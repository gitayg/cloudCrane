import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// /api/apps/:slug/database — the managed-database HTTP surface.
//
// Two things can go wrong here and neither is caught by "it returns 200":
//
//   1. AUTHORIZATION. The route takes an app identifier from the URL, so
//      requiring only authentication would let any logged-in user create a
//      database — holding a live credential — against ANY app on the box. That
//      is the IDOR class scripts/check-route-authz.mjs exists to reject, and
//      the class behind most of the 2026 self-hosted-PaaS advisory wave.
//
//   2. CREDENTIAL LEAKAGE. services/managedDb.js provision() returns the
//      plaintext password AND a connection URL with it embedded — correctly, so
//      the deployer can inject them. The router must discard that and rebuild
//      its response from listForApp(). The double below returns exactly that
//      shape, and an engine that throws the CREATE ROLE statement back, and the
//      tests assert the password never appears in the bytes sent to a client.
//
// The engine is replaced with a double via __setEngineForTests, because the
// real provision() calls ensureServer(), which docker-runs Postgres/MariaDB.
// The last test in this file guards the double against drift by asserting the
// real module still exports everything the router calls.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-mdb-'));
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
const { errorHandler } = await import('../server/utils/errors.js');
initDb();
const db = getDb();

let slot = 0;
const mkApp = (slug) => db.prepare(
  'INSERT INTO apps (name,slug,slot,source_type,auth_mode,branch) VALUES (?,?,?,?,?,?)'
).run(slug, slug, ++slot, 'image', 'forward_auth', 'main').lastInsertRowid;

const APP_ID = mkApp('bookstack');
const OTHER_APP_ID = mkApp('someone-elses-app');

let seq = 0;
function mkUser(role, { assignTo = null } = {}) {
  const n = ++seq;
  const key = generateApiKey('dhk_user');
  const id = db.prepare(
    'INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES (?,?,?,?,1,?)'
  ).run(`u${n}`, `u${n}@t.test`, role, hashApiKey(key), 'human').lastInsertRowid;
  if (assignTo) db.prepare('INSERT INTO app_users (app_id,user_id) VALUES (?,?)').run(assignTo, id);
  return key;
}

const OWNER = mkUser('user', { assignTo: APP_ID });          // assigned to bookstack
const OUTSIDER = mkUser('user', { assignTo: OTHER_APP_ID }); // assigned, but elsewhere
const ADMIN = mkUser('admin');                               // unassigned
const PLATFORM = mkUser('platform_admin');                   // unassigned

// ── The engine double ──────────────────────────────────────────────────────
// It mirrors services/managedDb.js: provision() resolves to connectionFor()'s
// shape (password and url included), listForApp() returns the row shape without
// password_enc, deprovision() returns a boolean.

const PASSWORD = 'p4ssw0rd-that-must-never-ship-2f8a1c';

let calls;
let rows;        // the double's managed_databases table
let engineMode;  // 'ok' | 'throws-raw'

const rowKey = (scope, engine) => `${scope.appId}:${scope.tenant ?? ''}:${engine}`;

function makeEngine() {
  return {
    SUPPORTED_ENGINES: ['postgres', 'mariadb'],
    async provision(scope, engine) {
      calls.push(['provision', scope, engine]);
      if (engineMode === 'throws-raw') {
        // What runAdminSql actually throws: the command output, which for a
        // failed provision contains the statement carrying the password.
        throw new Error(`ERROR: role already exists\nSTATEMENT: CREATE ROLE "x" LOGIN PASSWORD '${PASSWORD}'`);
      }
      const k = rowKey(scope, engine);
      if (!rows.has(k)) {
        rows.set(k, {
          id: rows.size + 1,
          app_id: scope.appId,
          tenant: scope.tenant ?? '',
          engine,
          db_name: `crane_a${scope.appId}`,
          db_user: `crane_a${scope.appId}_u`,
          created_at: '2026-09-07T00:00:00Z',
          password_enc: `enc:${PASSWORD}`,
        });
      }
      const row = rows.get(k);
      // The real return value: credentials, not a view model.
      return {
        engine, host: 'host.docker.internal', port: engine === 'postgres' ? 45432 : 43306,
        database: row.db_name, username: row.db_user, password: PASSWORD,
        url: `${engine === 'postgres' ? 'postgresql' : 'mysql'}://${row.db_user}:${PASSWORD}@host.docker.internal/${row.db_name}`,
      };
    },
    listForApp(appId) {
      calls.push(['listForApp', appId]);
      return [...rows.values()].filter(r => r.app_id === Number(appId));
    },
    async deprovision(scope, engine) {
      calls.push(['deprovision', scope, engine]);
      return rows.delete(rowKey(scope, engine));
    },
  };
}

