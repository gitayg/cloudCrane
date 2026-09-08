import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// appcrane_provision_database / appcrane_list_databases — the managed-database
// MCP surface.
//
// An agent deploying a catalogue app hits exactly the 503 a human does:
// BookStack and ~53 other entries need a database that does not exist yet. The
// capability to fix it existed only on the HTTP surface, so an agent could
// diagnose the fault and not act on it. These two tools close that, and in
// doing so they inherit the two ways this feature can be got wrong:
//
//   1. AUTHORIZATION. An MCP caller authenticates as an ordinary user. A tool
//      that provisions against any slug is a privilege escalation dressed as
//      convenience — and the subtler half is the TIER: /api/apps/:slug/database
//      is gated by requireAppUser, where an assignment is authoritative for
//      EVERY role including platform_admin (the v2.39.0 guardrail). A tool
//      gated by isAppAdmin() instead would hand every unassigned AppCrane admin
//      a capability the HTTP route refuses them, and the escalation would live
//      in the two surfaces disagreeing rather than in either one alone.
//
//   2. CREDENTIAL LEAKAGE, twice over. provision() resolves to the plaintext
//      password AND a URL with it embedded, correctly, because that is the
//      deployer's input. And runAdminSql throws with the failing command's
//      output, where the failing command is `CREATE ROLE … LOGIN PASSWORD
//      '<pw>'`. A tool result is transcript; a transcript is forwarded, logged
//      and pasted. Both paths are asserted against the ACTUAL BYTES callTool
//      returns, not against the handler's object.
//
// The engine is replaced with a double via __setManagedDbForTests, because the
// real provision() calls ensureServer(), which docker-runs Postgres/MariaDB and
// holds a port. Two tests at the end use the REAL module — one drives
// listForApp() against a real row (it touches no container), the other pins the
// double against drift by asserting the real module still exports what the
// handlers call.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-mdbmcp-'));
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const mcp = await import('../server/services/mcpTools.js');
const { callTool, listTools, getToolCatalog, __setManagedDbForTests } = mcp;

// ── Fixtures ────────────────────────────────────────────────────────────────

let slot = 0;
const mkApp = (slug) => db.prepare(
  'INSERT INTO apps (name,slug,slot,source_type,auth_mode,branch) VALUES (?,?,?,?,?,?)'
).run(slug, slug, ++slot, 'image', 'forward_auth', 'main').lastInsertRowid;

const APP_ID = mkApp('bookstack');
const OTHER_APP_ID = mkApp('someone-elses-app');

let seq = 0;
/**
 * `assignTo` writes app_users — the membership row requireAppUser reads.
 * `roleOn` writes app_user_roles — the per-app ROLE row. They are separate
 * tables and the difference is load-bearing here: the write tier keys on
 * app_users alone, exactly as the HTTP middleware does.
 */
