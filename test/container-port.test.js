import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The container port stopped being a constant (v2.59.0), and the disk that a
// pulled image occupies started being reclaimable. Both are argv facts, so both
// are measured off a recording `docker` shim the way
// test/docker-resource-flags.test.js does, rather than described.
//
// Why this file exists.
//
// 1. `-p 127.0.0.1:<hostPort>:3000` with `PORT=3000` was a contract only an
//    image AppCrane BUILT could keep — the generated Dockerfile and the Node
//    apps behind it listen on $PORT and default to 3000. A pulled third-party
//    image keeps neither half: odoo listens on 8069 and ignores $PORT. Every
//    source_type='image' deploy therefore published a host port with nothing
//    behind it and died at the health probe, with the deploy log blaming the
//    app. The half of this file above the prune section is pointed at that, and
//    at the thing that makes it shippable: with no containerPort argument the
//    argv must not move by a single byte, because 57 existing apps depend on it.
//
// 2. pruneOldImages() filtered on `label=slug=`, which buildImage() writes and a
//    `docker pull` cannot. The filter matched zero rows for an image app, so
//    nothing was ever reclaimed and each redeploy of a moving tag ('odoo:19'
//    picking up a patch release) left the previous image on disk permanently.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-cport-'));
process.env.ENCRYPTION_KEY = 'e'.repeat(64);
process.env.LOG_LEVEL = 'error';

// ---------------------------------------------------------------------------
// A `docker` that records its argv and answers from a scriptable rule table
// ---------------------------------------------------------------------------

const SHIM_DIR = join(process.env.DATA_DIR, 'bin');
const ARGV_LOG = join(process.env.DATA_DIR, 'docker-argv.log');
const RULES = join(process.env.DATA_DIR, 'docker-rules.json');
mkdirSync(SHIM_DIR, { recursive: true });

// CommonJS on purpose: the file is named `docker` with no extension, so Node
// parses it as CJS and an `import` statement here is a syntax error at spawn
// time — which would surface as an unexplained docker failure, not a test error.
writeFileSync(
  join(SHIM_DIR, 'docker'),
  '#!/usr/bin/env node\n' +
  'const { appendFileSync, readFileSync, existsSync } = require("fs");\n' +
  'const argv = process.argv.slice(2);\n' +
  'appendFileSync(process.env.CRANE_TEST_DOCKER_LOG, argv.map(a => a + "\\n").join("") + "\\0");\n' +
  'const rf = process.env.CRANE_TEST_DOCKER_RULES;\n' +
  'const rules = rf && existsSync(rf) ? JSON.parse(readFileSync(rf, "utf8")) : [];\n' +
  'for (const r of rules) {\n' +
  '  if (r.match.every(tok => argv.includes(tok))) {\n' +
  '    process.stdout.write(r.stdout || "");\n' +
  '    process.exit(r.code || 0);\n' +
  '  }\n' +
  '}\n' +
  'process.stdout.write("0123456789abcdef\\n");\n',
  { mode: 0o755 },
);
process.env.CRANE_TEST_DOCKER_LOG = ARGV_LOG;
process.env.CRANE_TEST_DOCKER_RULES = RULES;
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;

// The network inspect that opens every startApp. Answered so ensureAppNetwork
// reads a healthy isolated network instead of parsing the fallback id and
// warning about connectivity on every single start.
const BASE_RULES = [
  { match: ['network', 'inspect'], stdout: 'false|172.20.0.0/16\n' },
  // Empty by default so the label-filtered prune finds nothing to delete unless
  // a test deliberately scripts rows for it.
  { match: ['images', '--filter'], stdout: '' },
];
function setRules(extra = []) {
  writeFileSync(RULES, JSON.stringify([...extra, ...BASE_RULES]));
}
setRules();

