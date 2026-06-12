/*
 * QC domain data — the single source of truth shared by the inspector page
 * (app.js), the supervisor page (supervisor.js) and any future consumer.
 *
 * Everything here is a CONTRACT between the two ends: app.js WRITES ZIPs/
 * uploads using these names, supervisor.js PARSES them back by the same
 * names. Change them here and both sides stay in sync; never re-declare
 * these literals inside a page script.
 *
 * 扩展指南（常见改动只需改这个文件）:
 *   - 新增拍照部位     → PARTS 加一行(id 唯一, group: external|internal)
 *   - 新增功能检查项   → FEATURES 加一行
 *   - 新增测试项/分组  → TEST_GROUPS(type:'param' 为数值录入行)
 *   - 新增瑕疵快选类别 → DEFECT_CATS
 *   - 新增包装拍摄面   → PACK_FACES
 */
(function () {
  'use strict';

  // ---- 14 fixed photo surfaces, in display order (拍照部位,顺序即展示顺序) ----
  var PARTS = [
    { id: 'back',          label: '背面',        group: 'external' },
    { id: 'left_side',     label: '左侧板',      group: 'external' },
    { id: 'front',         label: '正面',        group: 'external' },
    { id: 'right_side',    label: '右侧板',      group: 'external' },
    { id: 'top',           label: '顶板',        group: 'external' },
    { id: 'glass',         label: '玻璃',        group: 'external' },
    { id: 'inner_left',    label: '内侧板（左）', group: 'internal' },
    { id: 'inner_right',   label: '内侧板（右）', group: 'internal' },
    { id: 'inner_back',    label: '内背板',      group: 'internal' },
    { id: 'inner_top',     label: '内顶板',      group: 'internal' },
    { id: 'seat',          label: '坐板',        group: 'internal' },
    { id: 'seat_front',    label: '坐前板',      group: 'internal' },
    { id: 'foot',          label: '脚板',        group: 'internal' },
    { id: 'control_panel', label: '温度控制面板', group: 'internal' },
  ];

  // ---- Inspection ZIP layout (质检 ZIP 目录契约: app.js 写,supervisor.js 解析) ----
  var GROUP_FOLDER = { external: '外部', internal: '内部' };
  var DEFECT_FOLDER = '瑕疵';   // defect photos live in 瑕疵/外部|内部
  var ATTACH_FOLDER = '附件';
  var MANIFEST_CSV = '质检备注.csv';

  // ---- Supervisor report ZIP layout (复检 ZIP 目录契约) ----
  var REPORT_SUFFIX = '主管复检';        // report folder/zip: {model}-{unit}-主管复检
  var REPORT_ORIG_FOLDER = '原始质检';
  var REPORT_PACK_FOLDER = '包装';
  var REPORT_FIX_FOLDER = '瑕疵复检';
  var REPORT_CSV = '主管复检报告.csv';

  // ---- Cloud upload stages (OSS 子目录: records/qc-photo-organizer/{stage}/...) ----
  var STAGE_INSPECTION = '质检员首次检查';
  var STAGE_FINAL = '最终审查';

  // ---- Quick-pick defect categories (瑕疵快选类别) ----
  var DEFECT_CATS = ['毛刺', '裂痕', '钉子', '灰尘', '其他'];

  // ---- Function-check items (功能配置检查,勾选=已配且正常) ----
  var FEATURES = [
    { id: 'bluetooth', label: '蓝牙音响' },
    { id: 'led_ring', label: 'LED环形灯' },
    { id: 'reading_light', label: '阅读灯' },
  ];

  // ---- Smart test report (智能化测试报告;type:'param' 为电压/功率/电流录入行) ----
  var TEST_GROUPS = [
    { name: '外观', items: [
      { id: 'ap1', text: '电器部件安装、布局合理，布线/走线整洁美观' },
      { id: 'ap2', text: '显示屏显示符合说明书及文字要求，无破损/光斑/闪烁等不良' },
      { id: 'ap3', text: '客户安装的控制线有清晰、牢固的标识线指导安装' },
    ] },
    { name: '功能', items: [
      { id: 'fn1', text: '控制器功能按键及工作逻辑与说明书相对应' },
      { id: 'fn2', text: 'RGB彩灯：正常开/关，颜色与说明书相对应' },
      { id: 'fn3', text: '照明功能：正常开/关，灯光均匀、无色斑及闪烁' },
      { id: 'fn12', text: '蓝牙功能：按说明书可正常配对并播放音乐' },
    ] },
    { name: '参数', items: [
      { id: 'pm_power', text: '工作电压 / 功率 / 电流（实测）', type: 'param' },
      { id: 'pm1', text: '测试总功率与产品设计功率相符' },
      { id: 'pm2', text: '负载总功率与控制器最大载荷在合理范围内（<3.5KW）' },
      { id: 'pm3', text: '输入电源线与负载功率符合配套规则要求' },
    ] },
    { name: '安全性能', items: [
      { id: 'sf1', text: '1类电器，电气安全性能符合 GB 4706.31' },
      { id: 'sf2', text: '加热元件人体易接触处装非金属护栏，栅栏间距≤50mm' },
    ] },
    { name: '发热温升', items: [
      { id: 'ht1', text: '手摸或红外测温仪测试每块发热板正常发热' },
      { id: 'ht2', text: '最大功率工作20min，控制器温度达到45℃' },
      { id: 'ht3', text: '最大功率工作30min，控制器温度达到60℃' },
    ] },
    { name: '异味', items: [
      { id: 'od1', text: '测试后无烧焦、刺鼻等异常气味' },
    ] },
  ];
  var TEST_VERDICTS = ['合格', '不合格', '不适用'];

  // ---- Packaging photo faces, supervisor page (包装箱 5 面,顺序即展示顺序) ----
  var PACK_FACES = [
    { id: 'front', label: '前' },
    { id: 'back',  label: '后' },
    { id: 'left',  label: '左' },
    { id: 'right', label: '右' },
    { id: 'top',   label: '上' },
  ];

  // ---- File-type lists ----
  // IMG_EXT: what counts as an image when scanning an imported ZIP.
  // RENDERABLE_EXT: what a browser <img> can likely display (no tif — HEIC is
  // included because iOS Safari decodes it natively; desktop falls back on error).
  var IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff'];
  var RENDERABLE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'];

  window.QCDomain = Object.freeze({
    PARTS: PARTS,
    PART_LABELS: PARTS.map(function (p) { return p.label; }),
    GROUP_FOLDER: GROUP_FOLDER,
    DEFECT_FOLDER: DEFECT_FOLDER,
    ATTACH_FOLDER: ATTACH_FOLDER,
    MANIFEST_CSV: MANIFEST_CSV,
    REPORT_SUFFIX: REPORT_SUFFIX,
    REPORT_ORIG_FOLDER: REPORT_ORIG_FOLDER,
    REPORT_PACK_FOLDER: REPORT_PACK_FOLDER,
    REPORT_FIX_FOLDER: REPORT_FIX_FOLDER,
    REPORT_CSV: REPORT_CSV,
    STAGE_INSPECTION: STAGE_INSPECTION,
    STAGE_FINAL: STAGE_FINAL,
    DEFECT_CATS: DEFECT_CATS,
    FEATURES: FEATURES,
    TEST_GROUPS: TEST_GROUPS,
    TEST_VERDICTS: TEST_VERDICTS,
    PACK_FACES: PACK_FACES,
    IMG_EXT: IMG_EXT,
    RENDERABLE_EXT: RENDERABLE_EXT,
  });
})();
