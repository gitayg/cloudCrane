import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Managed database credential injection at deploy time.
//
// v2.64.0 shipped the provisioning half: a database and a login role per app.
// Nothing put the credentials INTO a container, so deploying BookStack from the
// catalogue still 503'd. This file covers the other half.
//
// THE PART THAT IS EASY TO GET WRONG, and so is what most of these assert:
//
//   1. The variable NAMES are per-entry, not a convention. BookStack reads
//      DB_DATABASE, Baserow reads DATABASE_NAME, Tryton reads DB_HOSTNAME and no
//      database name at all. Injecting a standard set would satisfy zero of them.
//   2. The app's OWN env var must win. A user who set DB_HOST by hand is pointing
//      the app at a database they chose; overriding it repoints a live app at an
//      empty one and presents as data loss.
//   3. The URL form must percent-encode the password. A password containing '@'
//      or '/' silently produces a URL naming a different host, with no error.
//   4. No password may reach a log line.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-mdbinj-'));
process.env.ENCRYPTION_KEY = 'f'.repeat(64);
process.env.LOG_LEVEL = 'error';

const { initDb, getDb } = await import('../server/db.js');
initDb(process.env.DATA_DIR);

const { encrypt } = await import('../server/services/encryption.js');
const { buildManagedDbEnv, managedDbUrl, applyManagedDbEnv } =
  await import('../server/services/deployer.js');
const { findEntry } = await import('../server/services/catalogService.js');
const { DB_HOST_FOR_CONTAINERS } = await import('../server/services/managedDb.js');

const db = getDb();

/** Insert an apps row plus a provisioned managed_databases row, without docker. */
function seedApp({ slug, catalogSlug, engine, password, dbName, dbUser }) {
  const appId = db.prepare(
    "INSERT INTO apps (name,slug,slot,source_type) VALUES (?,?,?,'image')"
  ).run(slug, slug, db.prepare('SELECT COUNT(*)+10 c FROM apps').get().c).lastInsertRowid;
  if (engine) {
    db.prepare(`
      INSERT INTO managed_databases (app_id, tenant, engine, db_name, db_user, password_enc)
      VALUES (?, '', ?, ?, ?, ?)
    `).run(appId, engine, dbName, dbUser, encrypt(password));
  }
  // The app row as the deployer sees it: catalog_slug is what links it back to
  // the manifest entry whose variable names get used.
  return { id: Number(appId), slug, catalog_slug: catalogSlug };
}

const CREDS = {
  engine: 'mariadb',
  host: 'host.docker.internal',
  port: 43306,
  database: 'crane_a42',
  username: 'crane_a42_u',
  password: 'sQ8pw-xY_2Zk3mNbVc4Ld6Rt',
  url: 'mysql://crane_a42_u:sQ8pw-xY_2Zk3mNbVc4Ld6Rt@host.docker.internal:43306/crane_a42',
};

// ---------------------------------------------------------------------------
// 1. The names come from the entry, not from a convention
// ---------------------------------------------------------------------------

test('BookStack gets ITS OWN variable names, including DB_DATABASE not DB_NAME', () => {
  const needs = findEntry('bookstack').needs;
  const out = buildManagedDbEnv(needs, CREDS);
  assert.deepEqual(out, {
    DB_HOST: 'host.docker.internal',
    DB_PORT: '43306',
    DB_DATABASE: 'crane_a42',
    DB_USERNAME: 'crane_a42_u',
    DB_PASSWORD: 'sQ8pw-xY_2Zk3mNbVc4Ld6Rt',
  });
  // The spelling this test exists for: BookStack does NOT read DB_NAME or DB_USER.
  assert.equal(out.DB_NAME, undefined);
  assert.equal(out.DB_USER, undefined);
});

test('Akaunting and BookStack disagree, and each gets its own spelling', () => {
  const bs = buildManagedDbEnv(findEntry('bookstack').needs, CREDS);
  const ak = buildManagedDbEnv(findEntry('akaunting').needs, CREDS);
  assert.equal(bs.DB_DATABASE, 'crane_a42');
  assert.equal(ak.DB_NAME, 'crane_a42');       // Akaunting's manifest note calls this out
  assert.equal(ak.DB_DATABASE, undefined);
  assert.equal(bs.DB_NAME, undefined);
});

test('port is injected as a string — docker -e cannot carry a number', () => {
  const out = buildManagedDbEnv(findEntry('bookstack').needs, CREDS);
  assert.equal(typeof out.DB_PORT, 'string');
});

test('a null field is skipped, not injected empty (Tryton reads no database name)', () => {
  const needs = findEntry('tryton').needs;
  assert.equal(needs.env.name, null, 'manifest precondition: tryton declares name:null');
  const out = buildManagedDbEnv(needs, CREDS);
  assert.equal(Object.values(out).includes(''), false);
  assert.equal(out.DB_HOSTNAME, 'host.docker.internal');
  assert.ok('TRYTOND_DATABASE_URI' in out);
  // No key was invented for the null field.
  assert.deepEqual(
    Object.keys(out).sort(),
    ['DB_HOSTNAME', 'DB_PASSWORD', 'DB_PORT', 'DB_USER', 'TRYTOND_DATABASE_URI']
  );
});

