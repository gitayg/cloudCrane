import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

// ═══════════════════════════════════════════════════════════════════════════
// SCIM /Groups — IdP REPLAY SUITE
//
// READ THIS BEFORE READING ANY RESULT OF THIS FILE.
//
// This is a replay of payloads that Okta and Microsoft are DOCUMENTED to send.
// It is NOT traffic captured from a live tenant. Nobody has pointed a real
// Okta org or a real Entra tenant at this server. Every request body below was
// copied out of a vendor documentation page (or out of the RFC), and the only
// edit made to any of them is substituting the vendor's opaque example id for
// a real integer user/group id from this test's fixture — see `replay()`.
//
// A green run here means: "the bytes those vendors publish, we handle". It does
// NOT mean "Okta works" or "Entra works". Only a tenant proves that.
//
// Provenance of every payload constant, so a reader can re-check the bytes:
//   OKTA_*   https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/
//   ENTRA_*  https://learn.microsoft.com/en-us/entra/identity/app-provisioning/
//              use-scim-to-provision-users-and-groups   (default behaviour)
//            .../application-provisioning-config-problem-scim-compatibility
//              (the `aadOptscim062020` feature-flag shapes)
//   RFC_*    RFC 7644 §3.5.2.1 / §3.5.2.2, RFC 7643 §4.2
//
// The single most likely real-world break, and the reason this file exists:
// Entra's DEFAULT remove-member body is NOT a path filter. It is
// `"path": "members"` with the member in a `value` array. A server that only
// understands Okta's `members[value eq "..."]` either ignores the removal (the
// user keeps their access) or — worse, under a literal reading of RFC 7644
// §3.5.2.2 — treats bare `members` as "remove every member" and empties the
// group. Both failure modes are silent: the IdP logs a green sync.
// ═══════════════════════════════════════════════════════════════════════════

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-scimidp-'));
process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const { initDb, getDb } = await import('../server/db.js');
const { generateApiKey, hashApiKey } = await import('../server/services/encryption.js');
initDb();
const db = getDb();

const mkUser = (name) => {
  const key = generateApiKey('dhk_user');
  const id = db.prepare("INSERT INTO users (name,email,role,api_key_hash,active) VALUES (?,?,'user',?,1)")
    .run(name, `${name}@idp.test`, hashApiKey(key)).lastInsertRowid;
  return { id, key };
};

const ALICE = mkUser('alice');
const BOB   = mkUser('bob');
const CARA  = mkUser('cara');

const SCIM_TOKEN = generateApiKey('scim');
const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(k, v);
setSetting('scim_token_hash', hashApiKey(SCIM_TOKEN));
setSetting('scim_enabled', '1');

const scim = await import('../server/routes/scim.js');

// ── two servers, because the body parser is the thing under test ────────────
//
// PROD is READ OUT OF server/index.js at run time. It used to be a hand-copied
// literal, and that is exactly how this file lied: the copy still said
// `{ limit:'50mb' }` after production had been widened to accept the SCIM media
// type, so the media-type test stayed red against a parser configuration that no
// longer existed anywhere. A mirror of production that cannot track production
// is worse than no mirror, because it reports with full confidence.
//
// Deriving it also makes the test bidirectional: if someone later narrows the
// real parser back to `application/json`, this file goes red for the right
// reason instead of silently passing against a stale copy.
//
// WIDE is the same app with `application/scim+json` added unconditionally. Every
// payload test runs against WIDE so that a transport defect does not mask a
// semantics defect: if they all ran against PROD, one root cause would paint 20
// tests red and the vendor-shape findings would be invisible underneath it. The
// transport defect gets its own test instead. Now that production is fixed WIDE
// and PROD describe the same parser, and the media-type test proves it.
function prodParser() {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const m = /app\.use\(express\.json\((\{[\s\S]*?\})\)\)/.exec(src);
  assert.ok(m, 'could not find the express.json() body parser in server/index.js — '
    + 'this test derives production config from that line and must not silently '
    + 'fall back to a guess');
  return Function(`"use strict"; return (${m[1]});`)();
}
function mkServer(jsonOpts) {
  const app = express();
  app.use(express.json(jsonOpts));
  app.use('/api/scim/v2', scim.default);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}
const PROD_PARSER = prodParser();
const WIDE_PARSER = { limit: '50mb', type: ['application/json', 'application/scim+json'] };

const listen = async (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const prodServer = await listen(mkServer(PROD_PARSER));
const wideServer = await listen(mkServer(WIDE_PARSER));
after(() => {
  for (const s of [prodServer, wideServer]) { s.closeAllConnections?.(); s.unref(); s.close(); }
});
const PROD = `http://127.0.0.1:${prodServer.address().port}/api/scim/v2`;
const WIDE = `http://127.0.0.1:${wideServer.address().port}/api/scim/v2`;

/**
 * Fire a request the way an IdP fires it.
 *
 * `Content-Type: application/scim+json` is not a stylistic choice — it is what
 * both vendors send. Okta's SCIM guide and Entra's tutorial both specify the
 * SCIM media type, and RFC 7644 §3.1 registers it. Sending `application/json`
 * here would make this suite test a request no IdP actually sends.
 *
 * `raw` is a STRING, not an object, so a payload constant copied out of a
 * vendor doc goes onto the wire byte-for-byte (including `"$ref": null` and
 * the vendor's own whitespace) instead of being normalised by JSON.stringify
 * of a hand-retyped object literal.
 */
async function idp(method, path, { raw, token = SCIM_TOKEN, base = WIDE, contentType = 'application/scim+json' } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw !== undefined ? { 'Content-Type': contentType } : {}),
    },
    ...(raw !== undefined ? { body: raw } : {}),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { status: res.status, body, raw: text, contentType: res.headers.get('content-type') };
}

