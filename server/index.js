import express from 'express';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, unlinkSync } from 'fs';
import { initDb, getDb } from './db.js';
import { errorHandler, notFound } from './utils/errors.js';
import log from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env file (no external dependency)
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {  // don't override existing env vars
      process.env[key] = value;
    }
  }
  log.info(`.env loaded (${envPath})`);
}

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

// Routes
import authRoutes from './routes/auth.js';
import appsRoutes from './routes/apps.js';
import usersRoutes from './routes/users.js';
import deployRoutes from './routes/deploy.js';
import envVarsRoutes from './routes/envVars.js';
import healthRoutes from './routes/health.js';
import webhooksRoutes from './routes/webhooks.js';
import backupsRoutes from './routes/backups.js';
import logsRoutes from './routes/logs.js';
import monitoringRoutes from './routes/monitoring.js';
import notificationsRoutes from './routes/notifications.js';
import uploadRoutes from './routes/upload.js';
import identityRoutes from './routes/identity.js';
import settingsRoutes from './routes/settings.js';
import enhancementsRoutes from './routes/enhancements.js';
import appstudioRoutes from './routes/appstudio.js';
import oidcRoutes from './routes/oidc.js';
import samlRoutes from './routes/saml.js';
import scimRoutes, { scimAdminRouter } from './routes/scim.js';

const PORT = process.env.PORT || 5001;
const HOST = process.env.HOST || '0.0.0.0';

// Initialize database
initDb();

const app = express();

// Security hardening
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Static files (favicon)
app.use('/public', express.static(join(__dirname, '..', 'public')));
app.use('/docs', express.static(join(__dirname, '..', 'docs')));
app.get('/favicon.svg', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'favicon.svg')));

// Serve app icons publicly (no auth required — needed by login page and iframe topbar)
// Raster formats preferred; legacy SVG served with restrictive CSP to block inline scripts.
const ICON_EXTS = [
  { ext: 'png',  type: 'image/png' },
  { ext: 'jpg',  type: 'image/jpeg' },
  { ext: 'jpeg', type: 'image/jpeg' },
  { ext: 'webp', type: 'image/webp' },
  { ext: 'gif',  type: 'image/gif' },
  { ext: 'svg',  type: 'image/svg+xml' },
];
app.get('/api/apps/:slug/icon', (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return res.status(404).end();
  const iconDir = resolve(join(process.env.DATA_DIR || './data', 'apps', slug));
  for (const { ext, type } of ICON_EXTS) {
    const iconPath = join(iconDir, `icon.${ext}`);
    if (existsSync(iconPath)) {
      if (ext === 'svg') {
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      }
      res.type(type).sendFile(iconPath);
      return;
    }
  }
  res.status(404).end();
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for dashboard — restrict to CRANE_DOMAIN when configured
const CRANE_ORIGIN = process.env.CRANE_DOMAIN ? `https://${process.env.CRANE_DOMAIN}` : null;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CRANE_ORIGIN) {
    // Production: only echo the configured crane origin
    if (origin === CRANE_ORIGIN) res.header('Access-Control-Allow-Origin', CRANE_ORIGIN);
    res.header('Vary', 'Origin');
  } else {
    // No CRANE_DOMAIN (dev / direct-IP): fall back to wildcard
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/api/server/health' && !req.path.startsWith('/dashboard')) {
    log.debug(`${req.method} ${req.path}`);
  }
  next();
});

