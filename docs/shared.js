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
  const cls = {
    live:'badge-live', failed:'badge-failed', building:'badge-building',
    deploying:'badge-deploying', degraded:'badge-degraded',
    'rolling-back':'badge-rolling-back', offline:'badge-offline',
    'health-check':'badge-health-check',
  }[status] || 'badge-pending';
  return '<span class="badge ' + cls + '">' + status + '</span>';
}

function barColor(pct) {
  return pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
}

function statCard(label, value, sub, pct) {
  return '<div class="stat"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div>' +
    (pct > 0 ? '<div class="bar"><div class="bar-fill" style="width:' + pct + '%;background:' + barColor(pct) + '"></div></div>' : '') + '</div>';
}

function sidebar(active) {
  const pages = [
    {id:'dashboard',  label:'Dashboard',   href:'/dashboard',    icon:'⊞'},
    {id:'applications',label:'Applications',href:'/applications', icon:'▣'},
    {id:'users',      label:'Users',        href:'/users-page',   icon:'◉'},
    {id:'audit',      label:'Audit Log',    href:'/audit-page',   icon:'≡'},
    {id:'appstudio',  label:'AppStudio',    href:'/appstudio',    icon:'✦'},
    {id:'settings',   label:'Settings',     href:'/settings',     icon:'⚙'},
  ];
  const nav = pages.map(p =>
    '<a href="' + p.href + '" class="sidebar-link' + (active === p.id ? ' active' : '') + '" title="' + p.label + '">' +
      '<span class="sidebar-link-icon">' + p.icon + '</span>' +
      '<span class="sidebar-link-text">' + p.label + '</span>' +
    '</a>'
  ).join('');

  return '<div class="mobile-topbar">' +
      '<a href="/dashboard" style="font-weight:700;font-size:1.05rem;text-decoration:none;color:var(--text)">App<span style="color:var(--accent)">Crane</span></a>' +
      '<button class="hamburger" onclick="toggleSidebar()" aria-label="Menu">&#9776;</button>' +
    '</div>' +
    '<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>' +
    '<aside class="sidebar" id="mainSidebar">' +
      '<a href="/dashboard" class="sidebar-logo">App<span>Crane</span></a>' +
      '<nav class="sidebar-nav">' + nav + '</nav>' +
      '<div class="sidebar-footer">' +
        '<div id="userInfo" style="color:var(--text);font-weight:600" class="sidebar-footer-meta"></div>' +
        '<div id="craneVersion" style="color:var(--dim);cursor:pointer" class="sidebar-footer-meta" onclick="checkForUpdate()" title="Click to check for updates"></div>' +
        '<div class="sidebar-footer-links" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px">' +
          '<a href="/docs" style="color:var(--dim);text-decoration:none">Docs</a>' +
          '<a href="/agent-guide" style="color:var(--dim);text-decoration:none">Agent Guide</a>' +
          '<button class="btn" onclick="setKey(\'\');location.href=\'/dashboard\'" style="font-size:.72rem;padding:2px 8px;margin-left:auto">Logout</button>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:4px;margin-top:5px">' +
          '<div class="sidebar-kbd-hint" onclick="openCmdPalette()" title="Command palette (⌘K)">' +
            '<kbd>⌘K</kbd>' +
          '</div>' +
          '<button class="theme-btn" onclick="toggleTheme()" id="themeBtn" title="Toggle light/dark mode">☀</button>' +
          '<div class="notif-wrap" style="margin-left:auto">' +
            '<button class="notif-bell-btn" onclick="toggleNotifPanel(event)" id="notifBell" title="Notifications">🔔</button>' +
            '<span class="notif-badge" id="notifBadge"></span>' +
            '<div class="notif-dropdown" id="notifDropdown">' +
              '<div class="notif-dd-hdr">Notifications</div>' +
              '<div id="notifList" class="notif-empty">Loading\u2026</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<button class="sidebar-collapse-btn" onclick="toggleSidebarCollapse()" id="collapseBtn">' +
          '<span id="collapseIcon">\u25c4</span><span class="btn-col-text">&nbsp;Collapse</span>' +
        '</button>' +
      '</div>' +
    '</aside>';
}

