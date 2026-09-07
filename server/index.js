import express from 'express';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { initDb, getDb } from './db.js';
import { errorHandler, notFound } from './utils/errors.js';
import log from './utils/logger.js';
import { platformEmbedAncestors, mergeAncestors } from './utils/embed.js';
import { isSafeRedirect } from './utils/safeRedirect.js';

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
import appRolesRoutes from './routes/appRoles.js';
import identityRoutes from './routes/identity.js';
import settingsRoutes from './routes/settings.js';
import configRoutes from './routes/config.js';
import enhancementsRoutes from './routes/enhancements.js';
import appstudioRoutes from './routes/appstudio.js';
import oidcRoutes from './routes/oidc.js';
import samlRoutes from './routes/saml.js';
import scimRoutes, { scimAdminRouter } from './routes/scim.js';
import presenceRoutes from './routes/presence.js';
import askRoutes from './routes/ask.js';
import planRoutes from './routes/plan.js';
import coderRoutes from './routes/coder.js';
import agentsRoutes from './routes/agents.js';
import skillsRoutes from './routes/skills.js';
import mcpRoutes from './routes/mcp.js';
import userMcpKeysRoutes from './routes/userMcpKeys.js';
import meRoutes from './routes/me.js';
import filesRoutes, { sweepStagedFiles } from './routes/files.js';
import githubServiceRoutes from './routes/githubService.js';
import whatsNewRoutes from './routes/whatsNew.js';
import platformWhatsNewRoutes from './routes/platformWhatsNew.js';
import serviceApiRoutes from './routes/serviceApi.js';
import noticesRoutes from './routes/notices.js';
import catalogRoutes from './routes/catalog.js';
import { globalNotices } from './services/platformNotices.js';

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
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

/**
 * No-store on API responses (v2.35.1).
 *
 * A WAS scan found `/api/me` — which returns the caller's id, name, email and
 * role — served with no Cache-Control at all. HTML got `no-store` via
 * sendHtml() and SSE routes set their own, but ordinary JSON responses got
 * nothing, so an identity payload was cacheable by the browser and by any
 * intermediary between it and Caddy. Same applies to /api/apps (app inventory)
 * and every other authenticated read.
 *
 * Set before the routes so a handler can still override it — SSE routes do,
 * with `no-cache`. App icons are deliberately exempt: they're public,
 * unchanging and fetched once per app for every sidebar and tile render, so
 * making them uncacheable would be a pure regression for no privacy gain.
 */
