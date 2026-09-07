import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// v2.44.0 — the four controls that turn "the platform records it" into "a human
// is told, and abuse stops".
//
// Everything here is downstream of one environment fact: AppCrane sits behind
// SDP, so the reachable population is not the internet — it is every device and
// person inside the perimeter. That is what makes each of these worth a control
// rather than a shrug:
//
//   1. SECRET REVEAL WAS SILENT. v2.42.1 added the `env-reveal` audit row, and
//      the MCP door already wrote `secret-reveal`. So the record existed — which
//      is forensics, not detection: you learn who copied the keys only once you
//      already know to go looking. The notice is the "new sign-in on your
//      account" mail, and its entire value is that it reaches a person unasked.
//   2. NOTHING BOUNDED THE REVEAL RATE. One lifted session could walk every key
//      of every app it touched as fast as HTTP allows.
//   3. AN APP CHOSE ITS OWN From DISPLAY NAME on a real corporate mailbox, and
//      the only record of which app really sent it was a DB column nobody reads.
//      Recipients are bounded to registered users, so this is not an open relay
//      — it is targeted spoofing at colleagues, which is a better phish than a
//      stranger's mail, not a worse one.
//   4. /data IS A PLAIN BIND MOUNT. No --storage-opt, no project quota: the
//      "tenant quota" the deployer injects binds only an app that chooses to
//      honour it, so one app's runaway write fills a SHARED host filesystem and
//      takes every other app on the box down with it.
//
// The tests drive the real route handlers, the real queue worker and the real
// health-checker timer against a real SQLite database and a real SMTP
// conversation, because three of the four claims are about what a human
// RECEIVES. Asserting that a function was called proves the mail was composed;
// only reading it off the wire proves it was sent, addressed to the right people
// and carrying the attribution.

// ── A real (tiny) SMTP server ────────────────────────────────────────────────
//
// Not a stub of sendEmail. The attribution requirement is specifically that it
// survives into the RENDERED message and not just the email_queue row, and a
// spy on sendEmail() cannot tell those apart — it sees the arguments, never the
// bytes. This speaks enough of RFC 5321 for nodemailer to complete a
// transaction, and keeps the envelope and the DATA payload verbatim.

const inbox = [];

const smtp = net.createServer((sock) => {
  let buf = '';
  let inData = false;
  let data = '';
  let envelope = { from: null, to: [] };

  sock.write('220 fake.appcrane.test ESMTP\r\n');
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          inbox.push({ raw: data, envelope });
          data = '';
          envelope = { from: null, to: [] };
          sock.write('250 2.0.0 Ok: queued\r\n');
        } else {
          // Dot-stuffing (RFC 5321 4.5.2).
          data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        }
        continue;
      }

      const cmd = line.split(/[ :]/)[0].toUpperCase();
      const addr = line.match(/<([^>]*)>/)?.[1];
      if (cmd === 'EHLO' || cmd === 'HELO') {
        // No AUTH advertised on purpose: nodemailer only attempts a login when
        // the server offers one, and SMTP_USER/SMTP_PASS are unset here.
        sock.write('250-fake.appcrane.test\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
      } else if (cmd === 'MAIL') {
        envelope.from = addr; sock.write('250 2.1.0 Ok\r\n');
      } else if (cmd === 'RCPT') {
        envelope.to.push(addr); sock.write('250 2.1.5 Ok\r\n');
      } else if (cmd === 'DATA') {
        inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd === 'RSET' || cmd === 'NOOP') {
        envelope = { from: null, to: [] }; sock.write('250 2.0.0 Ok\r\n');
      } else if (cmd === 'QUIT') {
        sock.write('221 2.0.0 Bye\r\n'); sock.end();
      } else {
        sock.write('502 5.5.2 Not implemented\r\n');
      }
    }
  });
});

await new Promise((res) => smtp.listen(0, '127.0.0.1', res));
const SMTP_PORT = smtp.address().port;

// Set before anything imports/creates the transport — emailService caches it on
// first send.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(SMTP_PORT);
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.GRAPH_TENANT_ID;
delete process.env.GRAPH_CLIENT_ID;
delete process.env.GRAPH_CLIENT_SECRET;

const DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-secrets-notify-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { hashApiKey, encrypt } = await import('../server/services/encryption.js');
const { errorHandler } = await import('../server/utils/errors.js');
const { logAudit } = await import('../server/middleware/audit.js');
const { issueServiceToken } = await import('../server/services/appServiceToken.js');
const { enqueueEmail, startEmailWorker, stopEmailWorker } = await import('../server/services/emailQueue.js');
const { startHealthChecker, stopHealthChecker } = await import('../server/services/healthChecker.js');

