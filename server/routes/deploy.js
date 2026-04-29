import { Router } from 'express';
import { existsSync, unlinkSync, symlinkSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { getDb } from '../db.js';
import { requireAuth, requireAppAccess } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import { getPortsForSlot } from '../services/portAllocator.js';
import log from '../utils/logger.js';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/apps/:slug/deploy/upload - Upload artifact and deploy in one step
 * Multipart form: file (.zip/.tar.gz/.tgz), env (sandbox|production), commit_sha?, commit_message?
 * No GitHub credentials required — CI builds the artifact and pushes it directly.
 */
router.post('/:slug/deploy/upload', requireAppAccess, auditMiddleware('deploy-upload'), async (req, res) => {
  const app = req.app;
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const { mkdirSync, unlinkSync } = await import('fs');
  const { execFileSync } = await import('child_process');
  const multer = (await import('multer')).default;

  const tmpDir = join(dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['.tar.gz', '.tgz', '.zip'];
      if (allowed.some(a => file.originalname.toLowerCase().endsWith(a))) cb(null, true);
      else cb(new AppError('Only .tar.gz, .tgz, and .zip files allowed', 400, 'INVALID_FILE'));
    },
  }).single('file');

  upload(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: multerErr.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'No file uploaded (field name: file)' } });

    const env = req.body?.env;
    if (!['production', 'sandbox'].includes(env)) {
      try { unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'env must be production or sandbox' } });
    }

    const commitSha = (req.body?.commit_sha || '').slice(0, 40) || null;
    const commitMessage = (req.body?.commit_message || '').slice(0, 200) || null;

    // Extract bundle to a timestamped release dir
    const timestamp = Date.now();
    const releaseDir = resolve(join(dataDir, 'apps', app.slug, env, 'releases', `${timestamp}-upload`));
    if (!releaseDir.startsWith(dataDir)) {
      try { unlinkSync(req.file.path); } catch (_) {}
      return res.status(500).json({ error: { code: 'PATH_TRAVERSAL', message: 'Security error' } });
    }

    mkdirSync(releaseDir, { recursive: true });

    try {
      const origName = req.file.originalname.toLowerCase();
      if (origName.endsWith('.zip')) {
        execFileSync('unzip', ['-o', req.file.path, '-d', releaseDir], { timeout: 60000, stdio: 'pipe' });
      } else {
        execFileSync('tar', ['-xzf', req.file.path, '-C', releaseDir], { timeout: 60000, stdio: 'pipe' });
      }
    } catch (e) {
      try { unlinkSync(req.file.path); } catch (_) {}
      return res.status(500).json({ error: { code: 'EXTRACT_FAILED', message: e.message } });
    }
    try { unlinkSync(req.file.path); } catch (_) {}

    const db = getDb();
    const ports = getPortsForSlot(app.slot);

    const result = db.prepare(`
      INSERT INTO deployments (app_id, env, status, commit_hash, commit_message, deployed_by, log)
      VALUES (?, ?, 'pending', ?, ?, ?, 'Triggered by artifact upload')
    `).run(app.id, env, commitSha || 'unknown', commitMessage, req.user.id);

    const deployId = result.lastInsertRowid;

    try {
      const { deployApp } = await import('../services/deployer.js');
      deployApp(deployId, app, env, ports, { preExtractedDir: releaseDir, commitHash: commitSha }).catch(err => {
        log.error(`Upload deploy ${deployId} failed: ${err.message}`);
      });
    } catch (e) {
      db.prepare("UPDATE deployments SET status = 'failed', log = ?, finished_at = datetime('now') WHERE id = ?")
        .run(`Deploy service error: ${e.message}`, deployId);
    }

    res.json({
      deployment: { id: deployId, app: app.slug, env, status: 'pending' },
      message: `Deployment #${deployId} started. Check status with GET /api/apps/${app.slug}/deployments/${env}`,
    });
  });
});

/**
 * POST /api/apps/:slug/deploy/:env - Trigger deployment
 */