function dockerCalls() {
  if (!existsSync(ARGV_LOG)) return [];
  return readFileSync(ARGV_LOG, 'utf8')
    .split('\0')
    .filter(rec => rec.trim() !== '')
    .map(rec => rec.split('\n').filter(l => l !== ''));
}
function clearDockerCalls() {
  if (existsSync(ARGV_LOG)) rmSync(ARGV_LOG);
}
function runArgs() {
  const runs = dockerCalls().filter(c => c[0] === 'run');
  assert.equal(runs.length, 1, `expected exactly one \`docker run\`, saw ${runs.length}`);
  return runs[0];
}

const logger = (await import('../server/utils/logger.js')).default;
for (const lvl of ['warn', 'info', 'debug']) logger[lvl] = () => {};

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const { initDb, getDb } = await import('../server/db.js');
initDb();
const db = getDb();

const { startApp, pruneOldImages } = await import('../server/services/docker.js');
const { getPortsForSlot } = await import('../server/services/portAllocator.js');

let nextSlot = 800;
function mkApp(slug, {
  ingress_type = 'http', public_port = null, data_plane_port = null,
  source_type = 'managed', image_ref = null,
} = {}) {
  const slot = ++nextSlot;
  db.prepare(
    'INSERT INTO apps (name,slug,slot,source_type,ingress_type,public_port,data_plane_port,image_ref) ' +
    'VALUES (?,?,?,?,?,?,?,?)'
  ).run(slug, slug, slot, source_type, ingress_type, public_port, data_plane_port, image_ref);
  return { slug, slot, port: getPortsForSlot(slot).prod_be };
}

const BASE = { env: 'production', image: 'odoo:19', hostPort: 4321, memoryMb: 512, cpus: 0.5 };

async function start(slug, extra = {}) {
  clearDockerCalls();
  await startApp({ ...BASE, slug, ...extra });
  return runArgs();
}

/** Every `-p` value in the argv, in order. */
function publishes(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-p') out.push(args[i + 1]);
  return out;
}

/** The value of `-e NAME=...`, or null. */
function envVar(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && args[i + 1]?.startsWith(`${name}=`)) return args[i + 1].slice(name.length + 1);
  }
  return null;
}

const HTTP_APP = mkApp('cp-http');
const TCP_APP = mkApp('cp-tcp', { ingress_type: 'tcp', public_port: 31910 });
const DUAL_APP = mkApp('cp-dual', { ingress_type: 'dual', public_port: 31911, data_plane_port: 5432 });

// ===========================================================================
// The default has to be invisible — 57 apps ride on it
// ===========================================================================

test('with no containerPort the loopback publish and PORT are still 3000', async () => {
  const args = await start(HTTP_APP.slug);
  assert.deepEqual(publishes(args), ['127.0.0.1:4321:3000'], JSON.stringify(args));
  assert.equal(envVar(args, 'PORT'), '3000', JSON.stringify(args));
});

test('containerPort:3000 given explicitly produces byte-identical argv to omitting it', async () => {
  // The strongest available statement of "nothing existing changes": not a
  // property of the argv but the whole array, compared token for token. A
  // refactor that reorders or duplicates a flag on the new code path fails here
  // even when every individual assertion above still passes.
  const omitted = await start(HTTP_APP.slug);
  const explicit = await start(HTTP_APP.slug, { containerPort: 3000 });
  assert.deepEqual(explicit, omitted);
});

test('a NULL container_port — what migration 083 stores for every existing app — means 3000', async () => {
  // apps.container_port is nullable and NULL MEANS the default. A default
  // parameter fires on `undefined` only, so a caller passing the column through
  // unchanged would otherwise emit `127.0.0.1:4321:null` and `PORT=null`: a
  // container that starts, publishes nothing reachable, and reads as a broken
  // app at the health probe.
  for (const value of [null, undefined]) {
    const args = await start(HTTP_APP.slug, { containerPort: value });
    assert.deepEqual(publishes(args), ['127.0.0.1:4321:3000'], `containerPort=${value}: ${JSON.stringify(args)}`);
    assert.equal(envVar(args, 'PORT'), '3000', `containerPort=${value}`);
  }
});

// ===========================================================================
// A pulled image listens where its author put it
// ===========================================================================