const routes = await import('../server/routes/managedDb.js');

beforeEach(() => {
  calls = [];
  rows = new Map();
  engineMode = 'ok';
  routes.__setEngineForTests(makeEngine());
});

const api = express();
api.use(express.json());
api.use('/api/apps', routes.default);
api.use(errorHandler);
const server = await new Promise((r) => { const s = api.listen(0, () => r(s)); });
after(() => { server.closeAllConnections?.(); server.unref(); server.close(); });
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { key = null, body = undefined } = {}) {
  const headers = {};
  if (key) headers['X-API-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* html/empty */ }
  return { status: res.status, text, body: parsed };
}

const provision = (k, body = { engine: 'postgres' }) =>
  call('POST', '/api/apps/bookstack/database', { key: k, body });
const wrote = () => calls.filter(([n]) => n === 'provision' || n === 'deprovision');

// ── 1. Per-app authorization ───────────────────────────────────────────────

test('an anonymous caller cannot provision a database', async () => {
  const { status } = await provision(null);
  assert.equal(status, 401);
  assert.deepEqual(calls, [], 'the engine must not be reached without authentication');
});

test('a logged-in user assigned to a DIFFERENT app is refused — the IDOR case', async () => {
  // The whole point of the per-app check: OUTSIDER is a perfectly valid,
  // authenticated user with a real app assignment. It is just not this app.
  const { status, body } = await provision(OUTSIDER);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.deepEqual(calls, [], 'no database may be created for an app the caller cannot touch');
});

test('an outsider cannot READ what another app has provisioned', async () => {
  const { status } = await call('GET', '/api/apps/bookstack/database', { key: OUTSIDER });
  assert.equal(status, 403);
  assert.deepEqual(calls, []);
});

test('an outsider cannot DEPROVISION another app\'s database', async () => {
  const { status } = await call(
    'DELETE', '/api/apps/bookstack/database?engine=postgres&confirm=bookstack', { key: OUTSIDER });
  assert.equal(status, 403);
  assert.deepEqual(calls, [], 'authorization must run before the destructive call');
});

test('an UNASSIGNED admin is blocked from provisioning', async () => {
  // Same guardrail env vars and backups get (requireAppUser, v2.39.0): a
  // credential injected into the app is app data, not platform administration.
  const { status, body } = await provision(ADMIN);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'ADMIN_BLOCKED');
  assert.deepEqual(calls, []);
});

test('an UNASSIGNED platform_admin is blocked from provisioning', async () => {
  const { status, body } = await provision(PLATFORM);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'ADMIN_BLOCKED');
  assert.deepEqual(calls, []);
});

test('the assigned app user is allowed', async () => {
  const { status, body } = await provision(OWNER);
  assert.equal(status, 200);
  assert.equal(body.database.engine, 'postgres');
  assert.equal(body.database.database, `crane_a${APP_ID}`);
  assert.equal(body.database.username, `crane_a${APP_ID}_u`);
});

test('an unknown app slug is 404, not 403 or 500', async () => {
  const { status, body } = await call('POST', '/api/apps/no-such-app/database',
    { key: OWNER, body: { engine: 'postgres' } });
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.deepEqual(calls, []);
});

// ── 2. The password never crosses the wire ─────────────────────────────────

test('the provision response contains neither the password nor the connection URL', async () => {
  // The engine hands back both. Everything the client sees is rebuilt from
  // listForApp(), so neither can survive the trip.
  const { status, text } = await provision(OWNER);
  assert.equal(status, 200);
  assert.ok(!text.includes(PASSWORD), 'the generated password appeared in the response body');
  assert.ok(!text.includes('password'),
    'no password-shaped field may appear at all — not even an encrypted one');
  assert.ok(!text.includes('postgresql://'),
    'the connection URL embeds the password and must not be returned');
});