function toggleSidebar() {
  document.getElementById('mainSidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('mainSidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

function topbar(active) { return sidebar(active); }

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

function _buildLoginOverlay() {
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(id, label, active) {
    var b = el('button', 'flex:1;padding:10px;border:none;cursor:pointer;font-size:.85rem;font-weight:600;' +
      (active ? 'background:var(--accent);color:#fff' : 'background:var(--surface2);color:var(--dim)'));
    b.id = id; b.textContent = label;
    return b;
  }
  function input(id, type, placeholder) {
    var i = el('input', 'background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:6px;width:100%;margin-bottom:8px;font-size:14px;box-sizing:border-box');
    i.id = id; i.type = type; i.placeholder = placeholder;
    return i;
  }

  var wrap = el('div', 'position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:500');
  var box = el('div', 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:100%;max-width:440px');

  var h2 = el('h2', 'margin:0 0 4px;font-size:1.3rem', 'Sign In');
  var sub = el('p', 'color:var(--dim);margin-bottom:20px;font-size:.9rem', 'Choose your login method');
  var errDiv = el('div', 'display:none;background:#ef444418;border:1px solid #ef444444;color:var(--red);padding:8px;border-radius:6px;margin-bottom:12px;font-size:.85rem');
  errDiv.id = 'loginError';

  var tabs = el('div', 'display:flex;margin-bottom:20px;border:1px solid var(--border);border-radius:6px;overflow:hidden');
  var tabUser = btn('tabUser', 'User Login', true);
  var tabKey = btn('tabKey', 'Admin Key', false);
  tabs.appendChild(tabUser); tabs.appendChild(tabKey);

  var userForm = el('div');
  userForm.id = 'userForm';
  var userNote = el('p', 'color:var(--dim);font-size:.8rem;margin-bottom:12px', 'Sign in to access your assigned apps');
  var loginUser = input('loginUser', 'text', 'Email or username');
  loginUser.setAttribute('autofocus', '');
  var loginPass = input('loginPass', 'password', 'Password');
  loginPass.style.marginBottom = '12px';
  var signInBtn = el('button', 'width:100%;padding:10px');
  signInBtn.className = 'btn btn-accent'; signInBtn.textContent = 'Sign In';
  userForm.appendChild(userNote); userForm.appendChild(loginUser);
  userForm.appendChild(loginPass); userForm.appendChild(signInBtn);

  var keyForm = el('div', 'display:none');
  keyForm.id = 'keyForm';
  var keyNote = el('p', 'color:var(--dim);font-size:.8rem;margin-bottom:12px', 'For AppCrane administrators only');
  var keyInput = input('keyInput', 'password', 'dhk_admin_...');
  keyInput.style.marginBottom = '12px';
  var keySignInBtn = el('button', 'width:100%;padding:10px');
  keySignInBtn.className = 'btn btn-accent'; keySignInBtn.textContent = 'Sign In with Admin Key';
  keyForm.appendChild(keyNote); keyForm.appendChild(keyInput); keyForm.appendChild(keySignInBtn);

  box.appendChild(h2); box.appendChild(sub); box.appendChild(errDiv);
  box.appendChild(tabs); box.appendChild(userForm); box.appendChild(keyForm);
  wrap.appendChild(box);

  signInBtn.addEventListener('click', function() { window.doPassLogin && window.doPassLogin(); });
  keySignInBtn.addEventListener('click', function() { window.doKeyLogin && window.doKeyLogin(); });
  loginPass.addEventListener('keydown', function(e) { if (e.key === 'Enter') { window.doPassLogin && window.doPassLogin(); } });
  keyInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { window.doKeyLogin && window.doKeyLogin(); } });
  loginUser.addEventListener('keydown', function(e) { if (e.key === 'Enter') { loginPass.focus(); } });
  tabUser.addEventListener('click', function() { window.showTab && window.showTab('user'); });
  tabKey.addEventListener('click', function() { window.showTab && window.showTab('key'); });

  return wrap;
}

function checkAuth() {
  if (!KEY) {
    var overlay = _buildLoginOverlay();
    // If page already has sidebar layout, overlay it; otherwise replace body
    if (document.querySelector('.page-body')) {
      document.body.appendChild(overlay);
    } else {
      document.body.style.cssText = 'margin:0;padding:0';
      document.body.appendChild(overlay);
    }

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

// ── Command palette (⌘K / Ctrl+K) ────────────────────────────────────────
var _cmdOpen = false, _cmdApps = null, _cmdIdx = 0, _cmdFiltered = [];

function _cmdItems() {
  var nav = [
    {g:'Navigation',icon:'⊞',label:'Dashboard',href:'/dashboard'},
    {g:'Navigation',icon:'▣',label:'Applications',href:'/applications'},
    {g:'Navigation',icon:'✦',label:'AppStudio',href:'/appstudio'},
    {g:'Navigation',icon:'◉',label:'Users',href:'/users-page'},
    {g:'Navigation',icon:'≡',label:'Audit Log',href:'/audit-page'},
    {g:'Navigation',icon:'⚙',label:'Settings',href:'/settings'},
  ];
  var app = [], act = [];
  (_cmdApps || []).forEach(function(a) {
    var n = a.display_name || a.name;
    app.push({g:'Apps',icon:'▸',label:n,desc:a.slug,href:'/applications'});
    act.push({g:'Actions',icon:'▲',label:'Deploy '+n+' → sandbox',desc:a.slug,
      run:(function(slug,name){return async function(){
        var r = await apiPost('/api/apps/'+slug+'/deploy/sandbox',{});
        _cmdToast(r&&r.error?'✗ '+(r.error.message||'failed'):'✓ Deploy queued — '+name,
          r&&r.error?'var(--red)':'var(--green)');
      };})(a.slug,n)});
    act.push({g:'Actions',icon:'✦',label:'AppStudio: enhance '+n,desc:a.slug,href:'/appstudio'});
  });
  return nav.concat(app).concat(act);
}

function _cmdScore(item,q) {
  var l=item.label.toLowerCase(), d=(item.desc||'').toLowerCase();
  if(l===q) return 100;
  if(l.startsWith(q)) return 90;
  if(d===q||d.startsWith(q)) return 85;
  if(l.includes(q)) return 70;
  if(d.includes(q)) return 55;
  var ws=l.split(/\s+/);
  for(var i=0;i<ws.length;i++) if(ws[i].startsWith(q)) return 80;
  return 0;
}

function _cmdRender(query) {
  var all=_cmdItems(), q=(query||'').trim().toLowerCase(), filtered;
  if(!q) {
    filtered=all.filter(function(i){return i.g==='Navigation';})
      .concat(all.filter(function(i){return i.g==='Apps';}).slice(0,6));
  } else {
    filtered=all.map(function(i){return{i,s:_cmdScore(i,q)};})
      .filter(function(x){return x.s>0;})
      .sort(function(a,b){return b.s-a.s;})
      .map(function(x){return x.i;}).slice(0,14);
  }
  _cmdFiltered=filtered; _cmdIdx=0;
  var el=document.getElementById('cmdResults');
  el.innerHTML='';
  if(!filtered.length){el.innerHTML='<div class="cmd-empty">No results</div>';return;}
  var groups={},order=[];
  filtered.forEach(function(item,idx){
    if(!groups[item.g]){groups[item.g]=[];order.push(item.g);}
    groups[item.g].push({item,idx});
  });
  order.forEach(function(gname){
    var gl=document.createElement('div');gl.className='cmd-group-label';gl.textContent=gname;el.appendChild(gl);
    groups[gname].forEach(function(e){
      var div=document.createElement('div');
      div.className='cmd-item'+(e.idx===0?' cmd-active':'');
      div.dataset.idx=e.idx;
      var ic=document.createElement('span');ic.className='cmd-item-icon';ic.textContent=e.item.icon;
      var lb=document.createElement('span');lb.className='cmd-item-label';lb.textContent=e.item.label;
      var kb=document.createElement('span');kb.className='cmd-item-kbd';kb.textContent='↵';
      div.appendChild(ic);div.appendChild(lb);
      if(e.item.desc){var dc=document.createElement('span');dc.className='cmd-item-desc';dc.textContent=e.item.desc;div.appendChild(dc);}
      div.appendChild(kb);
      div.addEventListener('mouseenter',function(){_cmdIdx=parseInt(this.dataset.idx);_cmdActivate();});
      div.addEventListener('click',function(){_cmdExec(_cmdFiltered[parseInt(this.dataset.idx)]);});
      el.appendChild(div);
    });
  });
}

function _cmdActivate() {
  document.querySelectorAll('.cmd-item').forEach(function(el,i){el.classList.toggle('cmd-active',i===_cmdIdx);});
  var a=document.querySelector('.cmd-item.cmd-active');if(a)a.scrollIntoView({block:'nearest'});
}

function _cmdExec(item) {
  closeCmdPalette();
  if(item.run) item.run();
  else if(item.href) location.href=item.href;
}

function _cmdToast(msg,color) {
  var t=document.createElement('div');t.className='cmd-toast';
  t.style.color=color||'var(--text)';t.textContent=msg;
  document.body.appendChild(t);setTimeout(function(){t.remove();},3000);
}

function closeCmdPalette() {
  _cmdOpen=false;
  var ov=document.getElementById('cmdOverlay');if(ov)ov.style.display='none';
}

function openCmdPalette() {
  _cmdOpen=true;
  var ov=document.getElementById('cmdOverlay');
  if(!ov){
    ov=document.createElement('div');ov.id='cmdOverlay';ov.className='cmd-overlay';
    ov.innerHTML='<div class="cmd-box">'+
      '<div class="cmd-input-row">'+
        '<span class="cmd-input-icon">⌘K</span>'+
        '<input id="cmdInput" class="cmd-input" placeholder="Search apps and actions…" autocomplete="off" spellcheck="false">'+
        '<span class="cmd-esc-hint" onclick="closeCmdPalette()">ESC</span>'+
      '</div>'+
      '<div id="cmdResults" class="cmd-results"></div>'+
    '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click',function(e){if(e.target===ov)closeCmdPalette();});
    document.getElementById('cmdInput').addEventListener('input',function(){_cmdRender(this.value);});
    document.getElementById('cmdInput').addEventListener('keydown',function(e){
      if(e.key==='ArrowDown'){e.preventDefault();_cmdIdx=Math.min(_cmdIdx+1,_cmdFiltered.length-1);_cmdActivate();}
      else if(e.key==='ArrowUp'){e.preventDefault();_cmdIdx=Math.max(_cmdIdx-1,0);_cmdActivate();}
      else if(e.key==='Enter'&&_cmdFiltered[_cmdIdx]){_cmdExec(_cmdFiltered[_cmdIdx]);}
    });
  } else {
    ov.style.display='flex';
  }
  var inp=document.getElementById('cmdInput');inp.value='';inp.focus();
  if(_cmdApps===null&&typeof apiFetch==='function'&&KEY){
    apiFetch('/api/apps').then(function(d){_cmdApps=d.apps||[];_cmdRender('');}).catch(function(){_cmdApps=[];});
  }
  _cmdRender('');
}

document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();if(_cmdOpen)closeCmdPalette();else openCmdPalette();}
  else if(e.key==='Escape'&&_cmdOpen){closeCmdPalette();}
});

