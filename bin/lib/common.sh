# ============================================================================
# fps_boost_ctl · 守护脚本公共库
#
# 由 bin/fps_boost_d.sh 用 `.` 引入。职责：
#   路径常量 / 日志 / 读写内核节点 / 配置（profiles·opts·mode）解析与合并 /
#   模式预设 / governor 与 rtg_boost_freq 固定 / 前台渲染进程识别
#
# 只用 busybox sh 的 POSIX 子集，不依赖 bash。
# ============================================================================

FB_PROC=/proc/fps_boost
FB_CONF=/data/adb/fps_boost_ctl.conf
FB_OPTS=/data/adb/fps_boost_ctl.opts
FB_MODE=/data/adb/fps_boost_ctl.mode
FB_STATE=/data/adb/fps_boost_ctl.state
FB_LOG=/data/adb/fps_boost_ctl.log
FB_PID=/data/adb/fps_boost_ctl.pid
FB_INTERVAL=${FPS_BOOST_CTL_INTERVAL:-1}   # 轮询周期（秒）
FB_PIN_EVERY=5                             # governor / rtg_boost_freq 校验间隔
FB_DUMPSYS_EVERY=30                        # dumpsys 回退的最小间隔（很贵，尽量少用）

# ---------------------------------------------------------------- 基础
fb_log() {
    [ -f "$FB_LOG" ] || echo "# fps_boost_ctl daemon log" > "$FB_LOG"
    echo "$(date '+%m-%d %H:%M:%S') $*" >> "$FB_LOG"
    if [ "$(wc -l < "$FB_LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
        tail -n 200 "$FB_LOG" > "$FB_LOG.tmp" 2>/dev/null && mv -f "$FB_LOG.tmp" "$FB_LOG"
    fi
}

fb_wb() { [ -n "$2" ] && echo "$2" > "$FB_PROC/$1" 2>/dev/null; }      # 写内核节点
fb_knob() { cat "$FB_PROC/$1" 2>/dev/null | tr -d ' \r\n'; }           # 读内核节点
fb_mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }                  # 文件 mtime
fb_policies() { ls -d /sys/devices/system/cpu/cpufreq/policy* 2>/dev/null; }

# ------------------------------------------------------- 每应用 profile
# 语法: <包名|*|!包名> <target_fps> <margin_fps> <boost_pct> <hold_ms> [rtg_id]
#       包名 = 精确匹配（优先于 *）；* = 全局默认；!包名 = 黑名单（不接管）
#       target_fps 可写档位列表 60,90,120；字段写 "-" = 沿用模式/opts 的值
# 输出: "<t> <m> <pct> <hold> <rtg> <命中的键>"；黑名单输出 "__excluded__ ..."
fb_profile_for() {
    local want="$1" p t m pct hold rtg star="" starp=""
    [ -z "$want" ] && want="*"
    while read -r p t m pct hold rtg; do
        case "$p" in ''|\#*) continue ;; esac
        case "$p" in
            '!'*)
                [ "$p" = "!$want" ] && { echo "__excluded__ - - - - $p"; return 0; }
                continue ;;
        esac
        # 精确匹配优先：即使 * 行写在前头，应用自己的行也能生效
        if [ "$p" = "$want" ]; then
            echo "$t $m $pct $hold $rtg $p"
            return 0
        fi
        [ "$p" = "*" ] && [ -z "$starp" ] && { star="$t $m $pct $hold $rtg"; starp="*"; }
    done < "$FB_CONF"
    [ -n "$starp" ] && { echo "$star $starp"; return 0; }
    return 1
}

fb_apply_profile() {   # $1..$5 = target margin pct hold rtg；$6 = 命中的键
    local t="$1" m="$2" pct="$3" hold="$4" rtg="$5" key="$6"

    # 黑名单：这个应用完全不接管
    if [ "$t" = "__excluded__" ]; then
        fb_wb enable 0
        fb_log "profile: $key 在黑名单里 -> enable 0"
        return 0
    fi
    # only_listed=1：没被显式列出的应用不主动接管（* 只提供参数默认值）
    if [ "${FB_ONLY_LISTED:-0}" = "1" ] && [ "$key" = "*" ]; then
        fb_wb enable 0
        return 0
    fi
    case "$t" in
        "-"|"") ;;
        *[,/]*) fb_wb target_fps_list "$(echo "$t" | tr ',/' '  ')" ;;
        *)      fb_wb target_fps "$t" ;;
    esac
    [ "$m" = "-" ]    || fb_wb margin_fps "$m"
    [ "$pct" = "-" ]  || fb_wb boost_pct "$pct"
    [ "$hold" = "-" ] || fb_wb hold_ms "$hold"
    [ "$rtg" = "-" ]  || fb_wb rtg_id "$rtg"
    fb_wb enable 1
}