function mkUser({ role = 'user', assignTo = null, roleOn = null, appRole = 'owner', scope = null } = {}) {
  const n = ++seq;
  const key = generateApiKey('dhk_user');
  const id = db.prepare(
    'INSERT INTO users (name,email,role,api_key_hash,active,kind,mcp_app_scope) VALUES (?,?,?,?,1,?,?)'
  ).run(`u${n}`, `u${n}@t.test`, role, hashApiKey(key), 'human', scope).lastInsertRowid;
  if (assignTo) db.prepare('INSERT INTO app_users (app_id,user_id) VALUES (?,?)').run(assignTo, id);
  if (roleOn) {
    db.prepare('INSERT INTO app_user_roles (app_id,user_id,app_role) VALUES (?,?,?)').run(roleOn, id, appRole);
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const MEMBER          = mkUser({ assignTo: APP_ID });                       // assigned to bookstack
const OUTSIDER        = mkUser({ assignTo: OTHER_APP_ID });                 // assigned, but elsewhere
const ADMIN           = mkUser({ role: 'admin' });                          // unassigned
const PLATFORM        = mkUser({ role: 'platform_admin' });                 // unassigned
const ASSIGNED_ADMIN  = mkUser({ role: 'admin', assignTo: APP_ID });        // admin who did the audited step
const ROLE_ONLY       = mkUser({ roleOn: APP_ID, appRole: 'owner' });       // app_user_roles but no app_users
const SCOPED_OUT      = mkUser({ assignTo: APP_ID, scope: JSON.stringify(['someone-elses-app']) });

// ── The engine double ───────────────────────────────────────────────────────
// Mirrors services/managedDb.js: provision() resolves to connectionFor()'s
// shape (password and url included), listForApp() returns the row shape with
// no password column.

const PASSWORD = 'p4ssw0rd-that-must-never-ship-2f8a1c';

let calls;
let rows;
let engineMode; // 'ok' | 'throws-raw'

const rowKey = (scope, engine) => `${scope.appId}:${scope.tenant ?? ''}:${engine}`;

function makeEngine() {
  return {
    SUPPORTED_ENGINES: ['postgres', 'mariadb'],
    async provision(scope, engine) {
      calls.push(['provision', scope, engine]);
      if (engineMode === 'throws-raw') {
        // What runAdminSql actually throws: the command output, which for a
        // failed provision carries the statement holding the password.
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
        });
      }
      const row = rows.get(k);
      // The real return value: credentials, not a view model.
      return {
        engine,
        host: 'host.docker.internal',
        port: engine === 'postgres' ? 45432 : 43306,
        database: row.db_name,
        username: row.db_user,
        password: PASSWORD,
        url: `${engine === 'postgres' ? 'postgresql' : 'mysql'}://${row.db_user}:${PASSWORD}@host.docker.internal/${row.db_name}`,
      };
    },
    listForApp(appId) {
      calls.push(['listForApp', appId]);
      return [...rows.values()].filter((r) => r.app_id === Number(appId));
    },
  };
}

beforeEach(() => {
  calls = [];
  rows = new Map();
  engineMode = 'ok';
  __setManagedDbForTests(makeEngine());
});

after(() => __setManagedDbForTests(null));

/** The bytes an MCP client actually receives. */
const textOf = (result) => result.content.map((c) => c.text).join('\n');
const jsonOf = (result) => JSON.parse(textOf(result));

async function refusal(user, name, args, key = null) {
  const err = await callTool(user, name, args, key).then(
    () => null,
    (e) => e
  );
  assert.ok(err, `${name} was expected to be refused for user ${user.id} and was not`);
  return err.message;
}

// ── Catalogue metadata ──────────────────────────────────────────────────────

test('both tools are advertised, and only the read one is marked readOnly', () => {
  const byName = new Map(getToolCatalog().map((t) => [t.name, t]));

  const provision = byName.get('appcrane_provision_database');
  const list = byName.get('appcrane_list_databases');
  assert.ok(provision, 'appcrane_provision_database is missing from the catalogue');
  assert.ok(list, 'appcrane_list_databases is missing from the catalogue');

  // readOnly is an opt-IN that decides whether a read-only MCP key may call the
  // tool. Marking the write tool readOnly would hand every read-only key on the
  // platform the ability to create infrastructure.
  assert.equal(provision.readOnly, false, 'provisioning creates real infrastructure and is not a read');
  assert.equal(list.readOnly, true);

  // Both do their real authorization per-slug in the handler; 'app_admin' here
  // would hide the write tool from the assigned plain users the HTTP route
  // accepts.
  assert.equal(provision.requiredRole, 'any');
  assert.equal(list.requiredRole, 'any');

  // The engine is required rather than guessed: an app may hold one of each.
  assert.deepEqual(provision.inputSchema.required, ['slug', 'engine']);
  assert.deepEqual(provision.inputSchema.properties.engine.enum, ['postgres', 'mariadb']);
  assert.equal(provision.inputSchema.additionalProperties, false);

  // The schema must not accept a tenant: namesForScope() hashes one into the
  // database name, and there is no authorization model for a tenant yet.
  assert.equal(provision.inputSchema.properties.tenant, undefined);
});

// ── Authorization: who may provision ────────────────────────────────────────

