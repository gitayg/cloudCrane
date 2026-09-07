import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Daily vulnerability digest (v2.52.0).
//
// The scan writes rows; this module is the only thing that puts them in front
// of a human. Three properties are load-bearing and each is pinned below:
//
//   1. Scope. An app owner gets their own apps and nothing else. The fleet view
//      names which OTHER apps are vulnerable — apps the owner may have no
//      access to — so leaking it to a non-admin is a disclosure, not a
//      convenience.
//   2. Silence on a clean fleet. A daily "nothing to report" is the fastest way
//      to teach people to filter the alert, and then the one that matters is
//      filtered too.
//   3. Exactly one mail per recipient per day. The scheduler ticks hourly and
//      the process restarts; both must be unable to re-send. enqueueEmail's own
//      dedupe cannot do this here — it is keyed on (app_id, idempotency_key)
//      and a digest spanning several apps has app_id NULL, where SQLite's
//      unique index treats every NULL as distinct.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-vuln-digest-'));
process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { buildDigest, sendVulnDigest, startVulnScheduler, stopVulnScheduler } =
  await import('../server/services/vulnDigest.js');
const { assertFindings } = await import('../server/services/scanShapes.js');

initDb();
const db = getDb();

// Migration 078 creates app_vuln_scans; this is here so the digest can still be
// exercised on a box where that migration has not run — the same guard the
// production path relies on.
db.exec(`CREATE TABLE IF NOT EXISTS app_vuln_scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env           TEXT    NOT NULL,
  scanned_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  source        TEXT    NOT NULL,
  ecosystem     TEXT,
  status        TEXT    NOT NULL,
  package_count INTEGER NOT NULL DEFAULT 0,
  findings_json TEXT,
  error         TEXT
)`);