router.post('/:slug/deploy/:env', requireAppAccess, auditMiddleware('deploy'), async (req, res) => {
  const { env } = req.params;
  if (!['production', 'sandbox'].includes(env)) {
    throw new AppError('env must be production or sandbox', 400, 'VALIDATION');
  }

  const db = getDb();
  const app = req.app;
  const ports = getPortsForSlot(app.slot);

  // Create deployment record
  const result = db.prepare(`
    INSERT INTO deployments (app_id, env, status, deployed_by)
    VALUES (?, ?, 'pending', ?)
  `).run(app.id, env, req.user.id);

  const deployId = result.lastInsertRowid;

  // Start deploy in background
  try {
    const { deployApp } = await import('../services/deployer.js');
    deployApp(deployId, app, env, ports).catch(err => {
      console.error(`Deploy ${deployId} failed:`, err);
    });
  } catch (e) {
    // deployer not yet implemented - mark as pending
    db.prepare("UPDATE deployments SET status = 'failed', log = ?, finished_at = datetime('now') WHERE id = ?")
      .run(`Deploy service error: ${e.message}`, deployId);
  }

  res.json({
    deployment: { id: deployId, app: app.slug, env, status: 'pending' },
    message: `Deployment #${deployId} started. Check status with GET /api/apps/${app.slug}/deployments/${env}`,
  });
});

/**
 * GET /api/apps/:slug/deployments/:env - Deployment history
 */
router.get('/:slug/deployments/:env', requireAppAccess, (req, res) => {
  const { env } = req.params;
  const db = getDb();

  const deployments = db.prepare(`
    SELECT d.*, u.name as deployed_by_name
    FROM deployments d
    LEFT JOIN users u ON d.deployed_by = u.id
    WHERE d.app_id = ? AND d.env = ?
    ORDER BY d.started_at DESC
    LIMIT 20
  `).all(req.app.id, env);

  res.json({ deployments });
});

/**
 * GET /api/apps/:slug/deployments/:env/:id/log - Get deploy log
 */
router.get('/:slug/deployments/:env/:id/log', requireAppAccess, (req, res) => {
  const db = getDb();
  const deploy = db.prepare('SELECT * FROM deployments WHERE id = ? AND app_id = ?').get(
    parseInt(req.params.id), req.app.id
  );
  if (!deploy) throw new AppError('Deployment not found', 404, 'NOT_FOUND');

  res.json({ log: deploy.log || '', status: deploy.status });
});

/**
 * POST /api/apps/:slug/rollback/:env - Rollback to previous version
 */