app.use('/api', (req, res, next) => {
  if (!req.path.endsWith('/icon')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Global API rate limiter: 2000 req/min per authenticated user (or 600/min per IP fallback).
// The admin SPA fans out ~40 requests per dashboard load (server health, apps, users,
// enhancements, activity, metrics, plus per-app live-version probes) and auto-refreshes
// every 30s, so the limit needs headroom for that plus normal navigation.
const _apiRateMap = new Map();
setInterval(() => { const now = Date.now(); for (const [k, rec] of _apiRateMap) { if (now > rec.resetAt) _apiRateMap.delete(k); } }, 5 * 60_000);

// MCP-E (v2.2.18): reap expired staged_files rows + their scratch dirs every
// 5 minutes. Idempotent; safe across server restarts (the row's expires_at
// is the source of truth, not in-memory state).
setInterval(() => { try { sweepStagedFiles(); } catch (_) {} }, 5 * 60_000);
function apiRateLimit(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const apiKey = req.headers['x-api-key'] || '';
  const isAuthed = Boolean(bearer || apiKey);
  // Hash the credential before using it as the bucket key — keeping plaintext
  // keys in process memory (the rate-limit Map persists for up to 5 min beyond
  // request lifetime) was unnecessary residue. SHA-256 is enough; keys are
  // already 192-bit random so collision risk is nil.
  const credHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
  const key = bearer ? `t:${credHash(bearer)}` : apiKey ? `k:${credHash(apiKey)}` : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  const limit = isAuthed ? 2000 : 600;
  const now = Date.now();
  const rec = _apiRateMap.get(key);
  if (!rec || now > rec.resetAt) { _apiRateMap.set(key, { count: 1, resetAt: now + 60_000 }); return next(); }
  if (rec.count >= limit) return res.status(429).json({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } });
  rec.count++;
  next();
}

/**
 * v2.36.0: `script-src` no longer allows 'unsafe-inline'.
 *
 * With it, a CSP gives almost no XSS protection — injected markup executes just
 * as happily as first-party code, which is what the scan's "Permissive Content
 * Security Policy" finding was pointing at. An audit of everything this policy
 * covers found NO inline scripts: the admin SPA's index.html loads one external
 * module, raiseme.html has no <script> at all, and the setup/crash pages
 * generated inline here are style-only. So dropping it costs nothing.
 *
 * `style-src` KEEPS 'unsafe-inline' deliberately. The React codebase uses
 * `style={{…}}` throughout; removing it would require refactoring every inline
 * style to a class or hashing each one, and the XSS value of blocking inline
 * *styles* is a small fraction of blocking inline *scripts*. Not worth breaking
 * the UI for a partial win.
 *
 * fonts.googleapis.com / fonts.gstatic.com stay for the webfonts.
 */
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'";

/**
 * docs/login.html is the last hand-written pre-SPA page: ~2600 lines of inline
 * <script> plus inline on*= handlers, from before the React SPA. script-src
 * 'self' would blank it, so it keeps the weaker policy.
 *
 * The other nine pre-SPA pages (dashboard/applications/settings/users-page/
 * app/coder/audit-page/enhancements-page/dashboard-new) were deleted in
 * v2.37.0 — every one of those routes had already been serving the SPA shell,
 * so express.static was exposing dead HTML at /docs/<name>.html and forcing
 * this carve-out to cover the whole tree.
 *
 * login.html survives them because it is the auth fallback, not because it is
 * maintained. Retiring it means extracting that script to a file; until then
 * the set below keeps the exception to exactly one known page instead of
 * "anything that isn't the SPA".
 */
const LEGACY_HTML_CSP = HTML_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
const LEGACY_INLINE_PAGES = new Set(['login.html']);

function sendHtml(res, filePath) {
  res.setHeader('Content-Security-Policy', HTML_CSP);
  // SPA shell HTML must always be re-fetched so the latest auth-check JS
  // runs on every navigation. Without this, browser back/forward can
  // restore a cached page that bypasses the post-logout redirect.
  // Asset bundles (hashed filenames) keep their long-cache headers.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(filePath);
}

// Static files (favicon)
app.use('/public', express.static(join(__dirname, '..', 'public')));
app.use('/docs', express.static(join(__dirname, '..', 'docs'), {
  index: false,
  setHeaders(res, filePath) {
    // Hardened by default; login.html is the one remaining exception. v2.36.1
    // had to invert this — nine pre-SPA pages still carried inline script, so
    // the SPA shell was allowlisted and everything else got the loose policy.
    // Deleting those nine (v2.37.0) leaves login.html alone needing it, so the
    // default flips back to secure: a page added under docs/ from here on is
    // covered by script-src 'self'. That fails closed, which is only safe
    // because test/csp-policy.test.js fails CI on inline script in any page
    // this branch hardens — the break surfaces in review, not in production.
    if (filePath.endsWith('.html')) {
      const needsLegacy = LEGACY_INLINE_PAGES.has(basename(filePath))
        && !filePath.includes(`${sep}admin-app${sep}`);
      res.setHeader('Content-Security-Policy', needsLegacy ? LEGACY_HTML_CSP : HTML_CSP);
    }
  },
}));
app.get('/favicon.svg', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'favicon.svg')));
// Standard browser favicon auto-requests — redirect to the canonical SVG
for (const p of ['/favicon.ico', '/favicon.png', '/logo.svg', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/logo192.png', '/logo512.png']) {
  app.get(p, (_req, res) => res.redirect(301, '/favicon.svg'));
}

/**
 * RFC 9116 security.txt (v2.35.0) — the standard place a researcher looks to
 * report a vulnerability. Flagged as missing by a WAS scan; more to the point,
 * without it someone who finds a bug in your platform has no documented channel
 * and ends up guessing at an address or posting publicly.
 *
 * The contact is CONFIGURABLE, not baked in: AppCrane is self-hosted by
 * whoever runs it, so a hardcoded address would be wrong for every operator but
 * one. Set `security_contact` in Settings, or SECURITY_CONTACT in the
 * environment — a mailto:, https: form, or tel: URI per the RFC.
 *
 * Unset ⇒ 404. Publishing a security.txt pointing at an address nobody reads is
 * worse than not publishing one: it looks like a channel and silently isn't.
 */
app.get('/.well-known/security.txt', (req, res) => {
  let contact = process.env.SECURITY_CONTACT || '';
  if (!contact) {
    try {
      contact = getDb().prepare("SELECT value FROM settings WHERE key = 'security_contact'").get()?.value || '';
    } catch (_) { /* pre-init or unreadable — treat as unset */ }
  }
  contact = String(contact).trim();
  if (!contact) return res.status(404).type('text/plain').send('No security contact configured.\n');

  // Reject anything that isn't a plain single-line URI: the value lands in a
  // response body, so a newline could forge additional directives.
  if (!/^(mailto:|https:\/\/|tel:)[^\s<>"]{1,300}$/.test(contact)) {
    log.warn('[security.txt] security_contact is not a valid mailto:/https:/tel: URI — not serving');
    return res.status(404).type('text/plain').send('No security contact configured.\n');
  }

  // RFC 9116 requires Expires. Roll it a year ahead of *now* so the file never
  // goes stale — a past Expires makes the whole document non-conforming.
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const host = req.get('host');
  res.type('text/plain').send(
    `Contact: ${contact}\n` +
    `Expires: ${expires}\n` +
    'Preferred-Languages: en\n' +
    (host ? `Canonical: https://${host}/.well-known/security.txt\n` : '')
  );
});

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
// `application/scim+json` is listed alongside `application/json` because RFC 7644
// §3.1 registers it as the SCIM media type and both Okta and Entra send it on
// every POST/PUT/PATCH. express's default `type` is the exact string
// `application/json`, so without this the SCIM body was silently left unparsed —
// req.body arrived as {} and every provisioning write was refused as malformed.
// The list is exact on purpose: no `*/*` and no `application/*+json` wildcard, so
// nothing that is rejected today starts being parsed.
app.use(express.json({ limit: '50mb', type: ['application/json', 'application/scim+json'] }));
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
// '/api/notices' sits here alongside '/api/info' for the same reason: it
// carries platform-authored release notices that name no app and no user, and a
// breaking-change channel that goes dark on a box nobody has initialized yet is
// useless exactly when someone is deciding whether to deploy to it. The
// app-scoped variant (/api/apps/:slug/notices) is NOT listed — it is
// authenticated and per-app authorized, and pre-init there are no apps anyway.
const PUBLIC_PATHS = ['/api/info', '/api/notices', '/favicon.svg', '/favicon.ico', '/favicon.png', '/logo.svg', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/logo192.png', '/logo512.png', '/login', '/portal', '/api/identity/login', '/api/identity/verify', '/api/identity/logout', '/api/identity/me'];
app.use((req, res, next) => {
  // Settings GETs skip the setup guard so the login page of a not-yet-
  // initialized instance can still fetch auth_sso_only. This is NOT an
  // authorization decision: as of v2.38.0 the settings router gates every read
  // itself, per key (server/utils/settingsVisibility.js) — anonymous callers get
  // auth_sso_only and a 401 for everything else — and every write goes through
  // requireAuth + requirePlatformAdmin. All this carve-out does is let the
  // request reach that router before an admin account exists.
  const isPublicSettingsRead = req.method === 'GET' && req.path.startsWith('/api/settings');
  const isCrashPage = req.path.startsWith('/api/_crashed/');
  if (PUBLIC_PATHS.includes(req.path) || req.path.startsWith('/docs/') || isPublicSettingsRead || isCrashPage || req.method === 'OPTIONS') return next();

  const db = getDb();
  const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE role IN ('admin', 'platform_admin')").get().count > 0;
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
// Excludes platform endpoints that apps legitimately call from inside their
// iframe. v2.7.18: added /api/me and /api/mcp — without them the slug-fallback
// 307'd browser fetches from a deployed app's frontend back into the app's own
// prefix (request never reached the platform endpoint), making the documented
// `fetch('/api/me')` pattern unreachable from any per-app browser caller.
// v2.40.0: '/api/notices' joins the list for the same reason '/api/me' did — an
// app's own frontend is a legitimate caller ("show a banner when the platform
// announces a breaking change"), and without the exemption that fetch gets
// 307'd back into the app's own /{slug} prefix and never reaches the platform.
const APPCRANE_PASSTHROUGH = ['/api/identity', '/api/apps', '/api/info', '/api/notices', '/api/_crashed', '/api/me', '/api/directory', '/api/mcp', '/api/service', '/favicon.svg', '/docs'];
const APPCRANE_PAGE_SLUGS = new Set(['login', 'portal', 'dashboard', 'applications', 'users-page', 'audit-page', 'settings', 'docs', 'app', 'studio', 'appstudio']);
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

// v2.7.20: surface boot-time Caddy reload outcome so silent failures (which
// used to log.warn and otherwise vanish) are visible to anyone polling
// /api/info — the same endpoint already used to verify the deployed version.
// Populated by the post-listen reload block at the bottom of this file.
let caddyReloadStatus = { ok: null, at: null, error: null, restarted: false, unchanged: false };

// Public API endpoints (no auth)
app.get('/api/info', (req, res) => {
  const db = getDb();
  const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE role IN ('admin', 'platform_admin')").get().count > 0;
  // Version is no longer auth-gated. It already leaks through
  // /api/version-check, bundle filenames, GitHub releases, and the
  // sidebar's first /api/info call (which can race auth-state setup).
  // Hiding it here was net-negative for ops without buying any security.
  res.json({
    name: 'AppCrane',
    version: VERSION,
    status: adminExists ? 'ready' : 'needs_init',
    description: 'Self-service app hosting and deployment',
    docs: '/docs',
    dashboard: '/dashboard',
    mcp: '/api/mcp',
    // v2.40.0: a pointer and a count, not the notices themselves.
    //
    // /api/info is the universal poll — the installer's readiness probe, the
    // CLI's `crane doctor`, deployhub.json's declared health endpoint, the SPA
    // sidebar on every page load, and the 30-minute version check all hit it,
    // and every one of them wants a single field. Inlining multi-paragraph
    // notice bodies would put the full text on all of that traffic forever.
    // A count is what actually makes a notice discoverable — a poller sees a
    // non-zero number change without anyone having known to look for a new
    // endpoint — and costs ~40 bytes. The bodies live one fetch away.
    notices: { url: '/api/notices', count: globalNotices().length },
    caddy_reload_status: caddyReloadStatus,
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
app.get('/api/version-check', requireAuth, requirePlatformAdmin, async (req, res) => {
  const now = Date.now();
  // v2.6.10: `?force=1` bypasses the 5-min cache. The topbar pill's
  // manual click sends force=1 so a user-initiated check ALWAYS does
  // a real GitHub fetch — was hitting the cached old "latest" and
  // showing "already up to date" right after a real release landed.
  // Auto-poll (every 30 min from Layout.tsx) still uses the cache:
  // bandwidth-friendly when nothing's changed, and 30 min is well
  // past the cache TTL anyway.
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force && _cachedRemoteVersion && now - _lastVersionCheck < 5 * 60 * 1000) {
    const isNewer = compareVersions(_cachedRemoteVersion, VERSION) > 0;
    return res.json({ current: VERSION, latest: _cachedRemoteVersion, update_available: isNewer, cached: true });
  }
  try {
    const response = await fetch('https://raw.githubusercontent.com/gitayg/appCrane/main/package.json', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const remotePkg = await response.json();
      _cachedRemoteVersion = remotePkg.version;
      _lastVersionCheck = now;
      const isNewer = compareVersions(remotePkg.version, VERSION) > 0;
      res.json({ current: VERSION, latest: remotePkg.version, update_available: isNewer, cached: false });
    } else {
      res.json({ current: VERSION, latest: null, update_available: false, error: 'Could not fetch remote version' });
    }
  } catch (e) {
    res.json({ current: VERSION, latest: null, update_available: false, error: e.message });
  }
});

// Caddy reload endpoint (admin only)
import { requireAuth, requireAdmin, requirePlatformAdmin } from './middleware/auth.js';
import { reloadCaddy, generateCaddyfile } from './services/caddy.js';

// v2.21.31: an EXPLICIT admin reload always actually reloads. reloadCaddy()'s
// skip-if-unchanged compares the generated config to the file on disk, which
// says nothing about what the running Caddy process has loaded — so a drifted
// process could never be recovered through this endpoint (it just kept
// answering `unchanged: true`). Internal callers (deploy, app update) still get
// the optimization; pass ?force=0 here to opt back into it.
app.post('/api/caddy/reload', requireAuth, requireAdmin, async (req, res) => {
  const force = req.query.force !== '0';
  const result = await reloadCaddy({ force });
  res.json({ ...result, forced: force, caddyfile: generateCaddyfile() });
});

app.get('/api/caddy/config', requireAuth, requireAdmin, (req, res) => {
  res.type('text/plain').send(generateCaddyfile());
});

// The lowest Node major AppCrane supports. Kept in step with package.json's
// `engines` field and install.sh's NODE_MAJOR — all three say the same number.
const NODE_FLOOR = 22;

function selfUpdateDataDir() {
  return resolve(process.env.DATA_DIR || join(__dirname, '..', 'data'));
}

function pendingUpdateFile() {
  return join(selfUpdateDataDir(), 'self-update-pending.json');
}

function bootSentinelFile() {
  return join(selfUpdateDataDir(), 'boot-sentinel.json');
}

/**
 * If a pending self-update exists and the boot sequence just failed,
 * roll the working tree back to the previous SHA, npm install, and exit
 * so systemd restarts us on the rolled-back code. Hard cap of 3 attempts
 * (counter persisted to the pending file) so a doubly-broken state
 * doesn't loop forever.
 *
 * Returns nothing; either exits the process or returns to let the caller
 * crash with the original error.
 */
async function maybeAutoRollback(originalError) {
  const pendingPath = pendingUpdateFile();
  if (!existsSync(pendingPath)) {
    log.error('No pending self-update — cannot auto-rollback. Manual intervention required.');
    return;
  }
  let pending;
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  } catch (_) {
    log.error('Pending self-update file unreadable — cannot auto-rollback.');
    return;
  }
  if (pending.completed_at) {
    log.error('Pending update was already completed — boot failure is unrelated to a recent update. Cannot auto-rollback.');
    return;
  }
  if (!pending.previous_sha) {
    log.error(`Pending update lacks previous_sha (legacy format) — cannot auto-rollback. Manually: cd /path/to/appcrane && git reset --hard <sha-before-${pending.previous_version}> && npm install && systemctl restart appcrane`);
    return;
  }
  const attempts = pending.rollback_attempts || 0;
  if (attempts >= 3) {
    log.error(`Auto-rollback budget exhausted (${attempts} attempts on ${pending.previous_version} → ${pending.target_version}). Both versions failing. Manual intervention required.`);
    return;
  }

  log.error(`Triggering auto-rollback to ${pending.previous_version} @ ${pending.previous_sha.slice(0, 7)} (attempt ${attempts + 1}/3)`);
  try {
    const { execFileSync } = await import('child_process');
    const cwd = join(__dirname, '..');
    const gitOpts = { cwd, stdio: 'pipe', timeout: 30000 };

    // Persist the attempt BEFORE we do anything destructive so a crash
    // mid-rollback doesn't burn an attempt without recording it.
    writeFileSync(pendingPath, JSON.stringify({
      ...pending,
      rollback_attempts: attempts + 1,
      last_rollback_at: new Date().toISOString(),
      last_rollback_error: String(originalError?.message || originalError).slice(0, 500),
    }, null, 2));

    // Self-heal git's "dubious ownership" if uid drifts (mirrors the
    // self-update endpoint's defensive setup).
    try {
      execFileSync('git', ['config', '--global', '--add', 'safe.directory', cwd], gitOpts);
    } catch (_) { /* best-effort */ }

    execFileSync('git', ['fetch', 'origin'], gitOpts);
    execFileSync('git', ['reset', '--hard', pending.previous_sha], gitOpts);
    execFileSync('npm', ['install', '--omit=dev', '--prefer-offline'], {
      cwd, stdio: 'pipe', timeout: 120000,
    });

    log.error(`Auto-rollback to ${pending.previous_version} complete. Exiting for systemd restart.`);
    process.exit(0);
  } catch (rollbackErr) {
    log.error(`Auto-rollback ITSELF failed: ${rollbackErr.stderr?.toString?.() || rollbackErr.message}`);
    log.error('Both forward update and rollback failed — AppCrane is bricked. SSH in to recover.');
  }
}

// Self-update endpoint (admin only)
app.post('/api/self-update', requireAuth, requirePlatformAdmin, async (req, res) => {
  const cwd = join(__dirname, '..');
  try {
    // Refuse to restart while builds are in flight — interrupting docker build mid-stream
    // leaves orphan dangling layers that pruneOldImages can't clean up. Caller can pass
    // ?force=1 to override (e.g. if a build is genuinely stuck).
    if (!req.query.force) {
      const db = getDb();
      const inflight = db.prepare(
        "SELECT id, app_id, env FROM deployments WHERE status IN ('pending','building','deploying') LIMIT 5"
      ).all();
      if (inflight.length > 0) {
        return res.status(409).json({
          error: {
            code: 'BUILDS_IN_FLIGHT',
            message: `Refusing to self-update: ${inflight.length} deployment(s) currently building. Wait for them to finish or POST again with ?force=1.`,
            in_flight: inflight,
          },
        });
      }
    }

    // "Smart turn toward the upgrade": don't restart out from under a live MCP
    // agent. If an MCP request is in flight, or one ran very recently (the agent
    // is likely mid-turn), wait for the connection to go quiet, THEN proceed —
    // rather than either hard-refusing or cutting the agent off. Only give up
    // (409) if it never settles within the max wait. ?force=1 skips the wait;
    // ?wait=<seconds> overrides how long we'll drain (default 45s, max 300s).
    if (!req.query.force) {
      const { getMcpActivity } = await import('./services/mcpActivity.js');
      const IDLE_REQUIRED_MS = 10_000; // MCP is "quiet" after 10s with no calls
      const MAX_WAIT_MS = Math.min(300, Math.max(0, parseInt(req.query.wait, 10) || 45)) * 1000;
      const isBusy = (a) => a.inflight > 0 || a.idleMs < IDLE_REQUIRED_MS;
      const startedAt = Date.now();
      let act = getMcpActivity();
      if (isBusy(act)) {
        log.info(`Self-update: MCP active (inflight=${act.inflight}, idle=${act.idleMs}ms) — draining up to ${MAX_WAIT_MS / 1000}s before upgrade`);
        while (isBusy(act) && Date.now() - startedAt < MAX_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 1000));
          act = getMcpActivity();
        }
      }
      if (isBusy(act)) {
        return res.status(409).json({
          error: {
            code: 'MCP_ACTIVE',
            message: `Refusing to self-update: an MCP agent is still active (inflight=${act.inflight}, last call ${Math.round(act.idleMs / 1000)}s ago) and didn't go idle within ${MAX_WAIT_MS / 1000}s. Wait for it to finish, retry with a longer ?wait=<seconds>, or POST with ?force=1 to upgrade anyway.`,
            mcp: { inflight: act.inflight, idle_ms: act.idleMs },
          },
        });
      }
      if (Date.now() - startedAt > 500) {
        log.info(`Self-update: MCP drained after ${Math.round((Date.now() - startedAt) / 1000)}s — proceeding`);
      }
    }

    const { execFileSync, spawn } = await import('child_process');
    const { logAudit } = await import('./middleware/audit.js');

    const gitOpts = { cwd, stdio: 'pipe', timeout: 30000 };

    // Self-heal git's "dubious ownership" check that fires when the repo
    // directory's owner uid differs from the running process's uid (common
    // after manual deploys, container restarts, or VPS console git pulls).
    // Whitelist the cwd globally so future runs don't have to re-do this.
    try {
      execFileSync('git', ['config', '--global', '--add', 'safe.directory', cwd], gitOpts);
    } catch (_) {
      // Best-effort; if it fails we'll see a clearer error from `fetch` below.
    }

    // Capture the SHA we're rolling FROM before the reset, so the boot
    // sentinel can `git reset --hard <previous_sha>` if the new version
    // crashes on first boot. SHA is more reliable than version-tag (we
    // don't tag releases).
    const previousSha = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim();

    // v2.27.0: snapshot the DB + .env BEFORE anything destructive. Code
    // rollback (maybeAutoRollback) can undo a bad commit; it cannot undo a
    // damaged database or a clobbered ENCRYPTION_KEY — and losing that key
    // makes every stored secret permanently unreadable. Non-fatal: a failed
    // snapshot is reported, not a reason to block the upgrade.
    const { createPreUpdateSnapshot } = await import('./services/updateSnapshot.js');
    const snapshot = createPreUpdateSnapshot(cwd, { from: VERSION, sha: previousSha });

    execFileSync('git', ['-c', 'credential.helper=', 'fetch', 'origin'], gitOpts);

    // v2.55.2: the floor of the release being INSTALLED, read without checking
    // it out. NODE_FLOOR is a constant compiled into the running version, so
    // using it here asks the wrong question twice: it is the floor of the
    // release being replaced, and on a host whose updater predates the floor
    // entirely it does not exist at all. `git show origin/main:package.json`
    // answers from the incoming tree while the working tree is still untouched.
    let incomingFloor = NODE_FLOOR;
    try {
      const incomingPkg = JSON.parse(
        execFileSync('git', ['show', 'origin/main:package.json'], gitOpts).toString(),
      );
      const m = String(incomingPkg?.engines?.node || '').match(/(\d+)/);
      if (m) incomingFloor = Number(m[1]);
    } catch (e) {
      log.warn(`[self-update] could not read the incoming Node floor (${e.message}); using this release's floor of ${NODE_FLOOR}`);
    }

    // v2.51.0: bring the RUNTIME up before installing anything against it.
    // v2.55.2: and before the `git reset --hard` below, not after it.
    //
    // Refusing after the reset left the working tree ahead of node_modules with
    // no rollback record — the pending-update file that the boot sentinel reads
    // is written further down, past the npm install that never ran. So a host
    // that declined the upgrade was moved to the new code anyway and left one
    // restart away from booting it against the old dependencies. Ordered this
    // way, a refusal costs nothing: nothing has been touched yet.
    //
    // install.sh has always installed Node when the host is below the floor;
    // the updater never did, so a box provisioned under an older floor stayed
    // there through every update. Cosmetic until dependencies began declaring
    // `engines.node >= 22`: `npm install --omit=dev` installs them regardless,
    // and the failure surfaces later, at whatever code path first touches a
    // newer feature, on a host running dozens of apps.
    //
    // Deliberately NOT on the auto-rollback path above. That reinstalls the
    // PREVIOUS release, which by definition ran on this runtime — blocking it
    // would strand a host mid-failure with no way back.
    //
    // Deciding is separated from doing (services/nodeUpgrade.js) so the policy
    // — when is it safe to touch system packages on a live host? — is testable
    // without apt.
    {
      const { planNodeUpgrade, verifyUpgrade } = await import('./services/nodeUpgrade.js');
      const which = (bin) => {
        try {
          return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' }).toString().trim();
        } catch (_) { return ''; }
      };
      const plan = planNodeUpgrade({
        currentMajor: Number(process.versions.node.split('.')[0]),
        floor: incomingFloor,
        platform: process.platform,
        isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
        hasApt: !!which('apt-get'),
        nodePath: which('node'),
        skipEnv: process.env.APPCRANE_SKIP_NODE_UPGRADE,
      });

      if (plan.upgrade) {
        log.info(`[self-update] ${plan.message}`);
        for (const [bin, args] of plan.commands) {
          execFileSync(bin, args, {
            cwd, stdio: 'pipe', timeout: 300000,
            env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
          });
        }
        // Asked of the node now on PATH, not of this process: it keeps running
        // the binary it started with and would report the old version whatever
        // apt did.
        const installed = Number(execFileSync('node', ['-v'], { stdio: 'pipe' })
          .toString().trim().replace(/^v/, '').split('.')[0]);
        const verdict = verifyUpgrade(installed, incomingFloor);
        if (!verdict.ok) throw new Error(`Self-update aborted: ${verdict.message}`);
        log.info(`[self-update] ${verdict.message}`);
      } else if (plan.blocking) {
        // Refused, not warned. A host left on the previous release is in better
        // shape than one that installed dependencies its runtime cannot run —
        // and the rollback sentinel cannot undo an npm install that left
        // node_modules unusable.
        throw new Error(`Self-update aborted: ${plan.message}`);
      } else {
        log.debug(`[self-update] ${plan.message}`);
      }
    }

    // Only now is the working tree moved. Everything above is either read-only
    // or repairs the host; the first destructive step comes after the runtime
    // is known to support what is about to be installed.
    const pullOutput = execFileSync('git', ['reset', '--hard', 'origin/main'], gitOpts).toString().trim();

    execFileSync('npm', ['install', '--omit=dev', '--prefer-offline'], {
      cwd, stdio: 'pipe', timeout: 120000,
    });

    // Rebuild the admin SPA if studio-web/ source changed. Otherwise the
    // server runs new code while serving a stale UI bundle. Skip-if-unchanged
    // is gated by docs/admin-app/.built-from stamp file.
    try {
      const { ensureSpaBuilt } = await import('./services/spaBuilder.js');
      const spa = ensureSpaBuilt(cwd, { onLog: (m) => log.info(`[self-update] ${m}`) });
      if (spa.rebuilt === false && spa.reason === 'up-to-date') {
        log.info(`Self-update: SPA bundle up-to-date (hash=${spa.hash?.slice(0, 7)})`);
      } else if (spa.rebuilt) {
        log.info(`Self-update: SPA rebuilt (${spa.reason}) in ${spa.durationMs}ms`);
      } else {
        // Build failed but server install succeeded. Surface the error to
        // the operator without aborting the upgrade — server will boot on
        // new code with a (potentially stale) old bundle, which is still
        // better than a partially-installed-and-crashing process.
        log.error(`Self-update: SPA rebuild FAILED (${spa.reason}): ${spa.error}`);
      }
    } catch (e) {
      log.error(`Self-update: SPA rebuild step crashed: ${e.message}`);
    }

    const newPkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const targetVersion = newPkg.version;

    const dataDir = selfUpdateDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(pendingUpdateFile(), JSON.stringify({
      previous_version: VERSION,
      previous_sha: previousSha,
      target_version: targetVersion,
      started_at: new Date().toISOString(),
      pid: process.pid,
      snapshot: snapshot.ok ? { id: snapshot.id, dir: snapshot.dir, files: snapshot.files } : null,
      snapshot_error: snapshot.ok ? null : snapshot.error,
    }, null, 2));

    // v2.29.1: past this point the update has ALREADY been applied (git reset +
    // npm install are done). An unguarded throw here would jump to the catch,
    // answer 500 UPDATE_FAILED, and — worse — skip the exit below, leaving new
    // code on disk, old code in memory, and no restart. An audit write is never
    // worth inverting the outcome of a completed upgrade, so log and continue.
    try {
      logAudit(req.user?.id, null, 'self-update-triggered', {
        from: VERSION, to: targetVersion, git: pullOutput,
        snapshot: snapshot.ok ? snapshot.id : `FAILED: ${snapshot.error}`,
      });
    } catch (e) {
      log.error(`Self-update: audit write failed (update still applied): ${e.message}`);
    }
    log.info(`Self-update: ${VERSION} → ${targetVersion} (pulled ${pullOutput})`);

    res.json({
      message: 'Update pulled. Restarting...',
      git: pullOutput,
      version: targetVersion,
      // Report the restore point honestly — including when there ISN'T one, so
      // an operator is never left assuming a snapshot exists that doesn't.
      snapshot: snapshot.ok
        ? { id: snapshot.id, files: snapshot.files, bytes: snapshot.bytes }
        : { error: snapshot.error, warning: 'Upgrade proceeded WITHOUT a data restore point.' },
    });

    // Exit and let systemd Restart=always re-exec us.
    setTimeout(() => {
      log.info('Self-update: exiting for systemd restart');
      process.exit(0);
    }, 1000);
  } catch (e) {
    const detail = e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message;
    res.status(500).json({ error: { code: 'UPDATE_FAILED', message: detail } });
  }
});

// Self-update status — lets clients poll whether a triggered update actually landed.
/**
 * POST /api/self-update/restart — exit so systemd re-execs on the code on disk.
 *
 * The escape hatch for a host whose update landed the files but could not
 * finish. That state is reachable and self-inflicted: the updater lives inside
 * this process, so a box below the Node floor runs an updater with no runtime
 * step, its `git reset --hard` succeeds, and `npm install` is refused by
 * engine-strict. New code on disk, old code in memory.
 *
 * scripts/safe-boot.sh reconciles the runtime on the way up (v2.55.1), so the
 * only thing standing between that host and a working install is a restart —
 * and until now the only way to get one was ssh and `systemctl restart`, or
 * POSTing a config import, which restarts as a side effect of REPLACING THE
 * DATABASE. Neither is a restart button.
 *
 * Nothing is written and nothing is fetched. It exits 0; `Restart=always`
 * brings the process back, which is the entire mechanism. If AppCrane is not
 * running under a supervisor that restarts it, this stops the server — hence
 * the explicit confirm parameter rather than a bare POST.
 */
app.post('/api/self-update/restart', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (req.query.confirm !== '1') {
    return res.status(400).json({
      error: {
        code: 'CONFIRM_REQUIRED',
        message: 'This exits the process and relies on systemd (Restart=always) to bring it back. '
          + 'If AppCrane is not supervised, it will stay down. Repeat with ?confirm=1.',
      },
    });
  }

  // Same guard the self-update uses: a container mid-build does not survive the
  // build process being killed, and leaves dangling layers behind.
  if (!req.query.force) {
    const db = getDb();
    const inflight = db.prepare(
      "SELECT id, app_id, env FROM deployments WHERE status IN ('pending','building','deploying') LIMIT 5"
    ).all();
    if (inflight.length > 0) {
      return res.status(409).json({
        error: {
          code: 'BUILDS_IN_FLIGHT',
          message: `Refusing to restart: ${inflight.length} deployment(s) currently building. Wait, or repeat with ?force=1.`,
          in_flight: inflight,
        },
      });
    }
  }

  try {
    const { logAudit } = await import('./middleware/audit.js');
    logAudit(req.user?.id, null, 'server-restart', { from_version: VERSION });
  } catch (_) { /* an audit write is never a reason to refuse the restart */ }

  log.warn(`[restart] platform admin ${req.user?.email || req.user?.id} requested a process restart`);
  res.json({
    message: 'Restarting. The process exits now and the supervisor re-execs it on the code currently on disk.',
    from_version: VERSION,
  });
  // Delay so the response flushes before the process goes away.
  setTimeout(() => {
    log.warn('[restart] exiting for supervisor restart');
    process.exit(0);
  }, 1200);
});

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
app.use('/api', apiRateLimit);
app.use('/api/auth', authRoutes);
app.use('/api/auth/oidc', oidcRoutes);
app.use('/api/auth/saml', samlRoutes);
app.use('/api/auth/scim', scimAdminRouter);
app.use('/api/scim/v2', scimRoutes);
// Platform notices. Mounted at the bare '/api' and BEFORE every router that
// installs a pathless `router.use(requireAuth)` — appsRoutes (line ~75 of
// apps.js), userMcpKeysRoutes, logsRoutes, monitoringRoutes. Each of those
// 401s any /api/* request that merely reaches it, whether or not the path is
// theirs, and that ordering trap has already broken two anonymous endpoints in
// this codebase. GET /api/notices must answer without credentials, and
// GET /api/apps/:slug/notices must reach its own requireAppAccess rather than
// appsRoutes' blanket auth, so this goes first. noticesRoutes itself installs
// no router-level middleware, so anything it doesn't match falls straight
// through to the routers below.
app.use('/api', noticesRoutes);          // /api/notices, /api/apps/:slug/notices
app.use('/api/apps', appsRoutes);
app.use('/api/apps', deployRoutes);     // /api/apps/:slug/deploy/:env
app.use('/api/apps', envVarsRoutes);     // /api/apps/:slug/env/:env
app.use('/api/apps', healthRoutes);      // /api/apps/:slug/health/:env
app.use('/api/apps', backupsRoutes);     // /api/apps/:slug/backup/:env
app.use('/api/apps', notificationsRoutes); // /api/apps/:slug/notifications
// /api/apps/:slug/app-roles — the roles an app defines for ITSELF. Distinct
// from /api/apps/:slug/roles (usersRoutes, mounted at line ~854), which sets
// AppCrane's own per-app tier. Safe anywhere among the /api/apps routers: this
// one installs no router-level middleware, and no earlier router registers a
// pattern that would swallow /:slug/app-roles.
app.use('/api/apps', appRolesRoutes);
app.use('/api/catalog', catalogRoutes);  // Curated self-hostable app catalogue (requireAuth — every logged-in user)
// Mount identity FIRST so its routes don't get caught by other middleware
app.use('/api/identity', identityRoutes);
app.use('/api/enhancements', enhancementsRoutes); // Enhancement requests (Bearer auth, must be before logsRoutes)
app.use('/api/service', serviceApiRoutes); // v2.8.0 internal app service API (service-token auth, internal-only)
app.use('/api/appstudio', appstudioRoutes); // AppStudio plan/code/build pipeline
app.use('/api/skills', skillsRoutes);       // Skill bundles loaded by all CLI agents via ~/.claude/skills/
app.use('/api/webhooks', webhooksRoutes); // Public webhook endpoint (no auth — must be before logsRoutes)
app.use('/api/presence', presenceRoutes); // Bearer auth (identity) — must be before logsRoutes (which installs X-API-Key requireAuth at /api)
app.use('/api/ask', askRoutes);           // Ask Claude (Bearer auth)
app.use('/api/plan', planRoutes);         // Plan panel (Bearer auth)
app.use('/api/coder', coderRoutes);       // AppCrane Studio (API key + Bearer auth)
app.use('/api/agents', agentsRoutes);     // AIDE-compatible Studio API
app.use('/api/mcp', mcpRoutes);          // Model Context Protocol endpoint (JSON-RPC + admin catalog)
// MUST precede every router mounted at the bare '/api' — userMcpKeysRoutes,
// logsRoutes and monitoringRoutes each do a pathless `router.use(requireAuth)`,
// so from their mount point down they 401 any /api/* request that reaches them,
// whether or not it is theirs. That swallowed GET /api/settings/auth_sso_only,
// which the login page fetches WITHOUT credentials to decide whether to render
// the password form: Login.tsx read `value` off the 401 body, got undefined,
// and left ssoOnly false — so an SSO-only instance still showed the password
// form. Anonymous settings GETs are also deliberately let past the not-yet-
// initialized guard above, which is what made the 401 look like a real answer.
//
// Safe to hoist ONLY because settingsRoutes now carries its own per-key auth
// (v2.38.0). Before that, this accidental ordering WAS its protection, and
// moving it would have made every setting world-readable.
app.use('/api/settings', settingsRoutes); // General settings (branding, etc.)

// v2.7.17: meRoutes MUST come before userMcpKeysRoutes. userMcpKeys's
// router.use(requireAuth) runs on every request entering it (including
// /api/me), and requireAuth only accepts Bearer / X-API-Key — so a
// cookie-only request to /api/me was 401'd before me.js's cookie handler
// could run. Mounting meRoutes first lets GET /api/me match meRoutes,
// and /api/me/mcp-keys/* still falls through to userMcpKeysRoutes
// (meRoutes only matches GET /me).
app.use('/api', meRoutes);               // /api/me — proxied-app identity endpoint (cookie/Bearer/X-API-Key)
app.use('/api', userMcpKeysRoutes);      // /api/me/mcp-keys — personal MCP keys
app.use('/api/files', filesRoutes);      // /api/files/staged — staged uploads for MCP-E
app.use('/api/github-service', githubServiceRoutes); // service-account config + verify (admin)
app.use('/api/apps', whatsNewRoutes);     // /api/apps/:slug/whats-new — per-user version dialog state
app.use('/api/whats-new', platformWhatsNewRoutes); // /api/whats-new/platform — AppCrane update dialog (platform admins)

app.use('/api', logsRoutes);             // /api/audit, /api/apps/:slug/audit
app.use('/api', monitoringRoutes);       // /api/server/health
app.use('/api/users', usersRoutes);
app.use('/api/apps', webhooksRoutes);     // /api/apps/:slug/webhook config
app.use('/api/apps', usersRoutes);        // /api/apps/:slug/roles, /api/apps/:slug/identity/users (admin)
app.use('/api/config', configRoutes);     // Instance config export/import (migration)

// Login page
// When the in-iframe SSO step targets an app with custom frame_ancestors, drop
// the global X-Frame-Options + emit a per-app frame-ancestors CSP so the login
// step renders inside exactly the embedders an admin listed for that app.

// Derive an embeddable app's admin-configured frame_ancestors from a login/SSO
// `redirect` target (e.g. /snc, /snc-sandbox, /snc/…). Returns the policy
// string, or null when the redirect doesn't resolve to an app that opted into
// embedding.
function frameAncestorsForRedirect(redirectRaw) {
  const m = String(redirectRaw || '').match(/^\/([a-z][a-z0-9-]*)/);
  if (!m) return null;
  const slug = m[1].replace(/-sandbox$/, '');
  try {
    const db = getDb();
    const row = db.prepare('SELECT frame_ancestors FROM apps WHERE slug = ?').get(slug);
    if (!row) return null; // redirect isn't a real app → keep the SAMEORIGIN lock
    // Merge the per-app policy with the platform same-site default (if enabled),
    // so the in-iframe login step is frameable by exactly what the app content is.
    return mergeAncestors(platformEmbedAncestors(db), row.frame_ancestors);
  } catch (_) { return null; }
}

// Relax the frame headers for an SSO bounce whose redirect targets an
// embeddable app: drop X-Frame-Options and emit frame-ancestors. Returns true
// when applied. No-op (false) otherwise, so the global SAMEORIGIN stands for
// the ordinary dashboard. v2.24.5: the SSO login step now happens in the SPA
// (/applications), so this must run there too — not just on the legacy login
// page — or the in-iframe /login → /applications bounce lands on a
// SAMEORIGIN-locked SPA shell and the frame comes up blank.
// `baseCsp` lets the legacy login page keep its weaker script-src while every
// other caller gets the hardened default (v2.36.0).
function applyEmbedHeaders(req, res, baseCsp = HTML_CSP) {
  const fa = frameAncestorsForRedirect(req.query.redirect);
  if (!fa) return false;
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `${baseCsp}; frame-ancestors ${fa}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  return true;
}

// docs/login.html carries a large inline <script>, so it — and only it — is
// served with LEGACY_HTML_CSP. Both branches must use it: the embed path
// sets the header itself, and the plain path would otherwise inherit the
// hardened HTML_CSP from sendHtml() and blank the page.
function loginHandler(req, res) {
  const loginPage = join(__dirname, '..', 'docs', 'login.html');
  if (applyEmbedHeaders(req, res, LEGACY_HTML_CSP)) return res.sendFile(loginPage);
  res.setHeader('Content-Security-Policy', LEGACY_HTML_CSP);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(loginPage);
}
// v2.5.14: collapse the dual-login UX. /login and /portal forward to
// /applications, which renders the SPA's <Login> when unauthenticated.
// The SPA handles the SSO query params (`oidc_token`, `sso_error`,
// `saml_error`, `redirect`) that docs/login.html used to.
//
// loginHandler (above) is kept for any iframe-embedded SSO flow that
// needs the custom-frame-ancestors CSP — exposed at /login-legacy.
// Once we confirm SSO works through the SPA, this can be deleted.
// v2.33.0: sign-in lands on /launch — the app picker — rather than
// /applications (the Manage table). /launch already renders the SPA's <Login>
// when unauthenticated, exactly as /applications did, so this only changes
// where you arrive AFTER authenticating: the tiles you can open, which is the
// first thing most users want. Query string is preserved so the SSO
// ?oidc_token=… / ?redirect=… handoff still works.
// v2.35.0: strip an unsafe `redirect` before forwarding it. The SPA now
// validates it too (utils/safeRedirect.ts), but this endpoint is what a
// phishing link actually targets — `/login?redirect=//attacker.com` — and it
// should not echo a cross-origin target back into the next URL at all.
// `//host` and `/\host` are absolute cross-origin URLs that merely begin with
// a slash, which is what defeated the original startsWith('/') check.
function forwardToLaunch(req, res) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  let out = qs;
  if (qs) {
    const params = new URLSearchParams(qs.slice(1));
    const r = params.get('redirect');
    // v2.38.0: was an inline regex here — a THIRD copy of the rule, and it had
    // already drifted: it also rejected \s, so a legitimate deep link containing
    // a space (`?redirect=/apps/foo?q=a+b`, which Express decodes to a real
    // space) passed the SSO callbacks and was then silently dropped here and
    // logged as an attack. Now that the callbacks actually forward deep links
    // again, that drift is user-visible. Share the module instead — the whole
    // finding was copies of a check that each looked correct in isolation.
    if (r !== null && !isSafeRedirect(r)) {
      log.warn(`[login] dropped unsafe redirect target: ${r.slice(0, 120)}`);
      params.delete('redirect');
      const rest = params.toString();
      out = rest ? `?${rest}` : '';
    }
  }
  res.redirect(302, '/launch' + out);
}
app.get('/login',  forwardToLaunch);
app.get('/portal', forwardToLaunch);
app.get('/login-legacy', loginHandler);

// Admin SPA — all admin routes served by the React admin-app bundle
// Static marketing page for RAISEME (the managed AI-security app hosted on this platform).
app.get('/raiseme', (req, res) => sendHtml(res, join(__dirname, '..', 'public', 'raiseme.html')));

const adminSpa = join(__dirname, '..', 'docs', 'admin-app', 'index.html');

// Serve the admin SPA shell, frameable when the request is an SSO bounce whose
// `redirect` targets an app that opted into embedding (frame_ancestors set).
// This is the render target of the /login → /applications bounce, so it's where
// the in-iframe SSO/login step actually paints — it must carry the per-app
// frame-ancestors, or a cross-origin embed of an SSO-gated app stays blank.
function sendAdminSpa(req, res) {
  if (applyEmbedHeaders(req, res)) return res.sendFile(adminSpa);
  sendHtml(res, adminSpa);
}

app.get('/dashboard', (req, res) => sendHtml(res, adminSpa));
app.get('/applications', sendAdminSpa);
app.get('/users-page', (req, res) => sendHtml(res, adminSpa));
app.get('/audit-page', (req, res) => sendHtml(res, adminSpa));
app.get('/enhancements-page', (req, res) => sendHtml(res, adminSpa));
// AppStudio collapsed in v1.27.38: Requests + Builders are top-level
// SPA routes; the React router redirects /appstudio → /requests.
app.get('/requests', (req, res) => sendHtml(res, adminSpa));
// v2.16.0: personal "My Requests" view (any signed-in user, see + delete own).
app.get('/my-requests', (req, res) => sendHtml(res, adminSpa));
app.get('/builders', (req, res) => sendHtml(res, adminSpa)); // legacy — SPA redirects to /requests
app.get('/appstudio', (req, res) => sendHtml(res, adminSpa));
app.get('/settings', (req, res) => sendHtml(res, adminSpa));
// v2.62.1: the catalogue shipped in v2.61.0 with a nav entry but no server
// route. Clicking the entry worked, because React Router handles that
// client-side and never asks the server — but loading /catalog directly, or
// refreshing while on it, fell through every route here to the API 404 and
// showed the user raw JSON. Every SPA path needs a line in this block; there is
// no catch-all, deliberately, so that an app slug is never shadowed by a typo'd
// SPA route. test/spa-routes.test.js now fails when a route is added to the SPA
// and not to this list.
app.get('/catalog', (req, res) => sendHtml(res, adminSpa));
// Found by the same test: /skills is a client-side redirect to /settings#skills,
// but a direct load never reaches React to be redirected.
app.get('/skills', (req, res) => sendHtml(res, adminSpa));
app.get('/mcp', (req, res) => sendHtml(res, adminSpa));
app.get('/studio', (req, res) => res.redirect(301, '/appstudio'));
app.get('/studio/*splat', (req, res) => res.redirect(301, '/appstudio'));
app.get('/coder', (req, res) => res.redirect(301, '/studio')); // legacy redirect

// App manager (app user)
app.get('/app', (req, res) => sendHtml(res, adminSpa));

// v2.13.0: launcher merged into the nav — apps open inline at /launch/:slug,
// owner self-service at /manage. Serve the SPA on direct nav / refresh / Back
// (otherwise these single-segment paths fall through to the app-slug proxy).
// sendAdminSpa (not sendHtml): /launch is now the sign-in landing target, so
// it must carry the per-app frame-ancestors headers that make the in-iframe
// SSO step render — the v2.24.5 fix, which previously only had to cover
// /applications because that was where /login bounced to.
app.get('/launch', sendAdminSpa);
app.get('/launch/*splat', (req, res) => sendHtml(res, adminSpa));

// Root redirects to login
app.get('/', (req, res) => res.redirect('/login'));

// Docs page (now part of admin SPA)
app.get('/docs', (req, res) => sendHtml(res, adminSpa));

// v2.5.24: agent guides are MCP-only. Both /agent-guide (legacy) and an
// /api/guides/:topic HTTP endpoint were considered and rejected — the
// content is for agents operating through MCP, not for humans reading
// docs. Agents call appcrane_get_guide(topic="onboarding"|"operations")
// to fetch from server/services/guides/. No HTTP surface, no curl path.

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
  log.info(`  AppCrane v${VERSION} - Self-service app hosting and deployment`);
  log.info(`  API:       http://${HOST}:${PORT}`);
  log.info(`  Dashboard: http://${HOST}:${PORT}/dashboard`);
  log.info(`  Docs:      http://${HOST}:${PORT}/docs`);
  log.info('');

  // v2.50.0: the platform's Node floor, checked where an operator will see it.
  //
  // install.sh provisions the baseline, but it only upgrades a host that is
  // BELOW it — and self-update is `git reset --hard` + `npm install`, which
  // never touches the runtime. So a box installed when the floor was 20 stays
  // on 20 through every update, and nothing said so: package.json declared no
  // `engines` at all, so npm did not even warn when a dependency needed 22.
  //
  // A warning, not an exit. Refusing to boot would take a running platform down
  // on upgrade, which is a worse failure than the mismatch it reports — and the
  // mismatch is usually harmless right up until the moment it is not. Loud, on
  // every boot, is enough to get it fixed on purpose rather than at 3am.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < NODE_FLOOR) {
    log.warn(`  ⚠ Node ${process.versions.node} is below AppCrane's supported floor (>=${NODE_FLOOR}).`);
    log.warn(`    Dependencies now declare engines.node >=${NODE_FLOOR}; npm will install them anyway and they may`);
    log.warn('    fail at runtime rather than at install. Upgrade the host runtime:');
    log.warn(`      curl -fsSL https://deb.nodesource.com/setup_${NODE_FLOOR}.x | sudo bash - && sudo apt-get install -y nodejs`);
    log.warn('    Node 20 left long-term support in April 2026 and receives no security patches.');
    log.warn('');
  }

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
  } catch (e) {
    log.warn('Boot sentinel write failed: ' + e.message);
  }

  // First run check — initialize DB (which runs migrations). If migrations
  // fail AND a pending self-update is present, that's almost certainly a bad
  // release that just landed; auto-rollback to the previous SHA and let
  // systemd restart us on the working version. The reconcile of the pending
  // file moves AFTER this point so 'success: true' is only recorded when
  // the DB is genuinely healthy.
  let db;
  try {
    const { getDb } = await import('./db.js');
    db = getDb();
  } catch (e) {
    log.error(`DB initialization failed during boot: ${e.message}`);
    if (e.stack) log.error(e.stack);
    await maybeAutoRollback(e);
    // If maybeAutoRollback returned without exiting, no rollback was attempted.
    // Bail loudly so systemd doesn't restart us in a tight loop.
    process.exit(1);
  }

  // Reconcile a pending self-update — only AFTER DB is healthy, otherwise
  // we'd mark a broken release "success: true" before its migrations have
  // even run.
  try {
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
        if (success && info.previous_version && info.previous_version !== VERSION) {
          log.info(`Self-update complete: ${info.previous_version} → ${VERSION}`);
        }
      }
    }
  } catch (e) {
    log.warn('Pending self-update reconcile failed: ' + e.message);
  }

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    log.warn('No users found. Initialize with: POST /api/auth/init');
    log.warn('Or run: crane init');
  }

  // v2.5.13: backfill app_user_roles owners for apps created before
  // v2.5.12 (when the create-paths started writing the owner row). Done
  // as a tolerant runtime task instead of a SQL migration so a hiccup
  // doesn't tank boot — the previous attempt (migration 055) caused a
  // 502 on self-update because boot rolled back when the migration
  // tripped on edge-case data.
  try {
    const { backfillAppOwners } = await import('./services/ownerBackfill.js');
    backfillAppOwners();
  } catch (e) {
    log.warn(`[owner-backfill] startup hook failed (continuing): ${e.message}`);
  }

  // Boot-time SPA freshness check. Catches operators who pulled new server
  // code (manual `git pull` + restart, no /api/self-update) without
  // rebuilding the admin bundle. By default we just warn so a misbuild
  // doesn't keep the server from booting; opt into auto-rebuild via
  // APPCRANE_SPA_AUTOBUILD=1 in the systemd unit env.
  try {
    const { ensureSpaBuilt } = await import('./services/spaBuilder.js');
    const force = process.env.APPCRANE_SPA_AUTOBUILD === '1';
    const repoDir = join(__dirname, '..');
    if (force) {
      const spa = ensureSpaBuilt(repoDir, { onLog: (m) => log.info(`[boot] ${m}`) });
      if (spa.rebuilt) {
        log.info(`Boot: SPA rebuilt (${spa.reason}) in ${spa.durationMs}ms`);
      } else if (spa.reason !== 'up-to-date') {
        log.warn(`Boot: SPA rebuild attempted but failed: ${spa.error}. Serving existing bundle.`);
      }
    } else {
      // Quick stamp check, no build.
      const { execFileSync } = await import('child_process');
      let sourceHash = null;
      try {
        sourceHash = execFileSync(
          'git', ['-C', repoDir, 'log', '-1', '--format=%H', '--', 'studio-web'],
          { stdio: 'pipe', timeout: 5000 }
        ).toString().trim();
      } catch (_) {}
      let stampHash = null;
      const stampPath = join(repoDir, 'docs', 'admin-app', '.built-from');
      try { stampHash = readFileSync(stampPath, 'utf8').trim(); } catch (_) {}
      if (sourceHash && stampHash && sourceHash !== stampHash) {
        log.warn(
          `Admin SPA bundle may be stale: source=${sourceHash.slice(0, 7)} ` +
          `stamp=${stampHash.slice(0, 7)}. Run \`cd studio-web && npm run build:admin\` ` +
          `or set APPCRANE_SPA_AUTOBUILD=1 in the systemd unit env to auto-rebuild on boot.`
        );
      }
    }
  } catch (e) {
    log.warn('SPA freshness check skipped: ' + e.message);
  }

  // Mark orphaned in-flight deployments as failed
  const orphaned = db.prepare(`
    UPDATE deployments
    SET status = 'failed', finished_at = datetime('now'),
        log = COALESCE(log || char(10), '') || '[Deployment interrupted by service restart]'
    WHERE status IN ('deploying', 'building', 'pending')
  `).run();
  if (orphaned.changes > 0) {
    log.warn(`Marked ${orphaned.changes} orphaned deployment(s) as failed (interrupted by restart)`);
  }

  // Wipe any leftover per-app shared containers + workspaces from a prior
  // process. Must run BEFORE coder session orphan recovery so the latter
  // sees a clean slate to mark sessions paused against.
  try {
    const { recoverOrphans: recoverAppContainers } = await import('./services/builder/appContainer.js');
    recoverAppContainers();
  } catch (e) {
    log.warn('App container orphan cleanup skipped: ' + e.message);
  }

  // Recover any coder sessions that were active when the server last restarted
  try {
    const { recoverOrphans } = await import('./services/builder/builderSession.js');
    recoverOrphans();
  } catch (e) {
    log.warn('Coder orphan recovery skipped: ' + e.message);
  }

  // Sweep stale per-call skills runtime dirs (24h+) left behind by killed processes.
  try {
    const { sweepStaleRuntimes } = await import('./services/skills.js');
    sweepStaleRuntimes();
  } catch (_) {}

  // Start health checker
  try {
    const { startHealthChecker } = await import('./services/healthChecker.js');
    startHealthChecker();

    if (process.env.ANTHROPIC_API_KEY) {
      const { startWorker } = await import('./services/appstudio/worker.js');
      startWorker();
    }

    // GitHub PR poller — closes the request lifecycle (Closes appcrane#N).
    // Outbound only, safe in firewalled installs. Set APPCRANE_PR_POLL_DISABLED=1
    // to skip if you don't want it.
    if (process.env.APPCRANE_PR_POLL_DISABLED !== '1') {
      const { startGithubPoller } = await import('./services/githubPoller.js');
      startGithubPoller();
    }

    // Per-user GitHub MCP container manager — spawns github-mcp-server on
    // demand when an MCP client passes X-Github-Token, idle-reaps after
    // settings.github_mcp_idle_timeout. Set APPCRANE_GH_MCP_DISABLED=1 to
    // skip (for envs without docker).
    if (process.env.APPCRANE_GH_MCP_DISABLED !== '1') {
      const { startContainerManager } = await import('./services/githubMcpContainers.js');
      startContainerManager();
    }
  } catch (e) {
    log.warn('Health checker startup deferred');
  }

  // Reload Caddy on startup so config changes (e.g. after self-update) take effect.
  // v2.7.20: log.error (not warn) on failure + record outcome in
  // caddyReloadStatus so /api/info surfaces it. Silent boot-time reload
  // failures were the foot-gun behind v2.7.19's "binary updated but Caddyfile
  // never regenerated" symptom — operators saw `/api/info` happily reporting
  // the new version while the live config was still the old one.
  try {
    const { reloadCaddy } = await import('./services/caddy.js');
    const result = await reloadCaddy();
    const at = new Date().toISOString();
    if (result.mock) {
      log.info('Caddy config generated (mock mode)');
      caddyReloadStatus = { ok: true, at, mock: true };
    } else if (result.success) {
      log.info(`Caddy reloaded on startup${result.unchanged ? ' (unchanged)' : ''}${result.restarted ? ' (escalated to restart)' : ''}`);
      caddyReloadStatus = { ok: true, at, unchanged: !!result.unchanged, restarted: !!result.restarted, error: null };
    } else {
      log.error('Caddy reload on startup FAILED — live config is stale: ' + result.error);
      caddyReloadStatus = { ok: false, at, error: result.error || 'unknown', unchanged: false, restarted: false };
    }
  } catch (e) {
    log.error('Caddy reload on startup THREW — live config is stale: ' + e.message);
    caddyReloadStatus = { ok: false, at: new Date().toISOString(), error: e.message, unchanged: false, restarted: false };
  }

  // v2.7.26: start the cron scheduler. Reads enabled rows from app_cron_jobs
  // every minute and `docker exec`s due jobs against the app's container.
  // Failure here is logged but boot continues — cron jobs are nice-to-have,
  // they shouldn't block the main API from coming up.
  try {
    const { startCronScheduler } = await import('./services/cronScheduler.js');
    startCronScheduler();
  } catch (e) {
    log.error('Cron scheduler failed to start: ' + e.message);
  }

  // v2.8.0: start the email queue worker. Drains email_queue, sends via Graph
  // (or SMTP), retries with backoff, dead-letters to the platform admin.
  // Failure here is logged but boot continues.
  try {
    const { startEmailWorker } = await import('./services/emailQueue.js');
    startEmailWorker();
  } catch (e) {
    log.error('Email worker failed to start: ' + e.message);
  }

  // v2.25.2: probe platform integration credentials (Graph mail secret, GitHub
  // service-account PAT) every 15m and email platform admins when one fails.
  try {
    const { startCredentialChecker } = await import('./services/credentialChecker.js');
    startCredentialChecker();
  } catch (e) {
    log.error('Credential checker failed to start: ' + e.message);
  }

  // v2.14.2: daily digest to app owners of requests awaiting their action.
  try {
    const { startRequestDigestScheduler } = await import('./services/requestDigest.js');
    startRequestDigestScheduler();
  } catch (e) {
    log.error('Request-digest scheduler failed to start: ' + e.message);
  }

  // v2.21.8: sample per-app CPU/memory into metrics_history for Manage charts.
  try {
    const { startMetricsSampler } = await import('./services/metricsSampler.js');
    startMetricsSampler();
  } catch (e) {
    log.error('Metrics sampler failed to start: ' + e.message);
  }

  // v2.21.9: nightly off-site (S3) backup — no-op until configured in Settings.
  try {
    const { startBackupScheduler } = await import('./services/backupScheduler.js');
    startBackupScheduler();
  } catch (e) {
    log.error('Backup scheduler failed to start: ' + e.message);
  }

  // v2.52.0: daily dependency scan of every hosted app, then the digest email.
  // Report-only — it never blocks a deploy — and the daily pass is the half
  // that matters: it catches an advisory published for code that was already
  // deployed and has not changed since.
  try {
    const { startVulnScheduler } = await import('./services/vulnDigest.js');
    startVulnScheduler();
  } catch (e) {
    log.error('Vulnerability scan scheduler failed to start: ' + e.message);
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
