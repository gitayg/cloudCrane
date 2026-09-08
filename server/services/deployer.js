import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, symlinkSync, cpSync, writeFileSync, readlinkSync } from 'fs';
import { join, resolve, basename } from 'path';
import net from 'net';
import { getDb } from '../db.js';
import { decrypt } from './encryption.js';
import log from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { getIngressForApp } from './tcpIngress.js';
import { ensureCodebaseContext } from './appstudio/contextBuilder.js';
import { findEntry } from './catalogService.js';
import { credentialsFor } from './managedDb.js';

// ---------------------------------------------------------------------------
// Managed database credentials -> container environment
// ---------------------------------------------------------------------------
//
// 54 of the 64 catalogue entries need an external SQL database, and they do NOT
// agree on what to call it: BookStack reads DB_HOST/DB_USERNAME/DB_PASSWORD/
// DB_DATABASE, Baserow reads DATABASE_HOST/DATABASE_USER/..., Outline reads a
// single DATABASE_URL, Tryton reads DB_HOSTNAME and gets its database name from
// somewhere else entirely. The manifest records each entry's own spelling in
// `needs.env` / `needs.url_env`, so injection is a lookup, not a convention.
//
// The link from an app row back to its manifest entry is `apps.catalog_slug`,
// written at install time. Matching on github_url or image_ref instead was
// rejected: a user can edit either after creation, and a wrong match sets
// ANOTHER app's variable names.
//
// This module never provisions. If the app has no provisioned database the
// deploy proceeds with nothing injected — a deploy path that quietly creates
// infrastructure is a surprise, and provisioning is an explicit action.

/**
 * Connection URL for a managed database, in the `scheme://user:pass@host:port/db`
 * form the url_env entries expect.
 *
 * THE PASSWORD IS PERCENT-ENCODED HERE rather than reused from
 * managedDb.connectionFor()'s `url`. Today's generated passwords are base64url
 * and need no escaping, but SAFE_PASSWORD also admits operator-supplied and
 * migrated values, and one '@' or '/' in a password turns a connection string
 * into a different host with no error anywhere — the app just cannot connect.
 * Encoding costs nothing and removes the failure mode.
 */
export function managedDbUrl(creds) {
  const scheme = String(creds.url || '').split('://')[0]
    || (creds.engine === 'mariadb' ? 'mysql' : 'postgresql');
  const auth = `${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.password)}`;
  return `${scheme}://${auth}@${creds.host}:${creds.port}/${creds.database}`;
}

/**
 * Map one catalogue entry's `needs` block onto real credentials, producing the
 * env vars THAT ENTRY'S IMAGE reads. Pure: no database, no docker, no logging.
 *
 * An entry may declare discrete fields, a single URL variable, or both (Metabase
 * and Baserow declare both, and upstream reads whichever is set). A field mapped
 * to null is skipped rather than injected empty — Tryton declares `name: null`
 * because its server does not read the database name from the environment at
 * all, and setting a blank DB_NAME there would be inventing a variable upstream
 * never asked for.
 */
export function buildManagedDbEnv(needs, creds) {
  if (!needs || !creds) return {};
  const byField = {
    host: creds.host,
    port: creds.port == null ? null : String(creds.port),
    name: creds.database,
    user: creds.username,
    password: creds.password,
  };
  const out = {};
  for (const [field, varName] of Object.entries(needs.env || {})) {
    if (typeof varName !== 'string' || !varName) continue;
    const value = byField[field];
    if (value == null) continue;
    out[varName] = value;
  }
  if (typeof needs.url_env === 'string' && needs.url_env) {
    out[needs.url_env] = managedDbUrl(creds);
  }
  return out;
}

/**
 * Inject an app's managed-database credentials into a runtime env map, under the
 * variable names its catalogue entry declares.
 *
 * PRECEDENCE — the app's OWN env var always wins. Someone who set DB_HOST by
 * hand is pointing the app at a database they chose, very possibly one holding
 * their data; silently overriding it would repoint a live app at an empty
 * managed database and look like data loss. `claimedKeys` extends that to vars
 * the user set but which failed to decrypt: the key is still theirs, and filling
 * the gap with a managed credential would substitute a different database for
 * the one they configured.
 *
 * Mutates `runtimeEnvVars`. Returns key NAMES only — the caller logs this, and
 * a password must never reach a log line.
 */
export function applyManagedDbEnv(app, runtimeEnvVars, claimedKeys = []) {
  const result = { engine: null, injected: [], deferred: [], reason: null };

  const catalogSlug = app?.catalog_slug;
  if (!catalogSlug) { result.reason = 'app was not installed from the catalogue'; return result; }

  const entry = findEntry(catalogSlug);
  if (!entry) { result.reason = `no catalogue entry '${catalogSlug}'`; return result; }
  const needs = entry.needs;
  if (!needs?.engine) { result.reason = `catalogue entry '${catalogSlug}' needs no database`; return result; }
  result.engine = needs.engine;

  // No provisioned database (never provisioned, or an engine managedDb does not
  // support — several entries name mongo, which it does not). Inject nothing and
  // let the app fail exactly the way it does today.
  let creds = null;
  try { creds = credentialsFor({ appId: app.id }, needs.engine); }
  catch (_) { creds = null; }
  if (!creds) { result.reason = `no provisioned ${needs.engine} database for this app`; return result; }

  const claimed = new Set([...Object.keys(runtimeEnvVars), ...claimedKeys]);
  for (const [key, value] of Object.entries(buildManagedDbEnv(needs, creds))) {
    if (claimed.has(key)) { result.deferred.push(key); continue; }
    runtimeEnvVars[key] = value;
    result.injected.push(key);
  }
  return result;
}

// Prune old release checkouts under <appDir>/releases, keeping the newest
// `keep` plus the currently-live release (the `current` symlink target), which
// is NEVER deleted even if it isn't among the newest. Release dir names are
// timestamp-prefixed, so lexicographic sort == chronological. Best-effort:
// individual rm failures are swallowed so one undeletable dir can't abort a
// deploy. Runs at the start of every deploy AND in the failure handler, not
// just on success — a repeatedly-failing app used to accumulate half-cloned
// `<ts>-git` dirs until the disk filled (ENOSPC on mkdir).
function pruneOldReleases(releasesDir, appDir, keep = 5, appendLog = () => {}) {
  let liveBase = null;
  try {
    const link = join(appDir, 'current');
    if (existsSync(link)) liveBase = basename(readlinkSync(link));
  } catch (_) { /* no/broken symlink — nothing to protect */ }

  let entries;
  try { entries = readdirSync(releasesDir); } catch (_) { return; }
  const sorted = entries.sort().reverse(); // newest-first
  let kept = 0;
  for (const dir of sorted) {
    if (dir === liveBase) continue;   // never delete the live release
    kept++;
    if (kept <= keep) continue;       // keep the newest `keep` non-live dirs
    try {
      rmSync(join(releasesDir, dir), { recursive: true, force: true });
      appendLog(`Pruned old release: ${dir}`);
    } catch (_) { /* best-effort */ }
  }
}

// v2.7.31: a deploy that hasn't moved past these states in this long is
// treated as orphaned (process died mid-build without the boot sweep, or a
// build hung past any plausible duration) — so it can be reclaimed instead of
// blocking deploys forever. Real builds finish in well under a minute or two.
const STALE_DEPLOY_SECONDS = 30 * 60;

/**
 * v2.7.31: deploy concurrency guard. Refuses a new deploy when one is already
 * in flight for the same app+env. Without this, a slow/hung build plus repeated
 * triggers (rapid "Redeploy" clicks, an MCP/agent loop) spawned unbounded
 * concurrent `docker build`s that starved each other and never finished —
 * leaving a pile of stuck `building` rows (deploy storm).
 *
 * Stale in-flight rows (older than STALE_DEPLOY_SECONDS) are reclaimed —
 * marked failed — and do NOT block, so a genuinely-stuck build can't wedge an
 * app's deploys permanently. Call BEFORE inserting the new deployment row.
 *
 * Throws AppError(409, DEPLOY_IN_PROGRESS) when a fresh deploy is in flight.
 */
