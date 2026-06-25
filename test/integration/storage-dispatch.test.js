'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadStorageDispatch, makeFetch, resp } = require('../helpers/load-globals.js');

// storage.js is the Supabase implementation AND the provider gate: it only claims
// window.QCStorage when QC_CONFIG.provider is absent or 'supabase'. In production
// (provider 'oss') it must stand down so storage-oss.js owns QCStorage.

const supaConfig = (overrides) => Object.assign({
  provider: 'supabase',
  supabaseUrl: 'https://proj.supabase.co',
  supabaseKey: 'KEY123',
  bucket: 'qc',
}, overrides);

function baseRec(extra) {
  return Object.assign({
    folder: '型号A-01', model: '型号A', unit: '01', inspector: '张三',
    photoCount: 14, defectCount: 0, attachCount: 0, notes: [],
  }, extra);
}

// ---- provider gate ----

test('claims QCStorage when provider is "supabase"', () => {
  const w = loadStorageDispatch(supaConfig(), makeFetch(() => resp()));
  assert.ok(w.QCStorage);
});

test('claims QCStorage when provider is absent (default/fallback)', () => {
  const cfg = supaConfig();
  delete cfg.provider;
  const w = loadStorageDispatch(cfg, makeFetch(() => resp()));
  assert.ok(w.QCStorage, 'no provider -> Supabase fallback owns QCStorage');
});

test('stands down (no QCStorage) when provider is "oss"', () => {
  const w = loadStorageDispatch(supaConfig({ provider: 'oss' }), makeFetch(() => resp()));
  assert.equal(w.QCStorage, undefined, 'lets storage-oss.js own QCStorage in production');
});

// ---- configured() ----

test('configured() needs url + key + bucket', () => {
  assert.equal(loadStorageDispatch(supaConfig(), makeFetch(() => resp())).QCStorage.configured(), true);
  assert.equal(loadStorageDispatch(supaConfig({ bucket: '' }), makeFetch(() => resp())).QCStorage.configured(), false);
  assert.equal(loadStorageDispatch(supaConfig({ supabaseKey: '' }), makeFetch(() => resp())).QCStorage.configured(), false);
});

// ---- upload() request shaping ----

test('upload() POSTs the zip to storage, then inserts the metadata row', async () => {
  const fetchMock = makeFetch(() => resp({ status: 200, body: {} }));
  const w = loadStorageDispatch(supaConfig(), fetchMock);

  const result = await w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1, 2, 3]) }));

  assert.equal(fetchMock.calls.length, 2, 'storage upload then row insert');
  const [zip, row] = fetchMock.calls;

  // --- object upload ---
  assert.equal(zip.method, 'POST');
  assert.ok(zip.url.startsWith('https://proj.supabase.co/storage/v1/object/qc/records/qc-photo-organizer/质检员首次检查/'));
  assert.ok(zip.url.endsWith('/型号A-01.zip'));
  assert.equal(zip.headers.apikey, 'KEY123');
  assert.equal(zip.headers.Authorization, 'Bearer KEY123');
  assert.equal(zip.headers['Content-Type'], 'application/zip');
  assert.equal(zip.headers['x-upsert'], 'true');

  // --- metadata row ---
  assert.equal(row.method, 'POST');
  assert.equal(row.url, 'https://proj.supabase.co/rest/v1/qc_records');
  assert.equal(row.headers['Content-Type'], 'application/json');
  const body = JSON.parse(row.body);
  assert.equal(body.model, '型号A');
  assert.equal(body.unit, '01');
  assert.equal(body.folder, '型号A-01');
  assert.equal(body.photo_count, 14);
  assert.ok(body.zip_path.endsWith('/型号A-01.zip'));
  assert.equal(body.zip_path, result.path, 'inserted zip_path matches the returned path');
});

test('upload() rejects when the storage POST fails', async () => {
  const fetchMock = makeFetch(() => resp({ status: 400, body: 'bad request' }));
  const w = loadStorageDispatch(supaConfig(), fetchMock);
  await assert.rejects(w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1]) })), /上传ZIP失败 400/);
});

test('upload() rejects when not configured', async () => {
  const w = loadStorageDispatch(supaConfig({ supabaseUrl: '' }), makeFetch(() => resp()));
  await assert.rejects(w.QCStorage.upload(baseRec({ bytes: new Uint8Array([1]) })), /未配置云端/);
});
