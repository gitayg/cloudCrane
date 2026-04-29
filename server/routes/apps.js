import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin, requireAppAccess } from '../middleware/auth.js';
import { auditMiddleware, logAudit } from '../middleware/audit.js';
import { getNextSlot, getPortsForSlot } from '../services/portAllocator.js';
import { encrypt, generateApiKey, hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import { resolveSafe } from '../utils/paths.js';
import { reloadCaddy } from '../services/caddy.js';
import log from '../utils/logger.js';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { reconcileOrphanedApps } from '../services/reconcile.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/apps - List apps (admin sees all, user sees assigned)
 */
router.get('/', (req, res) => {
  const db = getDb();
  let apps;

  if (req.user.role === 'admin') {
    apps = db.prepare('SELECT * FROM apps ORDER BY created_at DESC').all();
  } else {
    apps = db.prepare(`
      SELECT a.* FROM apps a
      WHERE a.id IN (
        SELECT app_id FROM app_users WHERE user_id = ?
        UNION
        SELECT app_id FROM app_user_roles WHERE user_id = ?
      )
      ORDER BY a.created_at DESC
    `).all(req.user.id, req.user.id);
  }

  // Enrich with ports and health status
  const enriched = apps.map(app => {
    const ports = getPortsForSlot(app.slot);

    const healthProd = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'production');
    const healthSand = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');

    const lastDeployProd = db.prepare(
      'SELECT version, status, finished_at FROM deployments WHERE app_id = ? AND env = ? ORDER BY started_at DESC LIMIT 1'
    ).get(app.id, 'production');
    const lastDeploySand = db.prepare(
      'SELECT version, status, finished_at FROM deployments WHERE app_id = ? AND env = ? ORDER BY started_at DESC LIMIT 1'
    ).get(app.id, 'sandbox');

    // Get assigned users
    const users = db.prepare(`
      SELECT u.id, u.name, u.email FROM users u
      JOIN app_users au ON u.id = au.user_id
      WHERE au.app_id = ?
    `).all(app.id);

    const craneDomain = process.env.CRANE_DOMAIN;
    const urls = craneDomain ? {
      production: `https://${craneDomain}/${app.slug}`,
      sandbox: `https://${craneDomain}/${app.slug}-sandbox`,
    } : null;

    return {
      ...app,
      resource_limits: JSON.parse(app.resource_limits || '{}'),
      ...(req.user.role === 'admin' ? { ports } : {}),
      urls,
      base_path: { production: `/${app.slug}/`, sandbox: `/${app.slug}-sandbox/` },
      production: {
        health: healthProd ? { status: healthProd.is_down ? 'down' : (healthProd.last_status === 200 ? 'healthy' : 'unknown'), last_check: healthProd.last_check_at, response_ms: healthProd.last_response_ms } : { status: 'unknown' },
        deploy: lastDeployProd || null,
      },
      sandbox: {
        health: healthSand ? { status: healthSand.is_down ? 'down' : (healthSand.last_status === 200 ? 'healthy' : 'unknown'), last_check: healthSand.last_check_at, response_ms: healthSand.last_response_ms } : { status: 'unknown' },
        deploy: lastDeploySand || null,
      },
      users,
    };
  });

  res.json({ apps: enriched });
});

/**
 * POST /api/apps/analyze - AI analysis of a GitHub repo (admin only)
 * Body: { github_url, branch?, github_token? }
 * Returns: { name, slug, description, framework, port, env_vars, notes }
 */
router.post('/analyze', requireAdmin, async (req, res) => {
  const { github_url, branch, github_token } = req.body || {};
  if (!github_url) throw new AppError('github_url is required', 400, 'VALIDATION');
  if (!/^https:\/\/.+/.test(github_url)) throw new AppError('github_url must use HTTPS', 400, 'VALIDATION');

  const { analyzeGithubRepo } = await import('../services/appAnalyzer.js');
  const { encrypt } = await import('../services/encryption.js');
  const githubTokenEncrypted = github_token ? encrypt(github_token) : null;

  const analysis = await analyzeGithubRepo({
    githubUrl: github_url,
    branch: branch || 'main',
    githubTokenEncrypted,
  });
  res.json({ analysis });
});

/**
 * POST /api/apps - Create app (any authenticated user, auto-assigns creator)
 */
