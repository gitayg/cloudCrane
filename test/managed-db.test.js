import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Managed databases (server/services/managedDb.js).
//
// THE REQUIREMENT THIS FILE EXISTS TO PROVE: "an app's credentials must reach
// that app's database and NOTHING else."
//
// A test that connects as app A and reads app A's data proves nothing about
// that. It proves the happy path works. So every isolation assertion below is
// an ATTACK — app A's real credentials, pointed at app B's database, at the
// server catalog, at CREATE DATABASE — and each one has to FAIL. And because a
// test where everything fails is equally worthless (a misconfigured client
// fails too), each attack is paired with a CONTROL that must SUCCEED: B's own
// credentials reading the same row A was denied. The control is what turns a
// denial into evidence.
//
// The attacks are run through the engine's own client inside the server
// container, over TCP to 127.0.0.1 — the host-based auth path, the same one an
// app container traverses. A unix-socket connection would take a different
// pg_hba line (`local ... trust`) and prove the wrong thing.
//
// There is also a real end-to-end reachability test: a container placed on the
// live `appcrane-apps` network (enable_icc=false) connecting to its database
// through host.docker.internal. That is the claim the whole design rests on and
// the one that is easiest to get wrong — see the measurement table in
// managedDb.js's header for the Linux/Desktop split it is guarding.

const PREFIX = 'appcrane-dbtest';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-mdb-'));
process.env.ENCRYPTION_KEY = 'e'.repeat(64);
process.env.LOG_LEVEL = 'error';
// Distinct container names and ports so a run on a developer's machine cannot
// adopt, and later delete, the platform's real database servers.
process.env.MANAGED_DB_CONTAINER_PREFIX = PREFIX;
process.env.MANAGED_DB_POSTGRES_PORT = '45599';
process.env.MANAGED_DB_MARIADB_PORT = '43399';

let dockerOk = false;
try {
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000, stdio: 'pipe' });
  dockerOk = true;
} catch (_) { /* left false */ }
const noDocker = dockerOk ? false : 'no reachable Docker daemon on this host';

const { initDb, getDb } = await import('../server/db.js');
const mdb = await import('../server/services/managedDb.js');

let APP_A;
let APP_B;

before(() => {
  initDb(process.env.DATA_DIR);
  const db = getDb();
  const ins = db.prepare("INSERT INTO apps (name, slug, slot) VALUES (?, ?, ?)");
  APP_A = Number(ins.run('App A', 'app-a', 1).lastInsertRowid);
  APP_B = Number(ins.run('App B', 'app-b', 2).lastInsertRowid);
});

after(async () => {
  if (dockerOk) {
    await mdb.stopServer('postgres').catch(() => {});
    await mdb.stopServer('mariadb').catch(() => {});
  }
  try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Naming — the silent cross-app data leak this scheme is designed against
// ---------------------------------------------------------------------------

test('migration 085 applied and the tables exist', () => {
  // Not an exact set: migration 065's managed_push_chunks shares the prefix.
  const names = getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%' ORDER BY name"
  ).all().map(r => r.name);
  for (const t of ['managed_databases', 'managed_db_servers']) {
    assert.ok(names.includes(t), `${t} missing; got ${names.join(', ')}`);
  }
  // The collision guard from 085 — the index that turns a name-derivation bug
  // into a failed INSERT instead of a cross-app data leak.
  const idx = getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='managed_databases'"
  ).all().map(r => r.name);
  assert.ok(idx.includes('idx_managed_databases_name'));
  assert.ok(idx.includes('idx_managed_databases_scope'));
  const applied = getDb().prepare("SELECT 1 FROM _migrations WHERE name = '085-managed-databases.sql'").get();
  assert.ok(applied, '085 should be recorded in _migrations');
});