const envVarsRoutes = (await import('../server/routes/envVars.js')).default;
const serviceApiRoutes = (await import('../server/routes/serviceApi.js')).default;

initDb();
const db = getDb();

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mkApp = (name, slug, slot) => db.prepare(
  "INSERT INTO apps (name,slug,slot,source_type,branch) VALUES (?,?,?,'managed','main')"
).run(name, slug, slot).lastInsertRowid;

// api_key_hash is NOT NULL, so users who never make a request still get one —
// derived from their email so it is unique and never collides with a real key.
const mkUser = (name, email, role, key) => db.prepare(
  'INSERT INTO users (name,email,role,active,api_key_hash) VALUES (?,?,?,1,?)'
).run(name, email, role, hashApiKey(key || `no-api-key-for-${email}`)).lastInsertRowid;

const assign = (appId, userId, appRole) => {
  db.prepare('INSERT OR IGNORE INTO app_users (app_id,user_id) VALUES (?,?)').run(appId, userId);
  if (appRole) {
    db.prepare('INSERT OR REPLACE INTO app_user_roles (app_id,user_id,app_role) VALUES (?,?,?)')
      .run(appId, userId, appRole);
  }
};

const setVar = (appId, env, key, value) => db.prepare(
  "INSERT INTO env_vars (app_id,env,key,value_encrypted,updated_at) VALUES (?,?,?,?,datetime('now'))"
).run(appId, env, key, encrypt(value));

const PADMIN_EMAIL = 'padmin@example.test';
mkUser('Platform Admin', PADMIN_EMAIL, 'platform_admin', 'dhk_user_sn_padmin');

// (1) reveal notice — an app WITH an owner.
const OWNED_ID = mkApp('Owned App', 'sn-owned', 501);
const OWNER_EMAIL = 'owner-a@example.test';
const OWNER_A = mkUser('Owner A', OWNER_EMAIL, 'user', null);
const MEMBER_EMAIL = 'member-a@example.test';
const KEY_MEMBER_A = 'dhk_user_sn_member_a';
const MEMBER_A = mkUser('Member A', MEMBER_EMAIL, 'user', KEY_MEMBER_A);
assign(OWNED_ID, OWNER_A, 'owner');
assign(OWNED_ID, MEMBER_A, 'user');
const OWNED_KEYS = ['ALPHA_TOKEN', 'BETA_TOKEN', 'GAMMA_TOKEN', 'DELTA_TOKEN', 'EPSILON_TOKEN'];
OWNED_KEYS.forEach((k, i) => setVar(OWNED_ID, 'production', k, `owned-secret-${i}`));

// (1b) reveal notice — an app with NO owner at all (admin fallback).
const ORPHAN_ID = mkApp('Orphan App', 'sn-orphan', 502);
const KEY_MEMBER_B = 'dhk_user_sn_member_b';
const MEMBER_B = mkUser('Member B', 'member-b@example.test', 'user', KEY_MEMBER_B);
assign(ORPHAN_ID, MEMBER_B, 'user');
setVar(ORPHAN_ID, 'production', 'ORPHAN_TOKEN', 'orphan-secret');

// (2) throttle.
const THROTTLE_ID = mkApp('Throttle App', 'sn-throttle', 503);
const KEY_THROTTLE = 'dhk_user_sn_throttle';
const THROTTLE_USER = mkUser('Throttle User', 'throttle@example.test', 'user', KEY_THROTTLE);
const THROTTLE_OWNER = mkUser('Throttle Owner', 'throttle-owner@example.test', 'user', null);
assign(THROTTLE_ID, THROTTLE_USER, 'user');
assign(THROTTLE_ID, THROTTLE_OWNER, 'owner');
const CANARY = 'plaintext-canary-9f2c41';
setVar(THROTTLE_ID, 'production', 'STRIPE_KEY', CANARY);

// (2b) the other door: MCP writes `secret-reveal`, and a control app proving the
// budget keys off the ACTION and not merely "this user did something here".
const MCPDOOR_ID = mkApp('Mcp Door App', 'sn-mcpdoor', 504);
const CONTROL_ID = mkApp('Control App', 'sn-control', 505);
const KEY_DOORS = 'dhk_user_sn_doors';
const DOORS_USER = mkUser('Doors User', 'doors@example.test', 'user', KEY_DOORS);
for (const id of [MCPDOOR_ID, CONTROL_ID]) {
  assign(id, DOORS_USER, 'user');
  setVar(id, 'production', 'DOOR_KEY', 'door-secret');
}

