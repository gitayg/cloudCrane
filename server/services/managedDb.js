/**
 * Managed databases — one shared Postgres and one shared MariaDB for the whole
 * platform, with a database and a login role per scope inside each.
 *
 * =========================================================================
 * WHY APPS REACH THE DATABASE THROUGH THE HOST GATEWAY, AND NOT THE NETWORK
 * =========================================================================
 * Every app container runs on the single shared `appcrane-apps` bridge with
 * com.docker.network.bridge.enable_icc=false (services/docker.js, v2.42.1).
 * The daemon DROPS container-to-container traffic there. That is a shipped
 * security fix — before it, one compromised app could open a sibling's origin
 * directly, behind Caddy, with no auth, audit or rate limit — and a network per
 * app was considered and rejected in the same change, because Docker's default
 * address pools run out at ~16-31 networks and the failure lands mid-deploy as
 * an unrelated-looking subnet error.
 *
 * So an app cannot reach a database container over the docker network, and
 * neither icc nor the one-network design is negotiable. Apps reach it the way
 * they already reach AppCrane itself: `host.docker.internal`, the host-gateway
 * convention deployer.js:1349/1382 established for CRANE_INTERNAL_URL.
 *
 * The consequence has to be said out loud: ANY container that gets
 * --add-host host.docker.internal:host-gateway can open a TCP socket to these
 * servers. Network isolation is not available to us. EVERY isolation guarantee
 * in this file is enforced INSIDE THE ENGINE, by grants — a credential reaches
 * exactly one database and nothing else. See provisionSql() below.
 *
 * =========================================================================
 * WHERE THE PORT IS PUBLISHED — MEASURED, NOT REASONED
 * =========================================================================
 * "Publish on 127.0.0.1 so the database is never on the internet" and "apps must
 * reach it via host.docker.internal" are in direct conflict on Linux, which is
 * what the production box runs. Measured against a real Linux daemon (Docker
 * 27.5.1 in privileged dind, aarch64), probing from a container ON
 * appcrane-apps with icc=false and --add-host host.docker.internal:host-gateway:
 *
 *   victim container -p 127.0.0.1:P     ->  wget: can't connect (172.18.0.1)
 *   victim container -p 0.0.0.0:P       ->  200   (works; database on the
 *                                                  internet — rejected)
 *   host process on 0.0.0.0:P           ->  200   (this is why the existing
 *                                                  CRANE_INTERNAL_URL works:
 *                                                  AppCrane is a host process,
 *                                                  not a container)
 *   host process on 127.0.0.1:P         ->  wget: can't connect (172.18.0.1)
 *   victim container -p 127.0.0.1:P
 *                    -p 172.18.0.1:P    ->  200, and `netstat -ltn` shows
 *                                           listeners on 127.0.0.1 and
 *                                           172.18.0.1 only, never 0.0.0.0
 *
 * On Linux, host.docker.internal resolves to the default bridge's gateway, and a
 * port bound to loopback is simply not on that interface. On macOS Docker
 * Desktop the same probe against a 127.0.0.1 publish returns 200, because
 * host.docker.internal there is 192.168.65.254 — an address on the Mac side that
 * the VM's port forwarder routes back to the host's loopback, and one that
 * cannot be bound inside the daemon (measured: `bind: cannot assign requested
 * address`).
 *
 * So we publish on BOTH 127.0.0.1 and the default bridge gateway, and treat the
 * second as best-effort — it is what makes Linux work and it is unbindable on
 * Desktop, where the first already works. Neither address is 0.0.0.0 and neither
 * is on a public NIC: the gateway of a docker bridge is reachable from the host
 * and from containers routing through it, and from nowhere else.
 *
 * NOTE the servers are deliberately NOT placed on `appcrane-apps`. If they were,
 * an app reaching them through the gateway would be a same-bridge hairpin, and
 * docker.js measured that path as blocked by icc=false. On the default bridge it
 * is a cross-bridge hairpin, which the matrix above measured as working.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { getDb } from '../db.js';
import { encrypt, decrypt } from './encryption.js';
import log from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/** The hostname an app container uses. Same convention as CRANE_INTERNAL_URL. */
export const DB_HOST_FOR_CONTAINERS = 'host.docker.internal';

export const SUPPORTED_ENGINES = ['postgres', 'mariadb'];

