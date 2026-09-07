import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 'upload' is a source type again, and the rebuild that allowed it kept the
// table intact (v2.53.0, migrations 080 + 081).
//
// Two separate risks here, and the second is the dangerous one.
//
// 1. The CHECK. 052 narrowed apps.source_type to github/managed/managed_legacy
//    because an uploaded release had no provenance. 080 gives it one — a
//    SHA-256 AppCrane computes over the received bytes — so 081 widens the
//    CHECK again. It must widen by exactly one value.
//
// 2. The rebuild. SQLite cannot alter a CHECK, so 081 recreates apps and
//    restates all 32 columns by hand. A column left out of that list is not an
//    error: the rebuild succeeds and the data is gone. apps has gained eleven
//    columns since the last rebuild in 052, which is how large the gap between
//    "pattern copied from an old migration" and "current schema" can get.
//    The same applies to the three explicit indexes, two of which are the
//    partial UNIQUEs that stop two apps claiming one host port (076).

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-srctype-'));
process.env.ENCRYPTION_KEY = 'd'.repeat(64);
process.env.LOG_LEVEL = 'error';

const { initDb, getDb } = await import('../server/db.js');
initDb();
const db = getDb();

const columns = () => db.prepare('PRAGMA table_info(apps)').all();

test("source_type accepts 'upload'", () => {
  db.prepare("INSERT INTO apps (name, slug, slot, source_type) VALUES ('U', 'up-1', 800, 'upload')").run();
  const row = db.prepare("SELECT source_type FROM apps WHERE slug = 'up-1'").get();
  assert.equal(row.source_type, 'upload');
});

test('the CHECK still rejects everything else — widening it must not remove it', () => {
  assert.throws(
    () => db.prepare("INSERT INTO apps (name, slug, slot, source_type) VALUES ('B', 'bad-1', 801, 'bogus')").run(),
    /CHECK/,
    'a rebuild that drops the constraint looks identical to one that widens it, until an ' +
    'arbitrary string reaches the deployer branch and matches nothing',
  );
});

test("'managed_legacy' survives — it marks pre-052 rows the deployer treats differently", () => {
  db.prepare("INSERT INTO apps (name, slug, slot, source_type) VALUES ('L', 'leg-1', 802, 'managed_legacy')").run();
  assert.equal(db.prepare("SELECT source_type FROM apps WHERE slug = 'leg-1'").get().source_type, 'managed_legacy');
});

test('the rebuild kept every column the migration is supposed to preserve', () => {
  // Resolve the newest rebuild instead of naming one. Every rebuild restates
  // the whole column list, so the highest-numbered migration containing
  // `CREATE TABLE apps_new` is the one that defines the live schema. Naming a
  // file here breaks the moment the next rebuild lands: 081 was named, 083 added
  // three columns, and the assertion below then reported a healthy schema as
  // broken — a false alarm on the one test that is supposed to catch real data
  // loss is worse than no test, because the next person edits the number out.
  const dir = new URL('../server/migrations/', import.meta.url);
  const rebuilds = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && readFileSync(new URL(f, dir), 'utf8').includes('CREATE TABLE apps_new'))
    .sort();
  const newest = rebuilds[rebuilds.length - 1];
  assert.ok(newest, 'no migration rebuilds apps — the parse below would then assert nothing at all');

  // Read the expected set from that migration itself rather than hardcoding it
  // here, so this fails when the migration's INSERT column list and its CREATE
  // TABLE disagree — the specific way a rebuild loses data silently.
  const sql = readFileSync(new URL(newest, dir), 'utf8');
  const created = [...sql.matchAll(/^\s{2}([a-z_]+)\s+(?:INTEGER|TEXT)/gm)].map((m) => m[1]);
  const live = columns().map((c) => c.name);

  // A floor, not the count: rebuilds only ever add columns, so anything under
  // the 32 that 081 restated means the regex stopped matching, not that the
  // schema shrank.
  assert.ok(created.length >= 32, `parsed only ${created.length} columns out of ${newest}`);
  for (const col of created) {
    assert.ok(live.includes(col), `column '${col}' is created by ${newest} but missing from the live table`);
  }
  assert.equal(live.length, created.length,
    `the live table and ${newest} disagree on the column count — one of them is out of date, ` +
    'and if it is the migration then a future rebuild drops whatever it does not know about');
});

test('the partial unique port indexes survived the drop', () => {
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'apps' AND sql IS NOT NULL"
  ).all().map((r) => r.name);

  assert.ok(idx.includes('idx_apps_public_port'),
    'DROP TABLE takes the indexes with it; losing this one silently undoes per-env port uniqueness (076)');
  assert.ok(idx.includes('idx_apps_sandbox_public_port'));
  assert.ok(idx.includes('idx_apps_service_token'));

  db.prepare("INSERT INTO apps (name, slug, slot, public_port) VALUES ('P','port-1',810,24999)").run();
  assert.throws(
    () => db.prepare("INSERT INTO apps (name, slug, slot, public_port) VALUES ('Q','port-2',811,24999)").run(),
    /UNIQUE/,
    'two apps must not be able to claim one host port',
  );
});

test('slug and slot uniqueness came back from the column definitions', () => {
  db.prepare("INSERT INTO apps (name, slug, slot) VALUES ('S','uniq-1',820)").run();
  assert.throws(() => db.prepare("INSERT INTO apps (name, slug, slot) VALUES ('S2','uniq-1',821)").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO apps (name, slug, slot) VALUES ('S3','uniq-2',820)").run(), /UNIQUE/);
});

test('foreign keys into apps still resolve after the table was dropped and renamed', () => {
  const appId = db.prepare("SELECT id FROM apps WHERE slug = 'up-1'").get().id;
  db.prepare("INSERT INTO deployments (app_id, env, status) VALUES (?, 'sandbox', 'live')").run(appId);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0,
    'the rebuild ran with foreign_keys = OFF; a child row pointing at nothing would not have been ' +
    'caught at insert time');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

// ---------------------------------------------------------------------------
// Tree digest
// ---------------------------------------------------------------------------

test('the release-tree digest ignores node_modules but not source', async () => {
  const { digestTree } = await import('../server/services/artifactDigest.js');
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'app.js'), 'v1');
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'x');

  const before = digestTree(dir);
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'y');
  assert.equal(digestTree(dir).sha256, before.sha256,
    'dependencies are reinstalled rather than shipped; hashing them makes every deploy report drift');

  writeFileSync(join(dir, 'app.js'), 'v2');
  assert.notEqual(digestTree(dir).sha256, before.sha256, 'a source edit must move the digest');
});

// NOT COVERED: the sort inside digestTree's walk.
//
// A test was written for it and deleted, because it could not fail. Removing
// the sort from the production code left it green: APFS returns directory
// entries in name order, so on this machine the sorted and unsorted walks are
// the same walk. It would bite on ext4, whose htree returns hash order — which
// is to say, on the Linux hosts AppCrane actually deploys to, where a rollback
// would then report drift on a directory nothing had touched.
//
// The sort stays. It is asserted by nothing, and this comment is here so the
// next person does not read the absence of a test as an absence of a reason.