test('names are derived from a SCOPE, and the tenant dimension is already carried', () => {
  assert.deepEqual(mdb.namesForScope({ appId: 42 }), { database: 'crane_a42', username: 'crane_a42_u' });

  // The same app with a tenant is a DIFFERENT database — this is the property
  // that makes multitenancy a change in namesForScope and nowhere else.
  const t1 = mdb.namesForScope({ appId: 42, tenant: 'acme.com/u7' });
  const t2 = mdb.namesForScope({ appId: 42, tenant: 'acme.com/u8' });
  const bare = mdb.namesForScope({ appId: 42 });
  assert.notEqual(t1.database, bare.database);
  assert.notEqual(t1.database, t2.database);
  assert.match(t1.database, /^crane_a42_t[0-9a-f]{12}$/);

  // Stable across calls, or a redeploy would provision a second database and
  // point the app at an empty one.
  assert.deepEqual(mdb.namesForScope({ appId: 42, tenant: 'acme.com/u7' }), t1);

  // null and '' are the same scope: the app itself.
  assert.deepEqual(mdb.namesForScope({ appId: 42, tenant: null }), bare);
  assert.deepEqual(mdb.namesForScope({ appId: 42, tenant: '' }), bare);
});

test('a tenant long enough to truncate does NOT collide with another tenant', () => {
  // The failure this guards: names built by slugging a long scope get silently
  // truncated by Postgres at 63 bytes, and two scopes sharing a prefix land on
  // ONE identifier — app B handed app A's database, with every grant satisfied.
  const long = 'a'.repeat(4000);
  const x = mdb.namesForScope({ appId: 7, tenant: `${long}-one` });
  const y = mdb.namesForScope({ appId: 7, tenant: `${long}-two` });
  assert.notEqual(x.database, y.database);
  assert.ok(Buffer.byteLength(x.username) <= 31, `username ${x.username} must fit the tightest engine limit`);
  assert.ok(Buffer.byteLength(x.database) <= 31);
});

test('an identifier that would have to be truncated is refused, not truncated', () => {
  assert.throws(
    () => mdb.namesForScope({ appId: 12345678901234, tenant: 'x' }),
    /over the 31-byte ceiling/
  );
});

test('a malformed scope is rejected before any SQL is built', () => {
  for (const bad of [undefined, {}, { appId: 0 }, { appId: -1 }, { appId: 'app-a' }, { appId: 1.5 }]) {
    assert.throws(() => mdb.namesForScope(bad), /positive integer/);
  }
});

test('an unknown engine is refused', async () => {
  await assert.rejects(() => mdb.provision({ appId: APP_A }, 'oracle'), /unknown engine/);
});

// ---------------------------------------------------------------------------
// Live engines
// ---------------------------------------------------------------------------

/** Run a client inside the server container, as a given app's credentials. */
async function asUser(engine, { username, password, database, sql }) {
  // `username`, not `user`: connectionFor() returns `username`, and an earlier
  // draft of this helper destructured `user`. Every ATTACK below then connected
  // as the role literally named "undefined", was denied, and the test went
  // green — proving nothing except that a nonexistent role cannot log in. The
  // CONTROL test is what caught it, which is the entire reason it is here.
  assert.ok(username && password, 'asUser needs real credentials, or a denial proves nothing');
  const container = `${PREFIX}-${engine}`;
  const args = engine === 'postgres'
    ? ['exec', '-e', `PGPASSWORD=${password}`, '-i', container,
       'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
       '-h', '127.0.0.1', '-p', '5432', '-U', username, '-d', database, '-c', sql]
    : ['exec', '-i', container, 'mariadb', '--batch', '--skip-column-names',
       '--protocol=tcp', '-h', '127.0.0.1', '-P', '3306',
       '-u', username, `-p${password}`, '-D', database, '-e', sql];
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 60000 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { ok: false, out: (e.stderr?.toString() || e.stdout?.toString() || e.message).trim() };
  }
}

/** Same, but without naming a database — for `SHOW DATABASES` style probes. */
async function asUserNoDb(engine, { username, password, sql }) {
  return asUser(engine, { username, password, database: 'information_schema', sql });
}

