import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// SCIM 2.0 /Groups — the first SCIM tests in this repo.
//
// Three things are being pinned, in descending order of what it costs to get
// them wrong:
//
//   1. AUTHZ. /Groups is an org chart, and through the group -> app mapping it
//      is also a grant of app access. Every verb must sit behind the same token
//      gate as /Users, and the platform-admin half of the mapping must be
//      unreachable with a SCIM bearer token. An unauthenticated call must not
//      just fail — it must not have changed anything either.
//
//   2. PATCH members[value eq "N"]. This is the shape Okta sends to remove one
//      person from a group and the one hand-rolled SCIM servers miss: a naive
//      `path === 'members'` check does not match it, the operation falls
//      through, and the server answers 200 while the member is still there
//      still holding whatever the group grants.
//
//   3. THE GRANT MEANS SOMETHING, AND ONLY WHAT IT SHOULD. Membership has to
//      reach app_users / app_user_roles or it is decoration — but it must not
//      delete a direct grant an admin made for unrelated reasons, and must not
//      downgrade a hand-set tier.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-scimgroups-'));
process.env.ENCRYPTION_KEY = 'b'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const mkUser = (name, role) => {
  const key = generateApiKey('dhk_user');
  const id = db.prepare('INSERT INTO users (name,email,role,api_key_hash,active) VALUES (?,?,?,?,1)')
    .run(name, `${name}@scim.test`, role, hashApiKey(key)).lastInsertRowid;
  return { id, key };
};

const ALICE = mkUser('alice', 'user');
const BOB   = mkUser('bob', 'user');
const CARA  = mkUser('cara', 'user');
const PLATFORM = mkUser('platform', 'platform_admin');
const PLAIN_ADMIN = mkUser('padmin', 'admin');

const APP_ID = db.prepare(
  "INSERT INTO apps (name,slug,slot,source_type,branch) VALUES (?,?,?,'managed','main')"
).run('Legal', 'legal', 1).lastInsertRowid;
const APP2_ID = db.prepare(
  "INSERT INTO apps (name,slug,slot,source_type,branch) VALUES (?,?,?,'managed','main')"
).run('Payroll', 'payroll', 2).lastInsertRowid;

