import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'node:http';

// Deploying a prebuilt image, and — the part that is actually load-bearing —
// getting back off one.
//
// Three failure modes are covered, each of which the deployer had before this
// change:
//
// 1. THE TAG FLOATS. `docker pull odoo:19` then `docker run odoo:19` are two
//    separate resolutions of a moving pointer. Recording the digest observed
//    between them, while starting the tag, records a claim the container does
//    not have to honour. The digest is resolved once and the DIGEST is what
//    runs — asserted off the real argv, not off the deployment row, because the
//    row is exactly the thing that would lie.
//
// 2. THE RELEASE-DIRECTORY CHAIN. deployApp's source resolution assumed a tree
//    of files: an icon under public/, a deployhub.json, a package.json, a dist
//    consistency check, a generated Dockerfile, and a `current` symlink whose
//    target it verified by demanding a package.json or deployhub.json inside
//    it. A pulled odoo:19 has none of those on the host, so a HEALTHY container
//    would have failed the deploy on the symlink verification.
//
// 3. NO WAY BACK. rollbackApp hard-fails on `if (!target.release_path)` and
//    promoteApp copies a release tree. An image deploy writes neither, so an
//    image app could be deployed and never rolled back or promoted. That is the
//    most valuable assertion in this file: a deploy platform can ship a missing
//    feature, but not a one-way door.
//
// Everything is measured off a recording `docker` shim (the pattern in
// test/container-port.test.js and test/docker-resource-flags.test.js) plus a
// real HTTP server standing in for the container's health endpoint, so the
// whole deploy runs green without a daemon and without pulling ~2 GB of odoo.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-image-deploy-'));
process.env.ENCRYPTION_KEY = 'd'.repeat(64);
process.env.LOG_LEVEL = 'error';

// ---------------------------------------------------------------------------
// A `docker` that records its argv and answers from a scriptable rule table
// ---------------------------------------------------------------------------

const SHIM_DIR = join(process.env.DATA_DIR, 'bin');
const ARGV_LOG = join(process.env.DATA_DIR, 'docker-argv.log');
const RULES = join(process.env.DATA_DIR, 'docker-rules.json');
mkdirSync(SHIM_DIR, { recursive: true });

// CommonJS on purpose: the file is named `docker` with no extension, so Node
// parses it as CJS and an `import` here would be a syntax error at spawn time —
// surfacing as an unexplained docker failure rather than as a test error.
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
  '    process.stderr.write(r.stderr || "");\n' +
  '    process.exit(r.code || 0);\n' +
  '  }\n' +
  '}\n' +
  'process.stdout.write("0123456789abcdef\\n");\n',
  { mode: 0o755 },
);
process.env.CRANE_TEST_DOCKER_LOG = ARGV_LOG;
process.env.CRANE_TEST_DOCKER_RULES = RULES;
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;

// Two digests for the SAME tag. 'odoo:19' resolving to different bytes on two
// different days is not a corner case — it is what a tag is for, and it is the
// only way to prove the deployer records what it ran rather than what it asked
// for.
const DIGEST_A = `sha256:${'a1'.repeat(32)}`;
const DIGEST_B = `sha256:${'b2'.repeat(32)}`;

let currentDigest = DIGEST_A;

