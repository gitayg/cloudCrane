import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// The self-hostable app catalogue: GET /api/catalog and
// GET /api/catalog/:slug/versions.
//
// Everything below goes over a real socket into the REAL router with a real API
// key, because the failures this feature is prone to are authorization and
// degradation failures and both live in the wiring rather than in a function:
//
//   - The page must be readable by EVERY logged-in user (requireAuth), while
//     deploying stays behind the configurable `platform.create_app` permission.
//     A unit test of the permission helper would pass in a world where the
//     route accidentally called requireAdmin.
//   - The page must render when GitHub and Docker Hub do not. A catalogue that
//     500s because Docker Hub is throttling is worse than one showing no stars,
//     and "it degrades" is only a claim until an outage is actually simulated
//     against the served response.
//   - The "already installed" badge must not disclose an app the caller cannot
//     otherwise see. That is an information leak dressed as a convenience, and
//     it is invisible unless a hidden app is actually created and read back by
//     two different callers.
//
// NOTHING here contacts the network: `setFetchImpl` swaps the HTTP layer. The
// SSRF checks are NOT swapped — they are pure URL builders exercised directly,
// so replacing fetch does not replace them.
//
// NOTHING here depends on a specific manifest entry's VALUES. appCatalog.json
// is edited independently of this file (an entry's `image` may become null when
// the image does not resolve), so every fixture is selected by SHAPE from
// whatever the manifest currently holds.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-catalog-'));
process.env.ENCRYPTION_KEY = 'f'.repeat(64);
process.env.LOG_LEVEL = 'error';
delete process.env.CATALOG_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const { setMatrix } = await import('../server/services/permissions.js');
const catalogService = await import('../server/services/catalogService.js');
const {
  loadCatalog, setFetchImpl, resetCatalogCaches, refreshEnrichment,
  githubApiUrl, dockerHubUrl, dockerHubRepo, parseRepoField, assertAllowedUrl,
  normalizeGithubUrl, normalizeImageRef, VERSION_CAP,
} = catalogService;

const catalogRoutes = (await import('../server/routes/catalog.js')).default;
const { errorHandler } = await import('../server/utils/errors.js');