/**
 * Substitute a vendor's opaque example id for a real id from this fixture.
 *
 * This is the ONLY edit made to any vendor payload. It is a plain string
 * replacement on the JSON TEXT, so quoting, key order, whitespace, capital
 * `Remove`, and explicit `"$ref": null` all survive exactly as the vendor
 * prints them. Every substitution is spelled out at the call site so a reader
 * can diff this file against the vendor page.
 */
function replay(template, subs = {}) {
  let out = template;
  for (const [vendorId, realId] of Object.entries(subs)) {
    assert.ok(out.includes(vendorId), `replay(): "${vendorId}" is not in the payload — the template drifted`);
    out = out.split(vendorId).join(String(realId));
  }
  return out;
}

// ── payloads, verbatim ──────────────────────────────────────────────────────

// Okta, "Update group membership". Remove and add arrive in ONE Operations
// array; RFC 7644 §3.5.2 requires them applied in order, atomically.
const OKTA_REMOVE_THEN_ADD = `{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
        "op": "remove",
        "path": "members[value eq \\"89bb1940-b905-4575-9e7f-6f887cfb368e\\"]"
        },
        {
        "op": "add",
        "path": "members",
        "value": [{
            "value": "23a35c27-23d3-4c03-b4c5-6443c09e7173",
            "display": "test.user@okta.local"
        }]
    }]
}`;

// Okta group rename. No `path` at all, and the `value` object carries a
// read-only `id`. The Okta page notes this "triggers each time there's a group
// membership update operation" — so it arrives constantly, and rejecting the
// read-only `id` with a mutability error would break every membership change.
const OKTA_RENAME = `{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
        "op": "replace",
        "value": {
            "id": "abf4dd94-a4c0-4f67-89c9-76b03340cb9b",
            "displayName": "Test SCIMv2"
        }
    }]
}`;

// Okta PUT full-replacement, used by integrations built with the AIW rather
// than published to the OIN.
const OKTA_PUT_REPLACE = `{
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        "id":"e9e30dba-f08f-4109-8486-d5c6a331660a",
        "displayName": "Tour Guides",
        "members": [
        {
        "value": "some-member-1",
        "display": "Babs Jensen"
        },
        {
        "value": "some-member-2",
        "display": "Mandy Pepperidge"
        }
        ]
}`;

// ENTRA DEFAULT REMOVE — the divergence this whole file is about.
// Capital `Remove`; bare `members` path; the member id inside a `value` array;
// an explicit JSON `null` for `$ref` rather than an omitted key.
const ENTRA_REMOVE_DEFAULT = `{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
        "op": "Remove",
        "path": "members",
        "value": [{
            "$ref": null,
            "value": "f648f8d5ea4e4cd38e9c"
        }]
    }]
}`;

const ENTRA_ADD_DEFAULT = `{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
        "op": "Add",
        "path": "members",
        "value": [{
            "$ref": null,
            "value": "f648f8d5ea4e4cd38e9c"
        }]
    }]
}`;

// Entra remove, as printed on the SCIM-compatibility page under
// "Requests made to remove a group member" → "Without feature flag".
// Same shape as ENTRA_REMOVE_DEFAULT but with a short opaque id and no $ref.
const ENTRA_REMOVE_NO_FLAG = `{
  "schemas": [
      "urn:ietf:params:scim:api:messages:2.0:PatchOp"
  ],
  "Operations": [
      {
          "op": "Remove",
          "path": "members",
          "value": [
              {
                  "value": "u1091"
              }
          ]
      }
  ]
}`;

// Entra remove WITH the `aadOptscim062020` feature flag: the flag lowercases
// `op` and switches to the RFC path-filter form. Both shapes exist in the wild
// indefinitely — there is a documented downgrade flag (`AzureAdScimPatch2017`).
const ENTRA_REMOVE_WITH_FLAG = `{
  "schemas": [
      "urn:ietf:params:scim:api:messages:2.0:PatchOp"
  ],
  "Operations": [
      {
          "op": "remove",
          "path": "members[value eq \\"7f4bc1a3-285e-48ae-8202-5accb43efb0e\\"]"
      }
  ]
}`;

// Entra create-group. Two things a strict server rejects: a second,
// Microsoft-proprietary schema URN, and a client-supplied `meta` (readOnly per
// RFC 7643 §3.1).
const ENTRA_CREATE_GROUP = `{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group", "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group"],
    "externalId": "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
    "displayName": "displayName",
    "meta": {
        "resourceType": "Group"
    }
}`;

