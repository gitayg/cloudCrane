import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin, requireAppAccess } from '../middleware/auth.js';
import { getSystemInfo, formatBytes } from '../services/platform.js';
import { getPortsForSlot } from '../services/portAllocator.js';

const router = Router();

router.use(requireAuth);

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
 * GET /api/server/tls-check - ENH-005: HSTS preload + cert validity check
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

  const warnings = [];
  let hstsPreloaded = false;
  let certValid = null;

  // HSTS preload check
  try {
    const r = await fetch(`https://hstspreload.org/api/v2/status?domain=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = await r.json();
      hstsPreloaded = data.status === 'preloaded';
      if (hstsPreloaded && !manualTls) {
        warnings.push({
          level: 'error',
          code: 'HSTS_PRELOADED_ACME',
          message: `${domain} is HSTS-preloaded. ACME (Let's Encrypt) requires port 80 for HTTP challenges, which HSTS-preloaded browsers will refuse. Provide a manual TLS certificate instead.`,
        });
      }
    }
  } catch (_) {
    // hstspreload.org unreachable — skip check
  }

  // Cert validity — try to fetch the domain's HTTPS endpoint
  try {
    const r = await fetch(`https://${domain}/api/info`, {
      signal: AbortSignal.timeout(8000),
    });
    certValid = r.ok || r.status < 500;
  } catch (e) {
    certValid = false;
    const msg = e.message || '';
    if (/cert|ssl|tls|self.signed|UNABLE_TO_VERIFY/i.test(msg)) {
      warnings.push({
        level: 'error',
        code: 'CERT_INVALID',
        message: `TLS certificate for ${domain} is invalid or self-signed: ${msg}`,
      });
    } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
      warnings.push({
        level: 'warn',
        code: 'DOMAIN_UNREACHABLE',
        message: `${domain} is not reachable — DNS may not be pointed at this server yet, or ports 80/443 are blocked.`,
      });
    }
  }

  res.json({
    domain,
    tls_mode: manualTls ? 'manual' : 'acme',
    hsts_preloaded: hstsPreloaded,
    cert_valid: certValid,
    warnings,
  });
});

export default router;
