#!/system/bin/sh
# ============================================================================
# fps_boost_ctl · KernelSU / Magisk 服务入口（late_start service）
#   等内核节点就绪 → 拉起 bin/fps_boost_d.sh（后台，日志进 /data/adb/fps_boost_ctl.log）
# ============================================================================
MODDIR=${0%/*}

i=0
while [ "$i" -lt 20 ] && [ ! -d /proc/fps_boost ]; do
    sleep 0.5
    i=$((i + 1))
done

if [ ! -d /proc/fps_boost ]; then
    echo "no /proc/fps_boost - 内核缺少 CONFIG_MTK_FPS_BOOST" > /data/adb/fps_boost_ctl.state
    exit 0
fi

# 已经在跑就不重复启动
if [ -f /data/adb/fps_boost_ctl.pid ] &&
   kill -0 "$(cat /data/adb/fps_boost_ctl.pid 2>/dev/null)" 2>/dev/null; then
    exit 0
fi

nohup sh "$MODDIR/bin/fps_boost_d.sh" >>/data/adb/fps_boost_ctl.log 2>&1 &
exit 0
