import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// source_type='image' on the two write paths (v2.59.0).
//
// Everything here goes over a real socket into the REAL apps router with a real
// API key. The reason is the specific failure this feature is prone to: apps.js
// declares VALID_SOURCE_TYPES TWICE — once in POST, once in PUT — so adding a
// value to one of them produces an API that accepts 'image' on create and
// answers 400 on every subsequent edit, or the reverse. A test that imported a
// validator and called it would pass in both of those worlds.
//
// The other property under test is the refusal of an UNPINNED reference. A
// deploy resolves the ref to a digest and records that digest as the release's
// identity; against ':latest' — or a bare name, which Docker resolves as
// ':latest' — the record stops being true as soon as the publisher pushes, and
// a rollback restores a different image under the same recorded identity. So
//'odoo:latest' and 'odoo' must both be 400s, and the message must say why.
//
// No docker anywhere on these paths: neither route pulls, inspects or starts
// anything. That is deliberate and is asserted at the end — the reference is
// validated and stored by these routes, and resolved at deploy time.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-image-routes-'));
process.env.ENCRYPTION_KEY = 'f'.repeat(64);
process.env.CRANE_DOMAIN = 'crane.test.local';
process.env.LOG_LEVEL = 'error';

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

function mkUser(name, role) {
  const key = generateApiKey('dhk_user');
  const id = db.prepare(
    "INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES (?,?,?,?,1,'human')"
  ).run(name, `${name}@t.test`, role, hashApiKey(key)).lastInsertRowid;
  return { id, key, role };
}

const admin = mkUser('imgadmin', 'platform_admin');

const appsRoutes = (await import('../server/routes/apps.js')).default;
const { errorHandler } = await import('../server/utils/errors.js');

const api = express();
api.use(express.json());
api.use('/api/apps', appsRoutes);
api.use(errorHandler);