# ------------------------------------------------------------ 模式预设
# 优先级：模式预设 < opts.conf < profile 行
fb_apply_mode() {
    local m="$1" pct hold graded rtg
    case "$m" in
        powersave)   pct=45;  hold=150; graded=0; rtg=1 ;;
        performance) pct=80;  hold=400; graded=1; rtg=2 ;;
        fast)        pct=100; hold=600; graded=1; rtg=2 ;;
        *)           pct=60;  hold=250; graded=1; rtg=2; m=balance ;;
    esac
    fb_wb boost_pct "$pct"
    fb_wb hold_ms   "$hold"
    fb_wb graded    "$graded"
    fb_wb rtg_mode  "$rtg"
    FB_CUR_MODE="$m"
    fb_log "mode=$m pct=$pct hold=$hold graded=$graded rtg_mode=$rtg"
}

# ---------------------------------------------------------- 全局选项
# 可用键: rtg_id rtg_mode floor_en graded ged_target sample_ms
#         target_fps margin_fps boost_pct hold_ms enable
#         only_listed <0|1>  governor <walt|keep>  rtg_boost_freq <kHz|max>
#         rtg_pid <pid|0>  rtg_pid_auto <0|1>
#         walt_<tunable> <value>   → 各 policy 的 /sys/.../policyN/walt/<tunable>
#           常用: walt_auto_boost walt_pl walt_hispeed_freq walt_hispeed_load
#                 walt_boost walt_adaptive_low_freq walt_adaptive_high_freq
#           值 "max" = 该 cluster 的最高频；auto_boost=1 时 hispeed_freq /
#           rtg_boost_freq 为 0 表示用内核算好的每 cluster 默认值
#
# 这些键先整文件读出来再用：rtg_boost_freq / walt_* 要在 governor 落地之后才能写
# （walt 的 tunable 目录只在它被选中时存在），而键在用户文件里的先后顺序不定。
fb_apply_opts() {
    local k v
    [ -f "$FB_OPTS" ] || return 0

    FB_GOV_WANT=""
    FB_RTGB_WANT=""
    FB_ONLY_LISTED=0
    FB_RTGPID_WANT=""
    FB_RTGPID_AUTO=1
    FB_WALT_PINS=""
    while read -r k v; do
        case "$k" in ''|\#*) continue ;; esac
        case "$k" in
            governor)       FB_GOV_WANT="$v" ;;
            rtg_boost_freq) FB_RTGB_WANT="$v" ;;
            only_listed)    FB_ONLY_LISTED="${v:-0}" ;;
            rtg_pid)        FB_RTGPID_WANT="$v" ;;
            rtg_pid_auto)   FB_RTGPID_AUTO="${v:-1}" ;;
            walt_*)         FB_WALT_PINS="$FB_WALT_PINS${k#walt_} $v
" ;;
        esac
    done < "$FB_OPTS"

    # governor 按配置固定：默认 walt（本仓库已把 WALT 设为内核默认，固定只是
    # 防 MTK perfmgr 把某些 policy 切回 schedutil）。
    # rtg_boost_freq 是可选项，没设时 RTG 只挂组、不改频率。
    [ -n "$FB_GOV_WANT" ]  && fb_set_governor "$FB_GOV_WANT"
    [ -n "$FB_RTGB_WANT" ] && fb_set_rtgb "$FB_RTGB_WANT"

    # WALT tunables：必须在 governor 生效后写（目录那时才存在）
    fb_pin_walt_pins

    if [ "$FB_GOV_WANT" = "walt" ] && [ -z "$FB_RTGB_WANT" ]; then
        fb_log "opts: governor=walt 已固定；未设 rtg_boost_freq -> 用内核默认（auto_boost 下每 cluster 70% of max）"
    fi

    while read -r k v; do
        case "$k" in ''|\#*) continue ;; esac
        case "$k" in
            enable|target_fps|margin_fps|boost_pct|hold_ms|sample_ms|\
            rtg_id|rtg_mode|floor_en|graded|ged_target)
                            fb_wb "$k" "$v" ;;
        esac
    done < "$FB_OPTS"
}