// Ports sit well clear of tcpIngress.js's 31000-31999 auto-allocation range and
// of the 3000 control plane, so an app can never be handed a port a database is
// already holding.
// Container names carry a prefix so a test run cannot adopt — or destroy — the
// platform's real database servers on a developer's machine. Production never
// sets it.
const CONTAINER_PREFIX = process.env.MANAGED_DB_CONTAINER_PREFIX || 'appcrane-db';

const ENGINES = {
  postgres: {
    image: process.env.MANAGED_DB_POSTGRES_IMAGE || 'postgres:16-alpine',
    container: `${CONTAINER_PREFIX}-postgres`,
    defaultPort: Number(process.env.MANAGED_DB_POSTGRES_PORT) || 45432,
    containerPort: 5432,
    dataPath: '/var/lib/postgresql/data',
    // Honoured only on first init of an empty data dir — see migration 085 for
    // why the value is stored rather than regenerated.
    passwordEnv: 'POSTGRES_PASSWORD',
    memoryMb: Number(process.env.MANAGED_DB_POSTGRES_MEMORY_MB) || 512,
    scheme: 'postgresql',
  },
  mariadb: {
    image: process.env.MANAGED_DB_MARIADB_IMAGE || 'mariadb:11.4',
    container: `${CONTAINER_PREFIX}-mariadb`,
    defaultPort: Number(process.env.MANAGED_DB_MARIADB_PORT) || 43306,
    containerPort: 3306,
    dataPath: '/var/lib/mysql',
    passwordEnv: 'MARIADB_ROOT_PASSWORD',
    memoryMb: Number(process.env.MANAGED_DB_MARIADB_MEMORY_MB) || 512,
    scheme: 'mysql',
  },
};

// Identifiers this module generates. Anything that fails this never reaches an
// engine: db_name and db_user are interpolated into DDL (they are identifiers,
// which no driver can bind as parameters), so this regex is the injection
// boundary, not a tidiness check.
const SAFE_IDENT = /^[a-z][a-z0-9_]{0,62}$/;

// Generated passwords are base64url, so this alphabet contains no quote,
// backslash or backtick and the literal below cannot be broken out of. Checked
// rather than assumed, because an operator-supplied or migrated password would
// reach the same code path.
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;

// MariaDB's user column was 32 bytes before 10.6 and Postgres truncates every
// identifier at 63. Both ceilings are enforced against the SHORTER one, so a
// name that works here works on any supported engine.
const MAX_IDENT_BYTES = 31;

// "the daemon cannot bind that host address". Native Linux says "cannot assign
// requested address"; Docker Desktop says "ports are not available: ... can't
// assign requested address". Matching only the first spelling is how the first
// run of this code failed on Desktop — the fallback never fired and the bad
// container was left behind for every later call to trip over.
const ADDR_UNAVAILABLE = /can(?:no|')t assign requested address|address not available|ports are not available/i;

async function dockerExec(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 60000, ...opts });
    return stdout.trim();
  } catch (e) {
    // stderr first, matching docker.js: `docker run -d` writes the new container
    // id to stdout even when the run fails, so a stdout-first pick returns a
    // bare hex string and discards the reason.
    const output = e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message;
    throw new Error(output);
  }
}

/**
 * `docker ...` with a body on STDIN.
 *
 * spawn, not execFile: execFile has no `input` option (that belongs to the
 * *Sync* family), so passing one is silently ignored — the child gets an
 * inherited-empty stdin and psql/mariadb read EOF, which for psql looks like a
 * successful run of an empty script. Every provisioning statement in this module
 * travels this path, so getting it wrong would mean rows in SQLite and no
 * database in the engine. execFileSync would work and would block the event
 * loop for the length of a database DDL, which is not acceptable in a server.
 */
function dockerExecStdin(args, input, { timeout = 60000 } = {}) {
  return new Promise((resolve_, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker ${args[0]} timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve_(out.trim());
      reject(new Error(err.trim() || out.trim() || `docker exited ${code}`));
    });
    // EPIPE if the child died before reading — the close handler already has the
    // real reason, so swallow it rather than replacing a useful SQL error with
    // a write error.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------
// Scope -> names. ONE function, deliberately.
// ---------------------------------------------------------------------------

/**
 * A scope is `{ appId, tenant }`. tenant is null/'' today — the app itself — and
 * is the dimension multitenancy will fill in (services/tenants.js already models
 * a tenant as org+user). Everything downstream keys on the value this returns,
 * so adding the tenant dimension is a change HERE and nowhere else.
 */
export function normalizeScope(scope) {
  const appId = Number(scope?.appId);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error(`managedDb: scope.appId must be a positive integer, got ${JSON.stringify(scope?.appId)}`);
  }
  const tenant = scope?.tenant == null ? '' : String(scope.tenant);
  return { appId, tenant };
}