test('an entry declaring BOTH discrete fields and a URL gets both (Metabase)', () => {
  const out = buildManagedDbEnv(findEntry('metabase').needs, CREDS);
  assert.equal(out.MB_DB_DBNAME, 'crane_a42');
  assert.equal(out.MB_DB_CONNECTION_URI, managedDbUrl(CREDS));
});

test('a URL-only entry gets only the URL (Outline)', () => {
  const needs = findEntry('outline').needs;
  assert.equal(needs.env, null, 'manifest precondition: outline declares no discrete fields');
  assert.deepEqual(Object.keys(buildManagedDbEnv(needs, CREDS)), ['DATABASE_URL']);
});

test('a credential field with no value is skipped rather than injected as "undefined"', () => {
  // Guards the other half of the skip: a missing VALUE, not a null var name.
  const out = buildManagedDbEnv(findEntry('bookstack').needs, { ...CREDS, port: null });
  assert.equal('DB_PORT' in out, false);
  assert.equal(Object.values(out).includes(undefined), false);
});

test('no credentials means no variables at all', () => {
  assert.deepEqual(buildManagedDbEnv(findEntry('bookstack').needs, null), {});
  assert.deepEqual(buildManagedDbEnv(null, CREDS), {});
});

// ---------------------------------------------------------------------------
// 2. The URL form
// ---------------------------------------------------------------------------

test('a password containing URL-reserved characters is percent-encoded', () => {
  const nasty = { ...CREDS, engine: 'postgres', password: 'p@ss:w/rd#1?x&y', url: 'postgresql://x' };
  const url = managedDbUrl(nasty);
  // The literal reserved characters must NOT survive into the authority: an '@'
  // there renames the host, a '/' ends the authority early.
  assert.equal(url, 'postgresql://crane_a42_u:p%40ss%3Aw%2Frd%231%3Fx%26y@host.docker.internal:43306/crane_a42');
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'host.docker.internal');
  assert.equal(parsed.port, '43306');
  assert.equal(parsed.pathname, '/crane_a42');
  assert.equal(decodeURIComponent(parsed.password), 'p@ss:w/rd#1?x&y');
});

test('an unencoded password would have produced an UNPARSEABLE url — the bug this guards', () => {
  // Measured, not assumed: WHATWG URL splits the authority on the LAST '@', so a
  // password containing '@' happens to survive. '/' and '?' do not — they end
  // the authority, and the result does not parse as a URL at all.
  assert.throws(
    () => new URL('postgresql://crane_a42_u:pa/ss@host.docker.internal:43306/crane_a42'),
    /Invalid URL/
  );
  const encoded = new URL(managedDbUrl({ ...CREDS, engine: 'postgres', password: 'pa/ss', url: 'postgresql://x' }));
  assert.equal(encoded.hostname, 'host.docker.internal');
  assert.equal(encoded.pathname, '/crane_a42');
  assert.equal(decodeURIComponent(encoded.password), 'pa/ss');
});

test('the scheme follows the engine', () => {
  assert.ok(managedDbUrl(CREDS).startsWith('mysql://'));
  assert.ok(managedDbUrl({ ...CREDS, engine: 'postgres', url: 'postgresql://x' }).startsWith('postgresql://'));
  // Falls back to the engine when the credential object carries no url.
  assert.ok(managedDbUrl({ ...CREDS, url: undefined }).startsWith('mysql://'));
  assert.ok(managedDbUrl({ ...CREDS, engine: 'postgres', url: undefined }).startsWith('postgresql://'));
});

// ---------------------------------------------------------------------------
// 3. End to end against a real provisioned row, and precedence
// ---------------------------------------------------------------------------

test('a catalogue app with a provisioned database gets its credentials injected', () => {
  const app = seedApp({
    slug: 'bs-plain', catalogSlug: 'bookstack', engine: 'mariadb',
    password: 'AaBbCcDdEeFfGgHhIiJjKkLl', dbName: 'crane_a901', dbUser: 'crane_a901_u',
  });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.equal(r.engine, 'mariadb');
  assert.equal(envMap.DB_HOST, DB_HOST_FOR_CONTAINERS);
  assert.equal(envMap.DB_DATABASE, 'crane_a901');
  assert.equal(envMap.DB_USERNAME, 'crane_a901_u');
  assert.equal(envMap.DB_PASSWORD, 'AaBbCcDdEeFfGgHhIiJjKkLl');
  assert.deepEqual(r.injected.sort(), ['DB_DATABASE', 'DB_HOST', 'DB_PASSWORD', 'DB_PORT', 'DB_USERNAME']);
  assert.deepEqual(r.deferred, []);
});