const api = express();
api.use(express.json());
api.use('/api/catalog', catalogRoutes);
api.use(errorHandler);
const server = await new Promise((r) => { const s = api.listen(0, () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  setFetchImpl(null);
  server.closeAllConnections?.();
  server.unref();
  server.close();
});

function mkUser(name, role) {
  const key = generateApiKey('dhk_user');
  const id = db.prepare(
    "INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES (?,?,?,?,1,'human')"
  ).run(name, `${name}@catalog.test`, role, hashApiKey(key)).lastInsertRowid;
  return { id, key, role };
}
const admin = mkUser('catadmin', 'platform_admin');
const plain = mkUser('catplain', 'user');

let slotSeq = 900;
function mkApp({ name, github_url = null, image_ref = null, visibility = 'private', source_type = 'github' }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  db.prepare(
    'INSERT INTO apps (name,slug,slot,source_type,github_url,image_ref,visibility) VALUES (?,?,?,?,?,?,?)'
  ).run(name, slug, slotSeq++, source_type, github_url, image_ref, visibility);
  return slug;
}

async function get(path, key) {
  const res = await fetch(`${BASE}${path}`, key ? { headers: { 'X-API-Key': key } } : undefined);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// --- fake upstream --------------------------------------------------------

function jsonRes(url, status, body) {
  return { ok: status >= 200 && status < 300, status, url, json: async () => body };
}
/** routes: [substring, (url) => response]. First match wins; default 404. */
function router(routes) {
  return async (url) => {
    for (const [needle, handler] of routes) {
      if (url.includes(needle)) return handler(url);
    }
    return jsonRes(url, 404, { message: 'Not Found' });
  };
}
const DEAD = async () => { throw new Error('ECONNREFUSED'); };

// Installed BEFORE the first request. GET /api/catalog kicks a background
// refresh when the cache is stale and does not await it, so without this the
// very first test reaches the real api.github.com — and the reply lands in the
// cache at an unpredictable moment later, which is exactly how the first draft
// of this file failed: six entries arrived with genuine star counts in the
// middle of an outage test.
setFetchImpl(DEAD);

/**
 * Wait for any background refresh to finish, then clear the cache.
 *
 * refreshEnrichment() returns the in-flight promise when one exists, so this
 * drains the fire-and-forget refresh a previous GET started, before the cache
 * is cleared out from under it.
 */
async function reset() {
  await refreshEnrichment().catch(() => {});
  resetCatalogCaches();
}

// --- manifest-shaped fixtures --------------------------------------------

const CATALOG = loadCatalog();
// An entry whose image reference is one Docker Hub can answer for. If a future
// manifest revision leaves none, the image-side assertions have nothing to
// stand on and say so rather than passing vacuously.
const HUB_ENTRY = CATALOG.find(e => e && e.repo && e.image && dockerHubRepo(e.image));
const ANY_ENTRY = CATALOG.find(e => e && e.repo);

test('manifest loads with the shape the API depends on', () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length > 0, 'catalogue is a non-empty array');
  const slugs = new Set();
  for (const e of CATALOG) {
    assert.equal(typeof e.slug, 'string', `${e.name}: slug is a string`);
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.category, 'string');
    assert.ok(!slugs.has(e.slug), `slug '${e.slug}' is unique`);
    slugs.add(e.slug);
    // `image` MAY be null — an entry whose image does not resolve is a normal
    // case, not an error, and nothing here may assume otherwise.
    assert.ok(e.image === null || typeof e.image === 'string');
  }
  assert.ok(ANY_ENTRY, 'at least one entry carries a repo');
  assert.ok(HUB_ENTRY, 'at least one entry carries a Docker Hub image reference');
});

// --- 1. read is universal, deploy is not ---------------------------------

test('GET /api/catalog rejects an unauthenticated caller', async () => {
  const { status } = await get('/api/catalog');
  assert.equal(status, 401);
});

test('GET /api/catalog is readable by an ordinary user, not just admins', async () => {
  const { status, body } = await get('/api/catalog', plain.key);
  assert.equal(status, 200, 'a plain user can READ the catalogue');
  assert.equal(body.count, CATALOG.length);
  assert.equal(body.catalog.length, CATALOG.length);
  assert.ok(body.categories.length > 1);
});

test('can_create_app follows the platform.create_app matrix, not the login', async () => {
  setMatrix({ 'platform.create_app': { user: 0, admin: 1, owner: 1, platform_admin: 1 } });
  let r = await get('/api/catalog', plain.key);
  assert.equal(r.body.can_create_app, false, 'user tier ungranted → cannot deploy');
  assert.equal(r.status, 200, 'but can still read the page');

  r = await get('/api/catalog', admin.key);
  assert.equal(r.body.can_create_app, true, 'platform_admin always may');

  setMatrix({ 'platform.create_app': { user: 1, admin: 1, owner: 1, platform_admin: 1 } });
  r = await get('/api/catalog', plain.key);
  assert.equal(r.body.can_create_app, true, 'granting the user tier flips it');

  setMatrix({ 'platform.create_app': { user: 0, admin: 1, owner: 1, platform_admin: 1 } });
});

// --- 2. SSRF: no manifest field ever reaches a URL unvalidated ------------