/**
 * Derive the database and role names for a scope.
 *
 *   app-scoped     { appId: 42 }                     -> crane_a42       / crane_a42_u
 *   tenant-scoped  { appId: 42, tenant: 'acme.com/u7' } -> crane_a42_t3f9a1c2b7e0
 *                                                       / crane_a42_t3f9a1c2b7e0_u
 *
 * THE TENANT IS HASHED, NOT SLUGGED, and so is anything else variable-length.
 * The tempting version builds the name from the app slug and the tenant string
 * and lets Postgres truncate at 63 bytes. Postgres truncates SILENTLY, and two
 * long scopes sharing a prefix truncate to the SAME identifier — at which point
 * the second app is handed the first app's database and every isolation grant in
 * this file is satisfied while the data is shared. That is a cross-app data leak
 * that presents as a successful deploy. A fixed-width hash of the full scope
 * string removes the failure mode instead of making it less likely, and the app
 * id (already unique, already short) carries the readable half.
 *
 * 12 hex characters is 48 bits: at the ~57 apps this platform runs, times any
 * plausible tenant count, the collision probability is negligible — and it is
 * not the last line of defence anyway, because migration 085's UNIQUE index on
 * (engine, db_name) turns a collision into a failed INSERT rather than a leak.
 */
export function namesForScope(scope) {
  const { appId, tenant } = normalizeScope(scope);
  let base = `crane_a${appId}`;
  if (tenant) {
    const h = crypto.createHash('sha256').update(tenant).digest('hex').slice(0, 12);
    base += `_t${h}`;
  }
  const database = base;
  const username = `${base}_u`;

  // Not defensive padding: an appId large enough to breach this would produce a
  // name Postgres silently truncates, which is the exact leak the hash exists to
  // prevent. Refusing to provision is the only safe answer.
  if (Buffer.byteLength(username) > MAX_IDENT_BYTES) {
    throw new Error(
      `managedDb: derived identifier "${username}" is ${Buffer.byteLength(username)} bytes, ` +
      `over the ${MAX_IDENT_BYTES}-byte ceiling. Shorten the naming scheme rather than letting ` +
      `the engine truncate it — truncation can collide with another scope's database.`
    );
  }
  if (!SAFE_IDENT.test(database) || !SAFE_IDENT.test(username)) {
    throw new Error(`managedDb: derived unsafe identifier from scope ${JSON.stringify(scope)}`);
  }
  return { database, username };
}

function assertIdent(name) {
  if (!SAFE_IDENT.test(name) || Buffer.byteLength(name) > MAX_IDENT_BYTES) {
    throw new Error(`managedDb: refusing to build SQL with identifier ${JSON.stringify(name)}`);
  }
  return name;
}

function assertPassword(pw) {
  if (!SAFE_PASSWORD.test(pw)) {
    // The value is NEVER echoed, here or anywhere else in this module.
    throw new Error('managedDb: password contains characters outside the safe alphabet; refusing to build SQL');
  }
  return pw;
}

/** 32 chars of base64url — no quote, backslash or backtick, and URL-safe, so it
 *  needs no escaping in SQL or in a connection string. Never logged. */
