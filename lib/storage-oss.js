/*
 * 云端上传 —— 阿里云 OSS 实现(国内/香港机房,工厂网络快)。
 * 仅当 window.QC_CONFIG.provider === 'oss' 时启用,注册到 window.QCStorage。
 *
 * 设计与 Supabase 版一致:员工端用一把"只能上传"的 RAM 钥匙(放在网页里,
 * 即使被看到也只能 PutObject,不能读/列/删)。每台记录上传两个对象:
 *   records/qc-photo-organizer/质检员首次检查/YYYY-MM-DD/{model}-{unit}.zip
 *   records/qc-photo-organizer/质检员首次检查/YYYY-MM-DD/{model}-{unit}.json
 *   records/qc-photo-organizer/最终审查/YYYY-MM-DD/{report}.zip  (主管复检)
 * 后台按日期文件夹浏览,点开 .json 即可建表,再下载对应 .zip。
 */
(function () {
  'use strict';

  var cfg = window.QC_CONFIG || {};
  if (cfg.provider !== 'oss') return; // 不是 OSS 模式则不接管

  var o = cfg.oss || {};

  // 上传走本地 presign(WebCrypto V1 签名)+ fetch,不再依赖 OSS SDK——员工端
  // index.html 因此不必加载那 600KB 的 SDK。签名需要 crypto.subtle(仅 HTTPS /
  // localhost 提供),拿不到就降级为仅本地打包下载。
  function configured() {
    return !!(o.region && o.bucket && o.accessKeyId && o.accessKeySecret &&
      window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined');
  }

  function datePrefix() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  // ---------- multipart upload (大 ZIP 分片直传) ----------
  //
  // iOS WebKit refuses to dispatch a single fetch() whose body is tens of MB
  // (instant "Load failed" — the whole body must cross IPC to the network
  // process in one piece). So anything bigger than one part goes through OSS
  // multipart: initiate → 8MB part PUTs → complete. Every request is a plain
  // fetch with a presigned V1 URL and a small body; each part has its own
  // timeout and retries, which also fixes "one 60s timeout for a 100MB ZIP".

  var PART_SIZE = 8 * 1024 * 1024;

  function hmacSha1(secret, msg) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, enc.encode(msg)); })
      .then(function (buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s);
      });
  }

  // Presigned URL for any verb/subresource (the SDK's signatureUrl can't sign
  // the `uploads` subresource unambiguously). Subresource values stay raw in
  // the signature but percent-encoded in the URL, per the OSS V1 spec.
  function presign(method, key, subRes, contentType) {
    var expires = Math.floor(Date.now() / 1000) + 300;
    var subKeys = Object.keys(subRes).sort();
    var resQuery = subKeys.map(function (k) { return subRes[k] === '' ? k : k + '=' + subRes[k]; }).join('&');
    var resource = '/' + o.bucket + '/' + key + (resQuery ? '?' + resQuery : '');
    var toSign = method + '\n\n' + (contentType || '') + '\n' + expires + '\n' + resource;
    return hmacSha1(o.accessKeySecret, toSign).then(function (sig) {
      var q = 'OSSAccessKeyId=' + encodeURIComponent(o.accessKeyId) + '&Expires=' + expires +
        '&Signature=' + encodeURIComponent(sig);
      subKeys.forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(subRes[k]); });
      var encKey = key.split('/').map(encodeURIComponent).join('/');
      return 'https://' + o.bucket + '.' + o.region + '.aliyuncs.com/' + encKey + '?' + q;
    });
  }

  function fetchT(url, opts, timeoutMsg) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); });
      return r;
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error(timeoutMsg || '请求超时（60秒）');
      throw e;
    });
  }

  function putPart(key, uploadId, n, bytes, attempt) {
    return presign('PUT', key, { partNumber: String(n), uploadId: uploadId }, '').then(function (url) {
      return fetchT(url, { method: 'PUT', body: bytes }, '第' + n + '片上传超时（60秒）');
    }).then(function (r) {
      var etag = r.headers.get('etag');
      if (!etag) throw new Error('第' + n + '片读不到 ETag（可能被网络设备改写了响应）');
      return etag;
    }).catch(function (e) {
      if (attempt >= 3) throw new Error('第' + n + '片：' + (e && e.message ? e.message : e));
      return new Promise(function (res) { setTimeout(res, attempt * 1000); })
        .then(function () { return putPart(key, uploadId, n, bytes, attempt + 1); });
    });
  }

  function multipartPut(key, u8, ct, onProgress) {
    var uploadId;
    return presign('POST', key, { uploads: '' }, ct).then(function (url) {
      return fetchT(url, { method: 'POST', headers: { 'Content-Type': ct } }, '初始化分片上传超时');
    }).then(function (r) { return r.text(); }).then(function (xml) {
      var m = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
      if (!m) throw new Error('初始化分片上传失败（响应里没有 UploadId）');
      uploadId = m[1];
      var total = Math.ceil(u8.length / PART_SIZE);
      var etags = [];
      var chain = Promise.resolve();
      for (var n = 1; n <= total; n++) (function (n) {
        chain = chain.then(function () {
          return putPart(key, uploadId, n, u8.subarray((n - 1) * PART_SIZE, Math.min(n * PART_SIZE, u8.length)), 1);
        }).then(function (etag) {
          etags.push(etag);
          if (onProgress) onProgress(n, total);
        });
      })(n);
      return chain.then(function () {
        var body = '<CompleteMultipartUpload>' + etags.map(function (e, i) {
          return '<Part><PartNumber>' + (i + 1) + '</PartNumber><ETag>' + e + '</ETag></Part>';
        }).join('') + '</CompleteMultipartUpload>';
        return presign('POST', key, { uploadId: uploadId }, 'application/xml').then(function (url) {
          return fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: body }, '合并分片超时');
        });
      });
    }).catch(function (e) {
      // 尽力中止分片上传,免得传了一半的分片一直占存储。RAM 钥匙若无 Abort
      // 权限就静默放弃,由 bucket 生命周期规则兜底清理。
      var fail = Promise.reject(e);
      if (!uploadId) return fail;
      return presign('DELETE', key, { uploadId: uploadId }, '').then(function (url) {
        return fetch(url, { method: 'DELETE' });
      }).then(function () { return fail; }, function () { return fail; });
    });
  }

  // The OSS SDK's internal XHR path uses FileReader to read Blobs, which fails
  // on some iOS/Android WebKit versions ("The I/O read operation failed").
  // Using a pre-signed PUT URL + fetch() bypasses that code path entirely.
  //
  // On iOS WebKit, EVERY blob read (FileReader, blob.arrayBuffer(), fetch with a
  // Blob body) goes through the blob registry in the network process — which can
  // be disk-backed for large blobs — and can throw NotReadableError
  // ("The I/O read operation failed") under memory/storage pressure. So `data`
  // should be a Uint8Array/ArrayBuffer whenever the caller has one (JSZip can
  // output uint8array directly); it is handed to fetch() as-is with no blob
  // registry involvement. A Blob still works as a fallback for small payloads.
  function putViaFetch(key, data, contentType) {
    var ct = contentType || data.type || 'application/octet-stream';
    var isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    var bodyP = isBlob && typeof data.arrayBuffer === 'function'
      ? data.arrayBuffer()
      : Promise.resolve(data);
    // 单体 PUT 的预签名 URL,与分片路径用同一个本地 presign(同样的 V1 签名)。
    return Promise.all([presign('PUT', key, {}, ct), bodyP]).then(function (parts) {
      var url = parts[0], body = parts[1];
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
      return fetch(url, {
        method: 'PUT',
        body: body,
        headers: { 'Content-Type': ct },
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) return r.text().then(function (t) { throw new Error('PUT ' + r.status + ': ' + t); });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('上传超时（60秒）');
        throw e;
      });
    });
  }

  // rec = { bytes?, blob?, folder, model, unit, inspector, photoCount,
  //         defectCount, defectSurfaceCount, attachCount, notes, subfolder,
  //         onProgress? }
  // bytes (Uint8Array) is preferred over blob — see putViaFetch. ZIPs bigger
  // than one part go through multipartPut; onProgress(done, total) reports
  // finished parts so the page can show progress on long uploads.
  function upload(rec) {
    if (!configured()) return Promise.reject(new Error('未配置阿里云 OSS'));
    var subfolder = rec.subfolder || '质检员首次检查';
    var base = 'records/qc-photo-organizer/' + subfolder + '/' + datePrefix() + '/' + rec.folder;
    var zipKey = base + '.zip';
    var jsonKey = base + '.json';

    var meta = {
      folder: rec.folder,
      model: rec.model,
      unit: rec.unit,
      inspector: rec.inspector || '',
      photo_count: rec.photoCount || 0,
      defect_count: rec.defectCount || 0,
      defect_surface_count: rec.defectSurfaceCount || 0,
      attach_count: rec.attachCount || 0,
      notes: (rec.notes && rec.notes.length) ? rec.notes : [],
      created_at: new Date().toISOString(),
      zip_key: zipKey,
    };
    var jsonBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });

    // ZIP first, JSON second — JSON appearing means the upload is complete.
    // crypto.subtle 只在 HTTPS 下可用;万一不可用(本地 http 调试)退回整体 PUT。
    var canMultipart = rec.bytes && rec.bytes.length > PART_SIZE &&
      window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined';
    var zipP = canMultipart
      ? multipartPut(zipKey, rec.bytes, 'application/zip', rec.onProgress)
      : putViaFetch(zipKey, rec.bytes || rec.blob, 'application/zip');
    return zipP.then(function () {
      return putViaFetch(jsonKey, jsonBlob, 'application/json');
    }).then(function () {
      return { ok: true, path: zipKey };
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (e && (e.name === 'RequestError' || e.code === 'RequestError')) {
        msg = '网络无法连到 OSS(请检查网络 / bucket 跨域CORS设置)：' + msg;
      }
      throw new Error(msg);
    });
  }

  window.QCStorage = { configured: configured, upload: upload };
})();