// Guard: block everything except public routes until admin is configured
const PUBLIC_PATHS = ['/api/info', '/favicon.svg', '/login', '/api/identity/login', '/api/identity/verify', '/api/identity/logout', '/api/identity/me'];
app.use((req, res, next) => {
  // Settings GETs are public (agents read branding); writes go through requireAdmin.
  const isPublicSettingsRead = req.method === 'GET' && req.path.startsWith('/api/settings');
  const isCrashPage = req.path.startsWith('/api/_crashed/');
  if (PUBLIC_PATHS.includes(req.path) || req.path.startsWith('/docs/') || isPublicSettingsRead || isCrashPage || req.method === 'OPTIONS') return next();

  const db = getDb();
  const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count > 0;
  if (!adminExists) {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.status(503).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AppCrane - Setup</title>
<style>body{background:#0f1117;color:#e4e4e7;font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{background:#1a1d27;border:1px solid #3b82f6;border-radius:12px;padding:40px;max-width:500px;text-align:center}
h1{margin-bottom:8px}h1 span{color:#3b82f6}p{color:#71717a;margin:8px 0}
pre{background:#1e2130;border:1px solid #2a2d3a;border-radius:6px;padding:14px;text-align:left;font-size:13px;overflow-x:auto;margin-top:16px;color:#22c55e}</style></head>
<body><div class="box"><h1>App<span>Crane</span></h1><p>Server is running but not initialized.</p><p>SSH into the server and run:</p>
<pre>cd ~/cloudCrane
npm link
crane init --name admin --email you@example.com</pre>
<p style="margin-top:16px;font-size:13px;color:#ef4444">Init can only be run from the server itself.</p>
<p style="font-size:13px;color:#71717a">Then refresh this page.</p></div></body></html>`);
    }
    return res.status(503).json({
      error: {
        code: 'NOT_INITIALIZED',
        message: `AppCrane is not initialized. Run: curl -X POST http://${req.headers.host}/api/auth/init -H "Content-Type: application/json" -d '{"name":"admin","email":"you@example.com"}'`
      }
    });
  }
  next();
});

