import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import express from 'express';

// apps.catalog_slug (migration 086) and the deprovision-on-delete wiring.
//
// TWO RISKS, and only one of them is about a column.
//
// 1. THE LINK. 54 of the 64 entries in appCatalog.json name the env var names
//    their image reads for a database, and they do not agree with each other.
//    Without a stored link back to the entry, the deployer has nothing to look
//    up and BookStack keeps 503-ing. The column is the easy half; the parts
//    that can go wrong quietly are the rebuild (086 restates 36 columns by
//    hand — a column left out is not an error, the data is just gone) and the
//    validation (this is a client-supplied lookup key that selects which
//    variable names a live database credential is injected under).
//
// 2. THE ORPHAN. This is the one that leaks. Migration 085's foreign key
//    cascades the managed_databases ROW away when an app is deleted, and that
//    is all SQLite can do — it cannot drop a database inside Postgres. So a
//    delete that does not call deprovisionApp() first leaves the database AND
//    its login role standing, holding the deleted app's data, reachable by
//    anyone who still has the credentials, with nothing left in AppCrane
//    pointing at either. The cascade makes that leak INVISIBLE.
//
//    Asserting that the SQLite row vanished proves nothing about it — the
//    foreign key does that for free, in exactly the world where the leak
//    exists. So the engine tests below ask the ENGINE, and each "it is gone"
//    assertion is paired with a CONTROL taken before the delete showing the
//    same probe reporting the database and the role present. A probe that
//    always answers "absent" would pass an unpaired test.

const PREFIX = 'appcrane-cslugtest';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-cslug-'));
process.env.ENCRYPTION_KEY = 'c'.repeat(64);
process.env.CRANE_DOMAIN = 'crane.test.local';
process.env.LOG_LEVEL = 'error';
// Distinct container names and ports from every other suite: `node --test` runs
// files in parallel, and adopting another run's server would let this file's
// teardown delete databases it does not own.
process.env.MANAGED_DB_CONTAINER_PREFIX = PREFIX;
process.env.MANAGED_DB_POSTGRES_PORT = '45597';
process.env.MANAGED_DB_MARIADB_PORT = '43397';

const execFileAsync = promisify(execFile);

let dockerOk = false;
try {
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000, stdio: 'pipe' });
  dockerOk = true;
} catch (_) { /* left false */ }
const noDocker = dockerOk ? false : 'no reachable Docker daemon on this host';

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const mdb = await import('../server/services/managedDb.js');
const catalog = JSON.parse(
  readFileSync(new URL('../server/services/appCatalog.json', import.meta.url), 'utf8'),
);

function mkUser(name, role) {
  const key = generateApiKey('dhk_user');
  const id = db.prepare(
    "INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES (?,?,?,?,1,'human')",
  ).run(name, `${name}@t.test`, role, hashApiKey(key)).lastInsertRowid;
  return { id, key, role };
}
const admin = mkUser('cslugadmin', 'platform_admin');

const appsRoutes = (await import('../server/routes/apps.js')).default;
const { errorHandler } = await import('../server/utils/errors.js');

const api = express();
api.use(express.json());
api.use('/api/apps', appsRoutes);
api.use(errorHandler);