// Entra's rename shape is described on the tutorial page in prose — capital
// `Replace`, WITH `path: "displayName"`, scalar value — rather than printed as
// a literal body. This constant is therefore ASSEMBLED FROM THAT DESCRIPTION,
// not copied byte-for-byte from a vendor page. Flagged so nobody reads it as
// verbatim the way the constants above are.
const ENTRA_RENAME_ASSEMBLED = `{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
        "op": "Replace",
        "path": "displayName",
        "value": "Renamed By Entra"
    }]
}`;

// RFC 7644 §3.5.2.1's own add-member example. The `$ref` line is wrapped in the
// RFC's text; unwrapped here because the wrap is typesetting, not wire bytes.
const RFC_ADD_MEMBER = `{ "schemas":
   ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations":[
    {
     "op":"add",
     "path":"members",
     "value":[
      {
        "display": "Babs Jensen",
        "$ref": "https://example.com/v2/Users/2819c223-7f76-453a-919d-413861904646",
        "value": "2819c223-7f76-453a-919d-413861904646"
      }
     ]
    }
  ]
}`;

// ── fixture helpers ─────────────────────────────────────────────────────────

const J = (o) => JSON.stringify(o);
const memberIds = (g) => (g?.members || []).map(m => Number(m.value)).sort((a, b) => a - b);
const dbMemberIds = (gid) => db.prepare('SELECT user_id FROM scim_group_members WHERE group_id = ? ORDER BY user_id')
  .all(gid).map(r => r.user_id);
const groupCount = () => db.prepare('SELECT COUNT(*) n FROM scim_groups').get().n;

function reset() {
  db.prepare('DELETE FROM scim_group_members').run();
  db.prepare('DELETE FROM scim_groups').run();
  db.prepare('DELETE FROM scim_group_access').run();
  db.prepare('DELETE FROM app_users').run();
  db.prepare('DELETE FROM app_user_roles').run();
}

async function mkGroup(displayName, members = []) {
  const res = await idp('POST', '/Groups', {
    raw: J({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName,
      members: members.map(id => ({ value: String(id) })),
    }),
  });
  assert.equal(res.status, 201, `fixture setup failed: ${res.raw}`);
  return res.body;
}

// ═══════════════════════════════════════════ A. transport: the media type ═══