test('repo and image fields cannot steer an outbound request', () => {
  // Path traversal, absolute URLs, an injected host, credentials, a port, and
  // a scheme downgrade. Every one returns null rather than a URL.
  for (const hostile of [
    '../../../etc/passwd', 'owner/repo/../../evil', 'https://evil.test/x',
    'owner/repo?x=1', 'owner//repo', 'owner', 'owner/repo/extra',
    '@evil.test/x', 'ow ner/repo', 'owner/re:po', '', null, 42, {},
  ]) {
    assert.equal(githubApiUrl(hostile), null, `githubApiUrl rejects ${JSON.stringify(hostile)}`);
    assert.equal(parseRepoField(hostile), null, `parseRepoField rejects ${JSON.stringify(hostile)}`);
  }
  for (const hostile of [
    'https://evil.test/img', 'evil.test:9999/img@x', '../../x', 'IMG/Upper',
    'user:pass@registry/img', '', null, 42,
  ]) {
    assert.equal(dockerHubUrl(hostile), null, `dockerHubUrl rejects ${JSON.stringify(hostile)}`);
  }

  // Anything that IS built lands on the allowlist and nowhere else.
  const gh = githubApiUrl('owner/repo', '/releases', '?per_page=5');
  assert.equal(gh, 'https://api.github.com/repos/owner/repo/releases?per_page=5');
  const hub = dockerHubUrl('odoo', '/tags', '?page_size=5');
  assert.equal(hub, 'https://hub.docker.com/v2/repositories/library/odoo/tags?page_size=5');

  // The final gate, exercised on its own: host, scheme, credentials, port.
  assert.equal(assertAllowedUrl('http://api.github.com/x'), null, 'http is refused');
  assert.equal(assertAllowedUrl('https://api.github.com.evil.test/x'), null, 'suffix host is refused');
  assert.equal(assertAllowedUrl('https://evil.test/x'), null);
  assert.equal(assertAllowedUrl('https://u:p@api.github.com/x'), null, 'credentials refused');
  assert.equal(assertAllowedUrl('https://api.github.com:8443/x'), null, 'explicit port refused');
  assert.equal(assertAllowedUrl('https://hub.docker.com/v2/x'), 'https://hub.docker.com/v2/x');

  // Every entry in the shipped manifest either produces an allowlisted URL or
  // produces nothing. There is no third outcome.
  for (const e of CATALOG) {
    const u = githubApiUrl(e.repo);
    if (u) assert.ok(u.startsWith('https://api.github.com/repos/'), `${e.slug}: ${u}`);
    const i = dockerHubUrl(e.image);
    if (i) assert.ok(i.startsWith('https://hub.docker.com/v2/repositories/'), `${e.slug}: ${i}`);
  }
});

test('a redirect off the allowlist is discarded, not followed into', async () => {
  await reset();
  setFetchImpl(async (url) => ({
    ok: true, status: 200,
    url: 'https://evil.test/pwned',        // where the redirect chain LANDED
    json: async () => ({ stargazers_count: 999999 }),
  }));
  await refreshEnrichment({ force: true });
  const r = await get('/api/catalog', plain.key);
  const withStars = r.body.catalog.filter(e => e.enrichment && e.enrichment.stars !== null);
  assert.equal(withStars.length, 0, 'a body fetched from off-allowlist is not believed');
});

// --- 3. live enrichment: BOTH versions, labelled -------------------------

test('stars, pulls and BOTH versions are carried separately', async () => {
  await reset();
  setFetchImpl(router([
    ['/releases/latest', (u) => jsonRes(u, 200, { tag_name: 'v3.2.0', published_at: '2026-08-01T00:00:00Z' })],
    ['hub.docker.com', (u) => (u.includes('/tags')
      ? jsonRes(u, 200, { results: [
          { name: 'latest', last_updated: '2026-08-05T00:00:00Z' },
          { name: '3.1.0', last_updated: '2026-07-01T00:00:00Z' },
        ] })
      : jsonRes(u, 200, { pull_count: 12345678 }))],
    ['api.github.com/repos/', (u) => jsonRes(u, 200, { stargazers_count: 4242 })],
  ]));
  await refreshEnrichment({ force: true });

  const { body } = await get('/api/catalog', plain.key);
  const row = body.catalog.find(e => e.slug === HUB_ENTRY.slug);
  assert.equal(row.enrichment.stars, 4242);
  assert.equal(row.enrichment.pulls, 12345678);

  // The whole point of carrying two: a project can cut v3.2.0 while the image
  // it publishes is still 3.1.0. Showing the release beside a deploy button
  // would promise a version the deploy does not deliver.
  assert.deepEqual(
    { v: row.enrichment.github_version.value, k: row.enrichment.github_version.kind },
    { v: 'v3.2.0', k: 'release' },
  );
  assert.deepEqual(
    { v: row.enrichment.image_version.value, k: row.enrichment.image_version.kind },
    { v: '3.1.0', k: 'tag' },
  );
  assert.notEqual(row.enrichment.github_version.value, row.enrichment.image_version.value);
  // 'latest' is a pointer, not a version — it is never reported as one.
  assert.notEqual(row.enrichment.image_version.value, 'latest');
});

