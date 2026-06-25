# QC Photo Organizer

A zero-build, client-only web app for factory quality-inspection photo archiving, covering the full two-role workflow:

1. **Inspector** (`index.html`) — enters a product model and unit number (typed or scanned from a QR label), photographs 14 fixed surfaces, marks defects with categorized close-up photos, runs a function/smart-test checklist, and attaches supporting files. Export is a ZIP with a standardized folder layout, downloaded locally and uploaded to cloud storage.
2. **Supervisor** (`supervisor.html`, login required) — imports one or more inspector ZIPs, reviews photos per unit, requires a repair photo for every defect before a unit can pass, records a verdict, photographs the packaging box (5 faces), and exports a review-report ZIP that is also synced to the cloud. Units can be drafted locally (IndexedDB) and handed to a final reviewer.

Everything runs in the browser: no backend, no build step, no framework. The UI is Simplified Chinese (the target users are QC and factory staff); code and documentation are English.

## Inspector features

- 14 fixed surface slots, grouped into external (6) and internal (8); the overview photo is optional per slot.
- Per-surface defect galleries: multiple close-up photos per surface, each with a quick-pick category (毛刺/裂痕/钉子/灰尘/其他) and a free-text note.
- Function-check list (Bluetooth speaker, LED ring light, reading light) recorded in the manifest.
- Smart test report: 16 checklist items in 6 collapsible groups, each judged 合格/不合格/不适用, plus measured voltage/power/current and an abnormal-findings note.
- Extra-files section for PDF / Word / image attachments.
- QR scanning (vendored jsQR) to fill the unit number from a label.
- One-click export: ZIP download plus best-effort cloud upload, with an in-session history panel for re-downloading any unit, and a "next unit" action that auto-increments the unit number.
- Mobile-first: direct camera capture, large touch targets, visual-viewport-aware bottom action bar (slides away while the iOS keyboard is open), HEIC previews on iOS, reduced-motion support.

## The 14 surfaces

| External (6) | Internal (8) |
| --- | --- |
| 背面 / 左侧板 / 正面 / 右侧板 / 顶板 / 玻璃 | 内侧板（左）/ 内侧板（右）/ 内背板 / 内顶板 / 坐板 / 坐前板 / 脚板 / 温度控制面板 |

Surfaces, checklists, and folder names are defined once in `lib/qc-domain.js` and consumed by both pages — see `CLAUDE.md` for extension recipes.

## Naming contract

For model `ABC` and unit `01`, the inspector export is `ABC-01.zip`:

```
ABC-01/                          unit folder = {model}-{unit}
├── 外部/                         external overview photos: {model}-{unit}-{surface}.{ext}
├── 内部/                         internal overview photos
├── 瑕疵/                         defect close-ups, by group
│   ├── 外部/  ABC-01-正面-瑕疵1-毛刺.jpg
│   └── 内部/
├── 附件/                         extra files, original (sanitized) names
└── 质检备注.csv                  manifest (always included)
```

`质检备注.csv` (UTF-8 with BOM; opens cleanly in Excel/WPS/Numbers) carries a header block (model, unit, inspector, timestamp, counts, function-check results), one row per photo/attachment (`类别, 部位, 类型, 文件名, 瑕疵备注`), and the full smart-test report. Only sub-folders that contain files are created. Model/unit text is sanitized for filesystem safety; Chinese is preserved as UTF-8 entry names.

The supervisor export for the same unit is `ABC-01-主管复检.zip`:

```
ABC-01-主管复检/
├── 原始质检/                     the imported inspection ZIP, verbatim
├── 包装/                         packaging photos: ABC-01-包装箱-{前|后|左|右|上}.jpg
├── 瑕疵复检/                     repair photos: ABC-01-{surface}-复检后.jpg
└── 主管复检报告.csv              verdict, notes, original manifest
```

## Cloud storage

