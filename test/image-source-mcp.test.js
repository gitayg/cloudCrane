import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// source_type='image' reaching an agent through MCP.
//
// The column's CHECK constraint (migration 083) is only the first of FOUR
// places a source type has to be listed before it is usable: POST /api/apps and
// PUT /api/apps/:slug each carry their own VALID_SOURCE_TYPES, and
// appcrane_update_app carries a JSON-Schema enum of its own. That third gate is
// how 'upload' shipped in v2.53.0 with the REST route accepting a source type
// the MCP tool advertised as invalid, and nothing caught it — the enum is
// advertisement, not runtime validation, so no request fails; the agent simply
// never learns the value exists.
//
// So the tests below drive callTool, not the schema. A test that reads
// TOOLS[...].inputSchema.properties.source_type.enum proves the string is
// present in a data structure; it does not prove a row lands in apps with
// source_type='image' and an image_ref beside it. The one schema assertion here
// is explicitly labelled as covering the advertisement, because the
// advertisement is the entire mechanism by which an agent picks the value.
//
// The second risk is the reference itself. It is the whole input — it selects
// what code runs — and the failure that matters is not a malformed string
// (parseImageRef rejects those loudly) but an ACCEPTED one that is unpinned:
// 'odoo' and 'odoo:latest' are both valid references that mean "whatever the
// publisher pushed most recently", so two deploys of the same stored value can
// start different code and nothing about the app row looks wrong afterwards.
// The refusal rule here is deliberately identical to validateImageRef in
// server/routes/apps.js — REST and MCP are separate gates on the same column,
// and a value one accepts and the other refuses is the bug this file exists
// to keep out.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-imgmcp-'));
process.env.ENCRYPTION_KEY = 'e'.repeat(64);
process.env.LOG_LEVEL = 'error';

// Neither docker nor caddy may be reachable: app creation reloads Caddy and
// starts health checks, and this file asserts on database rows.
const SHIM = join(process.env.DATA_DIR, 'bin');
mkdirSync(SHIM, { recursive: true });
for (const bin of ['docker', 'caddy']) {
  writeFileSync(join(SHIM, bin), '#!/bin/sh\necho "not available" >&2\nexit 1\n', { mode: 0o755 });
}
process.env.PATH = `${SHIM}:${process.env.PATH}`;

const { initDb, getDb } = await import('../server/db.js');
initDb();
const db = getDb();

const { callTool, getToolCatalog } = await import('../server/services/mcpTools.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');

const adminId = db.prepare(
  "INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES ('Admin','admin@x.io','platform_admin',?,1,'human')"
).run(hashApiKey(generateApiKey('dhk_admin'))).lastInsertRowid;
const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);

const unwrap = (r) => JSON.parse(r.content[0].text);
const appRow = (slug) => db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);

after(async () => {
  const { stopHealthChecker } = await import('../server/services/healthChecker.js');
  stopHealthChecker();
});

// ---------------------------------------------------------------------------
// Creating an image app
// ---------------------------------------------------------------------------

test('an image app is created with its ref, port and health path persisted', async () => {
  const res = unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Odoo',
    slug: 'odoo-img',
    source_type: 'image',
    image_ref: 'odoo:19',
    container_port: 8069,
    health_path: '/web/health',
  }));

  assert.equal(res.app.source_type, 'image');

  const row = appRow('odoo-img');
  assert.ok(row, 'no app row was created');
  // The point of the whole change: not that the call returned 200-shaped JSON,
  // but that the four columns a deploy will read actually hold the values.
  assert.equal(row.source_type, 'image');
  assert.equal(row.image_ref, 'odoo:19');
  assert.equal(row.container_port, 8069);
  assert.equal(row.health_path, '/web/health');
  assert.equal(row.github_url, null, 'an image app must not carry a repo URL');
});