router.post('/', requireAuth, auditMiddleware('app-create'), async (req, res) => {
  const { name, slug, domain, description, category, source_type, github_url, branch, github_token, max_ram_mb, max_cpu_percent } = req.body;

  if (!name || !slug) throw new AppError('Name and slug are required', 400, 'VALIDATION');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new AppError('Slug must be lowercase alphanumeric with dashes', 400, 'VALIDATION');
  if (github_url && !/^https:\/\/.+/.test(github_url)) throw new AppError('github_url must use HTTPS', 400, 'VALIDATION');

  const db = getDb();

  // Check uniqueness
  if (db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug)) {
    throw new AppError(`App slug '${slug}' already exists`, 409, 'DUPLICATE');
  }

  const slot = getNextSlot(db);
  const ports = getPortsForSlot(slot);
  const resourceLimits = JSON.stringify({
    max_ram_mb: max_ram_mb || 512,
    max_cpu_percent: max_cpu_percent || 50,
  });

  const tokenEncrypted = github_token ? encrypt(github_token) : null;

  // domain is a custom override only — routing uses CRANE_DOMAIN/slug by default
  const appDomain = domain || null;

  const result = db.prepare(`
    INSERT INTO apps (name, slug, slot, domain, description, category, source_type, github_url, branch, github_token_encrypted, resource_limits, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, slug, slot, appDomain, description || null, category || null, source_type || 'github', github_url || null, branch || 'main', tokenEncrypted, resourceLimits, req.user.id);

  const appId = result.lastInsertRowid;

  // Create health configs for both envs
  for (const env of ['production', 'sandbox']) {
    db.prepare('INSERT INTO health_configs (app_id, env) VALUES (?, ?)').run(appId, env);
    db.prepare('INSERT INTO health_state (app_id, env) VALUES (?, ?)').run(appId, env);
  }

  // Auto-assign creator to the app
  db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(appId, req.user.id);

  // Create webhook config
  const webhookToken = crypto.randomBytes(16).toString('hex');
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO webhook_configs (app_id, token, secret) VALUES (?, ?, ?)').run(appId, webhookToken, webhookSecret);

  // Create app directories
  const dataDir = process.env.DATA_DIR || './data';
  const appDir = join(dataDir, 'apps', slug);
  for (const env of ['production', 'sandbox']) {
    const envDir = join(appDir, env);
    mkdirSync(join(envDir, 'releases'), { recursive: true });
    mkdirSync(join(envDir, 'shared', 'data'), { recursive: true });
  }

  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);

  // Update Caddy reverse proxy config
  const caddyResult = await reloadCaddy();
  if (!caddyResult.success) {
    log.warn(`Caddy reload failed after app create: ${caddyResult.error}`);
  }

  // Start health checks for the new app
  try {
    const { refreshAppChecks } = await import('../services/healthChecker.js');
    refreshAppChecks(appId);
  } catch (e) {}

  const craneDomain = process.env.CRANE_DOMAIN;
  const urls = craneDomain ? {
    production: `https://${craneDomain}/${slug}`,
    sandbox: `https://${craneDomain}/${slug}-sandbox`,
  } : null;

  res.status(201).json({
    app: { ...app, resource_limits: JSON.parse(app.resource_limits) },
    urls,
    base_path: { production: `/${slug}/`, sandbox: `/${slug}-sandbox/` },
    webhook_url: `/api/webhooks/${webhookToken}`,
    message: `App '${name}' created. Assign users with PUT /api/apps/${slug}/users`,
  });
});

/**
 * GET /api/apps/:slug - App detail
 */
router.get('/:slug', requireAppAccess, (req, res) => {
  const db = getDb();
  const app = req.app;
  const ports = getPortsForSlot(app.slot);

  const users = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN app_users au ON u.id = au.user_id WHERE au.app_id = ?
  `).all(app.id);

  const deployments = db.prepare(
    'SELECT id, env, version, status, commit_hash, started_at, finished_at FROM deployments WHERE app_id = ? ORDER BY started_at DESC LIMIT 10'
  ).all(app.id);

  const healthProd = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'production');
  const healthSand = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');
  const healthConfigProd = db.prepare('SELECT * FROM health_configs WHERE app_id = ? AND env = ?').get(app.id, 'production');
  const healthConfigSand = db.prepare('SELECT * FROM health_configs WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');

  const webhook = db.prepare('SELECT token, auto_deploy_sandbox, auto_deploy_prod, branch_filter FROM webhook_configs WHERE app_id = ?').get(app.id);

  const craneDomainDetail = process.env.CRANE_DOMAIN;
  const urlsDetail = craneDomainDetail ? {
    production: `https://${craneDomainDetail}/${app.slug}`,
    sandbox: `https://${craneDomainDetail}/${app.slug}-sandbox`,
  } : null;

  res.json({
    app: { ...app, resource_limits: JSON.parse(app.resource_limits || '{}') },
    urls: urlsDetail,
    base_path: { production: `/${app.slug}/`, sandbox: `/${app.slug}-sandbox/` },
    ...(req.user.role === 'admin' ? { ports } : {}),
    users,
    deployments,
    health: {
      production: { config: healthConfigProd, state: healthProd },
      sandbox: { config: healthConfigSand, state: healthSand },
    },
    webhook: webhook ? { ...webhook, url: `/api/webhooks/${webhook.token}` } : null,
  });
});

