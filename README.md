# fps_boost_ctl

对接内核态帧感知提频驱动 **fps_boost**（需内核含 `CONFIG_MTK_FPS_BOOST=y`，即存在 `/proc/fps_boost`）的 KernelSU / Magisk 模块：
按**前台渲染进程**套用每应用参数，并提供 **LSPosed / Material 3 风格 WebUI**（暗色为主，主题跟随系统）。

## 目录结构

```
fps_boost_ctl/
├── module.prop            模块信息（版本 / 描述）
├── customize.sh           安装钩子（打印说明 + 修正权限）
├── service.sh             开机入口：等 /proc/fps_boost → 拉起守护进程
├── pack.sh                打包脚本（自带校验，见下「打包」）
├── bin/
│   ├── fps_boost_d.sh     守护进程主循环（支持 --once 单轮调试）
│   └── lib/common.sh      公共库：节点读写 / 配置解析 / 模式预设 / 合并 / 进程识别
├── conf/                  模块出厂默认值（首次运行复制到 /data/adb）
│   ├── profiles.conf      每应用参数
│   ├── opts.conf          全局开关
│   └── mode               默认模式（balance）
└── webroot/               WebUI（拆分为 html + css + js）
    ├── index.html
    ├── css/app.css
    └── js/{ksu.js,app.js}
```

## 打包

```sh
./pack.sh              # 输出到本仓库的上一级目录
./pack.sh -o /tmp      # 指定输出目录
```

产物名 `fps_boost_ctl-v<版本>-<YYMMDD>.zip`，版本号取自 `module.prop`。

脚本会排除 `.git/` —— **本目录自身是个 git 仓库，手敲 `zip -r out.zip .` 会把整个提交历史
打进包里**（几十 MB，刷入后模块目录里还会多出一个 `.git`），以及 `pack.sh` 自身、已有的 `*.zip`、
macOS 垃圾文件。打包后自检：`module.prop` / `customize.sh` / `service.sh` 必须在包根、关键文件齐全、
包内不得有 `.git` 条目 —— 任一不符就删掉产物并以非 0 退出，不会留下一个“看着能刷”的坏包。

## 安装

1. 内核包必须带 fps_boost（本仓库构建的即可）。
2. Manager → 模块 → 从本地安装 → 选 `fps_boost_ctl-vX.zip` → 重启。
3. 免重启更新 WebUI：`adb push webroot/ /data/adb/modules/fps_boost_ctl/`（守护脚本改动需重启模块或重跑 `service.sh`）。

## WebUI（LSPosed / Material 3 风格）

Manager → 模块 → WebUI。三个页面（底部导航，选中项为药丸底高亮）：

- **主界面**：顶部大标题 + **状态大卡**（只有文字：状态 / 当前模式+包名 / 目标与帧率档位 /
  模块与守护进程状态行；底色表示状态——提频中深绿、待机中浅绿、已关闭灰）、
  状态药丸（enable / boost / rtg）、信息行列表（实测帧率 / 提频状态 / 触发次数 / 热控压制）、
  可折叠的「内核原始状态」、快速参数（立即写 `/proc`）、模式切换（省电/均衡/性能/极速）、
  全局选项（写入 `fps_boost_ctl.opts`，持久），底部「日志」入口。
- **配置**：每应用参数列表（带图标，可直接改 5 个字段）、添加包名、**排除**（写 `!包名` 黑名单行）、
  从已安装应用挑选（带图标/搜索）；导航樽标显示已单独配置的条数。
- **关于**：模块信息、内核状态原文、守护进程日志、配置文件、**运行环境自检**（UA / 引擎特性 / ksu 桥接，排障用）。

主题：右上角按钮在 **跟随系统 → 深色 → 浅色** 间循环，选择记在 localStorage。
配色回到 **Miuix**：主色（按钮 / 开关 / 分段控件 / 导航高亮 / 药丸 / 链接 / 徽标）=
`#3482FF`（深色 `#277AF7`）；**绿色只用于"已激活"状态**（状态大卡底色，`#34C759`），
关闭时用红色，其余一律蓝色。两个主题的变量都在 `app.css` 顶部，改色只动那几个 `--var`。