export function assertNoInflightDeploy(db, appId, env, slug) {
  const rows = db.prepare(`
    SELECT id, (strftime('%s','now') - strftime('%s', started_at)) AS age_s
    FROM deployments
    WHERE app_id = ? AND env = ? AND status IN ('pending','building','deploying')
  `).all(appId, env);
  if (rows.length === 0) return;

  const newest = rows.reduce((a, b) => (a.id > b.id ? a : b));
  if (newest.age_s == null || newest.age_s < STALE_DEPLOY_SECONDS) {
    throw new AppError(
      `A deploy is already in progress for ${slug}/${env} (#${newest.id}). ` +
      `Wait for it to finish before starting another.`,
      409, 'DEPLOY_IN_PROGRESS'
    );
  }

  // All in-flight rows are stale → reclaim them so the new deploy can proceed.
  const ids = rows.map(r => r.id);
  db.prepare(
    `UPDATE deployments SET status='failed', finished_at=datetime('now'),
       log = COALESCE(log || char(10), '') || '[Reclaimed: stale in-flight deploy superseded by a newer deploy]'
     WHERE id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids);
  log.warn(`Reclaimed ${ids.length} stale in-flight deploy(s) for ${slug}/${env}: ${ids.join(', ')}`);
}

/**
 * Health-endpoint contract for AppCrane apps:
 *   - Responds 200 within the timeout
 *   - Body is JSON
 *   - Body has both `status` and `version` fields (any non-empty value)
 *
 * Pre-v2.2.11 the deployer only ran a health check when manifest.be.health
 * was explicitly declared; apps without one deployed "successfully" and
 * then sat with no health monitor data forever. Now health is mandatory:
 * if the manifest doesn't say where, we assume `/api/health` and require
 * it to satisfy the contract above.
 *
 * Returns:
 *   { ok: true }                                  on contract met
 *   { ok: false, reason: 'timeout', detail }      no 200 within window
 *   { ok: false, reason: 'not_json', detail }     200 but body wasn't JSON
 *   { ok: false, reason: 'missing_fields', detail } JSON but lacks status/version
 */
// v2.6.15: classify the network-level failure mode that bubbles up from
// undici (Node's fetch implementation). "fetch failed" alone doesn't tell
// you whether to look at your CMD, your listen(), or AppCrane's network —
// `e.cause?.code` does. Map the common codes to a human label so the
// deploy log says "connection refused — process running but port not
// open" instead of "fetch failed".
function classifyFetchError(e) {
  const code = e?.cause?.code || e?.code || '';
  const messageCue = String(e?.cause?.message || e?.message || '');
  switch (code) {
    case 'ECONNREFUSED':
      return { code, label: 'connection refused', hint: 'Process not yet listening on the port, or listening on a different interface than 0.0.0.0' };
    case 'ECONNRESET':
      return { code, label: 'connection reset',   hint: 'Port opened then the server crashed/closed mid-handshake. Check app logs for a panic.' };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return { code: code || 'ETIMEDOUT', label: 'connection timeout', hint: 'Port might be accepting but never responding. Container blocked? Loopback firewalled?' };
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return { code, label: 'response timeout', hint: 'Port opened and accepted, but the app never wrote a response. Synchronous CPU-bound work blocking the event loop?' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code, label: 'DNS failure', hint: 'Hostname unresolvable — unusual for a localhost probe; check the URL.' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { code, label: 'host unreachable', hint: 'Routing problem on the AppCrane host itself.' };
    default:
      if (/aborted|signal/i.test(messageCue)) return { code: 'ABORT', label: 'timeout (3s per attempt)', hint: 'Server accepted but never replied within 3s.' };
      return { code: code || 'UNKNOWN', label: e?.message || 'fetch failed', hint: '' };
  }
}

async function probeHealthEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastErrorClass = null;
  let lastStatus = null;
  let lastBodyPreview = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      lastStatus = res.status;
      if (res.ok) {
        const text = await res.text();
        lastBodyPreview = text.slice(0, 200);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return {
            ok: false,
            reason: 'not_json',
            detail: `Health endpoint returned 200 but body wasn't JSON. Got: ${JSON.stringify(text.slice(0, 80))}. Expected: {"status": "ok", "version": "<your-app-version>"}`,
          };
        }
        if (body && typeof body === 'object' && body.status !== undefined && body.version !== undefined) {
          return { ok: true };
        }
        return {
          ok: false,
          reason: 'missing_fields',
          detail: `Health endpoint returned JSON but missing required fields. Got: ${JSON.stringify(body).slice(0, 120)}. Expected both "status" and "version" fields.`,
        };
      }
    } catch (e) {
      lastErrorClass = classifyFetchError(e);
      lastError = lastErrorClass.label + (lastErrorClass.code && lastErrorClass.code !== 'UNKNOWN' ? ` [${lastErrorClass.code}]` : '');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const cls = lastErrorClass;
  return {
    ok: false,
    reason: 'timeout',
    errorCode: cls?.code || null,
    detail: lastError
      ? `No healthy response within ${timeoutMs}ms. Last failure: ${lastError}${cls?.hint ? `. ${cls.hint}` : ''}`
      : `No healthy response within ${timeoutMs}ms (last status: ${lastStatus ?? 'no response'}, last body: ${JSON.stringify(lastBodyPreview ?? '')})`,
  };
}

/**
 * Deploy-time TCP probe — the tcp-ingress counterpart of probeHealthEndpoint,
 * and deliberately the same shape as healthChecker.js's probeTcp so a deploy
 * and the periodic checker agree on what "up" means for a tcp app: a completed
 * TCP handshake on the loopback port the container publishes.
 *
 * Same retry envelope as the HTTP gate — attempts until `timeoutMs` elapses,
 * 2s between them — because a container needs the same few seconds to bind
 * whatever protocol it speaks. Each attempt gets healthChecker's 5s connect
 * budget, clamped to whatever is left of the envelope so the gate cannot
 * overrun it.
 *
 * The v2.6.10 lesson applies here exactly as it does to the fetch path: report
 * the errno. ECONNREFUSED (nothing bound), ETIMEDOUT (bound but wedged, or
 * packets black-holed) and EHOSTUNREACH send an operator down completely
 * different paths, and a probe that only says "failed" is the silent failure
 * the classifyFetchError work exists to prevent.
 */
const TCP_ATTEMPT_TIMEOUT_MS = 5000;

function tcpConnectOnce(host, port, timeoutMs) {
  // Named `settle` rather than `resolve`: this module imports path.resolve.
  return new Promise((settle) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      settle(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, code: 'ETIMEDOUT', label: `no TCP handshake within ${timeoutMs}ms` }));
    socket.once('error', (e) => done({ ok: false, code: e.code || 'UNKNOWN', label: e.message }));
  });
}

async function probeTcpListener(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const attemptMs = Math.min(TCP_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
    const result = await tcpConnectOnce(host, port, attemptMs);
    if (result.ok) return { ok: true };
    last = result;
    await new Promise(r => setTimeout(r, 2000));
  }

  return {
    ok: false,
    reason: 'timeout',
    errorCode: last?.code || null,
    detail: `No TCP connection accepted on ${host}:${port} within ${timeoutMs}ms. ` +
      `Last failure: ${last?.label || 'none recorded'}${last?.code ? ` [${last.code}]` : ''}`,
  };
}

/**
 * Post-deploy probe — fetches the user-visible index page through Caddy and
 * verifies every asset reference (src=/href=) returns non-404. Catches the
 * "container is up, /api/health is green, users see a white page" failure
 * mode where the frontend asset URLs don't resolve through Caddy's routing
 * for some reason (missing dist, bad APP_BASE_PATH, mis-routed slug, etc.).
 *
 * Returns one of:
 *   { status: 'ok' }
 *   { status: 'missing', missing: [...refs that 404'd] }
 *   { status: 'inconclusive', reason: 'why we couldn't tell' }
 */
async function probeFrontendAssets(slug, env) {
  const caddyPort = process.env.CADDY_HTTP_PORT || '80';
  const basePath = env === 'production' ? `/${slug}/` : `/${slug}-sandbox/`;
  const indexUrl = `http://127.0.0.1:${caddyPort}${basePath}`;

  let html;
  try {
    const r = await fetch(indexUrl, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      return { status: 'inconclusive', reason: `Caddy returned ${r.status} (likely SSO/auth redirect); cannot probe assets without a token` };
    }
    if (!r.ok) return { status: 'inconclusive', reason: `index page returned ${r.status}` };
    html = await r.text();
  } catch (e) {
    return { status: 'inconclusive', reason: `index fetch failed: ${e.message}` };
  }

  const refs = [];
  const matcher = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const m of html.matchAll(matcher)) {
    const ref = m[1];
    if (/^(https?:|data:|\/\/|mailto:|tel:|#)/i.test(ref)) continue;
    refs.push(ref);
  }
  if (!refs.length) return { status: 'inconclusive', reason: 'index.html has no asset references to probe' };

  const missing = [];
  for (const ref of refs) {
    const url = ref.startsWith('/')
      ? `http://127.0.0.1:${caddyPort}${ref}`
      : `http://127.0.0.1:${caddyPort}${basePath}${ref.replace(/^\.\//, '')}`;
    try {
      const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000), redirect: 'manual' });
      if (r.status === 404) missing.push(ref);
    } catch (_) { /* network error — don't false-positive */ }
  }

  return missing.length ? { status: 'missing', missing } : { status: 'ok' };
}

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
 * 6. Start Docker container on allocated ports
 * 7. Health check
 * 8. Swap 'current' symlink
 * 9. Cleanup old releases (keep last 5)
 */
/**
 * Roll an env back to a prior release ("release as an object"). Re-runs a
 * recorded release from its on-disk release_path via the normal deploy
 * pipeline (which re-uses the cached per-commit image, so no rebuild when the
 * image is still retained). Records a NEW deployment, marks the previously
 * live one rolled_back, and health-checks like any deploy.
 *
 * Shared by POST /api/apps/:slug/rollback/:env and the appcrane_rollback MCP
 * tool so REST and MCP stay in lockstep. Caller is responsible for authz
 * (production rollback must be gated by deploy.production).
 *
 * @param {object} app   - app row (needs id, slug, slot)
 * @param {string} env   - 'production' | 'sandbox'
 * @param {number|undefined} deploymentId - target release id; omit for the previous one
 * @param {number} userId - who triggered it (for the audit/deployed_by column)
 */