/**
 * PUT /api/apps/:slug - Update app (admin or assigned user)
 */
router.put('/:slug', requireAppAccess, auditMiddleware('app-update'), (req, res) => {
  const db = getDb();
  const app = req.app;
  const { name, domain, description, category, source_type, github_url, branch, github_token, max_ram_mb, max_cpu_percent, public_access } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (domain !== undefined) updates.domain = domain;
  if (description !== undefined) updates.description = description;
  if (category !== undefined) updates.category = category || null;
  if (source_type !== undefined) updates.source_type = source_type;
  if (github_url !== undefined) {
    if (github_url && !/^https:\/\/.+/.test(github_url)) throw new AppError('github_url must use HTTPS', 400, 'VALIDATION');
    updates.github_url = github_url;
  }
  if (branch !== undefined) updates.branch = branch;
  if (public_access !== undefined) updates.public_access = public_access ? 1 : 0;
  if (github_token !== undefined) updates.github_token_encrypted = encrypt(github_token);
  if (max_ram_mb !== undefined || max_cpu_percent !== undefined) {
    if (req.user?.role !== 'admin') {
      throw new AppError('Only admins can change resource limits', 403, 'FORBIDDEN');
    }
    const ram = max_ram_mb !== undefined ? Number(max_ram_mb) : null;
    const cpu = max_cpu_percent !== undefined ? Number(max_cpu_percent) : null;
    if (ram !== null && (!Number.isFinite(ram) || ram < 64 || ram > 16384)) {
      throw new AppError('max_ram_mb must be between 64 and 16384', 400, 'VALIDATION');
    }
    if (cpu !== null && (!Number.isFinite(cpu) || cpu < 5 || cpu > 800)) {
      throw new AppError('max_cpu_percent must be between 5 and 800', 400, 'VALIDATION');
    }
    const current = JSON.parse(app.resource_limits || '{}');
    updates.resource_limits = JSON.stringify({
      max_ram_mb: ram ?? current.max_ram_mb ?? 512,
      max_cpu_percent: cpu ?? current.max_cpu_percent ?? 50,
    });
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ app, message: 'No changes' });
  }

  const ALLOWED_APP_COLS = new Set(['name','domain','description','category','source_type','github_url','branch','public_access','github_token_encrypted','resource_limits','runtime']);
  const invalidKey = Object.keys(updates).find(k => !ALLOWED_APP_COLS.has(k));
  if (invalidKey) throw new AppError(`Invalid field: ${invalidKey}`, 400, 'VALIDATION');

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  db.prepare(`UPDATE apps SET ${setClauses} WHERE id = ?`).run(...values, app.id);

  const updated = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
  res.json({ app: { ...updated, resource_limits: JSON.parse(updated.resource_limits || '{}') } });
});

/**
 * DELETE /api/apps/:slug - Delete app (admin only, requires ?confirm=true)
 */
