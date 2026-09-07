import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

// Settings read authorization (v2.38.0).
//
// GET /api/settings/:key used to be guarded by a hand-maintained denylist of
// "sensitive" keys. The denylist drifted: `backup_s3_access_key_id` (an AWS
// access key ID in cleartext) and `backup_s3_secret_enc` (the encrypted S3
// backup secret) shipped without ever being added, so any authenticated
// caller — including a low-privilege `dhk_user_*` API key — could read them.
// The bulk GET /api/settings was ungated entirely.
//
// The replacement is an allowlist that fails closed (server/utils/settings-
// Visibility.js): a key nobody classified is platform-admin-only. These tests
// pin BOTH halves — the classifier's contract, and the wiring that enforces it
// — because a correct classifier behind an unwired route protects nothing.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SETTINGS_SRC = readFileSync(join(ROOT, 'server/routes/settings.js'), 'utf8');
const VISIBILITY_SRC = readFileSync(join(ROOT, 'server/utils/settingsVisibility.js'), 'utf8');
const GITHUB_SVC_SRC = readFileSync(join(ROOT, 'server/routes/githubService.js'), 'utf8');
const INDEX_SRC = readFileSync(join(ROOT, 'server/index.js'), 'utf8');

const DATA = mkdtempSync(join(tmpdir(), 'crane-settings-authz-'));
process.env.DATA_DIR = DATA;

const { initDb, getDb } = await import('../server/db.js');
const { hashApiKey } = await import('../server/services/encryption.js');
const { settingVisibility, PUBLIC, AUTHED, ADMIN } = await import('../server/utils/settingsVisibility.js');
const { errorHandler } = await import('../server/utils/errors.js');
const settingsRouter = (await import('../server/routes/settings.js')).default;
const githubServiceRouter = (await import('../server/routes/githubService.js')).default;

initDb();

// Values a leak would actually expose. Asserting on the literal string (not
// just the status code) catches a handler that 403s but still echoes the value
// in the error body.
const LEAKED = {
  backup_s3_access_key_id: 'AKIAEXAMPLEACCESSKEY',
  backup_s3_secret_enc: 'deadbeef:cafebabe:0badc0de',
  saml_idp_sso_url: 'https://idp.internal.example/sso',
  auth_sso_only: 'true',
  branding: 'Use the house typeface.',
};

const KEY_USER = 'dhk_user_lowpriv';
const KEY_ADMIN = 'dhk_user_platformadmin';

{
  const db = getDb();
  const ins = db.prepare('INSERT INTO users (name, email, role, api_key_hash) VALUES (?, ?, ?, ?)');
  ins.run('Low Priv', 'low@example.test', 'user', hashApiKey(KEY_USER));
  ins.run('Platform Admin', 'admin@example.test', 'platform_admin', hashApiKey(KEY_ADMIN));
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(LEAKED)) put.run(k, v);
}

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);
app.use('/api/github-service', githubServiceRouter);
app.use(errorHandler);

const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
after(() => { server.closeAllConnections?.(); server.unref(); server.close(); });
const BASE = `http://127.0.0.1:${server.address().port}`;

/** GET as anonymous (no key), as the low-priv user, or as the platform admin. */
async function get(path, apiKey) {
  const r = await fetch(`${BASE}${path}`, { headers: apiKey ? { 'X-API-Key': apiKey } : {} });
  return { status: r.status, body: await r.text() };
}

/** PUT as anonymous, as the low-priv user, or as the platform admin. */
async function put(path, value, apiKey) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    body: JSON.stringify({ value }),
  });
  return { status: r.status, body: await r.text() };
}

// ── The classifier's key universe ──────────────────────────────────────────
//
// Discovered, never hardcoded. A hardcoded list is precisely the drift that
// caused the leak: the denylist was written once and every later feature that
// added a setting forgot it. If the universe is derived from the source, a new
// key joins it the moment it is written.