export async function rollbackApp(app, env, deploymentId, userId) {
  if (!['production', 'sandbox'].includes(env)) {
    throw new AppError('env must be production or sandbox', 400, 'VALIDATION');
  }
  const db = getDb();

  let target;
  if (deploymentId) {
    target = db.prepare(
      "SELECT * FROM deployments WHERE id = ? AND app_id = ? AND env = ? AND status IN ('live', 'rolled_back')"
    ).get(deploymentId, app.id, env);
  } else {
    // Previous live-or-rolled-back deployment (skip the current live one).
    const history = db.prepare(
      "SELECT * FROM deployments WHERE app_id = ? AND env = ? AND status IN ('live', 'rolled_back') ORDER BY started_at DESC LIMIT 2"
    ).all(app.id, env);
    target = history[1];
  }

  if (!target) throw new AppError('No previous deployment to roll back to', 404, 'NO_ROLLBACK_TARGET');

  // An image app rolls back by re-running the digest it ran before, and it has
  // to be handled BEFORE the release_path check below — an image deploy never
  // writes a release directory, so that check would reject every image
  // rollback as a "pre-rollback-support deploy". Without this branch an image
  // app could be deployed and never recovered, which is the one thing a deploy
  // platform cannot leave missing.
  if (app.source_type === 'image') {
    if (!target.image_ref) {
      throw new AppError(
        `Deployment #${target.id} has no image_ref recorded, so there is no digest to restore. ` +
        `Deploy the app once more to record one, or roll back to a deployment that has it.`,
        409, 'NO_IMAGE_REF',
      );
    }

    // target.image_ref is already the digest-pinned ref deployApp resolved and
    // started. It is passed through as opts.imageRef rather than letting
    // deployApp re-read apps.image_ref, because the app row holds the
    // operator's CURRENT request — if the tag moved (or was edited to a
    // different image) since that deployment, re-resolving it would "roll
    // back" to bytes nobody has ever run here.
    const rollbackInsert = db.prepare(`
      INSERT INTO deployments (app_id, env, version, status, commit_hash, image_ref, deployed_by, log)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(app.id, env, target.version, target.commit_hash, target.image_ref, userId,
      `Rollback to deployment #${target.id} — restarting image ${target.image_ref}`);
    const newId = rollbackInsert.lastInsertRowid;

    db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE app_id = ? AND env = ? AND status = 'live' AND id != ?")
      .run(app.id, env, newId);

    const { getPortsForSlot } = await import('./portAllocator.js');
    const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    const ports = getPortsForSlot(fullApp.slot);
    await deployApp(newId, fullApp, env, ports, {
      imageRef: target.image_ref,
      commitHash: target.commit_hash,
    });

    log.info(`Rollback: ${app.slug}/${env} → deployment #${target.id} (image ${target.image_ref}) by user ${userId}`);
    return {
      deployment_id: newId, rollback_to: target.id, version: target.version,
      commit_hash: target.commit_hash, image_ref: target.image_ref,
    };
  }

  if (!target.release_path) throw new AppError('Target deployment has no release_path recorded (pre-rollback-support deploy)', 409, 'NO_RELEASE_PATH');
  if (!existsSync(target.release_path)) throw new AppError(`Release directory missing on disk: ${target.release_path}`, 410, 'RELEASE_GONE');

  const dataDir = resolve(process.env.DATA_DIR || './data');
  const appDir = resolve(join(dataDir, 'apps', app.slug, env));
  if (!appDir.startsWith(dataDir)) throw new AppError('Security: appDir outside dataDir', 500, 'PATH_TRAVERSAL');
  const releaseDir = resolve(target.release_path);
  if (!releaseDir.startsWith(dataDir)) throw new AppError('Security: release_path outside dataDir', 500, 'PATH_TRAVERSAL');

  // Swap the current symlink to the rollback target.
  const currentLink = join(appDir, 'current');
  try { unlinkSync(currentLink); } catch (_) {}
  symlinkSync(releaseDir, currentLink);

  const rollbackInsert = db.prepare(`
    INSERT INTO deployments (app_id, env, version, status, commit_hash, release_path, deployed_by, log)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(app.id, env, target.version, target.commit_hash, releaseDir, userId, `Rollback to deployment #${target.id}`);
  const newId = rollbackInsert.lastInsertRowid;

  // v2.53.0: provenance travels with the rollback. Without this the restored
  // deployment row carries the original commit_hash but none of the artifact
  // identity, so the release that is actually running looks less traceable than
  // the one it replaced — the wrong direction for a recovery action.
  db.prepare(`
    UPDATE deployments
       SET artifact_sha256 = ?, artifact_bytes = ?, artifact_filename = ?, declared_commit_sha = ?
     WHERE id = ?
  `).run(
    target.artifact_sha256 ?? null, target.artifact_bytes ?? null,
    target.artifact_filename ?? null, target.declared_commit_sha ?? null, newId,
  );

  // Mark the previously-live deployment as rolled_back.
  db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE app_id = ? AND env = ? AND status = 'live' AND id != ?")
    .run(app.id, env, newId);

  const { getPortsForSlot } = await import('./portAllocator.js');
  const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
  const ports = getPortsForSlot(fullApp.slot);
  await deployApp(newId, fullApp, env, ports, {
    preExtractedDir: releaseDir,
    commitHash: target.commit_hash,
    expectTreeSha: target.tree_sha256 || null,
  });

  log.info(`Rollback: ${app.slug}/${env} → deployment #${target.id} (v${target.version || '?'}) by user ${userId}`);
  return { deployment_id: newId, rollback_to: target.id, version: target.version, commit_hash: target.commit_hash };
}

/**
 * Promote the current live SANDBOX release to production — the gated
 * sandbox→prod path (Shipper's "promote a tested, healthy release" idea).
 *
 * Gate: there must be a live sandbox deployment AND it must be currently
 * healthy (health_state.is_down = 0) — we don't ship a broken sandbox to prod.
 * The promoted production release is then health-checked by deployApp, which
 * reverts to the previous prod image on failure, so a bad promote can't take
 * production down.
 *
 * - github apps: a FRESH production build (so the bundler bakes the prod
 *   base path /<slug>/ rather than the sandbox's /<slug>-sandbox/).
 * - managed/upload apps: copies the EXACT tested sandbox release tree into
 *   production (byte-identical artifact), rewriting only the prod .env.
 *
 * Shared by POST /api/apps/:slug/promote and the appcrane_promote MCP tool.
 * Caller is responsible for authz (must require deploy.production).
 */
export async function promoteApp(app, userId) {
  const db = getDb();

  const sandboxDeploy = db.prepare(
    "SELECT * FROM deployments WHERE app_id = ? AND env = 'sandbox' AND status = 'live' ORDER BY started_at DESC LIMIT 1"
  ).get(app.id);
  if (!sandboxDeploy) throw new AppError('No live sandbox deployment to promote', 400, 'NO_SANDBOX_DEPLOY');

  // v2.7.12: promotion gate — only advance a HEALTHY sandbox to production.
  const sbHealth = db.prepare("SELECT is_down FROM health_state WHERE app_id = ? AND env = 'sandbox'").get(app.id);
  if (sbHealth && sbHealth.is_down) {
    throw new AppError('Sandbox is currently unhealthy — fix sandbox before promoting it to production.', 409, 'SANDBOX_UNHEALTHY');
  }

  const { getPortsForSlot } = await import('./portAllocator.js');
  const prodPorts = getPortsForSlot(app.slot);

  // Image apps promote by running the EXACT digest sandbox ran. Both branches
  // below assume a tree — one rebuilds from a commit, the other copies a
  // release directory — and an image app has neither, so it would fall through
  // to the copy path's "Sandbox release directory missing on disk" error.
  //
  // No rebuild question arises here: the github branch rebuilds so the bundler
  // bakes the prod base path, and a prebuilt image has no build step to bake
  // anything into. The bytes tested in sandbox are the bytes promoted.
  if (app.source_type === 'image') {
    if (!sandboxDeploy.image_ref) {
      throw new AppError(
        `Sandbox deployment #${sandboxDeploy.id} has no image_ref recorded, so there is no digest to promote. ` +
        `Redeploy sandbox to record one.`,
        409, 'NO_IMAGE_REF',
      );
    }

    const ins = db.prepare(`
      INSERT INTO deployments (app_id, env, version, status, commit_hash, image_ref, deployed_by, log)
      VALUES (?, 'production', ?, 'pending', ?, ?, ?, ?)
    `).run(app.id, sandboxDeploy.version, sandboxDeploy.commit_hash, sandboxDeploy.image_ref, userId,
      `Promote from sandbox #${sandboxDeploy.id} — same image ${sandboxDeploy.image_ref}`);
    const newDeployId = ins.lastInsertRowid;

    const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    // Fire-and-forget for the same reason as the branches below: an awaited
    // deployApp outlives the MCP socket timeout and the caller sees a closed
    // connection for a promotion that succeeded.
    deployApp(newDeployId, fullApp, 'production', prodPorts, {
      imageRef: sandboxDeploy.image_ref,
      commitHash: sandboxDeploy.commit_hash,
    }).catch(err => {
      log.error(`Promote (image) ${newDeployId} for ${app.slug} failed: ${err.message}`);
    });

    log.info(`Promote: ${app.slug} sandbox #${sandboxDeploy.id} → production (image ${sandboxDeploy.image_ref}, deployment #${newDeployId}) by user ${userId}`);
    return {
      deployment_id: newDeployId, status: 'pending', mode: 'image',
      version: sandboxDeploy.version, from_sandbox: sandboxDeploy.id,
      image_ref: sandboxDeploy.image_ref,
    };
  }

  // GitHub-sourced apps: fresh production build so the bundler picks up
  // VITE_BASE_PATH=/<slug>/ instead of the sandbox's /<slug>-sandbox/.
  // v2.21.23: managed apps promote via a fresh clone-and-build at the exact
  // sandbox commit too — same as github. The old managed path copied the
  // sandbox release tree, and its cpSync filter strips every top-level entry
  // named `data` (reserved for the runtime volume symlink). That also deleted a
  // git-tracked `data/` SOURCE dir that an app's Dockerfile `COPY data ./data`
  // needs at build time — so the prod build failed ("file not found in build
  // context: stat data") while sandbox (built from a fresh clone) succeeded.
  // Cloning fresh at the tested commit removes the collision entirely. Only
  // upload apps (no repo to clone) keep the copy path below.
  if ((app.source_type === 'github' || app.source_type === 'managed') && app.github_url) {
    const freshResult = db.prepare(`
      INSERT INTO deployments (app_id, env, version, status, commit_hash, deployed_by, log)
      VALUES (?, 'production', ?, 'pending', ?, ?, ?)
    `).run(app.id, sandboxDeploy.version, sandboxDeploy.commit_hash, userId,
      `Promote from sandbox #${sandboxDeploy.id} — fresh production build @ ${sandboxDeploy.commit_hash || 'HEAD'}`);
    const freshDeployId = freshResult.lastInsertRowid;
    // v2.7.12: build production from the EXACT sandbox commit (targetCommit),
    // not the branch tip — production ships precisely what was tested in
    // sandbox. A fresh build (not the sandbox image) is still required so the
    // bundler bakes the prod base path /<slug>/. deployApp clones managed repos
    // with the service-account token, so this works for source_type='managed'.
    deployApp(freshDeployId, app, 'production', prodPorts, { targetCommit: sandboxDeploy.commit_hash }).catch(err => {
      log.error(`Promote build ${freshDeployId} for ${app.slug} failed: ${err.message}`);
    });
    return { deployment_id: freshDeployId, status: 'pending', mode: 'rebuild', version: sandboxDeploy.version, from_sandbox: sandboxDeploy.id };
  }

  // Upload apps (no git repo): copy the exact sandbox release tree into production.
  if (!sandboxDeploy.release_path || !existsSync(sandboxDeploy.release_path)) {
    throw new AppError('Sandbox release directory missing on disk (pre-promote-support deploy?)', 409, 'NO_RELEASE_PATH');
  }

  const dataDir = resolve(process.env.DATA_DIR || './data');
  const prodAppDir = resolve(join(dataDir, 'apps', app.slug, 'production'));
  const prodReleasesDir = resolve(join(prodAppDir, 'releases'));
  const prodSharedDir = resolve(join(prodAppDir, 'shared'));
  const sandboxReleaseDir = resolve(sandboxDeploy.release_path);
  for (const p of [prodAppDir, prodReleasesDir, prodSharedDir, sandboxReleaseDir]) {
    if (!p.startsWith(dataDir)) throw new AppError('Security: path outside dataDir', 500, 'PATH_TRAVERSAL');
  }

  const insertResult = db.prepare(`
    INSERT INTO deployments (app_id, env, version, status, commit_hash, deployed_by, log)
    VALUES (?, 'production', ?, 'deploying', ?, ?, ?)
  `).run(app.id, sandboxDeploy.version, sandboxDeploy.commit_hash, userId,
    `Promoted from sandbox deployment #${sandboxDeploy.id}`);
  const newDeployId = insertResult.lastInsertRowid;

  try {
    // 1. Copy sandbox release tree into production releases/ (skip .env + data symlinks).
    const timestamp = Date.now();
    const newReleaseDir = resolve(join(prodReleasesDir, `${timestamp}-promote`));
    cpSync(sandboxReleaseDir, newReleaseDir, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        const base = src.split('/').pop();
        if (base === '.env' || base === 'data') return false;
        return true;
      },
    });

    // 2. Rewrite production .env from production env_vars (NEVER copy sandbox env).
    const envRows = db.prepare('SELECT key, value_encrypted FROM env_vars WHERE app_id = ? AND env = ?').all(app.id, 'production');
    const envContent = envRows.map(v => {
      try { return `${v.key}=${decrypt(v.value_encrypted)}`; }
      catch (_) { return `# ERROR decrypting ${v.key}`; }
    }).join('\n');
    const fullEnv = `${envContent}\nPORT=${prodPorts.prod_be}\nFE_PORT=${prodPorts.prod_fe}\nNODE_ENV=production\n`;
    writeFileSync(join(prodSharedDir, '.env.production'), fullEnv);
    const envDest = join(newReleaseDir, '.env');
    try { unlinkSync(envDest); } catch (_) {}
    symlinkSync(join(prodSharedDir, '.env.production'), envDest);

    // 3. Symlink production shared /data.
    const dataLink = join(newReleaseDir, 'data');
    try { unlinkSync(dataLink); } catch (_) {}
    try { symlinkSync(join(prodSharedDir, 'data'), dataLink); } catch (_) {}

    // 4. Swap current symlink.
    const currentLink = join(prodAppDir, 'current');
    try { unlinkSync(currentLink); } catch (_) {}
    symlinkSync(newReleaseDir, currentLink);

    // 5. Mark any previously-live prod release as rolled_back, then update
    //    the new release row with its on-disk path so observers can find it
    //    while the build runs. release_path is the visible "this is the prod
    //    current" pointer; deployApp will flip status to 'live' once health
    //    passes (or 'failed' on revert), reusing its standard machinery.
    db.prepare("UPDATE deployments SET status = 'rolled_back' WHERE app_id = ? AND env = 'production' AND status = 'live'").run(app.id);
    db.prepare("UPDATE deployments SET release_path = ? WHERE id = ?").run(newReleaseDir, newDeployId);

    // 6. Rebuild production image + start fresh container, health-checked.
    //    v2.7.22: fire-and-forget instead of `await`. The managed-copy path
    //    used to block the caller until deployApp finished (build + health
    //    check, often 30-90s), which exceeded MCP's socket timeout —
    //    appcrane_promote returned "socket connection closed unexpectedly"
    //    even when the promotion succeeded. Now we return immediately with
    //    deployment_id + status='pending' (mirrors the github branch above);
    //    deployApp marks the row live/failed itself when it's done. The
    //    caller polls via appcrane_get_logs / appcrane_wait_deploy.
    const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
    deployApp(newDeployId, fullApp, 'production', prodPorts, {
      preExtractedDir: newReleaseDir,
      commitHash: sandboxDeploy.commit_hash,
    }).catch(e => {
      log.error(`Promote deploy failed for ${app.slug}-production (deployment #${newDeployId}): ${e.message}`);
    });

    log.info(`Promote: ${app.slug} sandbox #${sandboxDeploy.id} → production (deployment #${newDeployId}, pending) by user ${userId}`);
    return { deployment_id: newDeployId, status: 'pending', mode: 'copy', version: sandboxDeploy.version, from_sandbox: sandboxDeploy.id };
  } catch (e) {
    db.prepare("UPDATE deployments SET status = 'failed', finished_at = datetime('now'), log = ? WHERE id = ?").run(`Promote failed: ${e.message}`, newDeployId);
    throw new AppError(`Promote failed: ${e.message}`, 500, 'PROMOTE_FAILED');
  }
}