表单控件：**开关类与枚举类选项一律用下拉选择**（抬最低频 / 分级提频 / 用 GED 目标 =
`开启`+`关闭`；RTG 挂组时机 = `跟踪到就挂`/`仅提频时挂`/`关闭`；调度器 = `WALT`/`原生 schedutil`；
RTG id = `关闭`+`1~19`），只有真正要填数值的（帧率 / 百分比 / 毫秒 / 频率）才用输入框。
「全局选项」卡片会在打开时从 `fps_boost_ctl.opts` 读回，随后由内核 `status` 持续对齐，
不会出现"界面显示开启、实际是关闭"的情况。

## 配置

三个文件都在 `/data/adb/`，改完**无需重启**（守护脚本按 mtime 热重载）：

### 1) 每应用：`fps_boost_ctl.conf`

```
<包名|*|!包名>  <target_fps> <margin_fps> <boost_pct> <hold_ms> [rtg_id]
```

| 字段 | 说明 |
|---|---|
| `包名` | 精确匹配（**优先于 `*`**，与行序无关） |
| `*` | 全局默认（作为参数默认值，未被显式列出的应用用它） |
| `!包名` | 黑名单：命中的应用完全不接管（写 `enable 0`），跑分/敏感应用用它 |
| `target_fps` | 1-300；也可写**档位列表** `60,90,120` 或 `60/90/120`，内核按实测帧率匹配当前档（平局偏向高档：30fps 上限的游戏不会被一直提频，60fps 掉到 45 仍会提频） |
| `margin_fps` | 允许掉帧裕量（掉到 `target-margin` 以下才提频） |
| `boost_pct` | 提频强度：最低频抬到 max 的百分比（写 `-` = 用模式预设的值） |
| `hold_ms` | 掉帧后至少保持提频的时长（写 `-` = 用模式预设的值） |
| `rtg_id` | WALT 关联线程组 id（0=关，1-19；`-` = 用全局值） |

示例：
```
* 60 1 - - 1
com.miHoYo.Yuanshen 60,90,120 1 - - 1
com.tencent.tmgp.sgame 60 0 100 500 0
!com.antutu.ABenchMark - - - - -
```

### 2) 全局开关：`fps_boost_ctl.opts`

`<键> <值>`，只接受白名单键：

| 键 | 取值 | 说明 |
|---|---|---|
| `only_listed` | `0` / `1` | `1` = **只对 profiles.conf 里显式列出的包名生效**（`*` 只提供参数默认值，不主动接管）；跑分/其它应用不想被碰就设 1 |
| `governor` | `walt` / `keep` | 默认 `walt`：把各 policy 的 cpufreq 调度器固定为本仓库移植的 WALT governor（每 5s 保持，防 perfmgr 切回）；`keep` = 不干预，用系统原生 schedutil |
| `rtg_id` | 0-19 | WALT 关联线程组 id（0=关） |
| `rtg_mode` | 0/1/2 | 0=关；1=仅提频时挂组；2=跟踪到渲染进程就挂（默认） |
| `rtg_boost_freq` | kHz / `max` / `0` | walt governor 的 RTG 目标频点。**不设** = 用内核按 `walt_auto_boost` 算好的每 cluster 默认值（max 的 70%）；写 `0` 才是真正关掉 RTG 抬频 |
| `rtg_pid_auto` | 0/1 | 默认 `1`：内核没跟踪到渲染 pid 时（GED 静默、只有显示路径帧源），用前台包名在 `/proc` 反查主进程 pid 写进 `rtg_pid`，让 RTG 仍能挂上组 |
| `rtg_pid` | pid / `0` | 手动指定渲染进程 pid（`0` = 自动/GED）。非 0 时优先于 `rtg_pid_auto` |
| `floor_en` | 0/1 | 是否抬 cpufreq 最低频（设 0 = 只靠 walt governor） |
| `graded` | 0/1 | 分级提频：`boost_pct` 随掉帧程度线性放大到 100% |
| `ged_target` | 0/1 | 采用 GED 上报的目标帧率 |
| `sample_ms` | 20-5000 | 内核控制环周期 |
| `walt_auto_boost` | 0/1 | 默认 `1`：`hispeed_freq`/`rtg_boost_freq` 为 0 时改用内核按 cluster 算好的默认值（hispeed 80% / RTG 70% of max）；`0` = 0 即“关闭” |
| `walt_pl` | 0/1 | 默认 `1`：启用 WALT 预测负载（pl）抬频。耗电敏感可关 |
| `walt_hispeed_freq` | kHz / `max` | 高负载时顶到的频率；不设 = 用 `auto_boost` 的默认值 |
| `walt_hispeed_load` | 0-100 | 触发 hispeed 的负载阈值（相对平均容量，内核默认 90） |
| `walt_boost` | -100..1000 | util 额外百分比缩放（可为负，内核默认 0） |
| `walt_adaptive_low_freq` / `walt_adaptive_high_freq` | kHz | 自适应频带（把频率夹在这一段里），不设 = 关 |
| `walt_<其它>` | — | 任意 `walt_<tunable>` 都会写到各 policy 的 `/sys/.../policyN/walt/<tunable>`；值写 `max` = 该 cluster 自己的最高频 |