test('a project with no Releases falls back to its newest tag', async () => {
  await reset();
  setFetchImpl(router([
    // 6 of the 76 catalogued projects cut no GitHub Release at all and only
    // push tags. 404 here is that case, and it is the only failure that may
    // fall through to /tags.
    ['/releases/latest', (u) => jsonRes(u, 404, { message: 'Not Found' })],
    ['/tags', (u) => jsonRes(u, 200, [{ name: '17.0' }, { name: '16.0' }])],
    ['api.github.com/repos/', (u) => jsonRes(u, 200, { stargazers_count: 7 })],
  ]));
  await refreshEnrichment({ force: true });
  const { body } = await get('/api/catalog', plain.key);
  const row = body.catalog.find(e => e.slug === ANY_ENTRY.slug);
  assert.equal(row.enrichment.github_version.value, '17.0');
  assert.equal(row.enrichment.github_version.kind, 'tag', 'labelled a tag, not a release');
  assert.equal(row.enrichment.sources.github, 'tags');
});

test('a project with neither releases nor tags reports no version, not an invented one', async () => {
  await reset();
  setFetchImpl(router([
    ['/releases/latest', (u) => jsonRes(u, 404, { message: 'Not Found' })],
    ['/tags', (u) => jsonRes(u, 200, [])],
    ['api.github.com/repos/', (u) => jsonRes(u, 200, { stargazers_count: 11 })],
  ]));
  await refreshEnrichment({ force: true });
  const { body } = await get('/api/catalog', plain.key);
  const row = body.catalog.find(e => e.slug === ANY_ENTRY.slug);
  assert.equal(row.enrichment.stars, 11, 'the star count still arrived');
  assert.equal(row.enrichment.github_version, null, 'no version is honestly null');
});

test('an image on a registry Docker Hub cannot answer for is reported, not errored', async () => {
  assert.equal(dockerHubRepo('ghcr.io/owner/app'), null);
  assert.equal(dockerHubUrl('ghcr.io/owner/app'), null);
  await reset();
  setFetchImpl(router([['api.github.com', (u) => jsonRes(u, 200, { stargazers_count: 5 })]]));
  const { fetchImageFacts } = catalogService;
  assert.deepEqual(await fetchImageFacts('ghcr.io/owner/app'),
    { pulls: null, version: null, source: 'unsupported-registry' });
  assert.deepEqual(await fetchImageFacts(null),
    { pulls: null, version: null, source: 'no-image' });
});

// --- 4. the outage rule --------------------------------------------------

test('the catalogue renders with no figures when every upstream is down', async () => {
  await reset();
  setFetchImpl(DEAD);
  await refreshEnrichment({ force: true });

  const { status, body } = await get('/api/catalog', plain.key);
  assert.equal(status, 200, 'a dead GitHub does not 500 the page');
  assert.equal(body.catalog.length, CATALOG.length, 'every entry still renders');
  const leaked = body.catalog.filter(e => e.enrichment !== null);
  assert.deepEqual(leaked.map(e => [e.slug, e.enrichment]), [], 'and every one carries no figures');
  assert.equal(body.enrichment.degraded, true, 'the page is told WHY there are no numbers');
  assert.equal(body.enrichment.entries_with_figures, 0);
});