test('the loopback publish targets the given container port, at every port a real image uses', async () => {
  // Swept rather than pinned at 8069, so a hardcoded second literal cannot pass:
  // odoo 8069, nginx 80, postgres 5432, and the top of the range.
  for (const containerPort of [80, 5432, 8069, 8080, 65535]) {
    const args = await start(HTTP_APP.slug, { containerPort });
    assert.deepEqual(publishes(args), [`127.0.0.1:4321:${containerPort}`], JSON.stringify(args));
  }
});

test('PORT follows the container port instead of staying pinned at 3000', async () => {
  // An image that ignores $PORT (odoo, postgres, nginx) does not care. An image
  // that HONOURS it — buildpack output, AppCrane's own builds — would listen on
  // 3000 while the publish pointed at 8069, which is the original bug inverted.
  const args = await start(HTTP_APP.slug, { containerPort: 8069 });
  assert.equal(envVar(args, 'PORT'), '8069', JSON.stringify(args));
  assert.ok(!args.includes('PORT=3000'), `PORT=3000 is still in the argv: ${JSON.stringify(args)}`);
});

test('no 3000 survives anywhere in an 8069 container start', async () => {
  // The catch-all for a second hardcoded 3000 hiding in a flag this file does
  // not name individually. Scoped to the container side of the publish and to
  // the env block, because 3000 legitimately appears nowhere else here.
  const args = await start(HTTP_APP.slug, { containerPort: 8069 });
  for (const p of publishes(args)) {
    assert.ok(!p.endsWith(':3000'), `a publish still targets container port 3000: ${p}`);
  }
});

test('an explicit PORT in envVars still loses to the platform value', async () => {
  // Unchanged precedence, restated because the value being spread over is no
  // longer a constant: runtimeEnv puts PORT after ...envVars deliberately, so an
  // app cannot set a PORT that disagrees with the port AppCrane publishes.
  const args = await start(HTTP_APP.slug, { containerPort: 8069, envVars: { PORT: '1234' } });
  assert.equal(envVar(args, 'PORT'), '8069', JSON.stringify(args));
});

// ===========================================================================
// The tcp/dual publishes, which have a container side of their own
// ===========================================================================

test('a pure-tcp app with no containerPort still publishes 0.0.0.0:<public>:3000', async () => {
  const args = await start(TCP_APP.slug);
  assert.deepEqual(publishes(args), ['127.0.0.1:4321:3000', '0.0.0.0:31910:3000'], JSON.stringify(args));
});

test('a pure-tcp image app publishes the port the image actually listens on', async () => {
  // tcpIngress answers CONTROL_PLANE_PORT for a pure-tcp app because "the whole
  // container is the data plane and it is told PORT=3000". That premise dies
  // with a pulled image: publishing :3000 for a postgres image would put the
  // public port in front of nothing and every client would get
  // connection-refused, with the app itself perfectly healthy.
  const args = await start(TCP_APP.slug, { containerPort: 5432 });
  assert.deepEqual(publishes(args), ['127.0.0.1:4321:5432', '0.0.0.0:31910:5432'], JSON.stringify(args));
});

test('a dual app keeps its configured data-plane port — containerPort moves only the control plane', async () => {
  // SECURITY-adjacent: the two planes are different ports on purpose. If
  // containerPort overwrote the data-plane side, the 0.0.0.0 publish — which has
  // no TLS, no forward_auth, no identity headers and no audit — would carry the
  // HTTP control plane instead, which is exactly what validateDataPlanePort()
  // refuses to let an operator configure by hand.
  const args = await start(DUAL_APP.slug, { containerPort: 8069 });
  assert.deepEqual(publishes(args), ['127.0.0.1:4321:8069', '0.0.0.0:31911:5432'], JSON.stringify(args));
});

test('a dual app with the default container port is byte-identical to before', async () => {
  const args = await start(DUAL_APP.slug);
  assert.deepEqual(publishes(args), ['127.0.0.1:4321:3000', '0.0.0.0:31911:5432'], JSON.stringify(args));
});