> WALT 那批键为什么能“持久”：governor 被重选会**重建 tunable 目录并复位**，所以守护脚本把 `walt_*`
> 和 `governor` / `rtg_boost_freq` 放在一起**每 5s 保持一次**。

### 3) 模式：`fps_boost_ctl.mode`

文件里只有一行：`powersave` / `balance` / `performance` / `fast`（默认 `balance`）。
预设值（profile 里写 `-` 的字段、以及未被 profile 命中的场景都用它）：

| 模式 | boost_pct | hold_ms | graded | rtg_mode |
|---|---|---|---|---|
| powersave | 45 | 150 | 0 | 1 |
| balance | 60 | 250 | 1 | 2 |
| performance | 80 | 400 | 1 | 2 |
| fast | 100 | 600 | 1 | 2 |

### 优先级与合并

**模式 < opts.conf < profile 行**。

守护进程启动时做一次幂等合并：新增的 opts 键自动补进用户文件；缺少 `*` 行则补 `* 60 1 - - 1`；
旧版出厂默认行（整行恰为 `* 60 1 60 250`）升级为新默认行 —— 用户改过任何字符的行都不会动。合并记录见日志里的 `merge` 行。

## 守护进程怎么工作

```
每秒：
  1. 读 /proc/fps_boost/pid（内核正在跟踪的渲染进程）
  2. /proc/<pid>/cmdline → 包名（去掉 :remote 后缀）—— 快，且正是被调度的那个进程
     取不到且模块开着时才回退 dumpsys 前台应用，且限频 30s（dumpsys 很贵，
     跑分时会影响成绩；限频状态是进程级变量，不是在子 shell 里）
  3. 命中 profile 变化 → 写节点；opts/mode 文件 mtime 变化 → 重新套用
每 5s：校验 governor / rtg_boost_freq / walt_* tunables 没被别的组件改走
每轮：rtg_pid 兜底（GED 静默时按包名反查主进程 pid）
```

调试：`su -c "sh /data/adb/modules/fps_boost_ctl/bin/fps_boost_d.sh --once"` —— 打印识别到的包名、命中的 profile、套用后的节点值与内核 status。

比"看前台应用"更准的原因：内核跟踪的是真正在提交帧的渲染进程（GED 主渲染头 / DRM 提交），
横屏、分屏、SurfaceFlinger 中转等场景下不会误判成 SystemUI。

## 与内核的对接

| 节点 | 作用 |
|---|---|
| `enable` / `target_fps` / `target_fps_list` / `margin_fps` / `boost_pct` / `hold_ms` | 基本参数 |
| `rtg_id` / `rtg_mode` / `floor_en` / `graded` / `ged_target` / `sample_ms` | 行为开关 |
| `rtg_pid` | 显式指定参与 RTG 的渲染进程 pid（`0` = 用 GED 上报的）。用于 GED 静默、只有 DRM present 帧源的场景 |
| `status` | 实时状态：`eff_target`、`cur_pct`、`capped_event`、`foreign_evt`（最低频被外部改动的次数）、`rtg_pid`/`rtg_pid_user`、每 cluster 的 `min/max/user_min/floor/base`（**回读校验**：`min != user_min` 说明平台拒绝了写入） |