function setRules() {
  writeFileSync(RULES, JSON.stringify([
    // resolveDigest: `docker image inspect <ref> --format {{index .RepoDigests 0}}`.
    //
    // A DIGEST ref inspects to itself — that is what pinning means, and getting
    // this wrong in the shim would hide the bug the promote test exists to
    // catch: a shim that answered `currentDigest` for every ref would make a
    // correct re-resolution of a pinned ref look like a re-resolution of the
    // tag. Ordered first because the rule table is first-match-wins.
    { match: ['image', 'inspect', `odoo@${DIGEST_A}`], stdout: `odoo@${DIGEST_A}\n` },
    { match: ['image', 'inspect', `odoo@${DIGEST_B}`], stdout: `odoo@${DIGEST_B}\n` },
    // The TAG resolves to whatever it points at right now, which is the whole
    // reason a deploy has to record the digest.
    { match: ['image', 'inspect'], stdout: `odoo@${currentDigest}\n` },
    // ensureAppNetwork's inspect — answered so startApp reads a healthy
    // isolated network instead of warning about connectivity on every start.
    { match: ['network', 'inspect'], stdout: 'false|172.20.0.0/16\n' },
    { match: ['images', '--filter'], stdout: '' },
  ]));
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
/** The single `docker run` argv since the last clear. */
function runArgs() {
  const runs = dockerCalls().filter(c => c[0] === 'run');
  assert.equal(runs.length, 1, `expected exactly one \`docker run\`, saw ${runs.length}`);
  return runs[0];
}
/** `docker run`'s image argument: the last token before the trailing CMD, i.e.
 *  the first token that is not a flag and not a flag's value. Located by
 *  scanning rather than by index, because the flag list ahead of it changes. */
function runImage(args) {
  // Every flag startApp emits either stands alone or takes exactly one value.
  const STANDALONE = new Set(['run', '-d']);
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (STANDALONE.has(tok)) { i += 1; continue; }
    if (tok.startsWith('-')) { i += tok.includes('=') ? 1 : 2; continue; }
    return tok;
  }
  return null;
}

const logger = (await import('../server/utils/logger.js')).default;
for (const lvl of ['warn', 'info', 'debug']) logger[lvl] = () => {};

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const { initDb, getDb } = await import('../server/db.js');
initDb();
const db = getDb();

const { deployApp, rollbackApp, promoteApp } = await import('../server/services/deployer.js');
const { getPortsForSlot } = await import('../server/services/portAllocator.js');
const { isArtifactHash } = await import('../server/services/artifactDigest.js');

const HEALTH_PATH = '/web/health';

let userId;
let app;