// ── Theme ─────────────────────────────────────────────────────
(function initTheme() {
  var t = localStorage.getItem('cc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();

function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cc_theme', next);
  var btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = next === 'dark' ? '☀' : '🌙';
}

// ── Sidebar collapse ──────────────────────────────────────────
function toggleSidebarCollapse() {
  var sb = document.getElementById('mainSidebar');
  var pc = document.querySelector('.page-content');
  var collapsed = sb.classList.toggle('collapsed');
  if (pc) pc.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('cc_sb_col', collapsed ? '1' : '');
  var icon = document.getElementById('collapseIcon');
  if (icon) icon.textContent = collapsed ? '\u25b8' : '\u25c4';
}

document.addEventListener('DOMContentLoaded', function() {
  if (localStorage.getItem('cc_sb_col') === '1') {
    var sb = document.getElementById('mainSidebar');
    var pc = document.querySelector('.page-content');
    if (sb) sb.classList.add('collapsed');
    if (pc) pc.classList.add('sidebar-collapsed');
    var icon = document.getElementById('collapseIcon');
    if (icon) icon.textContent = '\u25b8';
  }
  var t = localStorage.getItem('cc_theme') || 'dark';
  var btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀' : '🌙';
});

// ── Notification bell ─────────────────────────────────────────
var _notifOpen = false;

function toggleNotifPanel(e) {
  if (e) e.stopPropagation();
  _notifOpen = !_notifOpen;
  var dd = document.getElementById('notifDropdown');
  if (dd) dd.classList.toggle('open', _notifOpen);
  if (_notifOpen) _loadNotifications();
}

document.addEventListener('click', function(e) {
  if (_notifOpen && !e.target.closest('.notif-wrap')) {
    _notifOpen = false;
    var dd = document.getElementById('notifDropdown');
    if (dd) dd.classList.remove('open');
  }
});

async function _loadNotifications() {
  var list = document.getElementById('notifList');
  if (!list) return;
  try {
    var data = await apiFetch('/api/apps');
    var items = [];
    (data.apps || []).forEach(function(a) {
      if (a.prod_down) items.push({title: a.name + ' (prod)', sub: 'Health check failing', color: 'var(--red)'});
      if (a.sand_down) items.push({title: a.name + ' (sandbox)', sub: 'Health check failing', color: 'var(--orange)'});
    });
    var badge = document.getElementById('notifBadge');
    if (badge) { badge.textContent = items.length || ''; badge.classList.toggle('show', items.length > 0); }
    if (!items.length) {
      list.className = 'notif-empty';
      list.textContent = 'All systems operational \u2713';
      return;
    }
    list.className = '';
    list.innerHTML = '';
    items.forEach(function(n) {
      var row = document.createElement('div');
      row.className = 'notif-row';
      var dot = document.createElement('div');
      dot.className = 'notif-row-dot';
      dot.style.background = n.color;
      var body = document.createElement('div');
      body.innerHTML = '<div class="notif-row-title">' + esc(n.title) + '</div><div class="notif-row-sub">' + esc(n.sub) + '</div>';
      row.appendChild(dot);
      row.appendChild(body);
      list.appendChild(row);
    });
  } catch(e) {
    list.className = 'notif-empty';
    list.textContent = 'Could not load notifications';
  }
}
