import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// GET /api/credentials/health. Two contracts:
//
//   1. It is platform-admin-only. The response names which platform integration
//      is currently broken — free reconnaissance for anyone who shouldn't have
//      it — so a plain admin and an anonymous caller must both be refused.
//   2. It carries an `href` for each failing probe so the banner can be a real
//      link, WITHOUT breaking on state rows that predate the field or on a
//      href that would render as a dead/hostile link.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-credhealth-'));
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const mkUser = (name, email, role) => {
  const key = generateApiKey('dhk_user');
  db.prepare('INSERT INTO users (name,email,role,api_key_hash,active,kind) VALUES (?,?,?,?,1,?)')
    .run(name, email, role, hashApiKey(key), 'human');
  return key;
};

const PLATFORM_KEY = mkUser('P', 'p@x.io', 'platform_admin');
const ADMIN_KEY = mkUser('A', 'a@x.io', 'admin');
const USER_KEY = mkUser('U', 'u@x.io', 'user');

function setState(state) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('credcheck_state', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(state));
}

const monitoring = (await import('../server/routes/monitoring.js')).default;
const app = express();
app.use(express.json());
app.use('/api', monitoring);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
after(() => { server.closeAllConnections?.(); server.unref(); server.close(); });

const BASE = `http://127.0.0.1:${server.address().port}`;
const get = async (key) => {
  const res = await fetch(`${BASE}/api/credentials/health`, key ? { headers: { 'X-API-Key': key } } : undefined);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const failingFor = async (state, key = PLATFORM_KEY) => {
  setState(state);
  const { body } = await get(key);
  return body.failing;
};

// ── Authorization: this response is a map of what is broken on the platform.

test('anonymous callers cannot read which integrations are failing', async () => {
  setState({ 'GitHub service account': { ok: false, error: 'bad creds', fix: 'Settings → GitHub' } });
  const { status, body } = await get(null);
  assert.equal(status, 401);
  assert.ok(!JSON.stringify(body ?? '').includes('GitHub service account'),
    'the 401 body must not leak the failing probe name');
});

test('a plain admin is refused — platform_admin only', async () => {
  const { status, body } = await get(ADMIN_KEY);
  assert.equal(status, 403);
  assert.ok(!JSON.stringify(body ?? '').includes('bad creds'));
});

test('a non-admin user is refused', async () => {
  const { status } = await get(USER_KEY);
  assert.equal(status, 403);
});

test('a platform admin gets the failing list', async () => {
  const { status, body } = await get(PLATFORM_KEY);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.failing.length, 1);
  assert.equal(body.failing[0].name, 'GitHub service account');
});

// ── href passthrough.

test('href is returned alongside name/error/fix', async () => {
  const [f] = await failingFor({
    'GitHub service account': {
      ok: false, since: 123, error: 'bad creds',
      fix: 'Settings → GitHub', href: '/settings?tab=github',
    },
  });
  assert.equal(f.href, '/settings?tab=github');
  assert.equal(f.fix, 'Settings → GitHub', 'fix stays — the banner falls back to it');
  assert.equal(f.error, 'bad creds');
  assert.equal(f.since, 123);
});

test('an absolute https href (built from CRANE_DOMAIN) passes through', async () => {
  const [f] = await failingFor({
    'Microsoft Graph (email)': { ok: false, href: 'https://crane.example.com/settings?tab=mail' },
  });
  assert.equal(f.href, 'https://crane.example.com/settings?tab=mail');
});

test('state written before href existed yields no href key at all, not undefined/null', async () => {
  const [f] = await failingFor({
    'Microsoft Graph (email)': { ok: false, error: 'expired', fix: 'Settings → Mail' },
  });
  assert.equal('href' in f, false, 'omit the key so the banner renders plain text, not an empty link');
  assert.equal(f.fix, 'Settings → Mail');
});

test('a https://undefined href from an unset CRANE_DOMAIN is dropped, not served as a dead link', async () => {
  const [f] = await failingFor({
    'Microsoft Graph (email)': { ok: false, fix: 'Settings → Mail', href: 'https://undefined/settings?tab=mail' },
  });
  assert.equal('href' in f, false);
});

test('javascript:/data:/protocol-relative hrefs are dropped before reaching an admin browser', async () => {
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>x</script>',
    '//evil.example.com/settings', 'settings?tab=github', '   ', 42, null]) {
    const [f] = await failingFor({ 'GitHub service account': { ok: false, href: bad } });
    assert.equal('href' in f, false, `href ${JSON.stringify(bad)} must not be served`);
  }
});

// ── Existing shape must not regress.

test('healthy state reports ok:true with an empty list', async () => {
  setState({ 'GitHub service account': { ok: true } });
  const { body } = await get(PLATFORM_KEY);
  assert.equal(body.ok, true);
  assert.deepEqual(body.failing, []);
});

test('unreadable state is treated as nothing failing rather than a 500', async () => {
  db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'credcheck_state'").run();
  const { status, body } = await get(PLATFORM_KEY);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});