function walkJs(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJs(p, acc);
    else if (entry.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// snake_case, at least one underscore. The underscore requirement bounds the
// noise picked up from settings-touching files (see keysFromSource) without
// needing a per-file exception list.
const KEY_SHAPED = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function keysFromSource(src) {
  const found = new Set();

  // 1. Named inline in SQL — `key = 'security_contact'`,
  //    `key IN ('tls_cert_file','tls_key_file')`. These live inside an outer
  //    quoted string, so the literal scan below can't see them.
  for (const m of src.matchAll(/\bkey\s*=+\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/\bkey\s+IN\s*\(([^)]*)\)/gi)) {
    for (const q of m[1].matchAll(/'([a-z0-9_]+)'/g)) found.add(q[1]);
  }

  // 2. Passed as a bound parameter — `get(db, K.accessKey)`, `setting(db,
  //    'graph_tenant_id')`, `const STATE_KEY = 'credcheck_state'`. The key
  //    reaches the query through a const, an object map or a call argument, so
  //    there is no single syntactic form to match. Every key-shaped literal in
  //    a file that queries the settings table is taken as a candidate instead.
  //    Deliberately over-inclusive: for a fail-closed classifier a superset is
  //    the safe direction — an extra candidate defaults to ADMIN and asserts
  //    nothing false, a missed one would silently escape these checks.
  if (/(?:FROM|INTO|UPDATE)\s+settings\b/i.test(src)) {
    for (const m of src.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)) {
      const v = m[1] ?? m[2];
      if (KEY_SHAPED.test(v)) found.add(v);
    }
  }
  return found;
}

const SERVER_KEYS = new Set();
for (const f of walkJs(join(ROOT, 'server'))) {
  for (const k of keysFromSource(readFileSync(f, 'utf8'))) SERVER_KEYS.add(k);
}

// The SPA reaches keys the server never names in code — it just fetches
// /api/settings/<key>. `branding` is one, and it is the whole reason the AUTHED
// level exists, so the universe would be misleading without them. The lookahead
// keeps sub-resources out: `mail/config`, `role-permissions/catalog` and
// `backup/s3` are separate handlers, not keys.
const FRONTEND_KEYS = new Set();
(function walkTs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { walkTs(p); continue; }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/\/api\/settings\/([a-z0-9_]+)(?=['"`?])/g)) {
      FRONTEND_KEYS.add(m[1]);
    }
  }
})(join(ROOT, 'studio-web/src'));

const UNIVERSE = new Set([...SERVER_KEYS, ...FRONTEND_KEYS]);