// The container's health endpoint, for real, over a real socket. deployApp's
// gate is not stubbed: an image deploy that cannot pass a health check is not a
// deploy, and a test that skipped the gate would not notice the deployer
// probing the wrong path.
const healthHits = [];
const healthServers = [];
function startHealthServer(port) {
  return new Promise((res) => {
    const s = http.createServer((req, out) => {
      healthHits.push(req.url);
      out.writeHead(200, { 'content-type': 'application/json' });
      out.end(JSON.stringify({ status: 'ok', version: '19' }));
    });
    s.on('error', () => res(null));
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

// The slot is SEARCHED FOR, not hardcoded. deployApp derives the host port from
// apps.slot, so the health server has to bind the exact port the slot implies —
// which means a hardcoded slot fails with EADDRINUSE whenever anything else on
// the machine holds that port, including a second run of this suite. That is a
// test that fails for a reason unrelated to what it covers.
let SLOT = null;
let PORTS = null;
for (let slot = 12345; slot < 12445 && SLOT === null; slot++) {
  const ports = getPortsForSlot(slot);
  const sand = await startHealthServer(ports.sand_be);
  if (!sand) continue;
  const prod = await startHealthServer(ports.prod_be);
  if (!prod) { sand.close(); continue; }
  SLOT = slot;
  PORTS = ports;
  healthServers.push(sand, prod);
}
assert.ok(SLOT !== null, 'could not find a slot whose sandbox and production ports are both free');

before(async () => {
  // api_key_hash is NOT NULL on users; the value is never authenticated
  // against here — nothing in this file goes through an HTTP route.
  userId = db.prepare(
    "INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES ('U','img@x.io','platform_admin','unused',1,'human')"
  ).run().lastInsertRowid;
  db.prepare(
    'INSERT INTO apps (name,slug,slot,source_type,image_ref,container_port,health_path) ' +
    "VALUES ('Odoo','odoo-app',?,'image','odoo:19',8069,?)"
  ).run(SLOT, HEALTH_PATH);
  app = db.prepare("SELECT * FROM apps WHERE slug = 'odoo-app'").get();
});

after(() => {
  for (const s of healthServers) { s.closeAllConnections?.(); s.unref(); s.close(); }
});

function newDeployment(env = 'sandbox') {
  return db.prepare(
    "INSERT INTO deployments (app_id, env, status, deployed_by) VALUES (?, ?, 'pending', ?)"
  ).run(app.id, env, userId).lastInsertRowid;
}
const rowFor = (id) => db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);

async function deploy(env = 'sandbox', opts = {}) {
  clearDockerCalls();
  const id = newDeployment(env);
  const ports = env === 'production' ? PORTS : PORTS;
  await deployApp(id, app, env, ports, opts);
  return id;
}

// ===========================================================================
// The tag is resolved once, and the DIGEST is what runs
// ===========================================================================

test('an image deploy pulls the tag, resolves it, and starts the digest — not the tag', async () => {
  const id = await deploy();
  const args = runArgs();

  const pinned = `odoo@${DIGEST_A}`;
  assert.equal(runImage(args), pinned,
    'the container must be started FROM THE DIGEST. Starting the tag while recording the digest ' +
    'makes deployments.image_ref a claim the run does not have to honour — the publisher can move ' +
    `the tag between the inspect and the run. argv: ${JSON.stringify(args)}`);
  assert.ok(!args.includes('odoo:19'),
    `the floating tag must not appear anywhere in the run argv: ${JSON.stringify(args)}`);

  const pulls = dockerCalls().filter(c => c[0] === 'pull');
  assert.deepEqual(pulls, [['pull', 'odoo:19']],
    'the PULL is by tag — that is how a patch release is picked up. Only the run is pinned.');

  const row = rowFor(id);
  assert.equal(row.status, 'live', row.log);
  assert.equal(row.image_ref, pinned, 'deployments.image_ref records the digest-pinned ref that ran');
  assert.equal(row.commit_hash, DIGEST_A);
  assert.ok(isArtifactHash(row.commit_hash),
    "commit_hash must be the shape services/artifactDigest.js recognises, or an image deploy reads " +
    "as having no provenance at all — the same 'unknown' hole uploads had before v2.53.0");
});

test('nothing is built: no docker build, and no Dockerfile is generated anywhere', async () => {
  await deploy();
  const builds = dockerCalls().filter(c => c[0] === 'build');
  assert.equal(builds.length, 0, `an image deploy must not build: ${JSON.stringify(builds)}`);
});

test('release_path stays NULL and no `current` symlink is created', async () => {
  const id = await deploy();
  const row = rowFor(id);
  assert.equal(row.release_path, null,
    'there is no release directory. A path recorded here would name a directory that does not exist, ' +
    'and rollbackApp reads this column to decide whether a deploy is recoverable.');

  const currentLink = join(process.env.DATA_DIR, 'apps', app.slug, 'sandbox', 'current');
  assert.ok(!existsSync(currentLink),
    'the symlink block also VERIFIES its target holds a package.json or deployhub.json — a statement ' +
    'about a source tree. A healthy odoo container would have failed the deploy on that line.');
});

test('the health probe uses apps.health_path, not the /api/health an AppCrane build would serve', async () => {
  healthHits.length = 0;
  await deploy();
  assert.ok(healthHits.includes(HEALTH_PATH), `probed: ${JSON.stringify(healthHits)}`);
  assert.ok(!healthHits.includes('/api/health'),
    'a stock image does not serve /api/health; probing it 404s and marks a working container unhealthy');
});

test('the deploy log states the resolution, so an operator does not need a DB query', async () => {
  const id = await deploy();
  const { log } = rowFor(id);
  assert.match(log, /Pulling image odoo:19/);
  assert.match(log, new RegExp(`Resolved odoo:19 . odoo@${DIGEST_A}`),
    `the tag→digest step is the one an operator has to be able to audit. log:\n${log}`);
});

// ===========================================================================
// A moving tag produces two distinguishable deployments
// ===========================================================================

test('two deploys of one tag, three months apart, are not the same deployment', async () => {
  currentDigest = DIGEST_A; setRules();
  const first = await deploy();

  currentDigest = DIGEST_B; setRules();
  const second = await deploy();
  const args = runArgs();

  assert.equal(runImage(args), `odoo@${DIGEST_B}`, 'the second run must use the digest the tag points at NOW');
  assert.notEqual(rowFor(first).image_ref, rowFor(second).image_ref,
    'recording only the tag would make these two rows identical, which defeats the point of recording anything');
  assert.notEqual(rowFor(first).commit_hash, rowFor(second).commit_hash);

  currentDigest = DIGEST_A; setRules();
});

// ===========================================================================
// source_type='image' wins over the release-directory chain
// ===========================================================================

test('a pre-extracted directory does not divert an image app into the tree path', async () => {
  // rollbackApp and promoteApp both pass preExtractedDir for tree-based apps.
  // If the image branch came second in the chain, an image app reaching either
  // of those paths would be built from a directory instead of pulled — and the
  // directory here is a valid Node app, so the tree path would SUCCEED and the
  // wrong bytes would ship.
  const decoy = join(process.env.DATA_DIR, 'apps', app.slug, 'sandbox', 'releases', '1-decoy');
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'package.json'), JSON.stringify({ name: 'decoy', version: '9.9.9' }));

  const id = await deploy('sandbox', { preExtractedDir: decoy });
  const args = runArgs();

  assert.equal(runImage(args), `odoo@${DIGEST_A}`, JSON.stringify(args));
  assert.equal(dockerCalls().filter(c => c[0] === 'build').length, 0);
  assert.notEqual(rowFor(id).version, '9.9.9',
    "the decoy's package.json must not have been read — an image app has no package.json");
});