// RFC 7644 §3.1 registers `application/scim+json`, and both vendors send it.
// server/index.js:289 mounts `express.json({ limit: '50mb' })` and nothing
// else; express's default `type` is the exact string `application/json`, which
// does not match `application/scim+json`. When it does not match, express
// leaves `req.body` as `{}` — it does not error — so every SCIM write from a
// real IdP reaches the route with an empty body and is refused as malformed.
//
// This test runs against PROD (the exact production parser). Every other test
// in this file runs against WIDE, which adds the media type.
test('IdP media type: a create sent as application/scim+json is parsed', async () => {
  reset();
  const res = await idp('POST', '/Groups', {
    base: PROD,
    raw: J({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Media Type Probe', members: [] }),
  });
  assert.equal(res.status, 201,
    'a body sent with the SCIM media type must reach the route. A 400 here means '
    + "express.json() dropped it: server/index.js:289 accepts only 'application/json', "
    + "so EVERY POST/PUT/PATCH from Okta or Entra arrives with req.body = {}. "
    + `Got ${res.status}: ${res.raw}`);
});

// Control for the test above: the same request with `application/json` is
// accepted, which localises the failure to the media type rather than to the
// payload, the token, or the route.
test('IdP media type: the same body as application/json is accepted (control)', async () => {
  reset();
  const res = await idp('POST', '/Groups', {
    base: PROD,
    contentType: 'application/json',
    raw: J({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Media Type Control', members: [] }),
  });
  assert.equal(res.status, 201, res.raw);
});

// Entra's tutorial states it as a rule: "The header for all the responses
// should be of content-Type: application/scim+json".
test('IdP media type: responses are labelled application/scim+json', async () => {
  reset();
  await mkGroup('Response Type Probe');
  const res = await idp('GET', '/Groups');
  assert.equal(res.status, 200);
  assert.match(res.contentType || '', /application\/scim\+json/,
    `Entra requires responses labelled application/scim+json; got "${res.contentType}"`);
});

// ═════════════════════════════════════════════════ B. Okta replay ═══════════

test('Okta: remove + add arrive in one Operations array and both apply, in order', async () => {
  reset();
  const g = await mkGroup('Okta Combined', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(OKTA_REMOVE_THEN_ADD, {
      '89bb1940-b905-4575-9e7f-6f887cfb368e': ALICE.id,   // the removed member
      '23a35c27-23d3-4c03-b4c5-6443c09e7173': CARA.id,    // the added member
    }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected 200 or 204, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [BOB.id, CARA.id].sort((a, b) => a - b),
    'alice removed by the path filter, cara added, bob untouched');
});

test('Okta: rename is a pathless replace whose value carries a read-only id', async () => {
  reset();
  const g = await mkGroup('Okta Renamed Group', [ALICE.id]);

  // Okta sends this on EVERY membership change, and it always contains `id`.
  // Rejecting the read-only `id` with a mutability error would break the
  // integration outright, so the only correct handling is to ignore it.
  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(OKTA_RENAME, { 'abf4dd94-a4c0-4f67-89c9-76b03340cb9b': g.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `Okta's rename must not be refused; got ${res.status}: ${res.raw}`);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id = ?').get(g.id).d, 'Test SCIMv2');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'a rename must not disturb membership');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scim_groups WHERE id = ?').get(g.id).n, 1,
    "the read-only `id` in the value object must be ignored, not written");
});

test('Okta: PUT replaces displayName and the entire member list', async () => {
  reset();
  const g = await mkGroup('Okta PUT Target', [ALICE.id]);

  const res = await idp('PUT', `/Groups/${g.id}`, {
    raw: replay(OKTA_PUT_REPLACE, {
      'e9e30dba-f08f-4109-8486-d5c6a331660a': g.id,
      'some-member-1': BOB.id,
      'some-member-2': CARA.id,
    }),
  });

  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.displayName, 'Tour Guides');
  assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [BOB.id, CARA.id].sort((a, b) => a - b),
    'PUT is a full replacement: alice is gone, bob and cara are in');
});

// RFC 7644 §3.5.2.2, verbatim: "If the user was not a member of this group, no
// changes should be made to the resource, and a success response should be
// returned." A 404 here makes an IdP retry a removal forever.
test('Okta: removing someone who is not a member is a success, not a 404', async () => {
  reset();
  const g = await mkGroup('Okta Not A Member', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${CARA.id}"]` }],
    }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'the group is unchanged');
});

// Okta's documented query, verbatim from the guide (URL-decoded):
//   GET /scim/v2/Groups?filter=displayName eq "Test SCIMv2"&startIndex=1&count=100
// Okta's guide also states: "The itemsPerPage, startIndex, and totalResults
// values need to be exchanged as integers, not as strings."
test('Okta: displayName filter with integer pagination fields', async () => {
  reset();
  await mkGroup('Test SCIMv2', [ALICE.id]);
  await mkGroup('Some Other Group', [BOB.id]);

  const res = await idp('GET', '/Groups?filter=displayName%20eq%20%22Test%20SCIMv2%22&startIndex=1&count=100');
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
  assert.equal(res.body.totalResults, 1);
  assert.equal(res.body.Resources[0].displayName, 'Test SCIMv2');
  for (const field of ['totalResults', 'startIndex', 'itemsPerPage']) {
    assert.equal(typeof res.body[field], 'number', `${field} must be an integer, not a string (Okta guide)`);
  }
});

// ═════════════════════════════════════════════════ C. Entra replay ══════════

// THE HEADLINE CASE. Capital `Remove`, bare `"path": "members"`, member id in a
// `value` array, `"$ref": null`.
//
// Under a literal reading of RFC 7644 §3.5.2.2 — "If the target location is a
// multi-valued attribute and no filter is specified, the attribute and all
// values are removed" — this body means "empty the group". Entra means "remove
// this one member". The group starts with TWO members and must end with ONE.
// A 2 -> 0 result is the silent mass-deprovisioning this test exists to catch;
// a 2 -> 2 result is the silent non-deprovisioning.
test('Entra (default): bare-members remove takes ONLY the named member', async () => {
  reset();
  const g = await mkGroup('Entra Default Remove', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(ENTRA_REMOVE_DEFAULT, { f648f8d5ea4e4cd38e9c: ALICE.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [BOB.id],
    'Entra\'s default remove must remove exactly the member in `value`. '
    + `Got [${dbMemberIds(g.id)}] — an empty list means the group was WIPED (every `
    + 'member silently deprovisioned); [alice,bob] means the removal was ignored '
    + 'and the user keeps whatever the group grants.');
});

test('Entra (default): capital `Add` with $ref:null adds the named member', async () => {
  reset();
  const g = await mkGroup('Entra Default Add', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(ENTRA_ADD_DEFAULT, { f648f8d5ea4e4cd38e9c: BOB.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [ALICE.id, BOB.id].sort((a, b) => a - b),
    'capital `Add` must be matched case-insensitively (Entra emits Add/Replace/Remove) '
    + 'and `"$ref": null` must not be rejected as an invalid reference');
});

// The compatibility page's "Without feature flag" body. Structurally identical
// to ENTRA_REMOVE_DEFAULT, but the id is `u1091` — a short opaque handle that
// is NOT a decimal integer.
//
// This is fired VERBATIM, with no substitution, on purpose. It is the exact
// wire shape of a removal naming a member this server has never heard of. The
// RFC answer is "no change, success". The answer that must never happen is an
// emptied group: `value` was present, so the request is targeted, and no
// reading of it authorises removing anybody else.
test('Entra (no flag): a remove naming an unknown member must not empty the group', async () => {
  reset();
  const g = await mkGroup('Entra Unknown Member', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, { raw: ENTRA_REMOVE_NO_FLAG });

  assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [ALICE.id, BOB.id].sort((a, b) => a - b),
    'a targeted remove (a `value` array IS present) that names nobody this server '
    + 'knows must leave every existing member in place. An empty list here means '
    + 'one unrecognised member id silently deprovisions the whole group. '
    + `Server answered ${res.status}: ${res.raw}`);
  assert.notEqual(res.status, 500, 'an unparseable member id must not crash the route');
});

// Every vendor id in this file is an opaque hex-and-hyphen handle:
// `89bb1940-b905-4575-9e7f-6f887cfb368e`, `f648f8d5ea4e4cd38e9c`, `u1091`.
// AppCrane's ids are decimal integers, so an id in that shape can only ever
// mean "a member this server does not have".
//
// It must not be COERCED into one. `parseInt` stops at the first non-digit, so
// an id beginning with digits resolves to whichever local user happens to own
// that number — Okta's own printed example `23a35c27-...` reads as user 23, and
// `89bb1940-...` as user 89. The result is not a failed operation; it is a
// SUCCESSFUL operation on somebody the IdP never named, granting or revoking
// whatever apps the group maps to.
//
// The id below is byte-shaped exactly like Okta's, with the leading digits
// chosen to collide with a real fixture user so the coercion is observable.
test('member ids: an opaque IdP id must not be truncated into a local user id', async () => {
  reset();
  const opaque = `${CARA.id}f4bc1a3-285e-48ae-8202-5accb43efb0e`;
  assert.equal(parseInt(opaque, 10), CARA.id, 'fixture check: this id does truncate to cara');

  const g = await mkGroup('Coerced Add', [ALICE.id]);
  const added = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: opaque, display: 'someone.else@okta.local' }] }],
    }),
  });
  assert.equal(dbMemberIds(g.id).includes(CARA.id), false,
    `an add naming "${opaque}" must never enrol user ${CARA.id}. It did: `
    + `members=[${dbMemberIds(g.id)}], status ${added.status}. A user the IdP never `
    + 'named now holds every app this group grants.');
  assert.equal(added.status, 400, `an unresolvable member id is invalidValue, not success: ${added.raw}`);

  const g2 = await mkGroup('Coerced Remove', [ALICE.id, BOB.id, CARA.id]);
  const removed = await idp('PATCH', `/Groups/${g2.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${opaque}"]` }],
    }),
  });
  assert.equal(dbMemberIds(g2.id).includes(CARA.id), true,
    `a remove naming "${opaque}" must never deprovision user ${CARA.id}. `
    + `members=[${dbMemberIds(g2.id)}], status ${removed.status}.`);
});

