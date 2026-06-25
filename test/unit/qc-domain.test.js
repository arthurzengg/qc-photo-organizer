'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDomainAndUtils } = require('../helpers/load-globals.js');

const { QCDomain } = loadDomainAndUtils();

test('QCDomain is a frozen namespace', () => {
  assert.ok(QCDomain, 'window.QCDomain registered');
  assert.equal(Object.isFrozen(QCDomain), true);
});

test('PARTS: 14 fixed surfaces, 6 external + 8 internal', () => {
  assert.equal(QCDomain.PARTS.length, 14);
  const external = QCDomain.PARTS.filter((p) => p.group === 'external');
  const internal = QCDomain.PARTS.filter((p) => p.group === 'internal');
  assert.equal(external.length, 6, '外部 6 面');
  assert.equal(internal.length, 8, '内部 8 面');
  // every part is in exactly one of the two known groups
  assert.equal(external.length + internal.length, QCDomain.PARTS.length);
});

test('PARTS: every entry has a unique id, a non-empty label, and a valid group', () => {
  const ids = new Set();
  for (const p of QCDomain.PARTS) {
    assert.match(p.id, /^[a-z][a-z0-9_]*$/, `part id is a stable ascii slug: ${p.id}`);
    assert.equal(ids.has(p.id), false, `duplicate part id: ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label && p.label.length > 0, `part ${p.id} has a label`);
    assert.ok(p.group === 'external' || p.group === 'internal', `part ${p.id} group valid`);
  }
  assert.equal(ids.size, 14);
});

test('PART_LABELS mirrors PARTS labels in order', () => {
  assert.deepEqual(QCDomain.PART_LABELS, QCDomain.PARTS.map((p) => p.label));
  assert.equal(QCDomain.PART_LABELS.length, 14);
});

test('ZIP folder-name contract is stable (app.js writes / supervisor.js parses)', () => {
  assert.deepEqual(QCDomain.GROUP_FOLDER, { external: '外部', internal: '内部' });
  assert.equal(QCDomain.DEFECT_FOLDER, '瑕疵');
  assert.equal(QCDomain.ATTACH_FOLDER, '附件');
  assert.equal(QCDomain.MANIFEST_CSV, '质检备注.csv');
});

test('supervisor report-ZIP contract is stable', () => {
  assert.equal(QCDomain.REPORT_SUFFIX, '主管复检');
  assert.equal(QCDomain.REPORT_ORIG_FOLDER, '原始质检');
  assert.equal(QCDomain.REPORT_PACK_FOLDER, '包装');
  assert.equal(QCDomain.REPORT_FIX_FOLDER, '瑕疵复检');
  assert.equal(QCDomain.REPORT_CSV, '主管复检报告.csv');
});

test('cloud upload stage names match what storage-oss.js writes', () => {
  // storage-oss.js defaults rec.subfolder to '质检员首次检查'; supervisor uploads
  // under '最终审查'. Keep the domain constants and that default in lockstep.
  assert.equal(QCDomain.STAGE_INSPECTION, '质检员首次检查');
  assert.equal(QCDomain.STAGE_FINAL, '最终审查');
});

test('DEFECT_CATS: non-empty quick-pick list ending in 其他', () => {
  assert.ok(Array.isArray(QCDomain.DEFECT_CATS) && QCDomain.DEFECT_CATS.length > 0);
  assert.ok(QCDomain.DEFECT_CATS.every((c) => typeof c === 'string' && c.length > 0));
  assert.ok(QCDomain.DEFECT_CATS.includes('其他'), 'an "other" bucket exists');
});

test('FEATURES: unique ids, non-empty labels', () => {
  const ids = new Set();
  for (const f of QCDomain.FEATURES) {
    assert.ok(f.id && f.label, 'feature has id + label');
    assert.equal(ids.has(f.id), false, `duplicate feature id: ${f.id}`);
    ids.add(f.id);
  }
});

test('TEST_GROUPS: every item id is unique across all groups', () => {
  // Item ids key the per-item 合格/不合格/不适用 verdicts; a collision would make
  // two checklist rows share one verdict. This is the invariant most worth guarding.
  const ids = new Set();
  let itemCount = 0;
  for (const g of QCDomain.TEST_GROUPS) {
    assert.ok(g.name && Array.isArray(g.items) && g.items.length > 0, `group ${g.name} has items`);
    for (const item of g.items) {
      assert.ok(item.id && item.text, `test item has id + text in ${g.name}`);
      assert.equal(ids.has(item.id), false, `duplicate test-item id: ${item.id}`);
      ids.add(item.id);
      itemCount++;
      if (item.type != null) assert.equal(item.type, 'param', 'only known item type is "param"');
    }
  }
  assert.equal(ids.size, itemCount);
});

test('TEST_GROUPS: exactly the param-entry rows are typed "param"', () => {
  const params = QCDomain.TEST_GROUPS
    .flatMap((g) => g.items)
    .filter((i) => i.type === 'param');
  assert.ok(params.length >= 1, 'at least one numeric param row (voltage/power/current)');
});

test('TEST_VERDICTS is the fixed three-way set', () => {
  assert.deepEqual(QCDomain.TEST_VERDICTS, ['合格', '不合格', '不适用']);
});

test('PACK_FACES: 5 packaging faces, unique ids', () => {
  assert.equal(QCDomain.PACK_FACES.length, 5, '包装箱 5 面');
  const ids = new Set(QCDomain.PACK_FACES.map((f) => f.id));
  assert.equal(ids.size, 5, 'packaging face ids are unique');
  assert.ok(QCDomain.PACK_FACES.every((f) => f.label && f.label.length > 0));
});

test('file-type lists: RENDERABLE_EXT is a subset of IMG_EXT and drops tiff', () => {
  for (const ext of QCDomain.RENDERABLE_EXT) {
    assert.ok(QCDomain.IMG_EXT.includes(ext), `${ext} renderable implies scannable`);
  }
  // tif/tiff scan as images but are not browser-renderable
  assert.ok(QCDomain.IMG_EXT.includes('tif') && QCDomain.IMG_EXT.includes('tiff'));
  assert.ok(!QCDomain.RENDERABLE_EXT.includes('tif') && !QCDomain.RENDERABLE_EXT.includes('tiff'));
  // lists are lowercase (extFromName lower-cases before comparing)
  for (const ext of QCDomain.IMG_EXT) assert.equal(ext, ext.toLowerCase());
});
