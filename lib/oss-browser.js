/*
 * 云端文件浏览器(只读)—— 在网页里直接浏览阿里云 OSS 某个前缀下的
 * 文件夹/文件,像 OSS 控制台那样逐层进入、查看大小/修改时间、下载、预览图片。
 *
 * 与「汇总后台 admin.js」不同:这里不解析 .json 建表,而是原样展示对象列表
 * (delimiter='/' 逐层列),所以 .zip / .json / 任何文件都能看到,贴近控制台。
 * 「平铺全部」按钮可切到递归模式:去掉 delimiter,把当前文件夹下所有子文件夹里的
 * 文件一次性平铺出来(文件名带相对子路径),便于一眼看完某阶段下的全部文件。
 *
 * 页面无关:挂载时传入容器与【只读】RAM 钥匙即可,自己不持有任何 DOM 约定。
 *   var ctl = window.QCOssBrowser.mount({
 *     container, region, bucket, accessKeyId, accessKeySecret,
 *     prefix: 'records/qc-photo-organizer/',  // 浏览的根前缀
 *     autoRefreshMs: 18000,                   // 可选,默认 18s;0 关闭自动刷新
 *     fileFilter: /\.zip$/i,                  // 可选:只显示匹配的文件(隐藏 .json 等)
 *     onImport: function (file) {...}         // 可选:.zip 行多一个「导入」按钮,
 *   });                                       //   点了就取回字节、包成 File 回调给页面
 *
 *   ctl.refresh(); ctl.pause(); ctl.resume(); ctl.destroy();
 *
 * 读取需要 RAM 钥匙具备 oss:ListObjects + oss:GetObject,且桶已配置跨域 CORS
 * (允许本站点 GET/HEAD)—— 与 admin 后台同一套要求。
 */