// RFC 7644 §3.5.2.1, verbatim: "Unless other operations change the resource,
// this operation SHALL NOT change the modify timestamp of the resource."
// An IdP that sees lastModified move reads the group as changed and re-syncs;
// if every no-op resync moves it again, the loop does not settle.
test('RFC 7644 §3.5.2.1: a no-op add does not move meta.lastModified', async () => {
  reset();
  const g = await mkGroup('No-Op Timestamp', [ALICE.id]);
  // Backdate so the comparison cannot be hidden by datetime('now')'s
  // one-second granularity.
  db.prepare("UPDATE scim_groups SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(g.id);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: String(ALICE.id) }] }],
    }),
  });
  assert.ok(res.status === 200 || res.status === 204, res.raw);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'nothing actually changed');
  assert.equal(db.prepare('SELECT updated_at u FROM scim_groups WHERE id = ?').get(g.id).u, '2020-01-01 00:00:00',
    'an add of a member already present changed nothing, so the modify timestamp must not move');
});

test('Entra (aadOptscim062020): the path-filter remove form also works', async () => {
  reset();
  const g = await mkGroup('Entra Flagged Remove', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(ENTRA_REMOVE_WITH_FLAG, { '7f4bc1a3-285e-48ae-8202-5accb43efb0e': BOB.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id],
    'both Entra shapes must work — the flag is opt-in and there is a documented '
    + 'downgrade flag, so a tenant can be on either indefinitely');
});

test('Entra: rename is a capital `Replace` WITH a path and a scalar value', async () => {
  reset();
  const g = await mkGroup('Entra Rename Target', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, { raw: ENTRA_RENAME_ASSEMBLED });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id = ?').get(g.id).d, 'Renamed By Entra');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id]);
});

// Entra's create body carries a second, Microsoft-proprietary schema URN and a
// client-supplied `meta`. A `schemas` allowlist rejects the first; a schema
// validator that enforces `meta`'s readOnly mutability rejects the second.
// Either rejection means Entra can never create a group here at all.
test('Entra: create is accepted despite the Microsoft schema URN and inbound meta', async () => {
  reset();
  const res = await idp('POST', '/Groups', { raw: ENTRA_CREATE_GROUP });

  assert.equal(res.status, 201,
    `a strict schemas allowlist or a readOnly-meta check would 400 here: ${res.raw}`);
  assert.equal(res.body.displayName, 'displayName');
  assert.equal(res.body.externalId, '8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159',
    'externalId is how Entra re-finds a group it renamed; store and echo it verbatim');
  assert.deepEqual(res.body.schemas, ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    'echo back only the URNs actually implemented — the Microsoft URN is accepted, not adopted');
  assert.equal(res.body.meta.resourceType, 'Group');
});

// Entra's SCIM Validator, verbatim: "Return HTTP 201 on first create request /
// Return HTTP 409 on second create request". displayName uniqueness is an
// Entra requirement, not an RFC one (the core schema says uniqueness: none).
test('Entra: a duplicate group create is 409 with scimType uniqueness', async () => {
  reset();
  assert.equal((await idp('POST', '/Groups', { raw: ENTRA_CREATE_GROUP })).status, 201);

  // Identical payload, second time. externalId is also duplicated, exactly as
  // the validator's "identical payload" wording says.
  const dupe = await idp('POST', '/Groups', { raw: ENTRA_CREATE_GROUP });
  assert.equal(dupe.status, 409, `Entra's validator requires 409 on the second create: ${dupe.raw}`);
  assert.equal(dupe.body.scimType, 'uniqueness');
  assert.equal(groupCount(), 1, 'the refused create left no second row');
});

// Entra's documented reads, verbatim:
//   GET /Groups/{id}?excludedAttributes=members
//   GET /Groups?excludedAttributes=members&filter=displayName eq "displayName"
// Entra's own sample response omits the key rather than sending an empty array.
test('Entra: excludedAttributes=members omits the key entirely', async () => {
  reset();
  const g = await mkGroup('Entra Excluded', [ALICE.id, BOB.id]);

  const one = await idp('GET', `/Groups/${g.id}?excludedAttributes=members`);
  assert.equal(one.status, 200, one.raw);
  assert.equal('members' in one.body, false, 'the key is omitted, not sent as []');

  const listed = await idp('GET',
    '/Groups?excludedAttributes=members&filter=' + encodeURIComponent('displayName eq "Entra Excluded"'));
  assert.equal(listed.status, 200, listed.raw);
  assert.equal(listed.body.totalResults, 1);
  assert.equal('members' in listed.body.Resources[0], false);
});

// ══════════════════════════════════════════════ D. RFC 7644 semantics ═══════

test('RFC 7644 §3.5.2.1: the spec\'s own add-member example applies', async () => {
  reset();
  const g = await mkGroup('RFC Add Example');

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(RFC_ADD_MEMBER, { '2819c223-7f76-453a-919d-413861904646': ALICE.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id]);
});

// RFC 7644 §3.5.2.1, verbatim: "If the target location already contains the
// value specified, no changes SHOULD be made to the resource, and a success
// response SHOULD be returned." A 409 here puts an IdP into a retry loop.
test('RFC 7644 §3.5.2.1: re-adding an existing member is an idempotent success', async () => {
  reset();
  const g = await mkGroup('RFC Idempotent Add', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: replay(RFC_ADD_MEMBER, { '2819c223-7f76-453a-919d-413861904646': ALICE.id }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'no duplicate row');
});

// RFC 7644 §3.5.2, verbatim: "A PATCH request, regardless of the number of
// operations, SHALL be treated as atomic. If a single operation encounters an
// error condition, the original SCIM resource MUST be restored, and a failure
// status SHALL be returned."
//
// The first op is a rename that WOULD succeed on its own; the second is
// invalid. Neither may land.
test('RFC 7644 §3.5.2: one bad op rolls back every op in the request', async () => {
  reset();
  const g = await mkGroup('Atomic Original', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'displayName', value: 'SHOULD-BE-ROLLED-BACK' },
        { op: 'frobnicate', path: 'members' },
      ],
    }),
  });

  assert.equal(res.status, 400, `a failed op must return a failure status: ${res.raw}`);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id = ?').get(g.id).d, 'Atomic Original',
    'the rename in op 1 must be rolled back with the failure in op 2');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id]);
});

