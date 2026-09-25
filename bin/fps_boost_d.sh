#!/system/bin/sh
# ============================================================================
# fps_boost_ctl · 守护进程主循环
#
#  1) 启动：检查内核节点 → 首次生成用户配置 → 合并升级 → 套用模式与 opts
#  2) 每秒：拿「内核正在跟踪的渲染进程」→ /proc/<pid>/cmdline 得包名
#           （拿不到才回退 dumpsys，且限频 30s、模块关时不调）
#           包名/profile 变化时套用；opts/mode 变化时（stat mtime）重新套用
#
# 用法： fps_boost_d.sh [--once]    --once 只跑一轮并打印，便于调试
# ============================================================================
MODDIR=$(cd "$(dirname "$0")/.." && pwd)
. "$MODDIR/bin/lib/common.sh"

fb_boot() {
    mkdir -p /data/adb
    [ -f "$FB_LOG" ] || echo "# fps_boost_ctl daemon log" > "$FB_LOG"

    # 首次运行：从模块默认配置复制到 /data/adb
    if [ ! -f "$FB_CONF" ]; then
        cp -f "$MODDIR/conf/profiles.conf" "$FB_CONF" 2>/dev/null || printf '* 60 1 - - 1\n' > "$FB_CONF"
        chmod 644 "$FB_CONF"
    fi
    if [ ! -f "$FB_OPTS" ]; then
        cp -f "$MODDIR/conf/opts.conf" "$FB_OPTS" 2>/dev/null || : > "$FB_OPTS"
        chmod 644 "$FB_OPTS"
    fi
    [ -f "$FB_MODE" ] || cp -f "$MODDIR/conf/mode" "$FB_MODE" 2>/dev/null || echo balance > "$FB_MODE"

    fb_merge_configs
    fb_apply_mode "$(tr -d ' \t\r\n' < "$FB_MODE" 2>/dev/null)"
    fb_apply_opts

    # 记录初始 mtime，之后按变化热重载
    fb_watch "$FB_OPTS" OPTS >/dev/null 2>&1
    fb_watch "$FB_MODE" MODE >/dev/null 2>&1
    fb_log "daemon start pid=$$ mode=${FB_CUR_MODE:-balance}"
}

fb_tick() {
    local now

    # opts.conf 变化 → 重新套用（显式键优先于模式），并让 profile 重新盖一次
    if fb_watch "$FB_OPTS" OPTS; then
        fb_apply_opts
        FB_NEED_REAPPLY=1
    fi
    # mode 文件变化 → 先套模式，再用 opts 覆盖，同样重套 profile
    if fb_watch "$FB_MODE" MODE; then
        fb_apply_mode "$(tr -d ' \t\r\n' < "$FB_MODE" 2>/dev/null)"
        fb_apply_opts
        FB_NEED_REAPPLY=1
    fi

    # governor / rtg_boost_freq / walt tunables 周期性校验（perfmgr 可能切走，
    # 重选 governor 会重建 tunable 目录、把值冲掉）
    now=$(date +%s)
    if [ "$((now - ${FB_LAST_PIN:-0}))" -ge "$FB_PIN_EVERY" ]; then
        FB_LAST_PIN=$now
        [ -n "${FB_GOV_WANT:-}" ]  && fb_set_governor "$FB_GOV_WANT"
        [ -n "${FB_RTGB_WANT:-}" ] && fb_set_rtgb "$FB_RTGB_WANT"
        fb_pin_walt_pins
    fi

    # rtg_pid 兜底：GED 不上报渲染 pid 时，用包名反查主进程 pid 填上
    fb_sync_rtg_pid
}

# ------------------------------------------------------------- 一次性调试
case "$1" in
    --once|once)
        fb_boot
        fb_foreground_pkg
        pkg="$FB_PKG"
        prof=$(fb_profile_for "$pkg")
        echo "pkg      : ${pkg:-未知}"
        if [ -n "$prof" ]; then
            # shellcheck disable=SC2086
            set -f                     # 命中的键可能是 *，别让 glob 把参数拆了
            fb_apply_profile $prof
            set +f
            echo "profile  : $prof   (已套用)"
        else
            echo "profile  : (无匹配)"
        fi
        echo "mode     : ${FB_CUR_MODE:-?}  governor=${FB_GOV_WANT:-未设置}  rtgb=${FB_RTGB_WANT:-未设置}  only_listed=${FB_ONLY_LISTED:-0}"
        fb_sync_rtg_pid
        echo "--- 套用后的节点 ---"
        for n in enable target_fps target_fps_list margin_fps boost_pct hold_ms rtg_id rtg_mode rtg_pid floor_en graded ged_target; do
            printf "  %-16s %s\n" "$n" "$(fb_knob $n)"
        done
        echo "--- WALT governor tunables ---"
        for d in $(fb_policies); do
            [ -f "$d/walt/auto_boost" ] || { echo "  $d: 非 walt governor（$(cat "$d/scaling_governor" 2>/dev/null)）"; continue; }
            printf "  %s gov=%s auto_boost=%s pl=%s hispeed_freq=%s hispeed_load=%s rtg_boost_freq=%s boost=%s\n" \
                "$(basename "$d")" "$(cat "$d/scaling_governor" 2>/dev/null)" \
                "$(cat "$d/walt/auto_boost" 2>/dev/null)" \
                "$(cat "$d/walt/pl" 2>/dev/null)" \
                "$(cat "$d/walt/hispeed_freq" 2>/dev/null)" \
                "$(cat "$d/walt/hispeed_load" 2>/dev/null)" \
                "$(cat "$d/walt/rtg_boost_freq" 2>/dev/null)" \
                "$(cat "$d/walt/boost" 2>/dev/null)"
        done
        echo "--- /proc/fps_boost/status ---"
        cat "$FB_PROC/status" 2>/dev/null | head -n 40
        exit 0
        ;;
esac

# --------------------------------------------------------------- 主循环
fb_boot
echo $$ > "$FB_PID"
trap 'rm -f "$FB_PID"; fb_log "daemon exit"; exit 0' INT TERM HUP

last_key=""
while :; do
    fb_tick

    fb_foreground_pkg
    fb_boost_log_tick          # 提频日志：放在这里才拿得到本轮的包名
    pkg="$FB_PKG"
    prof=$(fb_profile_for "$pkg")
    key="$pkg|$prof"
    need=${FB_NEED_REAPPLY:-0}
    FB_NEED_REAPPLY=0
    if [ -n "$prof" ] && { [ "$key" != "$last_key" ] || [ "$need" = "1" ]; }; then
        # shellcheck disable=SC2086
        set -f                         # 命中的键可能是 *，别让 glob 把参数拆了
        fb_apply_profile $prof
        set +f
        last_key="$key"
        echo "mode=${FB_CUR_MODE:-?} pkg=${pkg:-none} profile=$prof $(date '+%F %T')" > "$FB_STATE"
        fb_log "pkg=${pkg:-none} -> $prof"
    fi
    sleep "$FB_INTERVAL"
done
