import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin, requirePlatformAdmin, requireAppAccess } from '../middleware/auth.js';
import { getSystemInfo, formatBytes } from '../services/platform.js';
import { getPortsForSlot } from '../services/portAllocator.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/dashboard/app-cpu (v2.31.0) — per-app CPU over the last 7 days,
 * shaped exactly like /api/dashboard/app-activity so the dashboard can render
 * it with the same chart.
 *
 * Sandbox and production are COMBINED: an app's cost to the box is what both
 * of its containers burn together, and that is the number worth watching on a
 * 2-core host where a saturated CPU starves Caddy and takes the site down.
 *
 * Aggregation is average-per-env-per-day, then summed across envs — i.e. "the
 * average total CPU this app was using that day". Averaging the two envs
 * together instead would halve an app whose sandbox is idle, which is exactly
 * backwards for spotting a hog.
 *
 * Source is metrics_history, sampled every 5 minutes with 7-day retention
 * (metricsSampler.js), so the window here matches what is actually retained.
 */
router.get('/dashboard/app-cpu', requireAdmin, (req, res) => {
  const db = getDb();

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const rows = db.prepare(`
    SELECT slug, name, day, SUM(env_avg) AS cpu
    FROM (
      SELECT a.slug              AS slug,
             a.name              AS name,
             date(m.recorded_at) AS day,
             m.env               AS env,
             AVG(m.cpu_percent)  AS env_avg
      FROM metrics_history m
      JOIN apps a ON a.id = m.app_id
      WHERE m.recorded_at >= date('now', '-6 days')
      GROUP BY a.id, day, m.env
    )
    GROUP BY slug, day
  `).all();

  const byApp = {};
  for (const r of rows) {
    if (!byApp[r.slug]) {
      byApp[r.slug] = { slug: r.slug, name: r.name, counts: Object.fromEntries(days.map(d => [d, 0])) };
    }
    // One decimal: CPU percent is a float, and whole numbers would render
    // every sub-1% app as a flat zero line.
    byApp[r.slug].counts[r.day] = Math.round((r.cpu || 0) * 10) / 10;
  }

  const apps = Object.values(byApp)
    .map(a => ({ slug: a.slug, name: a.name, counts: days.map(d => a.counts[d] ?? 0) }))
    // Busiest first, so the legend colours track the lines that matter.
    .filter(a => a.counts.some(v => v > 0))
    .sort((x, y) => Math.max(...y.counts) - Math.max(...x.counts));

  res.json({ days, apps });
});

/**
 * GET /api/credentials/health (v2.25.3) — platform integration credential
 * status for the dashboard banner. Reads the checker's persisted state
 * (settings.credcheck_state) and returns any currently-failing credential.
 * platform_admin only — this is sensitive operational detail (which integration
 * is down), deliberately NOT surfaced on the public /api/info. Closes the gap
 * where a dead Graph mail token can't email its own failure alert.
 *
 * `href` (added alongside the existing `fix` breadcrumb) is the clickable route
 * to the page that repairs the credential, so the banner is one click from the
 * fix instead of asking a paged admin to hunt for "Settings → GitHub". It is
 * OPTIONAL: state rows written by an older checker (or by a checker that could
 * not build a URL) carry no href, and the field is then omitted entirely rather
 * than sent as null — the banner falls back to plain `fix` text.
 */

/**
 * The banner renders this straight into an <a href>. The value is read back out
 * of the settings table, so a `javascript:`/`data:` string written there — by a
 * future bug or by anyone who can write settings — would run in a platform
 * admin's session on click. Allow only a same-origin path or an http(s) URL.
 *
 * Also rejects a host of literally "undefined"/"null": the href is built from
 * CRANE_DOMAIN, which is frequently unset, and `https://undefined/settings` is
 * a dead link that looks like a real one.
 */
function safeCredentialHref(value) {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith('//')) return null;              // protocol-relative → off-origin
  if (href.startsWith('/')) return href;               // same-origin path
  const m = /^https?:\/\/([^/?#]+)/i.exec(href);
  if (!m) return null;
  return /^(undefined|null)(:\d+)?$/i.test(m[1]) ? null : href;
}

router.get('/credentials/health', requirePlatformAdmin, (req, res) => {
  const db = getDb();
  let state = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'credcheck_state'").get();
    if (row?.value) state = JSON.parse(row.value);
  } catch (_) { /* treat unreadable state as "nothing failing" */ }
  const failing = Object.entries(state)
    .filter(([, s]) => s && s.ok === false)
    .map(([name, s]) => {
      const entry = { name, since: s.since || null, error: s.error || null, fix: s.fix || null };
      const href = safeCredentialHref(s.href);
      if (href) entry.href = href;
      return entry;
    });
  res.json({ ok: failing.length === 0, failing });
});