// ===========================================================================
// Rollback: the part that makes an image deploy a door rather than a trapdoor
// ===========================================================================

test('rollback restores the exact digest the target deployment ran', async () => {
  currentDigest = DIGEST_A; setRules();
  // deployments.started_at has second resolution, so every row written by the
  // tests above ties with these two on the ORDER BY that picks the default
  // rollback target. Aged explicitly rather than left to the clock, so this is
  // not a coin flip: everything before is -2h, the target is -1h, and the
  // deploy being rolled back is now.
  db.prepare("UPDATE deployments SET started_at = datetime('now','-2 hours') WHERE app_id = ?").run(app.id);
  const oldId = await deploy();
  db.prepare("UPDATE deployments SET started_at = datetime('now','-1 hour') WHERE id = ?").run(oldId);

  currentDigest = DIGEST_B; setRules();
  const newId = await deploy();
  assert.equal(rowFor(newId).image_ref, `odoo@${DIGEST_B}`);

  // The operator's request has moved on with the tag; the rollback must not
  // follow it. Deliberately left pointing at DIGEST_B's world.
  clearDockerCalls();
  const result = await rollbackApp(app, 'sandbox', undefined, userId);

  assert.equal(result.rollback_to, oldId, 'the previous live deployment is the default target');
  const restored = rowFor(result.deployment_id);
  assert.equal(restored.image_ref, `odoo@${DIGEST_A}`,
    'rollback re-runs the digest RECORDED against the target, not whatever apps.image_ref resolves to ' +
    'today. Re-resolving the tag would "roll back" to bytes that have never run here.');
  assert.equal(restored.commit_hash, DIGEST_A);
  assert.equal(restored.status, 'live', restored.log);
  assert.equal(restored.release_path, null);
  assert.equal(runImage(runArgs()), `odoo@${DIGEST_A}`);

  assert.equal(rowFor(newId).status, 'rolled_back');
  currentDigest = DIGEST_A; setRules();
});