test("the app's OWN env var wins — an injected credential never overrides it", () => {
  const app = seedApp({
    slug: 'bs-own', catalogSlug: 'bookstack', engine: 'mariadb',
    password: 'MmNnOoPpQqRrSsTtUuVvWwXx', dbName: 'crane_a902', dbUser: 'crane_a902_u',
  });
  // The user pointed this app at their existing database by hand.
  const envMap = { DB_HOST: 'db.internal.example', DB_DATABASE: 'their_real_data' };
  const r = applyManagedDbEnv(app, envMap, []);
  assert.equal(envMap.DB_HOST, 'db.internal.example', 'user value was overwritten — this moves their data');
  assert.equal(envMap.DB_DATABASE, 'their_real_data');
  assert.deepEqual(r.deferred.sort(), ['DB_DATABASE', 'DB_HOST']);
  // The vars they did NOT set still get filled in.
  assert.deepEqual(r.injected.sort(), ['DB_PASSWORD', 'DB_PORT', 'DB_USERNAME']);
});

test('a var the user set that failed to DECRYPT is still theirs, not a gap to fill', () => {
  const app = seedApp({
    slug: 'bs-undecryptable', catalogSlug: 'bookstack', engine: 'mariadb',
    password: 'YyZz00112233445566778899', dbName: 'crane_a903', dbUser: 'crane_a903_u',
  });
  const envMap = {};                          // decrypt failed, so it is absent
  const r = applyManagedDbEnv(app, envMap, ['DB_HOST']);
  assert.equal(envMap.DB_HOST, undefined, 'substituted a managed database for the one the user configured');
  assert.deepEqual(r.deferred, ['DB_HOST']);
});

test('an app with no catalog_slug is left completely alone', () => {
  const app = seedApp({
    slug: 'no-slug', catalogSlug: null, engine: 'mariadb',
    password: 'Q1W2E3R4T5Y6U7I8O9P0aSdF', dbName: 'crane_a904', dbUser: 'crane_a904_u',
  });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.deepEqual(envMap, {});
  assert.deepEqual(r.injected, []);
  assert.match(r.reason, /not installed from the catalogue/);
});

test('NO PROVISIONING HERE: a catalogue app without a database injects nothing', () => {
  const app = seedApp({ slug: 'bs-nodb', catalogSlug: 'bookstack', engine: null });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.deepEqual(envMap, {});
  assert.deepEqual(r.injected, []);
  assert.match(r.reason, /no provisioned mariadb database/);
  // And nothing was created as a side effect.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM managed_databases WHERE app_id = ?').get(app.id).c, 0);
});

test('an entry naming an unsupported engine (mongo) injects nothing', () => {
  const app = seedApp({ slug: 'rc', catalogSlug: 'rocketchat', engine: null });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.equal(r.engine, 'mongo');
  assert.deepEqual(envMap, {});
  assert.deepEqual(r.injected, []);
});

test('a catalogue entry that needs no database injects nothing', () => {
  const noNeeds = JSON.parse(readFileSync('server/services/appCatalog.json', 'utf8')).find(e => !e.needs);
  const app = seedApp({ slug: 'nodb-entry', catalogSlug: noNeeds.slug, engine: null });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.deepEqual(envMap, {});
  assert.match(r.reason, /needs no database/);
});

test('an unknown catalog_slug injects nothing rather than guessing', () => {
  const app = seedApp({ slug: 'ghost', catalogSlug: 'not-a-real-entry', engine: 'mariadb',
    password: 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2', dbName: 'crane_a905', dbUser: 'crane_a905_u' });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.deepEqual(envMap, {});
  assert.match(r.reason, /no catalogue entry/);
});

// ---------------------------------------------------------------------------
// 4. Passwords must not reach a log line
// ---------------------------------------------------------------------------

test('the result handed to the logger carries key NAMES only, never a value', () => {
  const secret = 'LogMeAndYouLoseTheDatabase';
  const app = seedApp({
    slug: 'bs-secret', catalogSlug: 'bookstack', engine: 'mariadb',
    password: secret, dbName: 'crane_a906', dbUser: 'crane_a906_u',
  });
  const envMap = {};
  const r = applyManagedDbEnv(app, envMap, []);
  assert.equal(envMap.DB_PASSWORD, secret, 'precondition: the password really was injected');
  // Everything the two call sites log comes out of this object.
  assert.equal(JSON.stringify(r).includes(secret), false);
});

test('both call sites log only key names, and both defer to the app\'s own vars', () => {
  for (const file of ['server/services/deployer.js', 'server/routes/deploy.js']) {
    const src = readFileSync(file, 'utf8');
    assert.ok(
      /applyManagedDbEnv\(app, runtimeEnvVars, decryptFailures\)/.test(src),
      `${file} must inject managed db credentials the same way, with the same claimed-key set`
    );
    // A log line built from .injected/.deferred is names; one built from the env
    // map itself would be values.
    assert.equal(/mdbEnv\.(injected|deferred)\.join/.test(src), true, `${file} logs names`);
    assert.equal(/runtimeEnvVars\[[^\]]*\]\}/.test(src), false, `${file} must not interpolate an env VALUE into a log`);
  }
});