/**
 * GET /api/server/health - Server health overview (admin)
 */
router.get('/server/health', requireAdmin, (req, res) => {
  const db = getDb();
  const system = getSystemInfo();

  const apps = db.prepare('SELECT * FROM apps').all();
  const appCount = apps.length;

  // Count running/down apps
  const healthStates = db.prepare('SELECT * FROM health_state').all();
  const downCount = healthStates.filter(h => h.is_down).length;
  const healthyCount = healthStates.filter(h => h.last_status === 200).length;

  // Recent deploys
  const recentDeploys = db.prepare(`
    SELECT d.*, a.slug, u.name as deployed_by_name
    FROM deployments d
    JOIN apps a ON d.app_id = a.id
    LEFT JOIN users u ON d.deployed_by = u.id
    ORDER BY d.started_at DESC LIMIT 10
  `).all();

  // Recent audit events
  const recentAudit = db.prepare(`
    SELECT al.*, u.name as user_name, a.slug as app_slug
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN apps a ON al.app_id = a.id
    ORDER BY al.created_at DESC LIMIT 20
  `).all();

  res.json({
    system: {
      ...system,
      memory_formatted: {
        total: formatBytes(system.memory.total),
        used: formatBytes(system.memory.used),
        free: formatBytes(system.memory.free),
      },
      disk_formatted: {
        total: formatBytes(system.disk.total),
        used: formatBytes(system.disk.used),
        free: formatBytes(system.disk.free),
      },
    },
    apps: { total: appCount, environments: appCount * 2, healthy: healthyCount, down: downCount },
    recent_deploys: recentDeploys,
    recent_audit: recentAudit,
  });
});

/**
 * GET /api/server/app-metrics - Batch CPU/RAM for all apps (admin)
 */
router.get('/server/app-metrics', requireAdmin, async (req, res) => {
  const db = getDb();
  const apps = db.prepare('SELECT slug FROM apps').all();
  const { getProcessMetrics } = await import('../services/docker.js');

  const metrics = {};
  await Promise.all(apps.map(async (app) => {
    metrics[app.slug] = {};
    for (const env of ['production', 'sandbox']) {
      try { metrics[app.slug][env] = await getProcessMetrics(app.slug, env); }
      catch (_) { metrics[app.slug][env] = null; }
    }
  }));

  res.json({ metrics });
});

/**
 * GET /api/apps/:slug/metrics/:env - Per-app metrics
 */
router.get('/apps/:slug/metrics/:env', requireAppAccess, async (req, res) => {
  const { env } = req.params;
  const ports = getPortsForSlot(req.app.slot);

  let procMetrics = null;
  try {
    const { getProcessMetrics } = await import('../services/docker.js');
    procMetrics = await getProcessMetrics(req.app.slug, env);
  } catch (e) {}

  const db = getDb();
  const healthState = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?')
    .get(req.app.id, env);

  const recentDeploys = db.prepare(
    'SELECT version, status, started_at, finished_at FROM deployments WHERE app_id = ? AND env = ? ORDER BY started_at DESC LIMIT 5'
  ).all(req.app.id, env);

  const craneDomain = process.env.CRANE_DOMAIN;
  const url = craneDomain
    ? `https://${craneDomain}/${env === 'production' ? req.app.slug : `${req.app.slug}-sandbox`}`
    : (() => { const d = req.app.domain || `${req.app.slug}.example.com`; return env === 'production' ? `https://${d}` : `https://${d.replace(/^([^.]+)/, '$1-sandbox')}`; })();

  res.json({
    app: req.app.slug,
    env,
    url,
    process: procMetrics || { status: 'unknown', cpu: 0, memory: 0 },
    health: healthState,
    recent_deploys: recentDeploys,
  });
});

/**
 * GET /api/dashboard/app-activity - Per-app visitor counts for the last 7 days
 * "Visitors" = identity session creations (user logins) per app per day.
 */
router.get('/dashboard/app-activity', requireAdmin, (req, res) => {
  const db = getDb();

  // Build 7-day label array (YYYY-MM-DD strings)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Unique visitor counts grouped by app + day (from app_visits, deduplicated per user/app/day)
  const rows = db.prepare(`
    SELECT a.slug, a.name,
           v.day,
           COUNT(*) AS count
    FROM app_visits v
    JOIN apps a ON a.id = v.app_id
    WHERE v.day >= date('now', '-6 days')
    GROUP BY a.slug, v.day
  `).all();

  // Build per-app series
  const appsMap = {};
  for (const row of rows) {
    if (!appsMap[row.slug]) appsMap[row.slug] = { slug: row.slug, name: row.name, counts: Object.fromEntries(days.map(d => [d, 0])) };
    appsMap[row.slug].counts[row.day] = row.count;
  }

  const apps = Object.values(appsMap).map(a => ({
    slug: a.slug,
    name: a.name,
    counts: days.map(d => a.counts[d] ?? 0),
  }));

  res.json({ days, apps });
});