test('a 429 throttle is degradation, not failure', async () => {
  await reset();
  setFetchImpl(async (url) => jsonRes(url, 429, { message: 'rate limit exceeded' }));
  await refreshEnrichment({ force: true });
  const { status, body } = await get('/api/catalog', plain.key);
  assert.equal(status, 200);
  assert.equal(body.catalog.length, CATALOG.length);
  assert.equal(body.enrichment.entries_with_figures, 0);
});

test('cached figures SURVIVE an outage that starts after they were fetched', async () => {
  await reset();
  setFetchImpl(router([
    ['/releases/latest', (u) => jsonRes(u, 200, { tag_name: 'v9.9.9', published_at: null })],
    ['hub.docker.com', (u) => (u.includes('/tags')
      ? jsonRes(u, 200, { results: [{ name: '9.9.8', last_updated: null }] })
      : jsonRes(u, 200, { pull_count: 777 }))],
    ['api.github.com/repos/', (u) => jsonRes(u, 200, { stargazers_count: 1234 })],
  ]));
  await refreshEnrichment({ force: true });
  let r = await get('/api/catalog', plain.key);
  assert.equal(r.body.catalog.find(e => e.slug === HUB_ENTRY.slug).enrichment.stars, 1234);

  // Upstream now dies. A forced refresh learns nothing and must not erase what
  // it already knew — stale figures beat blank ones.
  setFetchImpl(DEAD);
  await refreshEnrichment({ force: true });
  r = await get('/api/catalog', plain.key);
  assert.equal(r.status, 200);
  const row = r.body.catalog.find(e => e.slug === HUB_ENTRY.slug);
  assert.equal(row.enrichment.stars, 1234, 'the star count from before the outage is still served');
  assert.equal(row.enrichment.pulls, 777);
  assert.equal(row.enrichment.github_version.value, 'v9.9.9');
  assert.equal(r.body.enrichment.entries_with_figures, CATALOG.length);
});

test('a PARTIAL refresh is retried soon; a complete one is not', async () => {
  // Measured against the real APIs from this host with no token: a cold refresh
  // enriched 34 of 76 entries and then hit GitHub's anonymous 60/hour ceiling,
  // every remaining repo answering 403. Under the six-hour TTL those 42 entries
  // would read as "no stars" for six hours instead of "not asked yet".
  let budget = 30;
  await reset();
  setFetchImpl(async (url) => (budget-- > 0
    ? jsonRes(url, 200, { stargazers_count: 1, pull_count: 1, results: [] })
    : jsonRes(url, 403, { message: 'API rate limit exceeded' })));
  await refreshEnrichment({ force: true });

  let r = await get('/api/catalog', plain.key);
  const partial = r.body.enrichment;
  assert.equal(partial.entries_total, CATALOG.length);
  assert.ok(partial.entries_with_figures > 0, 'some entries were enriched');
  assert.ok(partial.entries_with_figures < partial.entries_total, 'but not all of them');
  assert.equal(partial.complete, false);
  assert.equal(partial.stale, false, 'not stale the moment it was written');

  // Twenty minutes later the PARTIAL cache is due for another attempt, where a
  // complete one would not be for six hours. Clock moved rather than reasoned
  // about, because the two constants are the entire point of the test.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 20 * 60 * 1000;
    r = await get('/api/catalog', plain.key);
    assert.equal(r.body.enrichment.stale, true, 'a partial cache is retried within the hour');

    // Now complete it and check the same 20 minutes does NOT make it stale.
    Date.now = realNow;
    setFetchImpl(async (url) => jsonRes(url, 200, { stargazers_count: 2, pull_count: 2, results: [] }));
    await refreshEnrichment({ force: true });
    Date.now = () => realNow() + 20 * 60 * 1000;
    r = await get('/api/catalog', plain.key);
    assert.equal(r.body.enrichment.complete, true);
    assert.equal(r.body.enrichment.stale, false, 'a complete cache is left alone for hours');
  } finally {
    Date.now = realNow;
  }
});

// --- 5. the version dropdown --------------------------------------------

