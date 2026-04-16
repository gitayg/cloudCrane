import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../db.js';
import { decrypt } from './encryption.js';
import log from '../utils/logger.js';

function parseResourceLimits(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return {
      max_ram_mb: Number(parsed.max_ram_mb) || 512,
      max_cpu_percent: Number(parsed.max_cpu_percent) || 50,
    };
  } catch (e) {
    return { max_ram_mb: 512, max_cpu_percent: 50 };
  }
}

/**
 * Allowlist of executables permitted in deployhub.json build/entry commands.
 * Prevents arbitrary command execution via attacker-controlled manifest fields.
 */
const SAFE_EXECUTABLES = new Set([
  'node', 'npm', 'yarn', 'pnpm', 'npx', 'bun',
  'ts-node', 'tsx', 'vite', 'next', 'nuxt', 'tsc', 'react-scripts',
]);

/**
 * Validate a command string from deployhub.json before execution.
 * Throws if the command contains dangerous characters, an absolute path,
 * path traversal, or a non-allowlisted executable.
 */
function validateManifestCommand(value, field) {
  if (!value) return;
  const tokens = value.trim().split(/\s+/);
  const executable = tokens[0];
  if (!SAFE_EXECUTABLES.has(executable)) {
    throw new Error(
      `deployhub.json ${field}: executable "${executable}" is not allowed. ` +
      `Permitted: ${[...SAFE_EXECUTABLES].join(', ')}`
    );
  }
  for (const token of tokens) {
    if (/[;&|`$(){}<>!\n\r]/.test(token)) {
      throw new Error(`deployhub.json ${field}: token "${token}" contains unsafe shell characters`);
    }
    if (token.startsWith('/')) {
      throw new Error(`deployhub.json ${field}: absolute paths are not allowed`);
    }
    if (token.includes('..')) {
      throw new Error(`deployhub.json ${field}: path traversal ("..") is not allowed`);
    }
  }
}

/**
 * Core deploy pipeline.
 * 1. Clone repo (or use uploaded files)
 * 2. npm install
 * 3. npm run build (FE)
 * 4. Write .env file from encrypted vars
 * 5. Symlink shared data dirs
 * 6. Start via PM2 on allocated ports
 * 7. Health check
 * 8. Swap 'current' symlink
 * 9. Cleanup old releases (keep last 5)
 */
export async function deployApp(deployId, app, env, ports, opts = {}) {
  const db = getDb();
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const appDir = resolve(join(dataDir, 'apps', app.slug, env));
  const releasesDir = resolve(join(appDir, 'releases'));
  const sharedDir = resolve(join(appDir, 'shared'));

  // Security: ensure all paths are within dataDir (prevent path traversal)
  for (const p of [appDir, releasesDir, sharedDir]) {
    if (!p.startsWith(dataDir)) {
      throw new Error(`Security: path ${p} is outside data directory ${dataDir}`);
    }
  }

  mkdirSync(releasesDir, { recursive: true });
  const sharedData = join(sharedDir, 'data');
  mkdirSync(sharedData, { recursive: true });

  // Bind-mounted volumes inherit host ownership, not container ownership.
  // Our Dockerfile runs as the `node` user (UID 1000 in node:*-alpine), so
  // chown -R the shared dir to 1000:1000 on Linux; otherwise the container
  // gets a read-only /data and apps crash with EACCES on their first write.
  // Recursive chown also fixes files left over from older rootful containers.
  // No-op on macOS/dev (chown fails silently, containers run rootful there).
  try {
    execFileSync('chown', ['-R', '1000:1000', sharedData], { stdio: 'pipe', timeout: 30000 });
  } catch (_) {}

  const deployLog = [];
  let deployFinished = false;
  const appendLog = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    deployLog.push(line);
    log.info(`[deploy:${deployId}] ${msg}`);
    // Update log in DB (don't overwrite status after deploy is done)
    if (!deployFinished) {
      db.prepare("UPDATE deployments SET log = ?, status = 'building' WHERE id = ?")
        .run(deployLog.join('\n'), deployId);
    }
  };

  try {
    // 1. Clone or locate release
    const timestamp = Date.now();
    let commitHash = 'unknown';
    let releaseDir;

    if (opts.preExtractedDir) {
      releaseDir = resolve(opts.preExtractedDir);
      if (!releaseDir.startsWith(dataDir)) throw new Error('Security: preExtractedDir is outside data directory');
      commitHash = opts.commitHash || 'unknown';
      appendLog(`Using pre-extracted release: ${releaseDir.split('/').pop()}`);
    } else if (app.source_type === 'github' && app.github_url) {
      appendLog(`Cloning ${app.github_url} (branch: ${app.branch || 'main'})...`);

      releaseDir = resolve(join(releasesDir, `${timestamp}-git`));
      mkdirSync(releaseDir, { recursive: true });

      let cloneUrl = app.github_url;
      if (app.github_token_encrypted) {
        const token = decrypt(app.github_token_encrypted);
        const url = new URL(app.github_url);
        url.username = token;
        cloneUrl = url.toString();
      }

      execFileSync('git', [
        'clone', '--depth', '1',
        '--branch', app.branch || 'main',
        cloneUrl, releaseDir,
      ], { timeout: 120000, stdio: 'pipe' });

      // Get commit hash
      try {
        commitHash = execFileSync('git', ['-C', releaseDir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })
          .toString().trim();
      } catch (e) {}

      appendLog(`Cloned successfully. Commit: ${commitHash}`);
    } else {
      // Find latest upload release
      const releases = readdirSync(releasesDir)
        .filter(d => d.includes('upload'))
        .sort()
        .reverse();

      if (releases.length === 0) {
        throw new Error('No uploaded release found. Upload files first.');
      }

      releaseDir = resolve(join(releasesDir, releases[0]));
      appendLog(`Using uploaded release: ${releases[0]}`);
    }

    // Read deployhub.json manifest
    let manifest = {};
    const manifestPath = join(releaseDir, 'deployhub.json');
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      appendLog(`Found deployhub.json: ${manifest.name} v${manifest.version}`);
    } else {
      appendLog('WARNING: No deployhub.json found. Using defaults.');
      // Try to read version from package.json
      const pkgPath = join(releaseDir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        manifest.version = pkg.version;
        manifest.name = pkg.name;
      }
    }

    const envVars = db.prepare(
      'SELECT key, value_encrypted FROM env_vars WHERE app_id = ? AND env = ?'
    ).all(app.id, env);

    const bePort = env === 'production' ? ports.prod_be : ports.sand_be;
    const cranePort = process.env.PORT || 5001;
    const craneUrl = process.env.CRANE_DOMAIN
      ? `https://${process.env.CRANE_DOMAIN}`
      : `http://localhost:${cranePort}`;
    const craneInternalUrl = `http://localhost:${cranePort}`;

    const appBasePath = env === 'production' ? `/${app.slug}/` : `/${app.slug}-sandbox/`;

    db.prepare("UPDATE deployments SET status = 'deploying' WHERE id = ?").run(deployId);

    const { dockerAvailable, buildImage, startApp: dockerStart, stopApp: dockerStop, pruneOldImages } = await import('./docker.js');
    const { ensureDockerfile } = await import('./dockerfileGen.js');

    if (!dockerAvailable()) throw new Error('Docker daemon is not available on this host');

    // No validateManifestCommand here — Docker builds run inside an isolated
    // container, which IS the security boundary. Commands like "cd backend &&
    // node server.js" are safe in a Dockerfile CMD but would fail the
    // host-oriented validator (which blocks shell metacharacters and non-allowlisted executables).

    ensureDockerfile({ releaseDir, manifest, appBasePath, craneUrl, craneInternalUrl });
    appendLog('Generated Dockerfile (Node Alpine, non-root)');

    appendLog('Building docker image...');
    const image = buildImage({
      slug: app.slug,
      contextDir: releaseDir,
      commitHash,
      onLog: (line) => { if (deployLog.length < 500) appendLog(`  ${line}`); },
    });
    appendLog(`Image built: ${image}`);

    await dockerStop(app.slug, env).catch(() => {});

    const runtimeEnvVars = {};
    for (const v of envVars) {
      try { runtimeEnvVars[v.key] = decrypt(v.value_encrypted); } catch (_) {}
    }
    Object.assign(runtimeEnvVars, {
      APP_BASE_PATH: appBasePath,
      CRANE_URL: craneUrl,
      CRANE_INTERNAL_URL: craneInternalUrl,
      DATA_DIR: '/data',
    });

    const limits = parseResourceLimits(app.resource_limits);
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
    appendLog(`Container started: appcrane-${app.slug}-${env} (host port ${bePort})`);

    pruneOldImages(app.slug, 2);

    // 7. Update current symlink (remove old even if target is gone)
    const currentLink = resolve(join(appDir, 'current'));
    try { unlinkSync(currentLink); } catch (e) {} // ignore if doesn't exist
    symlinkSync(resolve(releaseDir), currentLink);
    appendLog('Updated current symlink');

    // 8. Update deployment record
    deployFinished = true;
    appendLog(`Deploy complete! Version: ${manifest.version || 'unknown'}`);
    db.prepare(`
      UPDATE deployments SET status = 'live', version = ?, commit_hash = ?, release_path = ?, finished_at = datetime('now'), log = ?
      WHERE id = ?
    `).run(manifest.version || 'unknown', commitHash, releaseDir, deployLog.join('\n'), deployId);

    // 9. Persist health endpoint from manifest
    if (manifest.be?.health) {
      db.prepare(`
        INSERT INTO health_configs (app_id, env, endpoint)
        VALUES (?, ?, ?)
        ON CONFLICT(app_id, env) DO UPDATE SET endpoint = excluded.endpoint
      `).run(app.id, env, manifest.be.health);
      appendLog(`Health endpoint set to ${manifest.be.health}`);
    }

    // 10. Ensure Caddy has routes for this app
    try {
      const { reloadCaddy } = await import('./caddy.js');
      const result = await reloadCaddy();
      if (result.success) {
        appendLog('Caddy config updated');
      } else {
        appendLog(`Caddy update skipped: ${result.error || 'not available'}`);
      }
    } catch (e) {
      appendLog(`Caddy update skipped: ${e.message}`);
    }

    // Cleanup old releases (keep last 5)
    try {
      const allReleases = readdirSync(releasesDir).sort().reverse();
      for (const dir of allReleases.slice(5)) {
        const fullPath = join(releasesDir, dir);
        rmSync(fullPath, { recursive: true, force: true });
        appendLog(`Cleaned up old release: ${dir}`);
      }
    } catch (e) {}

    // Send notification
    try {
      const { notifyDeploy } = await import('./emailService.js');
      await notifyDeploy(app, env, manifest.version || 'unknown', 'success');
    } catch (e) {}

    return { success: true, version: manifest.version };

  } catch (error) {
    appendLog(`DEPLOY FAILED: ${error.message}`);
    db.prepare(`
      UPDATE deployments SET status = 'failed', finished_at = datetime('now'), log = ?
      WHERE id = ?
    `).run(deployLog.join('\n'), deployId);

    // Send failure notification
    try {
      const { notifyDeploy } = await import('./emailService.js');
      await notifyDeploy(app, env, 'unknown', 'failed', error.message);
    } catch (e) {}

    throw error;
  }
}
