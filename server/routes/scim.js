/**
 * SCIM 2.0 — User and Group provisioning for Okta (and other IdPs).
 *
 * Supported endpoints:
 *   GET    /api/scim/v2/ServiceProviderConfig
 *   GET    /api/scim/v2/Schemas
 *   GET    /api/scim/v2/ResourceTypes      (list)
 *   GET    /api/scim/v2/ResourceTypes/:id  (User or Group)
 *   GET    /api/scim/v2/Users          (list + filter)
 *   POST   /api/scim/v2/Users          (create)
 *   GET    /api/scim/v2/Users/:id      (get)
 *   PUT    /api/scim/v2/Users/:id      (replace)
 *   PATCH  /api/scim/v2/Users/:id      (partial update — active flag, name, etc.)
 *   DELETE /api/scim/v2/Users/:id      (hard delete)
 *   GET    /api/scim/v2/Groups         (list + filter)
 *   POST   /api/scim/v2/Groups         (create)
 *   GET    /api/scim/v2/Groups/:id     (get)
 *   PUT    /api/scim/v2/Groups/:id     (replace — displayName + full member list)
 *   PATCH  /api/scim/v2/Groups/:id     (add/remove member, rename)
 *   DELETE /api/scim/v2/Groups/:id     (delete)
 *
 * Auth: Bearer token. Generate via POST /api/auth/scim/token (admin only).
 *
 * GROUPS GRANT NOTHING BY THEMSELVES. Membership is what the IdP pushes; what a
 * group is WORTH is a separate, platform-admin-only mapping (group -> app +
 * app_role) written through /api/auth/scim/groups/:id/apps. See
 * migration 084 for why the two halves are deliberately not the same table.
 */

import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { getDb } from '../db.js';
import { hashApiKey, generateApiKey, hashPassword } from '../services/encryption.js';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth.js';
import { reconcileGroupAccess } from '../services/scimGroupAccess.js';
import log from '../utils/logger.js';

const router = Router();

// RFC 7644 §3.1 registers `application/scim+json`, and Entra states it as a
// rule: "The header for all the responses should be of content-Type:
// application/scim+json". Set on this router only — the platform's other
// routes keep express's `application/json` default. `res.json()` fills in a
// Content-Type only when one is not already set, so this wins without every
// route having to say so.
const SCIM_MEDIA_TYPE = 'application/scim+json';
router.use((_req, res, next) => {
  res.type(SCIM_MEDIA_TYPE);
  next();
});

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const SCIM_LIST_SCHEMA  = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCIM_RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';

// v2.18.0: pull directory attributes AppCrane inherits from the IdP:
//   department ← enterprise extension `department`
//   region     ← primary/first address `region`   (state / province)
//   location   ← primary/first address `locality` (city / office)
// Accepts a SCIM resource body OR a PatchOp value object; both put the
// enterprise fields under the extension URN and addresses on the core object.
function directoryAttrs(src) {
  if (!src || typeof src !== 'object') return {};
  const ent = src[SCIM_ENTERPRISE_SCHEMA] || {};
  const addrs = Array.isArray(src.addresses) ? src.addresses : [];
  const addr = addrs.find(a => a && a.primary) || addrs[0] || {};
  const out = {};
  if (ent.department !== undefined) out.department = ent.department || null;
  if (addr.region !== undefined) out.region = addr.region || null;
  if (addr.locality !== undefined) out.location = addr.locality || null;
  return out;
}

// ---------------------------------------------------------------------------
// Auth middleware — Bearer token verified against stored hash
// ---------------------------------------------------------------------------
function requireScimToken(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json(scimError(401, 'Unauthorized'));

  const db  = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scim_token_hash'").get();
  const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'scim_enabled'").get();

  if (!enabledRow || enabledRow.value !== '1') {
    return res.status(403).json(scimError(403, 'SCIM provisioning is not enabled'));
  }
  const storedHash = row ? Buffer.from(row.value, 'utf8') : null;
  const tokenHash  = Buffer.from(hashApiKey(token), 'utf8');
  if (!row || !timingSafeEqual(storedHash, tokenHash)) {
    return res.status(401).json(scimError(401, 'Invalid SCIM token'));
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// `scimType` is optional and only meaningful on a 400 (RFC 7644 §3.12). Every
// pre-existing caller passes two arguments and keeps its exact old shape.
function scimError(status, detail, scimType) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    ...(scimType ? { scimType } : {}),
    status: String(status),
    detail,
  };
}

function baseUrl(req) {
  return (process.env.CRANE_DOMAIN
    ? 'https://' + process.env.CRANE_DOMAIN
    : 'http://' + req.headers.host) + '/api/scim/v2';
}

function toScimUser(u, req) {
  const nameParts = (u.name || '').trim().split(/\s+/);
  const givenName  = nameParts[0] || '';
  const familyName = nameParts.slice(1).join(' ') || '';
  const hasAddress = u.region || u.location;
  return {
    schemas: hasAddress || u.department
      ? [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_SCHEMA]
      : [SCIM_USER_SCHEMA],
    id:         String(u.id),
    externalId: u.scim_external_id || undefined,
    userName:   u.email || u.username || String(u.id),
    name: {
      formatted:  u.name || '',
      givenName,
      familyName,
    },
    emails: u.email ? [{ value: u.email, primary: true, type: 'work' }] : [],
    ...(hasAddress ? { addresses: [{ region: u.region || undefined, locality: u.location || undefined, primary: true, type: 'work' }] } : {}),
    ...(u.department ? { [SCIM_ENTERPRISE_SCHEMA]: { department: u.department } } : {}),
    active: u.active !== 0,
    meta: {
      resourceType:  'User',
      created:       u.created_at ? u.created_at.replace(' ', 'T') + 'Z' : undefined,
      lastModified:  u.created_at ? u.created_at.replace(' ', 'T') + 'Z' : undefined,
      location:      baseUrl(req) + '/Users/' + u.id,
    },
  };
}