(function () {
  'use strict';

  var IMG_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t);
    if (isNaN(d.getTime())) return '';
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 去掉前缀,得到当前层的短名(文件夹去掉末尾 '/')。
  function leafName(key, prefix) {
    var rest = key.indexOf(prefix) === 0 ? key.slice(prefix.length) : key;
    if (rest.charAt(rest.length - 1) === '/') rest = rest.slice(0, -1);
    return rest;
  }

  function mount(opts) {
    var box = opts.container;
    if (!box) throw new Error('QCOssBrowser.mount 需要 container');
    if (!window.OSS) { box.innerHTML = '<div class="ossb-msg ossb-err">OSS SDK 未加载</div>'; return noop(); }

    var root = opts.prefix || '';
    if (root && root.charAt(root.length - 1) !== '/') root += '/';

    var client = new window.OSS({
      region: opts.region, bucket: opts.bucket,
      accessKeyId: opts.accessKeyId, accessKeySecret: opts.accessKeySecret,
      secure: true,
    });

    var cur = root;             // 当前浏览的前缀
    var flat = false;           // 平铺模式:递归列出该前缀下全部文件(忽略子文件夹层级)
    var renderedFiles = [];     // 当前已渲染的文件(供「导入」按钮按下标取回 key)
    var loadSeq = 0;            // 防止旧请求覆盖新请求
    var paused = false;
    var autoMs = opts.autoRefreshMs == null ? 18000 : +opts.autoRefreshMs;
    var timer = null;

    // ---------- OSS:列出(分层 or 平铺)----------
    // isFlat=false:逐层列(delimiter='/'),返回当层文件夹 + 文件;
    // isFlat=true :去掉 delimiter,递归列出该前缀下「全部文件」(文件名带子路径)。
    function listLevel(prefix, isFlat) {
      var folders = [], files = [];
      function page(marker, guard) {
        var q = { prefix: prefix, 'max-keys': 1000 };
        if (!isFlat) q.delimiter = '/';
        if (marker) q.marker = marker;
        return client.list(q, {}).then(function (res) {
          (res.prefixes || []).forEach(function (p) { folders.push(p); });
          (res.objects || []).forEach(function (ob) {
            if (ob.name === prefix) return;                       // 跳过前缀自身
            if (ob.name.charAt(ob.name.length - 1) === '/') return; // 跳过文件夹占位对象
            files.push({ key: ob.name, size: ob.size, lastModified: ob.lastModified });
          });
          // 平铺可能很多页,放宽到 50 页(5 万对象)再停。
          var cap = isFlat ? 50 : 20;
          if (res.isTruncated && res.nextMarker && guard < cap) return page(res.nextMarker, guard + 1);
        });
      }
      return page(null, 0).then(function () { return { folders: folders, files: files }; });
    }

    function signedUrl(key, asAttachment) {
      var o = { expires: 3600 };
      if (asAttachment) {
        var name = leafName(key, key.replace(/[^/]*$/, '')); // basename
        o.response = { 'content-disposition': 'attachment; filename="' + encodeURIComponent(name) + '"' };
      }
      return client.signatureUrl(key, o);
    }

    // 「导入」:取回该对象字节,包成 File 交给页面的 onImport(页面负责解析/跳转)。
    function doImport(f, btn) {
      if (!opts.onImport || !f) return;
      var prev = btn.textContent;
      btn.disabled = true; btn.textContent = '导入中…';
      fetch(signedUrl(f.key, false)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var name = leafName(f.key, f.key.replace(/[^/]*$/, '')); // basename
        var file;
        try { file = new File([blob], name, { type: 'application/zip' }); }
        catch (e) { file = blob; try { file.name = name; } catch (e2) {} }
        return opts.onImport(file);
      }).then(function () {
        // 成功后页面通常已切到下一页;按钮多半随刷新消失,这里兜底恢复。
        btn.disabled = false; btn.textContent = prev;
      }).catch(function (e) {
        console.error('导入失败', e);
        btn.disabled = false; btn.textContent = '导入失败,重试';
      });
    }

    // ---------- 渲染 ----------
    function breadcrumbHtml() {
      // 以 root 为「根」,其后逐段可点回退
      var tail = cur.indexOf(root) === 0 ? cur.slice(root.length) : '';
      var segs = tail.split('/').filter(Boolean);
      var html = '<a href="#" data-go="' + esc(root) + '">根目录</a>';
      var acc = root;
      segs.forEach(function (s) {
        acc += s + '/';
        html += ' <span class="ossb-sep">/</span> <a href="#" data-go="' + esc(acc) + '">' + esc(s) + '</a>';
      });
      return html;
    }

    function render(data) {
      var rows = '';
      // 只显示某类文件(主管端只看 .zip,隐藏 .json 等附带文件)。
      if (opts.fileFilter) {
        data.files = data.files.filter(function (f) { return opts.fileFilter.test(f.key); });
      }
      // 文件夹按名倒序(日期目录最新在上);文件按修改时间新→旧。
      data.folders.sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; });
      data.files.sort(function (a, b) {
        var ta = +new Date(a.lastModified) || 0, tb = +new Date(b.lastModified) || 0;
        if (tb !== ta) return tb - ta;
        return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
      });
      renderedFiles = data.files;          // 供「导入」按钮按下标取回对应文件
      data.folders.forEach(function (p) {
        rows += '<div class="ossb-row ossb-row--dir" data-go="' + esc(p) + '">' +
          '<span class="ossb-ic">📁</span>' +
          '<span class="ossb-name">' + esc(leafName(p, cur)) + '</span>' +
          '<span class="ossb-meta">文件夹</span>' +
          '<span class="ossb-act">进入 ›</span>' +
        '</div>';
      });
      data.files.forEach(function (f, idx) {
        var name = leafName(f.key, cur);
        var dl = signedUrl(f.key, true);
        var actions = '';
        if (IMG_RE.test(name)) {
          actions += '<a class="ossb-btn" href="' + esc(signedUrl(f.key, false)) + '" target="_blank" rel="noopener">预览</a>';
        }
        if (opts.onImport && /\.zip$/i.test(name)) {
          actions += '<button type="button" class="ossb-btn ossb-btn--imp" data-import="' + idx + '">导入</button>';
        }
        actions += '<a class="ossb-btn ossb-btn--dl" href="' + esc(dl) + '" target="_blank" rel="noopener">下载</a>';
        rows += '<div class="ossb-row">' +
          '<span class="ossb-ic">📄</span>' +
          '<span class="ossb-name">' + esc(name) + '</span>' +
          '<span class="ossb-meta">' + esc(fmtSize(f.size)) + ' · ' + esc(fmtTime(f.lastModified)) + '</span>' +
          '<span class="ossb-act">' + actions + '</span>' +
        '</div>';
      });
      if (!rows) rows = '<div class="ossb-msg">此文件夹为空。</div>';

      var stat = flat
        ? (data.files.length + ' 个文件(平铺含子文件夹)')
        : (data.folders.length + ' 个文件夹 · ' + data.files.length + ' 个文件');
      box.innerHTML =
        '<div class="ossb-bar">' +
          '<div class="ossb-crumb">' + breadcrumbHtml() + '</div>' +
          '<button type="button" class="ossb-refresh" data-flat-toggle>' + (flat ? '分文件夹' : '平铺全部') + '</button>' +
          '<button type="button" class="ossb-refresh" data-refresh>刷新</button>' +
        '</div>' +
        '<div class="ossb-stat">' + stat + ' · 更新于 ' + esc(fmtTime(new Date())) + '</div>' +
        '<div class="ossb-list">' + rows + '</div>';
    }

    function renderError(e) {
      var msg = (e && e.message) ? e.message : String(e);
      box.innerHTML =
        '<div class="ossb-bar"><div class="ossb-crumb">' + breadcrumbHtml() + '</div>' +
          '<button type="button" class="ossb-refresh" data-refresh>重试</button></div>' +
        '<div class="ossb-msg ossb-err">读取失败:' + esc(msg) +
        '<br><small>请检查只读钥匙权限(ListObjects/GetObject)与桶的跨域 CORS 设置。</small></div>';
    }

    function load(showSpin) {
      var seq = ++loadSeq;
      if (showSpin && !box.querySelector('.ossb-list')) {
        box.innerHTML = '<div class="ossb-msg">加载中…</div>';
      }
      return listLevel(cur, flat).then(function (data) {
        if (seq !== loadSeq) return;               // 已有更新的请求,丢弃本次
        render(data);
      }).catch(function (e) {
        if (seq !== loadSeq) return;
        renderError(e);
      });
    }

    // ---------- 事件(委托)----------
    box.addEventListener('click', function (e) {
      var go = e.target.closest('[data-go]');
      if (go) { e.preventDefault(); cur = go.getAttribute('data-go'); load(true); return; }
      var imp = e.target.closest('[data-import]');
      if (imp) { e.preventDefault(); doImport(renderedFiles[+imp.getAttribute('data-import')], imp); return; }
      if (e.target.closest('[data-flat-toggle]')) { e.preventDefault(); flat = !flat; load(true); return; }
      if (e.target.closest('[data-refresh]')) { e.preventDefault(); load(true); return; }
      // 下载/预览是真链接,放行默认行为(新标签页)
    });

    // ---------- 自动刷新 ----------
    function tick() {
      if (paused) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      load(false);
    }
    function startTimer() { if (autoMs > 0 && !timer) timer = setInterval(tick, autoMs); }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    load(true);
    startTimer();

    return {
      refresh: function () { return load(true); },
      pause: function () { paused = true; },
      resume: function () { paused = false; startTimer(); return load(true); },
      destroy: function () { stopTimer(); box.innerHTML = ''; },
    };
  }

  function noop() { return { refresh: function () {}, pause: function () {}, resume: function () {}, destroy: function () {} }; }

  window.QCOssBrowser = { mount: mount };
})();