router.delete('/:slug', requireAdmin, requireAppAccess, auditMiddleware('app-delete'), async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('confirm') !== 'true') {
    throw new AppError('Add ?confirm=true to delete', 400, 'CONFIRMATION_REQUIRED');
  }

  const db = getDb();
  const slug = req.app.slug;

  // Stop containers
  try {
    const { stopApp } = await import('../services/docker.js');
    await stopApp(slug, 'production').catch(() => {});
    await stopApp(slug, 'sandbox').catch(() => {});
  } catch (e) {}

  // Delete related records first to avoid FK constraint failures
  const appId = req.app.id;
  db.transaction(() => {
    db.prepare('DELETE FROM app_users WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM app_user_roles WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM deployments WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM env_vars WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM health_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM health_state WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM webhook_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM backups WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM notification_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM identity_sessions WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM audit_log WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  })();

  // Update Caddy config (removes app routes)
  await reloadCaddy().catch(e => log.warn(`Caddy reload after delete: ${e.message}`));

  res.json({ message: `App '${slug}' deleted` });
});

/**
 * POST /api/apps/:slug/rename - Rename app slug (admin only)
 * Stops containers, renames data dir, updates DB, reloads Caddy, redeploys.
 */
router.post('/:slug/rename', requireAdmin, requireAppAccess, auditMiddleware('app-rename'), async (req, res) => {
  const { new_slug, redirect = true } = req.body;

  if (!new_slug) throw new AppError('new_slug is required', 400, 'VALIDATION');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(new_slug)) {
    throw new AppError('Slug must be lowercase alphanumeric with dashes', 400, 'VALIDATION');
  }

  const db = getDb();
  const app = req.app;
  const oldSlug = app.slug;

  if (new_slug === oldSlug) throw new AppError('New slug is the same as current slug', 400, 'VALIDATION');
  if (db.prepare('SELECT id FROM apps WHERE slug = ?').get(new_slug)) {
    throw new AppError(`Slug '${new_slug}' is already in use`, 409, 'DUPLICATE');
  }

  // Stop old containers
  try {
    const { stopApp } = await import('../services/docker.js');
    await stopApp(oldSlug, 'production').catch(() => {});
    await stopApp(oldSlug, 'sandbox').catch(() => {});
  } catch (_) {}

  // Rename data directory
  const dataDir = process.env.DATA_DIR || './data';
  const appsBase = join(dataDir, 'apps');
  const oldDir = resolveSafe(appsBase, oldSlug);
  const newDir = resolveSafe(appsBase, new_slug);
  if (existsSync(oldDir)) {
    renameSync(oldDir, newDir);
  }

  // Build updated slug_aliases (append old slug for redirect)
  let aliases = [];
  try { aliases = JSON.parse(app.slug_aliases || '[]'); } catch (_) {}
  if (redirect && !aliases.includes(oldSlug)) aliases.push(oldSlug);

  // Update DB
  db.prepare('UPDATE apps SET slug = ?, slug_aliases = ? WHERE id = ?')
    .run(new_slug, aliases.length ? JSON.stringify(aliases) : null, app.id);

  // Reload Caddy with new routes (+ redirect if requested)
  await reloadCaddy().catch(e => log.warn(`Caddy reload after rename: ${e.message}`));

  // Redeploy live environments so containers get the updated APP_BASE_PATH and new name
  const liveEnvs = db.prepare("SELECT env FROM deployments WHERE app_id = ? AND status = 'live'").all(app.id);
  const updatedApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
  const ports = getPortsForSlot(updatedApp.slot);

  for (const { env } of liveEnvs) {
    try {
      const result = db.prepare(
        "INSERT INTO deployments (app_id, env, status, deployed_by) VALUES (?, ?, 'pending', ?)"
      ).run(app.id, env, req.user.id);
      const { deployApp } = await import('../services/deployer.js');
      deployApp(result.lastInsertRowid, updatedApp, env, ports).catch(err => {
        log.error(`Rename redeploy failed (${env}): ${err.message}`);
      });
    } catch (e) {
      log.warn(`Could not queue rename redeploy for ${env}: ${e.message}`);
    }
  }

  res.json({
    message: `App renamed from '${oldSlug}' to '${new_slug}'`,
    old_slug: oldSlug,
    new_slug,
    redirect,
    redeploying: liveEnvs.map(r => r.env),
  });
});

/**
 * PUT /api/apps/:slug/users - Assign users to app (admin or assigned user)
 */