// (3) attribution. The app NAME carries angle brackets so the HTML footer's
// escaping is exercised rather than assumed.
const MM_ID = mkApp('Market <Mind>', 'sn-marketmind', 506);
const MM_TOKEN = issueServiceToken(MM_ID);

// (4) email budget.
const BUDGET_ID = mkApp('Budget App', 'sn-budget', 507);
const BUDGET_TOKEN = issueServiceToken(BUDGET_ID);
const BUDGET2_ID = mkApp('Budget Two', 'sn-budget2', 508);
const BUDGET2_TOKEN = issueServiceToken(BUDGET2_ID);

// (5) disk quota.
const BIG_ID = mkApp('Disk Big', 'sn-diskbig', 509);
const SMALL_ID = mkApp('Disk Small', 'sn-disksmall', 510);
const BIG_OWNER_EMAIL = 'owner-big@example.test';
assign(BIG_ID, mkUser('Big Owner', BIG_OWNER_EMAIL, 'user', null), 'owner');
assign(SMALL_ID, mkUser('Small Owner', 'owner-small@example.test', 'user', null), 'owner');

// ── HTTP harness ─────────────────────────────────────────────────────────────

const api = express();
api.use(express.json());
api.use('/api/apps', envVarsRoutes);
api.use('/api/service', serviceApiRoutes);
api.use(errorHandler);

const server = await new Promise((res) => { const s = api.listen(0, () => res(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

startEmailWorker();

after(() => {
  stopEmailWorker();
  stopHealthChecker();
  server.closeAllConnections?.();
  server.unref();
  server.close();
  smtp.close();
});

async function req(method, path, { apiKey, serviceToken, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(apiKey && { 'X-API-Key': apiKey }),
      ...(serviceToken && { 'X-AppCrane-Service-Token': serviceToken }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, body: text, json, code: json?.error?.code };
}

const reveal = (slug, key, env = 'production') =>
  req('GET', `/api/apps/${slug}/env/${env}?reveal=true`, { apiKey: key });

// ── Reading the wire ─────────────────────────────────────────────────────────

/** Unfolded header value from a captured message. */
function header(raw, name) {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  return head.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1]?.trim() || '';
}

/**
 * Everything the recipient could read, as one searchable string.
 *
 * A body may arrive 7bit, quoted-printable or base64 depending on how
 * nodemailer sized the content, and the difference is not something the
 * assertions below should care about — so all three decodings are searched.
 * The union only ever makes a "this text is present" assertion easier to
 * satisfy and a "this text is absent" assertion harder, which is the safe
 * direction for both.
 */
function rendered(raw) {
  const parts = [raw];
  parts.push(
    raw.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  );
  for (const m of raw.matchAll(/(?:^[A-Za-z0-9+/=]{40,}\r?\n)+/gm)) {
    try { parts.push(Buffer.from(m[0].replace(/\s+/g, ''), 'base64').toString('utf8')); } catch (_) {}
  }
  return parts.join('\n');
}

const mailsMatching = (pred) => inbox.filter(pred);
const bySubject = (needle) => mailsMatching(m => header(m.raw, 'Subject').includes(needle));

async function waitFor(fn, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v && (!Array.isArray(v) || v.length)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 40));
  }
}

/** Let any fire-and-forget send finish before asserting that NOTHING arrived. */
const settle = (ms = 600) => new Promise(r => setTimeout(r, ms));

const auditCount = (userId, appId, action) => db.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE user_id IS ? AND app_id = ? AND action = ?'
).get(userId, appId, action).n;

// ═════════════════════════════════════════════════════════════════════════════
// 1. The reveal notification
// ═════════════════════════════════════════════════════════════════════════════