const SCIM_TOKEN = generateApiKey('scim');
const setSetting = (k, v) => db.prepare(
  `INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
).run(k, v);
setSetting('scim_token_hash', hashApiKey(SCIM_TOKEN));
setSetting('scim_enabled', '1');

const scim = await import('../server/routes/scim.js');
const app = express();
app.use(express.json());
app.use('/api/scim/v2', scim.default);
app.use('/api/auth/scim', scim.scimAdminRouter);
// requireAuth signals with next(AppError); the real server has an error
// handler, so the test needs one too or a 403 arrives as a 500.
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));

const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
after(() => { server.closeAllConnections?.(); server.unref(); server.close(); });
const BASE = `http://127.0.0.1:${server.address().port}`;

/** SCIM call with the bearer token (or a caller-supplied one / none). */
async function scimReq(method, path, { body, token = SCIM_TOKEN } = {}) {
  const res = await fetch(BASE + '/api/scim/v2' + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

/** Admin-side call (X-API-Key session, not the SCIM token). */
async function adminReq(method, path, { body, key } = {}) {
  const res = await fetch(BASE + '/api/auth/scim' + path, {
    method,
    headers: {
      ...(key ? { 'X-API-Key': key } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const createGroup = async (displayName, members = []) =>
  scimReq('POST', '/Groups', { body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName, members: members.map(id => ({ value: String(id) })) } });

const memberIds = (group) => (group.members || []).map(m => Number(m.value)).sort((a, b) => a - b);
const groupCount = () => db.prepare('SELECT COUNT(*) n FROM scim_groups').get().n;
const rowsFor = (appId, userId) => ({
  member: !!db.prepare('SELECT 1 FROM app_users WHERE app_id=? AND user_id=?').get(appId, userId),
  role: db.prepare('SELECT app_role r FROM app_user_roles WHERE app_id=? AND user_id=?').get(appId, userId)?.r ?? null,
});

function resetState() {
  db.prepare('DELETE FROM scim_groups').run();
  db.prepare('DELETE FROM scim_group_access').run();
  db.prepare('DELETE FROM app_users').run();
  db.prepare('DELETE FROM app_user_roles').run();
}

// ───────────────────────────────────────────────────────── authorization

test('anonymous callers cannot read groups, and the 401 leaks no group name', async () => {
  resetState();
  await createGroup('Legal Team');
  const res = await scimReq('GET', '/Groups', { token: null });
  assert.equal(res.status, 401);
  assert.ok(!res.raw.includes('Legal Team'), 'the 401 body must not leak group names');
});

test('a wrong bearer token is refused on every /Groups verb, and mutates nothing', async () => {
  resetState();
  const { body: group } = await createGroup('Legal Team', [ALICE.id]);
  const before = groupCount();
  const bad = 'scim_' + 'z'.repeat(32);

  const calls = [
    ['GET', '/Groups'],
    ['GET', `/Groups/${group.id}`],
    ['POST', '/Groups', { displayName: 'Injected' }],
    ['PUT', `/Groups/${group.id}`, { displayName: 'Renamed' }],
    ['PATCH', `/Groups/${group.id}`, { Operations: [{ op: 'remove', path: `members[value eq "${ALICE.id}"]` }] }],
    ['DELETE', `/Groups/${group.id}`],
  ];
  for (const [method, path, body] of calls) {
    const res = await scimReq(method, path, { body, token: bad });
    assert.equal(res.status, 401, `${method} ${path} must be 401 with a bad token`);
  }
  assert.equal(groupCount(), before, 'no group was created or deleted by the rejected calls');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_members WHERE group_id=?').get(group.id).n, 1,
    'the rejected PATCH did not remove the member');
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id=?').get(group.id).d, 'Legal Team',
    'the rejected PUT did not rename the group');
});

test('with SCIM disabled every /Groups verb is 403 even with the right token', async () => {
  resetState();
  const { body: group } = await createGroup('Legal Team');
  setSetting('scim_enabled', '0');
  try {
    for (const [method, path] of [['GET', '/Groups'], ['GET', `/Groups/${group.id}`], ['DELETE', `/Groups/${group.id}`]]) {
      assert.equal((await scimReq(method, path)).status, 403, `${method} ${path}`);
    }
  } finally {
    setSetting('scim_enabled', '1');
  }
  assert.equal(groupCount(), 1, 'the refused DELETE did not remove the group');
});

// ───────────────────────────────────────────────────── CRUD + list/filter

test('POST /Groups creates, GET returns it, duplicate displayName is 409', async () => {
  resetState();
  const created = await createGroup('Legal Team', [ALICE.id, BOB.id]);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.schemas, ['urn:ietf:params:scim:schemas:core:2.0:Group']);
  assert.equal(created.body.displayName, 'Legal Team');
  assert.deepEqual(memberIds(created.body), [ALICE.id, BOB.id].sort((a, b) => a - b));
  assert.equal(created.body.meta.resourceType, 'Group');
  assert.ok(created.body.meta.location.endsWith(`/Groups/${created.body.id}`));

  const got = await scimReq('GET', `/Groups/${created.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(memberIds(got.body), memberIds(created.body));

  const dupe = await createGroup('Legal Team');
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.scimType, 'uniqueness');

  assert.equal((await scimReq('GET', '/Groups/999999')).status, 404);
});

test('a duplicate externalId is a 409, not a 500 from the unique index', async () => {
  resetState();
  const first = await scimReq('POST', '/Groups', { body: { displayName: 'Legal Team', externalId: 'okta-1' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.externalId, 'okta-1');

  const dupe = await scimReq('POST', '/Groups', { body: { displayName: 'Payroll Team', externalId: 'okta-1' } });
  assert.equal(dupe.status, 409, 'a raw SQLITE_CONSTRAINT would surface as 500 and tell the IdP nothing');
  assert.equal(dupe.body.scimType, 'uniqueness');
  assert.equal(groupCount(), 1);

  const { body: second } = await scimReq('POST', '/Groups', { body: { displayName: 'Payroll Team', externalId: 'okta-2' } });
  assert.equal((await scimReq('PUT', `/Groups/${second.id}`, { body: { displayName: 'Payroll Team', externalId: 'okta-1' } })).status, 409);
  assert.equal((await scimReq('PATCH', `/Groups/${second.id}`, { body: { Operations: [{ op: 'replace', path: 'externalId', value: 'okta-1' }] } })).status, 409);
  assert.equal(db.prepare('SELECT external_id e FROM scim_groups WHERE id=?').get(second.id).e, 'okta-2');

  // Two groups with no externalId at all must still be allowed — the index is
  // partial for exactly that reason.
  assert.equal((await scimReq('POST', '/Groups', { body: { displayName: 'A' } })).status, 201);
  assert.equal((await scimReq('POST', '/Groups', { body: { displayName: 'B' } })).status, 201);

  // externalId eq "..." is how an IdP re-finds a group it renamed.
  const found = await scimReq('GET', '/Groups?filter=' + encodeURIComponent('externalId eq "okta-2"'));
  assert.equal(found.body.totalResults, 1);
  assert.equal(found.body.Resources[0].id, String(second.id));
});

test('POST /Groups rejects a member the IdP cannot see through /Users', async () => {
  resetState();
  const ghost = await scimReq('POST', '/Groups', { body: { displayName: 'Ghosts', members: [{ value: '424242' }] } });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.scimType, 'invalidValue');
  assert.equal(groupCount(), 0, 'the group was not half-created');

  // A platform_admin account is not in the /Users population, so it cannot be
  // pulled into a group and handed an app tier through the mapping.
  const lifted = await scimReq('POST', '/Groups', { body: { displayName: 'Lifted', members: [{ value: String(PLATFORM.id) }] } });
  assert.equal(lifted.status, 400);
});

test('GET /Groups filters, paginates, and refuses a filter it cannot evaluate', async () => {
  resetState();
  await createGroup('Legal Team', [ALICE.id]);
  await createGroup('Payroll Team', [BOB.id]);

  const all = await scimReq('GET', '/Groups');
  assert.equal(all.body.totalResults, 2);
  assert.equal(all.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:ListResponse');

  const one = await scimReq('GET', '/Groups?filter=' + encodeURIComponent('displayName eq "Payroll Team"'));
  assert.equal(one.body.totalResults, 1);
  assert.equal(one.body.Resources[0].displayName, 'Payroll Team');

  const none = await scimReq('GET', '/Groups?filter=' + encodeURIComponent('displayName eq "Nope"'));
  assert.equal(none.body.totalResults, 0);
  assert.deepEqual(none.body.Resources, []);

  // The failure mode this replaces: an unparseable filter used to be dropped
  // and answered with the whole list, which an IdP reads as a match.
  const bad = await scimReq('GET', '/Groups?filter=' + encodeURIComponent('displayName co "Team" and id gt 0'));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.scimType, 'invalidFilter');

  const page = await scimReq('GET', '/Groups?count=1&startIndex=2');
  assert.equal(page.body.totalResults, 2);
  assert.equal(page.body.itemsPerPage, 1);
  assert.equal(page.body.startIndex, 2);

  const lean = await scimReq('GET', '/Groups?excludedAttributes=members');
  assert.ok(lean.body.Resources.every(r => r.members === undefined), 'members omitted when excluded');
});

test('GET /Users refuses a filter it cannot evaluate instead of listing everyone', async () => {
  const bad = await scimReq('GET', '/Users?filter=' + encodeURIComponent('userName eq "alice@scim.test" and active eq true'));
  assert.equal(bad.status, 400, 'an unparseable user filter must not answer 200 with the full list');
  assert.equal(bad.body.scimType, 'invalidFilter');
  const ok = await scimReq('GET', '/Users?filter=' + encodeURIComponent('userName eq "alice@scim.test"'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.totalResults, 1);
});

// ───────────────────────────────────────────────────────────────── PATCH

test('PATCH removes a member through the members[value eq "N"] path filter', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id, BOB.id]);

  const res = await scimReq('PATCH', `/Groups/${g.id}`, {
    body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'remove', path: `members[value eq "${ALICE.id}"]` }] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(memberIds(res.body), [BOB.id], 'alice removed, bob untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_members WHERE group_id=? AND user_id=?')
    .get(g.id, ALICE.id).n, 0, 'the row is really gone, not just absent from the response');
});

test('PATCH accepts the other member shapes IdPs send', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team');
  const patch = (Operations) => scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations } });

  let r = await patch([{ op: 'add', path: 'members', value: [{ value: String(ALICE.id) }, { value: String(BOB.id) }] }]);
  assert.deepEqual(memberIds(r.body), [ALICE.id, BOB.id].sort((a, b) => a - b));

  // add is idempotent — a resync must not fail on a member already present
  r = await patch([{ op: 'add', path: 'members', value: [{ value: String(ALICE.id) }] }]);
  assert.equal(r.status, 200);
  assert.deepEqual(memberIds(r.body), [ALICE.id, BOB.id].sort((a, b) => a - b));

  // remove by value payload rather than path filter
  r = await patch([{ op: 'remove', path: 'members', value: [{ value: String(BOB.id) }] }]);
  assert.deepEqual(memberIds(r.body), [ALICE.id]);

  // replace the whole list
  r = await patch([{ op: 'replace', path: 'members', value: [{ value: String(CARA.id) }] }]);
  assert.deepEqual(memberIds(r.body), [CARA.id]);

  // remove the attribute entirely
  r = await patch([{ op: 'remove', path: 'members' }]);
  assert.deepEqual(memberIds(r.body), []);

  // unwrapped single value
  r = await patch([{ op: 'add', path: 'members', value: { value: String(BOB.id) } }]);
  assert.deepEqual(memberIds(r.body), [BOB.id]);
});

test('PATCH renames, rejects an empty or clashing name, and honours the pathless form', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team');
  await createGroup('Payroll Team');

  let r = await scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations: [{ op: 'replace', path: 'displayName', value: 'Legal' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, 'Legal');

  r = await scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations: [{ op: 'replace', value: { displayName: 'Legal Ops' } }] } });
  assert.equal(r.body.displayName, 'Legal Ops');

  r = await scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations: [{ op: 'replace', path: 'displayName', value: '   ' }] } });
  assert.equal(r.status, 400);

  r = await scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations: [{ op: 'replace', path: 'displayName', value: 'Payroll Team' }] } });
  assert.equal(r.status, 409);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id=?').get(g.id).d, 'Legal Ops',
    'the refused rename left the name alone');
});

test('PATCH refuses an operation it cannot honour rather than answering 200', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);

  const weird = await scimReq('PATCH', `/Groups/${g.id}`, {
    body: { Operations: [{ op: 'replace', path: 'members[display eq "alice@scim.test"].type', value: 'Group' }] },
  });
  assert.equal(weird.status, 400, 'an unhandled op must not report success');
  assert.equal(weird.body.scimType, 'invalidPath');

  assert.equal((await scimReq('PATCH', `/Groups/${g.id}`, { body: {} })).status, 400);
  assert.equal((await scimReq('PATCH', '/Groups/999999', { body: { Operations: [] } })).status, 404);

  const ghost = await scimReq('PATCH', `/Groups/${g.id}`, {
    body: { Operations: [{ op: 'add', path: 'members', value: [{ value: '424242' }] }] },
  });
  assert.equal(ghost.status, 400);
  assert.deepEqual(memberIds((await scimReq('GET', `/Groups/${g.id}`)).body), [ALICE.id]);
});

test('a PATCH whose second operation is invalid applies neither', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);
  const res = await scimReq('PATCH', `/Groups/${g.id}`, {
    body: { Operations: [
      { op: 'replace', path: 'displayName', value: 'Renamed Mid-Flight' },
      { op: 'frobnicate', path: 'members' },
    ] },
  });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id=?').get(g.id).d, 'Legal Team',
    'the first operation was rolled back with the second');
});

// ─────────────────────────────────────────────────────────── PUT / DELETE

test('PUT replaces displayName and the whole member list', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id, BOB.id]);
  const res = await scimReq('PUT', `/Groups/${g.id}`, {
    body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Legal', members: [{ value: String(CARA.id) }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.displayName, 'Legal');
  assert.deepEqual(memberIds(res.body), [CARA.id]);

  const emptied = await scimReq('PUT', `/Groups/${g.id}`, { body: { displayName: 'Legal' } });
  assert.deepEqual(memberIds(emptied.body), [], 'PUT without members clears them — replace semantics');
});

test('DELETE removes the group and its membership rows', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);
  assert.equal((await scimReq('DELETE', `/Groups/${g.id}`)).status, 204);
  assert.equal(groupCount(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_members WHERE group_id=?').get(g.id).n, 0);
  assert.equal((await scimReq('DELETE', `/Groups/${g.id}`)).status, 404);
});

test('deleting a user leaves no dangling group member', async () => {
  resetState();
  const doomed = mkUser('doomed', 'user');
  const { body: g } = await createGroup('Legal Team', [ALICE.id, doomed.id]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_members WHERE group_id=?').get(g.id).n, 2);

  assert.equal((await scimReq('DELETE', `/Users/${doomed.id}`)).status, 204);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_members WHERE user_id=?').get(doomed.id).n, 0,
    'the membership row cascaded away with the user');
  assert.deepEqual(memberIds((await scimReq('GET', `/Groups/${g.id}`)).body), [ALICE.id]);
});

// ─────────────────────────────────────────── discovery documents are honest

test('/Schemas and /ServiceProviderConfig describe Group support', async () => {
  const schemas = await scimReq('GET', '/Schemas');
  assert.equal(schemas.status, 200);
  const ids = schemas.body.Resources.map(r => r.id);
  assert.ok(ids.includes('urn:ietf:params:scim:schemas:core:2.0:Group'), 'Group schema advertised');
  assert.equal(schemas.body.totalResults, schemas.body.Resources.length,
    'totalResults must match the resources actually returned');
  const group = schemas.body.Resources.find(r => r.id === 'urn:ietf:params:scim:schemas:core:2.0:Group');
  assert.ok(group.attributes.some(a => a.name === 'members' && a.multiValued));

  const spc = await scimReq('GET', '/ServiceProviderConfig');
  assert.equal(spc.body.patch.supported, true);
  assert.equal(spc.body.filter.maxResults, 200);
});

// /ResourceTypes is how an IdP asks "what kinds of thing does this server hold?"
// Some probe it during setup and read a 404 as a broken endpoint. RFC 7644 §4
// defines it; RFC 7643 §6 defines the resource it returns.
test('/ResourceTypes describes both Users and Groups, behind the same token gate', async () => {
  assert.equal((await scimReq('GET', '/ResourceTypes', { token: null })).status, 401,
    '/ResourceTypes must not be an unauthenticated hole in the token gate');

  const res = await scimReq('GET', '/ResourceTypes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
  assert.equal(res.body.totalResults, res.body.Resources.length,
    'totalResults must match the resources actually returned');

  const byId = Object.fromEntries(res.body.Resources.map(r => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['Group', 'User']);

  // RFC 7643 §6: `schema` MUST equal the id of the associated Schema resource.
  const advertised = (await scimReq('GET', '/Schemas')).body.Resources.map(r => r.id);
  for (const rt of res.body.Resources) {
    assert.deepEqual(rt.schemas, ['urn:ietf:params:scim:schemas:core:2.0:ResourceType']);
    assert.equal(rt.meta.resourceType, 'ResourceType');
    assert.ok(advertised.includes(rt.schema), `${rt.id}.schema must be a schema /Schemas serves`);
    for (const ext of rt.schemaExtensions || []) {
      assert.ok(advertised.includes(ext.schema), `${rt.id} extension must be a schema /Schemas serves`);
      assert.equal(typeof ext.required, 'boolean');
    }
  }
  assert.equal(byId.User.endpoint, '/Users');
  assert.equal(byId.Group.endpoint, '/Groups');
  assert.equal(byId.Group.schema, 'urn:ietf:params:scim:schemas:core:2.0:Group');

  // Same baseUrl convention as every other resource in this file.
  const { body: g } = await createGroup('Base URL Probe');
  const base = g.meta.location.replace(/\/Groups\/\d+$/, '');
  assert.equal(byId.Group.meta.location, base + '/ResourceTypes/Group');
  assert.equal(byId.User.meta.location, base + '/ResourceTypes/User');
});

test('/ResourceTypes refuses a filter and serves one type on its own', async () => {
  // RFC 7644 §4: "If a 'filter' is provided, the service provider SHOULD respond
  // with HTTP status code 403 (Forbidden) to ensure that clients cannot
  // incorrectly assume that any matching conditions specified in a filter are
  // true." Answering 200 with the full list is exactly that wrong assumption.
  const filtered = await scimReq('GET', '/ResourceTypes?filter=name%20eq%20%22Group%22');
  assert.equal(filtered.status, 403);

  // meta.location above points at /ResourceTypes/Group; it must resolve.
  const one = await scimReq('GET', '/ResourceTypes/Group');
  assert.equal(one.status, 200);
  assert.equal(one.body.id, 'Group');
  assert.equal(one.body.endpoint, '/Groups');
  assert.ok(!('Resources' in one.body), 'a single resource is not wrapped in a ListResponse');

  const missing = await scimReq('GET', '/ResourceTypes/Nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.status, '404', 'SCIM error status is a JSON string');
});

// ───────────────────────────────────── membership actually grants app access

test('a group grants app access only once a platform admin maps it to an app', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);

  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null },
    'membership alone grants nothing — the mapping is a separate, admin-owned decision');

  const mapped = await adminReq('PUT', `/groups/${g.id}/apps`, {
    key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'admin' }] },
  });
  assert.equal(mapped.status, 200);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: true, role: 'admin' });

  // The gates that actually decide access agree.
  const { requireAppUser, requireAppAccess } = await import('../server/middleware/auth.js');
  const { roleForUserOnApp } = await import('../server/services/permissions.js');
  const gate = (mw) => {
    let out = null;
    mw({ params: { slug: 'legal' }, user: { id: ALICE.id, role: 'user' } }, {}, (err) => { out = err ? (err.code || err.message) : 'allowed'; });
    return out;
  };
  assert.equal(gate(requireAppUser), 'allowed');
  assert.equal(gate(requireAppAccess), 'allowed');
  assert.equal(roleForUserOnApp({ id: ALICE.id, role: 'user' }, { id: APP_ID }), 'admin');

  // Removing her from the group takes it all back.
  await scimReq('PATCH', `/Groups/${g.id}`, { body: { Operations: [{ op: 'remove', path: `members[value eq "${ALICE.id}"]` }] } });
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null });
  assert.equal(gate(requireAppUser), 'FORBIDDEN');
});

test('deleting the group withdraws the access it was holding open', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id, BOB.id]);
  await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'user' }] } });
  assert.equal(rowsFor(APP_ID, BOB.id).member, true);

  await scimReq('DELETE', `/Groups/${g.id}`);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null });
  assert.deepEqual(rowsFor(APP_ID, BOB.id), { member: false, role: null });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_group_access').get().n, 0, 'the ledger is empty again');
});

test('the reconciler never revokes a grant an admin made directly', async () => {
  resetState();
  // Cara was assigned to the app by hand, before any group existed.
  db.prepare('INSERT INTO app_users (app_id,user_id) VALUES (?,?)').run(APP_ID, CARA.id);
  db.prepare('INSERT INTO app_user_roles (app_id,user_id,app_role) VALUES (?,?,?)').run(APP_ID, CARA.id, 'owner');

  const { body: g } = await createGroup('Legal Team', [CARA.id]);
  await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'user' }] } });
  assert.deepEqual(rowsFor(APP_ID, CARA.id), { member: true, role: 'owner' },
    "a group grant of 'user' must not downgrade a hand-set 'owner'");

  await scimReq('DELETE', `/Groups/${g.id}`);
  assert.deepEqual(rowsFor(APP_ID, CARA.id), { member: true, role: 'owner' },
    'the direct grant survives the group being deleted');
});

test('two groups on one app resolve to the highest tier, and drop back when one goes', async () => {
  resetState();
  const { body: low }  = await createGroup('Legal Readers', [ALICE.id]);
  const { body: high } = await createGroup('Legal Owners',  [ALICE.id]);
  await adminReq('PUT', `/groups/${low.id}/apps`,  { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'user' }] } });
  await adminReq('PUT', `/groups/${high.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'owner' }] } });
  assert.equal(rowsFor(APP_ID, ALICE.id).role, 'owner');

  await scimReq('DELETE', `/Groups/${high.id}`);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: true, role: 'user' },
    'losing the owner group drops to what the remaining group grants, not to nothing');

  await scimReq('DELETE', `/Groups/${low.id}`);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null });
});