/**
 * GET /api/dashboard/leaderboards (v2.6.10+)
 *
 * Two leaderboards driven off the existing app_visits table (one row
 * per user/app/day, written from /api/identity/verify on every Caddy
 * forward_auth call):
 *
 *   - apps[]:  top apps by distinct active users over the window
 *   - users[]: top users by distinct apps opened over the window
 *
 * Query params:
 *   days  — lookback window in days (default 7, max 90)
 *   top   — how many rows per leaderboard (default 10, max 50)
 *
 * Both lists are admin-only — user-level activity rolled up by name is
 * sensitive enough to keep behind requireAdmin. Per-app rollups are
 * admin too (in line with /dashboard/app-activity which is already
 * gated the same way).
 */
router.get('/dashboard/leaderboards', requireAdmin, (req, res) => {
  const db = getDb();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const top  = Math.min(Math.max(parseInt(req.query.top,  10) || 10, 1), 50);

  // ─ Top apps by distinct active users in the window.
  // Attribute each app to its owner (first owner by id, matching how the
  // apps detail route resolves `owner`). LEFT JOIN so apps with no owner
  // record (creator deleted / pre-migration-048) still list, just unattributed.
  const apps = db.prepare(`
    SELECT a.slug, a.name,
           COUNT(DISTINCT v.user_id) AS users,
           COUNT(*) AS visit_days,
           ou.name  AS owner_name,
           ou.email AS owner_email
    FROM app_visits v
    JOIN apps a ON a.id = v.app_id
    LEFT JOIN (
      SELECT app_id, MIN(user_id) AS owner_id
      FROM app_user_roles WHERE app_role = 'owner'
      GROUP BY app_id
    ) o ON o.app_id = a.id
    LEFT JOIN users ou ON ou.id = o.owner_id
    WHERE v.day >= date('now', '-' || ? || ' days')
    GROUP BY a.id, a.slug, a.name, ou.name, ou.email
    ORDER BY users DESC, visit_days DESC, a.name ASC
    LIMIT ?
  `).all(days, top);

  // ─ Top users by distinct apps opened in the window
  const users = db.prepare(`
    SELECT u.id, u.name, u.email,
           COUNT(DISTINCT v.app_id) AS apps,
           COUNT(*) AS visit_days
    FROM app_visits v
    JOIN users u ON u.id = v.user_id
    WHERE v.day >= date('now', '-' || ? || ' days')
      AND u.active = 1
    GROUP BY u.id, u.name, u.email
    ORDER BY apps DESC, visit_days DESC, u.name ASC
    LIMIT ?
  `).all(days, top);

  res.json({ days, top, apps, users });
});

/**
 * GET /api/dashboard/active-users (v2.21.22) — count of users currently active
 * in the system, i.e. active (non-deactivated) accounts that either opened an
 * app (app_last_visit, updated on every Caddy forward_auth) or took a platform
 * action (audit_log) within the last `minutes`. Admin-only, like the other
 * dashboard rollups. Query: minutes (default 15, 1..1440).
 */