test('a plaintext reveal mails the app OWNERS exactly once, whatever the key count', async () => {
  const before = inbox.length;

  const r = await reveal('sn-owned', KEY_MEMBER_A);
  assert.equal(r.status, 200);
  // The read really did hand over plaintext — otherwise "a notice was sent"
  // would be true of a route that returns nothing at all.
  assert.equal(r.json.vars.length, OWNED_KEYS.length);
  assert.equal(r.json.vars.find(v => v.key === 'ALPHA_TOKEN').value, 'owned-secret-0');

  const mails = await waitFor(
    () => inbox.slice(before).filter(m => header(m.raw, 'Subject').includes('SECRET REVEAL')),
    'the secret-reveal notice',
  );
  await settle();

  const notices = inbox.slice(before).filter(m => header(m.raw, 'Subject').includes('SECRET REVEAL'));
  assert.equal(notices.length, 1,
    `one reveal of ${OWNED_KEYS.length} keys produced ${notices.length} notices — a reveal is one ` +
    'decision by one person at one moment, and one mail per key is the same information shaped so ' +
    'that nobody reads it');
  assert.equal(mails.length, 1);

  const m = notices[0];
  // Envelope, not just the To: header — the envelope is who the MTA actually
  // delivers to.
  assert.deepEqual(m.envelope.to, [OWNER_EMAIL],
    'the notice did not go to the app owner');

  const text = rendered(m.raw);
  assert.ok(!text.includes(PADMIN_EMAIL),
    'platform admins are on a per-app secret alert; on a box with dozens of apps that trains ' +
    'them to filter it, and they are the fallback for an ownerless app only');

  // Every key, in one mail. Partial lists are worse than none: they read as if
  // fewer secrets were taken than really were.
  for (const k of OWNED_KEYS) {
    assert.ok(text.includes(k), `the notice omits ${k}`);
  }
  assert.ok(text.includes(MEMBER_EMAIL), 'the notice never names who read the secrets');
  assert.ok(header(m.raw, 'Subject').includes('sn-owned'), 'the subject does not name the app');
  assert.ok(header(m.raw, 'Subject').includes('production'), 'the subject does not name the env');
  assert.ok(header(m.raw, 'Subject').includes(`${OWNED_KEYS.length} key`),
    'the subject does not carry the key count');

  // Platform identity, not the app's: a notice ABOUT an app must not look like
  // it came FROM that app, or a compromised app can forge AppCrane security mail.
  assert.match(header(m.raw, 'From'), /AppCrane Security/,
    'the security notice is sent under the app\'s own display name');

  // The record the notice points at.
  assert.equal(auditCount(MEMBER_A, OWNED_ID, 'env-reveal'), 1);
});

test('a masked read — the ordinary Environment tab render — notifies nobody', async () => {
  // The baseline that keeps the test above from passing vacuously: if ANY read
  // mailed the owners, the SPA's every-visit render would bury the reveal that
  // matters, and "a notice arrived" would prove nothing about reveals.
  const before = inbox.length;
  const r = await req('GET', '/api/apps/sn-owned/env/production', { apiKey: KEY_MEMBER_A });
  assert.equal(r.status, 200);
  assert.equal(r.json.vars[0].value, '********', 'a read without ?reveal=true returned plaintext');

  await settle(900);
  assert.deepEqual(
    inbox.slice(before).filter(m => header(m.raw, 'Subject').includes('SECRET REVEAL')),
    [],
    'a masked list triggered a security notice',
  );
  assert.equal(auditCount(MEMBER_A, OWNED_ID, 'env-reveal'), 1, 'a masked read wrote an env-reveal row');
});

test('an app with no owner falls back to the platform admins rather than telling nobody', async () => {
  const before = inbox.length;
  const r = await reveal('sn-orphan', KEY_MEMBER_B);
  assert.equal(r.status, 200);

  const notices = await waitFor(
    () => inbox.slice(before).filter(m => header(m.raw, 'Subject').includes('SECRET REVEAL')),
    'the ownerless-app fallback notice',
  );
  await settle();
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].envelope.to, [PADMIN_EMAIL],
    'an app with no active owner produced no notice at all — silence is the one outcome the ' +
    'fallback exists to prevent');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The reveal throttle
// ═════════════════════════════════════════════════════════════════════════════

const WINDOW_MIN = 10;
const MAX_PER_WINDOW = 30;

test('BASELINE: a single reveal is untouched by the throttle and returns the plaintext', async () => {
  // Deliberately first, and deliberately asserting the SECRET ITSELF comes back.
  // Everything below asserts a 429 that withholds plaintext; without this, a
  // route that had simply broken would satisfy all of it.
  const before = inbox.length;
  const r = await reveal('sn-throttle', KEY_THROTTLE);
  assert.equal(r.status, 200, 'the very first reveal for this user/app was throttled');
  assert.equal(r.json.vars[0].value, CANARY);
  assert.equal(auditCount(THROTTLE_USER, THROTTLE_ID, 'env-reveal'), 1);

  await waitFor(
    () => inbox.slice(before).filter(m => header(m.raw, 'Subject').includes('SECRET REVEAL')),
    'the first-reveal notice on the throttle app',
  );
});

