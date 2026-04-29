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

function sidebar(active) {
  const pages = [
    {id:'dashboard',label:'Dashboard',href:'/dashboard'},
    {id:'applications',label:'Applications',href:'/applications'},
    {id:'users',label:'Users',href:'/users-page'},
    {id:'audit',label:'Audit Log',href:'/audit-page'},
    {id:'appstudio',label:'AppStudio',href:'/appstudio'},
    {id:'settings',label:'Settings',href:'/settings'},
  ];
  const nav = pages.map(p =>
    '<a href="' + p.href + '" class="sidebar-link' + (active === p.id ? ' active' : '') + '">' + p.label + '</a>'
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
        '<div id="userInfo" style="color:var(--text);font-weight:600"></div>' +
        '<div id="craneVersion" style="color:var(--dim);cursor:pointer" onclick="checkForUpdate()" title="Click to check for updates"></div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px">' +
          '<a href="/docs" style="color:var(--dim);text-decoration:none">Docs</a>' +
          '<a href="/agent-guide" style="color:var(--dim);text-decoration:none">Agent Guide</a>' +
          '<button class="btn" onclick="setKey(\'\');location.href=\'/dashboard\'" style="font-size:.72rem;padding:2px 8px;margin-left:auto">Logout</button>' +
        '</div>' +
        '<div class="sidebar-kbd-hint" onclick="openCmdPalette()" title="Command palette">' +
          '<kbd>⌘K</kbd><span>Search</span>' +
        '</div>' +
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

function checkAuth() {
  if (!KEY) {
    document.body.innerHTML =
      '<div style="background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px"><span style="font-weight:700;font-size:1.05rem">App<span style="color:var(--accent)">Crane</span></span></div>' +
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