// Slug fallback: when an app's frontend was built without APP_BASE_PATH, its
// HTML/JS still emits root-relative URLs (/assets/foo.js, /api/state, …) and
// the browser hits AppCrane instead of the app. If the Referer shows the
// request originated inside an app's iframe at /{slug}/…, redirect (307 —
// preserves method + body) to /{slug}{originalUrl} so Caddy routes it through
// the per-app handle.
//
// Runs early — before the API routers — because some AppCrane routers
// (logsRoutes mounted at /api) install requireAuth as router-level middleware
// and would 401 unmatched /api/* paths before we got a chance to redirect.
//
// Excludes /api/identity/* and /api/apps/* so apps can still call AppCrane's
// own identity / icon endpoints from inside their iframe.
const APPCRANE_PASSTHROUGH = ['/api/identity', '/api/apps', '/api/info', '/api/_crashed', '/favicon.svg', '/docs'];
const APPCRANE_PAGE_SLUGS = new Set(['login', 'dashboard', 'applications', 'users-page', 'audit-page', 'settings', 'docs', 'agent-guide', 'app']);
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  for (const prefix of APPCRANE_PASSTHROUGH) {
    if (req.path === prefix || req.path.startsWith(prefix + '/')) return next();
  }
  const referer = req.headers.referer || req.headers.referrer || '';
  const m = referer.match(/^https?:\/\/[^/]+\/([^/?#]+)/);
  if (!m) return next();
  const refSlug = m[1];
  if (APPCRANE_PAGE_SLUGS.has(refSlug)) return next();

  const baseSlug = refSlug.replace(/-sandbox$/, '');
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM apps WHERE slug = ?').get(baseSlug);
  if (!exists) return next();

  if (req.path === `/${refSlug}` || req.path.startsWith(`/${refSlug}/`)) return next();

  const target = `/${refSlug}${req.originalUrl}`;
  log.debug(`[slug-fallback] ${req.method} ${req.originalUrl} → ${target}`);
  return res.redirect(307, target);
});

// Public API endpoints (no auth)
app.get('/api/info', (req, res) => {
  const db = getDb();
  const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count > 0;
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const authenticated = !!(apiKey && apiKey.length > 10);
  res.json({
    name: 'AppCrane',
    ...(authenticated && { version: VERSION }),
    status: adminExists ? 'ready' : 'needs_init',
    description: 'Self-hosted deployment manager',
    docs: '/docs',
    dashboard: '/dashboard',
    agent_guide: '/agent-guide',
    ...(!adminExists && { init: 'POST /api/auth/init -d \'{"name":"admin","email":"you@example.com"}\'' }),
  });
});

// Semver comparison: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Version check endpoint (compares local vs GitHub)
let _cachedRemoteVersion = null;
let _lastVersionCheck = 0;
app.get('/api/version-check', requireAuth, requireAdmin, async (req, res) => {
  const now = Date.now();
  // Cache for 5 minutes
  if (_cachedRemoteVersion && now - _lastVersionCheck < 5 * 60 * 1000) {
    const isNewer = compareVersions(_cachedRemoteVersion, VERSION) > 0;
    return res.json({ current: VERSION, latest: _cachedRemoteVersion, update_available: isNewer });
  }
  try {
    const response = await fetch('https://raw.githubusercontent.com/gitayg/appCrane/main/package.json', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const remotePkg = await response.json();
      _cachedRemoteVersion = remotePkg.version;
      _lastVersionCheck = now;
      const isNewer = compareVersions(remotePkg.version, VERSION) > 0;
      res.json({ current: VERSION, latest: remotePkg.version, update_available: isNewer });
    } else {
      res.json({ current: VERSION, latest: null, update_available: false, error: 'Could not fetch remote version' });
    }
  } catch (e) {
    res.json({ current: VERSION, latest: null, update_available: false, error: e.message });
  }
});

// Caddy reload endpoint (admin only)
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { reloadCaddy, generateCaddyfile } from './services/caddy.js';

app.post('/api/caddy/reload', requireAuth, requireAdmin, async (req, res) => {
  const result = await reloadCaddy();
  res.json({ ...result, caddyfile: generateCaddyfile() });
});

app.get('/api/caddy/config', requireAuth, requireAdmin, (req, res) => {
  res.type('text/plain').send(generateCaddyfile());
});

function selfUpdateDataDir() {
  return resolve(process.env.DATA_DIR || join(__dirname, '..', 'data'));
}

function pendingUpdateFile() {
  return join(selfUpdateDataDir(), 'self-update-pending.json');
}

function bootSentinelFile() {
  return join(selfUpdateDataDir(), 'boot-sentinel.json');
}

// Self-update endpoint (admin only)
app.post('/api/self-update', requireAuth, requireAdmin, async (req, res) => {
  const cwd = join(__dirname, '..');
  try {
    const { execFileSync, spawn } = await import('child_process');
    const { logAudit } = await import('./middleware/audit.js');

    const gitOpts = { cwd, stdio: 'pipe', timeout: 30000 };
    execFileSync('git', ['-c', 'credential.helper=', 'fetch', 'origin'], gitOpts);
    const pullOutput = execFileSync('git', ['reset', '--hard', 'origin/main'], gitOpts).toString().trim();

    execFileSync('npm', ['install', '--omit=dev', '--prefer-offline'], {
      cwd, stdio: 'pipe', timeout: 120000,
    });

    const newPkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const targetVersion = newPkg.version;

    // v1.3 → v1.4 transition: write systemd unit + install docker, but DON'T kill pm2 yet
    // (that would kill this process before cutover finishes). Cutover runs detached below.
    const needsHostUpgrade = !existsSync('/etc/systemd/system/appcrane.service');
    const upgradeScript = join(cwd, 'scripts/upgrade-to-docker.sh');
    const runUser = process.env.SUDO_USER || process.env.USER || 'root';
    const isRoot = !process.getuid || process.getuid() === 0;

    if (needsHostUpgrade) {
      if (!isRoot) {
        throw new Error('Upgrade to v1.4 requires root to install Docker + systemd unit. Run install.sh manually.');
      }
      if (!existsSync(upgradeScript)) {
        throw new Error(`Upgrade script missing at ${upgradeScript}`);
      }
      log.info('Self-update: running v1.4 prepare phase (install docker, write systemd unit)');
      execFileSync('bash', [upgradeScript, 'prepare', cwd, runUser], {
        stdio: 'pipe', timeout: 300000,
      });
      log.info('Self-update: prepare complete — systemd unit enabled, not yet started');
    } else if (isRoot && existsSync(upgradeScript)) {
      // Already under systemd — run hygiene cleanup on every update so stale
      // PM2 daemons / pm2-<user>.service files left from a botched migration
      // get reaped on the next self-update without manual intervention.
      try {
        log.info('Self-update: running cleanup phase (kill stray PM2 if any)');
        execFileSync('bash', [upgradeScript, 'cleanup', cwd, runUser], {
          stdio: 'pipe', timeout: 60000,
        });
      } catch (cleanupErr) {
        // Non-fatal — log and continue with the update
        log.warn(`Self-update cleanup failed (continuing): ${cleanupErr.message}`);
      }
    }

    const dataDir = selfUpdateDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(pendingUpdateFile(), JSON.stringify({
      previous_version: VERSION,
      target_version: targetVersion,
      started_at: new Date().toISOString(),
      pid: process.pid,
      host_migrated: needsHostUpgrade,
    }, null, 2));

    logAudit(req.user?.id, null, 'self-update-triggered', {
      from: VERSION, to: targetVersion, git: pullOutput, host_migrated: needsHostUpgrade,
    });
    log.info(`Self-update: ${VERSION} → ${targetVersion} (pulled ${pullOutput})`);

    res.json({
      message: 'Update pulled. Restarting...',
      git: pullOutput,
      version: targetVersion,
      host_migrated: needsHostUpgrade,
    });

    if (needsHostUpgrade) {
      // Spawn detached cutover helper: kills pm2, starts appcrane.service, verifies health.
      // MUST survive this process dying when pm2 kills it, so stdio:'ignore' + detached + unref.
      setTimeout(() => {
        try {
          const upgradeScript = join(cwd, 'scripts/upgrade-to-docker.sh');
          const runUser = process.env.SUDO_USER || process.env.USER || 'root';
          const logFile = join(selfUpdateDataDir(), 'cutover.log');
          const fd = openSync(logFile, 'a');
          const child = spawn('bash', [upgradeScript, 'cutover', cwd, runUser], {
            detached: true,
            stdio: ['ignore', fd, fd],
          });
          child.unref();
          log.info(`Self-update: cutover helper spawned (pid ${child.pid}); exiting — systemd will take over`);
        } catch (e) {
          log.error(`Self-update: cutover spawn failed: ${e.message}`);
        }
        setTimeout(() => process.exit(0), 500);
      }, 1000);
    } else {
      // v1.4+ → v1.4+: already under systemd. Just exit and let Restart=always re-exec us.
      setTimeout(() => {
        log.info('Self-update: exiting for systemd restart');
        process.exit(0);
      }, 1000);
    }
  } catch (e) {
    const detail = e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message;
    res.status(500).json({ error: { code: 'UPDATE_FAILED', message: detail } });
  }
});

// Self-update status — lets clients poll whether a triggered update actually landed.
app.get('/api/self-update/status', requireAuth, requireAdmin, (req, res) => {
  const pending = pendingUpdateFile();
  if (!existsSync(pending)) {
    return res.json({ pending: false, current_version: VERSION });
  }
  try {
    const info = JSON.parse(readFileSync(pending, 'utf8'));
    const age = Date.now() - new Date(info.started_at).getTime();
    const completed = !!info.completed_at;
    res.json({
      pending: !completed && age < 30000,
      timed_out: !completed && age >= 30000,
      success: info.success ?? null,
      current_version: VERSION,
      ...info,
    });
  } catch (e) {
    res.json({ pending: false, current_version: VERSION, error: 'Could not read sentinel' });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/auth/saml', samlRoutes);
app.use('/api/auth/scim', scimAdminRouter);
app.use('/api/scim/v2', scimRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/apps', deployRoutes);     // /api/apps/:slug/deploy/:env
app.use('/api/apps', envVarsRoutes);     // /api/apps/:slug/env/:env
app.use('/api/apps', healthRoutes);      // /api/apps/:slug/health/:env
app.use('/api/apps', backupsRoutes);     // /api/apps/:slug/backup/:env
app.use('/api/apps', uploadRoutes);      // /api/apps/:slug/upload/:env
app.use('/api/apps', notificationsRoutes); // /api/apps/:slug/notifications
// Mount identity FIRST so its routes don't get caught by other middleware
app.use('/api/identity', identityRoutes);
app.use('/api/enhancements', enhancementsRoutes); // Enhancement requests (Bearer auth, must be before logsRoutes)
app.use('/api/appstudio', appstudioRoutes); // AppStudio plan/code/build pipeline
app.use('/api/webhooks', webhooksRoutes); // Public webhook endpoint (no auth — must be before logsRoutes)

app.use('/api', logsRoutes);             // /api/audit, /api/apps/:slug/audit
app.use('/api', monitoringRoutes);       // /api/server/health
app.use('/api/users', usersRoutes);
app.use('/api/apps', webhooksRoutes);     // /api/apps/:slug/webhook config
app.use('/api/apps', usersRoutes);        // /api/apps/:slug/roles, /api/apps/:slug/identity/users (admin)
app.use('/api/settings', settingsRoutes); // General settings (branding, etc.)

// Login page
app.get('/login', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'login.html')));

// Dashboard (admin)
app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'dashboard.html')));
app.get('/applications', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'applications.html')));
app.get('/users-page', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'users-page.html')));
app.get('/audit-page', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'audit-page.html')));
app.get('/enhancements-page', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'enhancements-page.html')));
app.get('/appstudio', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'appstudio.html')));
app.get('/settings', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'settings.html')));