for (const engine of ['postgres', 'mariadb']) {
  test(`[${engine}] provisions, isolates, and deprovisions`, { skip: noDocker, timeout: 600000 }, async (t) => {
    const a = await mdb.provision({ appId: APP_A }, engine);
    const b = await mdb.provision({ appId: APP_B }, engine);

    await t.test('the server is published on loopback and never on 0.0.0.0', async () => {
      const { stdout } = await execFileAsync('docker', ['port', `${PREFIX}-${engine}`]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      assert.ok(lines.length > 0, 'the server must publish at least one host port');
      assert.ok(
        lines.some(l => l.includes('127.0.0.1:')),
        `expected a loopback publish, got:\n${stdout}`
      );
      for (const line of lines) {
        assert.ok(
          !/(^|\s|>)0\.0\.0\.0:/.test(line) && !/\[::\]:/.test(line),
          `a managed database must never be published on a wildcard address, got: ${line}`
        );
      }
    });

    await t.test('credentials are returned to the caller but stored encrypted', () => {
      assert.match(a.password, /^[A-Za-z0-9_-]{24,}$/);
      assert.notEqual(a.password, b.password);
      assert.equal(a.host, 'host.docker.internal');
      assert.ok(a.url.includes(a.database));

      const row = getDb().prepare('SELECT password_enc FROM managed_databases WHERE app_id = ? AND engine = ?')
        .get(APP_A, engine);
      assert.ok(!row.password_enc.includes(a.password), 'the stored blob must not contain the plaintext');
      assert.match(row.password_enc, /^[0-9a-f]{32}:[0-9a-f]{32}:/, 'iv:tag:ciphertext, per encryption.js');

      // The listing an API would return carries no secret at all.
      const listed = mdb.listForApp(APP_A).find(r => r.engine === engine);
      assert.ok(listed);
      assert.equal(listed.password_enc, undefined);
      assert.equal(listed.password, undefined);
    });

    await t.test('provisioning is idempotent — a redeploy gets the SAME database', async () => {
      const again = await mdb.provision({ appId: APP_A }, engine);
      assert.equal(again.database, a.database);
      assert.equal(again.username, a.username);
      assert.equal(again.password, a.password);
      const n = getDb().prepare('SELECT COUNT(*) c FROM managed_databases WHERE app_id = ? AND engine = ?')
        .get(APP_A, engine).c;
      assert.equal(n, 1);
    });

    // ---- CONTROL. Without this, every denial below could be a broken client.
    await t.test('CONTROL: each app can use its own database', async () => {
      const mk = await asUser(engine, { ...b, sql: 'CREATE TABLE secrets (v text)' });
      assert.ok(mk.ok, `app B must be able to create a table in its own database: ${mk.out}`);
      const ins = await asUser(engine, { ...b, sql: "INSERT INTO secrets VALUES ('B-SECRET')" });
      assert.ok(ins.ok, ins.out);
      const sel = await asUser(engine, { ...b, sql: 'SELECT v FROM secrets' });
      assert.ok(sel.ok && sel.out.includes('B-SECRET'), `control read failed: ${sel.out}`);

      const own = await asUser(engine, { ...a, sql: 'SELECT 1' });
      assert.ok(own.ok, `app A must be able to use its own database: ${own.out}`);
    });

    // ---- THE ATTACKS. Every one of these must fail.
    await t.test("ATTACK: app A cannot reach app B's database", async () => {
      const r = await asUser(engine, { ...a, database: b.database, sql: 'SELECT v FROM secrets' });
      assert.ok(!r.ok, `app A reached app B's database — ISOLATION BROKEN: ${r.out}`);
      assert.ok(!r.out.includes('B-SECRET'), 'app B\'s data must not appear in the error output either');

      // The failure has to be a CONNECTION refusal, not "connected fine, then
      // hit a table permission". An earlier draft only asserted !r.ok, and
      // deliberately deleting `REVOKE ALL ON DATABASE .. FROM PUBLIC` left that
      // assertion GREEN: app A opened a session inside app B's database and was
      // merely stopped at the schema. That is one revoked grant away from a
      // data leak, and it is exactly the state this feature exists to prevent —
      // so the test pins the boundary at the database door.
      const refusedAtTheDoor = engine === 'postgres'
        ? /permission denied for database/
        : /Access denied for user/i;
      assert.match(r.out, refusedAtTheDoor,
        `app A must be refused at CONNECT, not later: ${r.out}`);
    });

    await t.test("ATTACK: app A cannot read app B's table by qualified name", async () => {
      // Postgres cannot cross a database boundary in one query at all; MariaDB
      // can, which is exactly why this probe exists for both.
      const r = await asUser(engine, { ...a, sql: `SELECT v FROM ${b.database}.secrets` });
      assert.ok(!r.ok, `cross-database read succeeded — ISOLATION BROKEN: ${r.out}`);
      assert.ok(!r.out.includes('B-SECRET'));
    });

    await t.test('ATTACK: app A cannot create a database', async () => {
      const r = await asUser(engine, { ...a, sql: 'CREATE DATABASE crane_escape' });
      assert.ok(!r.ok, `app A created a database — it must not be able to: ${r.out}`);
    });

    await t.test('ATTACK: app A cannot create a login of its own', async () => {
      const sql = engine === 'postgres'
        ? "CREATE ROLE crane_escape LOGIN PASSWORD 'x'"
        : "CREATE USER 'crane_escape'@'%' IDENTIFIED BY 'x'";
      const r = await asUser(engine, { ...a, sql });
      assert.ok(!r.ok, `app A created a login — privilege escalation: ${r.out}`);
    });

    await t.test('ATTACK: app A cannot read the credential catalog', async () => {
      const sql = engine === 'postgres' ? 'SELECT * FROM pg_shadow' : 'SELECT * FROM mysql.global_priv';
      const r = await asUser(engine, { ...a, sql });
      assert.ok(!r.ok, `app A read stored credentials: ${r.out}`);
    });

    if (engine === 'postgres') {
      await t.test('ATTACK: app A cannot connect to the maintenance databases', async () => {
        for (const target of ['postgres', 'template1']) {
          const r = await asUser(engine, { ...a, database: target, sql: 'SELECT 1' });
          assert.ok(!r.ok, `app A connected to '${target}' — a fresh role can do this unless CONNECT is revoked from PUBLIC: ${r.out}`);
          assert.match(r.out, /permission denied for database/);
        }
      });

      await t.test('ATTACK: app A cannot execute a server-side program', async () => {
        const r = await asUser(engine, { ...a, sql: "COPY (SELECT 1) TO PROGRAM 'id'" });
        assert.ok(!r.ok, `COPY TO PROGRAM succeeded — that is command execution on the database host: ${r.out}`);
      });

      await t.test('KNOWN LIMIT: Postgres leaks database and role NAMES, and nothing else', async () => {
        // Documented in managedDb.js rather than glossed over. Asserted here so
        // the boundary cannot quietly widen from names to data: if a future
        // change made this return B's rows, the ATTACK tests above go red.
        const r = await asUser(engine, { ...a, sql: 'SELECT datname FROM pg_database ORDER BY 1' });
        assert.ok(r.ok);
        assert.ok(r.out.includes(b.database), 'this is the accepted leak; if it stops being true, relax the doc, not the grants');
      });
    } else {
      await t.test("MariaDB does not even list app B's database", async () => {
        const r = await asUserNoDb(engine, { ...a, sql: 'SHOW DATABASES' });
        assert.ok(r.ok, r.out);
        assert.ok(r.out.includes(a.database), `app A should see its own: ${r.out}`);
        assert.ok(!r.out.includes(b.database), `app A must not see app B's database name: ${r.out}`);
      });

      await t.test('app A holds no global privileges and no GRANT OPTION', async () => {
        const r = await asUser(engine, { ...a, sql: 'SHOW GRANTS' });
        assert.ok(r.ok, r.out);
        assert.ok(!/WITH GRANT OPTION/i.test(r.out), `GRANT OPTION lets the role re-grant itself: ${r.out}`);
        // The only *.* line MariaDB writes for a user with no global rights.
        const globals = r.out.split('\n').filter(l => /ON \*\.\*/i.test(l));
        for (const g of globals) {
          assert.match(g, /GRANT USAGE ON \*\.\*/i, `unexpected global privilege: ${g}`);
        }
      });
    }

    // ---- Deprovisioning
    await t.test('deprovision drops the database and the login, and leaves app B alone', async () => {
      assert.equal(await mdb.deprovision({ appId: APP_A }, engine), true);
      assert.equal(mdb.credentialsFor({ appId: APP_A }, engine), null);

      const gone = await asUser(engine, { ...a, sql: 'SELECT 1' });
      assert.ok(!gone.ok, `app A's credentials still work after deprovision: ${gone.out}`);

      const survivor = await asUser(engine, { ...b, sql: 'SELECT v FROM secrets' });
      assert.ok(survivor.ok && survivor.out.includes('B-SECRET'),
        `deprovisioning app A damaged app B: ${survivor.out}`);

      // Idempotent.
      assert.equal(await mdb.deprovision({ appId: APP_A }, engine), false);
    });

    await t.test('deprovisionApp clears every engine an app holds', async () => {
      await mdb.provision({ appId: APP_A }, engine);
      const res = await mdb.deprovisionApp(APP_A);
      assert.ok(res.dropped >= 1);
      assert.equal(mdb.listForApp(APP_A).length, 0);
    });

    // Leave a clean slate for the next engine's run.
    await mdb.deprovisionApp(APP_B);
  });
}

test('an app container on appcrane-apps can actually reach its managed database',
  { skip: noDocker, timeout: 600000 }, async (t) => {
  // THE CLAIM THE WHOLE DESIGN RESTS ON. enable_icc=false means the app cannot
  // route to the database container over the docker network, so it goes out
  // through host.docker.internal — and a loopback-only publish is unreachable
  // that way on Linux. See the measurement table in managedDb.js.
  const { ensureAppNetwork } = await import('../server/services/docker.js');
  const network = await ensureAppNetwork();

  const conn = await mdb.provision({ appId: APP_B }, 'postgres');
  await t.test('psql from inside the isolated app network', async () => {
    const { stdout } = await execFileAsync('docker', [
      'run', '--rm',
      '--network', network,
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PGPASSWORD=${conn.password}`,
      'postgres:16-alpine',
      'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
      '-h', conn.host, '-p', String(conn.port), '-U', conn.username, '-d', conn.database,
      '-c', "SELECT 'REACHED'",
    ], { timeout: 120000 });
    assert.equal(stdout.trim(), 'REACHED');
  });

  await t.test("but that container still cannot reach another app's database", async () => {
    const other = await mdb.provision({ appId: APP_A }, 'postgres');
    const r = await execFileAsync('docker', [
      'run', '--rm',
      '--network', network,
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PGPASSWORD=${conn.password}`,
      'postgres:16-alpine',
      'psql', '-X', '-q', '-t', '-A',
      '-h', conn.host, '-p', String(conn.port), '-U', conn.username, '-d', other.database,
      '-c', 'SELECT 1',
    ], { timeout: 120000 }).then(
      () => ({ ok: true, out: '' }),
      e => ({ ok: false, out: (e.stderr?.toString() || e.message).trim() })
    );
    assert.ok(!r.ok, 'an app container reached a sibling app\'s database — ISOLATION BROKEN');
    assert.match(r.out, /permission denied for database/);
  });

  await mdb.deprovisionApp(APP_A);
  await mdb.deprovisionApp(APP_B);
});

test('the managed data directory lives under DATA_DIR so a restart keeps the data',
  { skip: noDocker, timeout: 600000 }, async () => {
  await mdb.ensureServer('postgres');
  assert.ok(existsSync(join(process.env.DATA_DIR, 'managed-db', 'postgres')));
  // The plaintext init credential must not outlive the docker run that needed it.
  assert.ok(!existsSync(join(process.env.DATA_DIR, 'managed-db', 'postgres', '.init-env')),
    'the superuser password file must be deleted after the container starts');
});