function generatePassword() {
  return crypto.randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------
// The shared server containers
// ---------------------------------------------------------------------------

function dataDirFor(engine) {
  const root = resolve(process.env.DATA_DIR || './data');
  return join(root, 'managed-db', engine);
}

/**
 * Host addresses to publish on. See the header: 127.0.0.1 alone is unreachable
 * from app containers on Linux, and 0.0.0.0 puts a database on the internet.
 */
async function bindAddresses() {
  const override = process.env.MANAGED_DB_BIND;
  if (override) return override.split(',').map(s => s.trim()).filter(Boolean);

  const addrs = ['127.0.0.1'];
  try {
    const gw = await dockerExec(
      ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
      { timeout: 10000 }
    );
    // host.docker.internal:host-gateway resolves to the default bridge gateway
    // on Linux. A daemon started with an explicit --host-gateway-ip breaks that
    // assumption; MANAGED_DB_BIND is the escape hatch for it.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(gw) && gw !== '127.0.0.1') addrs.push(gw);
  } catch (e) {
    log.debug(`managedDb: could not read the default bridge gateway (${e.message}); publishing on loopback only`);
  }
  return addrs;
}

async function containerState(name) {
  try {
    return await dockerExec(['inspect', '-f', '{{.State.Status}}', name], { timeout: 10000 });
  } catch (_) {
    return null;
  }
}

function serverRow(engine) {
  return getDb().prepare('SELECT * FROM managed_db_servers WHERE engine = ?').get(engine) || null;
}

function upsertServerRow(engine, cfg, port, adminPassword) {
  getDb().prepare(`
    INSERT INTO managed_db_servers (engine, container_name, image, host_port, admin_password_enc)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(engine) DO UPDATE SET container_name = excluded.container_name, image = excluded.image
  `).run(engine, cfg.container, cfg.image, port, encrypt(adminPassword));
}

/**
 * Wait until the server is serving on TCP, which is the only readiness signal
 * that means anything here.
 *
 * BOTH images run a TEMPORARY server during first-time initialisation — postgres
 * with listen_addresses='', MariaDB with --skip-networking — and then restart it
 * for real. A readiness probe over the unix socket therefore goes GREEN in the
 * middle of init, and the provisioning statements that follow land on a server
 * that is about to be shut down and reinitialised. Probing TCP on 127.0.0.1
 * inside the container is the check that cannot pass early, because TCP is
 * exactly what the temporary server does not offer.
 *
 * NEITHER probe carries a credential. pg_isready needs none, and mariadb-admin
 * is given a username that does not exist: once the server is up it answers
 * "Access denied", which proves the server is accepting and authenticating TCP
 * connections just as well as a successful ping would — without putting the
 * superuser password in the host's process table on every poll.
 */
async function waitReady(engine, timeoutMs = 120000) {
  const cfg = ENGINES[engine];
  const probe = engine === 'postgres'
    ? ['exec', cfg.container, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', String(cfg.containerPort), '-U', 'postgres']
    : ['exec', cfg.container, 'mariadb-admin', 'ping', '--protocol=tcp', '-h', '127.0.0.1',
       '-P', String(cfg.containerPort), '-u', 'appcrane_readiness_probe'];
  const upAnyway = /access denied|using password/i;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      await dockerExec(probe, { timeout: 15000 });
      return;
    } catch (e) {
      if (engine === 'mariadb' && upAnyway.test(e.message)) return;
      last = e.message;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`managedDb: ${engine} container did not become ready within ${timeoutMs}ms (last probe: ${last})`);
}

/**
 * Start the shared server for an engine if it is not already running, and return
 * its connection coordinates. Idempotent, and LAZY — nothing here runs until an
 * app actually asks for a database, so a platform whose apps need no SQL server
 * never pays for one.
 */
export async function ensureServer(engine) {
  const cfg = ENGINES[engine];
  if (!cfg) throw new Error(`managedDb: unknown engine '${engine}' (supported: ${SUPPORTED_ENGINES.join(', ')})`);

  let row = serverRow(engine);
  const port = row?.host_port || cfg.defaultPort;
  const adminPassword = row ? decrypt(row.admin_password_enc) : generatePassword();
  if (!row) {
    upsertServerRow(engine, cfg, port, adminPassword);
    row = serverRow(engine);
  }

  const state = await containerState(cfg.container);

  if (state && state !== 'running') {
    // exited / created / paused: the volume is intact and the password matches
    // the row, so a start is enough and a recreate would only risk the data.
    try {
      await dockerExec(['start', cfg.container], { timeout: 60000 });
    } catch (e) {
      // A container CREATED with a port binding the host cannot provide never
      // starts, and retrying `docker start` forever just repeats the same
      // error — which is what a run against Docker Desktop produced before this
      // branch existed. Recreate it against the bindable address instead. The
      // data is in the volume, not the container, so nothing is lost.
      if (!ADDR_UNAVAILABLE.test(e.message)) throw e;
      log.info(`managedDb: ${cfg.container} cannot start on its recorded bindings; recreating`);
      await dockerExec(['rm', '-f', cfg.container], { timeout: 60000 }).catch(() => {});
      await createServerContainer(engine, cfg, port, adminPassword);
    }
  } else if (!state) {
    await createServerContainer(engine, cfg, port, adminPassword);
  }

  await waitReady(engine);
  await ensureAdminCredentialFile(engine, adminPassword);
  await hardenServer(engine);
  return { engine, host: DB_HOST_FOR_CONTAINERS, port, container: cfg.container };
}

/**
 * Create and start the shared server container.
 *
 * The bridge-gateway publish is best-effort by design (see the header): it is
 * what makes Linux work and it is unbindable on Docker Desktop, where the
 * loopback publish alone is what apps reach. Rather than sniffing the platform,
 * ask for both and fall back when the daemon says it cannot bind — the daemons
 * disagree on the wording ("cannot assign requested address" on native Linux,
 * "ports are not available: ... can't assign requested address" on Desktop), so
 * ADDR_UNAVAILABLE matches both. A miss here is not silent: it surfaces as a
 * failed provision, not as a database quietly published somewhere else.
 */
async function createServerContainer(engine, cfg, port, adminPassword) {
  const dir = dataDirFor(engine);
  mkdirSync(dir, { recursive: true });

  // The superuser password goes in through --env-file rather than -e so it
  // never appears in the host's process table, where any local user can read
  // it. It is still visible in `docker inspect` — that is unavoidable for an
  // image that takes its init credential from the environment, and reading it
  // needs docker socket access, which is already root-equivalent.
  const envFile = join(dir, '.init-env');
  writeFileSync(envFile, `${cfg.passwordEnv}=${adminPassword}\n`, { mode: 0o600 });

  const args = [
    'run', '-d',
    '--name', cfg.container,
    '--label', 'appcrane=true',
    '--label', `appcrane-db=${engine}`,
    '--restart=on-failure:2',
    `--memory=${cfg.memoryMb}m`,
    // Equal to --memory: Docker's spelling for "no swap at all". Omitting it
    // silently doubles the real ceiling on any host that has swap. Same
    // reasoning as docker.js's app containers.
    `--memory-swap=${cfg.memoryMb}m`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'NET_RAW',
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
    '--env-file', envFile,
    '-v', `${dir}:${cfg.dataPath}`,
  ];
  // NOT `--network appcrane-apps`: see the header. On that bridge the
  // app -> gateway -> database hop is a same-bridge hairpin, which
  // enable_icc=false drops. The default bridge makes it a cross-bridge hop,
  // which is the one that was measured working.
  for (const addr of await bindAddresses()) {
    args.push('-p', `${addr}:${port}:${cfg.containerPort}`);
  }
  args.push(cfg.image);

  try {
    await dockerExec(args, { timeout: 180000 });
  } catch (e) {
    // Retry without the bridge-gateway publish. On Docker Desktop
    // host.docker.internal is a Mac-side address that cannot be bound inside
    // the VM ("bind: cannot assign requested address"), and there the
    // loopback publish alone is what apps actually reach — measured.
    if (ADDR_UNAVAILABLE.test(e.message)) {
      log.info(`managedDb: bridge-gateway publish unavailable for ${engine}; publishing on loopback only`);
      // Drop every `-p <addr>:...` pair whose address is not loopback, taking
      // the flag and its value together. A filter that tests each element
      // independently leaves the orphaned `-p` behind and docker then reads
      // the image name as the port spec.
      const loopbackOnly = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-p' && !args[i + 1].startsWith('127.0.0.1')) { i++; continue; }
        loopbackOnly.push(args[i]);
      }
      // A half-created container from the failed run would make the retry fail
      // with "name already in use", which reads as an unrelated problem.
      await dockerExec(['rm', '-f', cfg.container], { timeout: 60000 }).catch(() => {});
      await dockerExec(loopbackOnly, { timeout: 180000 });
    } else {
      throw e;
    }
  } finally {
    // The plaintext credential must not outlive the one `docker run` that
    // needs it. Best-effort: a leftover file is a finding, not a crash.
    try { rmSync(envFile, { force: true }); } catch (_) {}
  }
  log.info(`managedDb: started shared ${engine} server on 127.0.0.1:${port}`);
}