test('GET /:slug/versions returns both sets, labelled and capped', async () => {
  await reset();
  const manyReleases = Array.from({ length: 500 }, (_, i) => ({ tag_name: `v${i}`, published_at: null, prerelease: false }));
  const manyTags = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}` }));
  const manyImageTags = Array.from({ length: 500 }, (_, i) => ({ name: `i${i}`, last_updated: null }));
  setFetchImpl(router([
    ['/releases?', (u) => jsonRes(u, 200, manyReleases)],
    ['/tags?per_page', (u) => jsonRes(u, 200, manyTags)],
    ['hub.docker.com', (u) => jsonRes(u, 200, { results: manyImageTags })],
  ]));

  const { status, body } = await get(`/api/catalog/${HUB_ENTRY.slug}/versions`, plain.key);
  assert.equal(status, 200);
  assert.equal(body.cap, VERSION_CAP);
  // A project with thousands of tags must not be returned in full: that is a
  // denial of service against AppCrane's own page, paid for with AppCrane's
  // own bandwidth.
  assert.equal(body.github.releases.length, VERSION_CAP);
  assert.equal(body.github.tags.length, VERSION_CAP);
  assert.equal(body.image.tags.length, VERSION_CAP);
  assert.equal(body.github.releases[0].name, 'v0', 'newest first, as upstream ordered them');
  assert.equal(body.image.source, 'dockerhub');
  assert.equal(body.github.source, 'releases');
  assert.equal(body.cached, false);

  // Second call is served from cache — the dropdown does not re-hit upstream on
  // every open.
  let calls = 0;
  setFetchImpl(async (u) => { calls++; return jsonRes(u, 500, {}); });
  const again = await get(`/api/catalog/${HUB_ENTRY.slug}/versions`, plain.key);
  assert.equal(again.body.cached, true);
  assert.equal(calls, 0, 'no outbound request on a cache hit');
});

test('the version dropdown degrades instead of failing when upstream is down', async () => {
  await reset();
  setFetchImpl(DEAD);
  const { status, body } = await get(`/api/catalog/${ANY_ENTRY.slug}/versions`, plain.key);
  assert.equal(status, 200, 'a dead upstream is an empty dropdown, not a 502');
  assert.equal(body.github.available, false);
  assert.equal(body.image.available, false);
  assert.deepEqual(body.github.releases, []);
  assert.ok(body.github.error, 'and the reason is stated rather than hidden');
});

test('an unknown slug is a 404, and cannot name a repo of its own', async () => {
  const r = await get('/api/catalog/no-such-app-xyz/versions', plain.key);
  assert.equal(r.status, 404);
  const r2 = await get('/api/catalog/owner%2Frepo/versions', plain.key);
  assert.equal(r2.status, 404, 'the slug indexes the manifest; it is not a repo name');
  const r3 = await get(`/api/catalog/${ANY_ENTRY.slug}/versions`);
  assert.equal(r3.status, 401, 'and the dropdown is behind auth too');
});

// --- 6. installed matching, and the leak it must not become --------------

test('installed matching normalises both sides', () => {
  assert.equal(normalizeGithubUrl('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(normalizeGithubUrl('https://github.com/Owner/Repo/tree/main'), 'owner/repo');
  assert.equal(normalizeGithubUrl('https://gitlab.com/o/r'), null);
  assert.equal(normalizeGithubUrl('not a url'), null);
  assert.equal(normalizeGithubUrl(null), null);

  assert.equal(normalizeImageRef('odoo:19'), 'odoo');
  assert.equal(normalizeImageRef('docker.io/library/odoo:19'), 'odoo');
  assert.equal(normalizeImageRef('ghcr.io/owner/app@sha256:' + 'a'.repeat(64)), 'ghcr.io/owner/app');
  assert.equal(normalizeImageRef('user:pass@registry/img'), null);
  assert.equal(normalizeImageRef(null), null);
});

test('an app deployed from a catalogued repo is reported as installed', async () => {
  const slug = mkApp({
    name: 'Cat Repo Match',
    github_url: `https://github.com/${ANY_ENTRY.repo}.git`,
    visibility: 'private',
  });
  const { body } = await get('/api/catalog', plain.key);
  const row = body.catalog.find(e => e.slug === ANY_ENTRY.slug);
  assert.equal(row.is_installed, true);
  assert.ok(row.installed.some(i => i.slug === slug && i.matched_on === 'repo'));
});

