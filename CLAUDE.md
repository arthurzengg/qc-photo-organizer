# qc-photo-organizer

Factory QC photo tool. Static site, no build step, no backend: inspectors photograph
14 fixed surfaces per unit, run a function/test checklist, and export a ZIP that is
also uploaded to Aliyun OSS; supervisors import those ZIPs, re-inspect defects, add
packaging photos, and export a review report ZIP. All Chinese UI; runs on factory
phones (iOS Safari/Chrome) and desktops.

## Architecture

```
index.html ── boot.js ──────► lib/qc-domain.js   shared domain data (contract)
supervisor.html ─ boot-supervisor.js ─► lib/qc-utils.js    shared pure helpers
                              ├► lib/storage-oss.js  OSS backend (presigned PUT + multipart)
                              ├► lib/storage.js      provider dispatch / Supabase fallback
                              └► app.js | supervisor.js   page logic (IIFE, owns its DOM)
admin.html + admin.js     read-only records browser (lists OSS uploads)
auth.js                   login gate for supervisor page (users.json, roles)
nettest.html              standalone on-device network/upload diagnostics (6 tests)
```

- **`lib/qc-domain.js`** (`window.QCDomain`) is the single source of truth for
  everything both pages must agree on: the 14 PARTS, ZIP folder names
  (外部/内部/瑕疵/附件), manifest/report CSV names, upload stage subfolders,
  checklists (FEATURES, TEST_GROUPS), defect categories, packaging faces.
  app.js *writes* ZIPs/uploads with these names; supervisor.js *parses* them back.
  Never re-declare these literals in a page script.
- **`lib/qc-utils.js`** (`window.QCUtils`) holds page-agnostic helpers (escape,
  sanitize, file-type, `triggerDownload`, `isIOS`...). Page scripts alias them to
  their historical local names at the top of the IIFE.
- Page scripts (`app.js`, `supervisor.js`) keep all DOM/state logic. Supervisor
  CSS is intentionally inline in supervisor.html (one less versioned asset to bump).
- Boot loaders fetch `public/qc-config.json` from OSS (upload-only RAM key — public
  by design), then load scripts sequentially with `?vN` cache busting. No config →
  graceful degrade to local-only ZIP download.

## Extension recipes

- **New photo surface / checklist item / defect category / packaging face** → edit
  the corresponding array in `lib/qc-domain.js`. Both pages, ZIP layout, CSV and
  supervisor sorting follow automatically. (`TOTAL`/group counts derive from PARTS.)
- **New shared helper** → `lib/qc-utils.js` (pure functions only; DOM-touching
  helpers stay in the page script that owns the element).
- **New page** → own `boot-*.js` modeled on boot-supervisor.js, load qc-domain →
  qc-utils → storage libs → page script, each with `?V`.
- **New storage provider** → new `lib/storage-*.js` that claims `window.QCStorage`
  when `QC_CONFIG.provider` matches (see storage-oss.js / storage.js pattern).

## Release ritual (cache bump is NOT optional)

GitHub Pages serves `max-age=600`; phones run stale code without bumps and fixes
"mysteriously fail" (this caused a real misdiagnosis round). When JS/CSS changes:

1. `boot.js`: bump `var V` (versions app.js + lib/*). `index.html`: bump `boot.js?v=`.
   `styles.css?v=` only if styles.css changed.
2. `boot-supervisor.js`: bump `var V` and `supervisor.js?vN` (only if supervisor.js
   changed). `supervisor.html`: bump `boot-supervisor.js?v=`.
3. Merge PRs to `main` — **merging publishes nothing**. Pages is workflow-built and
   the `github-pages` environment only accepts `v*` tag deployments.
4. `git tag vX.Y.Z && git push origin vX.Y.Z` → release-deploy.yml creates the
   GitHub Release, deploys Netlify prod and GitHub Pages together.
5. Verify: workflow green; live `boot.js` shows the new `var V`.

`window.QC_VERSION` (set by both boot loaders) is displayed in the upload-failure
alert so a device screenshot reveals which version it ran.

## iOS landmines (hard-won; do not regress)

- **Clicking an `<a download>` cancels in-flight network requests on iOS WebKit**
  (all browsers). Upload first, trigger the download when the upload settles —
  see `generate()` in app.js. The resulting error text only names whichever layer
  got cancelled ("Load failed" / "The I/O read operation failed"), which misleads.
- **Pass JSZip output as `{type:'uint8array'}` bytes straight to fetch.** Blob
  round-trips (`blob.arrayBuffer()`) can throw NotReadableError under memory
  pressure on iOS. Blob is only for the local download.
- **ZIPs >8MB upload via OSS multipart** (presigned V1 URLs, WebCrypto HMAC-SHA1,
  per-part timeout/retry) in storage-oss.js. Part ETags must stay CORS-exposed on
  the bucket.
- Keep inputs/textareas at `font-size ≥16px` (iOS zoom-on-focus) and respect the
  `--vv-bottom` visual-viewport plumbing for the fixed action bar.
- `nettest.html` reproduces the full upload path on-device when something fails.

## Conventions

- Vanilla ES5-style JS (IIFEs, `var`, no modules/build); match existing style.
- Issues/commits/PRs in English; UI strings and domain constants stay Chinese.
- Test before PR: `node --check` on changed JS; for UI, screenshot at phone width
  via `npx playwright screenshot --browser chromium --channel chrome --device "Pixel 5"`
  against `python3 -m http.server` (plain headless Chrome fakes a 500px-min viewport).