test('rollback does NOT fail with NO_RELEASE_PATH — the check an image deploy can never satisfy', async () => {
  // The whole point. Before the image branch, `if (!target.release_path)` threw
  // 409 NO_RELEASE_PATH for every image deployment ever made, because an image
  // deploy writes no release directory. An app that can be deployed and not
  // recovered is worse than one that cannot be deployed.
  const target = db.prepare(
    "SELECT * FROM deployments WHERE app_id = ? AND env = 'sandbox' AND image_ref IS NOT NULL " +
    "AND status IN ('live','rolled_back') ORDER BY id DESC LIMIT 1"
  ).get(app.id);
  assert.ok(target, 'fixture: need a completed image deployment to roll back to');
  assert.equal(target.release_path, null, 'fixture: and it must have no release_path, which is the point');

  const result = await rollbackApp(app, 'sandbox', target.id, userId);
  assert.equal(rowFor(result.deployment_id).image_ref, target.image_ref);
});

test('rollback to a deployment with no image_ref recorded says so instead of NO_RELEASE_PATH', async () => {
  const orphan = db.prepare(
    "INSERT INTO deployments (app_id, env, status, deployed_by, version) VALUES (?, 'sandbox', 'live', ?, '0.0.1')"
  ).run(app.id, userId).lastInsertRowid;

  await assert.rejects(
    () => rollbackApp(app, 'sandbox', orphan, userId),
    (e) => {
      assert.equal(e.code, 'NO_IMAGE_REF',
        `an image app must not be told its problem is a missing release_path — it never has one. Got ${e.code}`);
      return true;
    },
  );
  db.prepare('DELETE FROM deployments WHERE id = ?').run(orphan);
});

// ===========================================================================
// Promote
// ===========================================================================

test('promote ships the exact digest sandbox ran, with no rebuild', async () => {
  currentDigest = DIGEST_A; setRules();
  await deploy('sandbox');
  const sandbox = db.prepare(
    "SELECT * FROM deployments WHERE app_id = ? AND env = 'sandbox' AND status = 'live' ORDER BY started_at DESC LIMIT 1"
  ).get(app.id);

  // The tag moves between the sandbox test and the promote. Promotion must ship
  // what was TESTED, so this must not appear in production.
  currentDigest = DIGEST_B; setRules();
  clearDockerCalls();

  const res = await promoteApp(app, userId);
  assert.equal(res.mode, 'image');
  assert.equal(res.image_ref, sandbox.image_ref);

  // promoteApp is fire-and-forget (an awaited deployApp outlives the MCP socket
  // timeout), so the production row is polled rather than read once.
  const deadline = Date.now() + 20000;
  let prod;
  do {
    prod = rowFor(res.deployment_id);
    if (prod.status === 'live' || prod.status === 'failed') break;
    await new Promise(r => setTimeout(r, 25));
  } while (Date.now() < deadline);

  assert.equal(prod.status, 'live', prod.log);
  assert.equal(prod.image_ref, `odoo@${DIGEST_A}`,
    'promote must not re-resolve the tag — the bytes tested in sandbox are the bytes promoted');
  assert.equal(prod.release_path, null);
  assert.equal(dockerCalls().filter(c => c[0] === 'build').length, 0);

  currentDigest = DIGEST_A; setRules();
});

// ===========================================================================
// Misconfiguration
// ===========================================================================

test("source_type='image' with no image_ref fails with an actionable message", async () => {
  db.prepare("INSERT INTO apps (name,slug,slot,source_type) VALUES ('Bare','bare-image',?,'image')").run(SLOT + 500);
  const bare = db.prepare("SELECT * FROM apps WHERE slug = 'bare-image'").get();
  const id = db.prepare(
    "INSERT INTO deployments (app_id, env, status, deployed_by) VALUES (?, 'sandbox', 'pending', ?)"
  ).run(bare.id, userId).lastInsertRowid;

  await assert.rejects(
    () => deployApp(id, bare, 'sandbox', getPortsForSlot(SLOT + 500), {}),
    /source_type='image' but no image_ref set/,
    'the pre-image message — "not deployable on this AppCrane install" — was false and pointed at the wrong fix',
  );
  assert.equal(rowFor(id).status, 'failed');
});