test('the read response contains no password either', async () => {
  await provision(OWNER);
  const { status, text, body } = await call('GET', '/api/apps/bookstack/database', { key: OWNER });
  assert.equal(status, 200);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes('password'));
  // It still reports what the app HAS — engine, database, user.
  assert.equal(body.databases.length, 1);
  assert.equal(body.databases[0].engine, 'postgres');
  assert.equal(body.databases[0].username, `crane_a${APP_ID}_u`);
});

test('an engine error that quotes the password is not echoed to the caller', async () => {
  // runAdminSql throws with the command output, and a failed provision's output
  // can contain the CREATE ROLE statement carrying the credential. Passing
  // err.message through would put it in the browser console.
  engineMode = 'throws-raw';
  routes.__setEngineForTests(makeEngine());
  const { status, text, body } = await provision(OWNER);
  assert.equal(status, 502);
  assert.equal(body.error.code, 'MANAGED_DB_ENGINE_ERROR');
  assert.ok(!text.includes(PASSWORD), 'the engine error leaked the password into the response');
  assert.ok(!text.includes('CREATE ROLE'), 'the raw failing statement must not be echoed');
});

test('GET reports an empty list when nothing is provisioned', async () => {
  const { status, body } = await call('GET', '/api/apps/bookstack/database', { key: OWNER });
  assert.equal(status, 200);
  assert.deepEqual(body.databases, [], 'no database is an answer, not a 404');
  assert.deepEqual(body.engines, ['postgres', 'mariadb'], 'the UI is told what it may ask for');
});

test('one app cannot see another app\'s databases through its own endpoint', async () => {
  // listForApp is filtered by app id, but the filter is what makes the read
  // per-app rather than platform-wide — break it and this goes red.
  await provision(OWNER);
  rows.set('999::postgres', {
    id: 99, app_id: OTHER_APP_ID, tenant: '', engine: 'postgres',
    db_name: 'crane_a999', db_user: 'crane_a999_u', created_at: 'x', password_enc: 'y',
  });
  const { body } = await call('GET', '/api/apps/bookstack/database', { key: OWNER });
  assert.deepEqual(body.databases.map(d => d.database), [`crane_a${APP_ID}`]);
});

// ── 3. The provisioning scope carries a tenant dimension ───────────────────

test('the engine is handed a scope record, not a bare app id or slug', async () => {
  // "Supports multitenancy eventually" fails at exactly this line if the router
  // passes app.slug or a bare id — every signature downstream then hard-codes
  // one dimension and a tenant has nowhere to go. normalizeScope() in the
  // engine reads { appId, tenant }.
  await provision(OWNER);
  const [, scope, engine] = calls.find(([n]) => n === 'provision');
  assert.deepEqual(scope, { appId: APP_ID, tenant: null });
  assert.equal(engine, 'postgres');
});

test('the response echoes the scope so a caller can tell app from tenant', async () => {
  const { body } = await provision(OWNER);
  assert.deepEqual(body.database.scope, { app: 'bookstack', tenant: null });
});

test('a client-supplied tenant is refused, not silently ignored', async () => {
  // Accepting one today would be an IDOR: nothing in this router can check that
  // the caller is entitled to tenant 'acme.com'. Refusing keeps the shape
  // available without opening the hole.
  const { status, body } = await provision(OWNER, { engine: 'postgres', tenant: 'acme.com' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'TENANT_SCOPE_UNSUPPORTED');
  assert.deepEqual(calls, []);
});

test('an explicit tenant:null is accepted — it is the current scope', async () => {
  const { status } = await provision(OWNER, { engine: 'postgres', tenant: null });
  assert.equal(status, 200);
});

// ── 4. Input validation ────────────────────────────────────────────────────

test('an unknown engine is rejected before anything is provisioned', async () => {
  for (const bad of ['sqlite', 'postgres; DROP', '', undefined]) {
    calls = [];
    const { status, body } = await provision(OWNER, { engine: bad });
    assert.equal(status, 400, `engine=${JSON.stringify(bad)} should be rejected`);
    assert.equal(body.error.code, 'INVALID_ENGINE');
    assert.deepEqual(wrote(), [], 'an unvalidated engine string must not reach provisioning');
  }
});

test('engine names are case-insensitive', async () => {
  const { status, body } = await provision(OWNER, { engine: 'MariaDB' });
  assert.equal(status, 200);
  assert.equal(body.database.engine, 'mariadb');
});

// ── 5. Idempotency and the two-engine case ─────────────────────────────────

test('provisioning twice yields one database, not two', async () => {
  await provision(OWNER);
  const { status, body } = await provision(OWNER);
  assert.equal(status, 200);
  assert.equal(body.databases.length, 1,
    'the engine returns the existing database rather than rotating the credential '
    + 'out from under a running container');
});

test('an app may hold one database per engine', async () => {
  await provision(OWNER, { engine: 'postgres' });
  const { body } = await provision(OWNER, { engine: 'mariadb' });
  assert.deepEqual(body.databases.map(d => d.engine).sort(), ['mariadb', 'postgres']);
  assert.equal(body.database.engine, 'mariadb', '`database` is the one just asked for');
});

// ── 6. Deprovision ─────────────────────────────────────────────────────────

test('deprovision without the confirmation token drops nothing', async () => {
  await provision(OWNER);
  calls = [];
  const { status, body } = await call(
    'DELETE', '/api/apps/bookstack/database?engine=postgres', { key: OWNER });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'CONFIRM_REQUIRED');
  assert.deepEqual(wrote(), [], 'nothing may be dropped');
});

