'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDomainAndUtils } = require('../helpers/load-globals.js');

const env = loadDomainAndUtils();
const U = env.QCUtils;

test('QCUtils is a frozen namespace', () => {
  assert.equal(Object.isFrozen(U), true);
});

test('escapeHtml escapes the five HTML-significant chars and coerces nullish', () => {
  assert.equal(U.escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(U.escapeHtml(null), '');
  assert.equal(U.escapeHtml(undefined), '');
  assert.equal(U.escapeHtml(0), '0');
  assert.equal(U.escapeHtml('安全'), '安全', 'non-ascii passes through');
});

test('csvEscape quotes only when needed and doubles inner quotes', () => {
  assert.equal(U.csvEscape('plain'), 'plain');
  assert.equal(U.csvEscape('a,b'), '"a,b"');
  assert.equal(U.csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(U.csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(U.csvEscape(null), '');
});

test('formatSize: bytes / KB / MB thresholds, blank on bad input', () => {
  assert.equal(U.formatSize(0), '0 B');
  assert.equal(U.formatSize(1023), '1023 B');
  assert.equal(U.formatSize(1024), '1 KB');
  assert.equal(U.formatSize(1536), '2 KB'); // rounded
  assert.equal(U.formatSize(1024 * 1024), '1.0 MB');
  assert.equal(U.formatSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(U.formatSize(null), '');
  assert.equal(U.formatSize(NaN), '');
});

test('formatNow returns a zero-padded YYYY-MM-DD HH:MM:SS string', () => {
  assert.match(U.formatNow(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('extFromName: lowercased trailing extension, else empty', () => {
  assert.equal(U.extFromName('photo.JPG'), 'jpg');
  assert.equal(U.extFromName('archive.tar.gz'), 'gz');
  assert.equal(U.extFromName('README'), '');
  assert.equal(U.extFromName(''), '');
  assert.equal(U.extFromName('trailing.'), '', 'a bare dot is not an extension');
  assert.equal(U.extFromName('名字.PnG'), 'png');
});

test('extFromMime maps known image mimes, empty otherwise', () => {
  assert.equal(U.extFromMime('image/jpeg'), 'jpg');
  assert.equal(U.extFromMime('IMAGE/PNG'), 'png');
  assert.equal(U.extFromMime('image/heic'), 'heic');
  assert.equal(U.extFromMime('application/pdf'), '');
  assert.equal(U.extFromMime(''), '');
});

test('fileExt: name wins, then mime, then bin fallback', () => {
  assert.equal(U.fileExt({ name: 'a.png', type: 'image/jpeg' }), 'png');
  assert.equal(U.fileExt({ name: 'noext', type: 'image/jpeg' }), 'jpg');
  assert.equal(U.fileExt({ name: 'noext', type: '' }), 'bin');
});

test('baseName strips any directory prefix', () => {
  assert.equal(U.baseName('外部/正面.jpg'), '正面.jpg');
  assert.equal(U.baseName('a/b/c.png'), 'c.png');
  assert.equal(U.baseName('flat.png'), 'flat.png');
  assert.equal(U.baseName(''), '');
});

test('isImageName uses QCDomain.IMG_EXT (incl. tiff), case-insensitive', () => {
  assert.equal(U.isImageName('x.JPG'), true);
  assert.equal(U.isImageName('x.tiff'), true);
  assert.equal(U.isImageName('x.heic'), true);
  assert.equal(U.isImageName('notes.txt'), false);
  assert.equal(U.isImageName('noext'), false);
});

test('isRenderable: by mime, or by extension when mime is missing', () => {
  assert.equal(U.isRenderable({ type: 'image/png', name: 'a.png' }), true);
  assert.equal(U.isRenderable({ type: '', name: 'a.heic' }), true, 'iOS renders HEIC natively');
  assert.equal(U.isRenderable({ type: '', name: 'a.tif' }), false, 'tiff not browser-renderable');
  assert.equal(U.isRenderable({ type: 'application/pdf', name: 'a.pdf' }), false);
  assert.equal(U.isRenderable({ type: '', name: 'a.txt' }), false);
});

test('sanitizeFilename: strips illegal chars, keeps Chinese, caps length, handles reserved', () => {
  assert.equal(U.sanitizeFilename('a/b:c*?"<>|d'), 'a_b_c______d'); // 6 illegal chars -> 6 underscores
  assert.equal(U.sanitizeFilename('  spaced   out  '), 'spaced out');
  assert.equal(U.sanitizeFilename('...leading'), 'leading');
  assert.equal(U.sanitizeFilename('trailing.  '), 'trailing');
  assert.equal(U.sanitizeFilename('型号-编号'), '型号-编号', 'Chinese preserved');
  assert.equal(U.sanitizeFilename('', '默认'), '默认', 'empty falls back');
  assert.equal(U.sanitizeFilename('   '), '未命名', 'whitespace-only -> default fallback');
  assert.equal(U.sanitizeFilename('CON'), '_CON', 'Windows reserved name guarded');
  assert.equal(U.sanitizeFilename('com1'), '_com1');
  assert.equal(U.sanitizeFilename('x'.repeat(200)).length, 80, 'length capped at 80');
});

test('sanitizeAttachmentName: sanitizes base, lowercases/strips extension', () => {
  assert.equal(U.sanitizeAttachmentName('My Report.PDF'), 'My Report.pdf');
  assert.equal(U.sanitizeAttachmentName('a/b.DocX'), 'a_b.docx');
  assert.equal(U.sanitizeAttachmentName('noext'), 'noext', 'no extension -> sanitized base, no dot appended');
  assert.equal(U.sanitizeAttachmentName(''), '附件', 'empty name falls back to 附件');
  assert.equal(U.sanitizeAttachmentName('weird.tar.gz'), 'weird.tar.gz', 'only the last dot splits the extension');
  assert.ok(!U.sanitizeAttachmentName('x.j!p@g').includes('!'), 'extension stripped to alnum');
});

test('dedupe: appends " (n)" before the extension and mutates the used Set', () => {
  const used = new Set();
  assert.equal(U.dedupe('正面.jpg', used), '正面.jpg');
  assert.equal(U.dedupe('正面.jpg', used), '正面 (2).jpg');
  assert.equal(U.dedupe('正面.jpg', used), '正面 (3).jpg');
  assert.equal(U.dedupe('noext', used), 'noext');
  assert.equal(U.dedupe('noext', used), 'noext (2)');
  assert.equal(used.has('正面 (2).jpg'), true, 'Set was mutated');
});

test('incrementUnit: preserves zero-pad width and non-digit affixes', () => {
  assert.equal(U.incrementUnit('01'), '02');
  assert.equal(U.incrementUnit('09'), '10');
  assert.equal(U.incrementUnit('99'), '100', 'width grows when needed');
  assert.equal(U.incrementUnit('A-01'), 'A-02');
  assert.equal(U.incrementUnit('01-B'), '02-B');
  assert.equal(U.incrementUnit(''), '01', 'empty seeds at 01');
  assert.equal(U.incrementUnit('abc'), 'abc', 'no digits -> unchanged');
});

test('isIOS: UA sniff plus the iPad-desktop touch fallback', () => {
  env.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  env.navigator.platform = 'iPhone';
  env.navigator.maxTouchPoints = 5;
  assert.equal(U.isIOS(), true, 'iPhone UA');

  env.navigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  env.navigator.platform = 'MacIntel';
  env.navigator.maxTouchPoints = 5;
  assert.equal(U.isIOS(), true, 'iPadOS reports MacIntel + touch');

  env.navigator.platform = 'MacIntel';
  env.navigator.maxTouchPoints = 0;
  assert.equal(U.isIOS(), false, 'real desktop Mac (no touch)');

  env.navigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  env.navigator.platform = 'Win32';
  env.navigator.maxTouchPoints = 0;
  assert.equal(U.isIOS(), false, 'Windows');
});

test('triggerDownload: builds <a download>, clicks it, and defers revoke (iOS contract)', () => {
  const before = env.created.length;
  U.triggerDownload({ size: 10 }, '型号-01.zip');

  const a = env.created[env.created.length - 1];
  assert.equal(env.created.length, before + 1, 'one anchor created');
  assert.equal(a.tag, 'a');
  assert.match(a.href, /^blob:mock\//, 'href set to an object URL');
  assert.equal(a.download, '型号-01.zip', 'download filename preserved');
  assert.equal(a.rel, 'noopener');
  assert.equal(a.clicks, 1, 'clicked once');
  assert.equal(a.removed, true, 'anchor removed after click');
  assert.equal(env.appended.includes(a), true, 'anchor appended to body');
  // revoke must be deferred (not synchronous) so the download can start first
  assert.equal(env.revoked.length, 0, 'not revoked synchronously');
  assert.ok(env.timeouts.some((t) => t.ms >= 1000), 'revoke scheduled on a timer');
});
