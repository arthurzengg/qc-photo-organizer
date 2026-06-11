/*
 * Boot loader for supervisor.html — mirrors boot.js but loads supervisor.js
 * instead of app.js. Fetches the same remote config so cloud upload credentials
 * are available on the supervisor page too.
 */
(function () {
  'use strict';

  var V = 'v22';
  var CONFIG_URL = 'https://haoyao-qc-hk.oss-cn-hongkong.aliyuncs.com/public/qc-config.json';

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = cb || null;
    s.onerror = function () { console.error('加载失败: ' + src); if (cb) cb(); };
    document.body.appendChild(s);
  }

  function startApp() {
    loadScript('lib/aliyun-oss-sdk.min.js?' + V, function () {
      loadScript('lib/storage-oss.js?' + V, function () {
        loadScript('lib/storage.js?' + V, function () {
          loadScript('supervisor.js?v9');
        });
      });
    });
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