// ===========================================================================
// pruneOldImages: pulled images carry no slug label
// ===========================================================================

const PULLED_APP = mkApp('cp-pulled', { source_type: 'image', image_ref: 'odoo:19' });
const GHCR_APP = mkApp('cp-ghcr', { source_type: 'image', image_ref: 'ghcr.io/acme/thing:1.2' });

// Full-length ids, in the 'sha256:<64hex>' form `docker images --no-trunc`
// prints — the short 12-char form is what let an in-use image slip past a
// comparison against `docker ps --no-trunc`.
const IMG = [1, 2, 3, 4, 5].map(n => `sha256:${'a'.repeat(63)}${n}`);

function imagesCall() {
  return dockerCalls().find(c => c[0] === 'images' && c.includes('--no-trunc')) ?? null;
}
function removed() {
  return dockerCalls().filter(c => c[0] === 'rmi').map(c => c[c.length - 1]);
}

test('an image app is pruned by REPOSITORY, because the slug label the old filter wants is never on a pulled image', async () => {
  clearDockerCalls();
  setRules([
    {
      // Deliberately NOT in date order. `docker images` prints newest-first
      // today, so a listing that arrives pre-sorted would let a missing sort
      // pass — and the ordering of that output is Docker's choice, not a
      // contract this code is entitled to rely on.
      match: ['images', '--no-trunc'],
      stdout:
        `${IMG[2]} 2026-09-02 10:00:00 +0000 UTC\n` +
        `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` +
        `${IMG[3]} 2026-09-01 10:00:00 +0000 UTC\n` +
        `${IMG[1]} 2026-09-03 10:00:00 +0000 UTC\n`,
    },
    { match: ['ps', '-a'], stdout: '' },
  ]);

  await pruneOldImages(PULLED_APP.slug, 'production', 2);

  const call = imagesCall();
  assert.ok(call, `no repository-scoped \`docker images\` was issued at all — nothing reclaims a ` +
    `pulled image and the disk grows on every redeploy: ${JSON.stringify(dockerCalls())}`);
  assert.ok(call.includes('odoo'), `scoped to the wrong repository: ${JSON.stringify(call)}`);

  // Newest two kept, both older ones gone. Sorted by CreatedAt, not by the
  // order docker happened to print them in.
  assert.deepEqual(removed(), [IMG[2], IMG[3]]);
});

test('the label pass still deletes past keep — the pulled pass was added beside it, not in front of it', async () => {
  // The label pass used to `return` from inside pruneOldImages when its listing
  // came back empty. Bolting the pulled pass on after that return would have
  // skipped it for exactly the apps that need it, since an image app's label
  // filter always matches zero rows. Splitting the two is only correct if the
  // original one still does its job, which is what this asserts.
  clearDockerCalls();
  setRules([
    {
      match: ['images', '--filter'],
      stdout:
        `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` +
        `${IMG[1]} 2026-09-03 10:00:00 +0000 UTC\n` +
        `${IMG[2]} 2026-09-02 10:00:00 +0000 UTC\n`,
    },
    { match: ['ps', '-a'], stdout: '' },
  ]);

  await pruneOldImages(HTTP_APP.slug, 'production', 2);
  assert.deepEqual(removed(), [IMG[2]]);
  setRules();
});

test('a registry-qualified ref is scoped to registry/name, not to the bare name', async () => {
  // parseImageRef splits 'ghcr.io/acme/thing:1.2' into registry + name;
  // rejoining only the name would run `docker images acme/thing`, match nothing,
  // and silently reclaim zero bytes — a no-op that looks exactly like success.
  clearDockerCalls();
  setRules([
    { match: ['images', '--no-trunc'], stdout: '' },
    { match: ['ps', '-a'], stdout: '' },
  ]);
  await pruneOldImages(GHCR_APP.slug, 'production', 2);
  assert.ok(imagesCall()?.includes('ghcr.io/acme/thing'), JSON.stringify(imagesCall()));
});