test(`reveal ${MAX_PER_WINDOW + 1} in the window is refused, withholds the plaintext, and is not logged`, async () => {
  // Walk the real route the remaining way to the ceiling; no audit rows are
  // forged, so the boundary that fires is the one production computes.
  for (let i = 2; i <= MAX_PER_WINDOW; i++) {
    const ok = await reveal('sn-throttle', KEY_THROTTLE);
    assert.equal(ok.status, 200, `reveal #${i} was refused, so the ceiling is below ${MAX_PER_WINDOW}`);
  }
  assert.equal(auditCount(THROTTLE_USER, THROTTLE_ID, 'env-reveal'), MAX_PER_WINDOW);

  const blocked = await reveal('sn-throttle', KEY_THROTTLE);
  assert.equal(blocked.status, 429,
    `reveal #${MAX_PER_WINDOW + 1} in ${WINDOW_MIN} minutes was served; there is no rate ceiling`);
  assert.equal(blocked.code, 'REVEAL_THROTTLED');
  assert.ok(!blocked.body.includes(CANARY),
    'the throttled response still contained the plaintext secret — the refusal is cosmetic');

  // A refused call is not a reveal, so it must not consume or extend the window.
  // (Logging it would also let a caller push their own budget around.)
  assert.equal(auditCount(THROTTLE_USER, THROTTLE_ID, 'env-reveal'), MAX_PER_WINDOW,
    'the refused reveal wrote an env-reveal audit row');
});

test('the ceiling is a WINDOW: once the earlier reveals age out, reveals resume', async () => {
  // Age the existing rows past the window instead of sleeping 10 minutes. The
  // query under test is the production one, unchanged — only the clock the rows
  // sit on moves.
  db.prepare(`
    UPDATE audit_log SET created_at = datetime('now', ?)
    WHERE user_id = ? AND app_id = ? AND action = 'env-reveal'
  `).run(`-${WINDOW_MIN + 1} minutes`, THROTTLE_USER, THROTTLE_ID);

  const r = await reveal('sn-throttle', KEY_THROTTLE);
  assert.equal(r.status, 200,
    'reveals stayed blocked after the window elapsed — the throttle is a permanent lockout, and ' +
    'an operator who hits one during incident response gets it deleted');
  assert.equal(r.json.vars[0].value, CANARY);
});

test('30 reveals in one sitting produce ONE owner notice, not 30', async () => {
  // Coalescing is not a nicety. The SPA re-reveals after every set and every
  // delete, so without it a normal editing session puts ~15 identical mails in
  // the owner's inbox and the third one teaches them to filter the rest.
  const notices = inbox.filter(m => {
    const t = rendered(m.raw);
    return header(m.raw, 'Subject').includes('SECRET REVEAL') && t.includes('sn-throttle');
  });
  assert.equal(notices.length, 1,
    `${MAX_PER_WINDOW + 1} reveals on one app produced ${notices.length} notices`);
  assert.deepEqual(notices[0].envelope.to, ['throttle-owner@example.test']);
});

test('the MCP door spends the same budget as the HTTP door', async () => {
  // `appcrane_reveal_secret` writes `secret-reveal`. If the HTTP counter ignored
  // it, a caller would refresh their allowance just by switching transports —
  // and switching transports is free.
  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    logAudit(DOORS_USER, MCPDOOR_ID, 'secret-reveal', { env: 'production', keys: ['DOOR_KEY'] });
  }
  const blocked = await reveal('sn-mcpdoor', KEY_DOORS);
  assert.equal(blocked.status, 429,
    'MCP reveals do not count against the HTTP ceiling, so HTTP→MCP→HTTP is an unbounded loop');
  assert.equal(blocked.code, 'REVEAL_THROTTLED');
});

