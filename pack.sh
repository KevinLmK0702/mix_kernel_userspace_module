#!/usr/bin/env sh
# ============================================================================
# fps_boost_ctl · 打包脚本
#
#   产出可直接刷入的 KernelSU / Magisk 模块 zip：
#     <输出目录>/fps_boost_ctl-v<module.prop 里的版本>-<YYMMDD>.zip
#
#   用法:
#     ./pack.sh                  # 输出到本仓库的上一级目录
#     ./pack.sh /tmp             # 输出到 /tmp
#     ./pack.sh -o /tmp          # 同上
#
#   为什么要用这个脚本而不是手敲 zip：
#     1) 本目录自身是个 git 仓库，`zip -r out.zip .` 会把整个 .git/ 打进包里
#        （可能几十 MB，刷入后模块目录里还会多出一个 .git）；
#     2) 打包完会自动校验 module.prop 在包根、且没有 .git 条目 —— 这两个都是
#        装不上/装歪的典型原因，与其等刷机报错，不如在这里就拦掉；
#     3) 版本号与日期自动取自 module.prop 与系统时间，不会手抖写错文件名。
#
#   依赖: sh / zip / unzip / date / sed
# ============================================================================
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)

OUT_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o|--out)
            [ $# -ge 2 ] || { echo "pack.sh: -o 需要一个参数" >&2; exit 2; }
            OUT_DIR=$2; shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"; exit 0 ;;
        -*)
            echo "pack.sh: 未知选项 $1（用 -h 看用法）" >&2; exit 2 ;;
        *)
            OUT_DIR=$1; shift ;;
    esac
done
[ -n "$OUT_DIR" ] || OUT_DIR=$(cd "$SRC/.." && pwd)
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

for c in zip unzip date sed; do
    command -v "$c" >/dev/null 2>&1 || { echo "pack.sh: 缺少命令 $c" >&2; exit 1; }
done

[ -f "$SRC/module.prop" ] || { echo "pack.sh: 找不到 $SRC/module.prop" >&2; exit 1; }

VER=$(sed -n 's/^version=//p' "$SRC/module.prop" | head -n1 | tr -d ' \r')
[ -n "$VER" ] || { echo "pack.sh: module.prop 里没有 version=" >&2; exit 1; }
VER=${VER#v}                                   # v2.1.0 -> 2.1.0
DATE=$(date +%y%m%d)
ZIP="$OUT_DIR/fps_boost_ctl-v$VER-$DATE.zip"

echo "==> 源目录 : $SRC"
echo "==> 版本   : v$VER  ($DATE)"
echo "==> 输出   : $ZIP"

rm -f "$ZIP"
# 排除: .git（历史）、pack.sh 自身、已有的 zip、macOS 垃圾文件
# shellcheck disable=SC2086
(cd "$SRC" && zip -r9 "$ZIP" . \
        -x '.git/*' -x '.git' \
        -x 'pack.sh' -x './pack.sh' \
        -x '*.zip' \
        -x '.DS_Store' -x '*/.DS_Store' -x '._*') >/dev/null

# ---------------------------------------------------------------- 自检
fail() { echo "!! $1" >&2; rm -f "$ZIP"; exit 1; }

unzip -t "$ZIP" >/dev/null 2>&1 || fail "zip 完整性校验失败"

unzip -l "$ZIP" | grep -q '\.git' && fail "包里混入了 .git 条目（检查排除规则）"

unzip -Z1 "$ZIP" | grep -qx 'module.prop'    || fail "module.prop 不在包根（KernelSU/Magisk 会装不上）"
unzip -Z1 "$ZIP" | grep -qx 'customize.sh'   || fail "customize.sh 不在包根"
unzip -Z1 "$ZIP" | grep -qx 'service.sh'     || fail "service.sh 不在包根"
unzip -Z1 "$ZIP" | grep -qx 'bin/fps_boost_d.sh' || fail "bin/fps_boost_d.sh 缺失"
unzip -Z1 "$ZIP" | grep -qx 'bin/lib/common.sh'  || fail "bin/lib/common.sh 缺失"
unzip -Z1 "$ZIP" | grep -qx 'conf/opts.conf'     || fail "conf/opts.conf 缺失"
unzip -Z1 "$ZIP" | grep -qx 'webroot/index.html' || fail "webroot/index.html 缺失"

N=$(unzip -Z1 "$ZIP" | wc -l | tr -d ' ')
SIZE=$(wc -c < "$ZIP" | tr -d ' ')

echo "==> 条目   : $N"
echo "==> 大小   : $SIZE bytes"
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$ZIP"
fi
echo "==> 完成，可直接在 KernelSU / Magisk 里刷入"
