/*
 * 共享登录模块(质检员页 + 主管页通用)。
 *
 * 账号数据放在 GitHub 仓库的 users.json,运行时从 raw.githubusercontent.com 直读;
 * 密码不存明文,只存 SHA-256(salt + ':' + 密码) 的哈希,用 Web Crypto 在本机校验。
 * 登录态存在 localStorage,带角色(inspector/supervisor),按页面要求的角色放行。
 *
 * 用法:页面在 <head> 里设置
 *     <script>window.QC_AUTH={roles:['inspector','supervisor'],title:'质检拍照'}</script>
 *   再用 <script defer src="auth.js"></script> 加载本文件即可。
 *
 * 安全说明:这是纯前端校验,主要用于「区分是谁、按角色放行」,不是强安全边界
 *   (懂技术的人能在浏览器里绕过)。真正的云端数据由 OSS 钥匙单独保护。
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var CFG = window.QC_AUTH || {};
  var ROLES = CFG.roles || (SCRIPT && SCRIPT.dataset.roles ? SCRIPT.dataset.roles.split(',') : ['inspector', 'supervisor']);
  ROLES = ROLES.map(function (r) { return String(r).trim(); }).filter(Boolean);
  var PAGE_TITLE = CFG.title || document.title || '质检系统';

  // users.json 的来源:GitHub raw 优先(改完几分钟生效),失败再退回同源文件。
  var USERS_RAW = CFG.usersUrl || (SCRIPT && SCRIPT.dataset.usersUrl) ||
    'https://raw.githubusercontent.com/arthurzengg/qc-photo-organizer/main/users.json';
  var USERS_FALLBACK = 'users.json';

  var LS_KEY = 'qc_session';
  var ROLE_CN = { inspector: '质检员', supervisor: '主管' };

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var arr = Array.prototype.slice.call(new Uint8Array(buf));
      return arr.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function fetchUsers() {
    function tryUrl(url, noStore) {
      return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), noStore ? { cache: 'no-store' } : {})
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    return tryUrl(USERS_RAW, true).catch(function () { return tryUrl(USERS_FALLBACK, true); })
      .then(function (data) {
        var list = (data && data.users) || [];
        if (!Array.isArray(list)) throw new Error('users.json 格式不对');
        return list;
      });
  }

  // ---------- 登录态 ----------
  function getSession() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (s && s.username && s.role) return s;
    } catch (e) {}
    return null;
  }
  function setSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(LS_KEY); }

  function roleAllowed(role) { return ROLES.indexOf(role) >= 0; }

  // ---------- 校验 ----------
  function verify(username, password) {
    username = (username || '').trim();
    return fetchUsers().then(function (users) {
      var u = users.filter(function (x) {
        return String(x.username || '').toLowerCase() === username.toLowerCase();
      })[0];
      if (!u) throw new Error('用户名或密码不正确');
      return sha256Hex((u.salt || '') + ':' + password).then(function (h) {
        if (h !== String(u.hash || '').toLowerCase()) throw new Error('用户名或密码不正确');
        if (!roleAllowed(u.role)) {
          var need = ROLES.map(function (r) { return ROLE_CN[r] || r; }).join(' / ');
          throw new Error('此账号是「' + (ROLE_CN[u.role] || u.role) + '」，本页面仅限「' + need + '」登录');
        }
        return { username: u.username, name: u.name || u.username, role: u.role, ts: Date.now() };
      });
    });
  }

  // ---------- 样式 ----------
  function injectStyles() {
    if (document.getElementById('qc-auth-style')) return;
    var css =
      '#qc-auth-gate{position:fixed;inset:0;z-index:99999;visibility:visible;display:flex;align-items:center;justify-content:center;' +
        'padding:20px;background:linear-gradient(160deg,#2563eb 0%,#1e3a8a 100%);font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}' +
      '#qc-auth-gate *{box-sizing:border-box;visibility:visible;}' +
      '.qc-auth-card{width:100%;max-width:360px;background:#fff;border-radius:18px;padding:30px 26px 26px;box-shadow:0 24px 60px rgba(15,23,42,.32);}' +
      // brand badge: gradient tile + camera glyph, matching the inspector accent
      '.qc-auth-brand{width:60px;height:60px;margin:0 auto 16px;border-radius:18px;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);box-shadow:0 8px 20px rgba(37,99,235,.35);}' +
      '.qc-auth-brand svg{width:32px;height:32px;fill:#fff;}' +
      '.qc-auth-card h2{margin:0 0 4px;font-size:21px;font-weight:700;color:#0f172a;text-align:center;}' +
      '.qc-auth-card .sub{margin:0 0 20px;font-size:13px;color:#64748b;text-align:center;}' +
      '.qc-auth-card label{display:block;font-size:13px;color:#475569;margin:14px 0 6px;}' +
      '.qc-auth-card input{width:100%;padding:11px 13px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:16px;color:#0f172a;background:#fff;transition:border-color .16s,box-shadow .16s;}' +
      '.qc-auth-card input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px #eef4ff;}' +
      '.qc-auth-card .err{min-height:18px;margin:12px 0 0;font-size:13px;color:#dc2626;}' +
      '.qc-auth-card .go{width:100%;margin-top:16px;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:background .16s,transform .12s;}' +
      '.qc-auth-card .go:hover{background:#1d4ed8;}' +
      '.qc-auth-card .go:active{transform:scale(.98);}' +
      '.qc-auth-card .go:disabled{background:#94a3b8;cursor:not-allowed;transform:none;}' +
      '.qc-auth-chip{display:flex;align-items:center;gap:8px;border-radius:999px;padding:5px 6px 5px 12px;' +
        'font:13px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}' +
      '.qc-auth-chip b{font-weight:600;}' +
      '.qc-auth-chip button{border:0;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;}' +
      // docked inside the page header (default now): translucent, matches the blue bar
      '.qc-auth-chip--dock{background:rgba(255,255,255,.18);color:#fff;flex-shrink:0;}' +
      '.qc-auth-chip--dock .role{display:none;}' +  // 顶栏已写「主管」，这里不再重复
      '.qc-auth-chip--dock b{display:inline-block;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;}' +
      '.qc-auth-chip--dock button{background:rgba(255,255,255,.92);color:#2563eb;}' +
      '.qc-auth-chip--dock button:hover{background:#fff;}' +
      // floating fallback when the page has no <header>
      '.qc-auth-chip--float{position:fixed;top:8px;right:10px;z-index:50;background:rgba(255,255,255,.92);' +
        'border:1px solid rgba(15,23,42,.08);box-shadow:0 2px 8px rgba(0,0,0,.12);color:#0f172a;}' +
      '.qc-auth-chip--float .role{color:#64748b;}' +
      '.qc-auth-chip--float button{background:#eef4ff;color:#2563eb;}' +
      '.qc-auth-chip--float button:hover{background:#dbeafe;}';
    var st = document.createElement('style');
    st.id = 'qc-auth-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------- 登录界面 ----------
  function showGate() {
    injectStyles();
    document.documentElement.classList.add('qc-gate');
    var gate = document.getElementById('qc-auth-gate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'qc-auth-gate';
      document.body.appendChild(gate);
    }
    var roleCn = ROLES.map(function (r) { return ROLE_CN[r] || r; }).join(' / ');
    gate.innerHTML =
      '<form class="qc-auth-card" id="qc-auth-form" autocomplete="on">' +
        '<div class="qc-auth-brand" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24"><path d="M9 3 7.5 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>' +
        '</div>' +
        '<h2>' + esc(PAGE_TITLE) + '</h2>' +
        '<p class="sub">请登录（' + esc(roleCn) + '）</p>' +
        '<label for="qc-auth-user">用户名</label>' +
        '<input id="qc-auth-user" name="username" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" enterkeyhint="next" />' +
        '<label for="qc-auth-pass">密码</label>' +
        '<input id="qc-auth-pass" name="password" type="password" autocomplete="current-password" enterkeyhint="go" />' +
        '<p class="err" id="qc-auth-err"></p>' +
        '<button class="go" id="qc-auth-go" type="submit">登录</button>' +
      '</form>';

    var form = document.getElementById('qc-auth-form');
    var userEl = document.getElementById('qc-auth-user');
    var passEl = document.getElementById('qc-auth-pass');
    var errEl = document.getElementById('qc-auth-err');
    var goEl = document.getElementById('qc-auth-go');
    setTimeout(function () { userEl.focus(); }, 60);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var u = userEl.value, p = passEl.value;
      if (!u.trim() || !p) { errEl.textContent = '请输入用户名和密码'; return; }
      errEl.textContent = '';
      goEl.disabled = true; goEl.textContent = '登录中…';
      verify(u, p).then(function (sess) {
        setSession(sess);
        unlock(sess);
      }).catch(function (err) {
        errEl.textContent = (err && err.message) || '登录失败，请重试';
        goEl.disabled = false; goEl.textContent = '登录';
        passEl.value = ''; passEl.focus();
      });
    });
  }

  // ---------- 解锁 / 用户标识 ----------
  function unlock(sess) {
    var gate = document.getElementById('qc-auth-gate');
    if (gate) gate.remove();
    document.documentElement.classList.remove('qc-gate');
    renderChip(sess);
    fillUserFields(sess);
    QCAuth.user = sess;
    READY_RESOLVE(sess);
    document.dispatchEvent(new CustomEvent('qc-auth-ready', { detail: sess }));
  }

  function renderChip(sess) {
    injectStyles();
    var old = document.getElementById('qc-auth-chip');
    if (old) old.remove();
    var chip = document.createElement('div');
    chip.id = 'qc-auth-chip';
    chip.innerHTML = '<span>👤 <b>' + esc(sess.name) + '</b> <span class="role">' +
      esc(ROLE_CN[sess.role] || sess.role) + '</span></span><button type="button" id="qc-auth-out">退出</button>';
    // 优先放进页面顶栏(避免悬浮框压住标题/返回链接);没有 header 才悬浮在右上角。
    var header = document.querySelector('header');
    if (header) {
      chip.className = 'qc-auth-chip qc-auth-chip--dock';
      header.style.flexWrap = 'wrap';
      // 让标题用内容宽度参与换行计算并可收缩，这样窄屏时整块会自然换行而不是被裁切
      var title = header.querySelector('h1');
      if (title) { title.style.flexBasis = 'auto'; title.style.minWidth = '0'; }
      header.appendChild(chip);
    } else {
      chip.className = 'qc-auth-chip qc-auth-chip--float';
      document.body.appendChild(chip);
    }
    document.getElementById('qc-auth-out').addEventListener('click', function () {
      if (!confirm('确定退出登录？')) return;
      clearSession();
      location.reload();
    });
  }

  // 把登录用户的姓名填进带 data-qc-fill="name" 的输入框,并锁定(保证记录可溯源)。
  function fillUserFields(sess) {
    var nodes = document.querySelectorAll('[data-qc-fill="name"]');
    Array.prototype.forEach.call(nodes, function (el) {
      el.value = sess.name;
      el.readOnly = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // ---------- 对外接口 ----------
  var READY_RESOLVE;
  var QCAuth = {
    user: null,
    ready: new Promise(function (res) { READY_RESOLVE = res; }),
    logout: function () { clearSession(); location.reload(); },
    roles: ROLES,
  };
  window.QCAuth = QCAuth;

  // ---------- 启动 ----------
  function boot() {
    var sess = getSession();
    if (sess && roleAllowed(sess.role)) {
      unlock(sess);
    } else {
      if (sess) clearSession(); // 角色不匹配的旧登录态清掉
      showGate();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