router.post('/:slug/rollback/:env', requireAppAccess, auditMiddleware('rollback'), async (req, res) => {
  const { env } = req.params;
  if (!['production', 'sandbox'].includes(env)) {
    throw new AppError('env must be production or sandbox', 400, 'VALIDATION');
  }
  const { deployment_id } = req.body || {};
  const db = getDb();
  const app = req.app;

  // Find the deployment to rollback to (must have release_path on disk)
  let target;
  if (deployment_id) {
    target = db.prepare(
      "SELECT * FROM deployments WHERE id = ? AND app_id = ? AND env = ? AND status IN ('live', 'rolled_back')"
    ).get(deployment_id, app.id, env);
  } else {
    // Previous live-or-rolled-back deployment (skip current live)
    const history = db.prepare(
      "SELECT * FROM deployments WHERE app_id = ? AND env = ? AND status IN ('live', 'rolled_back') ORDER BY started_at DESC LIMIT 2"
    ).all(app.id, env);
    target = history[1];
  }

  if (!target) {
    throw new AppError('No previous deployment to rollback to', 404, 'NO_ROLLBACK_TARGET');
  }
  if (!target.release_path) {
    throw new AppError('Target deployment has no release_path recorded (pre-rollback-support deploy)', 409, 'NO_RELEASE_PATH');
  }
  if (!existsSync(target.release_path)) {
    throw new AppError(`Release directory missing on disk: ${target.release_path}`, 410, 'RELEASE_GONE');
  }

  const dataDir = resolve(process.env.DATA_DIR || './data');
  const appDir = resolve(join(dataDir, 'apps', app.slug, env));
  if (!appDir.startsWith(dataDir)) {
    throw new AppError('Security: appDir outside dataDir', 500, 'PATH_TRAVERSAL');
  }
  const releaseDir = resolve(target.release_path);
  if (!releaseDir.startsWith(dataDir)) {
    throw new AppError('Security: release_path outside dataDir', 500, 'PATH_TRAVERSAL');
  }

  // Swap the current symlink
  const currentLink = join(appDir, 'current');
  try { unlinkSync(currentLink); } catch (_) {}
  symlinkSync(releaseDir, currentLink);

  // Insert rollback deployment record first so deployApp can update it
  const rollbackInsert = db.prepare(`
    INSERT INTO deployments (app_id, env, version, status, commit_hash, release_path, deployed_by, log)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(app.id, env, target.version, target.commit_hash, releaseDir, req.user.id, `Rollback to deployment #${target.id}`);

  // Mark previously-live deployments as rolled_back
  db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE app_id = ? AND env = ? AND status = 'live' AND id != ?")
    .run(app.id, env, rollbackInsert.lastInsertRowid);

  // Rebuild the image from the rollback release and start a fresh container
  try {
    const { deployApp } = await import('../services/deployer.js');
    const { getPortsForSlot } = await import('../services/portAllocator.js');
    const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    const ports = getPortsForSlot(fullApp.slot);
    await deployApp(rollbackInsert.lastInsertRowid, fullApp, env, ports, {
      preExtractedDir: releaseDir,
      commitHash: target.commit_hash,
    });
  } catch (e) {
    log.warn(`Rollback deploy failed for ${app.slug}-${env}: ${e.message}`);
  }

  const result = { lastInsertRowid: rollbackInsert.lastInsertRowid };

  res.json({
    message: `Rolled back ${app.slug} ${env} to version ${target.version || 'deployment #' + target.id}`,
    deployment: { id: result.lastInsertRowid, rollback_to: target.id },
  });
});

/**
 * POST /api/apps/:slug/promote - Promote sandbox code to production
 *
 * Copies the sandbox release directory into the production releases tree,
 * rewrites the production .env from prod env_vars, swaps the `current` symlink,
 * and restarts the production PM2 process. Env vars and /data are NOT copied.
 */
router.post('/:slug/promote', requireAppAccess, auditMiddleware('promote'), async (req, res) => {
  const db = getDb();
  const app = req.app;

  const sandboxDeploy = db.prepare(
    "SELECT * FROM deployments WHERE app_id = ? AND env = 'sandbox' AND status = 'live' ORDER BY started_at DESC LIMIT 1"
  ).get(app.id);

  if (!sandboxDeploy) {
    throw new AppError('No live sandbox deployment to promote', 400, 'NO_SANDBOX_DEPLOY');
  }

  const prodPorts = getPortsForSlot(app.slot);

  // GitHub-sourced apps: trigger a fresh production build so the bundler picks up
  // VITE_BASE_PATH=/<slug>/ instead of the sandbox's /<slug>-sandbox/ that is baked
  // into any copied dist/ artifacts.
  if (app.source_type === 'github' && app.github_url) {
    const { deployApp } = await import('../services/deployer.js');
    const freshResult = db.prepare(`
      INSERT INTO deployments (app_id, env, version, status, commit_hash, deployed_by, log)
      VALUES (?, 'production', ?, 'pending', ?, ?, ?)
    `).run(app.id, sandboxDeploy.version, sandboxDeploy.commit_hash, req.user.id,
      `Promote from sandbox #${sandboxDeploy.id} — fresh production build`);
    const freshDeployId = freshResult.lastInsertRowid;

    deployApp(freshDeployId, app, 'production', prodPorts).catch(err => {
      log.error(`Promote build ${freshDeployId} for ${app.slug} failed: ${err.message}`);
    });

    return res.status(202).json({
      message: `Promoting sandbox v${sandboxDeploy.version || '?'} to production (fresh build)`,
      deployment: { id: freshDeployId, status: 'pending' },
    });
  }

  // Upload-sourced apps: copy the sandbox release (same behavior as before).
  // Note: if the upload artifact has a baked-in sandbox base path, it will carry
  // over to production. Build separate artifacts per env to avoid this.
  if (!sandboxDeploy.release_path || !existsSync(sandboxDeploy.release_path)) {
    throw new AppError('Sandbox release directory missing on disk (pre-promote-support deploy?)', 409, 'NO_RELEASE_PATH');
  }

  const dataDir = resolve(process.env.DATA_DIR || './data');
  const prodAppDir = resolve(join(dataDir, 'apps', app.slug, 'production'));
  const prodReleasesDir = resolve(join(prodAppDir, 'releases'));
  const prodSharedDir = resolve(join(prodAppDir, 'shared'));
  const sandboxReleaseDir = resolve(sandboxDeploy.release_path);

  for (const p of [prodAppDir, prodReleasesDir, prodSharedDir, sandboxReleaseDir]) {
    if (!p.startsWith(dataDir)) {
      throw new AppError('Security: path outside dataDir', 500, 'PATH_TRAVERSAL');
    }
  }

  // Insert pending record first so we can track status if something fails
  const insertResult = db.prepare(`
    INSERT INTO deployments (app_id, env, version, status, commit_hash, deployed_by, log)
    VALUES (?, 'production', ?, 'deploying', ?, ?, ?)
  `).run(app.id, sandboxDeploy.version, sandboxDeploy.commit_hash, req.user.id,
    `Promoted from sandbox deployment #${sandboxDeploy.id}`);
  const newDeployId = insertResult.lastInsertRowid;

  try {
    // 1. Copy sandbox release tree into production releases/ with a new timestamp
    const timestamp = Date.now();
    const newReleaseDir = resolve(join(prodReleasesDir, `${timestamp}-promote`));
    cpSync(sandboxReleaseDir, newReleaseDir, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        // Skip any .env symlink or data symlink — production rewrites both
        const base = src.split('/').pop();
        if (base === '.env' || base === 'data') return false;
        return true;
      },
    });

    // 2. Rewrite production .env from production env_vars (NEVER copy sandbox env)
    const { decrypt } = await import('../services/encryption.js');
    const prodPorts = getPortsForSlot(app.slot);
    const envRows = db.prepare(
      'SELECT key, value_encrypted FROM env_vars WHERE app_id = ? AND env = ?'
    ).all(app.id, 'production');
    const envContent = envRows.map(v => {
      try { return `${v.key}=${decrypt(v.value_encrypted)}`; }
      catch (_) { return `# ERROR decrypting ${v.key}`; }
    }).join('\n');
    const fullEnv = `${envContent}\nPORT=${prodPorts.prod_be}\nFE_PORT=${prodPorts.prod_fe}\nNODE_ENV=production\n`;
    writeFileSync(join(prodSharedDir, '.env.production'), fullEnv);
    const envDest = join(newReleaseDir, '.env');
    try { unlinkSync(envDest); } catch (_) {}
    symlinkSync(join(prodSharedDir, '.env.production'), envDest);

    // 3. Symlink production shared /data
    const dataLink = join(newReleaseDir, 'data');
    try { unlinkSync(dataLink); } catch (_) {}
    try { symlinkSync(join(prodSharedDir, 'data'), dataLink); } catch (_) {}

    // 4. Swap current symlink
    const currentLink = join(prodAppDir, 'current');
    try { unlinkSync(currentLink); } catch (_) {}
    symlinkSync(newReleaseDir, currentLink);

    // 5. Rebuild production image + start fresh container via deployApp
    try {
      const { deployApp } = await import('../services/deployer.js');
      const { getPortsForSlot } = await import('../services/portAllocator.js');
      const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
      const ports = getPortsForSlot(fullApp.slot);
      await deployApp(newDeployId, fullApp, 'production', ports, {
        preExtractedDir: newReleaseDir,
        commitHash: sandboxDeploy.commit_hash,
      });
    } catch (e) {
      log.warn(`Promote deploy failed for ${app.slug}-production: ${e.message}`);
    }

    // Mark previously-live prod deployments as rolled_back, then mark this one live
    db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE app_id = ? AND env = 'production' AND status = 'live'")
      .run(app.id);
    db.prepare("UPDATE deployments SET status = 'live', release_path = ?, finished_at = datetime('now') WHERE id = ?")
      .run(newReleaseDir, newDeployId);

    res.json({
      message: `Promoted sandbox v${sandboxDeploy.version || '?'} to production`,
      deployment: { id: newDeployId, from_sandbox: sandboxDeploy.id },
    });
  } catch (e) {
    db.prepare("UPDATE deployments SET status = 'failed', finished_at = datetime('now'), log = ? WHERE id = ?")
      .run(`Promote failed: ${e.message}`, newDeployId);
    throw new AppError(`Promote failed: ${e.message}`, 500, 'PROMOTE_FAILED');
  }
});