# ------------------------------------- 固定 governor / RTG 目标频点
# 只在当前值不同时才写，避免重选 governor 把 tunable 冲掉
fb_set_governor() {
    local g="$1" d cur
    [ -n "$g" ] || return 0
    [ "$g" = "keep" ] && return 0
    for d in $(fb_policies); do
        grep -qw "$g" "$d/scaling_available_governors" 2>/dev/null || continue
        cur=$(cat "$d/scaling_governor" 2>/dev/null)
        [ "$cur" = "$g" ] || echo "$g" > "$d/scaling_governor" 2>/dev/null
    done
}

fb_set_rtgb() {
    local v="$1" d f cur
    [ -n "$v" ] || return 0
    for d in $(fb_policies); do
        [ -f "$d/walt/rtg_boost_freq" ] || continue
        f="$v"
        [ "$v" = "max" ] && f=$(cat "$d/cpuinfo_max_freq" 2>/dev/null)
        [ -n "$f" ] || continue
        cur=$(cat "$d/walt/rtg_boost_freq" 2>/dev/null)
        [ "$cur" = "$f" ] || echo "$f" > "$d/walt/rtg_boost_freq" 2>/dev/null
    done
}

# ------------------------------------------- WALT governor tunables
# 通用写入器：<name> 对应 /sys/devices/system/cpu/cpufreq/policyN/walt/<name>
# 值 "max" 换算成该 cluster 自己的最高频（各 cluster 用各自己的）
# 目录不存在（governor 不是 walt）时静默跳过
fb_set_walt_tunable() {
    local name="$1" val="$2" d f cur
    [ -n "$name" ] || return 0
    for d in $(fb_policies); do
        [ -f "$d/walt/$name" ] || continue
        f="$val"
        [ "$val" = "max" ] && f=$(cat "$d/cpuinfo_max_freq" 2>/dev/null)
        [ -n "$f" ] || continue
        cur=$(cat "$d/walt/$name" 2>/dev/null)
        [ "$cur" = "$f" ] || echo "$f" > "$d/walt/$name" 2>/dev/null
    done
}

# 重放 FB_WALT_PINS（每行 "<name> <value>"）。governor 被重选会重建 tunable，
# 所以这一条要跟着 governor / rtg_boost_freq 一起周期保持。
fb_pin_walt_pins() {
    local n v
    [ -n "$FB_WALT_PINS" ] || return 0
    while read -r n v; do
        [ -n "$n" ] && fb_set_walt_tunable "$n" "$v"
    done <<EOF
$FB_WALT_PINS
EOF
}

# ------------------------------------------- 配置合并（跨版本升级）
fb_merge_configs() {
    local k v
    if [ -f "$MODDIR/conf/opts.conf" ]; then
        while read -r k v; do
            case "$k" in ''|\#*) continue ;; esac
            awk -v k="$k" '{sub(/#.*/,"")} $1==k{f=1} END{exit !f}' "$FB_OPTS" 2>/dev/null && continue
            echo "$k $v" >> "$FB_OPTS"
            fb_log "merge opts: +$k $v"
        done < "$MODDIR/conf/opts.conf"
    fi
    grep -q "^[[:space:]]*\*" "$FB_CONF" 2>/dev/null || {
        printf '# merged: default line added by fps_boost_ctl\n* 60 1 - - 1\n' >> "$FB_CONF"
        fb_log "merge profiles: +default line"
    }
    # 旧版出厂默认行 → 新默认行；用户改过任何字符的行不动
    if grep -qx "[[:space:]]*\* 60 1 60 250[[:space:]]*" "$FB_CONF" 2>/dev/null; then
        sed -i 's/^[[:space:]]*\* 60 1 60 250[[:space:]]*$/* 60 1 - - 1/' "$FB_CONF"
        fb_log "merge profiles: default line -> * 60 1 - - 1"
    fi
}

# ------------------------------------------------- 前台渲染进程识别
# 结果统一放在全局 $FB_PKG（不用 $(...) 取返回值：子 shell 里写的限频状态
# 会丢，旧版因此每秒都真的跑一次 dumpsys；顺带也省掉一次 fork）
FB_PKG=""

# 首选：内核正在跟踪的 pid → /proc/<pid>/cmdline（快，且正是被调度的那个进程）
fb_kernel_pkg() {
    local pid pkg
    FB_PKG=""
    pid=$(fb_knob pid)
    case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
    pkg=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' '\n' | head -n1)
    [ -n "$pkg" ] || return 1
    FB_PKG="${pkg%%:*}"      # 去掉 :remote 之类的后缀
    return 0
}

