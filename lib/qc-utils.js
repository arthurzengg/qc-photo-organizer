/*
 * Shared page-agnostic helpers for app.js / supervisor.js (and future pages).
 * Pure functions only — no DOM lookups, no page state. Anything that touches
 * a specific element (toasts, overlays) stays in the page script.
 *
 * Loaded by boot.js / boot-supervisor.js after lib/qc-domain.js (isImageName /
 * isRenderable read QCDomain's extension lists).
 *
 * 历史教训:这些函数从前在 app.js 和 supervisor.js 各复制一份,iOS 下载修复
 * (download 点击会取消进行中的请求)当时要改两处。共享后只改一处。
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function formatNow() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- File names & types ----

  function extFromName(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function extFromMime(type) {
    var map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
      'image/bmp': 'bmp', 'image/tiff': 'tif',
    };
    return map[(type || '').toLowerCase()] || '';
  }

  function fileExt(file) {
    return extFromName(file.name) || extFromMime(file.type) || 'bin';
  }

  function baseName(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // Is this entry name an image file (for scanning imported ZIPs)?
  function isImageName(name) {
    return window.QCDomain.IMG_EXT.indexOf(extFromName(name)) !== -1;
  }

  // Whether the browser can likely render this File as an <img>. HEIC/HEIF are
  // included — iOS Safari decodes them natively; desktop browsers that cannot
  // decode HEIC fire img.onerror and the caller falls back.
  function isRenderable(file) {
    var t = (file.type || '').toLowerCase();
    if (t.indexOf('image/') === 0) return true;
    if (!t && window.QCDomain.RENDERABLE_EXT.indexOf(extFromName(file.name)) !== -1) return true;
    return false;
  }

  // Strip filesystem-illegal characters while preserving Chinese (kept as UTF-8
  // in the ZIP entry names). Returns a safe, length-capped name.
  function sanitizeFilename(raw, fallback) {
    var s = String(raw == null ? '' : raw);
    if (s.normalize) s = s.normalize('NFC');
    s = s.replace(/[\/\\:*?"<>|]/g, '_'); // illegal on Windows/macOS
    s = s.replace(/[\x00-\x1f\x7f]/g, ''); // control chars
    s = s.replace(/\s+/g, ' ').trim();     // collapse whitespace
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no leading dots / trailing dot or space
    if (!s) s = fallback || '未命名';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = '_' + s; // Windows reserved
    return s.slice(0, 80);
  }

  // Sanitize an attachment's original filename, preserving its extension.
  function sanitizeAttachmentName(name) {
    var raw = String(name == null ? '' : name);
    var dot = raw.lastIndexOf('.');
    var base = dot > 0 ? raw.slice(0, dot) : raw;
    var ext = dot > 0 ? raw.slice(dot + 1) : '';
    base = sanitizeFilename(base, '附件');
    var safeExt = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
    return safeExt ? base + '.' + safeExt : base;
  }

  // "name.jpg" -> "name (2).jpg" until unused; `used` is a Set this mutates.
  function dedupe(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var i = 2, candidate;
    do { candidate = base + ' (' + i + ')' + ext; i++; } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  }

  // Increment a unit string, preserving any non-digit prefix/suffix and zero-pad
  // width: "01" -> "02", "09" -> "10", "A-01" -> "A-02". Non-numeric kept as-is.
  function incrementUnit(unit) {
    var s = String(unit || '').trim();
    var m = /^(\D*?)(\d+)(\D*)$/.exec(s);
    if (!m) return s || '01';
    var next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
    return m[1] + next + m[3];
  }

  // ---- Platform ----

  // iPad 桌面版 UA 报 MacIntel,用触点数兜底识别。
  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // NOTE (iOS): clicking an <a download> cancels the page's in-flight network
  // requests on iOS WebKit. Never call this while an upload is running there —
  // upload first, download when it settles. See generate() in app.js.
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  window.QCUtils = Object.freeze({
    escapeHtml: escapeHtml,
    csvEscape: csvEscape,
    formatNow: formatNow,
    formatSize: formatSize,
    extFromName: extFromName,
    extFromMime: extFromMime,
    fileExt: fileExt,
    baseName: baseName,
    isImageName: isImageName,
    isRenderable: isRenderable,
    sanitizeFilename: sanitizeFilename,
    sanitizeAttachmentName: sanitizeAttachmentName,
    dedupe: dedupe,
    incrementUnit: incrementUnit,
    isIOS: isIOS,
    triggerDownload: triggerDownload,
  });
})();
