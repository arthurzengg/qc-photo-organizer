'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadStorageOss,
  makeFetch,
  resp,
  expectedOssSignature,
  parseSignedUrl,
} = require('../helpers/load-globals.js');

const OSS = {
  region: 'oss-cn-hongkong',
  bucket: 'haoyao-qc-hk',
  accessKeyId: 'AKID',
  accessKeySecret: 'SECRET',
};
const ossConfig = (overrides) => ({ provider: 'oss', oss: Object.assign({}, OSS, overrides) });

const PART_SIZE = 8 * 1024 * 1024;

function baseRec(extra) {
  return Object.assign({
    folder: '型号A-01',
    model: '型号A',
    unit: '01',
    inspector: '张三',
    photoCount: 14,
    defectCount: 0,
    attachCount: 0,
    notes: [],
  }, extra);
}

// ---- configured() ----

test('configured() is true with full OSS config + WebCrypto', () => {
  const w = loadStorageOss(ossConfig(), makeFetch(() => resp()));
  assert.ok(w.QCStorage, 'storage-oss claimed window.QCStorage for provider=oss');
  assert.equal(w.QCStorage.configured(), true);
});

test('configured() is false when a credential is missing', () => {
  const w = loadStorageOss(ossConfig({ accessKeySecret: '' }), makeFetch(() => resp()));
  assert.equal(w.QCStorage.configured(), false);
});

test('configured() is false without WebCrypto (e.g. plain-http, non-localhost)', () => {
  const w = loadStorageOss(ossConfig(), makeFetch(() => resp()));
  assert.equal(w.QCStorage.configured(), true);
  w.crypto = undefined; // simulate an insecure context where crypto.subtle is absent
  assert.equal(w.QCStorage.configured(), false);
});

test('storage-oss does NOT claim QCStorage when provider is not "oss"', () => {
  const w = loadStorageOss({ provider: 'supabase', oss: OSS }, makeFetch(() => resp()));
  assert.equal(w.QCStorage, undefined);
});

// ---- small upload: single PUTs for zip + json ----

test('upload() (small) PUTs the zip then the json with valid presigned V1 URLs', async () => {
  const fetchMock = makeFetch(() => resp({ status: 200 }));
  const w = loadStorageOss(ossConfig(), fetchMock);

  const result = await w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1, 2, 3, 4]) }));

  assert.equal(fetchMock.calls.length, 2, 'exactly two requests: zip, then json');
  const [zip, json] = fetchMock.calls;

  // --- the zip PUT ---
  assert.equal(zip.method, 'PUT');
  assert.equal(zip.headers['Content-Type'], 'application/zip');
  const z = parseSignedUrl(zip.url);
  assert.equal(z.host, 'haoyao-qc-hk.oss-cn-hongkong.aliyuncs.com');
  assert.ok(z.rawKey.startsWith('records/qc-photo-organizer/质检员首次检查/'), 'inspection stage prefix');
  assert.ok(z.rawKey.endsWith('/型号A-01.zip'), 'folder + .zip key, Chinese preserved');
  assert.equal(z.accessKeyId, 'AKID');
  assert.ok(/^\d+$/.test(z.expires), 'Expires is a unix timestamp');
  assert.ok(z.signature && z.signature.length > 0, 'Signature present');

  // independently recompute the V1 signature with Node's classic HMAC-SHA1
  const expected = expectedOssSignature('SECRET', 'PUT', 'haoyao-qc-hk', z.rawKey, 'application/zip', z.expires);
  assert.equal(z.signature, expected, 'presign signature matches an independent HMAC-SHA1');

  // --- the json PUT ---
  assert.equal(json.method, 'PUT');
  assert.equal(json.headers['Content-Type'], 'application/json');
  const j = parseSignedUrl(json.url);
  assert.ok(j.rawKey.endsWith('/型号A-01.json'), 'json sidecar key');
  // zip uploads before json — json appearing in the bucket means the record is complete
  assert.ok(result.path.endsWith('/型号A-01.zip'));
});