/**
 * POST /api/apps/:slug/restart/:env - Recreate the container with fresh env vars from the DB.
 * docker restart does NOT re-read env vars (they're baked in at `docker run`), so we inspect the
 * running container to find its image, stop it, and start a new one with the current env.
 */
router.post('/:slug/restart/:env', requireAppAccess, auditMiddleware('restart'), async (req, res) => {
  const { env } = req.params;
  if (!['production', 'sandbox'].includes(env)) {
    throw new AppError('env must be production or sandbox', 400, 'VALIDATION');
  }

  const db = getDb();
  const app = req.app;
  const ports = getPortsForSlot(app.slot);
  const { decrypt } = await import('../services/encryption.js');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { resolve, join } = await import('path');
  const execFileAsync = promisify(execFile);

  const containerName = `appcrane-${app.slug}-${env}`;

  // Find the image currently running. If the container doesn't exist (never deployed or pruned),
  // fall back to the most recent live deployment record.
  let image = null;
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', containerName, '--format', '{{.Config.Image}}'], { timeout: 10000 });
    image = stdout.trim();
  } catch (_) {}

  if (!image) {
    throw new AppError(`Container ${containerName} not found. Run a deploy first.`, 400, 'NO_CONTAINER');
  }

  // Rebuild runtime env vars from DB
  const envVars = db.prepare(
    'SELECT key, value_encrypted FROM env_vars WHERE app_id = ? AND env = ?'
  ).all(app.id, env);

  const runtimeEnvVars = {};
  for (const v of envVars) {
    try { runtimeEnvVars[v.key] = decrypt(v.value_encrypted); } catch (_) {}
  }
  const cranePort = process.env.PORT || 5001;
  const craneUrl = process.env.CRANE_DOMAIN ? `https://${process.env.CRANE_DOMAIN}` : `http://localhost:${cranePort}`;
  // APP_BASE_PATH is intentionally NOT set at runtime — see deployer.js and
  // bugs/2026-04-26-appcrane-app-base-path-resolution.md
  Object.assign(runtimeEnvVars, {
    CRANE_URL: craneUrl,
    CRANE_INTERNAL_URL: `http://localhost:${cranePort}`,
    DATA_DIR: '/data',
  });

  const dataDir = resolve(process.env.DATA_DIR || './data');
  const sharedDir = resolve(join(dataDir, 'apps', app.slug, env, 'shared'));
  const bePort = env === 'production' ? ports.prod_be : ports.sand_be;

  // Parse resource limits the same way the deployer does
  let limits = { max_ram_mb: 512, max_cpu_percent: 50 };
  try {
    const parsed = JSON.parse(app.resource_limits || '{}');
    limits = {
      max_ram_mb: Number(parsed.max_ram_mb) || 512,
      max_cpu_percent: Number(parsed.max_cpu_percent) || 50,
    };
  } catch (_) {}

  // Recreate: stop + start with fresh env
  const { startApp: dockerStart, stopApp: dockerStop } = await import('../services/docker.js');
  await dockerStop(app.slug, env).catch(() => {});
  await dockerStart({
    slug: app.slug,
    env,
    image,
    hostPort: bePort,
    envVars: runtimeEnvVars,
    volumes: [{ host: resolve(join(sharedDir, 'data')), container: '/data' }],
    memoryMb: limits.max_ram_mb,
    cpus: limits.max_cpu_percent / 100,
  });

  res.json({ message: `Restarted ${app.slug} ${env} with updated env vars`, image });
});

export default router;