test('an image referenced by ANY container, running or stopped, is never removed', async () => {
  // A repository is wider than one app: two apps on 'odoo:19' share image ids.
  // The in-use exclusion is the whole reason `rmi -f` is acceptable here, so it
  // is asserted rather than assumed.
  clearDockerCalls();
  setRules([
    {
      match: ['images', '--no-trunc'],
      stdout:
        `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` +
        `${IMG[1]} 2026-09-03 10:00:00 +0000 UTC\n` +
        `${IMG[2]} 2026-09-02 10:00:00 +0000 UTC\n` +
        `${IMG[3]} 2026-09-01 10:00:00 +0000 UTC\n`,
    },
    { match: ['ps', '-a'], stdout: `${IMG[3]}\n` },
  ]);

  await pruneOldImages(PULLED_APP.slug, 'production', 2);
  assert.deepEqual(removed(), [IMG[2]],
    `an image a container still references was deleted: ${JSON.stringify(removed())}`);
});

test('a multi-tagged image counts once, so `keep` retains the number of images it says', async () => {
  // `docker images <repo>` prints one row per TAG. Counting 'odoo:19' and
  // 'odoo:latest' as two would let keep=2 retain a single distinct image and
  // delete one it was told to keep.
  clearDockerCalls();
  setRules([
    {
      match: ['images', '--no-trunc'],
      stdout:
        `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` +
        `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` +
        `${IMG[1]} 2026-09-03 10:00:00 +0000 UTC\n` +
        `${IMG[2]} 2026-09-02 10:00:00 +0000 UTC\n`,
    },
    { match: ['ps', '-a'], stdout: '' },
  ]);

  await pruneOldImages(PULLED_APP.slug, 'production', 2);
  assert.deepEqual(removed(), [IMG[2]]);
});

test('a built app is untouched by the repository path — the label prune is still the whole story', async () => {
  // The regression guard for the 57 existing apps: a github/managed/upload app
  // must issue the label-filtered `docker images` and NOTHING else, or the new
  // path could start deleting images the label rule already governs.
  clearDockerCalls();
  setRules([
    { match: ['images', '--no-trunc'], stdout: `${IMG[0]} 2026-09-04 10:00:00 +0000 UTC\n` },
    { match: ['ps', '-a'], stdout: '' },
  ]);

  await pruneOldImages(HTTP_APP.slug, 'production', 2);
  assert.equal(imagesCall(), null,
    `a built app took the pulled-image path: ${JSON.stringify(dockerCalls())}`);
  const labelCall = dockerCalls().find(c => c[0] === 'images');
  assert.ok(labelCall?.includes(`label=slug=${HTTP_APP.slug}`), JSON.stringify(labelCall));
  assert.deepEqual(removed(), []);
});

test('an image app still gets the label prune too, so a formerly-built app keeps being cleaned', async () => {
  // source_type is editable. An app switched to 'image' still has AppCrane-built
  // images on disk from its previous life, and those are labelled — dropping the
  // label pass for image apps would strand them forever.
  clearDockerCalls();
  setRules([
    { match: ['images', '--no-trunc'], stdout: '' },
    { match: ['ps', '-a'], stdout: '' },
  ]);

  await pruneOldImages(PULLED_APP.slug, 'production', 2);
  const labelCall = dockerCalls().find(c => c[0] === 'images' && c.includes('--filter'));
  assert.ok(labelCall?.includes(`label=slug=${PULLED_APP.slug}`), JSON.stringify(dockerCalls()));
});

test('an unparseable image_ref reclaims nothing rather than throwing into the deploy path', async () => {
  // pruneOldImages is called without await from deployer.js AFTER the health
  // check passes. A rejection there is an unhandled rejection on a deploy that
  // has already succeeded.
  const bad = mkApp('cp-bad', { source_type: 'image', image_ref: 'Odoo:NOT VALID' });
  clearDockerCalls();
  setRules([{ match: ['ps', '-a'], stdout: '' }]);
  await pruneOldImages(bad.slug, 'production', 2);
  assert.deepEqual(removed(), []);
});