const server = await new Promise((resolve) => {
  const s = api.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  if (dockerOk) {
    await mdb.stopServer('postgres').catch(() => {});
    await mdb.stopServer('mariadb').catch(() => {});
  }
  const { stopHealthChecker } = await import('../server/services/healthChecker.js');
  stopHealthChecker();
  server.closeAllConnections?.();
  server.unref();
  server.close();
  try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

async function req(as, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': as.key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const columns = () => db.prepare('PRAGMA table_info(apps)').all();
const rowFor = (slug) => db.prepare('SELECT id, catalog_slug FROM apps WHERE slug = ?').get(slug);

let n = 0;
const nextSlug = (label) => `cs-${label}-${++n}`;

// ---------------------------------------------------------------------------
// Migration 086 — the rebuild
// ---------------------------------------------------------------------------

test('086 ran and apps.catalog_slug is a nullable TEXT column with no default', () => {
  const applied = db.prepare("SELECT 1 FROM _migrations WHERE name = '086-app-catalog-slug.sql'").get();
  assert.ok(applied, '086 should be recorded in _migrations');

  const col = columns().find((c) => c.name === 'catalog_slug');
  assert.ok(col, 'apps.catalog_slug is missing');
  assert.equal(col.type, 'TEXT');
  // NULL is load-bearing, not laziness: it is how a row says "this app did not
  // come from the catalogue". A '' default would be a slug-shaped value that
  // resolves to nothing, and every reader would have to special-case it.
  assert.equal(col.notnull, 0, 'an app not installed from the catalogue has no catalogue entry');
  assert.equal(col.dflt_value, null);

  db.prepare("INSERT INTO apps (name, slug, slot) VALUES ('Bare', 'cs-bare-row', 8801)").run();
  assert.equal(rowFor('cs-bare-row').catalog_slug, null);
});

test('the rebuild kept every column, and 086 is now the migration that describes apps', () => {
  // Read the expected set out of 086 itself rather than hardcoding it, so this
  // fails when the migration's CREATE TABLE and the live table disagree — the
  // specific way a rebuild loses a column without erroring.
  const sql = readFileSync(new URL('../server/migrations/086-app-catalog-slug.sql', import.meta.url), 'utf8');
  const created = [...sql.matchAll(/^ {2}([a-z_]+) +(?:INTEGER|TEXT)/gm)].map((m) => m[1]);
  const live = columns().map((c) => c.name);

  assert.ok(created.length >= 36, `parsed only ${created.length} columns out of 086`);
  for (const col of created) {
    assert.ok(live.includes(col), `column '${col}' is created by 086 but missing from the live table`);
  }
  assert.equal(live.length, created.length,
    'the live table and 086 disagree on the column count — one of them is out of date, and if it ' +
    'is the migration then the next rebuild drops whatever it does not know about');

  // 086 must also be the NEWEST rebuild, or the invariant the guard rests on
  // ("the highest-numbered CREATE TABLE apps_new describes the live schema")
  // now points at a file that predates catalog_slug.
  const dir = new URL('../server/migrations/', import.meta.url);
  const rebuilds = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && readFileSync(new URL(f, dir), 'utf8').includes('CREATE TABLE apps_new'))
    .sort();
  assert.equal(rebuilds[rebuilds.length - 1], '086-app-catalog-slug.sql');
});

test('086 preserves every column 083 restated — nothing was dropped in passing', () => {
  const prev = readFileSync(new URL('../server/migrations/083-source-type-image.sql', import.meta.url), 'utf8');
  const before = [...prev.matchAll(/^ {2}([a-z_]+) +(?:INTEGER|TEXT)/gm)].map((m) => m[1]);
  const live = columns().map((c) => c.name);
  assert.ok(before.length >= 35, `parsed only ${before.length} columns out of 083`);
  for (const col of before) {
    assert.ok(live.includes(col), `column '${col}' survived 083 but was dropped by 086`);
  }
});

test('the CHECK and the port indexes survived the drop', () => {
  assert.throws(
    () => db.prepare("INSERT INTO apps (name, slug, slot, source_type) VALUES ('B','cs-bad-st',8802,'bogus')").run(),
    /CHECK/,
    'a rebuild that drops the source_type constraint looks identical to one that keeps it, until ' +
    'an arbitrary string reaches the deployer branch and matches nothing',
  );
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='apps' AND sql IS NOT NULL",
  ).all().map((r) => r.name);
  for (const want of ['idx_apps_service_token', 'idx_apps_public_port', 'idx_apps_sandbox_public_port']) {
    assert.ok(idx.includes(want), `DROP TABLE takes the indexes with it; ${want} did not come back`);
  }
});

test("085's foreign key still points at apps and still cascades after the rebuild", () => {
  // The rebuild DROPs apps and renames a new table into its place. If that left
  // managed_databases referencing a table that no longer exists, the row would
  // outlive its app — and every "the row is gone" assertion elsewhere would be
  // asserting something the schema no longer does.
  const fks = db.prepare('PRAGMA foreign_key_list(managed_databases)').all();
  const appFk = fks.find((f) => f.from === 'app_id');
  assert.ok(appFk, 'managed_databases lost its app_id foreign key in the rebuild');
  assert.equal(appFk.table, 'apps');
  assert.equal(appFk.on_delete, 'CASCADE');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const appId = Number(db.prepare(
    "INSERT INTO apps (name, slug, slot) VALUES ('FK', 'cs-fk-row', 8803)",
  ).run().lastInsertRowid);
  db.prepare(
    'INSERT INTO managed_databases (app_id, engine, db_name, db_user, password_enc) VALUES (?,?,?,?,?)',
  ).run(appId, 'postgres', 'crane_fk_probe', 'crane_fk_probe_u', 'x');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_databases WHERE app_id = ?').get(appId).n, 1);
  db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_databases WHERE app_id = ?').get(appId).n, 0,
    'the cascade is what makes an undropped engine-side database invisible; it must still be armed');
});