test('an app deployed from a catalogued image is reported as installed', async () => {
  const slug = mkApp({
    name: 'Cat Image Match',
    source_type: 'image',
    image_ref: `${HUB_ENTRY.image}:1.2.3`,
    visibility: 'private',
  });
  const { body } = await get('/api/catalog', plain.key);
  const row = body.catalog.find(e => e.slug === HUB_ENTRY.slug);
  assert.equal(row.is_installed, true);
  assert.ok(row.installed.some(i => i.slug === slug), 'the tag does not defeat the match');
});

test('SECURITY: a hidden app is not disclosed through the installed badge', async () => {
  // A catalogue entry nothing else in this file has installed, so the only
  // thing that can flip its badge is the hidden app below.
  const target = CATALOG.find(e => e.repo
    && e.slug !== ANY_ENTRY.slug && e.slug !== HUB_ENTRY.slug);
  assert.ok(target, 'manifest has a third distinct entry to use');

  const hiddenSlug = mkApp({
    name: 'Cat Hidden App',
    github_url: `https://github.com/${target.repo}`,
    visibility: 'hidden',
  });

  const asUser = await get('/api/catalog', plain.key);
  const userRow = asUser.body.catalog.find(e => e.slug === target.slug);
  assert.equal(userRow.is_installed, false,
    'a user who cannot see the app is not told it exists');
  assert.deepEqual(userRow.installed, [],
    'and is given no name, slug or hint of one');
  assert.ok(!JSON.stringify(asUser.body).includes(hiddenSlug),
    'the hidden slug appears nowhere in the response');

  const asAdmin = await get('/api/catalog', admin.key);
  const adminRow = asAdmin.body.catalog.find(e => e.slug === target.slug);
  assert.equal(adminRow.is_installed, true, 'an admin, who CAN see it, is told');
  assert.ok(adminRow.installed.some(i => i.slug === hiddenSlug));
});

// --- 7. metadata only ----------------------------------------------------

test('nothing in the catalogue path can download image content', () => {
  // Comments are stripped first: this file's own prose explains what the code
  // must not do, and scanning the prose reports the explanation as the offence.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const svc = strip(readFileSync(new URL('../server/services/catalogService.js', import.meta.url), 'utf8'));
  const route = strip(readFileSync(new URL('../server/routes/catalog.js', import.meta.url), 'utf8'));
  for (const [label, src] of [['catalogService.js', svc], ['routes/catalog.js', route]]) {
    // The repo ships a 24 KB JSON manifest and no blobs. Image content is
    // pulled by services/imageSource.js on the AppCrane host at DEPLOY time and
    // by nothing else; this path traffics in metadata.
    for (const banned of ['child_process', 'execFile', 'spawn(', 'docker pull', 'writeFileSync', 'createWriteStream']) {
      assert.ok(!src.includes(banned), `${label} must not reference ${banned}`);
    }
  }
  // parseImageRef is imported for its GRAMMAR, not to reach Docker.
  assert.ok(svc.includes("from './imageSource.js'"));
});

test('no second path into app creation was added', () => {
  const route = readFileSync(new URL('../server/routes/catalog.js', import.meta.url), 'utf8');
  // POST /api/apps already accepts everything an install needs and carries the
  // platform.create_app gate plus audit middleware. A write verb here would be
  // a second authorization surface to keep in sync with the first.
  for (const verb of ['router.post', 'router.put', 'router.patch', 'router.delete']) {
    assert.ok(!route.includes(verb), `catalog.js must expose no ${verb}`);
  }
});