# 回退：dumpsys（昂贵，限频）
fb_dumpsys_pkg() {
    local now p
    FB_PKG=""
    now=$(date +%s)
    [ "$((now - ${FB_LAST_DUMPSYS:-0}))" -lt "$FB_DUMPSYS_EVERY" ] && return 1
    FB_LAST_DUMPSYS=$now
    p=$(dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=.*{ *\([^/ ]*\)\/.*/\1/p' | head -n1)
    [ -z "$p" ] && p=$(dumpsys activity activities 2>/dev/null | sed -n 's/.*mResumedActivity.*{ *\([^/ ]*\)\/.*/\1/p' | head -n1)
    [ -n "$p" ] || return 1
    FB_PKG="$p"
    return 0
}

fb_foreground_pkg() {
    fb_kernel_pkg && return 0        # 快路径：内核正在跟踪的渲染进程
    # 回退很贵（要起 dumpsys 进程，跑分时会影响成绩），所以只在模块确实开着
    # 的时候才做，且限频 30s
    [ "$(fb_knob enable)" = "1" ] || return 0
    fb_dumpsys_pkg
}

# ------------------------------------------------- rtg_pid 兜底
# 内核的 rtg_pid 是给「GED 不上报渲染 pid」的场景用的：内核只用它来挂 WALT 关联
# 线程组，真正抬频与否由 walt governor 的 rtg_boost_freq + 组负载决定。
#
# 规则：
#   - opts 里显式写了 rtg_pid 且非 0 → 手动值优先（不自动覆盖）
#   - 否则 rtg_pid_auto=1 时：内核自己在跟踪（status 的 pid 非 0）就交回给内核
#     （写 0，让它继续用 GED 的 pid）；内核没在跟踪才用包名反查主进程 pid 填上
FB_RTGPID_EVERY=5          # 包名反查 /proc 的最小间隔（秒，兜底时才用）

# 用 /proc 扫出包名对应的主进程 pid（cmdline 首段精确匹配，排除 :remote 等）
fb_pkg_main_pid() {
    local want="$1" d cmd p
    [ -n "$want" ] || return 1
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        cmd=$(tr '\0' '\n' < "$d/cmdline" 2>/dev/null | head -n1)
        [ "$cmd" = "$want" ] || continue
        p=${d#/proc/}
        echo "$p"
        return 0
    done
    return 1
}

fb_sync_rtg_pid() {
    local kpid cur p now

    # 手动值优先
    if [ -n "${FB_RTGPID_WANT:-}" ] && [ "$FB_RTGPID_WANT" != "0" ]; then
        cur=$(fb_knob rtg_pid)
        [ "$cur" = "$FB_RTGPID_WANT" ] || fb_wb rtg_pid "$FB_RTGPID_WANT"
        return 0
    fi
    [ "${FB_RTGPID_AUTO:-1}" = "1" ] || return 0

    kpid=$(fb_knob pid)
    if [ -n "$kpid" ] && [ "$kpid" != "0" ]; then
        # 内核自己在跟踪渲染进程 → 让 rtg_pid 归零，继续用 GED 的 pid
        [ "$(fb_knob rtg_pid)" = "0" ] || fb_wb rtg_pid 0
        return 0
    fi

    # 内核没在跟踪（GED 静默 / 只有显示路径帧源）：用前台包名兜底
    [ -n "$FB_PKG" ] || return 0
    now=$(date +%s)
    [ "$((now - ${FB_LAST_RTGPID:-0}))" -lt "$FB_RTGPID_EVERY" ] && return 0
    FB_LAST_RTGPID=$now
    p=$(fb_pkg_main_pid "$FB_PKG") || return 0
    [ -n "$p" ] || return 0
    [ "$(fb_knob rtg_pid)" = "$p" ] || {
        fb_wb rtg_pid "$p"
        fb_log "rtg_pid auto -> $p ($FB_PKG)"
    }
}

# -------------------------------------------------- 变更检测（只 stat）
# 用法: fb_watch <文件> <变量前缀>；返回 0 = 变了，1 = 没变
fb_watch() {
    eval "local last=\${${2}_MTIME:-0}"
    local now
    now=$(fb_mtime "$1")
    if [ "$now" != "$last" ]; then
        eval "${2}_MTIME=$now"
        return 0
    fi
    return 1
}