// App manager (app user)
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'app.html')));

// Root redirects to login
app.get('/', (req, res) => res.redirect('/login'));

// Docs page
app.get('/docs', (req, res) => res.sendFile(join(__dirname, '..', 'docs', 'index.html')));

// Agent guide
app.get('/agent-guide', (req, res) => { res.type('text/markdown'); res.sendFile(join(__dirname, '..', 'AGENT_GUIDE.md')); });

// Friendly crash page. Caddy's handle_errors rewrites failed app proxy requests
// to /api/_crashed<original-uri> so we can identify the app from the URL and
// render a useful page instead of a blank upstream error.
app.all('/api/_crashed/*splat', (req, res) => {
  const rawSplat = req.params.splat;
  const rest = Array.isArray(rawSplat) ? rawSplat.join('/') : (rawSplat || '');
  const firstSeg = rest.split(/[/?#]/).filter(Boolean)[0] || '';
  const envSuffix = firstSeg.endsWith('-sandbox') ? 'sandbox' : 'production';
  const slug = firstSeg.replace(/-sandbox$/, '');
  let appName = slug || 'Unknown app';
  try {
    const db = getDb();
    const row = slug ? db.prepare('SELECT name FROM apps WHERE slug = ?').get(slug) : null;
    if (row?.name) appName = row.name;
  } catch (_) {}

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  res.status(503).type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(appName)} is unavailable</title>
<style>
body{background:#0f1117;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1a1d27;border:1px solid #2a2d3a;border-radius:12px;padding:40px;max-width:520px;width:100%;text-align:center}
.icon{font-size:48px;margin-bottom:12px}
h1{margin:0 0 8px;font-size:1.4rem;font-weight:600}
.env{display:inline-block;font-size:.7rem;color:#a1a1aa;background:#2a2d3a;border-radius:4px;padding:2px 8px;margin-left:6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.5px}
p{color:#a1a1aa;line-height:1.55;margin:8px 0}
code{background:#0f1117;border:1px solid #2a2d3a;border-radius:4px;padding:2px 6px;font-size:.85rem;color:#e4e4e7}
.actions{margin-top:24px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.btn{background:#3b82f6;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:.9rem;font-weight:500}
.btn:hover{background:#2563eb}
.btn-ghost{background:transparent;color:#a1a1aa;border:1px solid #2a2d3a}
.btn-ghost:hover{border-color:#3b82f6;color:#e4e4e7}
.hint{font-size:.78rem;color:#71717a;margin-top:16px}
</style></head>
<body>
<div class="card">
  <div class="icon">⚠️</div>
  <h1>${esc(appName)}<span class="env">${esc(envSuffix)}</span></h1>
  <p>This app is currently unreachable — the container isn't responding.</p>
  <p>Most likely causes:</p>
  <p style="text-align:left;display:inline-block;font-size:.85rem">
    • The app crashed on startup (check the deploy log)<br>
    • The container hit its restart cap and stopped<br>
    • A recent deploy is still in progress
  </p>
  <div class="actions">
    <a class="btn" href="/app?slug=${esc(slug)}">Open app manager</a>
    <a class="btn btn-ghost" href="/dashboard">Dashboard</a>
  </div>
  <div class="hint">If you're an admin, check <code>journalctl -u appcrane</code> or the deploy log on the dashboard.</div>
</div>
</body></html>`);
});

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
app.listen(PORT, HOST, async () => {
  log.info('');
  log.info(`  AppCrane v${VERSION} - Self-hosted deploy manager`);
  log.info(`  API:       http://${HOST}:${PORT}`);
  log.info(`  Dashboard: http://${HOST}:${PORT}/dashboard`);
  log.info(`  Docs:      http://${HOST}:${PORT}/docs`);
  log.info('');

  // Boot sentinel — confirms this process actually started with this version.
  // Also reconciles any pending self-update left by a previous process exit.
  try {
    const dataDir = selfUpdateDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(bootSentinelFile(), JSON.stringify({
      pid: process.pid,
      version: VERSION,
      boot_time: new Date().toISOString(),
    }, null, 2));

    const pending = pendingUpdateFile();
    if (existsSync(pending)) {
      const info = JSON.parse(readFileSync(pending, 'utf8'));
      if (!info.completed_at) {
        const success = info.target_version === VERSION;
        writeFileSync(pending, JSON.stringify({
          ...info,
          completed_at: new Date().toISOString(),
          success,
          final_version: VERSION,
        }, null, 2));
        log.info(`Self-update reconciled: ${info.previous_version} → ${VERSION} (success: ${success})`);
        // Version actually changed → flag for container recreation downstream.
        // Triggers a redeploy of every live app so policy changes (restart cap,
        // env injections, Dockerfile template tweaks) propagate to existing apps.
        if (success && info.previous_version && info.previous_version !== VERSION) {
          global.__appcraneVersionChanged = { from: info.previous_version, to: VERSION };
        }
      }
    }
  } catch (e) {
    log.warn('Boot sentinel write failed: ' + e.message);
  }

  // First run check
  const { getDb } = await import('./db.js');
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    log.warn('No users found. Initialize with: POST /api/auth/init');
    log.warn('Or run: crane init');
  }

  // Start health checker
  try {
    const { startHealthChecker } = await import('./services/healthChecker.js');
    startHealthChecker();

    if (process.env.ANTHROPIC_API_KEY) {
      const { startWorker } = await import('./services/appstudio/worker.js');
      startWorker();
    }
  } catch (e) {
    log.warn('Health checker startup deferred');
  }

  // Reload Caddy on startup so config changes (e.g. after self-update) take effect
  try {
    const { reloadCaddy } = await import('./services/caddy.js');
    const result = await reloadCaddy();
    if (result.mock) log.info('Caddy config generated (mock mode)');
    else if (result.success) log.info('Caddy reloaded on startup');
    else log.warn('Caddy reload on startup failed: ' + result.error);
  } catch (e) {
    log.warn('Caddy reload on startup skipped: ' + e.message);
  }

  // Bulk-redeploy sentinel — written by the upgrade script's cleanup phase
  // when it kills a PM2 daemon, because those apps are now offline and need
  // to be rebuilt as Docker containers. In-process, no API key needed.
  try {
    const dataDir = selfUpdateDataDir();
    const sentinel = join(dataDir, 'needs-bulk-redeploy');
    if (existsSync(sentinel)) {
      const { deployApp } = await import('./services/deployer.js');
      const { getPortsForSlot } = await import('./services/portAllocator.js');
      const allApps = db.prepare('SELECT * FROM apps').all();
      log.info(`Bulk-redeploy sentinel found — queueing ${allApps.length} app(s) for production deploy`);
      for (const app of allApps) {
        try {
          const ports = getPortsForSlot(app.slot);
          const r = db.prepare(`
            INSERT INTO deployments (app_id, env, status, log)
            VALUES (?, 'production', 'pending', 'auto-queued after PM2 cleanup')
          `).run(app.id);
          log.info(`  → ${app.slug} (deploy id ${r.lastInsertRowid})`);
          deployApp(r.lastInsertRowid, app, 'production', ports).catch(err => {
            log.error(`     ${app.slug} failed: ${err.message}`);
          });
        } catch (e) {
          log.error(`  ${app.slug}: ${e.message}`);
        }
      }
      // Delete the sentinel so subsequent boots don't re-trigger
      try { unlinkSync(sentinel); } catch (_) {}
    }
  } catch (e) {
    log.warn('Bulk-redeploy sentinel check failed: ' + e.message);
  }

  // Auto-heal: any app with a 'live' deployment but no running container gets
  // redeployed. Catches the "PM2 got killed by a cutover, apps are orphaned,
  // no one wrote the sentinel" state and also recovers after docker restarts.
  // Runs once per boot; if Docker isn't available, no-ops silently.
  try {
    const { execFileSync } = await import('child_process');
    let runningSet = new Set();
    try {
      const out = execFileSync('docker', ['ps', '--filter', 'label=appcrane=true', '--format', '{{.Names}}'],
        { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
      if (out) runningSet = new Set(out.split('\n'));
    } catch (e) {
      // Docker not installed or daemon down — skip auto-heal
      throw new Error('docker ps unavailable');
    }
    // Only consider apps whose MOST RECENT deployment per env is 'live' AND
    // was deployed >5min ago. If the latest deploy failed, or was just attempted,
    // don't redeploy — same code → same failure → CPU drain.
    const liveDeploys = db.prepare(`
      SELECT a.*, d.env AS deploy_env, d.finished_at AS deploy_finished_at
      FROM apps a
      JOIN deployments d ON d.app_id = a.id
      WHERE d.id = (
        SELECT MAX(id) FROM deployments WHERE app_id = a.id AND env = d.env
      )
      AND d.status = 'live'
      AND (strftime('%s', 'now') - strftime('%s', COALESCE(d.finished_at, d.started_at))) > 300
    `).all();
    const missing = liveDeploys.filter(r => !runningSet.has(`appcrane-${r.slug}-${r.deploy_env}`));
    if (missing.length > 0) {
      const { deployApp } = await import('./services/deployer.js');
      const { getPortsForSlot } = await import('./services/portAllocator.js');
      log.info(`Auto-heal: ${missing.length} live deploy(s) have no running container — redeploying`);
      for (const row of missing) {
        try {
          const ports = getPortsForSlot(row.slot);
          const r = db.prepare(`
            INSERT INTO deployments (app_id, env, status, log)
            VALUES (?, ?, 'pending', 'auto-heal: live deploy had no running container')
          `).run(row.id, row.deploy_env);
          log.info(`  → ${row.slug}-${row.deploy_env} (deploy id ${r.lastInsertRowid})`);
          deployApp(r.lastInsertRowid, row, row.deploy_env, ports).catch(err => {
            log.error(`     ${row.slug}-${row.deploy_env} failed: ${err.message}`);
          });
        } catch (e) {
          log.error(`  ${row.slug}-${row.deploy_env}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    log.warn('Auto-heal skipped: ' + e.message);
  }

  // Post-upgrade container recreation — if the AppCrane version just changed,
  // queue a redeploy of every app whose latest deployment is 'live'. This
  // ensures policy changes (e.g. --restart=on-failure cap) baked into the
  // Dockerfile / docker run flags actually reach existing containers without
  // requiring a manual redeploy of each app.
  if (global.__appcraneVersionChanged) {
    const { from, to } = global.__appcraneVersionChanged;
    delete global.__appcraneVersionChanged;
    try {
      const liveApps = db.prepare(`
        SELECT a.*, d.env AS deploy_env
        FROM apps a
        JOIN deployments d ON d.app_id = a.id
        WHERE d.id = (
          SELECT MAX(id) FROM deployments WHERE app_id = a.id AND env = d.env
        )
        AND d.status = 'live'
      `).all();
      if (liveApps.length > 0) {
        const { deployApp } = await import('./services/deployer.js');
        const { getPortsForSlot } = await import('./services/portAllocator.js');
        log.info(`Post-upgrade ${from} → ${to}: recreating ${liveApps.length} container(s) under new policy`);
        for (const row of liveApps) {
          try {
            const ports = getPortsForSlot(row.slot);
            const r = db.prepare(`
              INSERT INTO deployments (app_id, env, status, log)
              VALUES (?, ?, 'pending', ?)
            `).run(row.id, row.deploy_env, `post-upgrade recreate (${from} → ${to})`);
            log.info(`  → ${row.slug}-${row.deploy_env} (deploy id ${r.lastInsertRowid})`);
            deployApp(r.lastInsertRowid, row, row.deploy_env, ports).catch(err => {
              log.error(`     ${row.slug}-${row.deploy_env} failed: ${err.message}`);
            });
          } catch (e) {
            log.error(`  ${row.slug}-${row.deploy_env}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      log.warn('Post-upgrade recreate skipped: ' + e.message);
    }
  }

  // Orphan check — warn if Docker containers are running but not tracked in the DB
  try {
    const { getOrphanedSlugs } = await import('./services/reconcile.js');
    const orphans = getOrphanedSlugs();
    if (orphans.length > 0) {
      log.warn('');
      log.warn(`  ⚠  ${orphans.length} orphaned container(s) found — running but not in DB:`);
      for (const slug of orphans) log.warn(`       ${slug}`);
      log.warn('  Run: crane reconcile   (or POST /api/apps/reconcile)');
      log.warn('');
    }
  } catch (e) {}
});
