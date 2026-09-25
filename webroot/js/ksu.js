/* ============================================================================
 * fps_boost_ctl · KernelSU WebUI 桥接层
 *
 * 只负责与管理器通信，不含业务逻辑：
 *  - exec()      : 以 root 执行 shell（返回 Promise<{errno,stdout,stderr}>）
 *  - toast()     : 管理器原生 toast
 *  - listPackages()/packagesInfo() : 已安装应用（不同管理器版本返回
 *                   JSON 字符串或数组，这里统一成数组）
 *  - moduleInfo(): 模块信息
 *  - envInfo()   : 渲染引擎自检（排障用）
 * ========================================================================== */
var KSU = (function () {
  function has() {
    return !!(window.ksu && typeof window.ksu.exec === "function");
  }

  /* 执行 shell 命令；第三参在 KernelSU 里是「回调函数名字符串」 */
  function exec(cmd) {
    return new Promise(function (resolve) {
      if (!has()) { resolve({ errno: -1, stdout: "", stderr: "window.ksu 不可用" }); return; }
      var cb = "fb_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      window[cb] = function (errno, stdout, stderr) {
        delete window[cb];
        resolve({ errno: errno, stdout: stdout || "", stderr: stderr || "" });
      };
      try {
        window.ksu.exec(cmd, JSON.stringify({}), cb);
      } catch (e) {
        delete window[cb];
        resolve({ errno: -1, stdout: "", stderr: String(e) });
      }
    });
  }

  function toast(text) {
    try { if (window.ksu && window.ksu.toast) window.ksu.toast(text); } catch (e) {}
  }

  /* 有的版本返回 JSON 字符串、有的返回数组，统一成数组 */
  function toArr(v) {
    if (v === undefined || v === null) return [];
    if (typeof v === "string") {
      try { var a = JSON.parse(v); return Object.prototype.toString.call(a) === "[object Array]" ? a : []; }
      catch (e) { return []; }
    }
    return Object.prototype.toString.call(v) === "[object Array]" ? v : [];
  }

  function listPackages(type) {
    try {
      if (!window.ksu || typeof window.ksu.listPackages !== "function") return [];
      return toArr(window.ksu.listPackages(type || "user"));
    } catch (e) { return []; }
  }

  function packagesInfo(pkgs) {
    try {
      if (!window.ksu || typeof window.ksu.getPackagesInfo !== "function") return [];
      return toArr(window.ksu.getPackagesInfo(JSON.stringify(pkgs)));
    } catch (e) { return []; }
  }

  function moduleInfo() {
    try {
      if (!window.ksu || !window.ksu.moduleInfo) return null;
      var mi = window.ksu.moduleInfo();
      if (typeof mi === "string") mi = JSON.parse(mi);
      return mi && typeof mi === "object" ? mi : null;
    } catch (e) { return null; }
  }

  function featureOk(src) {
    try { new Function(src); return "支持"; } catch (e) { return "不支持"; }
  }

  function envInfo() {
    return "UA: " + navigator.userAgent +
      "\nasync/await: " + featureOk("return async function(){}") +
      " · 箭头函数: " + featureOk("return ()=>1") +
      " · NodeList.forEach: " +
      ((typeof NodeList !== "undefined" && NodeList.prototype && NodeList.prototype.forEach) ? "支持" : "不支持") +
      "\nksu bridge: " + (has() ? "可用" : "不可用") +
      " · 页面高度: " + window.innerHeight + "px";
  }

  return {
    has: has, exec: exec, toast: toast, toArr: toArr,
    listPackages: listPackages, packagesInfo: packagesInfo,
    moduleInfo: moduleInfo, envInfo: envInfo
  };
})();