test('unrelated audit rows do not consume the reveal budget', async () => {
  // The control for the test above: proves the counter keys off the reveal
  // ACTIONS, not "this user touched this app N times". A throttle that fires on
  // ordinary deploys is one that gets ripped out.
  for (let i = 0; i < MAX_PER_WINDOW * 2; i++) {
    logAudit(DOORS_USER, CONTROL_ID, 'env-set', { env: 'production', keys: ['DOOR_KEY'] });
  }
  const r = await reveal('sn-control', KEY_DOORS);
  assert.equal(r.status, 200,
    'non-reveal audit rows count against the reveal ceiling, so ordinary work locks a user out');
  assert.equal(r.json.vars[0].value, 'door-secret');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. App-mail attribution
// ═════════════════════════════════════════════════════════════════════════════

const APP_SUBJECT = 'Quarterly access review sn-attrib';
const PLATFORM_SUBJECT = 'Platform notice sn-attrib';

// Both are queued once, up front, so the suite pays a single worker tick rather
// than one per assertion. The platform-source row is the control: the "via"
// suffix and the footer must be scoped to app-originated mail, or every
// AppCrane notice starts claiming an app wrote it.
enqueueEmail({
  appId: MM_ID, env: 'sandbox', to: OWNER_EMAIL,
  subject: APP_SUBJECT,
  text: 'Please review your access this quarter.',
  html: '<p>Please review your access this quarter.</p>',
  fromName: 'IT Helpdesk',
  source: 'app',
});
enqueueEmail({
  appId: MM_ID, env: 'sandbox', to: OWNER_EMAIL,
  subject: PLATFORM_SUBJECT,
  text: 'AppCrane platform notice.',
  html: '<p>AppCrane platform notice.</p>',
  source: 'platform',
});

test('app mail names the sending app on the From line the recipient sees', async () => {
  const [m] = await waitFor(() => bySubject(APP_SUBJECT), 'the app-sent message on the wire');

  const from = header(m.raw, 'From');
  assert.ok(from.includes('IT Helpdesk'),
    `the app's chosen display name was discarded: ${from}`);
  assert.ok(/via\s+sn-marketmind/.test(from),
    `the rendered From line does not name the sending app: ${from}\n` +
    'The DB column already recorded it; nobody reads the DB. "<name> via <slug>" is the Google ' +
    'Groups convention for exactly this: the app keeps the presentation it wants, and the true ' +
    'origin is appended where it cannot be styled away — including on mobile clients that show ' +
    'the display name and nothing else.');
  assert.ok(/AppCrane/.test(from), `the From line does not name the platform: ${from}`);

  // Display name only. The address is the platform mailbox; a per-app address
  // would be a real sender identity rather than a label.
  assert.ok(/<[^>]*@[^>]*>/.test(from), `no envelope address on the From line: ${from}`);
  assert.equal(m.envelope.from, 'appcrane@example.com',
    'the app influenced the envelope sender, not just the display name');
});

test('app mail carries a body footer naming the app, HTML-escaped', async () => {
  // The From line is the attribution most people see and the first thing a
  // forward or a quote loses. The footer travels with the text.
  const [m] = await waitFor(() => bySubject(APP_SUBJECT), 'the app-sent message on the wire');
  const text = rendered(m.raw);

  assert.ok(text.includes('sn-marketmind'),
    'the rendered body never names the sending app, so a forwarded copy has no attribution left');
  assert.ok(/AppCrane did not write this message/.test(text),
    'the footer does not disclaim authorship, which is the part that stops a colleague reading a ' +
    'spoofed display name as a platform statement');

  // The app's own NAME is attacker-chosen text landing in an HTML document.
  assert.ok(text.includes('Market &lt;Mind&gt;'),
    'the app name is not HTML-escaped in the footer — an app could close the tag and inject markup');
  assert.ok(!/<p>Market <Mind>/.test(text), 'raw app-name markup reached the HTML part');

  // And the stored row is untouched: attribution is applied at SEND time, so it
  // cannot be edited back out of the queue.
  const row = db.prepare('SELECT * FROM email_queue WHERE app_id = ? AND subject = ?').get(MM_ID, APP_SUBJECT);
  assert.equal(row.from_name, 'IT Helpdesk', 'the stored row was rewritten instead of the rendered message');
  assert.ok(!String(row.body_text).includes('sn-marketmind'), 'the footer was baked into the stored row');
});

test('platform mail is NOT attributed to an app', async () => {
  const [m] = await waitFor(() => bySubject(PLATFORM_SUBJECT), 'the platform-sourced message');
  const from = header(m.raw, 'From');
  assert.ok(!/via\s+sn-marketmind/.test(from),
    `a platform notice claims an app sent it: ${from}`);
  assert.ok(!rendered(m.raw).includes('at that app\'s request'),
    'a platform notice carries the app-authorship footer');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Per-app email budget
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_HOURLY = 100;

const sendAs = (token, subject, extra = {}) => req('POST', '/api/service/email', {
  serviceToken: token,
  body: { to: OWNER_EMAIL, subject, text: 'body', env: 'sandbox', ...extra },
});

const queuedForApp = (appId) => db.prepare(
  "SELECT COUNT(*) AS n FROM email_queue WHERE app_id = ? AND source = 'app'"
).get(appId).n;

test('BASELINE: a single app send is accepted and does not trip the budget', async () => {
  const r = await sendAs(BUDGET_TOKEN, 'sn-budget first message');
  assert.equal(r.status, 202, `a first, solitary send was rate-limited: ${r.body}`);
  assert.equal(r.json.queued, true);
  assert.equal(queuedForApp(BUDGET_ID), 1);
});

test(`the ${DEFAULT_HOURLY}/hour default budget refuses the next message with 429`, async () => {
  // Backfill the rest of the hour rather than firing 99 real sends: the row
  // count is exactly what production counts, and the boundary itself is walked
  // with real requests below.
  const backfill = db.prepare(`
    INSERT INTO email_queue (app_id, env, to_email, subject, body_text, source, status, created_at)
    VALUES (?, 'sandbox', ?, 'backfill', 'x', 'app', 'sent', datetime('now'))
  `);
  for (let i = 0; i < DEFAULT_HOURLY - 2; i++) backfill.run(BUDGET_ID, OWNER_EMAIL);
  assert.equal(queuedForApp(BUDGET_ID), DEFAULT_HOURLY - 1);

  // The last message inside the budget still goes through — an off-by-one here
  // would silently cost a legitimate app its final send every hour.
  const last = await sendAs(BUDGET_TOKEN, 'sn-budget message 100');
  assert.equal(last.status, 202, `message #${DEFAULT_HOURLY} of ${DEFAULT_HOURLY} was refused: ${last.body}`);
  assert.equal(queuedForApp(BUDGET_ID), DEFAULT_HOURLY);

  const over = await sendAs(BUDGET_TOKEN, 'sn-budget message 101');
  assert.equal(over.status, 429,
    `message #${DEFAULT_HOURLY + 1} in the hour was accepted; a looping app can mail every ` +
    'registered user inside the perimeter, repeatedly, under a display name of its choosing');
  assert.equal(over.code, 'EMAIL_RATE_LIMITED',
    'a spent budget is reported as a malformed request (400), which tells a well-behaved app to ' +
    'give up rather than back off');
  assert.equal(queuedForApp(BUDGET_ID), DEFAULT_HOURLY, 'the refused send was queued anyway');
});

test('the budget is a rolling hour, not a permanent cap', async () => {
  db.prepare("UPDATE email_queue SET created_at = datetime('now','-2 hours') WHERE app_id = ?").run(BUDGET_ID);
  const r = await sendAs(BUDGET_TOKEN, 'sn-budget after the hour');
  assert.equal(r.status, 202, 'an app that hits the cap once can never send again');
});

test('platform mail neither consumes nor is starved by an app budget', async () => {
  // Dead-letter alerts and request digests share this table. If they counted
  // against the app, an app's spam would silence the platform's own alarms —
  // including the alarm about that spam.
  db.prepare('DELETE FROM email_queue WHERE app_id = ?').run(BUDGET2_ID);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('email_app_hourly_limit','2')").run();

  const plat = db.prepare(`
    INSERT INTO email_queue (app_id, env, to_email, subject, body_text, source, status, created_at)
    VALUES (?, 'sandbox', ?, 'platform backfill', 'x', 'platform', 'sent', datetime('now'))
  `);
  for (let i = 0; i < 5; i++) plat.run(BUDGET2_ID, OWNER_EMAIL);

  // Five platform rows already exist and the limit is 2, so both of these
  // succeeding is the proof that source='app' is the only thing counted.
  assert.equal((await sendAs(BUDGET2_TOKEN, 'sn-budget2 one')).status, 202);
  assert.equal((await sendAs(BUDGET2_TOKEN, 'sn-budget2 two')).status, 202);

  const over = await sendAs(BUDGET2_TOKEN, 'sn-budget2 three');
  assert.equal(over.status, 429, 'the email_app_hourly_limit setting is ignored');
  assert.equal(over.code, 'EMAIL_RATE_LIMITED');

  // A non-positive setting falls back to the default instead of disabling the
  // budget: "0 means unlimited" is config that reads as safe and behaves as off.
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'email_app_hourly_limit'").run();
  const withZero = await sendAs(BUDGET2_TOKEN, 'sn-budget2 four');
  assert.equal(withZero.status, 202,
    'setting the limit to 0 kept the budget at 0 — an operator typing the value that reads as ' +
    '"no limit" would lock every app out of email');

  db.prepare("DELETE FROM settings WHERE key = 'email_app_hourly_limit'").run();
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Disk-quota detection
// ═════════════════════════════════════════════════════════════════════════════

const QUOTA_MB = 1;

function seedDataDir(slug, env, bytes) {
  // Mirrors deployer.js: this host path is the container's /data bind mount.
  const dir = join(DATA_DIR, 'apps', slug, env, 'shared', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(bytes, 7));
  return dir;
}

const quotaAudits = (appId) => db.prepare(
  "SELECT * FROM audit_log WHERE app_id = ? AND action = 'disk-quota-exceeded'"
).all(appId);

const quotaMails = () => inbox.filter(m => header(m.raw, 'Subject').includes('DISK QUOTA EXCEEDED'));

/**
 * Fire the sweep by advancing its own timer.
 *
 * The interval is 15 minutes, so a real wait is out — but driving the timer
 * rather than the (unexported) sweep function also proves the thing most likely
 * to break silently: that startHealthChecker actually schedules it. Only
 * setInterval is mocked, so the polling below still runs on the real clock.
 */
async function sweep() {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startHealthChecker();
    mock.timers.tick(15 * 60_000 + 1);
  } finally {
    stopHealthChecker();
    mock.timers.reset();
  }
}

test('an app over its disk budget produces an audit row and mails owners AND platform admins', async () => {
  seedDataDir('sn-diskbig', 'production', 3 * 1024 * 1024);
  seedDataDir('sn-disksmall', 'production', 4 * 1024);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('app_disk_quota_mb', ?)").run(String(QUOTA_MB));

  const before = inbox.length;
  await sweep();

  await waitFor(() => quotaAudits(BIG_ID), 'the disk-quota audit row');
  const rows = quotaAudits(BIG_ID);
  assert.equal(rows.length, 1);
  const detail = JSON.parse(rows[0].detail);
  assert.equal(detail.env, 'production');
  assert.ok(detail.used_bytes > detail.quota_bytes,
    `the alert fired below the line: ${detail.used_bytes} <= ${detail.quota_bytes}`);
  assert.equal(detail.quota_bytes, QUOTA_MB * 1024 * 1024, 'the app_disk_quota_mb setting was ignored');

  // Wait for the FULL recipient set, not merely the first mail. waitFor returns
  // on any non-empty array, so waiting for "a mail" and then asserting two is a
  // race: the owner's send lands, settle() runs, and the platform admin's has
  // not been enqueued yet. It won locally on every run and lost on the CI
  // runner — the sends are sequential, so the slower the box the wider the gap.
  const mails = await waitFor(
    () => (quotaMails().length >= 2 ? quotaMails() : null),
    'both disk-quota alert mails (owner + platform admin)',
  );
  await settle();
  assert.equal(quotaMails().length, 2,
    'the quota alert did not reach exactly the owner and the platform admin');

  const to = mails.flatMap(m => m.envelope.to).sort();
  assert.deepEqual(to, [BIG_OWNER_EMAIL, PADMIN_EMAIL].sort(),
    'platform admins are on this one BECAUSE the quota is advisory: an app over budget is eating a ' +
    'shared host filesystem, so the blast radius is every other app on the box, not just the owner\'s');

  const body = rendered(mails[0].raw);
  assert.ok(body.includes('sn-diskbig'), 'the alert does not name the app');
  assert.ok(/ADVISORY|advisory/.test(body),
    'the alert does not say the quota is unenforced — an operator who assumes the platform stopped ' +
    'the write will not go free the space');
  assert.ok(inbox.length > before);
});

test('an app comfortably under its budget stays silent', async () => {
  // The other half of the same sweep. Without this the test above is satisfied
  // by a check that alerts on every app it can measure.
  assert.deepEqual(quotaAudits(SMALL_ID), [],
    'an app using 4 KB against a 1 MB budget was reported as over quota');
  assert.ok(!quotaMails().some(m => rendered(m.raw).includes('sn-disksmall')),
    'a quota alert was sent for an app under its budget');

  // And the apps with no /data at all were skipped rather than read as zero-or-error.
  for (const id of [OWNED_ID, MM_ID, BUDGET_ID]) {
    assert.deepEqual(quotaAudits(id), [], 'an app with no data directory was alerted on');
  }
});

test('a still-over app is not re-alerted inside the cooldown', async () => {
  // 15-minute sweeps against a condition that takes days to resolve: re-alerting
  // every sweep is how an alert becomes something people filter, which is the
  // failure this whole item is about.
  const mailsBefore = quotaMails().length;
  await sweep();
  await settle(900);

  assert.equal(quotaAudits(BIG_ID).length, 1,
    'the second sweep wrote a duplicate audit row for the same unresolved condition');
  assert.equal(quotaMails().length, mailsBefore,
    'the second sweep re-mailed inside the 24h cooldown');
});
