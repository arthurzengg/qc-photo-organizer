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

  function configured() {
    return !!(window.OSS && o.region && o.bucket && o.accessKeyId && o.accessKeySecret);
  }

  function client() {
    return new window.OSS({
      region: o.region,
      bucket: o.bucket,
      accessKeyId: o.accessKeyId,
      accessKeySecret: o.accessKeySecret,
      secure: true,            // 走 https
    });
  }

  function datePrefix() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
  function putViaFetch(c, key, data, contentType) {
    var ct = contentType || data.type || 'application/octet-stream';
    var url = c.signatureUrl(key, { method: 'PUT', expires: 300, 'Content-Type': ct });
    var isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    var bodyP = isBlob && typeof data.arrayBuffer === 'function'
      ? data.arrayBuffer()
      : Promise.resolve(data);
    return bodyP.then(function (body) {
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
  //         defectCount, defectSurfaceCount, attachCount, notes, subfolder }
  // bytes (Uint8Array) is preferred over blob — see putViaFetch.
  function upload(rec) {
    if (!configured()) return Promise.reject(new Error('未配置阿里云 OSS(或 SDK 未加载)'));
    var c = client();
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
    return putViaFetch(c, zipKey, rec.bytes || rec.blob, 'application/zip').then(function () {
      return putViaFetch(c, jsonKey, jsonBlob, 'application/json');
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