test('upload() rejects (and wraps the message) when OSS returns non-2xx', async () => {
  const fetchMock = makeFetch(() => resp({ status: 403, body: 'AccessDenied' }));
  const w = loadStorageOss(ossConfig(), fetchMock);
  await assert.rejects(
    w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1, 2, 3]) })),
    /PUT 403/
  );
});

test('upload() rejects when storage is not configured', async () => {
  const w = loadStorageOss(ossConfig({ accessKeyId: '' }), makeFetch(() => resp()));
  await assert.rejects(w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1]) })), /未配置/);
});

// ---- large upload: multipart (initiate -> parts -> complete -> json) ----

test('upload() (>8 MB) runs the multipart flow in order with per-part ETags', async () => {
  const progress = [];
  const fetchMock = makeFetch((call) => {
    const sp = new URL(call.url).searchParams;
    if (call.method === 'POST' && sp.has('uploads')) {
      return resp({ status: 200, body: '<InitiateMultipartUploadResult><UploadId>UPID-XYZ</UploadId></InitiateMultipartUploadResult>' });
    }
    if (call.method === 'PUT' && sp.has('partNumber')) {
      return resp({ status: 200, headers: { ETag: '"etag-' + sp.get('partNumber') + '"' } });
    }
    if (call.method === 'POST' && sp.has('uploadId')) {
      return resp({ status: 200, body: '<CompleteMultipartUploadResult/>' });
    }
    return resp({ status: 200 }); // the final json PUT
  });
  const w = loadStorageOss(ossConfig(), fetchMock);

  // 9 MB -> two parts: one full 8 MB part + a 1 MB remainder
  const bytes = new Uint8Array(9 * 1024 * 1024);
  const result = await w.QCStorage.upload(baseRec({
    bytes,
    onProgress: (done, total) => progress.push([done, total]),
  }));

  const calls = fetchMock.calls;
  assert.equal(calls.length, 5, 'initiate + 2 parts + complete + json');

  const markers = calls.map((c) => {
    const sp = new URL(c.url).searchParams;
    if (c.method === 'POST' && sp.has('uploads')) return 'initiate';
    if (c.method === 'PUT' && sp.has('partNumber')) return 'part' + sp.get('partNumber');
    if (c.method === 'POST' && sp.has('uploadId')) return 'complete';
    return 'json';
  });
  assert.deepEqual(markers, ['initiate', 'part1', 'part2', 'complete', 'json']);

  // part bodies are the right byte slices
  assert.equal(calls[1].body.length, PART_SIZE, 'part 1 is a full 8 MB chunk');
  assert.equal(calls[2].body.length, 9 * 1024 * 1024 - PART_SIZE, 'part 2 is the 1 MB remainder');

  // the complete request lists both parts with the ETags the parts returned
  const completeBody = calls[3].body;
  assert.match(completeBody, /<Part><PartNumber>1<\/PartNumber><ETag>"etag-1"<\/ETag><\/Part>/);
  assert.match(completeBody, /<Part><PartNumber>2<\/PartNumber><ETag>"etag-2"<\/ETag><\/Part>/);

  // progress reported once per finished part
  assert.deepEqual(progress, [[1, 2], [2, 2]]);

  // multipart targets the zip key; the json sidecar follows
  assert.ok(parseSignedUrl(calls[0].url).rawKey.endsWith('/型号A-01.zip'));
  assert.ok(parseSignedUrl(calls[4].url).rawKey.endsWith('/型号A-01.json'));
  assert.ok(result.path.endsWith('/型号A-01.zip'));
});

test('upload() supports the supervisor stage via rec.subfolder', async () => {
  const fetchMock = makeFetch(() => resp({ status: 200 }));
  const w = loadStorageOss(ossConfig(), fetchMock);
  await w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1]), subfolder: '最终审查', folder: '型号A-01-主管复检' }));
  const key = parseSignedUrl(fetchMock.calls[0].url).rawKey;
  assert.ok(key.startsWith('records/qc-photo-organizer/最终审查/'), 'final-review stage prefix');
  assert.ok(key.endsWith('/型号A-01-主管复检.zip'));
});