// Minimal SCIM filter parser — handles what Okta actually sends:
//   userName eq "value"
//   externalId eq "value"
//   id eq "value"
function parseFilter(filter) {
  if (!filter) return null;
  const m = filter.match(/^(\w+)\s+eq\s+"([^"]*)"$/i);
  if (!m) return null;
  return { attr: m[1].toLowerCase(), value: m[2] };
}

function applyUpdateToUser(db, id, attrs) {
  const updates = [];
  const values  = [];

  if (attrs.name !== undefined) {
    const formatted = attrs.name.formatted
      || [attrs.name.givenName, attrs.name.familyName].filter(Boolean).join(' ')
      || '';
    if (formatted) { updates.push('name = ?'); values.push(formatted); }
  }
  if (attrs.userName !== undefined) {
    updates.push('email = ?'); values.push(attrs.userName);
  }
  if (attrs.emails !== undefined) {
    const primary = (attrs.emails || []).find(e => e.primary) || attrs.emails[0];
    if (primary?.value) { updates.push('email = ?'); values.push(primary.value); }
  }
  if (attrs.active !== undefined) {
    updates.push('active = ?'); values.push(attrs.active ? 1 : 0);
    // Expire sessions of deactivated users immediately
    if (!attrs.active) {
      db.prepare("DELETE FROM identity_sessions WHERE user_id = ?").run(id);
    }
  }
  if (attrs.externalId !== undefined) {
    updates.push('scim_external_id = ?'); values.push(attrs.externalId);
  }
  // v2.18.0: department + address (region/locality) from the IdP.
  const dir = directoryAttrs(attrs);
  if (dir.department !== undefined) { updates.push('department = ?'); values.push(dir.department); }
  if (dir.region     !== undefined) { updates.push('region = ?');     values.push(dir.region); }
  if (dir.location   !== undefined) { updates.push('location = ?');   values.push(dir.location); }

  if (updates.length) {
    values.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
}

// ---------------------------------------------------------------------------
// Groups — helpers
// ---------------------------------------------------------------------------

// SCIM-visible users are exactly the ones GET /Users lists: role = 'user'.
// Group membership uses the same population on purpose. If it did not, the IdP
// could put a platform_admin's account into a group and, through the
// group -> app mapping, hand that account an app tier — using a credential
// whose whole scope is supposed to be "the plain users I provision". A member
// the IdP cannot GET from /Users has no business appearing in /Groups either.
/**
 * Convert an id received on the wire into a LOCAL row id — totally, or not at all.
 *
 * `parseInt` stops at the first non-digit, so every opaque IdP handle collides
 * with a real local row: Okta's own printed example `23a35c27-23d3-…` reads as
 * 23, `89bb1940-…` as 89, `u1091` as NaN. That is not a failed lookup, it is a
 * SUCCESSFUL operation on somebody the IdP never named — a user nobody asked
 * for gains (or loses) every app the group grants.
 *
 * Anything that is not exactly a positive decimal integer returns null and the
 * caller must refuse the request. There is no coercion path.
 */
function toLocalId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Route parameters arrive as strings and address a single row. `/Groups/23abc`
// must be a 404, never group 23.
function pathId(req) {
  return toLocalId(req.params.id);
}

function scimVisibleUser(db, id) {
  if (!Number.isInteger(id)) return null;
  return db.prepare("SELECT id, email, name, username FROM users WHERE id = ? AND role = 'user'").get(id);
}

function groupMembers(db, groupId) {
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.username
      FROM scim_group_members gm
      JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ?
     ORDER BY u.id
  `).all(groupId);
}

function toScimGroup(g, req, { members = null } = {}) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id:          String(g.id),
    displayName: g.display_name,
    externalId:  g.external_id || undefined,
    ...(members === null ? {} : {
      members: members.map(m => ({
        value:   String(m.id),
        display: m.email || m.username || m.name || String(m.id),
        $ref:    baseUrl(req) + '/Users/' + m.id,
        type:    'User',
      })),
    }),
    meta: {
      resourceType: 'Group',
      created:      g.created_at ? g.created_at.replace(' ', 'T') + 'Z' : undefined,
      lastModified: (g.updated_at || g.created_at) ? (g.updated_at || g.created_at).replace(' ', 'T') + 'Z' : undefined,
      location:     baseUrl(req) + '/Groups/' + g.id,
    },
  };
}

// Entra asks for the member list to be left out of list responses on large
// directories; Okta accepts its absence. Honour the standard query parameter
// rather than always paying for the join.
function membersExcluded(req) {
  const ex = String(req.query.excludedAttributes || '').toLowerCase();
  return ex.split(',').map(s => s.trim()).includes('members');
}

function touchGroup(db, id) {
  db.prepare("UPDATE scim_groups SET updated_at = datetime('now') WHERE id = ?").run(id);
}

// externalId carries a UNIQUE index (a second group claiming one IdP identifier
// would make `filter=externalId eq "..."` ambiguous). Checked in the route so
// the collision is a SCIM 409 rather than a raw SQLITE_CONSTRAINT surfacing as
// a 500 that tells the IdP nothing.
function externalIdTaken(db, externalId, exceptId = null) {
  if (externalId === null || externalId === undefined || externalId === '') return false;
  return !!db.prepare('SELECT id FROM scim_groups WHERE external_id = ? AND id IS NOT ?')
    .get(String(externalId), exceptId);
}

/**
 * Pull member ids out of a PATCH/PUT/POST member list.
 *
 * IdPs send all of these for the same intent:
 *   value: [{ value: "7" }, { value: "8" }]     (Okta, Entra — the usual form)
 *   value: { value: "7" }                       (single member, unwrapped)
 *   value: "7"                                  (seen from smaller IdPs)
 *
 * Returns BOTH the ids that resolved and the raw references that did not.
 * Dropping the unresolvable ones on the floor is what turns "remove the member
 * you have never heard of" into "remove nobody, report success" — or, when the
 * list is then read as empty, into "remove everybody".
 */
function memberRefsFromValue(value) {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const ids = [];
  const invalid = [];
  for (const entry of list) {
    const raw = entry && typeof entry === 'object' ? entry.value : entry;
    const id  = toLocalId(raw);
    if (id === null) invalid.push(raw === undefined ? '(missing)' : String(raw));
    else ids.push(id);
  }
  return { ids, invalid, present: list.length > 0 };
}

// `members[value eq "7"]` — the value-path filter form. This is what Okta
// sends to remove one person from a group, and it is the single shape
// hand-rolled SCIM servers most often get wrong: the naive `path === 'members'`
// comparison does not match it, the op falls through unhandled, the server
// answers 200, and the IdP records the removal as done while the member is
// still there and still holding whatever the group grants.
const MEMBER_PATH_FILTER = /^members\s*\[\s*value\s+eq\s+"?([^"\]\s]+)"?\s*\]$/i;

/**
 * null              — not a members value-path at all (the caller falls through)
 * { id }            — a members value-path naming a resolvable local id
 * { invalid: raw }  — a members value-path this server cannot evaluate
 *
 * The third case must never collapse into the second. `parseInt` used to make
 * `members[value eq unquoted]` and `members[value eq "not-a-user"]` produce NaN,
 * which then deleted nothing and answered 200: the IdP marks the removal as
 * applied, never retries, and the member keeps their access forever.
 */
function parseMemberPath(path) {
  const m = String(path ?? '').match(MEMBER_PATH_FILTER);
  if (!m) return null;
  const id = toLocalId(m[1]);
  return id === null ? { invalid: m[1] } : { id };
}

// ---------------------------------------------------------------------------
// ServiceProviderConfig
// ---------------------------------------------------------------------------
router.get('/ServiceProviderConfig', requireScimToken, (req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: baseUrl(req).replace('/api/scim/v2', '/docs'),
    patch:  { supported: true },
    bulk:   { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    // `filter.supported` is a real claim now. The parser handles a single
    // `attr eq "value"` term and nothing else; anything else is answered with
    // 400 / invalidFilter rather than being dropped and replied to with an
    // unfiltered list. maxResults matches the `count` clamp on the list routes.
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort:   { supported: false },
    etag:   { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication scheme using the OAuth Bearer Token standard',
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: baseUrl(req) + '/ServiceProviderConfig' },
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
router.get('/Schemas', requireScimToken, (req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 3,
    Resources: [{
      id: SCIM_USER_SCHEMA,
      name: 'User',
      description: 'User Account',
      attributes: [
        { name: 'userName',  type: 'string',  required: true,  uniqueness: 'server' },
        { name: 'name',      type: 'complex', required: false },
        { name: 'emails',    type: 'complex', required: false, multiValued: true },
        { name: 'active',    type: 'boolean', required: false },
        { name: 'externalId', type: 'string', required: false },
        // v2.18.0: physical address — region (state) + locality (city) are inherited.
        { name: 'addresses', type: 'complex', required: false, multiValued: true },
      ],
    }, {
      // v2.18.0: enterprise extension — AppCrane reads `department`.
      id: SCIM_ENTERPRISE_SCHEMA,
      name: 'EnterpriseUser',
      description: 'Enterprise User',
      attributes: [
        { name: 'department', type: 'string', required: false },
      ],
    }, {
      id: SCIM_GROUP_SCHEMA,
      name: 'Group',
      description: 'Group. Membership is provisioned by the IdP; what a group '
        + 'grants inside AppCrane is configured separately by a platform admin.',
      attributes: [
        { name: 'displayName', type: 'string',  required: true,  uniqueness: 'server' },
        { name: 'externalId',  type: 'string',  required: false },
        { name: 'members',     type: 'complex', required: false, multiValued: true,
          subAttributes: [
            { name: 'value',   type: 'string', required: true },
            { name: 'display', type: 'string', required: false, mutability: 'readOnly' },
            { name: 'type',    type: 'string', required: false },
          ] },
      ],
    }],
  });
});

// ---------------------------------------------------------------------------
// ResourceTypes
//
// RFC 7644 §4: "An HTTP GET to this endpoint is used to discover the types of
// resources available on a SCIM service provider (e.g., Users and Groups)."
// Neither Okta nor Entra requires it, but some clients probe it during setup
// and read the HTML 404 that Express serves for an unrouted path as evidence
// that the whole base URL is wrong.
//
// The resource shape is RFC 7643 §6: `schema` MUST equal the id of a Schema
// this server actually serves, so the entries below are built from the same
// constants /Schemas publishes rather than hand-typed URNs that could drift.
// ---------------------------------------------------------------------------
function resourceTypes(req) {
  const at = id => ({
    resourceType: 'ResourceType',
    location: baseUrl(req) + '/ResourceTypes/' + id,
  });
  return [{
    schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
    id:          'User',
    name:        'User',
    endpoint:    '/Users',
    description: 'User Account',
    schema:      SCIM_USER_SCHEMA,
    // `required: false` — AppCrane reads `department` off the enterprise
    // extension when it is sent, and provisions the user fine when it is not.
    schemaExtensions: [{ schema: SCIM_ENTERPRISE_SCHEMA, required: false }],
    meta: at('User'),
  }, {
    schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
    id:          'Group',
    name:        'Group',
    endpoint:    '/Groups',
    description: 'Group. Membership is provisioned by the IdP; what a group '
      + 'grants inside AppCrane is configured separately by a platform admin.',
    schema:      SCIM_GROUP_SCHEMA,
    meta: at('Group'),
  }];
}

router.get('/ResourceTypes', requireScimToken, (req, res) => {
  // RFC 7644 §4: filtering and pagination "SHALL be ignored", and a `filter`
  // SHOULD be answered with 403 "to ensure that clients cannot incorrectly
  // assume that any matching conditions specified in a filter are true".
  if (req.query.filter) {
    return res.status(403).json(scimError(403, 'Filtering is not supported on /ResourceTypes'));
  }
  const rts = resourceTypes(req);
  res.json({
    schemas:      [SCIM_LIST_SCHEMA],
    totalResults: rts.length,
    startIndex:   1,
    itemsPerPage: rts.length,
    Resources:    rts,
  });
});

// A single ResourceType, "returned in the same way that a single User or Group
// is retrieved" (RFC 7644 §4). This is the URL each entry's meta.location
// advertises, so it has to resolve.
router.get('/ResourceTypes/:id', requireScimToken, (req, res) => {
  const found = resourceTypes(req).find(rt => rt.id.toLowerCase() === String(req.params.id).toLowerCase());
  if (!found) return res.status(404).json(scimError(404, `ResourceType not found: ${req.params.id}`));
  res.json(found);
});

// ---------------------------------------------------------------------------
// GET /Users — list with optional filter + pagination
// ---------------------------------------------------------------------------
router.get('/Users', requireScimToken, (req, res) => {
  const db = getDb();
  const startIndex = Math.max(1, parseInt(req.query.startIndex) || 1);
  const count      = Math.min(200, Math.max(1, parseInt(req.query.count) || 100));
  const filter     = parseFilter(req.query.filter);

  let query  = "SELECT * FROM users WHERE role = 'user'";
  const args = [];

  // An unparseable or unrecognised filter is REFUSED, not ignored.
  //
  // Ignoring it is what this route used to do, and it is worse than it looks:
  // the reply to `filter=userName eq "a" and active eq true` was the whole
  // user list with HTTP 200, which an IdP reads as "yes, that user exists, and
  // here is the id" — Resources[0], i.e. an arbitrary other person. Okta then
  // links its user record to that account and provisions onto it. RFC 7644
  // §3.4.2.2 says to answer 400 with scimType 'invalidFilter', which also stops
  // ServiceProviderConfig's `filter.supported: true` from being a claim about
  // filters this parser cannot actually evaluate.
  if (req.query.filter && !filter) {
    return res.status(400).json(scimError(400, `Unsupported filter: ${req.query.filter}`, 'invalidFilter'));
  }
  if (filter) {
    if (filter.attr === 'username' || filter.attr === 'email') {
      query += ' AND (email = ? OR username = ?)'; args.push(filter.value, filter.value);
    } else if (filter.attr === 'externalid') {
      query += ' AND scim_external_id = ?'; args.push(filter.value);
    } else if (filter.attr === 'id') {
      if (toLocalId(filter.value) === null) {
        return res.status(400).json(scimError(400, `Unusable id in filter: ${filter.value}`, 'invalidFilter'));
      }
      query += ' AND id = ?'; args.push(toLocalId(filter.value));
    } else {
      return res.status(400).json(scimError(400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter'));
    }
  }

  const total = db.prepare(query.replace('SELECT *', 'SELECT COUNT(*) as n')).get(...args).n;
  const rows  = db.prepare(query + ' ORDER BY id LIMIT ? OFFSET ?').all(...args, count, startIndex - 1);

  res.json({
    schemas:      [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources:    rows.map(u => toScimUser(u, req)),
  });
});

// ---------------------------------------------------------------------------
// POST /Users — create user
// ---------------------------------------------------------------------------
router.post('/Users', requireScimToken, (req, res) => {
  const db   = getDb();
  const body = req.body;

  const email = (body.emails?.find(e => e.primary)?.value) || body.emails?.[0]?.value || body.userName;
  const name  = body.name?.formatted
    || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ')
    || email;

  if (!email) return res.status(400).json(scimError(400, 'userName or emails required'));

  // Check for existing user by email or externalId
  const existing = db.prepare('SELECT * FROM users WHERE email = ? OR scim_external_id = ?').get(email, body.externalId || '');
  if (existing) {
    // Idempotent — return existing user (Okta may retry)
    return res.status(409).json(scimError(409, 'User already exists'));
  }

  const apiKey  = generateApiKey('dhk_user');
  const keyHash = hashApiKey(apiKey);
  const active  = body.active !== false ? 1 : 0;
  const dir     = directoryAttrs(body);

  const result = db.prepare(`
    INSERT INTO users (name, email, role, api_key_hash, active, scim_external_id, department, region, location, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(name, email, keyHash, active, body.externalId || null,
         dir.department ?? null, dir.region ?? null, dir.location ?? null);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  log.info(`SCIM: created user "${name}" (${email})`);
  res.status(201).json(toScimUser(user, req));
});

// ---------------------------------------------------------------------------
// GET /Users/:id
// ---------------------------------------------------------------------------
router.get('/Users/:id', requireScimToken, (req, res) => {
  const db   = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(pathId(req));
  if (!user) return res.status(404).json(scimError(404, 'User not found'));
  res.json(toScimUser(user, req));
});

// ---------------------------------------------------------------------------
// PUT /Users/:id — full replace
// ---------------------------------------------------------------------------
router.put('/Users/:id', requireScimToken, (req, res) => {
  const db   = getDb();
  const id   = pathId(req);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(id);
  if (!user) return res.status(404).json(scimError(404, 'User not found'));

  applyUpdateToUser(db, id, req.body);
  if (req.body.externalId) {
    db.prepare('UPDATE users SET scim_external_id = ? WHERE id = ?').run(req.body.externalId, id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  log.info(`SCIM: replaced user ${id}`);
  res.json(toScimUser(updated, req));
});

// ---------------------------------------------------------------------------
// PATCH /Users/:id — partial update (Okta uses this for activate/deactivate)
// ---------------------------------------------------------------------------
router.patch('/Users/:id', requireScimToken, (req, res) => {
  const db   = getDb();
  const id   = pathId(req);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(id);
  if (!user) return res.status(404).json(scimError(404, 'User not found'));

  const ops = req.body?.Operations || [];
  for (const op of ops) {
    const action = (op.op || '').toLowerCase();
    if (action === 'replace' || action === 'add') {
      // op.path = 'active', op.value = false  (deactivate)
      // op.path = null, op.value = { active: false, name: {...} }  (bulk replace)
      if (op.path) {
        const attr = op.path.toLowerCase();
        const patch = {};
        if (attr === 'active')   patch.active   = op.value;
        else if (attr === 'username') patch.userName  = op.value;
        else if (attr === 'name')     patch.name      = op.value;
        else if (attr === 'emails')   patch.emails    = op.value;
        // v2.18.0: path-scoped department / address ops (Okta sends these too).
        else if (attr.includes('enterprise') && attr.endsWith(':department')) patch[SCIM_ENTERPRISE_SCHEMA] = { department: op.value };
        else if (attr.startsWith('addresses') && attr.endsWith('.region'))    patch.addresses = [{ region: op.value, primary: true }];
        else if (attr.startsWith('addresses') && attr.endsWith('.locality'))  patch.addresses = [{ locality: op.value, primary: true }];
        applyUpdateToUser(db, id, patch);
      } else if (op.value && typeof op.value === 'object') {
        applyUpdateToUser(db, id, op.value);
      }
    }
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  log.info(`SCIM: patched user ${id}`);
  res.json(toScimUser(updated, req));
});

// ---------------------------------------------------------------------------
// DELETE /Users/:id — hard delete
// ---------------------------------------------------------------------------
router.delete('/Users/:id', requireScimToken, (req, res) => {
  const db   = getDb();
  const id   = pathId(req);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(id);
  if (!user) return res.status(404).json(scimError(404, 'User not found'));

  db.prepare('DELETE FROM identity_sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  log.info(`SCIM: deleted user ${id} (${user.email})`);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// GET /Groups — list with optional filter + pagination
// ---------------------------------------------------------------------------
router.get('/Groups', requireScimToken, (req, res) => {
  const db = getDb();
  const startIndex = Math.max(1, parseInt(req.query.startIndex) || 1);
  const count      = Math.min(200, Math.max(1, parseInt(req.query.count) || 100));
  const filter     = parseFilter(req.query.filter);

  let query  = 'SELECT * FROM scim_groups WHERE 1 = 1';
  const args = [];

  if (req.query.filter && !filter) {
    return res.status(400).json(scimError(400, `Unsupported filter: ${req.query.filter}`, 'invalidFilter'));
  }
  if (filter) {
    if (filter.attr === 'displayname') {
      query += ' AND display_name = ?'; args.push(filter.value);
    } else if (filter.attr === 'externalid') {
      query += ' AND external_id = ?'; args.push(filter.value);
    } else if (filter.attr === 'id') {
      if (toLocalId(filter.value) === null) {
        return res.status(400).json(scimError(400, `Unusable id in filter: ${filter.value}`, 'invalidFilter'));
      }
      query += ' AND id = ?'; args.push(toLocalId(filter.value));
    } else {
      return res.status(400).json(scimError(400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter'));
    }
  }

  const total = db.prepare(query.replace('SELECT *', 'SELECT COUNT(*) as n')).get(...args).n;
  const rows  = db.prepare(query + ' ORDER BY id LIMIT ? OFFSET ?').all(...args, count, startIndex - 1);
  const skip  = membersExcluded(req);

  res.json({
    schemas:      [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: rows.length,
    Resources:    rows.map(g => toScimGroup(g, req, { members: skip ? null : groupMembers(db, g.id) })),
  });
});

// ---------------------------------------------------------------------------
// POST /Groups — create group (optionally with an initial member list)
// ---------------------------------------------------------------------------
router.post('/Groups', requireScimToken, (req, res) => {
  const db   = getDb();
  const body = req.body || {};
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  if (!displayName) return res.status(400).json(scimError(400, 'displayName is required', 'invalidValue'));

  const clash = db.prepare('SELECT id FROM scim_groups WHERE display_name = ?').get(displayName);
  if (clash) return res.status(409).json(scimError(409, 'Group already exists', 'uniqueness'));
  if (externalIdTaken(db, body.externalId)) {
    return res.status(409).json(scimError(409, 'Another group already uses that externalId', 'uniqueness'));
  }

  const { ids: memberIds, invalid } = memberRefsFromValue(body.members);
  if (invalid.length) {
    return res.status(400).json(scimError(400, `Unresolvable member id: ${invalid[0]}`, 'invalidValue'));
  }
  for (const uid of memberIds) {
    if (!scimVisibleUser(db, uid)) {
      return res.status(400).json(scimError(400, `Unknown member: ${uid}`, 'invalidValue'));
    }
  }

  let groupId;
  db.transaction(() => {
    groupId = db.prepare('INSERT INTO scim_groups (display_name, external_id) VALUES (?, ?)')
      .run(displayName, body.externalId || null).lastInsertRowid;
    const add = db.prepare('INSERT OR IGNORE INTO scim_group_members (group_id, user_id) VALUES (?, ?)');
    for (const uid of memberIds) add.run(groupId, uid);
  })();

  reconcileGroupAccess(db);
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(groupId);
  log.info(`SCIM: created group "${displayName}" (${memberIds.length} member(s))`);
  res.status(201).json(toScimGroup(group, req, { members: groupMembers(db, groupId) }));
});

// ---------------------------------------------------------------------------
// GET /Groups/:id
// ---------------------------------------------------------------------------
router.get('/Groups/:id', requireScimToken, (req, res) => {
  const db    = getDb();
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(pathId(req));
  if (!group) return res.status(404).json(scimError(404, 'Group not found'));
  const skip = membersExcluded(req);
  res.json(toScimGroup(group, req, { members: skip ? null : groupMembers(db, group.id) }));
});

// ---------------------------------------------------------------------------
// PUT /Groups/:id — full replace: displayName AND the entire member list
// ---------------------------------------------------------------------------
router.put('/Groups/:id', requireScimToken, (req, res) => {
  const db    = getDb();
  const id    = pathId(req);
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json(scimError(404, 'Group not found'));

  const body = req.body || {};
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) return res.status(400).json(scimError(400, 'displayName is required', 'invalidValue'));

  const clash = db.prepare('SELECT id FROM scim_groups WHERE display_name = ? AND id != ?').get(displayName, id);
  if (clash) return res.status(409).json(scimError(409, 'Another group already uses that displayName', 'uniqueness'));
  if (body.externalId !== undefined && externalIdTaken(db, body.externalId, id)) {
    return res.status(409).json(scimError(409, 'Another group already uses that externalId', 'uniqueness'));
  }

  // PUT replaces. An absent `members` key means "no members" per SCIM's replace
  // semantics, and that is a mass revocation, so it is applied literally rather
  // than being second-guessed into "leave them alone".
  const { ids: memberIds, invalid } = memberRefsFromValue(body.members);
  if (invalid.length) {
    return res.status(400).json(scimError(400, `Unresolvable member id: ${invalid[0]}`, 'invalidValue'));
  }
  for (const uid of memberIds) {
    if (!scimVisibleUser(db, uid)) {
      return res.status(400).json(scimError(400, `Unknown member: ${uid}`, 'invalidValue'));
    }
  }

  db.transaction(() => {
    db.prepare("UPDATE scim_groups SET display_name = ?, external_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(displayName, body.externalId ?? group.external_id ?? null, id);
    db.prepare('DELETE FROM scim_group_members WHERE group_id = ?').run(id);
    const add = db.prepare('INSERT OR IGNORE INTO scim_group_members (group_id, user_id) VALUES (?, ?)');
    for (const uid of memberIds) add.run(id, uid);
  })();

  reconcileGroupAccess(db);
  const updated = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  log.info(`SCIM: replaced group ${id} (${memberIds.length} member(s))`);
  res.json(toScimGroup(updated, req, { members: groupMembers(db, id) }));
});

// ---------------------------------------------------------------------------
// PATCH /Groups/:id — the operations IdPs actually send
//
//   add member       { op:'add',     path:'members', value:[{value:'7'}] }
//   remove member    { op:'remove',  path:'members[value eq "7"]' }
//   remove member    { op:'remove',  path:'members', value:[{value:'7'}] }
//   remove all       { op:'remove',  path:'members' }
//   replace members  { op:'replace', path:'members', value:[{value:'7'}] }
//   rename           { op:'replace', path:'displayName', value:'X' }
//   rename, no path  { op:'replace', value:{ displayName:'X' } }
//
// An operation this route does not understand is REFUSED with 400. Answering
// 200 to an op that changed nothing is how a group drifts out of step with the
// directory while every sync in the IdP's log reads green.
// ---------------------------------------------------------------------------
router.patch('/Groups/:id', requireScimToken, (req, res) => {
  const db    = getDb();
  const id    = pathId(req);
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json(scimError(404, 'Group not found'));

  const ops = req.body?.Operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    return res.status(400).json(scimError(400, 'Operations is required', 'invalidValue'));
  }

  const addMember = db.prepare('INSERT OR IGNORE INTO scim_group_members (group_id, user_id) VALUES (?, ?)');
  const rmMember  = db.prepare('DELETE FROM scim_group_members WHERE group_id = ? AND user_id = ?');

  // Validated up front, applied as one transaction: a PATCH that fails halfway
  // would leave the group in a state neither side asked for.
  const plan = [];
  for (const op of ops) {
    const action = String(op?.op || '').toLowerCase();
    const rawPath = op?.path === undefined || op?.path === null ? '' : String(op.path);
    const memberPath = parseMemberPath(rawPath);

    // A members value-path this server cannot evaluate is an ERROR, not a
    // no-op. Answering 200 to it is the silent half of a deprovisioning
    // failure: the IdP records the removal as applied and never retries.
    // A filter that is well-formed and simply matches nobody is NOT this case
    // — that one resolves to an id below and is a legitimate no-op.
    if (memberPath && memberPath.invalid !== undefined) {
      return res.status(400).json(scimError(
        400, `Cannot evaluate path filter: ${rawPath}`, 'invalidFilter'));
    }

    // RFC 7644 §3.5.2.2: "If 'path' is unspecified, the operation fails with
    // HTTP status code 400 and a 'scimType' error code of 'noTarget'."
    if (action === 'remove' && !rawPath) {
      return res.status(400).json(scimError(400, "PATCH 'remove' requires a path", 'noTarget'));
    }

    const pathMemberId = memberPath ? memberPath.id : null;
    const attr = memberPath ? 'members' : rawPath.toLowerCase();

    if (action === 'remove' && pathMemberId !== null) {
      plan.push({ kind: 'remove', ids: [pathMemberId] });
      continue;
    }
    if (attr === 'members') {
      const { ids, invalid, present } = memberRefsFromValue(op.value);
      if (invalid.length) {
        return res.status(400).json(scimError(400, `Unresolvable member id: ${invalid[0]}`, 'invalidValue'));
      }
      if (action === 'add' || action === 'replace') {
        for (const uid of ids) {
          if (!scimVisibleUser(db, uid)) {
            return res.status(400).json(scimError(400, `Unknown member: ${uid}`, 'invalidValue'));
          }
        }
        plan.push({ kind: action === 'add' ? 'add' : 'replaceAll', ids });
        continue;
      }
      if (action === 'remove') {
        // Two DIFFERENT requests wear the same bare `"path": "members"`:
        //
        //   no `value` at all  — RFC 7644 §3.5.2.2's "the attribute and all
        //                        values are removed". Really means empty it.
        //   a `value` array    — Entra's DEFAULT remove-member shape. Means
        //                        "remove exactly these", and nobody else.
        //
        // Collapsing the second into the first is mass deprovisioning: one
        // member id the server cannot place would empty the whole group.
        plan.push(present ? { kind: 'remove', ids } : { kind: 'replaceAll', ids: [] });
        continue;
      }
    }
    if (attr === 'displayname' && (action === 'replace' || action === 'add')) {
      const name = typeof op.value === 'string' ? op.value.trim() : '';
      if (!name) return res.status(400).json(scimError(400, 'displayName cannot be empty', 'invalidValue'));
      plan.push({ kind: 'rename', name });
      continue;
    }
    if (attr === 'externalid' && (action === 'replace' || action === 'add')) {
      plan.push({ kind: 'externalId', value: op.value == null ? null : String(op.value) });
      continue;
    }
    if (!rawPath && op.value && typeof op.value === 'object' && (action === 'replace' || action === 'add')) {
      // Pathless bulk form: { op:'replace', value:{ displayName, members } }
      if (typeof op.value.displayName === 'string' && op.value.displayName.trim()) {
        plan.push({ kind: 'rename', name: op.value.displayName.trim() });
      }
      if (op.value.members !== undefined) {
        const { ids, invalid } = memberRefsFromValue(op.value.members);
        if (invalid.length) {
          return res.status(400).json(scimError(400, `Unresolvable member id: ${invalid[0]}`, 'invalidValue'));
        }
        for (const uid of ids) {
          if (!scimVisibleUser(db, uid)) {
            return res.status(400).json(scimError(400, `Unknown member: ${uid}`, 'invalidValue'));
          }
        }
        plan.push({ kind: 'replaceAll', ids });
      }
      if (op.value.externalId !== undefined) {
        plan.push({ kind: 'externalId', value: op.value.externalId == null ? null : String(op.value.externalId) });
      }
      continue;
    }

    return res.status(400).json(scimError(
      400, `Unsupported PATCH operation: op=${action || '(missing)'} path=${rawPath || '(none)'}`, 'invalidPath'));
  }

  for (const step of plan) {
    if (step.kind === 'rename') {
      const clash = db.prepare('SELECT id FROM scim_groups WHERE display_name = ? AND id != ?').get(step.name, id);
      if (clash) return res.status(409).json(scimError(409, 'Another group already uses that displayName', 'uniqueness'));
    }
    if (step.kind === 'externalId' && externalIdTaken(db, step.value, id)) {
      return res.status(409).json(scimError(409, 'Another group already uses that externalId', 'uniqueness'));
    }
  }

  // RFC 7644 §3.5.2.1: "Unless other operations change the resource, this
  // operation SHALL NOT change the modify timestamp of the resource." An IdP
  // that sees lastModified move reads the group as changed and resyncs; if
  // every no-op resync moves it again, the loop never settles. So the
  // timestamp follows what the statements actually did, not what was asked.
  const currentMembers = () => db.prepare(
    'SELECT user_id FROM scim_group_members WHERE group_id = ? ORDER BY user_id').all(id).map(r => r.user_id);

  db.transaction(() => {
    let changed = false;
    for (const step of plan) {
      if (step.kind === 'add') {
        for (const uid of step.ids) if (addMember.run(id, uid).changes > 0) changed = true;
      } else if (step.kind === 'remove') {
        for (const uid of step.ids) if (rmMember.run(id, uid).changes > 0) changed = true;
      } else if (step.kind === 'replaceAll') {
        const before = currentMembers();
        db.prepare('DELETE FROM scim_group_members WHERE group_id = ?').run(id);
        for (const uid of step.ids) addMember.run(id, uid);
        const after = currentMembers();
        if (before.length !== after.length || before.some((v, i) => v !== after[i])) changed = true;
      } else if (step.kind === 'rename') {
        if (db.prepare('UPDATE scim_groups SET display_name = ? WHERE id = ? AND display_name IS NOT ?')
          .run(step.name, id, step.name).changes > 0) changed = true;
      } else if (step.kind === 'externalId') {
        if (db.prepare('UPDATE scim_groups SET external_id = ? WHERE id = ? AND external_id IS NOT ?')
          .run(step.value, id, step.value).changes > 0) changed = true;
      }
    }
    if (changed) touchGroup(db, id);
  })();

  reconcileGroupAccess(db);
  const updated = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  log.info(`SCIM: patched group ${id} (${plan.length} operation(s))`);
  res.json(toScimGroup(updated, req, { members: groupMembers(db, id) }));
});

// ---------------------------------------------------------------------------
// DELETE /Groups/:id
//
// Members and the group -> app mappings cascade away with the row. The
// reconcile AFTER the delete is what withdraws the app access those mappings
// were holding open — without it, deleting a group in the IdP would leave every
// member still assigned to the apps it granted.
// ---------------------------------------------------------------------------
router.delete('/Groups/:id', requireScimToken, (req, res) => {
  const db    = getDb();
  const id    = pathId(req);
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json(scimError(404, 'Group not found'));

  db.prepare('DELETE FROM scim_groups WHERE id = ?').run(id);
  reconcileGroupAccess(db);
  log.info(`SCIM: deleted group ${id} (${group.display_name})`);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Admin token management — mounted separately at /api/auth/scim/token
// ---------------------------------------------------------------------------
export const scimAdminRouter = Router();

/**
 * POST /api/auth/scim/token — generate a new SCIM bearer token (admin only)
 * Returns the plaintext token ONCE — it is never stored.
 */
scimAdminRouter.post('/token', requireAuth, requirePlatformAdmin, (req, res) => {
  const db    = getDb();
  const token = generateApiKey('scim');
  const hash  = hashApiKey(token);
  const save  = (k, v) => db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(k, String(v), req.user.id);

  save('scim_token_hash', hash);
  save('scim_token_created_at', new Date().toISOString());
  log.info(`SCIM: new token generated by admin ${req.user.id}`);
  res.json({ token, message: 'Copy this token — it will not be shown again.' });
});

/**
 * PUT /api/auth/scim/config — enable/disable SCIM (admin only)
 */
scimAdminRouter.put('/config', requireAuth, requirePlatformAdmin, (req, res) => {
  const { enabled } = req.body || {};
  const db = getDb();
  db.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`)
    .run('scim_enabled', enabled ? '1' : '0', req.user.id);
  res.json({ message: 'SCIM settings saved' });
});

/**
 * GET /api/auth/scim/config — admin: current SCIM state
 */
scimAdminRouter.get('/config', requireAuth, requirePlatformAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'scim_%' AND key != 'scim_token_hash'").all();
  const cfg  = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    enabled:          cfg.scim_enabled === '1',
    token_created_at: cfg.scim_token_created_at || null,
    base_url:         (process.env.CRANE_DOMAIN ? 'https://' + process.env.CRANE_DOMAIN : 'http://localhost:' + (process.env.PORT || 5001)) + '/api/scim/v2',
  });
});

/**
 * GET /api/auth/scim/groups — platform admin: the groups the IdP has pushed,
 * with the app grants currently attached to each.
 *
 * platform_admin only, same gate as every other route on this router. A list of
 * group names and their member counts is an org chart, and the app column is a
 * map of who can reach what.
 */
scimAdminRouter.get('/groups', requireAuth, requirePlatformAdmin, (req, res) => {
  const db = getDb();
  const groups = db.prepare(`
    SELECT g.id, g.display_name, g.external_id, g.created_at, g.updated_at,
           (SELECT COUNT(*) FROM scim_group_members m WHERE m.group_id = g.id) AS member_count
      FROM scim_groups g ORDER BY g.display_name
  `).all();
  const grants = db.prepare(`
    SELECT r.group_id, r.app_id, r.app_role, a.slug, a.name
      FROM scim_group_app_roles r JOIN apps a ON a.id = r.app_id
  `).all();
  res.json({
    groups: groups.map(g => ({
      ...g,
      apps: grants.filter(x => x.group_id === g.id)
        .map(({ group_id, ...rest }) => rest),
    })),
  });
});

/**
 * PUT /api/auth/scim/groups/:id/apps — platform admin: set what a group grants.
 *
 * Body: { apps: [{ slug | app_id, app_role }] }. Replaces the whole mapping for
 * this group, then reconciles, so the response reflects live access rather than
 * intent.
 *
 * This is the half of group provisioning the IdP is NOT allowed to write. The
 * SCIM bearer token cannot reach this route — it requires an authenticated
 * platform_admin session — which is what stops "rename a group in Okta" from
 * being a route to production env vars.
 */
scimAdminRouter.put('/groups/:id/apps', requireAuth, requirePlatformAdmin, (req, res) => {
  const db    = getDb();
  const id    = pathId(req);
  const group = db.prepare('SELECT * FROM scim_groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const wanted = Array.isArray(req.body?.apps) ? req.body.apps : null;
  if (!wanted) return res.status(400).json({ error: 'apps must be an array' });

  const VALID = new Set(['user', 'admin', 'owner']);
  const resolved = [];
  for (const entry of wanted) {
    const role = String(entry?.app_role || '').toLowerCase();
    if (!VALID.has(role)) {
      return res.status(400).json({ error: `Invalid app_role: ${entry?.app_role}. Expected user, admin or owner.` });
    }
    const app = entry.app_id !== undefined
      ? db.prepare('SELECT id, slug FROM apps WHERE id = ?').get(toLocalId(entry.app_id))
      : db.prepare('SELECT id, slug FROM apps WHERE slug = ?').get(String(entry.slug || ''));
    if (!app) return res.status(404).json({ error: `App not found: ${entry.slug ?? entry.app_id}` });
    resolved.push({ app_id: app.id, slug: app.slug, app_role: role });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM scim_group_app_roles WHERE group_id = ?').run(id);
    const ins = db.prepare(`INSERT INTO scim_group_app_roles (group_id, app_id, app_role, created_by)
                            VALUES (?, ?, ?, ?)`);
    for (const r of resolved) ins.run(id, r.app_id, r.app_role, req.user.id);
  })();

  reconcileGroupAccess(db);
  log.info(`SCIM: group ${id} ("${group.display_name}") now grants ${resolved.length} app(s), set by admin ${req.user.id}`);
  res.json({
    group: { id, displayName: group.display_name },
    apps: resolved,
    affected_users: db.prepare(
      'SELECT COUNT(*) AS n FROM scim_group_access WHERE app_id IN (SELECT app_id FROM scim_group_app_roles WHERE group_id = ?)'
    ).get(id).n,
  });
});

export default router;
