/*
 * Server-side OSS object delete for the supervisor cloud browser (云端记录).
 *
 * Why this exists: the in-page browser authenticates with a PUBLIC, read-only
 * OSS key, so it cannot (and must not) delete. This function holds a
 * delete-scoped key as a Netlify ENV SECRET — the credential never reaches the
 * browser. The GitHub Pages page calls it cross-origin.
 *
 * Three independent gates, all server-side:
 *   1. 删除口令 (DELETE_PASSPHRASE) — a shared secret only authorized
 *      supervisors know; lives in no public file. This is the real boundary
 *      (users.json is public, so the client's button-hiding is UX only).
 *   2. username allow-list (DELETE_USERS, default "Harry,Arthur").
 *   3. path guard — can ONLY ever delete records/qc-photo-organizer/*.zip.
 *
 * Required Netlify environment variables:
 *   OSS_DELETE_KEY_ID, OSS_DELETE_KEY_SECRET  — a RAM key scoped to
 *       oss:DeleteObject on records/qc-photo-organizer/* in the bucket.
 *   DELETE_PASSPHRASE                          — the shared 删除口令.
 *   OSS_REGION   (default oss-cn-hongkong)
 *   OSS_BUCKET   (default haoyao-qc-hk)
 *   OSS_ENDPOINT (optional; default <bucket>.<region>.aliyuncs.com)
 *   DELETE_USERS (optional; default "Harry,Arthur")
 *   DELETE_ALLOW_ORIGINS (optional CSV; default https://arthurzengg.github.io)
 *
 * No npm dependencies: the OSS V1 signature is computed with node:crypto.
 */
'use strict';

var crypto = require('crypto');

var PREFIX = 'records/qc-photo-organizer/';

function corsHeaders(origin) {
  var allow = (process.env.DELETE_ALLOW_ORIGINS || 'https://arthurzengg.github.io')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var pick = (origin && allow.indexOf(origin) >= 0) ? origin : allow[0];
  return {
    'Access-Control-Allow-Origin': pick,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function safeEqual(a, b) {
  var ba = Buffer.from(String(a == null ? '' : a));
  var bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function json(statusCode, headers, obj) {
  return { statusCode: statusCode, headers: headers, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  var origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  var headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(origin));

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, headers, { error: '仅支持 POST' });

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, headers, { error: '请求格式错误' }); }

  var key = String(body.key || '');
  var user = String(body.user || '');
  var passphrase = String(body.passphrase || '');

  // --- gate 1: 删除口令 -------------------------------------------------
  var expected = process.env.DELETE_PASSPHRASE || '';
  if (!expected) return json(500, headers, { error: '服务未配置删除口令' });
  if (!safeEqual(passphrase, expected)) return json(401, headers, { error: '删除口令错误' });

  // --- gate 2: username allow-list -------------------------------------
  var allowUsers = (process.env.DELETE_USERS || 'Harry,Arthur')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (allowUsers.indexOf(user.trim().toLowerCase()) < 0) {
    return json(403, headers, { error: '该账号无删除权限' });
  }

  // --- gate 3: path guard ----------------------------------------------
  if (key.indexOf(PREFIX) !== 0 || key.indexOf('..') >= 0 || !/\.zip$/i.test(key)) {
    return json(400, headers, { error: '非法对象路径' });
  }

  // --- sign + send OSS DeleteObject (V1 signature, no SDK) --------------
  var region = process.env.OSS_REGION || 'oss-cn-hongkong';
  var bucket = process.env.OSS_BUCKET || 'haoyao-qc-hk';
  var host = process.env.OSS_ENDPOINT || (bucket + '.' + region + '.aliyuncs.com');
  var id = process.env.OSS_DELETE_KEY_ID || '';
  var secret = process.env.OSS_DELETE_KEY_SECRET || '';
  if (!id || !secret) return json(500, headers, { error: '服务未配置删除钥匙' });

  var date = new Date().toUTCString();
  var resource = '/' + bucket + '/' + key;                 // CanonicalizedResource = raw path
  var stringToSign = 'DELETE\n\n\n' + date + '\n' + resource;
  var signature = crypto.createHmac('sha1', secret).update(stringToSign, 'utf8').digest('base64');
  var auth = 'OSS ' + id + ':' + signature;

  // Request line is percent-encoded per segment; slashes preserved.
  var encodedPath = key.split('/').map(encodeURIComponent).join('/');
  var url = 'https://' + host + '/' + encodedPath;

  try {
    var resp = await fetch(url, { method: 'DELETE', headers: { Date: date, Authorization: auth } });
    if (resp.status !== 204 && resp.status !== 200) {
      var detail = '';
      try { detail = (await resp.text()).slice(0, 400); } catch (e) {}
      return json(502, headers, { error: 'OSS 删除失败 (' + resp.status + ')', detail: detail });
    }
    // Audit trail in the Netlify function log (no secrets).
    console.log('[delete-record] ok user=' + user + ' key=' + key);
    return json(200, headers, { ok: true, key: key });
  } catch (e) {
    return json(502, headers, { error: '删除请求失败：' + (e && e.message ? e.message : String(e)) });
  }
};