/**
 * MariaDB's client cannot take a password on stdin while stdin is carrying the
 * script, and passing --password on the command line publishes the superuser
 * credential to the host's process table on every provisioning call. So the
 * credential is written INSIDE the container, over stdin, at 0600, and the
 * client picks it up from there. Rewritten on every ensureServer() because it
 * lives in the container's writable layer, not the volume, and so does not
 * survive a recreate.
 *
 * Postgres needs nothing equivalent: the official image ships
 * `local all all trust` in pg_hba.conf (verified by reading the file out of a
 * running container), so `docker exec -u postgres ... psql` authenticates over
 * the unix socket with no password anywhere.
 */
async function ensureAdminCredentialFile(engine, adminPassword) {
  if (engine !== 'mariadb') return;
  const body = `[client]\nuser=root\npassword=${adminPassword}\nprotocol=socket\n`;
  // The credential travels on stdin. It is a fixed shell string with nothing
  // interpolated into it, so this does not violate the "no user strings in
  // sh -c" rule — the variable part never touches argv at all.
  await dockerExecStdin(
    ['exec', '-i', ENGINES.mariadb.container, 'sh', '-c', 'cat > /root/.my.cnf && chmod 600 /root/.my.cnf'],
    body,
    { timeout: 30000 }
  );
}

