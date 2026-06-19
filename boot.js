/*
 * 启动引导:从阿里云 OSS 读取云端配置(含上传钥匙),再加载存储模块与主程序。
 * 这样钥匙不进公开 git 仓库;配置对象就近放在深圳 OSS,读取很快。
 *
 * 取不到配置时降级:仍可本地拍照打包下载,只是不上传云端。
 */
(function () {
  'use strict';

  var V = 'v30';
  window.QC_VERSION = V; // 诊断弹窗里显示,确认真机跑的是哪个版本
  var CONFIG_URL = 'https://haoyao-qc-hk.oss-cn-hongkong.aliyuncs.com/public/qc-config.json';

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = cb || null;
    s.onerror = function () { window.alert('加载失败:' + src + '\n请检查网络后刷新。'); };
    document.body.appendChild(s);
  }

  // 顺序加载:域数据 → 共享工具 → 存储实现(接管 window.QCStorage) → 主程序
  function loadChain(srcs) {
    if (!srcs.length) return;
    loadScript(srcs[0], function () { loadChain(srcs.slice(1)); });
  }

  function startApp() {
    loadChain([
      'lib/qc-domain.js?' + V,
      'lib/qc-utils.js?' + V,
      'lib/storage-oss.js?' + V,
      'lib/storage.js?' + V,
      'app.js?' + V,
    ]);
  }

  fetch(CONFIG_URL + '?t=' + (new Date().getTime()), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (cfg) { window.QC_CONFIG = cfg; startApp(); })
    .catch(function (e) {
      console.error('云端配置加载失败,降级为仅本地打包', e);
      window.QC_CONFIG = {}; // 无上传能力,但本地生成下载仍可用
      startApp();
    });
})();
