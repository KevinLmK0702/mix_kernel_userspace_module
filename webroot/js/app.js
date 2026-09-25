/* ============================================================================
 * fps_boost_ctl · WebUI 业务逻辑
 *
 * 三个页面：主界面（状态/快速参数/模式/全局选项）、配置（每应用 profile）、关于。
 * 约定：
 *  - 所有写 /proc 与 /data/adb 的命令都经 shWrite()/shq() 生成，
 *    值一律加双引号并做字符白名单过滤；**绝不能**写成 "echo 1>文件"
 *    （shell 会当成 fd 重定向，写进去的是换行，procfs 直接 -EINVAL）。
 *  - 多步写入用 && 串联，任一步失败即停止并显示 stderr。
 *  - 不用 NodeList.forEach / async-await / 箭头函数，兼容老 WebView。
 * ========================================================================== */
(function () {
  "use strict";

  var PROC = "/proc/fps_boost";
  var CONF = "/data/adb/fps_boost_ctl.conf";
  var OPTS = "/data/adb/fps_boost_ctl.opts";
  var MODE_FILE = "/data/adb/fps_boost_ctl.mode";
  var LOG = "/data/adb/fps_boost_ctl.log";

  var profiles = [];   /* [{pkg,t,m,p,h,r}] 值为字符串，"-" = 沿用模式 */
  var appInfo = {};    /* pkg -> {label,isSystem} */
  var instApps = [];   /* [{pkg,label}] */
  var curMode = "balance";   /* 当前模式（hero 展示用） */

  /* ---------------------------------------------------------------- 工具 */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function fval(v, d) { return (v === undefined || v === "") ? d : v; }
  function clean(v, allow) { return String(v === undefined || v === null ? "" : v).replace(new RegExp("[^" + allow + "]", "g"), ""); }
  /* shell 单引号包裹（内容不含单引号） */
  function shq(s) { return "'" + String(s).replace(/'/g, "") + "'"; }
  /* 写文件：注意值后面的空格！ */
  function shWrite(file, val) { return "echo " + shq(val) + " > " + file; }
  function setMsg(id, txt, ok) {
    var el = $(id); if (!el) return;
    el.className = "msg " + (ok ? "ok" : ok === false ? "err" : "");
    el.textContent = txt;
  }
  function toast(txt) {
    var t = $("toast");
    if (!t) { KSU.toast(txt); return; }
    t.textContent = txt; t.className = "show";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ""; }, 1800);
  }
  function setIfIdle(id, v) {  /* 输入框没被聚焦时才跟随实时值 */
    var el = $(id);
    if (el && v !== undefined && v !== "" && document.activeElement !== el) {
      if (el.options) setField(id, v);   /* select 只能选已存在的 option */
      else el.value = v;
    }
  }

  /* 给 select 赋值：选项里没有该值就保持原样（input 直接写） */
  function setField(id, v) {
    var el = $(id), i;
    if (!el || v === undefined || v === null) return;
    if (el.options) {
      for (i = 0; i < el.options.length; i++)
        if (el.options[i].value === String(v)) { el.value = String(v); return; }
      return;
    }
    if (document.activeElement !== el) el.value = v;
  }

  /* RTG id 下拉：关闭(0) + 1~19（HTML 里只写关闭，其余在此生成） */
  function fillRtgId(id) {
    var el = $(id), i, o, want;
    if (!el || !el.options || el.options.length > 1) return;
    want = el.value && el.value !== "0" ? el.value : "1";
    for (i = 1; i <= 19; i++) {
      o = document.createElement("option");
      o.value = String(i); o.textContent = String(i);
      el.appendChild(o);
    }
    el.value = want;
  }

  /* ---------------------------------------------------------------- 主题 */
  function applyTheme(mode) {
    var dark = mode === "dark" ||
      (mode === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme-mode", mode);
    var mt = document.querySelector('meta[name="theme-color"]');
    if (mt) mt.setAttribute("content", dark ? "#000000" : "#F2F2F4");
    try { localStorage.setItem("fb_theme", mode); } catch (e) {}
  }
  function cycleTheme() {
    var cur = document.documentElement.getAttribute("data-theme-mode") || "auto";
    var next = cur === "auto" ? "dark" : (cur === "dark" ? "light" : "auto");
    applyTheme(next);
    toast("主题：" + (next === "auto" ? "跟随系统" : next === "dark" ? "深色" : "浅色"));
  }

  /* ---------------------------------------------------------------- 导航 */
  /* 每个页面各自的滚动位置：切回来时接着看，而不是永远跳回顶部 */
  var pageScroll = {};

  /* 底部导航的按钮顺序 = 页面顺序，用来判断翻页方向 */
  function pageIndex(pg) {
    var bs = document.querySelectorAll("#navbar button"), i;
    for (i = 0; i < bs.length; i++)
      if (bs[i].getAttribute("data-page") === pg) return i;
    return -1;
  }

  function showPage(pg) {
    var bs = document.querySelectorAll("#navbar button"), ss = document.querySelectorAll(".page"), i;
    var html = document.documentElement, prev = document.querySelector(".page.active"), y, dir = "";

    if (prev && prev.id) pageScroll[prev.id] = window.pageYOffset || 0;

    /* 翻页方向：索引变大 = 前进（新页从右滑入），变小 = 后退（从左滑入）。
       同页重入或找不到索引时不加方向 class（回落成 fade，兼当“已在此页”的反馈）。 */
    if (prev && prev.id !== "page-" + pg) {
      var a = pageIndex(prev.id.replace(/^page-/, "")), b = pageIndex(pg);
      if (a >= 0 && b >= 0 && a !== b) dir = b > a ? "fwd" : "back";
    }

    for (i = 0; i < bs.length; i++)
      bs[i].setAttribute("aria-selected", bs[i].getAttribute("data-page") === pg ? "true" : "false");
    for (i = 0; i < ss.length; i++) {
      if (ss[i].id === "page-" + pg)
        ss[i].className = "page active" + (dir ? " slide " + dir : "");
      else ss[i].className = "page";
    }

    /* CSS 里 scroll-behavior: smooth，切页时要瞬时定位，否则会从上往下“滑”一遍 */
    y = pageScroll["page-" + pg];
    if (y === undefined) y = 0;
    try {
      html.style.scrollBehavior = "auto";
      window.scrollTo(0, y);
      html.style.scrollBehavior = "";
    } catch (e) {}

    if (pg === "config" && !instApps.length) loadInstalled();
  }

  /* ---------------------------------------------------------------- 状态 */
  function parseStatus(txt) {
    var o = {}, lines = String(txt || "").split("\n"), i, idx;
    for (i = 0; i < lines.length; i++) {
      idx = lines[i].indexOf(":");
      if (idx > 0) o[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
    }
    return o;
  }

  /* hero 副标题：内核 fb_status_show() 只输出 pid，从来没有 pkg 字段，
     所以不能只看 o.pkg（否则真机永远显示"无前台渲染进程"）。
     降级顺序：o.pkg -> 按 pid 反查 /proc/<pid>/cmdline（每个 pid 只查一次）-> pid */
  var heroPid = -1, heroPidName = "";

  function heroSubText(o) {
    if (o.pkg && o.pkg !== "0") return o.pkg;
    var pid = parseInt(o.pid, 10) || 0;
    if (pid <= 0) { heroPid = -1; heroPidName = ""; return "无前台渲染进程"; }
    if (pid !== heroPid) {
      heroPid = pid;
      heroPidName = "";
      /* cmdline 用 \0 分隔，先用 tr 换成行（与 fb_foreground_pkg 同一套命令） */
      KSU.exec("cat /proc/" + pid + "/cmdline 2>/dev/null | tr '\\0' '\\n' | head -n1")
        .then(function (r) {
          /* 万一桥接丢了 NUL，再按换行/空白取第一个 token 兜底 */
          var n = String(r.stdout || "").split("\n")[0].split("\u0000")[0].split(/\s+/)[0];
          if (heroPid !== pid || !n) return;
          heroPidName = n;
          var el = $("heroSub");
          if (el) el.textContent = "模式 " + curMode + " · " + n;
        });
    }
    return "渲染进程 " + (heroPidName || ("pid " + pid));
  }

  function renderStatus(o) {
    var on = o.enable === "1", b = o.boosting === "1";
    $("swEnable").checked = on;
    $("kFps").textContent = o.ema_fps || 0;
    $("kBoost").textContent = b ? "提频中" : "空闲";
    $("kEv").textContent = o.boost_events || 0;
    $("kCap").textContent = o.capped_event || 0;
    $("kForeign").textContent = o.foreign_evt || 0;

    /* 状态大卡：已关闭 / 待机中 / 提频中 三态着色 */
    var hero = $("hero");
    if (hero) {
      hero.className = "hero " + (on ? (b ? "on hot" : "on") : "off");
      $("heroState").textContent = on ? (b ? "提频中" : "待机中") : "已关闭";
      $("heroSub").textContent = "模式 " + curMode + " · " + heroSubText(o);
      var tgt = (o.target_list && o.target_list !== "(none)") ? o.target_list : o.target_fps;
      $("heroTag").textContent = "目标 " + (tgt || "-") + " fps ± " + (o.margin_fps || 0) +
        " · eff " + (o.eff_target || "-") + " · pct " + (o.boost_pct || 0) +
        (b && o.graded === "1" ? "→" + (o.cur_pct || "-") : "") + "%";
    }

    $("pills").innerHTML =
      '<span class="pill ' + (on ? "on" : "") + '">enable=' + (on ? "ON" : "OFF") + "</span>" +
      '<span class="pill ' + (b ? "active" : "") + '">boost=' + (b ? "ACTIVE" : "idle") + "</span>" +
      '<span class="pill">rtg=' + (o.rtg_set === "1" ? "g" + o.rtg_id : "off") + "</span>";

    var tgt = (o.target_list && o.target_list !== "(none)") ? o.target_list : o.target_fps;
    $("status").textContent =
      "target " + (tgt || "-") + " · eff " + (o.eff_target || "-") + " ±" + (o.margin_fps || "-") +
      " · pct " + (o.boost_pct || "-") + (b && o.graded === "1" ? "→" + (o.cur_pct || "-") : "") +
      "% · hold " + (o.hold_ms || "-") + "ms\n" +
      "pid " + (o.pid || "-") + " · rtg_pid " + (o.rtg_pid_user || 0) + " · samples " + (o.samples || 0) +
      " · all " + (o.all_samples || 0) + " · ema_fps " + (o.ema_fps || 0) + "\n" +
      "capped " + (o.capped_event || 0) + " · foreign " + (o.foreign_evt || 0) + "\n" +
      "rtg_mode " + (o.rtg_mode || "-") + " · floor_en " + (o.floor_en || "-") +
      " · graded " + (o.graded || "-") + " · ged_target " + (o.ged_target_en || "-");

    setIfIdle("t_target", tgt);
    setIfIdle("t_margin", o.margin_fps);
    setIfIdle("t_pct", o.boost_pct);
    setIfIdle("t_hold", o.hold_ms);
    setIfIdle("t_rtg", o.rtg_id);
    setIfIdle("o_rtgid", o.rtg_id);
    setIfIdle("o_rtgmode", o.rtg_mode);
    setIfIdle("o_floor", o.floor_en);
    setIfIdle("o_graded", o.graded);
    setIfIdle("o_gedtgt", o.ged_target_en);
    setIfIdle("o_sample", o.sample_ms);
  }

  function refresh() {
    return KSU.exec("cat " + PROC + "/status").then(function (r) {
      if (r.errno === 0 && r.stdout) { renderStatus(parseStatus(r.stdout)); setMsg("stMsg", "已更新", true); }
      else setMsg("stMsg", "/proc/fps_boost 不可用（内核缺 CONFIG_MTK_FPS_BOOST?）", false);
    });
  }

  /* ------------------------------------------------------- 快速参数 / 开关 */
  function applyQuick() {
    var t = clean($("t_target").value, "0-9,/") || "60";
    var m = clean($("t_margin").value, "0-9") || "1";
    var p = clean($("t_pct").value, "0-9") || "60";
    var h = clean($("t_hold").value, "0-9") || "250";
    var g = clean($("t_rtg").value, "0-9") || "1";

    var cmds = [
      shWrite(PROC + "/enable", "1"),
      (t.indexOf(",") >= 0 || t.indexOf("/") >= 0)
        ? shWrite(PROC + "/target_fps_list", t.replace(/[,\/]/g, " "))
        : shWrite(PROC + "/target_fps", t),
      shWrite(PROC + "/margin_fps", m),
      shWrite(PROC + "/boost_pct", p),
      shWrite(PROC + "/hold_ms", h),
      shWrite(PROC + "/rtg_id", g)
    ];
    return KSU.exec(cmds.join(" && ")).then(function (r) {
      setMsg("apMsg", r.errno === 0
        ? "已应用 target=" + t + " margin=" + m + " pct=" + p + " hold=" + h + " rtg=" + g
        : "失败 " + (r.stderr || r.stdout), r.errno === 0);
      if (r.errno === 0) { toast("已应用"); return refresh(); }
    });
  }

  function setEnable(on) {
    return KSU.exec(shWrite(PROC + "/enable", on ? "1" : "0")).then(function (r) {
      if (r.errno !== 0) toast("失败：" + (r.stderr || r.stdout));
      return refresh();
    });
  }

  /* ------------------------------------------------------------ 模式预设 */
  function paintMode(m) {
    curMode = m;
    var bs = document.querySelectorAll("#modeSeg .btn"), i;
    for (i = 0; i < bs.length; i++)
      bs[i].setAttribute("aria-pressed", bs[i].getAttribute("data-mode") === m ? "true" : "false");
    var cap = $("modeCap");
    if (cap) cap.textContent = "当前模式：" + m + "（boost_pct / hold_ms / graded / rtg_mode）";
  }
  function loadMode() {
    return KSU.exec("cat " + MODE_FILE + " 2>/dev/null").then(function (r) {
      paintMode((r.stdout || "").trim() || "balance");
    });
  }
  function setMode(m) {
    return KSU.exec(shWrite(MODE_FILE, m)).then(function (r) {
      setMsg("modeMsg", r.errno === 0 ? "已切换模式 " + m + "（守护脚本 ~1s 内套用）" : "失败 " + (r.stderr || r.stdout), r.errno === 0);
      if (r.errno === 0) { toast("模式 " + m); paintMode(m); }
    });
  }

  /* select/input 取值：空则回退默认值 */
  function sv(id, dflt, allow) {
    var el = $(id), v = el ? clean(el.value, allow) : "";
    return v === "" ? dflt : v;
  }

  /* ---------------------------------------------------------- 全局选项 */
  var OPT_IDS = {
    governor: "o_gov", only_listed: "o_only", rtg_mode: "o_rtgmode",
    rtg_id: "o_rtgid", floor_en: "o_floor", graded: "o_graded",
    ged_target: "o_gedtgt", sample_ms: "o_sample",
    rtg_pid_auto: "o_rtgpid_auto", rtg_pid: "o_rtgpid",
    walt_auto_boost: "o_wauto", walt_pl: "o_wpl",
    walt_hispeed_freq: "o_whf", walt_hispeed_load: "o_whl",
    walt_boost: "o_wboost"
  };

  /* 从 opts 文件读回，避免界面显示与实际不一致（内核侧的 0/1 值由 renderStatus 同步） */
  function loadOpts() {
    return KSU.exec("cat " + OPTS + " 2>/dev/null").then(function (r) {
      var lines = String(r.stdout || "").split("\n"), i, a, el;
      for (i = 0; i < lines.length; i++) {
        a = lines[i].replace(/#.*$/, "").replace(/^\s+|\s+$/g, "").split(/\s+/);
        if (a.length < 2 || !a[0]) continue;
        if (OPT_IDS[a[0]]) setField(OPT_IDS[a[0]], a[1]);
        else if (a[0] === "rtg_boost_freq") {
          el = $("o_rtgf");
          if (el && document.activeElement !== el) el.value = a[1];
        }
      }
    });
  }

  function saveOpts() {
    var body = "# fps_boost global options (saved by WebUI)\n" +
      "rtg_id " + sv("o_rtgid", "1", "0-9") + "\n" +
      "rtg_mode " + sv("o_rtgmode", "2", "0-9") + "\n" +
      "rtg_pid_auto " + sv("o_rtgpid_auto", "1", "01") + "\n" +
      "rtg_pid " + (clean($("o_rtgpid").value, "0-9") || "0") + "\n" +
      "floor_en " + sv("o_floor", "1", "01") + "\n" +
      "graded " + sv("o_graded", "1", "01") + "\n" +
      "ged_target " + sv("o_gedtgt", "1", "01") + "\n" +
      "sample_ms " + sv("o_sample", "200", "0-9") + "\n" +
      "governor " + sv("o_gov", "walt", "a-zA-Z") + "\n" +
      "only_listed " + sv("o_only", "0", "01") + "\n" +
      "walt_auto_boost " + sv("o_wauto", "1", "01") + "\n" +
      "walt_pl " + sv("o_wpl", "1", "01") + "\n";
    var rf = clean($("o_rtgf").value, "0-9a-zA-Z");
    if (rf) body += "rtg_boost_freq " + rf + "\n";
    var whf = clean($("o_whf").value, "0-9a-zA-Z");
    if (whf) body += "walt_hispeed_freq " + whf + "\n";
    var whl = clean($("o_whl").value, "0-9");
    if (whl) body += "walt_hispeed_load " + whl + "\n";
    var wb = clean($("o_wboost").value, "-0-9");
    if (wb !== "") body += "walt_boost " + wb + "\n";

    var b64 = btoa(unescape(encodeURIComponent(body)));
    return KSU.exec("echo " + shq(b64) + " | base64 -d > " + OPTS + " && chmod 644 " + OPTS).then(function (r) {
      setMsg("opMsg", r.errno === 0 ? "已保存，守护脚本 ~1s 内套用" : "保存失败 " + (r.stderr || r.stdout), r.errno === 0);
      if (r.errno === 0) { toast("全局选项已保存"); loadWalt(); }
    });
  }

  /* WALT governor 只读面板：每个 policy 的 governor + tunables + decision */
  function loadWalt() {
    var el = $("waltDump");
    if (!el) return Promise.resolve();
    el.textContent = "读取中…";
    var cmd = "for d in /sys/devices/system/cpu/cpufreq/policy*; do " +
      "echo \"== $(basename $d)  gov=$(cat $d/scaling_governor 2>/dev/null)\"; " +
      "for f in auto_boost pl hispeed_freq hispeed_load rtg_boost_freq boost target_load_thresh target_load_shift; do " +
      "[ -f $d/walt/$f ] && echo \"   $f = $(cat $d/walt/$f 2>/dev/null)\"; done; " +
      "[ -f $d/walt/decision ] && echo \"   decision: $(cat $d/walt/decision 2>/dev/null)\"; " +
      "[ -f $d/walt/decision ] || echo \"   （无 walt 目录：该 policy 不是 WALT 调度器）\"; done";
    return KSU.exec(cmd).then(function (r) {
      el.textContent = (r.stdout && r.stdout.replace(/\s+$/, "")) ||
        (r.stderr ? ("err " + r.stderr) : "(空)");
    });
  }

  /* -------------------------------------------------------- 每应用配置 */
  function loadConf() {
    return KSU.exec("cat " + CONF).then(function (r) {
      profiles = [];
      var lines = String(r.stdout || "").split("\n"), i, l, a;
      for (i = 0; i < lines.length; i++) {
        l = lines[i].replace(/^\s+|\s+$/g, "");
        if (!l || l.charAt(0) === "#") continue;
        a = l.split(/\s+/);
        if (a.length >= 2) {
          /* !包名 = 黑名单行，必须原样保留，否则保存时会变成普通启用行 */
          var excl = a[0].charAt(0) === "!";
          profiles.push({
            pkg: excl ? a[0].slice(1) : a[0], excl: excl,
            t: fval(a[1], "60"), m: fval(a[2], "1"),
            p: fval(a[3], "-"), h: fval(a[4], "-"), r: fval(a[5], "-")
          });
        }
      }
      if (!profiles.length) profiles.push({ pkg: "*", t: "60", m: "1", p: "-", h: "-", r: "-" });
      renderConf();
      refreshIcons();
    });
  }

  function ser() {
    return profiles.map(function (o) {
      if (o.excl) return "!" + o.pkg + " - - - - -";
      return o.pkg + " " + o.t + " " + o.m + " " + o.p + " " + o.h + " " + (o.r || "-");
    }).join("\n") + "\n";
  }

  function saveConf() {
    var b64 = btoa(unescape(encodeURIComponent(ser())));
    return KSU.exec("echo " + shq(b64) + " | base64 -d > " + CONF + " && chmod 644 " + CONF).then(function (r) {
      setMsg("cfMsg", r.errno === 0 ? "已保存到 " + CONF : "保存失败 " + (r.stderr || r.stdout), r.errno === 0);
      if (r.errno === 0) toast("配置已保存");
    });
  }

  var TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

  function renderConf() {
    var box = $("alist"); if (!box) return;
    /* 导航徽标 = 已单独配置的应用数（不含 * 行） */
    var nb = $("navBadge");
    if (nb) {
      var cnt = profiles.filter(function (x) { return x.pkg !== "*"; }).length;
      nb.textContent = cnt ? String(cnt) : "";
      nb.style.display = cnt ? "flex" : "none";
    }
    box.innerHTML = "";
    var ordered = profiles.filter(function (x) { return x.pkg === "*"; })
      .concat(profiles.filter(function (x) { return x.pkg !== "*"; }));

    ordered.forEach(function (o) {
      var isG = o.pkg === "*";
      var info = appInfo[o.pkg];
      var nm = isG ? "全局默认 · 未匹配任何应用" : ((info && info.label) ? info.label : o.pkg);
      var row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<div class="av ph">' + esc(isG ? "*" : (o.pkg.charAt(0) || "?").toUpperCase()) + "</div>" +
        '<div class="info">' +
        '<div class="t">' + esc(nm) + "</div>" +
        '<div class="s">' + esc(isG ? "*" : o.pkg) +
        (o.excl ? " · 黑名单：完全不接管（enable 0）"
                : " · target " + esc(o.t) + " fps · margin " + esc(o.m) +
                  " · boost " + esc(o.p) + "% · hold " + esc(o.h) + "ms · rtg " + esc(o.r || "-")) +
        "</div>" +
        (o.excl ? "" : '<div class="mini">' +
        '<div class="fld"><label>fps</label><input data-k="t" value="' + esc(o.t) + '"></div>' +
        '<div class="fld"><label>margin</label><input data-k="m" value="' + esc(o.m) + '"></div>' +
        '<div class="fld"><label>pct</label><input data-k="p" value="' + esc(o.p) + '"></div>' +
        '<div class="fld"><label>hold</label><input data-k="h" value="' + esc(o.h) + '"></div>' +
        '<div class="fld"><label>rtg</label><input data-k="r" value="' + esc(o.r || "-") + '"></div>' +
        "</div>") + "</div>" +
        '<button class="icon-btn" data-del="1"' + (isG ? ' style="visibility:hidden"' : "") + ">" + TRASH + "</button>";

      /* 非全局行：有图标就用管理器图标，失败回落到字母头像 */
      if (!isG) {
        try {
          var img = document.createElement("img");
          img.className = "av";
          img.src = "ksu://icon/" + encodeURIComponent(o.pkg);
          img.onerror = function () { if (img.parentNode) img.parentNode.replaceChild(fallbackAvatar(o.pkg), img); };
          row.replaceChild(img, row.firstChild);
        } catch (e) {}
      }

      var del = row.querySelector("[data-del]");
      del.onclick = function () {
        var i = profiles.indexOf(o);
        if (i >= 0) { profiles.splice(i, 1); renderConf(); }
      };

      var inps = row.querySelectorAll("input"), ii;
      for (ii = 0; ii < inps.length; ii++) (function (inp) {
        inp.oninput = function () {
          var k = inp.getAttribute("data-k"), v = inp.value.replace(/^\s+|\s+$/g, "");
          if (k === "t") { o.t = clean(v, "0-9,/") || "60"; return; }
          if (v === "-" || v === "") { o[k] = "-"; return; }
          var n = parseInt(v, 10); if (isNaN(n)) n = 0;
          if (k === "m") o.m = String(Math.min(120, n));
          else if (k === "p") o.p = String(Math.min(100, n));
          else if (k === "h") o.h = String(Math.min(10000, n));
          else o.r = String(Math.min(19, n));
        };
      })(inps[ii]);

      box.appendChild(row);
    });
  }

  function fallbackAvatar(pkg) {
    var d = document.createElement("div");
    d.className = "av ph";
    d.textContent = (pkg.charAt(0) || "?").toUpperCase();
    return d;
  }

  function refreshIcons() {
    var pkgs = profiles.filter(function (x) { return x.pkg !== "*"; }).map(function (x) { return x.pkg; });
    if (!pkgs.length) return Promise.resolve();
    var arr = KSU.packagesInfo(pkgs), i;
    for (i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (it && it.packageName) appInfo[it.packageName] = { label: it.appLabel, isSystem: !!it.isSystem };
    }
    if (arr.length) renderConf();
    return Promise.resolve();
  }

  function addPkg(pkg) {
    return addEntry(pkg, false);
  }

  function addEntry(pkg, excl) {
    pkg = clean(pkg, "0-9A-Za-z_.:-");
    if (!pkg) return;
    if (profiles.some(function (x) { return x.pkg === pkg; })) {
      toast("该包名已在列表里，先删除再加");
      return;
    }
    var g = profiles.filter(function (x) { return x.pkg === "*" && !x.excl; })[0] ||
      { t: "60", m: "1", p: "-", h: "-", r: "-" };
    profiles.push(excl ? { pkg: pkg, excl: true, t: "-", m: "-", p: "-", h: "-", r: "-" }
                       : { pkg: pkg, t: g.t, m: g.m, p: "-", h: "-", r: "-" });
    renderConf(); refreshIcons(); renderAppPick($("inSearch") ? $("inSearch").value : "");
    toast((excl ? "已排除 " : "已添加 ") + pkg);
  }

  /* ------------------------------------------------ 已安装应用选择器 */
  function placeHolder(txt) { var b = $("apppick"); if (b) b.innerHTML = '<div class="muted" style="padding:8px 2px">' + esc(txt) + "</div>"; }

  function finishInst(pkgs) {
    instApps = [];
    pkgs = KSU.toArr(pkgs);
    if (!pkgs.length) { placeHolder("未读取到应用，请用上方输入框手动添加包名。"); return; }
    var arr = KSU.packagesInfo(pkgs), labels = {}, i, it;
    for (i = 0; i < arr.length; i++) {
      it = arr[i];
      if (it && it.packageName) labels[it.packageName] = it.appLabel || it.packageName;
    }
    for (i = 0; i < pkgs.length; i++) instApps.push({ pkg: pkgs[i], label: labels[pkgs[i]] || pkgs[i] });
    instApps.sort(function (a, b) { return a.label < b.label ? -1 : 1; });
    renderAppPick($("inSearch") ? $("inSearch").value : "");
  }

  function loadInstalled() {
    placeHolder("加载应用列表…");
    var pkgs = KSU.listPackages("user");
    if (pkgs.length) { finishInst(pkgs.slice(0, 300)); return; }
    /* 回退：用 pm 枚举第三方应用 */
    KSU.exec("pm list packages -3 2>/dev/null").then(function (r) {
      var out = [], lines = String(r.stdout || "").split("\n"), i;
      for (i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^\s+|\s+$/g, "");
        if (l.indexOf("package:") === 0) out.push(l.slice(8).replace(/^\s+|\s+$/g, ""));
      }
      finishInst(out.slice(0, 300));
    });
  }

  function renderAppPick(filter) {
    var box = $("apppick"); if (!box) return;
    box.innerHTML = "";
    var f = (filter || "").toLowerCase(), shown = 0, i;
    for (i = 0; i < instApps.length && shown < 60; i++) {
      var a = instApps[i];
      if (f && a.pkg.toLowerCase().indexOf(f) < 0 && (a.label || "").toLowerCase().indexOf(f) < 0) continue;
      shown++;
      var row = document.createElement("div");
      row.className = "appitem";
      var added = profiles.some(function (x) { return x.pkg === a.pkg; });
      row.innerHTML = '<div class="av ph">' + esc((a.label || a.pkg).charAt(0).toUpperCase()) + "</div>" +
        '<div class="info"><div class="nm">' + esc(a.label) + '</div><div class="pk">' + esc(a.pkg) + "</div></div>" +
        (added ? '<span class="chip" style="opacity:.6">已添加</span>'
               : '<button class="chip" data-add="' + esc(a.pkg) + '">＋</button>');
      var b = row.querySelector("[data-add]");
      if (b) b.onclick = function () { addPkg(this.getAttribute("data-add")); };
      box.appendChild(row);
    }
    if (!shown) placeHolder(f ? "无匹配" : "加载中或为空…");
  }

  /* ------------------------------------------------------------ 关于页 */
  function refreshAbout() {
    try { $("abBridge").textContent = "JS 桥接：" + (KSU.has() ? "window.ksu 可用" : "无 window.ksu"); } catch (e) {}
    try { $("abEnv").textContent = KSU.envInfo(); } catch (e) {}

    var mi = KSU.moduleInfo();
    var box = $("abInfo");
    if (box) {
      if (!mi) box.innerHTML = '<div class="muted">模块信息不可用</div>';
      else {
        var rows = [["名称", mi.name], ["版本", (mi.version || "") + (mi.versionCode ? " (" + mi.versionCode + ")" : "")],
          ["作者", mi.author], ["ID", mi.id], ["启用", mi.enabled]];
        box.innerHTML = rows.map(function (r) {
          return '<div class="row"><div class="info"><div class="t">' + esc(r[0]) + '</div></div>' +
            '<div class="val">' + esc(r[1] === undefined ? "-" : String(r[1])) + "</div></div>";
        }).join("");
      }
    }

    KSU.exec("cat " + PROC + "/status 2>&1").then(function (r) { $("abStatus").textContent = r.errno ? ("err " + r.stderr) : (r.stdout || "(空)"); });
    KSU.exec("cat " + LOG + " 2>/dev/null | tail -n 40").then(function (r) { $("abDaemon").textContent = r.errno ? ("err " + r.stderr) : (r.stdout || "(空，暂无日志)"); });
    KSU.exec("cat " + CONF + " 2>&1").then(function (r) { $("abConf").textContent = r.errno ? ("err " + r.stderr) : (r.stdout || "(空)"); });
    loadMode();
  }

  /* ------------------------------------------------------------ 绑定 */
  function bindTheme() {
    var b = $("btnTheme");
    if (b) b.onclick = cycleTheme;
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if ((document.documentElement.getAttribute("data-theme-mode") || "auto") === "auto") applyTheme("auto");
        });
      } catch (e) {}
    }
  }

  function bindNav() {
    var nav = $("navbar");
    if (!nav) return;
    nav.addEventListener("click", function (ev) {
      var t = ev.target;
      while (t && t !== nav && !(t.getAttribute && t.getAttribute("data-page"))) t = t.parentNode;
      if (t && t !== nav) showPage(t.getAttribute("data-page"));
    });
  }

  function bindHome() {
    var b;
    if ((b = $("btnRefresh"))) b.onclick = refresh;
    if ((b = $("swEnable"))) b.onchange = function () { setEnable(this.checked); };
    if ((b = $("btnApply"))) b.onclick = applyQuick;
    if ((b = $("btnSaveOpts"))) b.onclick = saveOpts;
    if ((b = $("btnGoLog"))) b.onclick = function () { showPage("about"); };

    var raw = $("btnRaw");
    if (raw) raw.onclick = function () {
      var blk = $("rawBlock");
      if (!blk) return;
      var open = blk.className.indexOf("open") >= 0;
      blk.className = open ? "rawblock" : "rawblock open";
      raw.className = open ? "item link" : "item link open";
    };

    var walt = $("btnWalt");
    if (walt) walt.onclick = function () {
      var blk = $("waltBlock");
      if (!blk) return;
      var open = blk.className.indexOf("open") >= 0;
      blk.className = open ? "rawblock" : "rawblock open";
      walt.className = open ? "item link" : "item link open";
      if (!open) loadWalt();   /* 只在展开时读，少一次 shell */
    };

    var seg = $("modeSeg");
    if (seg) seg.addEventListener("click", function (ev) {
      var t = ev.target;
      while (t && t !== seg && !(t.getAttribute && t.getAttribute("data-mode"))) t = t.parentNode;
      if (t && t !== seg) setMode(t.getAttribute("data-mode"));
    });
  }

  function bindConfig() {
    var b;
    if ((b = $("btnSaveConf"))) b.onclick = saveConf;
    if ((b = $("btnAdd"))) b.onclick = function () { addPkg($("inPkg").value); $("inPkg").value = ""; };
    if ((b = $("btnAddExcl"))) b.onclick = function () { addEntry($("inPkg").value, true); $("inPkg").value = ""; };
    if ((b = $("inPkg"))) b.onkeydown = function (e) { if (e.keyCode === 13) { addPkg(this.value); this.value = ""; } };
    if ((b = $("btnFg"))) b.onclick = function () {
      /* 优先用内核正在跟踪的渲染进程 pid → /proc/<pid>/cmdline（比 dumpsys 快得多） */
      KSU.exec("cat " + PROC + "/status 2>/dev/null | sed -n 's/^pid *: *//p' | head -n1").then(function (r) {
        var pid = (r.stdout || "").replace(/\D/g, "");
        if (!pid || pid === "0") return dumpsysPkg();
        return KSU.exec("cat /proc/" + pid + "/cmdline 2>/dev/null | tr '\\0' '\\n' | head -n1").then(function (r2) {
          var pkg = (r2.stdout || "").split("\n")[0].replace(/^\s+|\s+$/g, "").split(":")[0];
          if (pkg) { $("inPkg").value = pkg; toast("填入 " + pkg); }
          else return dumpsysPkg();
        });
      });
    };
    if ((b = $("inSearch"))) b.oninput = function () { renderAppPick(this.value); };
  }

  function dumpsysPkg() {
    return KSU.exec("dumpsys window 2>/dev/null | sed -n 's/.*mCurrentFocus=.*{[^/ ]*\\([^/ ]*\\)\\/.*/\\1/p' | head -n1").then(function (r) {
      var pkg = (r.stdout || "").replace(/^\s+|\s+$/g, "");
      if (pkg) { $("inPkg").value = pkg; toast("填入 " + pkg); }
      else toast("未取到前台应用");
    });
  }

  function bindAbout() {
    var b = $("btnAboutRefresh");
    if (b) b.onclick = refreshAbout;
  }

  /* 清理部分旧版 Android WebView / 宿主注入的裸字面 \\n 文本，避免页面顶部出现 \\n\\n。 */
  function cleanBootNoise() {
    try {
      var body = document.body, i, n, s;
      if (!body) return;
      for (i = 0; i < body.childNodes.length; i++) {
        n = body.childNodes[i];
        if (n && n.nodeType === 3) {
          s = String(n.nodeValue || "");
          /* 纯空白，或只由字面 \\n / \\r（单个反斜杠 + n/r）拼成的文本节点 -> 直接删掉 */
          if (/^(?:\s|\\[nr])+$/.test(s)) n.nodeValue = "";
        }
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------ UI 反馈增强 */
  function enhanceUi() {
    var ids = ["btnApply", "btnSaveOpts", "btnSaveConf", "btnRefresh", "btnAboutRefresh"];
    var i, el;
    for (i = 0; i < ids.length; i++) {
      el = $(ids[i]);
      if (!el) continue;
      el.addEventListener("pointerdown", function () { this.className += " is-pressing"; });
      el.addEventListener("pointerup", function () { this.className = this.className.replace(/\s+is-pressing/g, ""); });
      el.addEventListener("pointercancel", function () { this.className = this.className.replace(/\s+is-pressing/g, ""); });
      el.addEventListener("pointerleave", function () { this.className = this.className.replace(/\s+is-pressing/g, ""); });
    }

    var inputs = document.querySelectorAll("input, select");
    for (i = 0; i < inputs.length; i++) inputs[i].setAttribute("autocomplete", "off");

    var nav = $("navbar");
    if (nav) nav.setAttribute("role", "navigation");
    var cards = document.querySelectorAll(".card");
    for (i = 0; i < cards.length; i++) cards[i].setAttribute("role", "region");

    /* 点 label 就能聚焦对应输入框：自动补 for=，以后新增字段也不用管 */
    var flds = document.querySelectorAll(".fld");
    for (i = 0; i < flds.length; i++) {
      var lb = flds[i].querySelector("label"), ctl = flds[i].querySelector("input, select");
      if (lb && ctl && ctl.id && !lb.getAttribute("for")) lb.setAttribute("for", ctl.id);
    }

    /* 提示条对辅助技术可见 */
    var tst = $("toast");
    if (tst) { tst.setAttribute("role", "status"); tst.setAttribute("aria-live", "polite"); }

    /* 改过输入 → 对应保存按钮点亮小圆点（CSS .btn.dirty::after） */
    bindDirty("btnSaveOpts");
    bindDirty("btnSaveConf");
  }

  /* 卡片里任何输入变化就给保存按钮加 .dirty；点保存时清掉 */
  function bindDirty(btnId) {
    var btn = $(btnId), card;
    if (!btn || !btn.closest) return;
    card = btn.closest(".card");
    if (!card) return;
    var mark = function () {
      if (btn.className.indexOf("dirty") < 0) btn.className += " dirty";
    };
    card.addEventListener("input", mark);
    card.addEventListener("change", mark);
    btn.addEventListener("click", function () {
      btn.className = btn.className.replace(/\s+dirty/g, "");
    });
  }

  /* ------------------------------------------------------------ 启动 */
  function safe(fn) { try { return fn(); } catch (e) { window.showErr && window.showErr(e && e.message ? e.message : String(e)); } }

  function boot() {
    safe(cleanBootNoise); safe(bindTheme); safe(bindNav); safe(bindHome); safe(bindConfig); safe(bindAbout); safe(enhanceUi);
    safe(function () { fillRtgId("o_rtgid"); fillRtgId("t_rtg"); });
    safe(function () { refresh(); });
    safe(loadConf); safe(loadOpts); safe(loadMode); safe(refreshAbout);
    /* 每 3s 只看一眼首页状态；页面在后台/息屏时跳过 —— 每次 refresh() 都要起一次
       shell，后台白跑既费电又没意义 */
    setInterval(function () {
      var h;
      if (document.hidden) return;
      h = $("page-home");
      if (h && h.className.indexOf("active") >= 0) refresh();
    }, 3000);

    /* 回到前台立刻补一次，不用等下一个 3s 周期 */
    document.addEventListener("visibilitychange", function () {
      var h;
      if (document.hidden) return;
      h = $("page-home");
      if (h && h.className.indexOf("active") >= 0) refresh();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