router.get('/dashboard/active-users', requireAdmin, (req, res) => {
  const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 15, 1), 1440);
  const db = getDb();
  const { count } = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS count
    FROM users u
    WHERE u.active = 1 AND (
      EXISTS (
        SELECT 1 FROM app_last_visit v
        WHERE v.user_id = u.id AND v.last_visit_at >= datetime('now', '-' || ? || ' minutes')
      ) OR EXISTS (
        SELECT 1 FROM audit_log al
        WHERE al.user_id = u.id AND al.created_at >= datetime('now', '-' || ? || ' minutes')
      )
    )
  `).get(minutes, minutes);
  res.json({ minutes, count });
});

/**
 * GET /api/dashboard/app-storage (v2.21.24) — total on-disk footprint per app:
 * the whole <DATA_DIR>/apps/<slug> tree (release checkouts + shared /data,
 * across sandbox + production) — i.e. what the app actually costs on the host
 * disk, not just its persistent volume. Admin-only. One `du` per app; returns
 * biggest-first so the Manage "Storage" column can rank disk hogs.
 */
router.get('/dashboard/app-storage', requireAdmin, async (req, res) => {
  const { dirSizeBytes } = await import('../services/diskUsage.js');
  const { resolveSafe } = await import('../utils/paths.js');
  const dataDir = process.env.DATA_DIR || './data';
  const db = getDb();
  const apps = db.prepare('SELECT slug FROM apps').all();
  const out = apps.map(({ slug }) => {
    let total = 0;
    try { total = dirSizeBytes(resolveSafe(dataDir, 'apps', slug)); } catch (_) { total = 0; }
    return { slug, total_bytes: total };
  });
  out.sort((a, b) => b.total_bytes - a.total_bytes);
  res.json({ apps: out });
});

// v2.45.2: the answer is cached, and the two probes below run together.
//
// This route reaches OUT to the internet twice — hstspreload.org, and the
// platform's own domain to see what its certificate looks like from outside.
// Both were awaited in series behind an 8s timeout each, and nothing cached the
// result, so every visit to Settings could spend up to 16 seconds on it. What it
// measures is DNS, a certificate and a public preload list; none of those change
// between two page loads a minute apart.
//
// Keyed on what the answer actually depends on, so switching TLS mode in the UI
// is reflected on the next read instead of up to the TTL later.
const TLS_CHECK_TTL_MS = 10 * 60 * 1000;
const TLS_PROBE_TIMEOUT_MS = 8000;
let tlsCheckCache = null;   // { key, at, payload }

/**
 * GET /api/server/tls-check - ENH-005: HSTS preload + cert validity check
 *
 * `?refresh=1` forces a re-probe — the button next to the panel needs to be able
 * to mean "check again now", which a cache that cannot be bypassed would break.
 */
router.get('/server/tls-check', requireAdmin, async (req, res) => {
  const domain = process.env.CRANE_DOMAIN;
  if (!domain) return res.json({ domain: null, skipped: true, reason: 'CRANE_DOMAIN not set' });

  const db = getDb();
  const tlsRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('tls_cert_file','tls_key_file')").all();
  const tlsMap = Object.fromEntries(tlsRows.map(r => [r.key, r.value || '']));
  const manualTls = !!(
    (tlsMap.tls_cert_file || process.env.TLS_CERT_FILE) &&
    (tlsMap.tls_key_file  || process.env.TLS_KEY_FILE)
  );

  const cacheKey = `${domain}|${manualTls}`;
  const fresh = req.query.refresh === '1';
  if (!fresh && tlsCheckCache && tlsCheckCache.key === cacheKey
      && Date.now() - tlsCheckCache.at < TLS_CHECK_TTL_MS) {
    return res.json({ ...tlsCheckCache.payload, cached: true });
  }

  const warnings = [];
  let hstsPreloaded = false;
  let certValid = null;

  // Independent probes of different hosts — there is no reason for the second
  // to wait on the first, and in series their timeouts add up.
  const [hsts, cert] = await Promise.allSettled([
    fetch(`https://hstspreload.org/api/v2/status?domain=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(TLS_PROBE_TIMEOUT_MS),
    }).then(r => (r.ok ? r.json() : null)),
    fetch(`https://${domain}/api/info`, {
      signal: AbortSignal.timeout(TLS_PROBE_TIMEOUT_MS),
    }),
  ]);

  // HSTS preload check — hstspreload.org unreachable just means no answer.
  if (hsts.status === 'fulfilled' && hsts.value) {
    hstsPreloaded = hsts.value.status === 'preloaded';
    if (hstsPreloaded && !manualTls) {
      warnings.push({
        level: 'error',
        code: 'HSTS_PRELOADED_ACME',
        message: `${domain} is HSTS-preloaded. ACME (Let's Encrypt) requires port 80 for HTTP challenges, which HSTS-preloaded browsers will refuse. Provide a manual TLS certificate instead.`,
      });
    }
  }

  // Cert validity — what the domain's HTTPS endpoint looks like from outside.
  if (cert.status === 'fulfilled') {
    certValid = cert.value.ok || cert.value.status < 500;
  } else {
    certValid = false;
    const msg = cert.reason?.message || '';
    if (/cert|ssl|tls|self.signed|UNABLE_TO_VERIFY/i.test(msg)) {
      warnings.push({
        level: 'error',
        code: 'CERT_INVALID',
        message: `TLS certificate for ${domain} is invalid or self-signed: ${msg}`,
      });
    } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|abort|timeout/i.test(msg)) {
      warnings.push({
        level: 'warn',
        code: 'DOMAIN_UNREACHABLE',
        message: `${domain} is not reachable — DNS may not be pointed at this server yet, or ports 80/443 are blocked.`,
      });
    }
  }

  const payload = {
    domain,
    tls_mode: manualTls ? 'manual' : 'acme',
    hsts_preloaded: hstsPreloaded,
    cert_valid: certValid,
    warnings,
  };
  tlsCheckCache = { key: cacheKey, at: Date.now(), payload };
  res.json({ ...payload, cached: false });
});

export default router;