export async function deployApp(deployId, app, env, ports, opts = {}) {
  const db = getDb();

  // An image app has no release tree — no clone, no bundle, no `current`
  // symlink target. Every step below that reads a file out of a release
  // directory is skipped on this flag rather than being made to tolerate a
  // missing directory, because "tolerate" would mean an image deploy silently
  // taking the defaults meant for a source tree (no dist check, a generated
  // Dockerfile, a symlink verification that throws "has no package.json or
  // deployhub.json" on a directory that was never supposed to exist).
  const isImageDeploy = app.source_type === 'image';

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
  // v2.6.15: log the result of chown — silent failure was masking a
  // suspected first-deploy permissions issue (sub-bug C in the deploy
  // #178 report). Successful chown logs at info; failure logs the
  // underlying error so the operator can see EACCES / no-such-user.
  let chownDetail = null;
  try {
    execFileSync('chown', ['-R', '1000:1000', sharedData], { stdio: 'pipe', timeout: 30000 });
    chownDetail = `chown 1000:1000 ${sharedData} → ok`;
  } catch (e) {
    chownDetail = `chown 1000:1000 ${sharedData} → failed (${e?.stderr?.toString().trim() || e.message}). App may hit EACCES on /data writes if its container runs as a non-root user.`;
  }

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

  // v2.6.15: surface the data-volume chown result captured during dir
  // setup. Was silently swallowed; now visible in the deploy log so an
  // operator chasing "fetch failed" can rule volume permissions in/out.
  if (chownDetail) appendLog(chownDetail);

  // Hoisted so the failure handler can remove this attempt's checkout.
  let releaseDir;
  try {
    // Trim any accumulated release backlog BEFORE cloning, so an app whose disk
    // filled from repeated failed deploys can self-heal on its next attempt
    // instead of hitting ENOSPC again on mkdir. Never touches the live release.
    pruneOldReleases(releasesDir, appDir, 5, appendLog);

    // 1. Clone or locate release
    const timestamp = Date.now();
    let commitHash = 'unknown';
    // v2.5.16: capture the commit message too so the What's New dialog
    // has actual content to show end users on a version bump. Previously
    // only the webhook + manual-upload paths populated this column; the
    // dashboard / MCP deploy path left it NULL, so the dialog rendered a
    // version pill with no body.
    let commitMessage = null;
    // The digest-pinned reference this deploy actually starts, and the version
    // string to record for it. Both stay null for every source type that builds
    // from a tree.
    let pinnedImageRef = null;
    let imageVersion = null;

    // FIRST, ahead of opts.preExtractedDir. rollbackApp and promoteApp both
    // pass a pre-extracted directory for tree-based apps, and an image app has
    // no directory to pass — so if this branch came second, an image app's
    // rollback would either land in the release-directory chain or be
    // unreachable. source_type is the fact that decides; the options object
    // only narrows WHICH image.
    if (isImageDeploy) {
      // rollback/promote pass the exact digest ref recorded against the
      // deployment being restored. app.image_ref is the operator's request
      // ('odoo:19'), which may point at different bytes today than it did when
      // that deployment ran — using it for a rollback would restore a version
      // nobody chose.
      const requestedRef = opts.imageRef || app.image_ref;
      if (!requestedRef) {
        throw new Error(
          `App '${app.slug}' has source_type='image' but no image_ref set. ` +
          `Run appcrane_update_app slug='${app.slug}' image_ref='<name>:<tag>' ` +
          `(e.g. 'odoo:19' or 'ghcr.io/owner/app@sha256:<hex>').`
        );
      }

      const { parseImageRef, pullImage, resolveDigest } = await import('./imageSource.js');
      const parsed = parseImageRef(requestedRef);

      appendLog(`Pulling image ${requestedRef} …`);
      await pullImage(requestedRef);

      // A tag is a moving pointer on purpose — re-deploying 'odoo:19' is how
      // you pick up a patch release. That makes the tag useless as a record of
      // what ran, so the digest is resolved here and the CONTAINER IS STARTED
      // FROM THE DIGEST, not from the tag. Recording the digest while running
      // the tag would be a false record: the publisher can move the tag between
      // this inspect and the `docker run` below, and the deployment row would
      // then name bytes that were never started.
      const digest = await resolveDigest(requestedRef);
      pinnedImageRef = `${parsed.registry ? `${parsed.registry}/` : ''}${parsed.name}@${digest}`;
      commitHash = digest;

      appendLog(`Resolved ${requestedRef} → ${pinnedImageRef}`);
      db.prepare('UPDATE deployments SET image_ref = ? WHERE id = ?').run(pinnedImageRef, deployId);

      // deployments.version has to say something and there is no package.json
      // to read it out of. The tag is the only human-meaningful version an
      // image carries; a digest-only ref has no tag, so it falls back to the
      // short digest rather than the literal 'unknown'.
      imageVersion = parsed.tag || digest.slice('sha256:'.length, 'sha256:'.length + 12);
    } else if (opts.preExtractedDir) {
      releaseDir = resolve(opts.preExtractedDir);
      if (!releaseDir.startsWith(dataDir)) throw new Error('Security: preExtractedDir is outside data directory');
      commitHash = opts.commitHash || 'unknown';
      appendLog(`Using pre-extracted release: ${releaseDir.split('/').pop()}`);

      // v2.53.0: the upload path never reached verifyCommitSha — it lives in
      // the clone branch below — so an uploaded release was deployed with no
      // provenance statement in the log at all. Silence read as "nothing to
      // report" when the truth was "nothing was checked".
      //
      // What IS checkable here: the bundle is already gone (unlinked right
      // after extraction), but the release directory it produced is on disk and
      // its digest is re-computable. Record it now; on a rollback or re-deploy
      // of this same directory, compare it and say so either way.
      try {
        const { digestTree, isArtifactHash } = await import('./artifactDigest.js');
        const tree = digestTree(releaseDir);
        const prior = opts.expectTreeSha || null;

        if (isArtifactHash(commitHash)) {
          const art = db.prepare(
            'SELECT artifact_filename, artifact_bytes, declared_commit_sha FROM deployments WHERE id = ?'
          ).get(deployId) || {};
          appendLog(
            `Release identity: ${commitHash} (SHA-256 of the uploaded bundle, computed by AppCrane`
            + `${art.artifact_filename ? `: ${art.artifact_filename}` : ''}`
            + `${art.artifact_bytes ? `, ${art.artifact_bytes} bytes` : ''}).`,
          );
          if (art.declared_commit_sha) {
            appendLog(
              `Uploader declared commit_sha ${art.declared_commit_sha} — recorded as context, NOT verified. `
              + `The identity above is the one computed from the bytes.`,
            );
          }
        } else {
          appendLog(
            `Release identity: ${commitHash} — NOT a content digest. This release pre-dates artifact `
            + `hashing (or was recorded as 'unknown'), so nothing ties it to a specific set of bytes.`,
          );
        }

        if (prior && prior !== tree.sha256) {
          appendLog(
            `Release tree DRIFTED: recorded ${prior.slice(0, 12)}…, on disk now ${tree.sha256.slice(0, 12)}… `
            + `over ${tree.files} files. The directory changed since it was deployed. This is REPORTED, not `
            + `blocked — an app that writes logs or a database under its own release path drifts by running `
            + `normally, and failing a rollback on that would break recovery during the incident it is for. `
            + `If this app does not write into its release directory, treat the drift as unexplained.`,
          );
        } else if (prior) {
          appendLog(`Release tree verified: ${tree.sha256.slice(0, 12)}… unchanged across ${tree.files} files.`);
        } else {
          appendLog(`Release tree recorded: ${tree.sha256.slice(0, 12)}… over ${tree.files} files.`);
        }
        db.prepare('UPDATE deployments SET tree_sha256 = ? WHERE id = ?').run(tree.sha256, deployId);
      } catch (e) {
        // Digesting a tree is a reporting step. It must not be able to fail a
        // deploy that is otherwise fine.
        appendLog(`Release tree digest unavailable: ${e.message}. Provenance NOT recorded for this deploy.`);
      }
    } else if ((app.source_type === 'github' || app.source_type === 'managed') && app.github_url) {
      // v2.6.14: 'github' and 'managed' clone the same way; only the token
      // source differs. github = per-app PAT stored encrypted on the app
      // row. managed = the platform-wide service-account PAT in settings
      // (the same one appcrane_create_managed_app used to create the
      // AMC_<slug> repo). Pre-v2.6.14 the deployer only handled 'github'
      // and managed apps fell through to the "not deployable" error.
      const isManaged = app.source_type === 'managed';
      appendLog(`Cloning ${isManaged ? 'managed repo ' : ''}${app.github_url} (branch: ${app.branch || 'main'})...`);

      releaseDir = resolve(join(releasesDir, `${timestamp}-git`));
      mkdirSync(releaseDir, { recursive: true });

      let token = null;
      if (isManaged) {
        const { getServiceTokenInternal } = await import('./githubService.js');
        token = getServiceTokenInternal();
        if (!token) {
          throw new Error(
            `App '${app.slug}' is source_type='managed' but the GitHub service-account token is not configured on this AppCrane install. ` +
            `A platform_admin needs to set it at Settings → GitHub → "Service-account — AppCrane-managed repos" before managed apps can deploy.`
          );
        }
      } else if (app.github_token_encrypted) {
        token = decrypt(app.github_token_encrypted);
      }

      let cloneUrl = app.github_url;
      if (token) {
        const url = new URL(app.github_url);
        url.username = token;
        cloneUrl = url.toString();
      }

      try {
        execFileSync('git', [
          'clone', '--depth', '1',
          '--branch', app.branch || 'main',
          cloneUrl, releaseDir,
        ], { timeout: 120000, stdio: 'pipe' });
      } catch (err) {
        throw new Error(err.message.replaceAll(cloneUrl, app.github_url));
      }

      // v2.7.12: pin to an exact commit when asked (promote ships the EXACT
      // release tested in sandbox, not the branch tip which may have moved).
      // GitHub serves reachable full SHAs directly; fall back to deepening the
      // branch history so an abbreviated SHA (deployments.commit_hash is short)
      // still resolves, then check it out detached.
      if (opts.targetCommit && opts.targetCommit !== 'unknown') {
        appendLog(`Pinning to commit ${opts.targetCommit} (exact sandbox release)…`);
        let fetched = false;
        try {
          execFileSync('git', ['-C', releaseDir, 'fetch', '--depth', '1', 'origin', opts.targetCommit], { timeout: 120000, stdio: 'pipe' });
          fetched = true;
        } catch (_) { /* abbreviated SHA or not directly fetchable — deepen below */ }
        if (!fetched) {
          try {
            execFileSync('git', ['-C', releaseDir, 'fetch', '--depth', '200', 'origin', app.branch || 'main'], { timeout: 120000, stdio: 'pipe' });
          } catch (_) { /* best effort; checkout will surface a clear error if the commit is unreachable */ }
        }
        try {
          execFileSync('git', ['-C', releaseDir, 'checkout', '--detach', opts.targetCommit], { timeout: 30000, stdio: 'pipe' });
        } catch (err) {
          throw new Error(`Failed to check out commit ${opts.targetCommit} for promotion (is it on branch '${app.branch || 'main'}' within the last 200 commits?): ${String(err.message).replaceAll(cloneUrl, app.github_url)}`);
        }
      }

      // Get commit hash
      try {
        commitHash = execFileSync('git', ['-C', releaseDir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })
          .toString().trim();
      } catch (e) {}

      // Get commit message (subject + body). %s is the subject line,
      // %B includes body — we use %B and trim, capping at 2000 chars
      // so a verbose merge-commit body doesn't blow up the row.
      try {
        const raw = execFileSync('git', ['-C', releaseDir, 'log', '-1', '--format=%B'], { timeout: 5000 })
          .toString().trim();
        if (raw) commitMessage = raw.slice(0, 2000);
      } catch (e) { /* commitMessage stays null */ }

      appendLog(`Cloned successfully. Commit: ${commitHash}${commitMessage ? ` — ${commitMessage.split('\n')[0].slice(0, 80)}` : ''}`);

      // v2.3.6: cross-check local HEAD against GitHub's claim for this
      // branch. Mismatch = refuse deploy. supplyChain.authForApp already
      // handles both 'github' (per-app PAT) and 'managed' (service token),
      // so no change needed here for the managed addition.
      try {
        const { verifyCommitSha } = await import('./supplyChain.js');
        await verifyCommitSha(app, releaseDir, app.branch || 'main', appendLog);
      } catch (e) {
        // Genuine mismatch — abort the deploy. The verifier already
        // formatted a clear error; just rethrow.
        throw e;
      }
    } else if (app.source_type === 'upload') {
      // v2.53.2: redeploy an upload app from the release it is already running.
      //
      // v2.53.0 made 'upload' a real source type but only ever reached the
      // deploy path with opts.preExtractedDir set — a bundle in hand. Every
      // other trigger arrives without one: `appcrane_deploy`, a restart-style
      // redeploy, and the rename endpoint, which queues a redeploy for each live
      // environment after moving the app. All of them fell through to the final
      // `else` and threw "not deployable on this AppCrane install", which was
      // false — the release is right there on disk — and in the rename case it
      // ran after the containers had already been stopped, so the app went down
      // and stayed down until someone re-uploaded.
      //
      // Replaying the newest release is what these callers mean. It is the same
      // move managed_legacy makes, minus the deprecation: for an app with no
      // repo, the last artifact IS the source of truth.
      const releases = readdirSync(releasesDir)
        .filter(d => d.includes('upload'))
        .sort()
        .reverse();

      if (releases.length === 0) {
        throw new Error(
          `App '${app.slug}' has source_type='upload' but no release on disk to redeploy. ` +
          `Upload a bundle: POST /api/apps/${app.slug}/deploy/upload, or appcrane_deploy_artifact with a staged token.`
        );
      }

      releaseDir = resolve(join(releasesDir, releases[0]));
      appendLog(`Redeploying the current uploaded release: ${releases[0]}`);
    } else if (app.source_type === 'managed_legacy') {
      // v2.3.1: deprecation branch — replays the last upload-time release
      // dir for apps that pre-date the service-account model. Upload as a
      // feature is gone (POST /api/apps/:slug/upload/:env was removed) so
      // this code only finds artifacts written by older versions of
      // AppCrane. Promote these apps to 'github' or 'managed' to retire it.
      const releases = readdirSync(releasesDir)
        .filter(d => d.includes('upload'))
        .sort()
        .reverse();

      if (releases.length === 0) {
        throw new Error(
          `No legacy release found for app '${app.slug}'. Upload-based deploys were removed in v2.3.1; ` +
          `promote this app to source_type='github' (with a github_url) or 'managed' (service-account repo) to deploy fresh.`
        );
      }

      releaseDir = resolve(join(releasesDir, releases[0]));
      appendLog(`Using legacy upload release (deprecated): ${releases[0]}`);
    } else {
      // v2.6.14: be specific about WHAT'S WRONG instead of recommending
      // a value the app might already have. The pre-fix message said
      // "Set source_type to 'github' or 'managed'" — which read as
      // contradictory for an app whose source_type was already 'managed'
      // but missing github_url (created out-of-band, or row corrupted).
      const st = app.source_type || '(unset)';
      if ((st === 'github' || st === 'managed') && !app.github_url) {
        throw new Error(
          `App '${app.slug}' has source_type='${st}' but no github_url set. ` +
          `Run appcrane_update_app slug='${app.slug}' github_url='https://github.com/<owner>/<repo>' (and, for source_type='github', a github_token too).`
        );
      }
      throw new Error(
        `App '${app.slug}' has source_type='${st}' which is not deployable on this AppCrane install. ` +
        `Valid source_types are 'github' (per-app PAT, github_url required) and 'managed' (service-account-owned AMC_<slug> repo, no per-app PAT). ` +
        `Run appcrane_update_app to set a deployable source_type.`
      );
    }

    // v2.5.22: auto-pickup app icon from the release dir.
    //
    // Convention: an app can ship a tile icon by committing
    // `public/icon.png` (or .svg / .webp / .jpg) at the repo root. On
    // each deploy we copy it to <DATA_DIR>/apps/<slug>/icon.<ext> — the
    // same path the dashboard upload endpoint (POST /api/apps/:slug/icon)
    // writes to. So all five surfaces light up at once: Dashboard tile,
    // Manage table row, Launcher cards, frame topbar, legacy /portal.
    //
    // Preference order is PNG → SVG → WEBP → JPG → JPEG → GIF. We
    // copy at most one file, wiping any stale-extension siblings so the
    // GET handler doesn't keep serving an old icon under a different
    // extension. Idempotent on each deploy; the manual dashboard upload
    // still works — whichever one ran most recently wins, since both
    // write to the same path.
    // Skipped for an image deploy: the convention is a file committed at
    // public/icon.png in the app's own repo, and an image app has no repo and
    // no release dir to look in.
    if (!isImageDeploy) {
    try {
      const ICON_PREFERENCE = ['png', 'svg', 'webp', 'jpg', 'jpeg', 'gif'];
      const found = ICON_PREFERENCE
        .map(ext => ({ ext, path: join(releaseDir, 'public', `icon.${ext}`) }))
        .find(({ path }) => existsSync(path));
      if (found) {
        const appIconDir = join(dataDir, 'apps', app.slug);
        mkdirSync(appIconDir, { recursive: true });
        // Wipe stale icons under a different extension before copying.
        for (const oldExt of ICON_PREFERENCE) {
          if (oldExt === found.ext) continue;
          const oldPath = join(appIconDir, `icon.${oldExt}`);
          if (existsSync(oldPath)) {
            try { unlinkSync(oldPath); } catch (_) {}
          }
        }
        const destPath = join(appIconDir, `icon.${found.ext}`);
        // copyFileSync rather than rename — the source lives inside the
        // release dir and we don't want to corrupt that dir's contents.
        const { copyFileSync } = await import('fs');
        copyFileSync(found.path, destPath);
        appendLog(`Picked up app icon from public/icon.${found.ext}`);
      }
    } catch (e) {
      appendLog(`WARNING: icon pickup failed: ${e.message}`);
    }
    }

    // Read deployhub.json manifest (everything except `version`)
    let manifest = {};
    // null, not join(undefined, …) — there is no releaseDir on the image path.
    const manifestPath = isImageDeploy ? null : join(releaseDir, 'deployhub.json');
    if (isImageDeploy) {
      // A prebuilt image ships no deployhub.json and no package.json, so the
      // manifest is not "missing" — it does not apply. Warning about its
      // absence, as the tree path does, would report a problem that isn't one.
      // The tag resolved above is the version.
      manifest = { version: imageVersion };
    } else if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } else {
      appendLog('WARNING: No deployhub.json found. Using defaults.');
    }

    // Sync the per-tenant DB opt-in from the manifest onto the app row, so the
    // revoke path (which runs outside a deploy) knows whether to purge tenant
    // data. Only touch the column when the manifest states it explicitly.
    if (typeof manifest.multitenant === 'boolean') {
      db.prepare('UPDATE apps SET multitenant = ? WHERE id = ?').run(manifest.multitenant ? 1 : 0, app.id);
    }

    // v2.7.26: sync the cron declaration from deployhub.json into
    // app_cron_jobs. Removed jobs are dropped, new ones added, existing rows
    // updated. cronScheduler.js's tick loop picks them up on the next minute.
    // Bad schedules surface here at deploy time as a hard error rather than
    // silently failing at run time.
    try {
      const { syncCronJobsFromManifest } = await import('./cronScheduler.js');
      const result = syncCronJobsFromManifest(app.id, env, manifest.cron);
      if (result.synced > 0) appendLog(`Synced ${result.synced} cron job(s) from deployhub.json`);
    } catch (e) {
      appendLog(`WARNING: cron sync failed (deploy continues): ${e.message}`);
    }

    // Resolve `version` with precedence:
    //   1. package.json:version (always wins for Node apps — the field
    //      developers actually bump)
    //   2. deployhub.json:version (fallback for non-Node apps, e.g. Python/Go)
    //   3. package.json:name (fills `manifest.name` if deployhub.json is absent)
    // This eliminates the drift class where deployhub.json:version goes stale
    // because every Node release bumps package.json but forgets the manifest.
    const pkgPath = isImageDeploy ? null : join(releaseDir, 'package.json');
    if (pkgPath && existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.version) manifest.version = pkg.version;
        if (!manifest.name && pkg.name) manifest.name = pkg.name;
      } catch (e) {
        appendLog(`WARNING: package.json parse failed (${e.message}); falling back to deployhub.json:version`);
      }
    }
    if (manifestPath && existsSync(manifestPath)) {
      appendLog(`Found deployhub.json: ${manifest.name || '(no name)'} v${manifest.version || '(no version)'}`);
    }

    const envVars = db.prepare(
      'SELECT key, value_encrypted FROM env_vars WHERE app_id = ? AND env = ?'
    ).all(app.id, env);

    const bePort = env === 'production' ? ports.prod_be : ports.sand_be;

    // v2.6.10: fail fast when the assigned port is on the WHATWG bad-
    // ports list. Without this guard the container would start fine
    // and the health probe (Node fetch) would silently 0-status with
    // "bad port" — operator chases the deploy log for hours seeing no
    // signal. New apps don't hit this since v2.6.10's getNextSlot
    // skips bad slots; this catches existing apps that were allocated
    // before the fix landed.
    try {
      const { isPortSafe } = await import('./blockedPorts.js');
      if (!isPortSafe(bePort)) {
        throw new Error(
          `PORT_BLOCKED: ${env} backend port ${bePort} is on the WHATWG fetch-spec blocklist. ` +
          `Node fetch() refuses to connect to this port, so the health probe cannot reach the container. ` +
          `Reassign the app's slot — see scripts/reassign-app-slot.js or run "UPDATE apps SET slot = <new_slot> WHERE slug = '${app.slug}'" with a safe slot from getNextSlot.`
        );
      }
    } catch (e) {
      if (e.message?.startsWith('PORT_BLOCKED')) {
        appendLog(e.message);
        throw e;
      }
      // import failure shouldn't block the deploy
    }

    const cranePort = process.env.PORT || 5001;
    const craneUrl = process.env.CRANE_DOMAIN
      ? `https://${process.env.CRANE_DOMAIN}`
      : `http://localhost:${cranePort}`;
    const craneInternalUrl = `http://localhost:${cranePort}`;

    const appBasePath = env === 'production' ? `/${app.slug}/` : `/${app.slug}-sandbox/`;

    db.prepare("UPDATE deployments SET status = 'deploying' WHERE id = ?").run(deployId);

    const { dockerAvailable, buildImageIfNeeded, getContainerImage, startApp: dockerStart, stopApp: dockerStop, pruneOldImages, pruneDanglingImages } = await import('./docker.js');
    const { ensureDockerfile, injectAppBasePathArg } = await import('./dockerfileGen.js');
    const { validateDockerfile } = await import('./dockerfileValidator.js');
    const { validateDistConsistency } = await import('./distValidator.js');

    if (!await dockerAvailable()) throw new Error('Docker daemon is not available on this host');

    let image;

    if (isImageDeploy) {
      // Nothing to build and nothing to validate a build against: the artifact
      // was pulled above. `image` is the DIGEST ref, never the tag the operator
      // typed, so what starts below is exactly what deployments.image_ref says
      // started.
      image = pinnedImageRef;
      appendLog(`Image ready (pulled, digest-pinned): ${image}`);
    } else {

    // Pre-build: if the app committed a `dist/`, verify it's not stale.
    // Catches the "white page on live" failure mode where index.html
    // references hashed asset names that don't exist on disk anymore.
    const distCheck = validateDistConsistency(releaseDir);
    for (const w of distCheck.warnings) appendLog(`⚠ ${w}`);
    if (!distCheck.valid) {
      throw new Error(
        `DIST_OUT_OF_SYNC: committed ${distCheck.foundDistAt} is stale.\n` +
        distCheck.errors.map(e => '  • ' + e).join('\n')
      );
    }
    if (distCheck.foundDistAt) {
      appendLog(`Committed ${distCheck.foundDistAt} validated — index.html references resolve.`);
    }

    // v2.21.10: an app with no Dockerfile that also isn't a Node app can't use
    // the Node-only dockerfileGen. Build it with Nixpacks (Python/Go/Ruby/
    // static/…) if the binary is on the host; otherwise fail with a clear ask.
    const hasDockerfile = existsSync(join(releaseDir, 'Dockerfile'));
    const isNodeApp = existsSync(join(releaseDir, 'package.json'));

    if (!hasDockerfile && !isNodeApp) {
      const { nixpacksAvailable, nixpacksBuild } = await import('./nixpacks.js');
      const { imageTagFor } = await import('./docker.js');
      if (!(await nixpacksAvailable())) {
        throw new Error(
          'NO_BUILD_METHOD: this app ships no Dockerfile and is not a Node app, so AppCrane ' +
          'cannot auto-build it. Install `nixpacks` on the deploy host ' +
          '(https://nixpacks.com/docs/install) to build Python/Go/Ruby/static/etc., or add a Dockerfile.'
        );
      }
      appendLog('No Dockerfile + non-Node app → building with Nixpacks…');
      image = imageTagFor(app.slug, env, commitHash);
      await nixpacksBuild({
        releaseDir, tag: image, slug: app.slug, env,
        onLog: (line) => { if (deployLog.length < 500) appendLog(`  ${line}`); },
      });
      appendLog(`Image ready (Nixpacks): ${image}`);
    } else {
      const { userProvided } = ensureDockerfile({ releaseDir, manifest, appBasePath, craneUrl, craneInternalUrl });

      if (userProvided) {
        const expectedPort = manifest?.port || manifest?.be?.port || 3000;
        const { valid, errors, warnings } = validateDockerfile(releaseDir, { expectedPort });
        for (const w of warnings) appendLog(`⚠ Dockerfile: ${w}`);
        if (!valid) throw new Error(`Dockerfile validation failed:\n${errors.map(e => '  • ' + e).join('\n')}`);
        injectAppBasePathArg(join(releaseDir, 'Dockerfile'));
        appendLog('Using app-provided Dockerfile (validated)');
      } else {
        appendLog('Generated Dockerfile (Node Alpine, non-root)');
      }

      appendLog('Building docker image...');
      image = await buildImageIfNeeded({
        slug: app.slug,
        env,
        contextDir: releaseDir,
        commitHash,
        appBasePath,
        onLog: (line) => { if (deployLog.length < 500) appendLog(`  ${line}`); },
      });
      appendLog(`Image ready: ${image}`);
    }
    }

    // v2.6.16: pre-flight entry-exists check. Validate that the entry
    // declared in deployhub.json actually resolves in the built image
    // BEFORE we stop the old container or hand off to the 30s health
    // probe. Converts a 30s mystery timeout (the common
    // monorepo-build-vs-flat-entry mismatch) into a 1s actionable
    // error with suggested candidates spelled out.
    if (manifest.be?.entry) {
      const { preflightEntryCheck } = await import('./preflightCheck.js');
      appendLog(`Pre-flight: validating be.entry "${manifest.be.entry}" against built image…`);
      const pf = await preflightEntryCheck({ image, entry: manifest.be.entry });
      if (pf.skipped) {
        appendLog(`Pre-flight skipped (${pf.skipped}); proceeding to health check.`);
      } else if (!pf.ok) {
        for (const line of pf.message.split('\n')) appendLog(line);
        // Old container is still running — we have NOT called dockerStop yet,
        // so the previous version stays live and serving traffic.
        throw new Error(`Pre-flight: ${pf.shortReason}. See deploy log for suggested candidates and fix.`);
      } else {
        appendLog('Pre-flight passed.');
      }
    }

    // Capture old image tag so we can revert if health check fails (Feature 9)
    let prevImage = null;
    try { prevImage = await getContainerImage(app.slug, env); } catch (_) {}

    await dockerStop(app.slug, env).catch(() => {});

    const runtimeEnvVars = {};
    const decryptFailures = [];
    for (const v of envVars) {
      try { runtimeEnvVars[v.key] = decrypt(v.value_encrypted); }
      catch (_) { decryptFailures.push(v.key); }
    }
    // v2.7.30: surface env injection in the deploy log — KEY NAMES ONLY,
    // never values. Lets an operator confirm a var actually reached the
    // container (e.g. ANTHROPIC_API_KEY) without shelling in or exposing the
    // secret. If a key is in this list, the `-e` flag was set; if the app
    // still doesn't see it, the app is reading a baked .env, not process.env.
    const injectedKeys = Object.keys(runtimeEnvVars);
    appendLog(
      injectedKeys.length
        ? `Injecting ${injectedKeys.length} env var(s) into container: ${injectedKeys.join(', ')}`
        : 'No app env vars to inject (env_vars empty for this app/env).'
    );
    // v2.7.30: a value that fails to decrypt was previously dropped silently —
    // the container came up missing the secret with zero signal. Make it loud.
    if (decryptFailures.length) {
      appendLog(
        `WARNING: ${decryptFailures.length} env var(s) failed to decrypt ` +
        `(ENCRYPTION_KEY mismatch?) and were OMITTED from the container: ${decryptFailures.join(', ')}`
      );
    }

    // v2.65.0: managed database credentials, under the variable names THIS app's
    // catalogue entry declares (apps.catalog_slug -> appCatalog.json `needs`).
    // Runs AFTER the app's own env vars are in the map and reads from it, so an
    // env var the user set by hand wins over the injected credential — see
    // applyManagedDbEnv. Key names only in the log; the password is a value and
    // never appears.
    {
      const mdbEnv = applyManagedDbEnv(app, runtimeEnvVars, decryptFailures);
      if (mdbEnv.injected.length) {
        appendLog(
          `Managed ${mdbEnv.engine} database: injected ${mdbEnv.injected.length} ` +
          `credential var(s): ${mdbEnv.injected.join(', ')}`
        );
      }
      if (mdbEnv.deferred.length) {
        appendLog(
          `Managed ${mdbEnv.engine} database: kept this app's OWN value for ` +
          `${mdbEnv.deferred.join(', ')} (an env var you set wins over the injected credential).`
        );
      }
      if (!mdbEnv.injected.length && !mdbEnv.deferred.length && mdbEnv.reason && app.catalog_slug) {
        appendLog(`Managed database: nothing injected (${mdbEnv.reason}).`);
      }
    }
    // APP_BASE_PATH is intentionally NOT set at runtime: Caddy strips the slug
    // prefix before requests reach the container, so backends must mount at '/'.
    // The variable is build-time only (bundlers need it for asset URLs) — see
    // bugs/2026-04-26-appcrane-app-base-path-resolution.md
    Object.assign(runtimeEnvVars, {
      CRANE_URL: craneUrl,
      CRANE_INTERNAL_URL: craneInternalUrl,
    });

    // v2.8.3: the email service is available to EVERY app, no per-app toggle.
    // Inject the service token (provisioning one on first deploy if absent)
    // plus a container-reachable internal URL — `localhost` inside a container
    // is the container itself, so we point CRANE_INTERNAL_URL at the docker
    // host-gateway. With this, any app's server can POST to /api/service/email.
    {
      const { getServiceTokenPlaintext, issueServiceToken } = await import('./appServiceToken.js');
      const token = getServiceTokenPlaintext(app) || issueServiceToken(app.id);
      runtimeEnvVars.APPCRANE_SERVICE_TOKEN = token;
      runtimeEnvVars.CRANE_INTERNAL_URL = `http://host.docker.internal:${cranePort}`;
      appendLog('Injected APPCRANE_SERVICE_TOKEN + host-gateway CRANE_INTERNAL_URL (email service)');
    }

    // Per-tenant DB (cooperative model): point the app at its tenant root under
    // the mounted /data. The app derives <org>/u<userId>/db.sqlite from the
    // identity headers it already receives. See server/services/tenants.js.
    if (manifest.multitenant) {
      runtimeEnvVars.APPCRANE_TENANT_ROOT = '/data/tenants';
      const quotaMb = Number(manifest.tenant_quota_mb);
      if (Number.isFinite(quotaMb) && quotaMb > 0) {
        runtimeEnvVars.APPCRANE_TENANT_QUOTA_BYTES = String(Math.floor(quotaMb * 1024 * 1024));
        appendLog(`Multitenant: injected APPCRANE_TENANT_ROOT + per-tenant quota ${quotaMb}MB`);
      } else {
        appendLog('Multitenant: injected APPCRANE_TENANT_ROOT=/data/tenants');
      }
    }

    const limits = parseResourceLimits(app.resource_limits);
    await dockerStart({
      slug: app.slug,
      env,
      image,
      hostPort: bePort,
      // The port the image listens on. AppCrane's own build always produces
      // 3000; a third-party image has no reason to agree (odoo is 8069, nginx
      // is 80), so an image app declares its own. Passed straight from the
      // column, NULL included — startApp normalises NULL to the 3000 default.
      containerPort: app.container_port,
      envVars: runtimeEnvVars,
      volumes: [{ host: resolve(join(sharedDir, 'data')), container: '/data' }],
      memoryMb: limits.max_ram_mb,
      cpus: limits.max_cpu_percent / 100,
      addHostGateway: true,
    });
    appendLog(`Container started: appcrane-${app.slug}-${env} (host port ${bePort})`);

    // Health-validate the new container; revert to previous image on failure (Feature 9).
    // v2.2.11: health check is now mandatory. If manifest.be.health is unset
    // we assume the /api/health convention and require the same contract:
    // 200 + JSON with {status, version}. Apps without a health endpoint used
    // to deploy "successfully" then leave the dashboard's version/health
    // columns blank forever, with no signal to the developer that anything
    // was wrong.
    //
    // v2.42.0: the gate is protocol-aware, and the two protocols do NOT prove
    // the same thing. For an http app nothing changes: 200 + JSON carrying
    // {status, version} — the app booted far enough to route a request and
    // report its own identity. A tcp app is on the platform precisely because
    // it does not speak HTTP (a CONNECT proxy cannot answer GET /api/health),
    // so the strongest assertion available without knowing its protocol is
    // that something completed a TCP handshake on the port. That says nothing
    // about which protocol is bound, which version is running, or whether a
    // single real request would succeed — a green deploy for a tcp app is a
    // strictly weaker statement than for an http app, and any operator reading
    // "Health check passed" on a tcp app should read it that way.
    //
    // v2.45.0: HEALTH FOLLOWS THE CONTROL PLANE, so a 'dual' app takes the HTTP
    // branch — deliberately, not by oversight. Note both branches probe the same
    // LOOPBACK port; the choice is handshake vs HTTP, and the handshake proves
    // only that a socket is bound. That is the most a pure-tcp app can offer. A
    // dual app does speak HTTP on that port, so handing it the handshake would
    // be a pure downgrade: a container that accepts connections and answers
    // nothing passes the handshake, so a dual app whose control plane is wedged
    // would deploy GREEN and be promoted over a working previous image. Hence
    // === 'tcp', never !== 'http' — publishing a raw port and being unable to
    // speak HTTP are different facts, and only the second earns the weaker gate.
    //
    // Ingress type is read fresh from the row, not from the `app` argument:
    // callers build that object from several different queries (and rollback
    // re-reads it), so the column is not guaranteed to be on it.
    const { ingress_type } = getIngressForApp(db, app.id);
    const isTcpIngress = ingress_type === 'tcp';

    // apps.health_path sits between the manifest and the default because an
    // image app has no manifest to declare one in, and /api/health is an
    // AppCrane-build convention a stock image has no reason to serve — probing
    // it would 404 and mark a working container unhealthy. The column is NULL
    // for every tree-based app, so their behaviour is unchanged.
    const healthPath = manifest.be?.health || app.health_path || '/api/health';
    const healthSource = manifest.be?.health
      ? `manifest.be.health="${manifest.be.health}"`
      : app.health_path
        ? `apps.health_path="${app.health_path}"`
        : `default /api/health (manifest.be.health unset)`;
    const healthUrl = `http://localhost:${bePort}${healthPath}`;
    // Both protocols probe the LOOPBACK port every container publishes, never
    // the public one — same rule as healthChecker.js: the gate must pass before
    // the operator opens the firewall, and must not depend on a public_port
    // allocation existing.
    if (isTcpIngress) {
      appendLog(`Validating new container health with a TCP connect to 127.0.0.1:${bePort} (30s, ingress_type=tcp — handshake only, no status/version assertion)…`);
    } else {
      appendLog(`Validating new container health at ${healthPath} (30s, ${healthSource})…`);
    }

    // v2.6.17: boot-watch races the HTTP probe. If the container
    // exits or restarts within the first 5s, boot-watch wins and we
    // capture the FULL container log (no --tail) — preserving the
    // first-attempt stderr that the v2.6.15 tail-200 capture would
    // otherwise miss in a restart loop. Happy path: container stays
    // up, boot-watch resolves with crashed=false, probe wins as
    // usual.
    const containerNameForWatch = `appcrane-${app.slug}-${env}`;
    const { watchBootForEarlyCrash } = await import('./bootWatch.js');

    const probePromise = isTcpIngress
      ? probeTcpListener('127.0.0.1', bePort, 30000)
      : probeHealthEndpoint(healthUrl, 30000);
    const bootCrashSignal = watchBootForEarlyCrash({ containerName: containerNameForWatch, windowMs: 5000 })
      .then((r) => (r.crashed ? r : new Promise(() => {})));

    let healthResult;
    let bootCrash = null;
    const winner = await Promise.race([
      probePromise.then((r) => ({ kind: 'probe', r })),
      bootCrashSignal.then((r) => ({ kind: 'boot_crash', r })),
    ]);
    if (winner.kind === 'boot_crash') {
      bootCrash = winner.r;
      // Synthesize a healthResult so the existing failure path below
      // runs (rollback, notification). Mark it so v2.6.15's
      // tail-200 capture is skipped — we already have the full log.
      healthResult = {
        ok: false,
        reason: 'boot_crash',
        detail: `Container ${bootCrash.reason} after ${Math.round(bootCrash.elapsedMs / 1000)}s`,
      };
    } else {
      healthResult = winner.r;
    }

    if (!healthResult.ok) {
      appendLog(`Health check failed (${healthResult.reason}): ${healthResult.detail}`);

      // v2.6.17: surface the full-log capture before the
      // truncated tail-200 capture below. When we got here via
      // boot-watch, we already have the original stderr; emit it
      // first so it's directly above the "Container state" line
      // in the deploy log.
      if (bootCrash) {
        if (bootCrash.logTail && bootCrash.logTail.length > 0) {
          appendLog('── container stdout/stderr (full boot log, captured before restart-loop overwrote it) ──');
          for (const line of bootCrash.logTail) appendLog(`  ${line}`);
          appendLog('── end container output ──');
        } else {
          appendLog('Container produced no output before crash (process exited before writing to stdout/stderr).');
        }
      }

      // v2.6.15: capture diagnostics from the failing container BEFORE
      // dockerStop destroys it. Previously the container was rm'd with
      // its logs, leaving the operator with "fetch failed" and zero
      // evidence. Now we capture container state (running / exited +
      // exit code + OOM flag + start/finish times) and a 200-line tail
      // of stdout/stderr into the deploy log, so the failure stays
      // diagnosable from the persisted deployments.log row.
      const containerName = `appcrane-${app.slug}-${env}`;
      try {
        const inspectOut = execFileSync('docker', ['inspect', containerName, '--format',
          '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}|{{.State.StartedAt}}|{{.State.FinishedAt}}',
        ], { stdio: 'pipe', timeout: 5000 }).toString().trim();
        const [status, exitCode, oom, err, startedAt, finishedAt] = inspectOut.split('|');
        appendLog(`Container state: status=${status}${exitCode !== '0' ? ` exit=${exitCode}` : ''}${oom === 'true' ? ' OOM-KILLED' : ''}${err ? ` err="${err}"` : ''} started=${startedAt}${finishedAt && finishedAt !== '0001-01-01T00:00:00Z' ? ` finished=${finishedAt}` : ''}`);
      } catch (e) {
        appendLog(`docker inspect ${containerName} failed: ${e?.stderr?.toString().trim() || e.message}`);
      }
      try {
        const logsOut = execFileSync('docker', ['logs', '--tail', '200', containerName], { stdio: 'pipe', timeout: 10000 }).toString();
        if (logsOut.trim()) {
          appendLog(`── container stdout/stderr (last 200 lines) ──`);
          for (const line of logsOut.trimEnd().split('\n')) appendLog(`  ${line}`);
          appendLog(`── end container output ──`);
        } else {
          appendLog(`Container produced no stdout/stderr (process exited before printing, or wrote to a file).`);
        }
      } catch (e) {
        appendLog(`docker logs ${containerName} failed: ${e?.stderr?.toString().trim() || e.message}`);
      }

      await dockerStop(app.slug, env).catch(() => {});
      if (prevImage) {
        appendLog(`Reverting to previous image: ${prevImage}`);
        await dockerStart({ slug: app.slug, env, image: prevImage, hostPort: bePort, containerPort: app.container_port, envVars: runtimeEnvVars, volumes: [{ host: resolve(join(sharedDir, 'data')), container: '/data' }], memoryMb: limits.max_ram_mb, cpus: limits.max_cpu_percent / 100 }).catch(() => {});
      }
      const restoreNote = prevImage
        ? 'Previous version restored.'
        : 'Container destroyed (first deploy, no previous version to fall back to). See deploy log above for container output captured before rollback.';
      throw new Error(
        isTcpIngress
          ? `New container failed TCP health check on 127.0.0.1:${bePort}: ${healthResult.detail}\n` +
            `A tcp-ingress app only has to accept a TCP connection on the port AppCrane publishes; ` +
            `nothing accepted one. Make sure the process listens on 0.0.0.0 inside the container ` +
            `(a listener bound to 127.0.0.1 there is unreachable from the host) and on the port declared in deployhub.json. ` +
            `${restoreNote}`
          : `New container failed health check at ${healthPath}: ${healthResult.detail}\n` +
            `Add a route that returns JSON like {"status":"ok","version":"1.0.0"} ` +
            `(declare the path in deployhub.json as be.health, or use the default /api/health). ` +
            `${restoreNote}`
      );
    }
    appendLog('Health check passed');

    pruneOldImages(app.slug, env, (app.image_retention ?? 0) + 1);
    // Reclaim dangling layers from failed/interrupted prior builds (safe — never touches in-use images).
    pruneDanglingImages();

    // 7. Update current symlink (remove old even if target is gone).
    // This is the atomic publish step — until it lands, the release isn't
    // visible to the worker / enhancement lookups. We validate after the
    // flip so a partial deploy can't quietly leave the app in the
    // "deployed but unfindable" state described in the
    // 2026-05-02 current-symlink-missing triage.
    //
    // Skipped entirely for an image deploy. There is no release directory to
    // point `current` at, and the verification below would be the loudest
    // failure of the lot: it demands the target hold a package.json or a
    // deployhub.json, which is a statement about a source tree. A healthy
    // odoo:19 container would have failed the deploy on that line.
    if (!isImageDeploy) {
      const currentLink = resolve(join(appDir, 'current'));
      try { unlinkSync(currentLink); } catch (e) {} // ignore if doesn't exist
      symlinkSync(resolve(releaseDir), currentLink);
      if (!existsSync(currentLink)) {
        throw new Error(`Deploy verification failed: current symlink at ${currentLink} did not resolve after creation`);
      }
      if (!existsSync(join(currentLink, 'package.json')) && !existsSync(join(currentLink, 'deployhub.json'))) {
        throw new Error(`Deploy verification failed: current symlink target ${releaseDir} has no package.json or deployhub.json`);
      }
      appendLog(`Updated current symlink → ${releaseDir.split('/').pop()}`);
    }

    // 8. Update deployment record
    deployFinished = true;
    appendLog(`Deploy complete! Version: ${manifest.version || 'unknown'}`);
    // release_path stays NULL for an image deploy — nothing was written to
    // disk, and a path recorded here would be a directory that does not exist.
    // rollbackApp reads this column, which is why it needed an image branch of
    // its own rather than the release_path check it hard-fails on.
    db.prepare(`
      UPDATE deployments SET status = 'live', version = ?, commit_hash = ?, commit_message = ?, release_path = ?, finished_at = datetime('now'), log = ?
      WHERE id = ?
    `).run(manifest.version || 'unknown', commitHash, commitMessage, isImageDeploy ? null : releaseDir, deployLog.join('\n'), deployId);
    // Refresh AI codebase context in background after production deploy —
    // there is no codebase to index for an image app.
    if (env === 'production' && !isImageDeploy) {
      ensureCodebaseContext(app.slug, releaseDir).catch(err => log.warn(`Context refresh failed for ${app.slug}: ${err.message}`));
    }

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

    // 10b. Post-deploy frontend asset probe. Catches the "white page on live"
    // class of bug — container is healthy, /api/health is green, but Caddy
    // returns 404 for one or more script/style refs in the served index.
    // Result is persisted on the deployment row so MCP agents can read it.
    let frontendAssets = null;
    try {
      const probe = await probeFrontendAssets(app.slug, env);
      frontendAssets = probe.status;
      if (probe.status === 'missing') {
        const sample = probe.missing.slice(0, 5).join(', ');
        const more = probe.missing.length > 5 ? ` (+${probe.missing.length - 5} more)` : '';
        appendLog(`⚠ frontend_assets=missing — Caddy 404'd: ${sample}${more}`);
      } else if (probe.status === 'inconclusive') {
        appendLog(`frontend_assets=inconclusive — ${probe.reason}`);
      } else {
        appendLog('frontend_assets=ok — every asset reference resolved through Caddy');
      }
    } catch (e) {
      appendLog(`Frontend probe error: ${e.message}`);
    }
    try {
      db.prepare('UPDATE deployments SET frontend_assets = ?, log = ? WHERE id = ?')
        .run(frontendAssets, deployLog.join('\n'), deployId);
    } catch (_) {}

    // Cleanup old releases (keep last 5, never the live one).
    pruneOldReleases(releasesDir, appDir, 5, appendLog);

    // Send notification
    try {
      const { notifyDeploy } = await import('./emailService.js');
      await notifyDeploy(app, env, manifest.version || 'unknown', 'success');
    } catch (e) {}

    // 11. Dependency CVE scan (v2.52.0). REPORT-ONLY, and deliberately the
    // last thing that happens: the container is live, the symlink is flipped,
    // the deployment row already says 'live' and the success notification has
    // already gone out. Nothing below this point can change the deploy's
    // outcome, which is the property that matters — these apps belong to other
    // teams who did not choose this control, and a scanner that can fail
    // someone else's deploy over a transitive advisory is a blocking gate
    // wearing a reporting label.
    //
    // scanApp does not throw by contract; the catch is here anyway because the
    // contract is the thing most likely to be broken by a future edit, and the
    // cost of being wrong about it is a deploy that reports failure after
    // having fully succeeded.
    try {
      const { scanApp } = await import('./appScan.js');
      const scan = await scanApp(db, app, env, 'deploy');
      appendLog(`Dependency scan: ${scan.status}${scan.package_count ? ` (${scan.package_count} packages)` : ''}`);
    } catch (e) {
      log.warn(`[appScan] post-deploy scan failed for ${app.slug}/${env}: ${e.message}`);
    }

    return { success: true, version: manifest.version };

  } catch (error) {
    appendLog(`DEPLOY FAILED: ${error.message}`);

    // A failed deploy's checkout is dead weight — the live `current` symlink
    // still points at the last-good release. Remove this attempt's dir (if it's
    // under releases/ and isn't the live one) so repeated failures don't fill
    // the disk, then trim any older backlog. This is what stops the ENOSPC.
    try {
      if (releaseDir && resolve(releaseDir).startsWith(resolve(releasesDir))) {
        const link = join(appDir, 'current');
        const liveTarget = existsSync(link) ? resolve(readlinkSync(link)) : null;
        if (resolve(releaseDir) !== liveTarget) {
          rmSync(releaseDir, { recursive: true, force: true });
          appendLog(`Removed failed release checkout: ${basename(releaseDir)}`);
        }
      }
    } catch (_) { /* best-effort */ }
    try { pruneOldReleases(releasesDir, appDir, 5, appendLog); } catch (_) {}

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
