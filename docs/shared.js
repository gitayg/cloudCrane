const API = window.location.origin;
let KEY = localStorage.getItem('cc_api_key') || '';

/** HTML-encode a value for safe injection into HTML content or attributes. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Produce a JSON-encoded, HTML-safe string literal for use inside
 * inline event handler attributes: onclick="foo(${jsStr(val)})"
 * JSON.stringify wraps in double quotes and escapes control chars;
 * then we HTML-encode " so it doesn't break the attribute boundary.
 */
function jsStr(s) {
  return JSON.stringify(String(s == null ? '' : s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strip a leading mention of the app name from a description so the UI
 * doesn't show "MyApp — MyApp does X" or repeat the name redundantly.
 * Tolerant to common separators (—, –, -, :, |, ·) and case differences.
 * Returns '' if the description is just the name.
 */
function trimAppNameFromDescription(name, description) {
  if (!description) return '';
  if (!name) return description;
  const desc = String(description).trim();
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match leading name optionally followed by a separator and whitespace
  const re = new RegExp('^' + escaped + '\\s*([\\-—–:|·]+\\s*)?', 'i');
  const stripped = desc.replace(re, '').trim();
  return stripped;
}

function getKey() { return KEY; }
function setKey(k) { KEY = k; localStorage.setItem('cc_api_key', k); }

async function apiFetch(path) {
  if (!KEY) throw new Error('No API key');
  const res = await fetch(API + path, { headers: { 'X-API-Key': KEY } });
  if (res.status === 401) {
    setKey('');
    window.location.href = '/dashboard';
    throw new Error('Unauthorized');
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(API + path, {
    method: 'PUT', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API + path, { method: 'DELETE', headers: { 'X-API-Key': KEY } });
  return res.json();
}

function dot(status) {
  const cls = status === 'healthy' ? 'dot-green' : status === 'down' ? 'dot-red' : 'dot-gray';
  return '<span class="dot ' + cls + '"></span>';
}

function badge(status) {
  const cls = {live:'badge-live',failed:'badge-failed',building:'badge-building',deploying:'badge-building'}[status] || 'badge-pending';
  return '<span class="badge ' + cls + '">' + status + '</span>';
}

function barColor(pct) {
  return pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
}

function statCard(label, value, sub, pct) {
  return '<div class="stat"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div>' +
    (pct > 0 ? '<div class="bar"><div class="bar-fill" style="width:' + pct + '%;background:' + barColor(pct) + '"></div></div>' : '') + '</div>';
}

function topbar(active) {
  const pages = [
    {id:'dashboard',label:'Dashboard',href:'/dashboard'},
    {id:'applications',label:'Applications',href:'/applications'},
    {id:'users',label:'Users',href:'/users-page'},
    {id:'audit',label:'Audit Log',href:'/audit-page'},
    {id:'enhancements',label:'Enhancements',href:'/enhancements-page'},
    {id:'settings',label:'Settings',href:'/settings'},
  ];
  const nav = pages.map(p => '<a href="' + p.href + '" class="' + (active === p.id ? 'active' : '') + '">' + p.label + '</a>').join('');

  return '<div class="topbar">' +
    '<div style="display:flex;align-items:center">' +
      '<span class="logo">App<span>Crane</span></span>' +
      '<div class="nav" id="mainNav">' + nav + '</div>' +
    '</div>' +
    '<div class="right" id="mainRight">' +
      '<span id="craneVersion" style="color:var(--dim);font-size:.8rem;cursor:pointer" onclick="checkForUpdate()" title="Click to check for updates"></span>' +
      '<span id="userInfo" style="color:var(--dim)"></span>' +
      '<a href="/docs" style="color:var(--dim);text-decoration:none;font-size:.85rem">Docs</a>' +
      '<a href="/agent-guide" style="color:var(--dim);text-decoration:none;font-size:.85rem">Agent Guide</a>' +
      '<button class="btn" onclick="setKey(\'\');location.href=\'/dashboard\'" style="font-size:.8rem;padding:3px 10px">Logout</button>' +
    '</div>' +
  '</div>';
}

async function loadVersion() {
  try {
    const info = await apiFetch('/api/info');
    document.getElementById('craneVersion').textContent = 'v' + info.version;
  } catch(e) {}
}

async function checkForUpdate() {
  const el = document.getElementById('craneVersion');
  el.textContent = 'checking...';
  el.style.color = 'var(--dim)';
  try {
    const data = await apiFetch('/api/version-check');
    if (data.update_available) {
      el.textContent = 'v' + data.current + ' → v' + data.latest + ' available!';
      el.style.color = 'var(--yellow)';
      if (confirm('Update available: v' + data.current + ' → v' + data.latest + '\n\nUpdate now?')) {
        el.textContent = 'updating to v' + data.latest + '...';
        el.style.color = 'var(--yellow)';
        const result = await apiPost('/api/self-update');
        const newVer = (result && result.version) ? result.version : data.latest;
        el.textContent = 'restarting (v' + newVer + ')...';
        setTimeout(() => location.reload(), 5000);
      }
    } else {
      el.textContent = 'v' + data.current + ' (latest)';
      el.style.color = 'var(--green)';
      setTimeout(() => { el.style.color = 'var(--dim)'; }, 3000);
    }
  } catch(e) { el.textContent = 'check failed'; el.style.color = 'var(--red)'; }
}

async function loadUserInfo() {
  try {
    const me = await apiFetch('/api/auth/me');
    window.currentUser = me.user;
    document.getElementById('userInfo').textContent = me.user.name + ' (' + me.user.role + ')';
  } catch(e) {}
}

function isAdmin() {
  return window.currentUser && window.currentUser.role === 'admin';
}

function showPromptModal(title, prompt) {
  const keyMatch = prompt.match(/API Key: (dhk_\S+)/);
  const keyOnly = keyMatch ? keyMatch[1] : '';

  function _el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  const overlay = _el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100');
  const box = _el('div', 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;max-width:600px;width:90%');

  box.appendChild(_el('h3', 'margin-bottom:12px;color:var(--green)', title));

  // API key row
  const keyWrap = _el('div', 'margin-bottom:16px');
  const keyRow = _el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px');
  keyRow.appendChild(_el('span', 'color:var(--dim);font-size:.8rem', 'API Key'));
  const copyKeyBtn = _el('button', 'font-size:.75rem;padding:4px 14px', 'Copy Key');
  copyKeyBtn.className = 'btn';
  copyKeyBtn.addEventListener('click', () => { navigator.clipboard.writeText(keyOnly); copyKeyBtn.textContent = 'Copied!'; });
  keyRow.appendChild(copyKeyBtn);
  keyWrap.appendChild(keyRow);
  const keyDisplay = _el('div', 'background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;cursor:pointer;font-family:monospace;font-size:.85rem;font-weight:700;word-break:break-all', keyOnly);
  keyDisplay.addEventListener('click', () => navigator.clipboard.writeText(keyOnly));
  keyWrap.appendChild(keyDisplay);
  box.appendChild(keyWrap);

  // Prompt row
  const promptWrap = _el('div');
  const promptRow = _el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px');
  promptRow.appendChild(_el('span', 'color:var(--dim);font-size:.8rem', 'Full Agent Prompt'));
  const copyPromptBtn = _el('button', 'font-size:.75rem;padding:4px 14px', 'Copy Prompt');
  copyPromptBtn.className = 'btn';
  const promptBox = _el('div', 'background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;cursor:pointer;white-space:pre-wrap;font-family:monospace;font-size:.75rem;line-height:1.5;color:var(--dim);user-select:all;max-height:200px;overflow-y:auto', prompt);
  copyPromptBtn.addEventListener('click', () => { navigator.clipboard.writeText(promptBox.textContent); copyPromptBtn.textContent = 'Copied!'; });
  promptBox.addEventListener('click', () => { navigator.clipboard.writeText(promptBox.textContent); copyPromptBtn.textContent = 'Copied!'; });
  promptRow.appendChild(copyPromptBtn);
  promptWrap.appendChild(promptRow);
  promptWrap.appendChild(promptBox);
  box.appendChild(promptWrap);

  const footer = _el('div', 'display:flex;justify-content:flex-end;margin-top:16px');
  const closeBtn = _el('button', null, 'Close');
  closeBtn.className = 'btn';
  closeBtn.addEventListener('click', () => overlay.remove());
  footer.appendChild(closeBtn);
  box.appendChild(footer);
  box.appendChild(_el('div', 'color:var(--yellow);font-size:.75rem;margin-top:8px', 'The API key will not be shown again after closing.'));

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function checkAuth() {
  if (!KEY) {
    document.body.innerHTML =
      '<div class="topbar"><span class="logo">App<span>Crane</span></span></div>' +
      '<div style="max-width:440px;margin:60px auto;padding:0 20px">' +
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px">' +
          '<h2 style="margin:0 0 4px;font-size:1.3rem">Sign In</h2>' +
          '<p style="color:var(--dim);margin-bottom:20px;font-size:.9rem">Choose your login method</p>' +
          '<div id="loginError" style="display:none;background:#ef444418;border:1px solid #ef444444;color:var(--red);padding:8px;border-radius:6px;margin-bottom:12px;font-size:.85rem"></div>' +

          '<div style="display:flex;margin-bottom:20px;border:1px solid var(--border);border-radius:6px;overflow:hidden">' +
            '<button onclick="showTab(\'user\')" id="tabUser" style="flex:1;padding:10px;border:none;cursor:pointer;font-size:.85rem;font-weight:600;background:var(--accent);color:#fff">User Login</button>' +
            '<button onclick="showTab(\'key\')" id="tabKey" style="flex:1;padding:10px;border:none;cursor:pointer;font-size:.85rem;font-weight:600;background:var(--surface2);color:var(--dim)">Admin Key</button>' +
          '</div>' +

          '<div id="userForm">' +
            '<p style="color:var(--dim);font-size:.8rem;margin-bottom:12px">Sign in to access your assigned apps</p>' +
            '<input type="text" id="loginUser" placeholder="Email or username" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:6px;width:100%;margin-bottom:8px;font-size:14px" autofocus onkeydown="if(event.key===\'Enter\')document.getElementById(\'loginPass\').focus()">' +
            '<input type="password" id="loginPass" placeholder="Password" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:6px;width:100%;margin-bottom:12px;font-size:14px" onkeydown="if(event.key===\'Enter\')doPassLogin()">' +
            '<button onclick="doPassLogin()" class="btn btn-accent" style="width:100%;padding:10px">Sign In</button>' +
          '</div>' +

          '<div id="keyForm" style="display:none">' +
            '<p style="color:var(--dim);font-size:.8rem;margin-bottom:12px">For AppCrane administrators only</p>' +
            '<input type="password" id="keyInput" placeholder="dhk_admin_..." style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:6px;width:100%;margin-bottom:12px;font-size:14px" onkeydown="if(event.key===\'Enter\')doKeyLogin()">' +
            '<button onclick="doKeyLogin()" class="btn btn-accent" style="width:100%;padding:10px">Sign In with Admin Key</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    window.showTab = function(tab) {
      document.getElementById('userForm').style.display = tab === 'user' ? 'block' : 'none';
      document.getElementById('keyForm').style.display = tab === 'key' ? 'block' : 'none';
      document.getElementById('tabUser').style.background = tab === 'user' ? 'var(--accent)' : 'var(--surface2)';
      document.getElementById('tabUser').style.color = tab === 'user' ? '#fff' : 'var(--dim)';
      document.getElementById('tabKey').style.background = tab === 'key' ? 'var(--accent)' : 'var(--surface2)';
      document.getElementById('tabKey').style.color = tab === 'key' ? '#fff' : 'var(--dim)';
      if (tab === 'user') document.getElementById('loginUser').focus();
      else document.getElementById('keyInput').focus();
    };

    window.doKeyLogin = function() {
      const k = document.getElementById('keyInput').value.trim();
      if (!k) return;
      setKey(k);
      location.reload();
    };

    window.doPassLogin = async function() {
      const login = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value;
      if (!login || !password) return;
      try {
        const res = await fetch(API + '/api/identity/login', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ login, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById('loginError').style.display = 'block';
          document.getElementById('loginError').textContent = data.error?.message || 'Login failed';
          return;
        }
        localStorage.setItem('cc_identity_token', data.token);
        window.location.href = '/login';
      } catch(e) {
        document.getElementById('loginError').style.display = 'block';
        document.getElementById('loginError').textContent = 'Connection failed';
      }
    };
    return false;
  }
  return true;
}
