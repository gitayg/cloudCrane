import { Router } from 'express';
import { existsSync, unlinkSync, symlinkSync, cpSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { getDb } from '../db.js';
import { requireAuth, requireAppAccess } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import { getPortsForSlot } from '../services/portAllocator.js';
import { userHasAppPermission, roleForUserOnApp } from '../services/permissions.js';
import { isAdmin } from '../utils/roles.js';
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

    const declaredSha = (req.body?.commit_sha || '').slice(0, 40) || null;
    const commitMessage = (req.body?.commit_message || '').slice(0, 200) || null;

    // services/artifactDeploy.js owns the digest, the extract and the deploy
    // handoff. It is shared with the MCP tool, which is the only route an agent
    // holding a dhk_mcp_* key can take.
    let out;
    try {
      const { deployArtifact } = await import('../services/artifactDeploy.js');
      out = await deployArtifact({
        app, env, filePath: req.file.path, filename: req.file.originalname,
        declaredSha, commitMessage, userId: req.user.id,
      });
    } catch (e) {
      return res.status(400).json({ error: { code: 'UPLOAD_DEPLOY_FAILED', message: e.message } });
    }

    res.json({
      deployment: { id: out.deployId, app: app.slug, env, status: 'pending' },
      // Echoed so the uploader can compare against the digest it computed
      // locally — the only way for the client to confirm the bytes AppCrane
      // deployed are the bytes it meant to send.
      artifact: {
        sha256: out.artifact.sha256,
        bytes: out.artifact.bytes,
        filename: out.artifact.filename,
        declared_commit_sha: out.artifact.declared_commit_sha,
      },
      message: `Deployment #${out.deployId} started. Check status with GET /api/apps/${app.slug}/deployments/${env}`,
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

  // Configurable RBAC: production deploys gated by deploy.production permission
  if (env === 'production' && !userHasAppPermission(req.user, req.app, 'deploy.production')) {
    throw new AppError('Production deploys are not permitted by your role on this app', 403, 'FORBIDDEN');
  }

  const db = getDb();
  const app = req.app;
  const ports = getPortsForSlot(app.slot);

  // v2.7.31: refuse to pile a new deploy on top of one already in flight for
  // this app+env (deploy-storm guard). Stale in-flight rows are reclaimed.
  const { assertNoInflightDeploy } = await import('../services/deployer.js');
  assertNoInflightDeploy(db, app.id, env, app.slug);

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
  // v2.7.13: rollback is owner-only (or global admin), same gate as promote.
  if (!isAdmin(req.user) && roleForUserOnApp(req.user, req.app) !== 'owner') {
    throw new AppError('Only the app owner can roll back this app.', 403, 'FORBIDDEN');
  }
  const { deployment_id } = req.body || {};
  const { rollbackApp } = await import('../services/deployer.js');
  const r = await rollbackApp(req.app, env, deployment_id, req.user.id);
  res.json({
    message: `Rolled back ${req.app.slug} ${env} to version ${r.version || 'deployment #' + r.rollback_to}`,
    deployment: { id: r.deployment_id, rollback_to: r.rollback_to },
  });
});

/**
 * POST /api/apps/:slug/promote - Promote the live sandbox release to production.
 *
 * Gated: requires a live + healthy sandbox (see promoteApp), and the caller
 * must hold deploy.production. github apps rebuild for prod; managed/upload
 * apps copy the exact tested sandbox release. Mechanics live in
 * services/deployer.js promoteApp() so REST and the appcrane_promote MCP tool
 * stay in lockstep.
 */
router.post('/:slug/promote', requireAppAccess, auditMiddleware('promote'), async (req, res) => {
  // v2.7.12: promotion is owner-only (or global admin). Per-app admins and
  // plain members cannot promote to production.
  if (!isAdmin(req.user) && roleForUserOnApp(req.user, req.app) !== 'owner') {
    throw new AppError('Only the app owner can promote to production.', 403, 'FORBIDDEN');
  }
  const { promoteApp } = await import('../services/deployer.js');
  const r = await promoteApp(req.app, req.user.id);
  res.status(r.status === 'pending' ? 202 : 200).json({
    message: `Promoting sandbox v${r.version || '?'} to production${r.mode === 'rebuild' ? ' (fresh build)' : ''}`,
    deployment: { id: r.deployment_id, from_sandbox: r.from_sandbox, status: r.status },
  });
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
  const decryptFailures = [];
  for (const v of envVars) {
    try { runtimeEnvVars[v.key] = decrypt(v.value_encrypted); }
    catch (_) { decryptFailures.push(v.key); }
  }
  // v2.7.30: loud decrypt failures — a silently-dropped secret on restart
  // is exactly the "I set it and it's still missing" mystery.
  if (decryptFailures.length) {
    log.warn(`Restart ${containerName}: ${decryptFailures.length} env var(s) failed to decrypt (ENCRYPTION_KEY mismatch?), omitted: ${decryptFailures.join(', ')}`);
  }

  // v2.65.0: managed database credentials, same rule as the deploy path — the
  // app's catalogue entry names the variables, and an env var the app itself
  // carries wins over the injected credential. Restart rebuilds the container's
  // whole environment from scratch, so skipping this here would silently strip
  // the database credentials off a restarted app that had them at deploy.
  // Deliberately placed BEFORE the CRANE_URL/DATA_DIR block below for the same
  // reason as in the deployer: those are platform vars that always win.
  {
    const { applyManagedDbEnv } = await import('../services/deployer.js');
    const mdbEnv = applyManagedDbEnv(app, runtimeEnvVars, decryptFailures);
    if (mdbEnv.injected.length) {
      // Key names only. The values include a database password.
      log.info(`Restart ${containerName}: injected managed ${mdbEnv.engine} database var(s): ${mdbEnv.injected.join(', ')}`);
    }
    if (mdbEnv.deferred.length) {
      log.info(`Restart ${containerName}: kept the app's own value for ${mdbEnv.deferred.join(', ')} over the managed ${mdbEnv.engine} credential`);
    }
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

  // v2.8.3: email service is available to every app — inject the token
  // (provisioning on first need) + host-gateway URL so the container can reach
  // AppCrane's internal email API.
  {
    const { getServiceTokenPlaintext, issueServiceToken } = await import('../services/appServiceToken.js');
    const token = getServiceTokenPlaintext(app) || issueServiceToken(app.id);
    runtimeEnvVars.APPCRANE_SERVICE_TOKEN = token;
    runtimeEnvVars.CRANE_INTERNAL_URL = `http://host.docker.internal:${cranePort}`;
  }

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
    addHostGateway: true,
  });

  res.json({
    message: `Restarted ${app.slug} ${env} with updated env vars`,
    image,
    injected_keys: Object.keys(runtimeEnvVars),
    decrypt_failures: decryptFailures,
  });
});

export default router;