router.put('/:slug/users', requireAppAccess, auditMiddleware('app-assign-users'), (req, res) => {
  const { user_ids, user_emails } = req.body;
  const db = getDb();
  const appId = req.app.id;

  let ids = user_ids || [];

  // Resolve emails to IDs
  if (user_emails && user_emails.length) {
    for (const email of user_emails) {
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (!user) throw new AppError(`User with email '${email}' not found`, 404, 'NOT_FOUND');
      ids.push(user.id);
    }
  }

  // Replace all assignments
  db.transaction(() => {
    db.prepare('DELETE FROM app_users WHERE app_id = ?').run(appId);
    const insert = db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)');
    for (const uid of ids) {
      insert.run(appId, uid);
    }
  })();

  const users = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN app_users au ON u.id = au.user_id WHERE au.app_id = ?
  `).all(appId);

  res.json({ app: req.app.slug, users });
});

/**
 * POST /api/apps/:slug/deployment-key - Create a scoped deployment key for this app (admin only)
 * Creates a new user with role 'user', assigns them to this app, and returns the API key.
 */
router.post('/:slug/deployment-key', requireAuth, requireAdmin, auditMiddleware('deployment-key-create'), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(req.params.slug);
  if (!app) throw new AppError('App not found', 404, 'NOT_FOUND');

  const apiKey = generateApiKey('user');
  const keyHash = hashApiKey(apiKey);
  const name = 'deploy-' + app.slug + '-' + Date.now().toString(36);

  const result = db.transaction(() => {
    const userResult = db.prepare(`
      INSERT INTO users (name, email, role, api_key_hash) VALUES (?, ?, 'user', ?)
    `).run(name, name + '@appcrane.local', keyHash);
    db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(app.id, userResult.lastInsertRowid);
    return userResult.lastInsertRowid;
  })();

  res.json({ id: result, name, api_key: apiKey, app: app.slug, message: 'Deployment key created and assigned to app' });
});

/**
 * POST /api/apps/:slug/deployment-key/recycle - Rotate the deployment key for this app (admin only)
 * Finds the most-recently-created deploy user for the app and regenerates its API key.
 */
router.post('/:slug/deployment-key/recycle', requireAuth, requireAdmin, auditMiddleware('deployment-key-recycle'), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(req.params.slug);
  if (!app) throw new AppError('App not found', 404, 'NOT_FOUND');

  const deployUser = db.prepare(`
    SELECT u.* FROM users u
    JOIN app_users au ON u.id = au.user_id
    WHERE au.app_id = ? AND u.name LIKE 'deploy-%'
    ORDER BY u.id DESC LIMIT 1
  `).get(app.id);

  if (!deployUser) {
    throw new AppError(
      `No deployment key found for '${app.slug}'. Create one first: POST /api/apps/${app.slug}/deployment-key`,
      404, 'NO_DEPLOYMENT_KEY'
    );
  }

  const apiKey = generateApiKey('user');
  const keyHash = hashApiKey(apiKey);
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(keyHash, deployUser.id);

  res.json({
    user: { id: deployUser.id, name: deployUser.name },
    api_key: apiKey,
    app: app.slug,
    warning: 'Save this API key — it will not be shown again. The old key is now invalid.',
  });
});

/**
 * GET /api/apps/:slug/icon - Serve app icon SVG
 */
router.get('/:slug/icon', (req, res) => {
  const dataDir = process.env.DATA_DIR || './data';
  const iconPath = join(dataDir, 'apps', req.params.slug, 'icon.svg');
  if (!existsSync(iconPath)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No icon uploaded' } });
  res.type('image/svg+xml').sendFile(iconPath, { root: '/' });
});

/**
 * POST /api/apps/:slug/icon - Upload app icon SVG (admin or assigned app user)
 */
router.post('/:slug/icon', requireAuth, requireAppAccess, async (req, res) => {
  const app = req.app;  // set by requireAppAccess

  const multer = (await import('multer')).default;
  const dataDir = process.env.DATA_DIR || './data';
  const tmpDir = join(dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const ALLOWED_ICON_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 500 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_ICON_MIMES[file.mimetype]) {
        cb(null, true);
      } else {
        cb(new AppError('Only PNG, JPEG, WEBP, and GIF icons are accepted', 400, 'INVALID_FILE'));
      }
    },
  }).single('icon');

  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'No icon file uploaded' } });
    const ext = ALLOWED_ICON_MIMES[req.file.mimetype] || 'png';
    const iconPath = join(dataDir, 'apps', app.slug, `icon.${ext}`);
    renameSync(req.file.path, iconPath);
    res.json({ message: 'Icon uploaded', url: `/api/apps/${app.slug}/icon` });
  });
});

/**
 * POST /api/reconcile - Register orphaned PM2/filesystem apps into the DB and reload Caddy
 */
router.post('/reconcile', requireAdmin, async (req, res) => {
  const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
  const result = await reconcileOrphanedApps({ dryRun });
  res.json({ ...result, dry_run: dryRun });
});

export default router;