test('image_ref alone implies source_type=image', async () => {
  // An agent that passes the reference but forgets the discriminator would
  // otherwise get a github app carrying an image_ref nothing reads — which
  // fails at deploy with a clone error naming a URL that is null.
  unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Implied', slug: 'implied-img', image_ref: 'ghcr.io/o/a:v2',
  }));
  assert.equal(appRow('implied-img').source_type, 'image');
});

test('a digest-pinned ref is accepted', async () => {
  const ref = `ghcr.io/o/a@sha256:${'a'.repeat(64)}`;
  unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Pinned', slug: 'pinned-img', image_ref: ref,
  }));
  assert.equal(appRow('pinned-img').image_ref, ref);
});

test('the port and health path stay NULL when the image matches AppCrane defaults', async () => {
  // NULL is meaningful here — it is what makes the deployer fall back to 3000
  // and /api/health — so it must not be written as 0 or ''.
  unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Defaults', slug: 'defaults-img', image_ref: 'myorg/myapp:1.0.0',
  }));
  const row = appRow('defaults-img');
  assert.equal(row.container_port, null);
  assert.equal(row.health_path, null);
});

test('a github app still creates, and gains no image fields', async () => {
  // The image parameters are additive: removing github_url from the schema's
  // required list must not stop validating it for the source type that needs it.
  unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Repo', slug: 'repo-app', github_url: 'https://github.com/me/mysite',
  }));
  const row = appRow('repo-app');
  assert.equal(row.source_type, 'github');
  assert.equal(row.image_ref, null);
});

// ---------------------------------------------------------------------------
// Refusing a bad reference
// ---------------------------------------------------------------------------

test('an unpinned reference is refused, and creates nothing', async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Latest', slug: 'unpinned-img', image_ref: 'odoo',
    }),
    /not pinned/i,
  );
  // A rejection that still leaves a half-built app behind is worse than no
  // rejection: the slug is taken and the row has no image to deploy.
  assert.equal(appRow('unpinned-img'), undefined);
});

test('an explicit :latest is refused too', async () => {
  // The tag is present, so a check for "has a tag" passes it. ':latest' is the
  // one tag guaranteed to move, and it is the one an agent reaches for by
  // default — routes/apps.js refuses it, and a gate that refuses it on REST
  // and accepts it on MCP is not a gate.
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Latest Tag', slug: 'latest-img', image_ref: 'odoo:latest',
    }),
    /not pinned/i,
  );
  assert.equal(appRow('latest-img'), undefined);
});

test('a boolean container_port is refused rather than silently becoming port 1', async () => {
  // Number(true) === 1, which is a valid port number.
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Bool Port', slug: 'boolport-img', image_ref: 'odoo:19', container_port: true,
    }),
    /container_port/,
  );
  assert.equal(appRow('boolport-img'), undefined);
});

test('a malformed reference is refused with the parser\'s own reason', async () => {
  // Uppercase is genuinely invalid in a repository path — `docker pull Ubuntu`
  // fails — so this is the parser talking, not an invented rule.
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Shouty', slug: 'shouty-img', image_ref: 'Odoo:19',
    }),
    /invalid image name component/i,
  );
  assert.equal(appRow('shouty-img'), undefined);
});

test('a reference carrying credentials is refused', async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Creds', slug: 'creds-img', image_ref: 'user:pw@registry.io/img:1',
    }),
    /image reference/i,
  );
  assert.equal(appRow('creds-img'), undefined);
});

test("source_type='image' without an image_ref is refused", async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Empty', slug: 'empty-img', source_type: 'image',
    }),
    /requires image_ref/,
  );
  assert.equal(appRow('empty-img'), undefined);
});

test('a container_port outside the TCP range is refused', async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Bad Port', slug: 'badport-img', image_ref: 'odoo:19', container_port: 70000,
    }),
    /container_port/,
  );
});

test('a health_path without a leading slash is refused', async () => {
  // 'health' concatenated onto the container origin becomes part of the host
  // name, which fails as a DNS lookup rather than as a 404 — an error nobody
  // reads as "the path was wrong".
  await assert.rejects(
    () => callTool(admin, 'appcrane_create_app', {
      name: 'Bad Path', slug: 'badpath-img', image_ref: 'odoo:19', health_path: 'health',
    }),
    /health_path/,
  );
});