test('deprovision with the wrong slug as confirmation drops nothing', async () => {
  await provision(OWNER);
  calls = [];
  const { status } = await call(
    'DELETE', '/api/apps/bookstack/database?engine=postgres&confirm=someone-elses-app',
    { key: OWNER });
  assert.equal(status, 400);
  assert.deepEqual(wrote(), []);
});

test('deprovision without naming an engine drops nothing', async () => {
  // An app may hold both. Guessing which to destroy is not this endpoint's job.
  await provision(OWNER);
  calls = [];
  const { status, body } = await call(
    'DELETE', '/api/apps/bookstack/database?confirm=bookstack', { key: OWNER });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_ENGINE');
  assert.deepEqual(wrote(), []);
});

test('deprovision drops only the engine named', async () => {
  await provision(OWNER, { engine: 'postgres' });
  await provision(OWNER, { engine: 'mariadb' });
  const { status, body } = await call(
    'DELETE', '/api/apps/bookstack/database?engine=postgres&confirm=bookstack', { key: OWNER });
  assert.equal(status, 200);
  assert.equal(body.removed, true);
  assert.deepEqual(body.databases.map(d => d.engine), ['mariadb']);
});

test('deprovisioning when nothing is provisioned reports removed:false, not an error', async () => {
  const { status, body } = await call(
    'DELETE', '/api/apps/bookstack/database?engine=postgres&confirm=bookstack', { key: OWNER });
  assert.equal(status, 200);
  assert.equal(body.removed, false);
});

// ── 7. The double must not drift away from the real engine ─────────────────

test('services/managedDb.js still exports everything this router calls', async () => {
  // Every test above runs against a double. Without this, the engine could
  // rename provision() and all 27 would stay green while production 500s.
  const real = await import('../server/services/managedDb.js');
  for (const fn of ['provision', 'deprovision', 'listForApp']) {
    assert.equal(typeof real[fn], 'function', `services/managedDb.js must export ${fn}()`);
  }
  assert.ok(Array.isArray(real.SUPPORTED_ENGINES) && real.SUPPORTED_ENGINES.length,
    'SUPPORTED_ENGINES must be a non-empty array — the router validates against it');
  // Arity, so a signature change from (scope, engine) is caught here rather
  // than by a provisioning call that silently does the wrong thing.
  assert.equal(real.provision.length, 2, 'provision(scope, engine)');
  assert.equal(real.deprovision.length, 2, 'deprovision(scope, engine)');
  assert.equal(real.listForApp.length, 1, 'listForApp(appId)');
});

test('the double returns the same field names the real engine does', async () => {
  // listForApp() is the router's only read source, so its column names are the
  // contract publicView() maps. Compare against the real SELECT.
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../server/services/managedDb.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function listForApp');
  assert.ok(start > 0, 'could not locate listForApp in services/managedDb.js');
  const fnBody = src.slice(start, src.indexOf('\n}', start));
  const select = fnBody.match(/SELECT ([^']*) FROM managed_databases/)?.[1];
  assert.ok(select, 'could not locate listForApp\'s SELECT');
  for (const col of ['engine', 'db_name', 'db_user', 'created_at', 'tenant']) {
    assert.ok(select.includes(col), `listForApp must select ${col} — publicView() reads it`);
  }
  assert.ok(!select.includes('password'),
    'listForApp must not select the password column — it is the router\'s safe read path');
});