// ---------------------------------------------------------------------------
// POST /api/apps — accepting the link
// ---------------------------------------------------------------------------

test('POST stores catalog_slug and reports it back', async () => {
  const slug = nextSlug('ok');
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'BookStack', slug, source_type: 'image', image_ref: 'lscr.io/linuxserver/bookstack:24.05',
    catalog_slug: 'bookstack',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Reported, not merely stored. auth_mode spent three versions write-only and
  // that blind spot is what made "my app gets no identity headers" a recurring
  // triage; a field the deployer branches on cannot be invisible to its owner.
  assert.equal(r.body.app.catalog_slug, 'bookstack');
  assert.equal(rowFor(slug).catalog_slug, 'bookstack');

  const got = await req(admin, 'GET', `/api/apps/${slug}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.app.catalog_slug, 'bookstack');
});

test('an app that did not come from the catalogue stores NULL, not an empty string', async () => {
  for (const [label, value] of [['absent', undefined], ['null', null], ['empty', '']]) {
    const slug = nextSlug(label);
    const body = { name: 'Plain', slug, github_url: 'https://github.com/o/r' };
    if (value !== undefined) body.catalog_slug = value;
    const r = await req(admin, 'POST', '/api/apps', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rowFor(slug).catalog_slug, null, `catalog_slug=${label} should store NULL`);
    assert.equal(r.body.app.catalog_slug, null);
  }
});

test('a value that is not a catalogue slug shape is refused, and no app row is written', async () => {
  // This string is a lookup key into appCatalog.json that decides WHICH env var
  // names a live database credential is injected under. Junk stored here is not
  // cosmetic — it is an attacker-chosen key sitting in the row the deployer
  // reads. '__proto__' falls out of the shape (no '_'); 'constructor' does NOT
  // — it is the one Object.prototype member that is entirely lowercase, so it
  // survives the shape and is refused by name. A reader that indexes the
  // catalogue as a plain object gets a truthy function back for that key.
  const bad = [
    'BookStack', '__proto__', 'constructor', 'book stack', '../etc/passwd', 'a/b',
    'book.stack', '-leading-dash', 'book_stack', 'a'.repeat(65), '', ' ',
    42, true, ['bookstack'], { slug: 'bookstack' },
  ];
  for (const value of bad) {
    if (value === '') continue; // '' means "not from the catalogue" — covered above
    const slug = nextSlug('bad');
    const r = await req(admin, 'POST', '/api/apps', {
      name: 'Bad', slug, github_url: 'https://github.com/o/r', catalog_slug: value,
    });
    assert.equal(r.status, 400, `catalog_slug=${JSON.stringify(value)} should be a 400, got ${r.status}`);
    assert.equal(r.body.error.code, 'VALIDATION');
    assert.equal(rowFor(slug), undefined,
      `the request was refused but app '${slug}' was created anyway`);
  }
});

test('every slug the manifest actually uses is accepted', async () => {
  // The shape is not invented here — it is read off appCatalog.json. A regex
  // tightened past what the manifest contains would refuse a real install, and
  // would do it only for the entries nobody tested by hand.
  const slugs = catalog.map((e) => e.slug);
  assert.ok(slugs.length >= 60, `expected the full catalogue, parsed ${slugs.length} entries`);

  // Longest, shortest, one with a dash, and one that starts with a digit if the
  // manifest has one — the four ways the regex's edges get hit.
  const byLen = [...slugs].sort((a, b) => a.length - b.length);
  const picks = new Set([
    byLen[0], byLen[byLen.length - 1],
    slugs.find((s) => s.includes('-')),
    slugs.find((s) => /^[0-9]/.test(s)),
  ].filter(Boolean));

  for (const cs of picks) {
    const slug = nextSlug('cat');
    const r = await req(admin, 'POST', '/api/apps', {
      name: cs, slug, github_url: 'https://github.com/o/r', catalog_slug: cs,
    });
    assert.equal(r.status, 201, `catalogue slug '${cs}' was refused: ${JSON.stringify(r.body)}`);
    assert.equal(rowFor(slug).catalog_slug, cs);
  }

  // And the boundary itself, so the 64-char bound is a measured limit rather
  // than a number in a comment.
  const okLong = nextSlug('len64');
  assert.equal((await req(admin, 'POST', '/api/apps', {
    name: 'L', slug: okLong, github_url: 'https://github.com/o/r', catalog_slug: 'a'.repeat(64),
  })).status, 201);
});

test('PUT cannot change the link once it is set', async () => {
  // The whole reason the app row carries a slug instead of being matched back to
  // the catalogue by github_url or image_ref is that those are editable, and
  // repointing one would repoint which entry's variable names a credential is
  // injected under. A settable catalog_slug would hand that lever straight back.
  const slug = nextSlug('immutable');
  await req(admin, 'POST', '/api/apps', {
    name: 'Fixed', slug, github_url: 'https://github.com/o/r', catalog_slug: 'bookstack',
  });
  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { catalog_slug: 'nextcloud', description: 'edited' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body?.error?.code, 'CATALOG_SLUG_IMMUTABLE');
  assert.equal(rowFor(slug).catalog_slug, 'bookstack',
    'PUT repointed the catalogue link — that is the editable-field hole the design rejected');
});

test('PUT CAN fill the link when it is still empty, so an older app is not stranded', async () => {
  // v2.65.1. Write-once was implemented as write-never, which stranded every
  // catalogue app created before the column existed: NULL slug means the deployer
  // cannot resolve the entry's env var names, so it injects nothing and the app
  // 503s against a database nobody told it about. There was no way out except
  // deleting and re-creating the app.
  //
  // Filling a NULL is a migration; changing a value is a repoint. Only the second
  // one is the hole the design rejected.
  const slug = nextSlug('adopt');
  await req(admin, 'POST', '/api/apps', { name: 'Older', slug, github_url: 'https://github.com/o/r' });
  assert.equal(rowFor(slug).catalog_slug, null, 'precondition: the app starts with no link');

  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { catalog_slug: 'bookstack' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rowFor(slug).catalog_slug, 'bookstack');

  // and it is immutable from then on — adoption must not become a back door
  const again = await req(admin, 'PUT', `/api/apps/${slug}`, { catalog_slug: 'nextcloud' });
  assert.equal(again.status, 409, 'a filled link must be immutable, even one filled by adoption');
  assert.equal(rowFor(slug).catalog_slug, 'bookstack');
});

test('adoption still validates the slug shape', async () => {
  const slug = nextSlug('adoptbad');
  await req(admin, 'POST', '/api/apps', { name: 'Older2', slug, github_url: 'https://github.com/o/r' });
  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { catalog_slug: 'BookStack' });
  assert.equal(r.status, 400, 'an invalid slug must be refused on adoption exactly as on create');
  assert.equal(rowFor(slug).catalog_slug, null);
});

// ---------------------------------------------------------------------------
// DELETE /api/apps/:slug — the orphan
// ---------------------------------------------------------------------------

/** Ask the ENGINE, as its superuser, whether a database and a role still exist. */
async function engineHas(engine, { database, username }) {
  const container = `${PREFIX}-${engine}`;
  const run = async (args) => (await execFileAsync('docker', args, { timeout: 60000 })).stdout.trim();
  if (engine === 'postgres') {
    const dbN = await run(['exec', '-u', 'postgres', container, 'psql', '-X', '-tA', '-U', 'postgres',
      '-d', 'postgres', '-c', `SELECT count(*) FROM pg_database WHERE datname = '${database}'`]);
    const roleN = await run(['exec', '-u', 'postgres', container, 'psql', '-X', '-tA', '-U', 'postgres',
      '-d', 'postgres', '-c', `SELECT count(*) FROM pg_roles WHERE rolname = '${username}'`]);
    return { database: dbN === '1', role: roleN === '1', raw: `${dbN}/${roleN}` };
  }
  const dbN = await run(['exec', container, 'mariadb', '--batch', '--skip-column-names', '-e',
    `SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${database}'`]);
  const userN = await run(['exec', container, 'mariadb', '--batch', '--skip-column-names', '-e',
    `SELECT count(*) FROM mysql.user WHERE user = '${username}'`]);
  return { database: dbN === '1', role: userN === '1', raw: `${dbN}/${userN}` };
}

for (const engine of ['postgres', 'mariadb']) {
  test(`[${engine}] deleting an app drops its database and its login role from the engine`,
    { skip: noDocker, timeout: 600000 }, async (t) => {
      const slug = nextSlug(`del-${engine}`);
      const created = await req(admin, 'POST', '/api/apps', {
        name: 'Doomed', slug, source_type: 'image', image_ref: 'lscr.io/linuxserver/bookstack:24.05',
        catalog_slug: 'bookstack',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const appId = created.body.app.id;

      const creds = await mdb.provision({ appId }, engine);
      const names = { database: creds.database, username: creds.username };

      // THE CONTROL. Without this, "the database is gone" is also what a probe
      // pointed at the wrong container, or a typo'd query, reports — and the
      // test would go green in exactly the world where the leak exists.
      const before = await engineHas(engine, names);
      assert.equal(before.database, true, `provision() did not create ${names.database} (counts ${before.raw})`);
      assert.equal(before.role, true, `provision() did not create the role ${names.username}`);

      await t.test('the delete reports what it dropped', async () => {
        const r = await req(admin, 'DELETE', `/api/apps/${slug}?confirm=true`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        // Counts only. A name or a credential in this payload would be a leak
        // of its own — the whole point of the drop is that nothing survives.
        assert.deepEqual(r.body.managed_databases, { requested: 1, dropped: 1 });
        assert.ok(!JSON.stringify(r.body).includes(creds.password),
          'the delete response echoed the database password');
      });

      await t.test('the database and the role are gone from the engine itself', async () => {
        const after = await engineHas(engine, names);
        assert.equal(after.database, false,
          `${names.database} survived the app that owned it — an orphan holding the deleted ` +
          "app's data, with nothing in AppCrane pointing at it");
        assert.equal(after.role, false,
          `${names.username} is still a live login on the shared ${engine} server`);
      });

      await t.test('and the AppCrane row is gone too', () => {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_databases WHERE app_id = ?').get(appId).n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM apps WHERE id = ?').get(appId).n, 0);
      });
    });
}

test('deleting an app with no managed database is unaffected', { skip: noDocker }, async () => {
  // deprovisionApp() runs on EVERY delete, including the overwhelming majority
  // of apps that never provisioned anything. If it touched the engine for those,
  // an app on a box whose database server is down would become undeletable.
  const slug = nextSlug('nodb');
  await req(admin, 'POST', '/api/apps', { name: 'Plain', slug, github_url: 'https://github.com/o/r' });
  const r = await req(admin, 'DELETE', `/api/apps/${slug}?confirm=true`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed_databases, { requested: 0, dropped: 0 });
  assert.equal(rowFor(slug), undefined);
});

test('a database whose engine cannot be reached does not make the app undeletable', async () => {
  // The failure mode this guards is the opposite of the leak: refusing to delete
  // an app because a database server is down. deprovisionApp() catches per row
  // and logs, so the row here points at an engine container that does not exist
  // and the delete must still succeed — reporting requested=1, dropped=0 so the
  // orphan is VISIBLE rather than silently assumed away.
  const slug = nextSlug('unreachable');
  const created = await req(admin, 'POST', '/api/apps', {
    name: 'Stranded', slug, github_url: 'https://github.com/o/r', catalog_slug: 'bookstack',
  });
  const appId = created.body.app.id;
  db.prepare(
    'INSERT INTO managed_databases (app_id, engine, db_name, db_user, password_enc) VALUES (?,?,?,?,?)',
  ).run(appId, 'nosuchengine', 'crane_stranded', 'crane_stranded_u', 'x');

  const r = await req(admin, 'DELETE', `/api/apps/${slug}?confirm=true`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.managed_databases, { requested: 1, dropped: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM apps WHERE id = ?').get(appId).n, 0);
});

// ---------------------------------------------------------------------------
// The delete that did not delete
//
// Reported from a live instance: deleting an app left its slug taken, so
// re-installing the same catalogue app answered 409 and pushed the user to
// bookstack-2, bookstack-3, bookstack-4. The delete handler clears related rows
// by hand, and that list had fallen behind the schema: app_skills and
// email_queue reference apps(id) with NO cascade and were absent from it, so a
// single row in either raised a foreign-key error, rolled the whole transaction
// back, and the app survived its own deletion.
// ---------------------------------------------------------------------------

test('no table can make an app undeletable', () => {
  // A structural check, not a scenario: the next table to reference apps
  // without an ON DELETE action will fail HERE, when it is added, rather than in
  // production as an app that survives its own deletion and keeps its slug.
  //
  // Three things make a reference safe, and an earlier version of this test only
  // knew about the first — which made it accuse two innocent tables:
  //   ON DELETE CASCADE     the row goes with the app
  //   ON DELETE SET NULL    the row stays, detached (email_queue keeps sent mail)
  //   cleared by the handler explicitly, before `DELETE FROM apps`
  // It must also look at references to apps(SLUG), not only apps(id):
  // app_skills cascades on slug and was wrongly reported as unprotected.
  const dir = new URL('../server/migrations/', import.meta.url);
  const refs = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
      const [, table, body] = m;
      if (table.endsWith('_new')) continue;
      const fk = body.match(/REFERENCES\s+apps\s*\(\s*(?:id|slug)\s*\)([^,\n]*)/i);
      if (!fk) continue;
      refs.set(table, /ON DELETE (CASCADE|SET NULL)/i.test(fk[1]));
    }
  }
  assert.ok(refs.size >= 20, `parsed only ${refs.size} tables referencing apps — the regex is stale`);

  const handler = readFileSync(new URL('../server/routes/apps.js', import.meta.url), 'utf8');
  const cleared = new Set([...handler.matchAll(/DELETE FROM ([a-z_]+) WHERE app_(?:id|slug)/g)].map((m) => m[1]));

  const blocking = [...refs].filter(([t, safe]) => !safe && !cleared.has(t)).map(([t]) => t);
  assert.deepEqual(blocking, [],
    'these tables reference apps with no ON DELETE action and are not cleared by the delete handler, '
    + `so a row in any of them makes an app undeletable: ${blocking.join(', ')}`);
});
