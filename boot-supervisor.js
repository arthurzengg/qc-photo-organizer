/*
 * Boot loader for supervisor.html — mirrors boot.js but loads supervisor.js
 * instead of app.js. Fetches the same remote config so cloud upload credentials
 * are available on the supervisor page too.
 */
(function () {
  'use strict';

  var V = 'v29';
  window.QC_VERSION = V; // 诊断时确认真机跑的是哪个版本
  var CONFIG_URL = 'https://haoyao-qc-hk.oss-cn-hongkong.aliyuncs.com/public/qc-config.json';

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = cb || null;
    s.onerror = function () { console.error('加载失败: ' + src); if (cb) cb(); };
    document.body.appendChild(s);
  }

  // 顺序加载:OSS SDK → 域数据 → 共享工具 → 存储实现 → 主程序
  function loadChain(srcs) {
    if (!srcs.length) return;
    loadScript(srcs[0], function () { loadChain(srcs.slice(1)); });
  }

  function startApp() {
    loadChain([
      'lib/aliyun-oss-sdk.min.js?' + V,
      'lib/qc-domain.js?' + V,
      'lib/qc-utils.js?' + V,
      'lib/storage-oss.js?' + V,
      'lib/storage.js?' + V,
      'supervisor.js?v13',
    ]);
  }

  fetch(CONFIG_URL + '?t=' + (new Date().getTime()), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (cfg) { window.QC_CONFIG = cfg; startApp(); })
    .catch(function (e) {
      console.error('云端配置加载失败,降级为仅本地', e);
      window.QC_CONFIG = {};
      startApp();
    });
})();