RTG 联动：`sched_set_group_id()` 把渲染进程挂进 WALT 关联线程组，只有组负载超过阈值（`walt_rtgb_active`）才参与计算；
`walt` governor 的 `rtg_boost_freq` 决定"组活跃时把 util 顶到多少 kHz"。两者可叠加：
- 只信 WALT：`floor_en=0` + `rtg_mode=2` + 设好 `rtg_boost_freq`
- 只信硬地板：`rtg_mode=0` + `floor_en=1`

## 与 FAS / fas-rs 的区别（一句话版）

FAS 系（含 [fas-rs](https://github.com/shadow3aaa/fas-rs) 这类用户态实现）是**限频省电**：以 eBPF/用户态守护看帧时长，
用 P 控制器把频率**压到刚好达标**；本模块是**保帧提频**：纯内核态，掉帧时抬最低频并把渲染进程挂进 WALT 的 RTG。
两者可共存（一个压上限、一个抬下限），但热控压低上限时本模块会主动让位（见 `capped_event`）。

## 排障

- `cat /data/adb/fps_boost_ctl.state`：最近一次套用
- `cat /data/adb/fps_boost_ctl.log`：守护进程日志（含 mode/merge/套用记录，以及提频事件）
- `cat /proc/fps_boost/status`：内核侧真实值
- 状态一直是「空闲」但游戏在掉帧：确认 `enable=1`、`target_list/eff_target` 是你要的帧率、`samples` 在涨
- WebUI 打不开/报错：看「关于 → 运行环境自检」，红条会直接显示 JS 错误原因
- 状态卡底部那行会直接写明是哪一环没生效：`模块已禁用`（在管理器里重新启用）/ `内核节点缺失`
  （内核没编 `CONFIG_MTK_FPS_BOOST`）/ `守护进程未运行`（重装模块或重启后由 `service.sh` 拉起）；
  都正常时是绿点 + `模块已启用 · 守护进程运行中`

### 日志里的提频事件

守护进程每秒读一次内核 `status`，只在 `boosting` 从 0 变 1 / 从 1 变 0 时各写一条，不会刷屏：

```
提频开始 pkg=com.tencent.tmgp.sgame fps=52 pct=75% min=1200000/1540000/1600000 第 13 次
提频结束 持续 7s pkg=com.tencent.tmgp.sgame fps=60 峰值 min=1500000/1800000/1600000 累计 13 次 · 热控 0 / 外部 2
提频(瞬时) 漏记 5 次起止 · fps=55 pct=60% min=1110000/1400000/1600000 累计 18 次
```

- `min=` 是各 cluster **实际生效的最低频**（提频就是把最低频抬上去）；被热控 / perfmgr 拒绝时
  它与内核想写的值（`status` 里的 `user_min`）会不一样。
- `提频(瞬时)` 是掉帧只持续几百毫秒、短于 1s 轮询周期、抓不到起止的补记行（攒到 5 次或 30s 写一条）。
- `mode=` / `pkg=` / `profile=` 那一行存在 `/data/adb/fps_boost_ctl.state`，首页「模块状态」卡也会显示。

### 开了模块反而跑分变低？

这是「保帧提频」类模块的正常代价，逐条对照排查：

1. **是不是模块在管跑分应用？** `only_listed 1`（只对你列出的游戏生效）或给跑分加 `!包名` 黑名单。
   模块的 `*` 默认行会让**任何**前台应用在掉帧时被抬最低频，跑分里的场景测试也会被抬。
2. **是不是 WALT governor 的问题？** 内核侧已修好 util 口径与默认值（见下），默认就是 `walt` + `auto_boost=1`。
   若跑分变低，先把 `walt_pl` 设 0（预测负载最激进）、`walt_auto_boost` 设 0（不再自动顶 hispeed/RTG 频点）对比；
   想彻底回到系统原生行为就写 `governor keep`。
3. **是不是温度撞墙？** 提频把最低频长期抬高 → 功耗/温度上升 → MTK 的 PPM 热控（在 cpufreq 驱动里
   夹 `idx_opp_ppm_limit`，比 `policy->max` 更硬）先把上限压下来 → 持续分数反而更低。
   试 `mode powersave` 或 `boost_pct` 降到 30~40 对比；`hold_ms` 太大也会让提频赖着不走。
4. **纯 CPU 跑分（不渲染）** 时模块不会抬频（没有帧就没有 PVS），但会每 30s 跑一次 `dumpsys`
   做前台回退；要彻底安静就 `only_listed 1` 或黑名单，或者把 `/proc/fps_boost/enable` 写 0。
5. **想要「分数优先」而不是「帧率优先」**：`enable 0` + `governor keep`，并确认 `/proc/fps_boost/floor_en = 0`；
   退出游戏后模块会自动释放地板，不释放会在 `status` 里看到某个 policy 的 `floor` 还在。

### 内核侧 WALT governor 的已知问题（2026-09-18 已修）

早期版本的 `walt` governor 直接读 WALT 原始 util，而系统原生 `schedutil` 用的是
`boosted_cpu_util()`（额外含 schedtune 给前台 cgroup 的加成，一般 +20%）。那条 boost 被漏掉时，
前台应用/跑分都会被"看轻"，WALT 给的频率系统性低于 schedutil —— 这正是"开了 walt 跑分反而低"的主因。
修复提交（`sched: walt: fix the governor's utilization source and RTG lifetime`）后，
governor 的 util 口径与 schedutil 完全一致，WALT 只在此基础上叠加自己的 `nl/pl/RTG` 加速。

**所以：如果内核还是旧版（没有这个修复），`governor keep` 才是跑分友好的选择；
内核更新后再把 `governor walt` 打开对比。**

### 内核侧 WALT / RTG 的后续修复（2026-09-25）

1. **WALT 原本根本不会运行**：内核 Kconfig 里没有 `CPU_FREQ_DEFAULT_GOV_WALT`，defconfig 默认是
   `schedutil` —— 不切 governor 的话整套 WALT governor（含 `rtg_boost_freq`）一次都不会执行。
   现已新增该选项，并把 `evergo_defconfig` 切过去，`walt` 是开机默认调度器。
2. **默认 tunables 全是 0**：`hispeed_freq` / `rtg_boost_freq` / `pl` 默认都是关的，等于 schedutil。
   现在 `auto_boost` 默认为 1，内核按**每个 cluster 的 `max_freq`** 算出默认 hispeed（80%）与 RTG 频点（70%），
   开箱即有 WALT 特性；`pl` 默认打开。
3. **RTG 从全局判断改成按 CPU**：以前任意一组负载超阈值，**所有 cluster 一起**抬频；
   现在按各 CPU 自己的组负载与其 capacity 判断。
4. **`avg_cap` 陈旧导致的误触发**：窗口序列重启（挂起恢复 / 窗口 resize）后 `avg_cap` 不清零，
   会让 `is_hiload` 长期误判、空闲 CPU 也被顶到 hispeed。已修。

调优入口：

- 可写：`/sys/devices/system/cpu/cpufreq/policyN/walt/{auto_boost,pl,hispeed_freq,hispeed_load,rtg_boost_freq,boost,...}`
- 只读决策面板：`/sys/.../walt/decision` —— 含 `hispeed_hits` / `pl_hits` / `nl_hits` 命中计数，用来**用数据调参**
- 组负载 / 活跃 CPU：`/sys/kernel/debug/sched_rtg`（`active_cpus=` 与每组的 `cpu_load=`）
- 外部干扰：`/proc/fps_boost/status` 的 `foreign_evt`（boost 期间最低频被热控/FPSGO/sysfs 改动的次数）

WebUI 的「主界面 → WALT 调度器」可以直接展开看上面这些只读值。


## 卸载

Manager 里删除模块即可。`/data/adb/fps_boost_ctl.{conf,opts,mode,state,log,pid}` 不随模块删除，可手动删。