/**
 * Server-wide hardening, applied on every ensure so a hand-restored volume or a
 * hand-created role cannot leave the server in the pre-hardening state.
 *
 * Postgres only, and it is the single most important statement in this module.
 * A FRESH POSTGRES ROLE CAN CONNECT TO EVERY DATABASE BY DEFAULT — CONNECT is
 * granted to PUBLIC on database creation. Without these revokes, app A's role
 * logs into `postgres` (or template1, or any database provisioned before the
 * revoke shipped) and the per-database grants below are decorative.
 *
 * MariaDB needs no equivalent: its privileges are per-database from the start
 * and a user with no grant on a database cannot USE it.
 */
async function hardenServer(engine) {
  if (engine !== 'postgres') return;
  await runAdminSql('postgres', [
    'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;',
    'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;',
  ].join('\n'));
}

/** Stop the shared server. The volume, and therefore the data, is untouched. */
export async function stopServer(engine) {
  const cfg = ENGINES[engine];
  if (!cfg) throw new Error(`managedDb: unknown engine '${engine}'`);
  await dockerExec(['rm', '-f', cfg.container], { timeout: 60000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Admin SQL
// ---------------------------------------------------------------------------

/**
 * Run SQL as the engine's superuser, over the container's unix socket. The
 * script goes in on STDIN, never in argv — identifiers are interpolated by the
 * callers (assertIdent'd first; an identifier cannot be a bind parameter in any
 * driver) and passwords are interpolated as literals from an alphabet with no
 * quoting characters in it (assertPassword). Neither ever reaches a shell.
 */
async function runAdminSql(engine, sql, { database } = {}) {
  const cfg = ENGINES[engine];
  if (engine === 'postgres') {
    return dockerExecStdin(
      ['exec', '-u', 'postgres', '-i', cfg.container,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database ? assertIdent(database) : 'postgres', '-f', '-'],
      sql,
      { timeout: 60000 }
    );
  }
  const args = ['exec', '-i', cfg.container, 'mariadb', '--batch'];
  if (database) args.push(assertIdent(database));
  return dockerExecStdin(args, sql, { timeout: 60000 });
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * The grants. Requirement 1 in one place: "an app's credentials must reach that
 * app's database and NOTHING else."
 *
 * POSTGRES. Four things have to be true, and three of them are revokes:
 *   - The role is created with every attribute off. NOSUPERUSER is obvious;
 *     NOCREATEDB stops it provisioning around us, NOCREATEROLE stops it minting
 *     a role with different grants, NOREPLICATION stops it streaming the whole
 *     cluster — which would include every other app's database — out of a
 *     replication slot without ever "connecting" to those databases at all.
 *   - REVOKE ALL ... FROM PUBLIC on the new database. CONNECT is granted to
 *     PUBLIC at creation, so without this, every existing and future role on the
 *     server can open this app's database. This is the whole failure mode.
 *   - REVOKE ALL ON SCHEMA public FROM PUBLIC. PG15+ already removes PUBLIC's
 *     CREATE here, but the platform must not depend on a default that differed
 *     in PG14 and could differ again; on an older image the omission lets any
 *     role plant objects in every app's schema.
 *   - The app's role OWNS its database and its public schema, so it can do
 *     everything an application needs (DDL, extensions it is allowed) inside
 *     that one database and has no route out of it.
 *
 * MEASURED, as app A's role against app B's database on postgres:16-alpine:
 *   connect to B's database   FATAL: permission denied for database "crane_a2"
 *   connect to `postgres`     FATAL: permission denied for database "postgres"
 *   connect to `template1`    FATAL: permission denied for database "template1"
 *   CREATE DATABASE           ERROR: permission denied to create database
 *   CREATE ROLE               ERROR: permission denied to create role
 *   SELECT * FROM pg_shadow   ERROR: permission denied for view pg_shadow
 *   COPY TO PROGRAM 'id'      ERROR: permission denied ... pg_execute_server_program
 *
 * KNOWN AND ACCEPTED LEAK, stated rather than glossed: from inside its own
 * database the role can still read pg_database and pg_roles, so it learns the
 * NAMES `crane_a2` / `crane_a2_u` exist. Postgres offers no supported way to
 * hide those — revoking SELECT on pg_database breaks psql, pg_dump and most
 * drivers — and the names are opaque ids, not app slugs. No row of another app's
 * data is reachable. test/managed-db.test.js asserts this boundary explicitly so
 * it cannot quietly widen from "names" to "data".
 *
 * MARIADB is simpler because its grants are per-database by construction:
 * GRANT ALL PRIVILEGES ON `db`.* — no *.*, and no WITH GRANT OPTION, so the role
 * cannot re-grant itself or anyone else. Measured, as app A against app B:
 *   SELECT ... FROM crane_a2.secrets  ERROR 1142 SELECT command denied
 *   USE crane_a2                      ERROR 1044 Access denied
 *   CREATE DATABASE evil              ERROR 1044 Access denied
 *   CREATE USER                       ERROR 1227 need CREATE USER privilege
 *   SELECT * FROM mysql.global_priv   ERROR 1142 SELECT command denied
 *   SHOW DATABASES                    lists only crane_a1 + information_schema
 * MariaDB does not even leak the other database's name, which is the one place
 * it is stricter than Postgres.
 */
function provisionSql(engine, database, username, password) {
  assertIdent(database);
  assertIdent(username);
  assertPassword(password);

  if (engine === 'postgres') {
    return {
      onServer: [
        `CREATE ROLE "${username}" LOGIN PASSWORD '${password}'`,
        '  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;',
        `CREATE DATABASE "${database}" OWNER "${username}";`,
        `REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;`,
        `GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO "${username}";`,
      ].join('\n'),
      onDatabase: [
        'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
        `ALTER SCHEMA public OWNER TO "${username}";`,
        `GRANT ALL ON SCHEMA public TO "${username}";`,
      ].join('\n'),
    };
  }

  return {
    onServer: [
      `CREATE USER '${username}'@'%' IDENTIFIED BY '${password}';`,
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${username}'@'%';`,
      'FLUSH PRIVILEGES;',
    ].join('\n'),
    onDatabase: null,
  };
}

function rowFor(scope, engine) {
  const { appId, tenant } = normalizeScope(scope);
  return getDb().prepare(
    'SELECT * FROM managed_databases WHERE app_id = ? AND tenant = ? AND engine = ?'
  ).get(appId, tenant, engine) || null;
}

function connectionFor(row, port) {
  const password = decrypt(row.password_enc);
  const scheme = ENGINES[row.engine].scheme;
  return {
    engine: row.engine,
    host: DB_HOST_FOR_CONTAINERS,
    port,
    database: row.db_name,
    username: row.db_user,
    password,
    // base64url passwords need no percent-encoding, which is the other reason
    // the alphabet is what it is.
    url: `${scheme}://${row.db_user}:${password}@${DB_HOST_FOR_CONTAINERS}:${port}/${row.db_name}`,
  };
}

/**
 * Provision (or return the existing) database for a scope. Returns full
 * connection details INCLUDING the password, for the caller to inject into a
 * container's environment. The password is never logged, here or anywhere.
 */
export async function provision(scope, engine) {
  if (!ENGINES[engine]) throw new Error(`managedDb: unknown engine '${engine}' (supported: ${SUPPORTED_ENGINES.join(', ')})`);
  const { appId, tenant } = normalizeScope(scope);

  const server = await ensureServer(engine);

  const existing = rowFor(scope, engine);
  if (existing) return connectionFor(existing, server.port);

  const { database, username } = namesForScope(scope);
  const password = generatePassword();

  // The row goes in FIRST. If the INSERT loses a race — two deploys of the same
  // app, or migration 085's (engine, db_name) collision guard firing — we must
  // not have already created a role in the engine that nothing points at.
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO managed_databases (app_id, tenant, engine, db_name, db_user, password_enc)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(appId, tenant, engine, database, username, encrypt(password));
  } catch (e) {
    if (/UNIQUE constraint/i.test(e.message)) {
      const raced = rowFor(scope, engine);
      if (raced) return connectionFor(raced, server.port);
      throw new Error(
        `managedDb: identifier '${database}' is already provisioned on ${engine} for a different scope. ` +
        `This is a name-derivation collision and provisioning is refusing rather than handing over ` +
        `another scope's database.`
      );
    }
    throw e;
  }

  const sql = provisionSql(engine, database, username, password);
  try {
    await runAdminSql(engine, sql.onServer);
    if (sql.onDatabase) await runAdminSql(engine, sql.onDatabase, { database });
  } catch (e) {
    // Engine-side failure with a row already written would leave AppCrane
    // believing in a database that does not exist. Roll both back.
    db.prepare('DELETE FROM managed_databases WHERE app_id = ? AND tenant = ? AND engine = ?')
      .run(appId, tenant, engine);
    await dropInEngine(engine, database, username).catch(() => {});
    throw new Error(`managedDb: provisioning ${engine} database failed: ${e.message}`);
  }

  log.info(`managedDb: provisioned ${engine} database ${database} for app ${appId}${tenant ? ` tenant ${tenant}` : ''}`);
  return connectionFor(rowFor(scope, engine), server.port);
}

/** Existing credentials for a scope, or null. Does not start a server. */
export function credentialsFor(scope, engine) {
  const row = rowFor(scope, engine);
  if (!row) return null;
  const server = serverRow(engine);
  return connectionFor(row, server?.host_port || ENGINES[engine].defaultPort);
}

/** Rows for an app, without decrypting anything. Safe to hand to an API. */
export function listForApp(appId) {
  return getDb().prepare(
    'SELECT id, app_id, tenant, engine, db_name, db_user, created_at FROM managed_databases WHERE app_id = ?'
  ).all(Number(appId));
}

async function dropInEngine(engine, database, username) {
  assertIdent(database);
  assertIdent(username);
  if (engine === 'postgres') {
    // WITH (FORCE) terminates any session the app still holds — without it a
    // container that has not shut down yet keeps the database undroppable, and
    // a delete that half-succeeds is worse than one that fails.
    await runAdminSql('postgres', [
      `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`,
      `DROP ROLE IF EXISTS "${username}";`,
    ].join('\n'));
    return;
  }
  await runAdminSql('mariadb', [
    `DROP DATABASE IF EXISTS \`${database}\`;`,
    `DROP USER IF EXISTS '${username}'@'%';`,
    'FLUSH PRIVILEGES;',
  ].join('\n'));
}

/**
 * Drop a scope's database and login role, then forget it. Idempotent: a scope
 * that was never provisioned is a no-op.
 */
export async function deprovision(scope, engine) {
  const row = rowFor(scope, engine);
  if (!row) return false;
  await ensureServer(engine);
  await dropInEngine(engine, row.db_name, row.db_user);
  getDb().prepare('DELETE FROM managed_databases WHERE id = ?').run(row.id);
  log.info(`managedDb: deprovisioned ${engine} database ${row.db_name}`);
  return true;
}

/**
 * Every managed database an app owns, across engines and (later) tenants.
 *
 * THIS MUST BE CALLED BEFORE `DELETE FROM apps`. Migration 085's foreign key
 * cascades the ROW away, and SQLite obviously cannot reach into Postgres to drop
 * the database — so a delete that skips this leaves an orphaned database and a
 * live login role holding the deleted app's data, with nothing in AppCrane
 * pointing at either. See the wiring note in the migration.
 */
export async function deprovisionApp(appId) {
  const rows = getDb().prepare('SELECT * FROM managed_databases WHERE app_id = ?').all(Number(appId));
  let dropped = 0;
  for (const row of rows) {
    try {
      await ensureServer(row.engine);
      await dropInEngine(row.engine, row.db_name, row.db_user);
      getDb().prepare('DELETE FROM managed_databases WHERE id = ?').run(row.id);
      dropped++;
    } catch (e) {
      // Never block an app delete on a database server that is down: report it
      // so the orphan is visible, rather than leaving the app undeletable.
      log.warn(`managedDb: could not deprovision ${row.engine} database ${row.db_name} for app ${appId}: ${e.message}`);
    }
  }
  return { requested: rows.length, dropped };
}