// ---------------------------------------------------------------------------
// Updating an existing app
// ---------------------------------------------------------------------------

test('appcrane_update_app repoints an image app at a new ref', async () => {
  const res = unwrap(await callTool(admin, 'appcrane_update_app', {
    slug: 'odoo-img', image_ref: 'odoo:18', container_port: 8070,
  }));
  assert.equal(res.config.image_ref, 'odoo:18');
  assert.equal(res.config.container_port, 8070);
  assert.equal(appRow('odoo-img').image_ref, 'odoo:18');
  // health_path was not passed and must be left alone.
  assert.equal(appRow('odoo-img').health_path, '/web/health');
});

test('appcrane_update_app converts a github app to an image app', async () => {
  // This is the path the update tool's source_type enum gates. Before 'image'
  // was listed there, an agent reading tools/list had no reason to believe the
  // value was accepted at all.
  unwrap(await callTool(admin, 'appcrane_update_app', {
    slug: 'repo-app', source_type: 'image', image_ref: 'nginx:1.27', container_port: 80,
  }));
  const row = appRow('repo-app');
  assert.equal(row.source_type, 'image');
  assert.equal(row.image_ref, 'nginx:1.27');
});

test('flipping source_type to image with no ref anywhere is refused', async () => {
  unwrap(await callTool(admin, 'appcrane_create_app', {
    name: 'Flip', slug: 'flip-app', github_url: 'https://github.com/me/flip',
  }));
  await assert.rejects(
    () => callTool(admin, 'appcrane_update_app', { slug: 'flip-app', source_type: 'image' }),
    /requires image_ref/,
  );
  // The refusal must not have half-applied: an app marked 'image' with no ref
  // has nothing to deploy, and the error would surface much later as docker
  // being handed an empty string.
  assert.equal(appRow('flip-app').source_type, 'github');
});

test('clearing image_ref on an image app is refused rather than leaving it undeployable', async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_update_app', { slug: 'defaults-img', image_ref: '' }),
    /requires image_ref/,
  );
  assert.equal(appRow('defaults-img').image_ref, 'myorg/myapp:1.0.0');
});

test('an unpinned reference is refused on update too', async () => {
  await assert.rejects(
    () => callTool(admin, 'appcrane_update_app', { slug: 'odoo-img', image_ref: 'odoo' }),
    /not pinned/i,
  );
  // The previously stored, pinned value must survive the rejected edit.
  assert.equal(appRow('odoo-img').image_ref, 'odoo:18');
});

// ---------------------------------------------------------------------------
// The advertisement. Not runtime validation — nothing rejects an out-of-enum
// value — but it is the only thing telling an agent the value exists, which is
// exactly why 'upload' was unreachable through MCP for a release.
// ---------------------------------------------------------------------------

test("both write tools advertise 'image' and the three image fields", () => {
  const catalog = new Map(getToolCatalog().map((t) => [t.name, t]));

  const update = catalog.get('appcrane_update_app').inputSchema.properties;
  assert.ok(update.source_type.enum.includes('image'),
    "appcrane_update_app's source_type enum is a third gate on top of POST and PUT; " +
    "an agent will not send a value the schema says is invalid");

  for (const tool of ['appcrane_create_app', 'appcrane_update_app']) {
    const props = catalog.get(tool).inputSchema.properties;
    for (const field of ['image_ref', 'container_port', 'health_path']) {
      assert.ok(props[field], `${tool} does not expose ${field}`);
    }
    assert.match(props.image_ref.description, /REFUSED/,
      `${tool} does not warn that an unpinned reference is refused`);
    assert.match(props.image_ref.description, /latest/,
      `${tool} does not tell the agent that ':latest' specifically is refused — it is the tag ` +
      'an agent reaches for by default');
  }
});