let keySeq = 0;
function mkUser(name, email, role) {
  return db.prepare('INSERT INTO users (name, email, role, api_key_hash) VALUES (?,?,?,?)')
    .run(name, email, role, `hash-${++keySeq}`).lastInsertRowid;
}
let slotSeq = 100;
function mkApp(name, slug, ownerId) {
  return db.prepare('INSERT INTO apps (name, slug, slot, source_type, branch, created_by) VALUES (?,?,?,?,?,?)')
    .run(name, slug, ++slotSeq, 'managed', 'main', ownerId).lastInsertRowid;
}
// scanned_at is explicit and monotonic: fleetScanSummary picks the newest row
// per app+env, and two rows inserted in the same second would otherwise leave
// "the latest scan supersedes the old one" resting on the id tie-break alone.
let scanClock = 0;
function mkScan(appId, env, findings) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, ++scanClock)).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`INSERT INTO app_vuln_scans
      (app_id, env, scanned_at, source, ecosystem, status, package_count, findings_json)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(appId, env, at, 'scheduled', 'npm',
         findings.length ? 'findings' : 'ok', 42, JSON.stringify(findings)).lastInsertRowid;
}

const alice = mkUser('Alice', 'alice@example.com', 'user');
const bob   = mkUser('Bob',   'bob@example.com',   'user');
const carol = mkUser('Carol', 'carol@example.com', 'user');
const root  = mkUser('Root',  'root@example.com',  'platform_admin');

const billing   = mkApp('Billing',   'billing',   alice);
const intranet  = mkApp('Intranet',  'intranet',  bob);
const telemetry = mkApp('Telemetry', 'telemetry', carol);

// scanShapes.Finding, the shape appScan writes and this module asserts on the
// way in: { name, version, ecosystem, ids[], fixed }. Written out in full here
// rather than through a helper — the point of these fixtures is that they are
// the frozen shape, and a helper that filled in defaults would let a producer
// drop a field without a single test noticing.
mkScan(billing, 'production', [
  { name: 'lodash', version: '4.17.20', ecosystem: 'npm', ids: ['GHSA-lodash-1', 'GHSA-lodash-2'], fixed: '4.17.21' },
  { name: 'minimist', version: '1.2.0', ecosystem: 'npm', ids: ['GHSA-minimist-1'], fixed: null },
]);
mkScan(intranet, 'production', [
  { name: 'axios', version: '0.21.0', ecosystem: 'npm', ids: ['GHSA-axios-1'], fixed: '0.21.2' },
]);
// One app, three ecosystems, and two packages that share a name across two of
// them. Real: `yaml` is published on both npm and PyPI, at unrelated versions
// with unrelated advisories. This is the fixture that makes an unlabelled
// "yaml 1.10.0" line indefensible.
mkScan(telemetry, 'production', [
  { name: 'yaml', version: '1.10.0', ecosystem: 'npm', ids: ['GHSA-yaml-npm'], fixed: '1.10.2' },
  { name: 'yaml', version: '5.4', ecosystem: 'PyPI', ids: ['GHSA-yaml-pypi'], fixed: null },
  { name: 'golang.org/x/net', version: 'v0.17.0', ecosystem: 'Go', ids: ['GO-2024-1', 'GHSA-net-1'], fixed: 'v0.23.0' },
]);

// Local date, mirroring production. This was a UTC copy, which matched only
// while the two clocks happened to agree — it broke the moment the day key
// moved to local, which is the bug the change fixed.
const today = (() => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
})();
const queued = () => db.prepare('SELECT * FROM email_queue ORDER BY id').all();
const rowFor = (email) => queued().find(r => r.to_email === email);

test('an app owner is scoped to their own apps; a platform admin gets the fleet', () => {
  const { recipients } = buildDigest(db);
  const byEmail = new Map(recipients.map(r => [r.email, r]));

  assert.deepEqual([...byEmail.keys()].sort(),
    ['alice@example.com', 'bob@example.com', 'carol@example.com', 'root@example.com']);

  assert.equal(byEmail.get('root@example.com').scope, 'platform');
  assert.deepEqual(byEmail.get('root@example.com').apps.map(a => a.slug).sort(),
    ['billing', 'intranet', 'telemetry']);

  assert.equal(byEmail.get('alice@example.com').scope, 'owner');
  assert.deepEqual(byEmail.get('alice@example.com').apps.map(a => a.slug), ['billing']);
  assert.deepEqual(byEmail.get('bob@example.com').apps.map(a => a.slug), ['intranet']);
  assert.deepEqual(byEmail.get('carol@example.com').apps.map(a => a.slug), ['telemetry']);
});

test('the mail names the app, the package, the ecosystem, the advisory and the fix', () => {
  const res = sendVulnDigest(db);
  assert.equal(res.sent, 4);

  const a = rowFor('alice@example.com');
  assert.ok(a, 'owner digest was enqueued');
  assert.match(a.body_text, /Billing \(production\)/);
  // The whole line, not its pieces: the reader has to be able to go from this
  // one line to an upgrade without opening the dashboard.
  assert.equal(
    a.body_text.includes('  - lodash 4.17.20 (npm) — GHSA-lodash-1, GHSA-lodash-2 — fix: 4.17.21\n'),
    true,
    `expected the full finding line in:\n${a.body_text}`);
  // A finding OSV published no fix for says so on its own line. Omitting it
  // would be indistinguishable from "we did not check", and "we did not check"
  // is what gets a live advisory ignored.
  assert.equal(
    a.body_text.includes('  - minimist 1.2.0 (npm) — GHSA-minimist-1 — no fixed version published\n'),
    true,
    `expected the no-fix line in:\n${a.body_text}`);
  assert.match(a.body_html, /GHSA-minimist-1/);
  assert.match(a.body_html, /no fixed version published/);

  // Scope again, but on what actually landed in the queue: the owner's mail
  // must not name the other team's app or its advisory.
  assert.doesNotMatch(a.body_text, /Intranet|GHSA-axios-1/);
  assert.doesNotMatch(a.body_html, /Intranet|GHSA-axios-1/);

  const r = rowFor('root@example.com');
  assert.match(r.body_text, /Billing \(production\)/);
  assert.match(r.body_text, /Intranet \(production\)/);
  assert.match(r.body_text, /Telemetry \(production\)/);
  assert.match(r.body_text, /GHSA-axios-1/);

  assert.equal(a.idempotency_key, `vuln-digest:${today}:alice@example.com`);
  assert.equal(a.app_id, null);
  assert.equal(a.source, 'vuln-digest');
  assert.equal(a.status, 'queued');
});

test('one scan can mix ecosystems, and every line names its own', () => {
  const c = rowFor('carol@example.com');
  assert.ok(c, 'owner digest was enqueued');

  const lines = c.body_text.split('\n').filter(l => l.startsWith('  - '));
  assert.deepEqual(lines, [
    '  - yaml 1.10.0 (npm) — GHSA-yaml-npm — fix: 1.10.2',
    '  - yaml 5.4 (PyPI) — GHSA-yaml-pypi — no fixed version published',
    '  - golang.org/x/net v0.17.0 (Go) — GO-2024-1, GHSA-net-1 — fix: v0.23.0',
  ]);

  // Strip the ecosystem and the first two lines become "yaml <version>" twice —
  // two packages from two registries, with unrelated advisories and unrelated
  // fixes, distinguishable only by a version number the reader has no reason to
  // recognise. That ambiguity is why the label is per finding and not per scan.
  const withoutEcosystem = lines.map(l => l.replace(/ \([^)]+\) —/, ' —'));
  assert.match(withoutEcosystem[0], /^ {2}- yaml 1\.10\.0 —/);
  assert.match(withoutEcosystem[1], /^ {2}- yaml 5\.4 —/);

  assert.match(c.body_html, /PyPI/);
  assert.match(c.body_html, /golang\.org\/x\/net/);
  // Scope holds across ecosystems too.
  assert.doesNotMatch(c.body_text, /Billing|Intranet|GHSA-lodash-1|GHSA-axios-1/);
});

test('the findings the digest carries satisfy the frozen shape', () => {
  const { recipients } = buildDigest(db);
  assert.ok(recipients.length > 0);
  let n = 0;
  for (const r of recipients) {
    for (const app of r.apps) {
      // assertFindings, not a hand-written field check: the asserter is the
      // contract, so a change to it has to be answered here rather than in a
      // duplicate of it that quietly went stale.
      assertFindings(app.findings, `${r.email} ${app.slug}/${app.env}`);
      n += app.findings.length;
    }
  }
  assert.equal(n, 12, 'every finding on every recipient was checked');
});

test('a second run the same day enqueues nothing more', () => {
  const before = queued().length;
  const res = sendVulnDigest(db);
  assert.deepEqual(res, { sent: 0, skipped: 4 });
  assert.equal(queued().length, before);
});

test('a newer clean scan supersedes the old finding and nobody is mailed', () => {
  mkScan(billing, 'production', []);
  mkScan(intranet, 'production', []);
  mkScan(telemetry, 'production', []);

  assert.deepEqual(buildDigest(db), { recipients: [] });

  const before = queued().length;
  assert.deepEqual(sendVulnDigest(db), { sent: 0, skipped: 0 });
  assert.equal(queued().length, before);
});

test('a producer that reshapes a finding fails here, loudly, instead of mailing "undefined"', () => {
  // v2.52.0's near-miss, replayed: the scanner wrote { name, version, ids } and
  // the digest's brief said { package, id, fixed_version }. The mail rendered
  // only because this file read `f.name ?? f.package`. A defensive read makes a
  // broken contract look like a working feature that happens to say less, and a
  // finding nobody reads is indistinguishable from no finding at all.
  mkScan(billing, 'production', [
    { package: 'lodash', version: '4.17.20', id: 'GHSA-lodash-1', fixed_version: '4.17.21' },
  ]);
  assert.throws(() => buildDigest(db), (e) => {
    assert.match(e.message, /billing\/production/, 'the error names the scan that broke the shape');
    assert.match(e.message, /name must be a non-empty string/);
    return true;
  });

  // Same for a finding that is right in every field but the new one. An
  // ecosystem-less finding used to render fine; now it cannot reach an inbox.
  mkScan(billing, 'production', [
    { name: 'lodash', version: '4.17.20', ids: ['GHSA-lodash-1'], fixed: '4.17.21' },
  ]);
  assert.throws(() => buildDigest(db), /ecosystem must be a non-empty string/);

  // And a null `fixed` that is merely absent. The shape spells the difference:
  // null means OSV published no fix, missing means nobody decided.
  mkScan(billing, 'production', [
    { name: 'lodash', version: '4.17.20', ecosystem: 'npm', ids: ['GHSA-lodash-1'] },
  ]);
  assert.throws(() => buildDigest(db), /fixed must be a non-empty string or null/);

  mkScan(billing, 'production', []);
  assert.deepEqual(buildDigest(db), { recipients: [] });
});

test('a missing app_vuln_scans table reports nothing rather than throwing', () => {
  db.exec('DROP TABLE app_vuln_scans');
  assert.deepEqual(buildDigest(db), { recipients: [] });
  assert.deepEqual(sendVulnDigest(db), { sent: 0, skipped: 0 });
});

test('the scheduler claims the day before scanning, and only once', async () => {
  const lastRun = () => db.prepare("SELECT value FROM settings WHERE key = 'vuln_scan_last_run'").get()?.value;
  // Hour 0 is what makes this test independent of the wall clock, and it only
  // works because the gate range-checks the setting. `parseInt(x, 10) || 6`
  // read midnight as 06:00 — measured at 03:10 local, the tick returned early
  // and this test failed; the same suite passed under TZ=Europe/Berlin an hour
  // later. That is both a flaky test and an admin's midnight digest silently
  // moving to breakfast.
  db.prepare("INSERT INTO settings (key, value) VALUES ('vuln_scan_hour','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();

  startVulnScheduler();
  // Claimed synchronously, before the scan is awaited — a fleet scan can
  // outlast the hourly interval, and a last-run written afterwards would let
  // the next tick start a second concurrent pass.
  assert.equal(lastRun(), today);
  await new Promise(r => setImmediate(r));
  stopVulnScheduler();

  db.prepare("UPDATE settings SET value = '2000-01-01' WHERE key = 'vuln_scan_last_run'").run();
  startVulnScheduler();
  assert.equal(lastRun(), today, 'a new date re-arms the daily run');
  await new Promise(r => setImmediate(r));
  stopVulnScheduler();
});

after(() => { stopVulnScheduler(); db.close(); });

// ---------------------------------------------------------------------------
// The day key and the hour gate must share one clock (found in review)
// ---------------------------------------------------------------------------
//
// The gate was `lastRun === today() || new Date().getHours() < hour`, where
// today() returned a UTC date and getHours() is local. Measured with a 30-hour
// tick walk: a scheduler arming mid-morning in a timezone BEHIND UTC fired at
// local 08:00 and again at local 17:00 when the UTC key rolled — two full fleet
// scans and two duplicate digests to every recipient. Steady state was one per
// day, so it only appeared on the first day after a start, restart or reset.
//
// Run in a child process because TZ must be set before the process starts.

test('today() returns the LOCAL date, matching the clock the hour gate uses', () => {
  const probe = `
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const local = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    import('${new URL('../server/services/vulnDigest.js', import.meta.url).pathname}')
      .then((m) => { console.log(JSON.stringify({ key: m.today(), local, utc: d.toISOString().slice(0, 10) })); });
  `;
  // A fixed list of zones only disagrees with UTC during part of the day.
  // Measured at 07:11 UTC: Los_Angeles, Auckland, Tokyo and UTC were ALL on
  // 2026-08-26, the same date `toISOString().slice(0, 10)` returns — so
  // reverting today() to the UTC form left this test green. A test that only
  // catches the bug during some hours is not evidence of the fix.
  //
  // So the zone that is straddling UTC midnight RIGHT NOW is computed and
  // probed too. Neither of these observes DST, so the offsets are constant:
  // Midway is -11, which is on the previous UTC date whenever the UTC hour is
  // under 11; Kiritimati is +14, which is on the next one from 11 onward.
  // Between them every hour of the day is covered.
  const straddler = new Date().getUTCHours() < 11 ? 'Pacific/Midway' : 'Pacific/Kiritimati';

  let discriminating = 0;
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'Asia/Tokyo', 'UTC', straddler]) {
    const out = execFileSync(process.execPath, ['-e', probe], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8',
    });
    const { key, local, utc } = JSON.parse(out.trim().split('\n').pop());
    if (local !== utc) discriminating++;
    assert.equal(key, local,
      `in ${tz} the day key was ${key} while the local date was ${local} (UTC ${utc}) — the key and ` +
      'the hour gate are reading different clocks, which re-arms the scheduler mid-local-day and ' +
      'sends every recipient a second digest');
  }

  // Without this the assertions above can all pass while proving nothing, which
  // is exactly what happened before the straddler was added.
  assert.ok(discriminating > 0,
    `no probed timezone was on a different date from UTC, so a UTC day key would have passed ` +
    `every assertion above (straddler was ${straddler}, UTC hour ${new Date().getUTCHours()})`);
});

// ---------------------------------------------------------------------------
// Owner attribution in the fleet digest (v2.59.0)
// ---------------------------------------------------------------------------
//
// The platform digest lists apps the reader does not own. "telemetry has 3
// vulnerable packages" leaves an admin holding a finding and no idea who to
// tell — a lookup sitting between the alert and anyone acting on it.
//
// Named ONLY in the fleet mail. An owner's scoped digest already covers exactly
// their apps, so repeating their own address back at them reads as a bug. And
// property 1 at the top of this file is why the fix is "name the owner in the
// admin's mail" rather than "copy the owner on it": the fleet view discloses
// which OTHER apps are vulnerable.
//
// These seed their own fixtures. Earlier tests in this file clear scans to
// assert the clean-fleet silence, so the module-level fixtures are gone by here.

function seedOwnerFixture() {
  // An earlier test drops this table to exercise the missing-migration guard,
  // so recreate it rather than depend on the module-level fixture surviving.
  db.exec(`CREATE TABLE IF NOT EXISTS app_vuln_scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env           TEXT    NOT NULL,
  scanned_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  source        TEXT    NOT NULL,
  ecosystem     TEXT,
  status        TEXT    NOT NULL,
  package_count INTEGER NOT NULL DEFAULT 0,
  findings_json TEXT,
  error         TEXT
)`);
  const admin = mkUser('Root Two', 'root2@x.io', 'platform_admin');
  const dana = mkUser('Dana Owner', 'dana@x.io', 'user');
  const mine = mkApp('Dana App', 'dana-app', dana);
  const other = mkApp('Other App', 'other-app', admin);
  const f = [{ name: 'lodash', version: '4.17.15', ecosystem: 'npm', ids: ['GHSA-own'], fixed: '4.17.21' }];
  mkScan(mine, 'production', f);
  mkScan(other, 'production', f);
  return { admin, dana };
}

test('buildDigest resolves the owner name and email, not just the id', () => {
  seedOwnerFixture();
  const fleet = buildDigest(db).recipients.find((r) => r.email === 'root2@x.io');
  assert.ok(fleet, 'the platform admin should receive a fleet digest');
  const mine = fleet.apps.find((a) => a.slug === 'dana-app');
  assert.equal(mine.ownerName, 'Dana Owner');
  assert.equal(mine.ownerEmail, 'dana@x.io');
});

test('the fleet mail names who owns each app; the owner mail does not', () => {
  sendVulnDigest(db);

  const admin = rowFor('root2@x.io');
  assert.ok(admin, 'the platform admin digest was enqueued');
  assert.match(admin.body_text, /owner: Dana Owner <dana@x\.io>/,
    'an admin has to be able to tell who to chase without a second lookup');
  assert.match(admin.body_html, /owner: Dana Owner/);

  const owner = rowFor('dana@x.io');
  assert.ok(owner, 'the owner digest was enqueued');
  assert.doesNotMatch(owner.body_text, /owner:/,
    'her mail covers exactly her apps; naming her as owner of each reads as a rendering bug');
});

test('owner attribution did not widen an owner mail into the fleet view', () => {
  // Property 1. This is the reason the change names the owner rather than
  // copying them onto the admin's mail.
  const owner = rowFor('dana@x.io');
  assert.doesNotMatch(owner.body_text, /Other App|other-app/,
    'an owner must not learn which other apps are vulnerable');
});

test('an app with no recorded owner reports null rather than a blank name', () => {
  const orphan = mkApp('Orphan', 'orphan-app', null);
  mkScan(orphan, 'production', [
    { name: 'lodash', version: '4.17.15', ecosystem: 'npm', ids: ['GHSA-orphan'], fixed: null },
  ]);
  const fleet = buildDigest(db).recipients.find((r) => r.email === 'root2@x.io');
  const app = fleet.apps.find((a) => a.slug === 'orphan-app');
  assert.ok(app, 'the orphan app should still appear in the fleet digest');
  assert.equal(app.ownerId, null);
  assert.equal(app.ownerName, null);
});
