#!/system/bin/sh
# ============================================================================
# fps_boost_ctl 安装钩子（KernelSU / Magisk 通用）
# ============================================================================
SKIPUNZIP=0

if command -v ui_print >/dev/null 2>&1; then
    ui_print "- fps_boost_ctl：内核态帧感知提频控制"
    ui_print "  需要内核含 CONFIG_MTK_FPS_BOOST=y（即存在 /proc/fps_boost）"
    ui_print "  新内核特性：/proc/fps_boost/rtg_pid（GED 不上报时的渲染 pid 兜底）"
    ui_print "              WALT governor tunables  /sys/.../policyN/walt/*"
    ui_print "  配置：/data/adb/fps_boost_ctl.conf（每应用）"
    ui_print "        /data/adb/fps_boost_ctl.opts（全局键，含 walt_* tunables）"
    ui_print "        /data/adb/fps_boost_ctl.mode（省电/均衡/性能/极速）"
    ui_print "  首次开机自动生成并合并默认值"
fi

# 保证脚本可执行（不依赖安装器的默认权限）
if command -v set_perm_recursive >/dev/null 2>&1; then
    set_perm_recursive "$MODPATH" 0 0 0755 0644
    for f in service.sh bin/fps_boost_d.sh bin/lib/common.sh; do
        [ -f "$MODPATH/$f" ] && command -v set_perm >/dev/null 2>&1 && set_perm "$MODPATH/$f" 0 0 0755
    done
else
    chmod -R 0755 "$MODPATH" 2>/dev/null
fi