Both pages boot by fetching `public/qc-config.json` from Aliyun OSS (the config holds an intentionally public, upload-only RAM key; it is not in this repository). Uploads land under `records/qc-photo-organizer/{质检员首次检查|最终审查}/YYYY-MM-DD/` as a ZIP plus a JSON metadata record. ZIPs over 8 MB upload via presigned multipart with per-part timeout and retry. If the config cannot be fetched, the app degrades gracefully to local-only ZIP download.

`admin.html` is a read-only browser for the uploaded records; `nettest.html` is a standalone on-device diagnostic that reproduces the full upload path in six steps.

## Authentication

The supervisor page is gated by `auth.js` against `users.json` (salted SHA-256 hashes, no plaintext). Use `account-tool.html` to generate new account entries. The inspector page needs no login.

## File structure

Entry pages stay at the repo root (they are the public URLs); page scripts live
in `js/`, the inspector stylesheet in `css/`, and shared/vendored modules in `lib/`.

```
index.html / supervisor.html / admin.html / nettest.html / account-tool.html
                                      entry pages (public URLs, root-anchored)
js/app.js / css/styles.css            inspector page logic + styles
js/supervisor.js                      supervisor page (CSS inline in supervisor.html by design)
js/boot.js / js/boot-supervisor.js    config fetch + versioned script loading
js/auth.js / users.json               supervisor login (account-tool.html generates entries)
js/admin.js                           cloud records browser
lib/qc-domain.js                      shared domain data (surfaces, checklists, ZIP contract)
lib/qc-utils.js                       shared pure helpers
lib/storage-oss.js / lib/storage.js   cloud storage backends (window.QCStorage)
lib/jszip.min.js / jsqr.min.js / aliyun-oss-sdk.min.js   vendored deps (offline-capable)
docs/config.example.js                sample of the OSS config shape (not loaded; real config on OSS)
CLAUDE.md                             architecture, extension recipes, release ritual
```

## Run locally

Static site — no install, no build:

```bash
cd qc-photo-organizer
python3 -m http.server 8000
# open http://localhost:8000
```

(Serving over HTTP is recommended; opening `index.html` via `file://` works for the basic flow but camera/QR access requires a secure or localhost origin.)

## Testing

Tests run on Node's built-in runner — no test framework and no `node_modules`, matching the zero-build site:

```bash
npm test        # unit (lib/qc-domain, lib/qc-utils) + integration (storage layer)
npm run check   # node --check syntax gate over all JS
```

The suite loads each `lib/*.js` browser module in Node by injecting a minimal `window`, so the `window.*` namespaces are testable without a DOM. Integration tests drive the storage layer (`storage-oss.js`, `storage.js`) against a mocked `fetch` — covering provider selection, the multipart upload flow, and an independent re-derivation of the OSS presigned-URL signature. `.github/workflows/ci.yml` runs both gates on every push and pull request.

## Deployment and releases

Merging to `main` publishes nothing. Pushing a version tag is the single release switch:

```bash
git tag v3.0.0 && git push origin v3.0.0
```

`.github/workflows/release-deploy.yml` then creates the GitHub Release, deploys the tagged commit to Netlify production, and deploys GitHub Pages (workflow-built; the `github-pages` environment accepts `v*` tags). Every release must bump the `?v=` cache-busting versions — see the release ritual in `CLAUDE.md`. A zero-build `vercel.json` is included for optional static hosting elsewhere.

## Tech and dependencies

Vanilla HTML/CSS/JavaScript. Vendored, offline-capable libraries: JSZip 3.10.1 (ZIP build/parse), jsQR (QR scanning), Aliyun OSS browser SDK (cloud upload). To upgrade one, replace the file under `lib/` and bump the loader version.

## Known limitations

- History is session-only on the inspector page; supervisor drafts persist in the browser's IndexedDB (per device).
- On iOS the local ZIP download intentionally starts only after the cloud upload settles (triggering a download cancels in-flight requests on iOS WebKit).
- Desktop browsers cannot render HEIC previews (iOS renders them natively); the original file is still included in the ZIP.
- Legacy unzip tools (Info-ZIP CLI, Windows 7 Explorer) may garble Chinese entry names; extract with a modern tool.