const server = await new Promise((resolve) => {
  const s = api.listen(0, () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

// POST /api/apps schedules health-check intervals that hold the event loop
// open, and undici's keep-alive pool outlives server.close(). Same shutdown as
// test/platform-policy.test.js.
after(async () => {
  const { stopHealthChecker } = await import('../server/services/healthChecker.js');
  stopHealthChecker();
  server.closeAllConnections?.();
  server.unref();
  server.close();
});

async function req(as, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': as.key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const rowFor = (slug) => db.prepare(
  'SELECT source_type, image_ref, container_port, health_path, github_url FROM apps WHERE slug = ?'
).get(slug);

let n = 0;
const nextSlug = (label) => `img-${label}-${++n}`;

// ---------------------------------------------------------------------------
// POST — accept
// ---------------------------------------------------------------------------

test('POST accepts source_type=image and stores the three image columns', async () => {
  const slug = nextSlug('ok');
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Odoo', slug, source_type: 'image',
    image_ref: 'odoo:19', container_port: 8069, health_path: '/web/health',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  assert.deepEqual(rowFor(slug), {
    source_type: 'image',
    image_ref: 'odoo:19',
    container_port: 8069,
    health_path: '/web/health',
    // The ref must NOT be smuggled into github_url: validateGithubUrl runs on
    // that column and deployer.js branches on it being truthy, so a value there
    // selects the git path.
    github_url: null,
  });
});

test('the create response carries the image fields back, so a client can confirm what was stored', async () => {
  const slug = nextSlug('echo');
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Echo', slug, source_type: 'image', image_ref: 'ghcr.io/owner/app:1.2.3',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.app.source_type, 'image');
  assert.equal(r.body.app.image_ref, 'ghcr.io/owner/app:1.2.3');
});

test('container_port and health_path are optional — NULL means the AppCrane defaults', async () => {
  const slug = nextSlug('defaults');
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Defaults', slug, source_type: 'image', image_ref: 'nginx:1.27',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = rowFor(slug);
  assert.equal(row.container_port, null, 'NULL is the 3000 default, not a missing value to reject');
  assert.equal(row.health_path, null);
});

test('a registry-qualified digest ref survives parsing (the localhost:5000 colon is a port, not a tag)', async () => {
  const slug = nextSlug('digest');
  const ref = `localhost:5000/team/app@sha256:${'a'.repeat(64)}`;
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Digest', slug, source_type: 'image', image_ref: ref,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rowFor(slug).image_ref, ref,
    'a digest with no tag is the MOST pinned form there is; rejecting it would invert the rule');
});

// ---------------------------------------------------------------------------
// POST — reject
// ---------------------------------------------------------------------------

test('POST source_type=image with no image_ref is a 400 that names the field', async () => {
  const slug = nextSlug('noref');
  const r = await req(admin, 'POST', '/api/apps', { name: 'No Ref', slug, source_type: 'image' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /image_ref/,
    'an image app with no ref names nothing to run; the operator must be told which field is missing, ' +
    'not meet a column error on the first deploy');
  assert.equal(rowFor(slug), undefined, 'the refused create must not have written a row');
});

test("a bare ':latest' is refused and the message says why", async () => {
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Latest', slug: nextSlug('latest'), source_type: 'image', image_ref: 'odoo:latest',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /pinned/i);
  assert.match(r.body.error.message, /sha256|digest/i,
    'the refusal has to state the accepted alternative — an explicit tag or a digest');
});

test('a ref with NO tag is refused too — Docker resolves it as :latest', async () => {
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Untagged', slug: nextSlug('untagged'), source_type: 'image', image_ref: 'odoo',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /latest/,
    'refusing ":latest" while accepting the bare name that MEANS ":latest" would be a rule in name only');
});

test('a malformed reference is refused by the shared parser, not by a second regex here', async () => {
  for (const bad of ['UPPER/case:1', 'odoo:19;rm -rf /', 'odoo:19@sha256:nothex', 'user:pw@reg.io/a:1']) {
    const r = await req(admin, 'POST', '/api/apps', {
      name: 'Bad', slug: nextSlug('bad'), source_type: 'image', image_ref: bad,
    });
    assert.equal(r.status, 400, `"${bad}" was accepted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error.message, /image_ref/);
  }
});

test('container_port outside 1-65535 is refused, and a boolean is not silently read as port 1', async () => {
  for (const bad of [0, 65536, -1, 8069.5, 'http', true]) {
    const slug = nextSlug('port');
    const r = await req(admin, 'POST', '/api/apps', {
      name: 'Port', slug, source_type: 'image', image_ref: 'nginx:1.27', container_port: bad,
    });
    assert.equal(r.status, 400, `container_port ${JSON.stringify(bad)} was accepted: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error.message, /container_port/);
    assert.equal(rowFor(slug), undefined);
  }
});

test("health_path that does not start with '/' is refused", async () => {
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'HP', slug: nextSlug('hp'), source_type: 'image',
    image_ref: 'nginx:1.27', health_path: 'web/health',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /health_path/);
});

test('an unknown source_type is still refused, and the message lists what is allowed', async () => {
  const r = await req(admin, 'POST', '/api/apps', {
    name: 'Bogus', slug: nextSlug('bogus'), source_type: 'bogus',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /'image'/,
    'widening the allowlist must not remove it, and the error should name the values that now work');
});

// ---------------------------------------------------------------------------
// PUT — the second VALID_SOURCE_TYPES declaration
// ---------------------------------------------------------------------------

test('PUT can convert an existing app to source_type=image', async () => {
  const slug = nextSlug('convert');
  assert.equal((await req(admin, 'POST', '/api/apps', {
    name: 'Convert', slug, source_type: 'github', github_url: 'https://github.com/owner/repo',
  })).status, 201);

  const r = await req(admin, 'PUT', `/api/apps/${slug}`, {
    source_type: 'image', image_ref: 'redis:7.4', container_port: 6379, health_path: '/ping',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = rowFor(slug);
  assert.equal(row.source_type, 'image',
    "PUT has its OWN VALID_SOURCE_TYPES literal — an 'image' added only to POST leaves every edit a 400");
  assert.equal(row.image_ref, 'redis:7.4');
  assert.equal(row.container_port, 6379);
  assert.equal(row.health_path, '/ping');
});

test('PUT refuses an unpinned ref on the update path too', async () => {
  const slug = nextSlug('putlatest');
  await req(admin, 'POST', '/api/apps', {
    name: 'PutLatest', slug, source_type: 'image', image_ref: 'redis:7.4',
  });

  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { image_ref: 'redis:latest' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(rowFor(slug).image_ref, 'redis:7.4',
    'a refused edit must leave the pinned ref in place rather than half-applying the request');
});

test('PUT to source_type=image on a row with no image_ref is refused', async () => {
  const slug = nextSlug('bareconvert');
  await req(admin, 'POST', '/api/apps', {
    name: 'Bare', slug, source_type: 'github', github_url: 'https://github.com/owner/repo',
  });

  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { source_type: 'image' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /image_ref/);
  assert.equal(rowFor(slug).source_type, 'github', 'the row must not have been converted');
});

test('flipping only the source_type is fine when the row ALREADY carries an image_ref', async () => {
  const slug = nextSlug('reflip');
  await req(admin, 'POST', '/api/apps', {
    name: 'Reflip', slug, source_type: 'image', image_ref: 'redis:7.4',
  });
  // Away and back: the ref survives the round trip, so the return flip needs no
  // second copy of the value. A requirement checked against req.body instead of
  // against the effective row would refuse this.
  assert.equal((await req(admin, 'PUT', `/api/apps/${slug}`, { source_type: 'github' })).status, 200);
  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { source_type: 'image' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rowFor(slug).image_ref, 'redis:7.4');
});

test('a read-modify-write PUT that echoes the app back unchanged is not a 400', async () => {
  const slug = nextSlug('rmw');
  const created = await req(admin, 'POST', '/api/apps', {
    name: 'RMW', slug, source_type: 'image',
    image_ref: 'nginx:1.27', container_port: 80, health_path: '/healthz',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const { source_type, image_ref, container_port, health_path } = created.body.app;
  const r = await req(admin, 'PUT', `/api/apps/${slug}`,
    { source_type, image_ref, container_port, health_path, description: 'edited' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rowFor(slug).image_ref, 'nginx:1.27',
    'every GET payload carries these fields, so a client that sends back what it was given must ' +
    'not be refused — that pattern has already broken ingress edits once');
});

test('container_port and health_path can be cleared back to the defaults with an explicit null', async () => {
  const slug = nextSlug('clear');
  await req(admin, 'POST', '/api/apps', {
    name: 'Clear', slug, source_type: 'image',
    image_ref: 'nginx:1.27', container_port: 80, health_path: '/healthz',
  });
  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { container_port: null, health_path: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = rowFor(slug);
  assert.equal(row.container_port, null);
  assert.equal(row.health_path, null);
});

test('an invalid container_port on PUT does not half-apply the rest of the request', async () => {
  const slug = nextSlug('putport');
  await req(admin, 'POST', '/api/apps', {
    name: 'PutPort', slug, source_type: 'image', image_ref: 'nginx:1.27', container_port: 80,
  });
  const r = await req(admin, 'PUT', `/api/apps/${slug}`, { description: 'new', container_port: 70000 });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const row = db.prepare('SELECT description, container_port FROM apps WHERE slug = ?').get(slug);
  assert.equal(row.container_port, 80);
  assert.equal(row.description, null, 'the valid half of a refused request must not land');
});

// ---------------------------------------------------------------------------

test('creating an image app does not shell out to docker — the ref is resolved at deploy time', async () => {
  // A `docker` on PATH that fails loudly, rather than a monkey-patched module:
  // pullImage/resolveDigest reach the daemon through execFile, so a route that
  // pulled or inspected here would surface as a 5xx instead of passing quietly
  // on a developer machine that happens to have Docker running.
  const shimDir = mkdtempSync(join(tmpdir(), 'crane-image-nodocker-'));
  writeFileSync(join(shimDir, 'docker'),
    '#!/bin/sh\necho "docker must not be invoked by the apps routes" >&2\nexit 97\n', { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${prevPath}`;
  try {
    const slug = nextSlug('nodocker');
    const r = await req(admin, 'POST', '/api/apps', {
      name: 'NoDocker', slug, source_type: 'image', image_ref: 'odoo:19',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rowFor(slug).image_ref, 'odoo:19',
      'the tag is stored AS TYPED — re-deploying it is how a patch release is picked up; the digest ' +
      'belongs on the deployment, not on the app');
  } finally {
    process.env.PATH = prevPath;
  }
});