// Same invariant, in the direction that costs access rather than a name: a
// membership change followed by a bad op must not deprovision anyone.
test('RFC 7644 §3.5.2: a member removal is rolled back by a later bad op', async () => {
  reset();
  const g = await mkGroup('Atomic Members', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'remove', path: `members[value eq "${ALICE.id}"]` },
        { op: 'add', path: 'members', value: [{ value: '999999999' }] },
      ],
    }),
  });

  assert.equal(res.status, 400, `the second op names a user that does not exist: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [ALICE.id, BOB.id].sort((a, b) => a - b),
    'alice must still be a member — the whole request failed');
});

// RFC 7644 §3.5.2.2, verbatim: "If 'path' is unspecified, the operation fails
// with HTTP status code 400 and a 'scimType' error code of 'noTarget'."
// This is the one error code the RFC names exactly for /Groups.
test('RFC 7644 §3.5.2.2: remove with no path is 400 noTarget', async () => {
  reset();
  const g = await mkGroup('No Target', [ALICE.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove' }] }),
  });

  assert.equal(res.status, 400, res.raw);
  assert.equal(res.body.scimType, 'noTarget',
    "RFC 7644 §3.5.2.2 names this code exactly; a different scimType tells the IdP "
    + 'the wrong thing about why its request failed');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id]);
});

// RFC 7644 §3.5.2.2, verbatim: "If the target location is a multi-valued
// attribute and no filter is specified, the attribute and all values are
// removed". No `value`, bare path — this one really does mean "empty it".
test('RFC 7644 §3.5.2.2: bare members remove with NO value clears the attribute', async () => {
  reset();
  const g = await mkGroup('Clear All', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: 'members' }] }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [], 'no value present, so this is the RFC "remove all" case');
});

test('RFC 7644 §3.5.2.3: replace with no filter replaces the whole member list', async () => {
  reset();
  const g = await mkGroup('Replace All', [ALICE.id, BOB.id]);

  const res = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'members', value: [{ value: String(CARA.id) }] }],
    }),
  });

  assert.ok(res.status === 200 || res.status === 204, `expected success, got ${res.status}: ${res.raw}`);
  assert.deepEqual(dbMemberIds(g.id), [CARA.id]);
});

// RFC 7643 §2.1 / RFC 7644 §3.10: attribute names and ABNF strings are case
// insensitive. Whitespace inside a valuePath is also free-form. Entra's flagged
// form and Okta's form both arrive as `eq`, but nothing in the grammar forbids
// `EQ`, and a regex written without /i silently stops matching removals.
test('RFC ABNF: the path filter matches case-insensitively and tolerates whitespace', async () => {
  reset();
  for (const path of [
    `members[value EQ "%ID%"]`,
    `members[ value eq "%ID%" ]`,
    `MEMBERS[value eq "%ID%"]`,
  ]) {
    const g = await mkGroup(`Filter Shape ${path.length}-${path[0]}`, [ALICE.id, BOB.id]);
    const res = await idp('PATCH', `/Groups/${g.id}`, {
      raw: J({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: path.replace('%ID%', String(ALICE.id)) }],
      }),
    });
    assert.ok(res.status === 200 || res.status === 204, `${path} -> ${res.status}: ${res.raw}`);
    assert.deepEqual(dbMemberIds(g.id), [BOB.id], `${path} must remove exactly alice`);
  }
});

// ═══════════════════════════════════════════════════ E. negative cases ══════

test('negative: no token is 401 on every /Groups verb, and nothing changed', async () => {
  reset();
  const g = await mkGroup('Token Gate', [ALICE.id]);
  const before = groupCount();

  const calls = [
    ['GET',    '/Groups', undefined],
    ['GET',    `/Groups/${g.id}`, undefined],
    ['POST',   '/Groups', J({ displayName: 'Injected' })],
    ['PUT',    `/Groups/${g.id}`, J({ displayName: 'Renamed' })],
    ['PATCH',  `/Groups/${g.id}`, replay(ENTRA_REMOVE_DEFAULT, { f648f8d5ea4e4cd38e9c: ALICE.id })],
    ['DELETE', `/Groups/${g.id}`, undefined],
  ];
  for (const [method, path, raw] of calls) {
    const res = await idp(method, path, { raw, token: null });
    assert.equal(res.status, 401, `${method} ${path} without a token must be 401, got ${res.status}`);
    assert.ok(!res.raw.includes('Token Gate'), `${method} ${path}: the 401 must not leak group names`);
  }
  assert.equal(groupCount(), before, 'no group created or deleted by the refused calls');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'the refused PATCH removed nobody');
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id = ?').get(g.id).d, 'Token Gate');
});

test('negative: a wrong bearer token is 401 on every /Groups verb', async () => {
  reset();
  const g = await mkGroup('Wrong Token', [ALICE.id]);
  const bad = 'scim_' + 'z'.repeat(32);

  for (const [method, path, raw] of [
    ['GET',    '/Groups', undefined],
    ['GET',    `/Groups/${g.id}`, undefined],
    ['POST',   '/Groups', J({ displayName: 'Injected' })],
    ['PATCH',  `/Groups/${g.id}`, replay(ENTRA_REMOVE_DEFAULT, { f648f8d5ea4e4cd38e9c: ALICE.id })],
    ['DELETE', `/Groups/${g.id}`, undefined],
  ]) {
    assert.equal((await idp(method, path, { raw, token: bad })).status, 401, `${method} ${path}`);
  }
  assert.equal(groupCount(), 1);
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id]);
});

// RFC 7644 §3.12: the error body's `status` is "The HTTP status code ...
// expressed as a JSON string." Entra's rule is that `id` is required on every
// resource response; a 404 is not a resource, and must be an Error object.
test('negative: an unknown group id is 404 on every verb, with a string status', async () => {
  reset();
  const missing = '/Groups/987654321';

  const get = await idp('GET', missing);
  assert.equal(get.status, 404);
  assert.deepEqual(get.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  assert.equal(get.body.status, '404', 'SCIM error status is a JSON string, not a number');
  assert.equal(typeof get.body.status, 'string');

  assert.equal((await idp('DELETE', missing)).status, 404);
  assert.equal((await idp('PUT', missing, { raw: J({ displayName: 'x' }) })).status, 404);
  assert.equal((await idp('PATCH', missing, {
    raw: replay(ENTRA_REMOVE_DEFAULT, { f648f8d5ea4e4cd38e9c: ALICE.id }),
  })).status, 404);
});

// The RFC does not name this case, so `invalidValue` is the closest-fitting
// code rather than a citation. What is NOT defensible under any reading is a
// 500, or a 2xx that stores a dangling member id the group then grants access
// through.
test('negative: a member referencing a nonexistent user is refused, not stored', async () => {
  reset();
  const g = await mkGroup('Ghost Member', [ALICE.id]);

  const patched = await idp('PATCH', `/Groups/${g.id}`, {
    raw: J({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: '987654321', display: 'ghost@idp.test' }] }],
    }),
  });
  assert.equal(patched.status, 400, patched.raw);
  assert.equal(patched.body.scimType, 'invalidValue');
  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'no dangling member row');

  const created = await idp('POST', '/Groups', {
    raw: J({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Ghosts', members: [{ value: '987654321' }] }),
  });
  assert.equal(created.status, 400, created.raw);
  assert.equal(groupCount(), 1, 'the group was not half-created');
});

test('negative: a duplicate displayName is 409 uniqueness and does not overwrite', async () => {
  reset();
  const g = await mkGroup('Finance', [ALICE.id]);
  await mkGroup('Legal', [BOB.id]);

  const dupe = await idp('POST', '/Groups', {
    raw: J({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Finance' }),
  });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.scimType, 'uniqueness');
  assert.equal(groupCount(), 2);

  // Renaming onto a taken name must be refused too, and must not half-apply.
  const collide = await idp('PATCH', `/Groups/${g.id}`, { raw: ENTRA_RENAME_ASSEMBLED.replace('Renamed By Entra', 'Legal') });
  assert.equal(collide.status, 409, collide.raw);
  assert.equal(db.prepare('SELECT display_name d FROM scim_groups WHERE id = ?').get(g.id).d, 'Finance');
});

// §6.4 N8: "expect invalidPath or invalidFilter -- NOT a 500, and NOT a silent
// no-op". A silent no-op is the dangerous half: the IdP records the removal as
// done and stops retrying, while the member keeps their access.
test('negative: a malformed path filter is refused, not silently ignored', async () => {
  reset();

  // Every shape is exercised and the verdicts collected, so one failure does
  // not hide the others.
  const verdicts = [];
  const shapes = [
    'members[value eq unquoted]',            // the quotes are part of the ABNF
    'members[value eq "not-a-user"]',        // well-formed filter, unresolvable id
    'members[display eq "alice@idp.test"]',  // a sub-attribute this server does not index
  ];

  for (const path of shapes) {
    const g = await mkGroup(`Malformed ${shapes.indexOf(path)}`, [ALICE.id, BOB.id]);
    const res = await idp('PATCH', `/Groups/${g.id}`, {
      raw: J({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path }] }),
    });

    assert.notEqual(res.status, 500, `${path} must not crash the route: ${res.raw}`);
    assert.deepEqual(dbMemberIds(g.id).sort((a, b) => a - b), [ALICE.id, BOB.id].sort((a, b) => a - b),
      `${path} must not remove anybody`);

    if (res.status === 200 || res.status === 204) {
      verdicts.push(`${path} -> ${res.status} having changed nothing (SILENT NO-OP)`);
    } else if (res.status !== 400) {
      verdicts.push(`${path} -> ${res.status}, expected 400`);
    } else if (!['invalidPath', 'invalidFilter'].includes(res.body?.scimType)) {
      verdicts.push(`${path} -> 400 but scimType ${res.body?.scimType}, expected invalidPath/invalidFilter`);
    }
  }

  assert.deepEqual(verdicts, [],
    'A filter this server cannot evaluate must be refused. Answering 200 is the '
    + 'dangerous half: the IdP records the removal as applied and never retries, so '
    + 'the member keeps every app the group grants.\n  ' + verdicts.join('\n  '));
});

test('negative: a malformed PATCH envelope is refused', async () => {
  reset();
  const g = await mkGroup('Envelope', [ALICE.id]);

  // No Operations at all.
  assert.equal((await idp('PATCH', `/Groups/${g.id}`, { raw: J({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] }) })).status, 400);
  // Operations present but empty — RFC 7644 §3.5.2 requires "one or more".
  assert.equal((await idp('PATCH', `/Groups/${g.id}`, { raw: J({ Operations: [] }) })).status, 400);
  // An op with no `op` member.
  assert.equal((await idp('PATCH', `/Groups/${g.id}`, { raw: J({ Operations: [{ path: 'members' }] }) })).status, 400);
  // An op verb outside add/remove/replace.
  assert.equal((await idp('PATCH', `/Groups/${g.id}`, { raw: J({ Operations: [{ op: 'frobnicate', path: 'members' }] }) })).status, 400);

  assert.deepEqual(dbMemberIds(g.id), [ALICE.id], 'none of the refused envelopes changed membership');
});
