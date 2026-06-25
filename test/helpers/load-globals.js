'use strict';

// Test harness for the vanilla, no-build browser modules in lib/.
//
// Each lib/*.js is an IIFE that reads/writes browser globals (window, navigator,
// fetch, crypto, ...) and registers a namespace on `window` (QCDomain, QCUtils,
// QCStorage). There is no module system to import from. Instead of pulling in
// jsdom, we run each file's source through `new Function(...injected, src)`:
// identifiers we list as parameters bind to the stubs/values we pass; every
// other free identifier (Math, Date, Promise, encodeURIComponent, ...) resolves
// to the Node global of the same name. The IIFE then assigns its namespace onto
// the `window` object we handed in, which we read back out.
//
// This keeps the test suite dependency-free, matching the repo's design.

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

// Run a lib file with the given globals injected. `injected` maps identifier
// name -> value; the file's matching free variables bind to those values.
function runModule(relPath, injected) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const names = Object.keys(injected);
  const values = names.map((n) => injected[n]);
  // eslint-disable-next-line no-new-func -- deliberate: load a browser IIFE in Node.
  const factory = new Function(...names, src);
  factory(...values);
}

// ---- DOM-ish env for qc-domain.js + qc-utils.js ----
//
// qc-utils' isImageName/isRenderable read window.QCDomain, so domain loads first
// into the SAME window. navigator/document/URL/setTimeout are stubbed so isIOS
// and triggerDownload are testable without a real DOM.
function loadDomainAndUtils() {
  const window = {};
  runModule('lib/qc-domain.js', { window });

  const navigator = { userAgent: '', platform: '', maxTouchPoints: 0 };

  const created = [];
  const appended = [];
  const document = {
    body: {
      appendChild(el) { appended.push(el); },
    },
    createElement(tag) {
      const el = {
        tag,
        clicks: 0,
        removed: false,
        click() { this.clicks++; },
        remove() { this.removed = true; },
      };
      created.push(el);
      return el;
    },
  };

  const revoked = [];
  let urlSeq = 0;
  const URL = {
    createObjectURL() { return 'blob:mock/' + (++urlSeq); },
    revokeObjectURL(u) { revoked.push(u); },
  };

  // Capture deferred work instead of arming a real timer (triggerDownload defers
  // revokeObjectURL); tests assert it was scheduled rather than run.
  const timeouts = [];
  const setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };

  runModule('lib/qc-utils.js', { window, navigator, document, URL, setTimeout });

  return {
    QCDomain: window.QCDomain,
    QCUtils: window.QCUtils,
    navigator,
    document,
    created,
    appended,
    revoked,
    timeouts,
  };
}

// ---- Storage env (storage-oss.js / storage.js) ----
//
// Both register window.QCStorage *conditionally* on window.QC_CONFIG.provider, so
// the config must be present before the IIFE runs. `fetch` is injected (a mock)
// so upload() never touches the network. WebCrypto is injected explicitly so the
// presign HMAC works regardless of whether the Node version exposes a global.
const webcrypto = nodeCrypto.webcrypto;

function loadStorageOss(config, fetchMock) {
  const window = { QC_CONFIG: config, crypto: webcrypto };
  runModule('lib/storage-oss.js', { window, fetch: fetchMock, crypto: webcrypto });
  return window;
}

function loadStorageDispatch(config, fetchMock) {
  const window = { QC_CONFIG: config, crypto: webcrypto };
  runModule('lib/storage.js', { window, fetch: fetchMock, crypto: webcrypto });
  return window;
}

// ---- fetch mock ----
//
// makeFetch(handler) records every call and returns whatever the handler maps a
// call to. `resp()` builds a minimal Response-like object (ok/status/headers.get/
// text/json) — the only surface the storage modules read.
function resp(opts) {
  opts = opts || {};
  const status = opts.status == null ? 200 : opts.status;
  const body = opts.body == null ? '' : opts.body;
  const headerMap = new Map(
    Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headerMap.has(String(k).toLowerCase()) ? headerMap.get(String(k).toLowerCase()) : null) },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body || '{}') : body),
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = (url, opts) => {
    const call = {
      url: String(url),
      opts: opts || {},
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {},
      body: opts && opts.body,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  fn.calls = calls;
  return fn;
}

// Independent recomputation of the OSS V1 query signature, using Node's classic
// crypto (a different implementation than the module's WebCrypto path) — so a
// matching signature cross-checks the presign algorithm, not just itself.
function expectedOssSignature(secret, method, bucket, rawKey, contentType, expires) {
  const stringToSign = method + '\n\n' + (contentType || '') + '\n' + expires + '\n/' + bucket + '/' + rawKey;
  return nodeCrypto.createHmac('sha1', secret).update(stringToSign, 'utf8').digest('base64');
}

// Pull the parts a test asserts on out of a presigned URL.
function parseSignedUrl(urlStr) {
  const u = new URL(urlStr);
  return {
    host: u.host,
    rawKey: decodeURIComponent(u.pathname).replace(/^\//, ''),
    accessKeyId: u.searchParams.get('OSSAccessKeyId'),
    expires: u.searchParams.get('Expires'),
    signature: u.searchParams.get('Signature'),
    params: u.searchParams,
  };
}

module.exports = {
  loadDomainAndUtils,
  loadStorageOss,
  loadStorageDispatch,
  makeFetch,
  resp,
  expectedOssSignature,
  parseSignedUrl,
};