test('re-mapping a group to a different app moves the access', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [BOB.id]);
  await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'user' }] } });
  assert.equal(rowsFor(APP_ID, BOB.id).member, true);

  await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'payroll', app_role: 'admin' }] } });
  assert.deepEqual(rowsFor(APP_ID, BOB.id), { member: false, role: null }, 'the old app grant is withdrawn');
  assert.deepEqual(rowsFor(APP2_ID, BOB.id), { member: true, role: 'admin' });
});

// ─────────────────────────── the mapping is platform-admin-only, not IdP-only

test('the group -> app mapping is unreachable with the SCIM token', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);

  // The SCIM bearer token authenticates the IdP, not a platform admin. If it
  // reached this route, whoever holds it could grant themselves any app.
  const viaScim = await fetch(`${BASE}/api/auth/scim/groups/${g.id}/apps`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${SCIM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apps: [{ slug: 'legal', app_role: 'owner' }] }),
  });
  assert.equal(viaScim.status, 401);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null });

  assert.equal((await adminReq('PUT', `/groups/${g.id}/apps`, { body: { apps: [] } })).status, 401,
    'anonymous is refused');
  assert.equal((await adminReq('PUT', `/groups/${g.id}/apps`, { key: ALICE.key, body: { apps: [] } })).status, 403,
    'a plain user is refused');
  assert.equal((await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLAIN_ADMIN.key, body: { apps: [] } })).status, 403,
    'a plain admin is refused — platform_admin only');
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null });
});