// Parsed from the route rather than re-declared here, so the two can't drift.
const SENSITIVE_KEYS = new Set(
  [...(SETTINGS_SRC.match(/const SENSITIVE_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '')
    .matchAll(/'([^']+)'/g)].map(m => m[1])
);

test('the key scan finds a real universe, not an empty one', () => {
  // Guards the scanner itself: every assertion below is vacuous if this is
  // empty or tiny. The landmarks span all four discovery shapes — inline SQL,
  // a const map, a bare call argument, and a frontend-only fetch.
  assert.ok(UNIVERSE.size >= 30, `expected a substantial key universe, found ${UNIVERSE.size}`);
  for (const landmark of [
    'security_contact',            // inline SQL literal in server/index.js
    'tls_cert_file',               // inline SQL `key IN (...)`
    'backup_s3_secret_enc',        // const map in backupScheduler.js
    'graph_tenant_id',             // bare call argument in graphMailer.js
    'max_dev_containers',          // inline SQL in containerLimit.js
    'branding',                    // frontend-only: never named in server code
  ]) {
    assert.ok(UNIVERSE.has(landmark), `scanner missed ${landmark} — the discovery regexes have a blind spot`);
  }
});

test('every discovered key resolves to a defined visibility level', () => {
  const levels = new Set([PUBLIC, AUTHED, ADMIN]);
  for (const key of UNIVERSE) {
    assert.ok(levels.has(settingVisibility(key)),
      `${key} classified as ${String(settingVisibility(key))}, which is not one of the three levels`);
  }
});

test('only the reviewed keys are readable below platform admin', () => {
  // The review gate. Every other key in the universe — and every key a future
  // feature adds — is admin-only by default. Widening one means editing
  // PUBLIC_KEYS/AUTHED_KEYS *and* this list, which is the point: it can't
  // happen by accident the way a forgotten denylist entry did.
  //
  // REVIEWED, v2.61.0 — `catalog_enabled`: a single boolean saying whether this
  // instance shows the app catalogue. Layout.tsx renders the nav for EVERY
  // logged-in user and must read it to decide whether to draw the entry, so
  // admin-gating it would hide the catalogue from everyone except platform
  // admins. It carries no credential, names no host, and reveals only which
  // pages this instance offers — which the navigation itself reveals anyway.
  // The WRITE side stays platform-admin-only through PUT /api/settings/:key.
  const widened = [...UNIVERSE].filter(k => settingVisibility(k) !== ADMIN).sort();
  assert.deepEqual(widened, ['auth_sso_only', 'branding', 'catalog_enabled'],
    'a settings key became readable below platform admin — justify it or revert it');
});

// A new `*_secret`, `*_token`, `*_access_key` widened below admin fails the two
// drift detectors below even if nobody thought to update the exact-match lists.
const SENSITIVE_SHAPE = /secret|token|password|credential|_cert|cert_|access_key|api_key|private_key|_hash$|_enc$|_encrypted$/;

test('no key that looks like credential material is readable below platform admin', () => {
  const exposed = [...UNIVERSE]
    .filter(k => SENSITIVE_SHAPE.test(k) && settingVisibility(k) !== ADMIN)
    .sort();
  assert.deepEqual(exposed, [],
    `credential-shaped settings keys are readable below platform admin: ${exposed.join(', ')}`);
});

test('the allowlist sets themselves are exactly the reviewed keys', () => {
  // The two tests above filter UNIVERSE, so they can only judge keys the
  // scanner found. A key added to AUTHED_KEYS that the scanner happens to miss
  // — one reached only through a helper in a file that never names the settings
  // table — would slip past both. Read the sets straight out of the classifier
  // so widening is caught regardless of scanner coverage.
  const parseSet = (name) => new Set(
    [...(VISIBILITY_SRC.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? '')
      .matchAll(/'([^']+)'/g)].map(m => m[1])
  );
  const publicKeys = parseSet('PUBLIC_KEYS');
  const authedKeys = parseSet('AUTHED_KEYS');

  assert.deepEqual([...publicKeys].sort(), ['auth_sso_only'],
    'PUBLIC_KEYS is unauthenticated read surface — every addition needs its own justification');
  assert.deepEqual([...authedKeys].sort(), ['branding', 'catalog_enabled'],
    'AUTHED_KEYS is readable by any dhk_user_* API key — every addition needs its own justification');

  // The parse must agree with the live function, or it is asserting on nothing.
  for (const k of publicKeys) assert.equal(settingVisibility(k), PUBLIC);
  for (const k of authedKeys) assert.equal(settingVisibility(k), AUTHED);

  // Same drift detector as above, but applied to the sets rather than to the
  // scanned universe, so it holds for a key the scanner never sees.
  for (const k of [...publicKeys, ...authedKeys]) {
    assert.ok(!SENSITIVE_SHAPE.test(k), `${k} is credential-shaped and must not be readable below platform admin`);
  }
});

test('stored ciphertext and hashes are never returned, even to a platform admin', () => {
  // Belt-and-braces on top of the allowlist: SENSITIVE_KEYS is the never-return
  // set. `backup_s3_secret_enc` is the key that was missing from it.
  const atRestSecrets = [...UNIVERSE].filter(k => /(_enc|_encrypted|_hash)$/.test(k)).sort();
  assert.ok(atRestSecrets.length >= 5, `expected several at-rest secrets, found ${atRestSecrets.length}`);
  const missing = atRestSecrets.filter(k => !SENSITIVE_KEYS.has(k));
  assert.deepEqual(missing, [],
    `these store ciphertext/hashes but are not in SENSITIVE_KEYS: ${missing.join(', ')}`);
  assert.ok(SENSITIVE_KEYS.has('backup_s3_secret_enc'), 'the key whose omission caused the leak is back out of the set');
});

test('an unclassified key falls through to platform admin, not to open', () => {
  // The whole design rests on the default. Use a name that provably appears
  // nowhere, so this asserts the fallthrough rather than an existing entry.
  const invented = 'zzz_unclassified_probe_key';
  assert.ok(!UNIVERSE.has(invented), 'pick a name that is genuinely absent from the codebase');
  assert.equal(settingVisibility(invented), ADMIN);
  assert.equal(settingVisibility('some_feature_shipped_next_quarter'), ADMIN);
});

// ── Route wiring ───────────────────────────────────────────────────────────

test('the bulk GET /api/settings carries both requireAuth and requirePlatformAdmin', () => {
  // Parsed, not taken on trust from the comment above it: this route dumps
  // every non-excluded row, so an ungated one is a full config disclosure
  // regardless of how the per-key classifier behaves.
  const chain = SETTINGS_SRC.match(/router\.get\('\/',\s*(.*?)\(req/)?.[1];
  assert.ok(chain, "could not locate the bulk router.get('/') route");
  assert.match(chain, /\brequireAuth\b/, 'bulk settings dump is not authenticated');
  assert.match(chain, /\brequirePlatformAdmin\b/, 'bulk settings dump is not platform-admin gated');
});

test('GET /:key is gated by the per-key visibility middleware', () => {
  const chain = SETTINGS_SRC.match(/router\.get\('\/:key',\s*(.*?)\(req/)?.[1];
  assert.ok(chain, "could not locate router.get('/:key')");
  assert.match(chain, /\brequireSettingVisibility\b/, 'GET /:key has no visibility gate of its own');
});

test('role-permissions/catalog and github-service/config are declared platform-admin', () => {
  const catalog = SETTINGS_SRC.match(/router\.get\('\/role-permissions\/catalog',\s*(.*?)\(req/)?.[1];
  assert.ok(catalog, 'could not locate the role-permissions catalog route');
  assert.match(catalog, /\brequirePlatformAdmin\b/, 'the whole RBAC matrix is readable below platform admin');

  assert.match(GITHUB_SVC_SRC, /router\.use\(requireAuth\)/, 'github-service router lost its auth');
  const cfg = GITHUB_SVC_SRC.match(/router\.get\('\/config',\s*(.*?)\(_?req/)?.[1];
  assert.ok(cfg, 'could not locate GET /config on the github-service router');
  assert.match(cfg, /\brequirePlatformAdmin\b/, 'service-account config is readable below platform admin');
});

test('the literal-path routes still precede the generic /:key handlers', () => {
  // Registration order is load-bearing: PUT /:key would otherwise capture
  // /role-permissions and reject the matrix payload with "value required".
  const generic = SETTINGS_SRC.indexOf("router.get('/:key'");
  for (const literal of ["router.get('/role-permissions/catalog'", "router.put('/role-permissions'",
                         "router.get('/mail/config'", "router.get('/backup/s3'", "router.get('/embed/config'"]) {
    const at = SETTINGS_SRC.indexOf(literal);
    assert.ok(at > -1 && at < generic, `${literal} must be registered before the generic /:key handlers`);
  }
});

// ── Live enforcement ───────────────────────────────────────────────────────

test('the S3 backup credentials are unreachable for a non-admin', async () => {
  // The exact leak. Both the bulk dump and the targeted read.
  const bulk = await get('/api/settings', KEY_USER);
  assert.equal(bulk.status, 403);
  assert.ok(!bulk.body.includes(LEAKED.backup_s3_access_key_id), 'access key id leaked via the bulk dump');
  assert.ok(!bulk.body.includes(LEAKED.backup_s3_secret_enc), 'encrypted secret leaked via the bulk dump');

  for (const key of ['backup_s3_access_key_id', 'backup_s3_secret_enc']) {
    const r = await get(`/api/settings/${key}`, KEY_USER);
    assert.equal(r.status, 403, `${key} is readable by a low-privilege user`);
    assert.ok(!r.body.includes(LEAKED[key]), `${key} value echoed in the error body`);
  }
});

test('the bulk dump withholds at-rest secrets even from a platform admin', async () => {
  const r = await get('/api/settings', KEY_ADMIN);
  assert.equal(r.status, 200);
  const { settings } = JSON.parse(r.body);
  for (const key of SENSITIVE_KEYS) {
    assert.ok(!(key in settings), `${key} appears in the bulk dump`);
  }
  assert.ok(!r.body.includes(LEAKED.backup_s3_secret_enc));
  // Still functional for what it is for.
  assert.equal(settings.saml_idp_sso_url, LEAKED.saml_idp_sso_url);
});

test('a platform admin can read admin-level keys but never the ciphertext', async () => {
  const ok = await get('/api/settings/backup_s3_access_key_id', KEY_ADMIN);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).value, LEAKED.backup_s3_access_key_id);

  const denied = await get('/api/settings/backup_s3_secret_enc', KEY_ADMIN);
  assert.equal(denied.status, 403, 'SENSITIVE_KEYS must outrank the admin level');
  assert.ok(!denied.body.includes(LEAKED.backup_s3_secret_enc));
});

test('anonymous callers get 401 from the settings router itself', async () => {
  // Not incidentally from some other router mounted at a broader path — the
  // gate has to survive a reordering of the mounts in server/index.js.
  assert.equal((await get('/api/settings')).status, 401);
  assert.equal((await get('/api/settings/saml_idp_sso_url')).status, 401);
  assert.equal((await get('/api/settings/branding')).status, 401);
});

test('auth_sso_only stays readable with no credentials at all', async () => {
  // The login page fetches this before anyone has credentials, to decide
  // whether to render the password form. Gating it shows the password form on
  // an SSO-only instance.
  const r = await get('/api/settings/auth_sso_only');
  assert.equal(r.status, 200, 'the login page can no longer determine the auth policy');
  assert.equal(JSON.parse(r.body).value, 'true');
  assert.equal(settingVisibility('auth_sso_only'), PUBLIC);
});

test('branding stays readable by an ordinary authenticated user', async () => {
  // AI agents read it over an X-API-Key that authenticates as an ordinary user,
  // as build context before scaffolding an app.
  const r = await get('/api/settings/branding', KEY_USER);
  assert.equal(r.status, 200, 'agents lost their brand-guidelines context');
  assert.equal(JSON.parse(r.body).value, LEAKED.branding);
  assert.equal(settingVisibility('branding'), AUTHED);
});

test('the RBAC matrix requires platform admin', async () => {
  assert.equal((await get('/api/settings/role-permissions/catalog')).status, 401);
  const user = await get('/api/settings/role-permissions/catalog', KEY_USER);
  assert.equal(user.status, 403, 'any authenticated user can enumerate the RBAC matrix');
  assert.ok(!user.body.includes('matrix'));
  assert.equal((await get('/api/settings/role-permissions/catalog', KEY_ADMIN)).status, 200);
});

test('the GitHub service-account config requires platform admin', async () => {
  assert.equal((await get('/api/github-service/config')).status, 401);
  assert.equal((await get('/api/github-service/config', KEY_USER)).status, 403,
    'the service account org and token-installed flag are readable by any user');
  assert.equal((await get('/api/github-service/config', KEY_ADMIN)).status, 200);
});

test('an unclassified key is admin-only over HTTP, not just in the classifier', async () => {
  assert.equal((await get('/api/settings/zzz_unclassified_probe_key', KEY_USER)).status, 403);
  assert.equal((await get('/api/settings/zzz_unclassified_probe_key', KEY_ADMIN)).status, 200);
});

test('writing a setting requires platform admin', async () => {
  // The read gate is per-key; the WRITE gate is not, and nothing above exercised
  // it. Losing requirePlatformAdmin here would let any `dhk_user_*` key point
  // the platform at its own TLS material, GitHub service org, embed domain, or
  // MCP image — a straight takeover — while every read assertion stayed green.
  assert.equal((await put('/api/settings/tls_cert_file', 'attacker.pem')).status, 401);

  const denied = await put('/api/settings/tls_cert_file', 'attacker.pem', KEY_USER);
  assert.equal(denied.status, 403, 'a low-privilege user can overwrite platform settings');
  assert.equal(
    getDb().prepare('SELECT value FROM settings WHERE key = ?').get('tls_cert_file'),
    undefined,
    'the rejected write still hit the database',
  );

  const ok = await put('/api/settings/tls_cert_file', '/etc/ssl/crane.pem', KEY_ADMIN);
  assert.equal(ok.status, 200, 'platform admins can no longer save settings');
  assert.equal(
    getDb().prepare('SELECT value FROM settings WHERE key = ?').get('tls_cert_file').value,
    '/etc/ssl/crane.pem',
  );
});

// ── Mount order ────────────────────────────────────────────────────────────

test('nothing mounted at the broader /api swallows the public settings key', () => {
  // The PUBLIC level is inert unless the request actually reaches the settings
  // router. Routers mounted at bare '/api' with a pathless `router.use(
  // requireAuth)` authenticate EVERY request under /api, including ones bound
  // for a router mounted later — so a router registered before
  // '/api/settings' 401s the login page's anonymous fetch before the
  // visibility middleware ever runs.
  const imports = new Map(
    [...INDEX_SRC.matchAll(/^import\s+(\w+)\s+from\s+'(\.\/routes\/[\w.]+\.js)';/gm)]
      .map(m => [m[1], m[2]])
  );
  const mounts = [...INDEX_SRC.matchAll(/^app\.use\('(\/api[^']*)',\s*(\w+)\)/gm)]
    .map(m => ({ path: m[1], router: m[2] }));

  const settingsAt = mounts.findIndex(m => m.path === '/api/settings' && imports.get(m.router)?.endsWith('/settings.js'));
  assert.ok(settingsAt > -1, 'could not locate the /api/settings mount in server/index.js');

  const swallowers = mounts.slice(0, settingsAt)
    .filter(m => m.path === '/api' && imports.has(m.router))
    .filter(m => /^router\.use\(requireAuth\);/m.test(readFileSync(join(ROOT, 'server', imports.get(m.router).slice(2)), 'utf8')))
    .map(m => `${m.router} (${imports.get(m.router)})`);

  assert.deepEqual(swallowers, [],
    'these are mounted at /api ahead of /api/settings and authenticate every request under it, ' +
    'so GET /api/settings/auth_sso_only 401s for the anonymous login page and it falls back to ' +
    'rendering the password form on an SSO-only instance. Fix by mounting /api/settings before ' +
    `them, or by scoping their requireAuth to their own paths:\n  ${swallowers.join('\n  ')}`);
});