test('an assigned app user can provision — the baseline every refusal below is measured against', async () => {
  const out = jsonOf(await callTool(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' }));
  assert.equal(out.app, 'bookstack');
  assert.equal(out.database.engine, 'mariadb');
  assert.equal(out.database.database, `crane_a${APP_ID}`);

  // The scope reached the engine in the documented shape, with no tenant.
  const provisioned = calls.filter((c) => c[0] === 'provision');
  assert.equal(provisioned.length, 1);
  assert.deepEqual(provisioned[0][1], { appId: APP_ID, tenant: null });
  assert.equal(provisioned[0][2], 'mariadb');
});

test('a user with no relationship to the app cannot provision against it', async () => {
  const msg = await refusal(OUTSIDER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  assert.match(msg, /Forbidden/);
  // The refusal must land BEFORE the engine — a check that runs after
  // provision() has already created a role is not an authorization check.
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM managed_databases').get().c, 0);
});

test('an UNASSIGNED admin or platform_admin cannot provision, and is told how to proceed', async () => {
  // The v2.39.0 guardrail, applied to a new resource. Both admin tiers get past
  // getAppForUser (they can see every app) and must still be refused here — this
  // is the case where the MCP surface would silently become looser than the
  // HTTP one.
  for (const [label, user] of [['admin', ADMIN], ['platform_admin', PLATFORM]]) {
    const msg = await refusal(user, 'appcrane_provision_database', { slug: 'bookstack', engine: 'postgres' });
    assert.match(msg, /Forbidden/, `${label} was not refused`);
    assert.match(msg, /Assign yourself to 'bookstack'/, `${label} got no actionable message`);
    assert.match(msg, /appcrane_grant_app_access/);
  }
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);

  // Paired baseline: the same role, once assigned, is allowed. Without this the
  // two assertions above would also pass if the tool refused everybody.
  const out = jsonOf(await callTool(ASSIGNED_ADMIN, 'appcrane_provision_database', { slug: 'bookstack', engine: 'postgres' }));
  assert.equal(out.database.engine, 'postgres');
});

test('the write tier keys on the membership row, not on a per-app role', async () => {
  // ROLE_ONLY holds app_user_roles owner but no app_users row. requireAppUser
  // reads app_users alone, so the HTTP route refuses this state and so must the
  // tool. In practice both tables are written together (grant_app_access,
  // create_app); this pins the tier so the two surfaces cannot drift apart.
  const msg = await refusal(ROLE_ONLY, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  assert.match(msg, /Forbidden/);
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);

  // ...but that same user CAN read, which is the app-access tier the GET route
  // uses. A refusal on both would make the test above meaningless.
  const out = jsonOf(await callTool(ROLE_ONLY, 'appcrane_list_databases', { slug: 'bookstack' }));
  assert.equal(out.app, 'bookstack');
});

test('a read-only MCP key may list but may not provision', async () => {
  const readOnlyKey = { read_only: 1 };
  const msg = await refusal(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' }, readOnlyKey);
  assert.match(msg, /read-only/);
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);

  // Paired baseline. MEMBER is an owner of nothing, so drive the read with a
  // user the personal-key path accepts.
  const out = jsonOf(await callTool(ROLE_ONLY, 'appcrane_list_databases', { slug: 'bookstack' }, { read_only: 1 }));
  assert.equal(out.count, 0);
});

test('an mcp_app_scope ceiling refuses provisioning outside it', async () => {
  const msg = await refusal(SCOPED_OUT, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  assert.match(msg, /outside this key's MCP scope/);
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);
});

test('an unknown engine is refused before anything is created', async () => {
  const msg = await refusal(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'sqlserver' });
  assert.match(msg, /engine must be one of: postgres, mariadb/);
  assert.deepEqual(calls.filter((c) => c[0] === 'provision'), []);
});

test('provisioning an app that does not exist does not disclose more than "not found"', async () => {
  const msg = await refusal(MEMBER, 'appcrane_provision_database', { slug: 'no-such-app', engine: 'mariadb' });
  assert.match(msg, /App not found/);
});

// ── The credential never reaches the transcript ─────────────────────────────

test('the provision result carries no password, no URL, and no host', async () => {
  const result = await callTool(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  const text = textOf(result);

  // Asserted on the serialized bytes, because that is what an MCP client, a
  // transcript store and a log all see. The engine double DID return the
  // password on this call — see makeEngine — so an empty assertion is not
  // possible here.
  assert.ok(!text.includes(PASSWORD), `the generated password appeared in the tool result:\n${text}`);
  assert.ok(!/password/i.test(text.replace(/No password is returned[^"]*/i, '')),
    `a password-shaped field appeared in the tool result:\n${text}`);
  assert.ok(!text.includes('host.docker.internal'));
  assert.ok(!/mysql:\/\/|postgresql:\/\//.test(text), 'a connection URL appeared in the tool result');

  const out = jsonOf(result);
  assert.deepEqual(Object.keys(out.database).sort(), ['created_at', 'database', 'engine', 'scope', 'username']);
  assert.match(out.next, /appcrane_deploy/);
});

test('the list result carries no password even when the row holds one', async () => {
  await callTool(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  const text = textOf(await callTool(MEMBER, 'appcrane_list_databases', { slug: 'bookstack' }));
  assert.ok(!text.includes(PASSWORD), `the password appeared in the list result:\n${text}`);
  assert.ok(!text.includes('password_enc'));
});

test('an engine failure is reported without echoing the engine message', async () => {
  engineMode = 'throws-raw';
  const msg = await refusal(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'postgres' });

  // The double throws the real shape: command output containing CREATE ROLE …
  // LOGIN PASSWORD '<pw>'. None of it may be relayed.
  assert.ok(!msg.includes(PASSWORD), `the engine's message leaked the password:\n${msg}`);
  assert.ok(!msg.includes('CREATE ROLE'), `the engine's failing statement was echoed:\n${msg}`);
  assert.match(msg, /failed to provision a postgres database for bookstack/);
  assert.match(msg, /safe to retry/);
});

test('the audit trail records the call without recording a credential', async () => {
  await callTool(MEMBER, 'appcrane_provision_database', { slug: 'bookstack', engine: 'mariadb' });
  const row = db.prepare(
    "SELECT * FROM audit_log WHERE action = 'mcp.appcrane_provision_database' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(row, 'the provisioning call was not audited');
  assert.equal(row.app_id, APP_ID);
  assert.ok(!row.detail.includes(PASSWORD));
});

// ── The read path, against the REAL engine module ───────────────────────────

test('listing reads real rows through the real module and returns no secret column', async () => {
  // listForApp() is pure SQL — it starts no container — so this exercises the
  // production code path rather than the double.
  __setManagedDbForTests(null);
  const { encrypt } = await import('../server/services/encryption.js');
  db.prepare(
    'INSERT INTO managed_databases (app_id,tenant,engine,db_name,db_user,password_enc) VALUES (?,?,?,?,?,?)'
  ).run(APP_ID, '', 'mariadb', 'crane_areal', 'crane_areal_u', encrypt(PASSWORD));

  const result = await callTool(MEMBER, 'appcrane_list_databases', { slug: 'bookstack' });
  const text = textOf(result);
  const out = jsonOf(result);

  assert.equal(out.count, 1);
  assert.equal(out.databases[0].database, 'crane_areal');
  assert.equal(out.databases[0].username, 'crane_areal_u');
  assert.deepEqual(out.databases[0].scope, { app: 'bookstack', tenant: null });
  assert.deepEqual(out.engines, ['postgres', 'mariadb']);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes('password_enc'));

  db.prepare('DELETE FROM managed_databases WHERE app_id = ?').run(APP_ID);
});

test('the real engine module still exports everything the handlers call', async () => {
  // The double is only honest while this holds. A rename in managedDb.js would
  // otherwise leave every test above green and the tools broken in production.
  const real = await import('../server/services/managedDb.js');
  for (const name of ['provision', 'listForApp', 'SUPPORTED_ENGINES']) {
    assert.ok(real[name] !== undefined, `services/managedDb.js no longer exports ${name}`);
  }
  assert.equal(typeof real.provision, 'function');
  assert.equal(typeof real.listForApp, 'function');
  assert.deepEqual(real.SUPPORTED_ENGINES, ['postgres', 'mariadb']);
});

// ── Visibility ──────────────────────────────────────────────────────────────

test('a plain user sees both tools in tools/list, and a read-only key sees only the read', () => {
  const names = listTools(MEMBER).map((t) => t.name);
  assert.ok(names.includes('appcrane_provision_database'));
  assert.ok(names.includes('appcrane_list_databases'));

  const readOnlyNames = listTools(MEMBER, { read_only: 1 }).map((t) => t.name);
  assert.ok(!readOnlyNames.includes('appcrane_provision_database'));
  assert.ok(readOnlyNames.includes('appcrane_list_databases'));
});