test('the admin mapping route validates its input', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id]);
  const put = (body) => adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body });

  assert.equal((await put({})).status, 400);
  assert.equal((await put({ apps: [{ slug: 'legal', app_role: 'none' }] })).status, 400,
    "'none' is app_user_roles' marker for non-membership — it cannot be a grant");
  assert.equal((await put({ apps: [{ slug: 'legal', app_role: 'platform_admin' }] })).status, 400);
  assert.equal((await put({ apps: [{ slug: 'no-such-app', app_role: 'user' }] })).status, 404);
  assert.deepEqual(rowsFor(APP_ID, ALICE.id), { member: false, role: null },
    'no partial mapping survived the rejected calls');

  assert.equal((await adminReq('PUT', '/groups/999999/apps', { key: PLATFORM.key, body: { apps: [] } })).status, 404);
});

test('GET /groups is platform-admin-only and reports members plus grants', async () => {
  resetState();
  const { body: g } = await createGroup('Legal Team', [ALICE.id, BOB.id]);
  await adminReq('PUT', `/groups/${g.id}/apps`, { key: PLATFORM.key, body: { apps: [{ slug: 'legal', app_role: 'admin' }] } });

  const denied = await adminReq('GET', '/groups', { key: PLAIN_ADMIN.key });
  assert.equal(denied.status, 403);
  assert.ok(!JSON.stringify(denied.body).includes('Legal Team'), 'the 403 leaks no group name');

  const ok = await adminReq('GET', '/groups', { key: PLATFORM.key });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.groups.length, 1);
  assert.equal(ok.body.groups[0].member_count, 2);
  assert.deepEqual(ok.body.groups[0].apps, [{ app_id: APP_ID, app_role: 'admin', slug: 'legal', name: 'Legal' }]);
});
