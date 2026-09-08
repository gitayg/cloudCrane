import { getDb } from '../db.js';
import { decrypt, encrypt } from './encryption.js';
import { BUCKETS, bucketize, applyBucket } from './requestStatus.js';
import { userHasAppPermission, userHasPlatformPermission, roleForUserOnApp } from './permissions.js';
import {
  listRoles, createRole, listMembersWithRoles, setUserRoleKeys, clearUserRoleGrants,
  MAX_ROLES_PER_APP, RESERVED_KEYS,
} from './appDefinedRoles.js';
import { isAdmin } from '../utils/roles.js';
import log from '../utils/logger.js';
import { validateBypassPaths } from '../utils/authBypassPaths.js';
import {
  effectiveIngressType, validateIngressType, publicPortForApp, pendingPortRelease,
  assignPublicPort, releasePublicPort, drainingPorts, effectiveDataPlanePort, dataPlanePortForApp, validateDataPlanePort,
  INGRESS_TYPES, CONTROL_PLANE_PORT,
  PUBLIC_PORT_MIN, PUBLIC_PORT_MAX, AUTO_PORT_MIN, AUTO_PORT_MAX,
} from './tcpIngress.js';
import { redactAuditArgs } from '../utils/auditRedact.js';
import { assertFinding } from './scanShapes.js';
import { resolveVisibility } from '../utils/appVisibility.js';
import { mkdirSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

/**
 * MCP tool registry. Each tool:
 *   - name, description, inputSchema (read by the LLM via tools/list)
 *   - requiredRole — 'admin' (any AppCrane admin), 'app_admin' (admin OR per-app
 *     admin role), 'app_access' (any user with access to the app), 'any'
 *   - readOnly — OPTIONAL opt-in marker: true means the tool changes no state
 *     and is therefore callable by a read-only MCP key (see isReadOnlyKey).
 *     Absent means "write tool". requiredRole cannot stand in for this: it
 *     grades WHO may call, not WHETHER the call mutates — appcrane_deploy is
 *     'any' and appcrane_get_secret is 'app_admin'.
 *   - handler(user, args) → arbitrary JSON returned to the agent
 *
 * v1 surface (5 tools): list apps, read env, deploy, list requests, read logs.
 * Keep this small and well-described — descriptions are how the LLM picks tools.
 */

/**
 * If users.mcp_app_scope is set on the calling key, MCP is restricted to
 * those slugs regardless of role — including AppCrane admins. Returns null
 * (no restriction) if unset, an array of slugs if set, or [] to lock out.
 */
function mcpScope(user) {
  const raw = user.mcp_app_scope;
  if (raw == null || raw === '') return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch (_) {
    return null;
  }
}

/**
 * True when mcp_app_scope is set to an empty list, i.e. the operator has locked
 * this key out of MCP entirely. Exported because the lockout has to hold on
 * every MCP surface, not just AppCrane's own tools — see server/routes/mcp.js.
 */
export function isMcpLockedOut(user) {
  const scope = mcpScope(user);
  return Array.isArray(scope) && scope.length === 0;
}

/**
 * v2.44.0: is the calling personal MCP key read-only (user_mcp_keys.read_only)?
 *
 * Checked against BOTH views of the caller. read_only is a property of the KEY,
 * so `userMcpKey` is its natural home — but callTool()'s userMcpKey argument is
 * optional and defaults to null, so a call site that forgets to forward it
 * would silently drop the restriction. That is precisely how
 * users.mcp_app_scope stayed inert until v2.42.1: requireAuth built req.user
 * for dhk_mcp_* keys from a hand-picked column list that omitted the column, so
 * the only MCP key type that exists never carried it. requireAuth now stamps
 * both `req.user.mcp_read_only` and `req.user_mcp_key.read_only`, and either
 * one alone refuses the write.
 */
function isReadOnlyKey(user, userMcpKey) {
  return !!(userMcpKey?.read_only || user?.mcp_read_only);
}

/**
 * The single gate a read-only key passes through. Enforced once, in callTool,
 * against the per-tool `readOnly` opt-in — never per handler. There are 44
 * tools; a per-tool check is a check that gets forgotten on the 45th.
 *
 * The classification is an opt-IN so the default fails closed: a tool added
 * without a `readOnly` marker is treated as a write tool and refused to
 * read-only keys. Getting it wrong that way produces a bug report from an
 * operator whose read tool is blocked; getting it wrong the other way round
 * would hand every read-only key a new mutation for free.
 */
function assertToolAllowedForKey(user, tool, userMcpKey) {
  if (!isReadOnlyKey(user, userMcpKey)) return;
  if (tool.readOnly) return;
  throw new Error(
    `Forbidden: ${tool.name} changes state and this MCP key is read-only. ` +
    'Issue a full-access key to perform writes.'
  );
}

function isInMcpScope(user, slug) {
  const scope = mcpScope(user);
  if (scope === null) return null; // no opinion — fall through to role checks
  return scope.includes(slug);
}

function accessibleSlugsForUser(user) {
  // Personal MCP key — dynamically resolves to apps where the user has access.
  // AppCrane global admins (admin OR platform_admin) see every app; everyone
  // else sees apps they own. Role changes take effect on the next call.
  // (App-scoped keys removed in v2.2.12 — per-app scoping comes from the
  // user's app_user_roles assignments, not from a separate key type.)
  if (user._mcpUserKey) {
    const db = getDb();
    const owned = isAdmin(user)
      ? db.prepare('SELECT slug FROM apps').all().map(r => r.slug)
      : db.prepare(`
        SELECT DISTINCT a.slug
        FROM apps a
        JOIN app_user_roles aur ON aur.app_id = a.id
        WHERE aur.user_id = ? AND aur.app_role = 'owner'
      `).all(user.id).map(r => r.slug);
    // v2.42.1 SECURITY: an explicit mcp_app_scope is a ceiling over whatever
    // the role resolves to, including for a personal key. This branch used to
    // return before reaching the scope, so the restriction only ever applied
    // to the key types that do not exist in practice.
    const ceiling = mcpScope(user);
    return ceiling ? owned.filter(s => ceiling.includes(s)) : owned;
  }

  const scope = mcpScope(user);
  if (scope) return scope; // explicit scope wins over role
  const db = getDb();
  if (isAdmin(user)) {
    return db.prepare('SELECT slug FROM apps').all().map(r => r.slug);
  }
  return db
    .prepare(
      `SELECT DISTINCT a.slug
       FROM apps a
       LEFT JOIN app_users au ON au.app_id = a.id AND au.user_id = ?
       LEFT JOIN app_user_roles aur ON aur.app_id = a.id AND aur.user_id = ?
       WHERE au.user_id IS NOT NULL OR aur.user_id IS NOT NULL`
    )
    .all(user.id, user.id)
    .map(r => r.slug);
}

function getAppForUser(user, slug) {
  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
  if (!app) throw new Error(`App not found: ${slug}`);

  // v2.42.1 SECURITY: the explicit scope is checked FIRST, above every role
  // branch, because it is a ceiling and not an alternative to the role checks.
  // It used to sit below the personal-key branch, which returned early — so a
  // dhk_mcp_* key ignored the scope entirely.
  if (isInMcpScope(user, slug) === false) {
    throw new Error(`Forbidden: app ${slug} is outside this key's MCP scope`);
  }

  // Personal MCP key locks scope to apps the user has access to. AppCrane
  // global admins (admin OR platform_admin) keep their global access;
  // everyone else is restricted to apps where they're explicitly Owner.
  if (user._mcpUserKey) {
    if (isAdmin(user)) return app;
    const owns = db.prepare(
      "SELECT 1 FROM app_user_roles WHERE app_id = ? AND user_id = ? AND app_role = 'owner'"
    ).get(app.id, user.id);
    if (!owns) throw new Error(`Forbidden: this personal MCP key only covers apps you own; ${slug} is not one`);
    return app;
  }

  // Explicit MCP scope (if set) trumps role
  const inScope = isInMcpScope(user, slug);
  if (inScope === false) throw new Error(`Forbidden: app ${slug} is outside this key's MCP scope`);
  if (inScope === true) return app;

  // No explicit scope: fall back to role/assignment check
  if (isAdmin(user)) return app;
  const hasAccess =
    db.prepare('SELECT 1 FROM app_users WHERE app_id = ? AND user_id = ?').get(app.id, user.id) ||
    db.prepare('SELECT 1 FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(app.id, user.id);
  if (!hasAccess) throw new Error(`Forbidden: no access to app ${slug}`);
  return app;
}

function isAppAdmin(user, app) {
  // MCP scope only restricts WHICH apps; if the user has the slug in scope
  // and is a global admin (admin or platform_admin), they're still an
  // app-admin for it.
  if (isAdmin(user)) return true;
  const db = getDb();
  const row = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(app.id, user.id);
  // v2.7.0: owner is the highest per-app tier (none < user < admin < owner),
  // so it must satisfy admin-level write gates. The canUseTool 'app_admin'
  // visibility check already includes owner; this handler-side check omitted
  // it, so an owner who created an app saw write tools (set_env, etc.) but
  // got "Forbidden" on call. Matters for non-admin onboarding: the app
  // creator is auto-assigned owner.
  return row?.app_role === 'admin' || row?.app_role === 'owner';
}

/**
 * Gate for the app-defined-role tools. `manage: true` demands the app's own
 * owner/admin tier; otherwise plain membership is enough to read the roster.
 *
 * Deliberately roleForUserOnApp rather than isAppAdmin: it is the same resolver
 * the REST routes use, and it gives an AppCrane global admin who is not assigned
 * to the app no per-app tier at all. So both surfaces answer identically, and an
 * app's own permission vocabulary is authored by that app's owners rather than
 * by anyone holding a platform key.
 */
function requireAppRoleTier(user, app, { manage }) {
  const tier = roleForUserOnApp(user, app);
  if (manage ? (tier !== 'owner' && tier !== 'admin') : !tier) {
    throw new Error(
      manage
        ? `Forbidden: only an owner or admin of ${app.slug} can manage its app-defined roles`
        : `Forbidden: you are not assigned to ${app.slug}. Assign yourself first (appcrane_grant_app_access) to read its app-defined roles.`
    );
  }
}

/**
 * The MCP equivalent of the app-USER tier that guards /api/apps/:slug/database
 * on the HTTP side (server/middleware/auth.js requireAppUser): an explicit
 * `app_users` assignment is required, and it is authoritative for EVERY role
 * INCLUDING platform_admin.
 *
 * Deliberately NOT isAppAdmin(), which returns true for any AppCrane global
 * admin. That difference is the entire v2.39.0 guardrail: what sits behind this
 * tier is the app's own data and credentials — env var plaintext, backups, and
 * now a live database login — as distinct from platform administration. An
 * admin reaches it by assigning themselves, which is an audited, attributable
 * act, rather than by holding a platform key.
 *
 * It has to be repeated here rather than inherited, because an MCP caller
 * authenticates as an ordinary user against the same identities. If this gate
 * were the looser one, the MCP surface would be a documented way around a
 * guardrail the HTTP surface enforces — the escalation is not in the tool, it
 * is in the two surfaces disagreeing.
 *
 * isAdmin() rather than a role literal so platform_admin lands in the
 * actionable branch and not the flat refusal (scripts/check-role-patterns.sh).
 */
function requireAppUserTier(user, app, action) {
  const assigned = getDb()
    .prepare('SELECT 1 FROM app_users WHERE app_id = ? AND user_id = ?')
    .get(app.id, user.id);
  if (assigned) return;
  if (isAdmin(user)) {
    throw new Error(
      `Forbidden: admin access does not include an app's own data and credentials. ` +
      `Assign yourself to '${app.slug}' first (appcrane_grant_app_access), then ${action}.`
    );
  }
  throw new Error(`Forbidden: you are not assigned to ${app.slug}, so you cannot ${action}.`);
}

/**
 * The managed-database engine, loaded on first use rather than at import —
 * the same shape server/routes/managedDb.js uses, and this file's existing
 * convention for service dependencies (see the backupScheduler imports below).
 *
 * A failure is not cached: an instance whose engine module is unavailable fails
 * these two tools and nothing else, and a later call retries.
 */
let managedDbPromise = null;
async function managedDbModule() {
  if (!managedDbPromise) {
    managedDbPromise = import('./managedDb.js').catch((e) => {
      managedDbPromise = null;
      throw new Error(`Managed databases are not available on this instance: ${e.message}`);
    });
  }
  return managedDbPromise;
}

/**
 * Test seam, mirroring routes/managedDb.js __setEngineForTests. Not used by
 * production code.
 *
 * Not a convenience: provision() calls ensureServer(), which docker-runs a real
 * Postgres or MariaDB container and holds a port. The double lets the two
 * things these tools are responsible for — the authorization tier, and never
 * putting the credential in a tool result — be tested without that.
 * test/managed-db-mcp.test.js also asserts the real module still exports
 * everything called here, so the double cannot drift away from the engine.
 */
export function __setManagedDbForTests(mod) {
  managedDbPromise = mod ? Promise.resolve(mod) : null;
}

/**
 * Whitelist for container exec paths. Only /app and /data are reachable —
 * everything else (/etc, /root, /proc, the host bind-mounts) is off-limits
 * for read tools so a curious agent can't grep secrets out of the OS image.
 * `..` traversal is rejected even after the prefix check.
 */
function validateContainerPath(p) {
  const path = String(p == null ? '' : p).trim();
  if (!path) throw new Error('path is required');
  if (!path.startsWith('/')) throw new Error('path must be absolute');
  if (path.includes('..')) throw new Error('path must not contain ".."');
  if (path !== '/app' && path !== '/data' &&
      !path.startsWith('/app/') && !path.startsWith('/data/')) {
    throw new Error('path must be under /app or /data');
  }
  return path;
}

function auditMcpCall(user, toolName, args, error) {
  try {
    const db = getDb();
    const slug = args && typeof args.slug === 'string' ? args.slug : null;
    const appId = slug
      ? db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug)?.id ?? null
      : null;
    // v2.28.0 SECURITY: redact credential-bearing arguments. This used to
    // stringify `args` verbatim, which wrote set_secret's `value` and
    // create_app's `github_token` into audit_log in PLAINTEXT — defeating the
    // AES-256-GCM encryption those same values get everywhere else, and making
    // the audit log the easiest place on the box to steal a credential.
    // Also truncates large strings so a file push can't write megabytes/call.
    const detail = JSON.stringify({
      tool: toolName,
      args: redactAuditArgs(args || {}),
      ok: !error,
      error: error ? String(error.message || error) : null,
    });
    // v2.28.0: attribute the actor. `kind` is 'agent' for MCP/agent identities
    // and 'human' otherwise; denormalized onto the row so the trail stays
    // truthful even if the user is later deleted or reclassified.
    db.prepare(
      'INSERT INTO audit_log (user_id, app_id, action, detail, actor_kind) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, appId, `mcp.${toolName}`, detail, user.kind || 'agent');
  } catch (e) {
    log.warn(`MCP audit log failed: ${e.message}`);
    // Compliance/regulated installs can flip this to fail-closed: any audit
    // write failure (table locked, schema drift, disk full) refuses the call
    // rather than letting the action proceed without a trail.
    if (process.env.APPCRANE_AUDIT_REQUIRED === '1') {
      throw new Error(`Audit log unavailable — refusing to proceed (APPCRANE_AUDIT_REQUIRED=1): ${e.message}`);
    }
  }
}

// appcrane_get_app returned no auth_mode key at all, so an agent debugging
// "no identity headers" had no way to rule out the most likely cause: a
// headless app skips forward_auth entirely and its container never sees
// X-AppCrane-* identity headers, by design.
//
// Report the EFFECTIVE mode, not the raw column. The value is not validated on
// write, so a legacy row can hold something like 'forward_auth'; caddy.js
// treats only the literal 'headless' as a bypass, and the agent needs the
// answer that matches proxy behaviour rather than storage.
function effectiveAuthMode(raw) {
  return raw === 'headless' ? 'headless' : 'authenticated';
}

/**
 * Augment an app row with the canonical URLs (production + sandbox) and
 * the most recent live deployment version for each environment. Used by
 * appcrane_list_apps and appcrane_get_app so an agent can answer
 * "what's deployed and where" without a follow-up call.
 *
 * `app` must include `id`, `slug`, and `domain`.
 */
function enrichAppRow(db, app) {
  const craneDomain = process.env.CRANE_DOMAIN;
  const urls = craneDomain
    ? {
        production: app.domain ? `https://${app.domain}` : `https://${craneDomain}/${app.slug}`,
        sandbox: `https://${craneDomain}/${app.slug}-sandbox`,
      }
    : null;

  const lastLiveProd = db
    .prepare(
      "SELECT version, finished_at FROM deployments WHERE app_id = ? AND env = 'production' AND status = 'live' ORDER BY started_at DESC LIMIT 1"
    )
    .get(app.id);
  const lastLiveSand = db
    .prepare(
      "SELECT version, finished_at FROM deployments WHERE app_id = ? AND env = 'sandbox' AND status = 'live' ORDER BY started_at DESC LIMIT 1"
    )
    .get(app.id);

  return {
    slug: app.slug,
    name: app.name,
    description: app.description ?? null,
    domain: app.domain ?? null,
    urls,
    versions: {
      production: lastLiveProd?.version ?? null,
      sandbox: lastLiveSand?.version ?? null,
    },
    last_deploy: {
      production: lastLiveProd?.finished_at ?? null,
      sandbox: lastLiveSand?.finished_at ?? null,
    },
  };
}

// Findings come off a scan row as JSON some other process wrote, and they are
// ASSERTED on the way out rather than read defensively. v2.52.0's scanner
// stored { name, version, ids } while the digest's brief described
// { package, id, fixed_version }; the mail rendered only because its author
// wrote `f.name ?? f.package`. That read is the bug, not the safety net — it
// turns a broken contract into a payload that quietly says less than it
// should. A reshape has to stop a test run rather than reach an agent as
// `undefined`.
//
// `ecosystem` on the row is the ONE manifest that scan read. A release can hold
// several — a go.mod beside a package-lock.json — and AppCrane reads one per
// row, so an app is only ever covered for the manifest named here; an unread Go
// service sitting next to a scanned npm frontend is a false clean at the app
// level even when every finding on the row is correct. findings_json is dropped
// on the way out because a raw copy beside the asserted list is a second,
// unchecked path to the same data.
function projectScanRow(row, where) {
  const raw = row.findings ?? (row.findings_json ? JSON.parse(row.findings_json) : []);
  const { findings_json, findings, ...rest } = row;
  return {
    ...rest,
    manifest: row.ecosystem || null,
    findings: (Array.isArray(raw) ? raw : []).map((f, i) => {
      const { name, version, ecosystem, ids, fixed } = assertFinding(f, `${where} findings[${i}]`);
      return { name, version, ecosystem, ids, fixed };
    }),
  };
}

// Shared description text for the three source_type='image' fields, so the
// create tool and the update tool cannot drift into telling an agent two
// different things about the same column.
const IMAGE_REF_DESC =
  'Prebuilt container image to run instead of building from source, e.g. "odoo:19" or ' +
  '"ghcr.io/owner/app@sha256:<64 hex>". Sets source_type=\'image\'. The reference MUST name a ' +
  'version: a bare name ("odoo") and an explicit ":latest" are both REFUSED, because AppCrane ' +
  'records the resolved digest as the deployment\'s identity and against an unpinned tag that ' +
  'record is wrong as soon as upstream moves. A digest is the real pin; a version tag ("odoo:19") ' +
  'is accepted and is how you pick up a patch release on redeploy. Credentials never go in the ' +
  'reference — a private registry authenticates through the Docker daemon\'s own credential ' +
  'store, set up out of band.';
const CONTAINER_PORT_DESC =
  'Port the image listens on inside the container. Omit only if the image really listens on 3000 ' +
  '(what an AppCrane-built image does); a third-party image usually does not — odoo is 8069, ' +
  'nginx is 80. Getting this wrong makes the app unreachable, not slow.';
const HEALTH_PATH_DESC =
  'HTTP path AppCrane health-checks. Omit only if the image serves /api/health (the AppCrane-built ' +
  'default). A stock image will not, and a health check against a 404 marks a working app unhealthy.';

/**
 * Validate the source_type='image' trio and return the values to persist.
 *
 * Both write tools go through here rather than each doing its own checks: the
 * MCP surface has already shipped one enum that drifted from the REST route
 * (see the source_type enum note on appcrane_update_app), and validation
 * duplicated per tool drifts the same way.
 *
 * `image_ref` is parsed by services/imageSource.js — the one place the
 * registry/port/tag ambiguity is resolved — and then held to a stricter rule
 * than the parser's: the parser reports "no tag" as a fact, and this refuses
 * it. An unpinned reference is not a typo the operator can see in the UI later;
 * it is a deploy whose contents depend on when it ran.
 *
 * Only keys actually present in `args` appear in the result, so an update that
 * touches one field leaves the other two alone.
 */
async function validateImageFields(args) {
  const out = {};
  const { parseImageRef } = await import('./imageSource.js');

  if (args.image_ref !== undefined) {
    if (!args.image_ref) {
      out.image_ref = null;
    } else {
      const parsed = parseImageRef(args.image_ref);
      // Same rule, same wording as validateImageRef in server/routes/apps.js:
      // no digest and either no tag or the literal ':latest'. The two gates are
      // separate code because a route helper is not importable from a service,
      // and a rule stated twice is a rule that drifts — so they are stated
      // identically and test/image-source-mcp.test.js pins this half of it.
      if (!parsed.digest && (parsed.tag === null || parsed.tag === 'latest')) {
        const why = parsed.tag === null
          ? 'it has no tag, so Docker resolves it as :latest'
          : ':latest points at a different image whenever the publisher pushes';
        throw new Error(
          `image_ref "${args.image_ref}" is not pinned — ${why}. Give an explicit tag (odoo:19) ` +
          'or a digest (odoo@sha256:<64 hex>).',
        );
      }
      out.image_ref = String(args.image_ref).trim();
    }
  }

  if (args.container_port !== undefined) {
    if (args.container_port === null || args.container_port === '') {
      out.container_port = null;
    } else {
      // typeof-guarded before Number(): Number(true) is 1, a valid port, so a
      // `container_port: true` would otherwise be stored as port 1.
      if (typeof args.container_port !== 'number' && typeof args.container_port !== 'string') {
        throw new Error('container_port must be an integer between 1 and 65535');
      }
      const n = Number(args.container_port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error('container_port must be an integer between 1 and 65535');
      }
      out.container_port = n;
    }
  }

  if (args.health_path !== undefined) {
    if (!args.health_path) {
      out.health_path = null;
    } else {
      // Same three checks, same 512 ceiling, as validateHealthPath in
      // server/routes/apps.js. The value is appended to a URL by the health
      // checker: a path missing its leading '/' concatenates into the host
      // name, and whitespace or a control character produces an unparseable URL.
      const p = String(args.health_path).trim();
      if (!p.startsWith('/')) throw new Error(`health_path must start with '/' — got "${args.health_path}"`);
      if (p.length > 512) throw new Error('health_path is too long (max 512 chars)');
      for (const ch of p) {
        const code = ch.codePointAt(0);
        if (code <= 0x20 || code === 0x7f) {
          throw new Error('health_path contains whitespace or control characters');
        }
      }
      out.health_path = p;
    }
  }

  return out;
}

const TOOLS = [
  {
    name: 'appcrane_list_apps',
    description:
      'List all AppCrane apps the current user has access to. Each app includes slug, name, description, ' +
      'urls (production + sandbox), and the version currently live in each environment. ' +
      'Call this first when the user asks about "my apps", "what apps exist", or before doing anything app-specific. ' +
      'Non-admin users see only their assigned apps; admins (admin or platform_admin) see everything.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user) => {
      const db = getDb();
      const slugs = accessibleSlugsForUser(user);
      if (!slugs.length) return { apps: [], count: 0 };
      const placeholders = slugs.map(() => '?').join(',');
      const apps = db
        .prepare(
          `SELECT id, slug, name, description, domain FROM apps WHERE slug IN (${placeholders}) ORDER BY name`
        )
        .all(...slugs)
        .map(a => enrichAppRow(db, a));
      return { apps, count: apps.length };
    },
  },

  {
    name: 'appcrane_get_app',
    description:
      'Get detailed info for a single app: URLs, current versions per environment, recent deployments, and ' +
      'health state. Use this when the user asks "what\'s the status of <app>", "is <app> deployed", or after a ' +
      'deploy to confirm what landed. Returns 404-equivalent error if the slug doesn\'t exist or the caller has no access. ' +
      'config.auth_mode tells you whether the app gets identity at all: `authenticated` means routes go through ' +
      'forward_auth and arrive at the container with X-AppCrane-* headers; `headless` means forward_auth is skipped ' +
      'for the whole app and those headers NEVER arrive. Check it first when debugging "my app sees no identity headers", ' +
      'but note it is per-APP, not per-request: an `authenticated` app can still have auth_bypass_paths prefixes that ' +
      'skip forward_auth, and a custom domain is never gated either. The request itself is authoritative — the app can ' +
      'read X-AppCrane-Auth-Mode (authenticated / headless / bypass), which AppCrane stamps on every route it proxies.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. "mysite"' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      const db = getDb();
      const enriched = enrichAppRow(db, app);

      const recentDeploys = db
        .prepare(
          `SELECT id, env, version, status, commit_hash, started_at, finished_at, frontend_assets
           FROM deployments WHERE app_id = ?
           ORDER BY started_at DESC LIMIT 6`
        )
        .all(app.id);

      const healthProd = db
        .prepare('SELECT last_check_at, last_status, last_response_ms, is_down FROM health_state WHERE app_id = ? AND env = ?')
        .get(app.id, 'production');
      const healthSand = db
        .prepare('SELECT last_check_at, last_status, last_response_ms, is_down FROM health_state WHERE app_id = ? AND env = ?')
        .get(app.id, 'sandbox');

      // v2.5.2: surface the mutable config fields so agents can see what's
      // actually stored before calling appcrane_update_app to patch one.
      // Token field is intentionally a boolean (`token_set`) — never the
      // plaintext, never the encrypted blob.
      let resourceLimits = null;
      try { resourceLimits = app.resource_limits ? JSON.parse(app.resource_limits) : null; } catch (_) {}

      return {
        ...enriched,
        recent_deployments: recentDeploys,
        health: {
          production: healthProd
            ? {
                status: healthProd.is_down ? 'down' : (healthProd.last_status === 200 ? 'healthy' : 'unknown'),
                last_check: healthProd.last_check_at,
                response_ms: healthProd.last_response_ms,
              }
            : { status: 'unknown' },
          sandbox: healthSand
            ? {
                status: healthSand.is_down ? 'down' : (healthSand.last_status === 200 ? 'healthy' : 'unknown'),
                last_check: healthSand.last_check_at,
                response_ms: healthSand.last_response_ms,
              }
            : { status: 'unknown' },
        },
        config: {
          source_type:    app.source_type,
          github_url:     app.github_url,
          branch:         app.branch,
          token_set:      !!app.github_token_encrypted,
          domain:         app.domain,
          category:       app.category,
          visibility:     app.visibility,
          public_access:  app.public_access,
          auth_mode:      effectiveAuthMode(app.auth_mode),
          // v2.42.0: reported here as well as on appcrane_get_app_ingress —
          // "this app also answers on a host port Caddy never sees" is not
          // something an agent should have to know to ask about.
          ingress_type:   effectiveIngressType(app.ingress_type),
          public_port:    publicPortForApp(app),
          // v2.45.0: the CONTAINER side of a dual app's raw publish. Reported
          // next to public_port because the pair is one fact — "the host port
          // goes to THIS port inside the container" — and half of it is not
          // actionable on its own.
          data_plane_port: effectiveDataPlanePort(app),
          pending_port_release: pendingPortRelease(app),
          image_retention: app.image_retention,
          frame_ancestors: app.frame_ancestors,
          max_ram_mb:      resourceLimits?.max_ram_mb      ?? null,
          max_cpu_percent: resourceLimits?.max_cpu_percent ?? null,
        },
      };
    },
  },

  {
    name: 'appcrane_top_apps',
    description:
      'Top apps by distinct active users in a lookback window. Useful for "which apps are getting the most use this week" or "what should I deprecate" type questions. Sourced from app_visits which is recorded on every Caddy forward_auth (one row per user/app/day). Returns rows ordered by user count descending. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7,  description: 'Lookback window. Default 7, max 90.' },
        top:  { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many rows. Default 10, max 50.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    readOnly: true,
    handler: async (_user, args) => {
      const days = Math.min(Math.max(parseInt(args.days, 10) || 7, 1), 90);
      const top  = Math.min(Math.max(parseInt(args.top,  10) || 10, 1), 50);
      const db = getDb();
      const rows = db.prepare(`
        SELECT a.slug, a.name,
               COUNT(DISTINCT v.user_id) AS users,
               COUNT(*) AS visit_days
        FROM app_visits v
        JOIN apps a ON a.id = v.app_id
        WHERE v.day >= date('now', '-' || ? || ' days')
        GROUP BY a.slug, a.name
        ORDER BY users DESC, visit_days DESC, a.name ASC
        LIMIT ?
      `).all(days, top);
      return { days, top, apps: rows };
    },
  },

  {
    name: 'appcrane_top_users',
    description:
      'Top users by distinct apps opened in a lookback window. Surfaces who the heaviest cross-app users are — handy for finding power users to interview, or spotting churn risk (a user who used 10 apps last month and 0 this week). Sourced from app_visits. Active users only. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7,  description: 'Lookback window. Default 7, max 90.' },
        top:  { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many rows. Default 10, max 50.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    readOnly: true,
    handler: async (_user, args) => {
      const days = Math.min(Math.max(parseInt(args.days, 10) || 7, 1), 90);
      const top  = Math.min(Math.max(parseInt(args.top,  10) || 10, 1), 50);
      const db = getDb();
      const rows = db.prepare(`
        SELECT u.id, u.name, u.email,
               COUNT(DISTINCT v.app_id) AS apps,
               COUNT(*) AS visit_days
        FROM app_visits v
        JOIN users u ON u.id = v.user_id
        WHERE v.day >= date('now', '-' || ? || ' days')
          AND u.active = 1
        GROUP BY u.id, u.name, u.email
        ORDER BY apps DESC, visit_days DESC, u.name ASC
        LIMIT ?
      `).all(days, top);
      return { days, top, users: rows };
    },
  },

  {
    name: 'appcrane_get_health',
    description:
      'Fetch the deployed app\'s health endpoint server-side, bypassing AppCrane\'s auth proxy. Use this to validate ' +
      'that a deploy actually landed the expected version, or to check if the app is responding. AppCrane hits the ' +
      'app\'s configured health endpoint (default /api/health) on the internal port directly — no Caddy, no SSO ' +
      'redirect — and returns the response status + body. ' +
      'Defaults to sandbox; pass stage="production" only when the user asks about prod.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. "mysite"' },
        env:  { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const { getPortsForSlot } = await import('./portAllocator.js');
      const ports = getPortsForSlot(app.slot);
      const port = env === 'production' ? ports.prod_be : ports.sand_be;

      const db = getDb();
      const cfg = db
        .prepare('SELECT endpoint FROM health_configs WHERE app_id = ? AND env = ?')
        .get(app.id, env);
      const path = cfg?.endpoint || '/api/health';
      const url = `http://127.0.0.1:${port}${path}`;

      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text.slice(0, 4096); }
        return {
          app: app.slug,
          env,
          url,
          status: r.status,
          ok: r.ok,
          body,
        };
      } catch (e) {
        return {
          app: app.slug,
          env,
          url,
          ok: false,
          error: e.message || String(e),
        };
      }
    },
  },

  {
    name: 'appcrane_get_secret',
    description:
      'List an app\'s secrets (encrypted env vars) with their values MASKED — safe to show in chat. ' +
      'For each key you get: is_set, length, a short preview (last 3 chars, rest masked; fully masked for short values), ' +
      'a sha256 `fingerprint` (compare two envs or detect a changed value without seeing it), and updated_at. ' +
      'This is what you want for "is X set?", "did the key change?", "which vars exist?". ' +
      'Does NOT return plaintext — a secret never lands in the transcript. To read one actual value, use appcrane_reveal_secret with a specific key. ' +
      'Defaults to sandbox; pass env="production" only when the user explicitly says production. App-admin or AppCrane admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. "mysite"' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin', // also gated per-slug inside handler
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: env vars require admin or app-admin role');

      const db = getDb();
      const rows = db
        .prepare('SELECT key, value_encrypted, updated_at FROM env_vars WHERE app_id = ? AND env = ? ORDER BY key')
        .all(app.id, env);
      const vars = rows.map((r) => {
        let plain = null;
        try { plain = decrypt(r.value_encrypted); } catch (_) { /* below */ }
        if (plain == null) return { key: r.key, is_set: true, error: 'decrypt_failed', updated_at: r.updated_at };
        const len = plain.length;
        // Show last 3 chars only when the value is long enough that 3 chars is
        // a small fraction; otherwise mask entirely (don't leak short passwords).
        const preview = len >= 10 ? `${'•'.repeat(Math.min(len - 3, 8))}${plain.slice(-3)}` : '•'.repeat(Math.min(len, 8));
        const fingerprint = crypto.createHash('sha256').update(plain).digest('hex').slice(0, 8);
        return { key: r.key, is_set: true, length: len, preview, fingerprint, updated_at: r.updated_at };
      });
      log.info(`MCP: env metadata (masked) read for ${app.slug}/${env} by user ${user.id}`);
      return {
        app: app.slug, env, count: rows.length, vars,
        note: 'Values are masked. To see one plaintext value, call appcrane_reveal_secret with the exact key — that value WILL appear in this transcript.',
      };
    },
  },

  {
    name: 'appcrane_reveal_secret',
    description:
      'Reveal the PLAINTEXT of ONE secret by key. Use ONLY when the user explicitly needs the actual value — it will appear in this ' +
      'conversation transcript, so treat the transcript as sensitive afterward (and consider rotating the secret if the transcript may be stored/shared). ' +
      'For checking whether a var is set, comparing values, or seeing what exists, use appcrane_get_secret (masked) instead — do NOT reveal just to inspect config. ' +
      'Single key only — it never dumps the whole env. Every reveal is audit-logged. Defaults to sandbox; env="production" only when the user explicitly asks. App-admin or AppCrane admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. "mysite"' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        key: { type: 'string', description: 'Exact env var name to reveal (e.g. "RESEND_API_KEY"). One key per call.' },
      },
      required: ['slug', 'key'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin', // also gated per-slug inside handler
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: revealing a secret requires admin or app-admin role');

      const db = getDb();
      const row = db
        .prepare('SELECT value_encrypted, updated_at FROM env_vars WHERE app_id = ? AND env = ? AND key = ?')
        .get(app.id, env, args.key);
      if (!row) throw new Error(`No env var '${args.key}' is set for ${app.slug}/${env}. Use appcrane_get_secret to list the keys that exist.`);
      let value;
      try { value = decrypt(row.value_encrypted); } catch (_) { throw new Error(`Failed to decrypt '${args.key}'.`); }

      // A plaintext read is sensitive — record who revealed what, when.
      try {
        const { logAudit } = await import('../middleware/audit.js');
        logAudit(user.id, app.id, 'secret-reveal', { env, key: args.key });
      } catch (_) { /* audit is best-effort */ }
      log.warn(`MCP: SECRET REVEAL ${app.slug}/${env}/${args.key} by user ${user.id}`);
      return { app: app.slug, env, key: args.key, value, updated_at: row.updated_at };
    },
  },

  {
    name: 'appcrane_deploy',
    description:
      'Trigger a deployment — this IS how you "update an env to the latest". For github and managed apps it ' +
      'pulls the latest commit from the app\'s configured branch on GitHub (server-side, using the app\'s stored ' +
      'credentials — you do NOT need your own github token or to push/upload anything), builds a fresh Docker ' +
      'image, and swaps in a new container. Use it whenever the user says things like "update sandbox to the ' +
      'latest", "deploy the newest version", "pull my latest github changes", or "redeploy". Returns a ' +
      'deployment ID; use appcrane_get_logs to monitor progress. ' +
      'Defaults to sandbox; production requires explicit confirmation from the user.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug to deploy' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // gated by app-access
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      // v2.7.11: production deploys require the deploy.production permission —
      // mirrors POST /api/apps/:slug/deploy/:env. Was missing here, so an
      // app-access key could ship to prod via MCP without the permission.
      if (env === 'production' && !userHasAppPermission(user, app, 'deploy.production')) {
        throw new Error('Forbidden: deploying to production requires the deploy.production permission for this app.');
      }
      const db = getDb();

      // v2.7.31: deploy-storm guard — refuse a new deploy when one is already
      // in flight for this app+env, so an agent loop calling appcrane_deploy
      // can't spawn unbounded concurrent builds. Mirrors POST /deploy/:env.
      const { getPortsForSlot } = await import('./portAllocator.js');
      const { deployApp, assertNoInflightDeploy } = await import('./deployer.js');
      assertNoInflightDeploy(db, app.id, env, app.slug);

      const result = db
        .prepare("INSERT INTO deployments (app_id, env, status, deployed_by) VALUES (?, ?, 'pending', ?)")
        .run(app.id, env, user.id);
      const deployId = result.lastInsertRowid;

      const ports = getPortsForSlot(app.slot);

      // Fire-and-forget — agent monitors via logs
      deployApp(deployId, app, env, ports).catch((err) => {
        log.error(`MCP deploy ${deployId} failed: ${err.message}`);
      });

      log.info(`MCP: deploy queued for ${app.slug}/${env} (id=${deployId}) by user ${user.id}`);
      return {
        deployment_id: deployId,
        app: app.slug,
        env,
        status: 'pending',
        next: `Use appcrane_get_logs with slug="${app.slug}" env="${env}" to monitor.`,
      };
    },
  },

  {
    name: 'appcrane_list_releases',
    description:
      'List the deploy/release history for an app + env, newest first — each release is id, version, commit, status (live / rolled_back / failed / pending), who deployed it, and when. Use this to see what is live and to pick a target for appcrane_rollback. App access required.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:  { type: 'string' },
        env:   { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows (default 10).' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // gated by app-access via getAppForUser
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
      const db = getDb();
      const releases = db.prepare(`
        SELECT d.id, d.version, d.commit_hash, d.status, d.started_at, d.finished_at,
          u.name AS deployed_by_name,
          CASE WHEN d.release_path IS NOT NULL AND d.release_path != '' THEN 1 ELSE 0 END AS rollbackable
        FROM deployments d
        LEFT JOIN users u ON d.deployed_by = u.id
        WHERE d.app_id = ? AND d.env = ?
        ORDER BY d.started_at DESC
        LIMIT ?
      `).all(app.id, env, limit);
      return { app: app.slug, env, releases };
    },
  },

  {
    name: 'appcrane_rollback',
    description:
      'Roll an env back to a prior release. Pass deployment_id (from appcrane_list_releases) to target a specific release, or omit it to roll back to the immediately previous one. Re-runs that release from its recorded build (re-uses the cached per-commit image — no rebuild when it is still retained) and health-checks it. Records a NEW deployment and marks the previous live one rolled_back. Owner-only (or global admin).',
    inputSchema: {
      type: 'object',
      properties: {
        slug:          { type: 'string' },
        env:           { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        deployment_id: { type: 'integer', description: 'Target release id. Omit to roll back to the previous release.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // gated per-slug in handler (owner of the app, or global admin)
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      // v2.7.13: rollback is owner-only (or global admin), same gate as promote.
      if (!isAdmin(user) && roleForUserOnApp(user, app) !== 'owner') {
        throw new Error('Forbidden: only the app owner can roll back this app.');
      }
      const { rollbackApp } = await import('./deployer.js');
      const r = await rollbackApp(app, env, args.deployment_id, user.id);
      return {
        app: app.slug,
        env,
        deployment_id: r.deployment_id,
        rolled_back_to: r.rollback_to,
        version: r.version,
        commit_hash: r.commit_hash,
        next: `Use appcrane_get_logs slug="${app.slug}" env="${env}" to confirm the rolled-back release is healthy.`,
      };
    },
  },

  {
    name: 'appcrane_promote',
    description:
      'Promote the current live SANDBOX release to production — the gated sandbox→prod path. Refuses unless sandbox is live AND currently healthy (you do not ship a broken sandbox to prod), and the promoted prod release is health-checked with auto-revert. For github apps this rebuilds production from the EXACT sandbox commit; for managed/upload apps it copies the exact tested sandbox release. Owner-only (or global admin).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // gated per-slug in handler (owner of the app, or global admin)
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      // v2.7.12: promotion is owner-only (or global admin).
      if (!isAdmin(user) && roleForUserOnApp(user, app) !== 'owner') {
        throw new Error('Forbidden: only the app owner can promote to production.');
      }
      const { promoteApp } = await import('./deployer.js');
      const r = await promoteApp(app, user.id);
      return {
        app: app.slug,
        deployment_id: r.deployment_id,
        from_sandbox: r.from_sandbox,
        version: r.version,
        mode: r.mode,
        status: r.status,
        next: `Use appcrane_get_logs slug="${app.slug}" stage="production" to monitor the promotion.`,
      };
    },
  },

  {
    name: 'appcrane_list_requests',
    description:
      'List enhancement requests filed against an app via the AppCrane intake form. ' +
      'Use this when the user asks "what should I work on?", "what\'s queued for X?", or wants to pick up tickets. ' +
      'Returns id, message, app_slug, submitter, and bucket. Buckets: triage (unclaimed), in_progress (someone is working on it), shipped (merged + deployed), validated (requester confirmed). ' +
      'Filter by bucket="triage" to find work to pick up.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Filter by app slug. Omit to see across all accessible apps.' },
        bucket: {
          type: 'string',
          enum: ['triage', 'in_progress', 'shipped', 'validated'],
          description: 'Filter to one bucket. Most useful: "triage" for unclaimed work.',
        },
        limit: { type: 'number', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const db = getDb();
      const limit = Math.min(args.limit || 20, 100);
      const where = [];
      const params = [];
      if (args.slug) {
        // Verify the explicit slug is in the user's MCP scope
        const inScope = isInMcpScope(user, args.slug);
        if (inScope === false) throw new Error(`Forbidden: app ${args.slug} is outside this key's MCP scope`);
        where.push('app_slug = ?');
        params.push(args.slug);
      }
      // Always restrict to what this key can see (admin + scope-set fold to one set)
      const accessibleSlugs = accessibleSlugsForUser(user);
      if (!accessibleSlugs.length) return { requests: [], count: 0 };
      where.push(`app_slug IN (${accessibleSlugs.map(() => '?').join(',')})`);
      params.push(...accessibleSlugs);
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT id, message, app_slug, status, validated_at, user_name, created_at, branch_name, pr_url, fix_version, cost_usd_cents
           FROM enhancement_requests ${whereClause}
           ORDER BY id DESC LIMIT ?`
        )
        .all(...params);
      let requests = rows.map(r => ({ ...r, bucket: bucketize(r.status, r.validated_at) }));
      if (args.bucket) requests = requests.filter(r => r.bucket === args.bucket);
      return { requests, count: requests.length };
    },
  },

  {
    name: 'appcrane_set_request_status',
    description:
      'Move a request through the lifecycle: triage → in_progress → shipped → validated. ' +
      'Use this when the user says "I\'ll take #42" (set to in_progress), after merging a PR (set to shipped), ' +
      'or after confirming a fix works (set to validated). Validated requests are considered closed. ' +
      'Requires app-admin or AppCrane admin role.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Request id (the # column).' },
        bucket: {
          type: 'string',
          enum: ['triage', 'in_progress', 'shipped', 'validated'],
          description: 'Target bucket.',
        },
      },
      required: ['id', 'bucket'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      if (!BUCKETS.includes(args.bucket)) throw new Error(`Unknown bucket: ${args.bucket}`);
      const db = getDb();
      const row = db.prepare(
        'SELECT id, app_slug, status, validated_at FROM enhancement_requests WHERE id = ?'
      ).get(args.id);
      if (!row) throw new Error(`Request ${args.id} not found`);

      // Authz: AppCrane admin OR per-app admin OR per-app owner.
      // The 'shipped' transition is gated by the configurable role_permissions
      // matrix (request.ship permission) so the matrix change applies to MCP
      // and REST identically.
      let appRow = null;
      if (!isAdmin(user)) {
        if (!row.app_slug) throw new Error('Forbidden: only AppCrane admin can move requests with no app');
        appRow = db.prepare('SELECT * FROM apps WHERE slug = ?').get(row.app_slug);
        const ar = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(appRow?.id, user.id);
        const hasAppRole = ar?.app_role === 'admin' || ar?.app_role === 'owner';
        if (!hasAppRole) throw new Error(`Forbidden: not an admin or owner of ${row.app_slug}`);
        if (args.bucket === 'shipped') {
          if (!userHasAppPermission(user, appRow, 'request.ship')) {
            throw new Error(`Forbidden: marking shipped is not permitted by your role on ${row.app_slug}`);
          }
        }
      }

      applyBucket(db, args.id, args.bucket, user.id);
      log.info(`MCP: request ${args.id} → bucket=${args.bucket} (user ${user.id})`);
      return { id: args.id, bucket: args.bucket };
    },
  },

  {
    name: 'appcrane_ls',
    description:
      'List files inside a running app container at a specific path. Use to verify what actually got built / what files made it into the deployed image. Read-only; bound to safe roots (/app and /data only). Returns the directory listing as text.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        path: { type: 'string', description: 'Absolute path inside the container, must start with /app or /data', default: '/app' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const safePath = validateContainerPath(args.path || '/app');
      const { execFileSync } = await import('child_process');
      const containerName = `appcrane-${app.slug}-${env}`;
      try {
        const out = execFileSync('docker', ['exec', containerName, 'ls', '-la', '--', safePath], {
          stdio: 'pipe',
          timeout: 5000,
        }).toString();
        return { app: app.slug, env, path: safePath, listing: out };
      } catch (e) {
        const detail = e.stderr?.toString().trim() || e.message;
        throw new Error(`ls failed in ${containerName}:${safePath}: ${detail}`);
      }
    },
  },

  {
    name: 'appcrane_cat',
    description:
      'Print the contents of a file inside a running app container. Read-only; bound to safe roots (/app and /data only). Refuses files larger than 256KB; truncate by reading the first N bytes via path tricks if you need a tail.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        path: { type: 'string', description: 'Absolute path inside the container, must start with /app or /data' },
      },
      required: ['slug', 'path'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const safePath = validateContainerPath(args.path);
      const { execFileSync } = await import('child_process');
      const containerName = `appcrane-${app.slug}-${env}`;
      const MAX_BYTES = 256 * 1024;
      // Probe size first so we don't pull a multi-MB file into the response.
      let size;
      try {
        const sizeOut = execFileSync('docker', ['exec', containerName, 'stat', '-c', '%s', '--', safePath], {
          stdio: 'pipe',
          timeout: 5000,
        }).toString().trim();
        size = parseInt(sizeOut, 10);
      } catch (e) {
        const detail = e.stderr?.toString().trim() || e.message;
        throw new Error(`stat failed in ${containerName}:${safePath}: ${detail}`);
      }
      if (Number.isFinite(size) && size > MAX_BYTES) {
        throw new Error(`File too large (${size} bytes > ${MAX_BYTES} cap). Use a tail/head invocation outside this tool, or read a specific range.`);
      }
      try {
        const out = execFileSync('docker', ['exec', containerName, 'cat', '--', safePath], {
          stdio: 'pipe',
          timeout: 5000,
          maxBuffer: MAX_BYTES + 1024,
        }).toString();
        return { app: app.slug, env, path: safePath, size, content: out };
      } catch (e) {
        const detail = e.stderr?.toString().trim() || e.message;
        throw new Error(`cat failed in ${containerName}:${safePath}: ${detail}`);
      }
    },
  },

  {
    name: 'appcrane_stage_from_url',
    description:
      'Stage a file by having AppCrane DOWNLOAD it, and return its token. '
      + 'THE CHEAPEST WAY to get a large artifact in: the bytes go host-to-host and never pass through '
      + 'your context, so a 600KB bundle costs the same handful of tokens as a 6KB one. Prefer this over '
      + 'appcrane_stage_chunk for anything bigger than a small text file. '
      + 'Give it a URL your build already produces — a GitHub release asset, an S3/R2 presigned URL, any '
      + 'https link the server can reach. Pass sha256 to have the downloaded bytes verified before a token '
      + 'is issued. Then deploy with appcrane_deploy_artifact. '
      + 'https only; redirects are not followed; private and link-local addresses are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Direct https URL to the file. Must not redirect — give the final URL.' },
        filename: { type: 'string', description: 'Name to stage it under. For a deploy it must end in .zip, .tar.gz or .tgz. Defaults to the last path segment.' },
        sha256:   { type: 'string', description: 'Optional hex SHA-256 of the file, verified before the token is issued.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const { fetchToBuffer } = await import('./remoteFetch.js');
      const buf = await fetchToBuffer(args.url);

      const { createHash, randomBytes } = await import('crypto');
      const actual = createHash('sha256').update(buf).digest('hex');
      if (args.sha256 && args.sha256 !== actual) {
        throw new Error(
          `downloaded file SHA-256 mismatch: you declared ${args.sha256}, the bytes hash to ${actual}. `
          + 'Refusing to stage something other than what you asked for.',
        );
      }

      const { mkdirSync, mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const stagedRoot = join(process.env.DATA_DIR || './data', 'staged');
      mkdirSync(stagedRoot, { recursive: true });
      const scratch = mkdtempSync(join(stagedRoot, 'url-'));
      const fallback = decodeURIComponent(new URL(args.url).pathname.split('/').pop() || 'download');
      const safeName = String(args.filename || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
      const scratchPath = join(scratch, safeName);
      writeFileSync(scratchPath, buf);

      const db = getDb();
      const token = randomBytes(16).toString('base64url');
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`
        INSERT INTO staged_files (token, user_id, filename, size_bytes, sha256, scratch_path, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, user.id, safeName, buf.length, actual, scratchPath, expiresAt);

      return {
        token,
        filename: safeName,
        size_bytes: buf.length,
        sha256: actual,
        expires_at: expiresAt,
        note: 'Deploy it with appcrane_deploy_artifact { slug, env, token }.',
      };
    },
  },
  {
    name: 'appcrane_stage_chunk',
    description:
      'Upload one part of a SMALL file to AppCrane over MCP. For anything bigger than a few KB use '
      + 'appcrane_stage_from_url instead — the bytes here are emitted by the model, so they cost output '
      + 'tokens per character and fail on a single typo. Capped at 8 parts for that reason. '
      + 'Split the file into parts small enough for a tool call (~256KB of base64 each is comfortable), send '
      + 'each with the same `session` and `of`, then call appcrane_stage_assemble. Parts may be sent in any '
      + 'order and re-sent to replace a corrupted one; the reply lists which parts are still missing. '
      + 'Use encoding="base64" for anything binary. Pass sha256 of THIS part to have it verified on arrival.',
    inputSchema: {
      type: 'object',
      properties: {
        session:  { type: 'string', description: 'Opaque id grouping the parts of one file. Any unique string; reuse it for every part.' },
        part:     { type: 'integer', minimum: 1, description: '1-based part number.' },
        of:       { type: 'integer', minimum: 1, description: 'Total number of parts. Identical across every part of a session.' },
        content:  { type: 'string', description: "This part's bytes, encoded per `encoding`." },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Defaults to utf-8. Use base64 for binary.' },
        sha256:   { type: 'string', description: 'Optional hex SHA-256 of this part, verified on arrival.' },
      },
      required: ['session', 'part', 'of', 'content'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const { session, part, of } = args;
      const encoding = args.encoding || 'utf-8';
      if (!Number.isInteger(part) || !Number.isInteger(of) || of < 1 || part < 1 || part > of) {
        throw new Error(`invalid part/of: part must be an integer in 1..of (got part=${part}, of=${of})`);
      }
      // A guardrail, not a limit of the transport.
      //
      // Every byte pushed this way has to be EMITTED by the model, one base64
      // character at a time. A 600KB bundle is ~800KB of base64 across dozens of
      // calls — expensive per character, and a single wrong character fails the
      // digest at the end, after all of it has been paid for. There are two ways
      // in that cost nothing per byte, and an agent that has started down this
      // road for a large file should be told about them before part 4 of 40, not
      // after.
      if (of > 8) {
        throw new Error(
          `${of} parts is too many for this tool — it is for small text files, not bulk data. `
          + 'Every byte here is emitted by the model, so a large file costs output tokens per character '
          + 'and fails on a single typo. Instead: appcrane_stage_from_url { url, sha256 } has AppCrane '
          + 'download it (bytes never touch your context), or, if you have a shell, '
          + '`curl -F file=@<file> -H "X-API-Key: <your dhk_mcp_ key>" https://<host>/api/files/staged` '
          + '— that endpoint accepts MCP keys. Both return a token for appcrane_deploy_artifact.',
        );
      }

      const bytes = Buffer.from(args.content, encoding === 'base64' ? 'base64' : 'utf-8');
      const { createHash } = await import('crypto');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (args.sha256 && args.sha256 !== actual) {
        throw new Error(
          `part ${part} SHA-256 mismatch: you declared ${args.sha256} but the received bytes hash to ${actual}. `
          + 'The part was corrupted in transit — resend it.',
        );
      }

      const db = getDb();
      db.prepare("DELETE FROM stage_chunks WHERE created_at < datetime('now', '-2 hours')").run();

      const existing = db.prepare('SELECT user_id, of_total FROM stage_chunks WHERE session = ? LIMIT 1').get(session);
      if (existing) {
        if (existing.user_id !== user.id) throw new Error(`session '${session}' belongs to a different user`);
        if (existing.of_total !== of) throw new Error(`session '${session}' was started with of=${existing.of_total}, not ${of}`);
      }

      db.prepare(
        `INSERT INTO stage_chunks (session, user_id, part, of_total, content, sha256)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session, part) DO UPDATE SET
           content = excluded.content, sha256 = excluded.sha256, created_at = datetime('now')`
      ).run(session, user.id, part, of, args.content, actual);

      const have = db.prepare('SELECT part FROM stage_chunks WHERE session = ? ORDER BY part').all(session).map((r) => r.part);
      const missing = [];
      for (let p = 1; p <= of; p++) if (!have.includes(p)) missing.push(p);
      return { session, part, of, received_bytes: bytes.length, sha256: actual, missing_parts: missing, complete: missing.length === 0 };
    },
  },
  {
    name: 'appcrane_stage_assemble',
    description:
      'Join the parts pushed with appcrane_stage_chunk into one staged file and return its token. '
      + 'Hand that token to appcrane_deploy_artifact to deploy it — that pair is a complete, MCP-native '
      + 'deploy for an app with no repo, and it does not touch GitHub. '
      + 'Pass sha256 of the WHOLE original file to have the reassembled bytes verified before the token is issued; '
      + 'without it you are trusting that every part arrived intact.',
    inputSchema: {
      type: 'object',
      properties: {
        session:  { type: 'string', description: 'The session id used for the parts.' },
        filename: { type: 'string', description: 'Name for the assembled file. For a deploy it must end in .zip, .tar.gz or .tgz.' },
        sha256:   { type: 'string', description: 'Optional hex SHA-256 of the whole original file, verified before the token is issued.' },
      },
      required: ['session', 'filename'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM stage_chunks WHERE session = ? ORDER BY part').all(args.session);
      if (!rows.length) throw new Error(`no parts staged for session '${args.session}' (unknown id, or swept after 2 hours)`);
      if (rows[0].user_id !== user.id) throw new Error(`session '${args.session}' belongs to a different user`);

      const of = rows[0].of_total;
      const missing = [];
      for (let p = 1; p <= of; p++) if (!rows.some((r) => r.part === p)) missing.push(p);
      if (missing.length) throw new Error(`cannot assemble: parts ${missing.join(', ')} of ${of} are missing`);

      const { createHash, randomBytes } = await import('crypto');
      const { mkdtempSync, writeFileSync } = await import('fs');
      const { join } = await import('path');

      const buf = Buffer.concat(rows.map((r) => Buffer.from(r.content, 'base64')));
      const actual = createHash('sha256').update(buf).digest('hex');
      if (args.sha256 && args.sha256 !== actual) {
        throw new Error(
          `assembled file SHA-256 mismatch: you declared ${args.sha256}, the joined parts hash to ${actual}. `
          + 'Re-push the parts rather than deploying bytes that are not what you built.',
        );
      }

      // Same store the curl upload writes to, so appcrane_deploy_artifact and
      // appcrane_push_staged_file consume this with no special case.
      const dataDir = process.env.DATA_DIR || './data';
      const stagedRoot = join(dataDir, 'staged');
      const { mkdirSync } = await import('fs');
      mkdirSync(stagedRoot, { recursive: true });
      const scratch = mkdtempSync(join(stagedRoot, 'mcp-'));
      const safeName = String(args.filename).replace(/[^A-Za-z0-9._-]/g, '_');
      const scratchPath = join(scratch, safeName);
      writeFileSync(scratchPath, buf);

      const token = randomBytes(16).toString('base64url');
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`
        INSERT INTO staged_files (token, user_id, filename, size_bytes, sha256, scratch_path, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, user.id, safeName, buf.length, actual, scratchPath, expiresAt);
      db.prepare('DELETE FROM stage_chunks WHERE session = ?').run(args.session);

      return {
        token,
        filename: safeName,
        size_bytes: buf.length,
        sha256: actual,
        expires_at: expiresAt,
        note: 'Deploy it with appcrane_deploy_artifact { slug, env, token }.',
      };
    },
  },
  {
    name: 'appcrane_rename_app',
    description:
      'Rename an app\'s slug. The slug is its URL, its container name and its data directory, so this '
      + 'changes all three — but it is NOT destructive: deploy history, env vars, ports, per-app roles and '
      + 'grants are keyed on the app id, not the slug, and survive untouched. The old slug is kept as a '
      + 'redirect unless redirect=false. Platform admin. '
      + 'Use this instead of recreating an app under a new name, which is what loses the history. '
      + 'To free a slug held by an app you no longer want, rename THAT app out of the way with '
      + 'redirect=false rather than deleting it — deleting clears the database rows but leaves '
      + 'data/apps/<slug> on disk, and the rename then refuses because the directory is still there.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:     { type: 'string', description: 'Current app slug.' },
        new_slug: { type: 'string', description: 'New slug: lowercase letters, digits and dashes, starting with a letter or digit.' },
        redirect: { type: 'boolean', default: true, description: 'Keep the old slug redirecting to the new one. Pass false when you are freeing the old slug for another app to take.' },
      },
      required: ['slug', 'new_slug'],
      additionalProperties: false,
    },
    requiredRole: 'platform_admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      const { renameApp } = await import('./appRename.js');
      const out = await renameApp({
        app,
        newSlug: args.new_slug,
        redirect: args.redirect !== false,
        userId: user.id,
      });
      return {
        ...out,
        note: out.redeploying.length
          ? `Redeploying ${out.redeploying.join(' and ')} so the containers pick up the new name. Poll appcrane_get_app.`
          : 'No live environment to redeploy.',
      };
    },
  },
  {
    name: 'appcrane_deploy_artifact',
    description:
      'Deploy a release from an uploaded BUNDLE instead of from git. For an app with no GitHub repo, and the '
      + 'fallback when the repo path is unavailable — an expired service-account PAT blocks every managed-repo '
      + 'write, and this route does not touch GitHub at all. '
      + 'Two steps: (1) upload the bundle with '
      + '`' + 'curl -F file=@dist.zip -H "X-API-Key: <your dhk_mcp_ key>" https://<host>/api/files/staged' + '`' + ' '
      + '— your MCP key IS allowed on that endpoint; it returns { token, sha256, size_bytes }. (2) Call this tool '
      + 'with that token. Accepts .zip, .tar.gz, .tgz, up to the staged-file limit. '
      + 'The release is identified by a SHA-256 AppCrane computes over the bytes, recorded as commit_hash '
      + '"sha256:<digest>"; the tool re-hashes the staged bytes and refuses if they no longer match what was '
      + 'staged. Returns that digest — compare it against the one you computed locally. '
      + 'Deploys to sandbox unless env=production.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:           { type: 'string', description: 'Target app slug' },
        env:            { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        token:          { type: 'string', description: 'Token returned by POST /api/files/staged' },
        commit_message: { type: 'string', description: 'Optional release note, shown in the deploy history' },
        commit_sha:     { type: 'string', description: 'Optional git SHA from the machine that BUILT the bundle. Recorded as context only — it is not verified and does not become the release identity.' },
      },
      required: ['slug', 'token'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);

      const db = getDb();
      const row = db.prepare('SELECT * FROM staged_files WHERE token = ?').get(args.token);
      if (!row)                    throw new Error('staged file not found (token unknown or already swept)');
      if (row.user_id !== user.id) throw new Error('staged file is owned by a different user');
      if (row.pushed_at)           throw new Error('staged file was already consumed');
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (row.expires_at < now)    throw new Error(`staged file expired at ${row.expires_at}`);

      // Re-hash rather than trust the stored value. The staged blob sits on
      // disk between the upload and this call, and the digest that becomes the
      // release identity has to be taken from the bytes about to be deployed —
      // reading it out of the row would record a digest for one set of bytes
      // while deploying another, which is the exact failure the digest exists
      // to make impossible.
      const { digestFile } = await import('./artifactDigest.js');
      const actual = await digestFile(row.scratch_path);
      if (actual !== row.sha256) {
        throw new Error(
          `staged file no longer matches what was uploaded (staged ${row.sha256.slice(0, 12)}…, `
          + `on disk ${actual.slice(0, 12)}…) — refusing to deploy it`,
        );
      }

      const { deployArtifact } = await import('./artifactDeploy.js');
      const out = await deployArtifact({
        app,
        env,
        filePath: row.scratch_path,
        filename: row.filename,
        declaredSha: (args.commit_sha || '').slice(0, 40) || null,
        commitMessage: (args.commit_message || '').slice(0, 200) || null,
        userId: user.id,
        // The staged store owns these bytes and sweeps them itself; deleting
        // them here would pull the file out from under its own bookkeeping.
        keepSource: true,
      });
      db.prepare("UPDATE staged_files SET pushed_at = datetime('now') WHERE token = ?").run(row.token);

      return {
        deployment_id: out.deployId,
        app: app.slug,
        env,
        status: 'pending',
        commit_hash: out.artifact.commit_hash,
        artifact: {
          sha256: out.artifact.sha256,
          bytes: out.artifact.bytes,
          filename: out.artifact.filename,
          declared_commit_sha: out.artifact.declared_commit_sha,
        },
        note: 'Deploy runs asynchronously. Poll appcrane_wait_deploy or appcrane_get_app for the result.',
      };
    },
  },
  {
    name: 'appcrane_push_staged_file',
    description:
      'Move a previously-staged file into a running container at a path under /app or /data. THE WAY TO GET LARGE BINARIES (DMGs, datasets, bundles) into a container when they\'re too big to inline through appcrane_cp. ' +
      'Two steps: (1) upload the bytes with a plain multipart POST to ' + '`' + 'curl -F file=@local.dmg -H "X-API-Key: <your dhk_mcp_ key>" https://<host>/api/files/staged' + '`' + ' — your MCP key IS allowed on this endpoint (v2.10.6+); it returns { token, sha256, size_bytes }. (2) Call this tool with that token and a dest path. ' +
      'The container must be running. Path is validated (no "..", must start with /app or /data). The staged blob is deleted on success.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:  { type: 'string', description: 'Target app slug' },
        env:   { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        token: { type: 'string', description: 'Token returned by POST /api/files/staged' },
        dest:  { type: 'string', description: 'Absolute container path under /app or /data — destination file or directory' },
      },
      required: ['slug', 'token', 'dest'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const safeDest = validateContainerPath(args.dest);

      const db = getDb();
      const row = db.prepare('SELECT * FROM staged_files WHERE token = ?').get(args.token);
      if (!row)                       throw new Error('staged file not found (token unknown or already swept)');
      if (row.user_id !== user.id)    throw new Error('staged file is owned by a different user');
      if (row.pushed_at)              throw new Error('staged file was already consumed');
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (row.expires_at < now)       throw new Error(`staged file expired at ${row.expires_at}`);

      const { execFileSync } = await import('child_process');
      const containerName = `appcrane-${app.slug}-${env}`;
      const cpSpec = `${containerName}:${safeDest}`;
      try {
        execFileSync('docker', ['cp', row.scratch_path, cpSpec], {
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch (e) {
        const detail = e.stderr?.toString().trim() || e.message;
        throw new Error(`docker cp into ${cpSpec} failed: ${detail}`);
      }

      // Mark consumed and reap the scratch dir. The 5-min sweeper would
      // catch this at expires_at anyway, but freeing disk immediately is
      // friendlier on busy boxes.
      try {
        const { rmSync } = await import('fs');
        const { dirname } = await import('path');
        rmSync(dirname(row.scratch_path), { recursive: true, force: true });
      } catch (_) { /* sweeper will retry */ }
      db.prepare("UPDATE staged_files SET pushed_at = datetime('now') WHERE token = ?").run(row.token);

      return {
        app: app.slug,
        env,
        container: containerName,
        dest: safeDest,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
      };
    },
  },

  {
    name: 'appcrane_wait_deploy',
    description:
      'Block until a deployment reaches a terminal state (live / failed / rolled_back), then return its final status. ' +
      'Use after appcrane_deploy instead of polling appcrane_get_logs in a loop. Returns immediately if the deployment ' +
      'is already terminal. Defaults to 180s timeout, hard-capped at 600s. On timeout, returns { status: "pending", ' +
      'timed_out: true } so the caller can decide whether to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'number', description: 'Deployment id from appcrane_deploy' },
        timeout_sec:   { type: 'number', description: 'How long to wait. Default 180s, max 600s.', default: 180 },
      },
      required: ['deployment_id'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const id = parseInt(args.deployment_id, 10);
      if (!Number.isFinite(id) || id <= 0) throw new Error('deployment_id must be a positive integer');
      const timeoutSec = Math.min(Math.max(parseInt(args.timeout_sec, 10) || 180, 1), 600);
      const TERMINAL = new Set(['live', 'failed', 'rolled_back']);

      const db = getDb();
      // Verify the caller can see this deployment's app — same accessibility
      // as appcrane_get_app would enforce. Resolves the slug from the row.
      const initial = db
        .prepare(
          `SELECT d.id, d.app_id, d.env, d.status, d.version, d.commit_hash, d.started_at, d.finished_at, d.frontend_assets,
                  a.slug AS app_slug
           FROM deployments d JOIN apps a ON a.id = d.app_id
           WHERE d.id = ?`
        )
        .get(id);
      if (!initial) throw new Error(`Deployment #${id} not found`);
      // getAppForUser throws Forbidden if the caller can't see the app.
      getAppForUser(user, initial.app_slug);

      // Already terminal? Return immediately.
      if (TERMINAL.has(initial.status)) {
        return {
          deployment_id: id,
          app: initial.app_slug,
          env: initial.env,
          status: initial.status,
          version: initial.version,
          commit_hash: initial.commit_hash,
          started_at: initial.started_at,
          finished_at: initial.finished_at,
          frontend_assets: initial.frontend_assets,
          timed_out: false,
          waited_ms: 0,
        };
      }

      // Poll once per 2s until terminal or timeout. setInterval-style with
      // setTimeout so we can cancel cleanly. No DB load to speak of —
      // single primary-key lookup per tick.
      const start = Date.now();
      const deadline = start + timeoutSec * 1000;
      const stmt = db.prepare(
        `SELECT id, status, version, commit_hash, started_at, finished_at, frontend_assets
         FROM deployments WHERE id = ?`
      );
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await new Promise(r => setTimeout(r, Math.min(2000, remaining)));
        const row = stmt.get(id);
        if (!row) {
          // Deleted under us — extremely unusual. Return a synthetic gone status.
          return {
            deployment_id: id,
            app: initial.app_slug,
            env: initial.env,
            status: 'gone',
            timed_out: false,
            waited_ms: Date.now() - start,
          };
        }
        if (TERMINAL.has(row.status)) {
          return {
            deployment_id: id,
            app: initial.app_slug,
            env: initial.env,
            status: row.status,
            version: row.version,
            commit_hash: row.commit_hash,
            started_at: row.started_at,
            finished_at: row.finished_at,
            frontend_assets: row.frontend_assets,
            timed_out: false,
            waited_ms: Date.now() - start,
          };
        }
      }

      // Timed out — give the caller back the latest known state.
      const last = stmt.get(id) || initial;
      return {
        deployment_id: id,
        app: initial.app_slug,
        env: initial.env,
        status: last.status,
        version: last.version,
        commit_hash: last.commit_hash,
        started_at: last.started_at,
        finished_at: last.finished_at,
        frontend_assets: last.frontend_assets,
        timed_out: true,
        waited_ms: Date.now() - start,
        next: `Deployment still ${last.status} after ${timeoutSec}s. Call appcrane_wait_deploy again or use appcrane_get_logs to see what's happening.`,
      };
    },
  },

  {
    name: 'appcrane_get_deploy_log',
    description:
      'Read the deploy/build log for a specific deployment — the output that came out of clone / npm install / docker build / health-validate, BEFORE the container started running. This is what you want when a deploy fails fast (1-2 second failures are almost always pre-build errors that never reach the runtime container, so appcrane_get_logs has nothing to show). Pass a deployment_id from appcrane_deploy / appcrane_get_app.recent_deployments, OR omit it and pass slug+env to get the latest deployment\'s log.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'integer', description: 'Specific deployment id. Preferred — unambiguous.' },
        slug:          { type: 'string',  description: 'App slug. Required when deployment_id is not given.' },
        env:           { type: 'string',  enum: ['sandbox', 'production'], description: 'Required when deployment_id is not given.' },
        tail:          { type: 'integer', minimum: 1, maximum: 5000, default: 500, description: 'Return only the last N lines. Defaults to 500; full log can be many KB on a long build.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const db = getDb();
      let row;
      if (args.deployment_id) {
        row = db.prepare(`
          SELECT d.*, a.slug AS app_slug
          FROM deployments d JOIN apps a ON a.id = d.app_id
          WHERE d.id = ?
        `).get(args.deployment_id);
        if (!row) throw new Error(`Deployment ${args.deployment_id} not found`);
        // Authz: caller must have access to the deployment's app.
        getAppForUser(user, row.app_slug);
      } else {
        if (!args.slug || !args.env) {
          throw new Error('Either deployment_id, or both slug and env, must be provided');
        }
        const app = getAppForUser(user, args.slug);
        row = db.prepare(`
          SELECT * FROM deployments
          WHERE app_id = ? AND env = ?
          ORDER BY started_at DESC
          LIMIT 1
        `).get(app.id, args.env);
        if (!row) throw new Error(`No deployments found for ${args.slug} (${args.env})`);
        row.app_slug = app.slug;
      }

      const fullLog = row.log || '';
      const tail = Math.min(parseInt(args.tail, 10) || 500, 5000);
      const lines = fullLog.split('\n');
      const trimmed = lines.length > tail ? lines.slice(-tail) : lines;
      const truncated = lines.length > tail;

      return {
        deployment_id:   row.id,
        app:             row.app_slug,
        env:             row.env,
        status:          row.status,
        version:         row.version,
        commit_hash:     row.commit_hash,
        commit_message:  row.commit_message,
        started_at:      row.started_at,
        finished_at:     row.finished_at,
        duration_seconds: row.finished_at && row.started_at
          ? Math.round((new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000)
          : null,
        log:             trimmed.join('\n'),
        line_count:      trimmed.length,
        truncated,
        original_line_count: lines.length,
      };
    },
  },

  {
    name: 'appcrane_get_logs',
    description:
      'Get recent runtime logs from a running app container (docker logs). Use this for runtime issues — once the container is up. ' +
      'Returns the most recent N lines (default 100, max 1000). Pass search to filter to lines containing a substring (case-insensitive). ' +
      'NOT the right tool for fast deploy failures (1-2 second exits, "no such container" errors): those happen during clone / npm install / docker build / health-validate, BEFORE any container exists. Use appcrane_get_deploy_log for that.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        env: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        lines: { type: 'number', default: 100, minimum: 1, maximum: 1000 },
        search: { type: 'string', description: 'Filter to lines containing this substring (case-insensitive)' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      const lines = Math.min(args.lines || 100, 1000);
      const { getAppLogs } = await import('./docker.js');
      const logLines = await getAppLogs(app.slug, env, lines, args.search || '');
      return { app: app.slug, env, lines: logLines, count: logLines.length };
    },
  },

  {
    name: 'appcrane_create_app',
    description:
      'Register a new app in AppCrane, either from a GitHub repository or from a prebuilt container image. ' +
      'Use this only after the user has explicitly confirmed they want to onboard a new app and told you ' +
      'which source to use — a real github URL, or an image reference for source_type=\'image\'. ' +
      'Allocates ports, creates the data directories, configures Caddy routing, and starts health checks. ' +
      'After this returns, call appcrane_set_secret to set any required secrets, then appcrane_deploy to ship the first build. ' +
      'For an image app there is nothing to build: the deploy pulls image_ref and starts it, so also pass ' +
      'container_port and health_path unless the image happens to match AppCrane\'s own 3000 + /api/health defaults. ' +
      'Requires the create-apps permission (global admins, or any role a platform admin granted at Settings → Roles).',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Display name (shown in dashboard)' },
        slug:        { type: 'string', description: 'URL-safe identifier — lowercase letters, digits, dashes; must start with a letter or digit. Lives at /<slug>/.' },
        // No source_type existed here before v2.59.0 — this tool hardcoded
        // 'github' and required github_url, so the image source was
        // unreachable through MCP no matter what the other two enums allowed.
        // 'managed' and 'upload' are deliberately NOT offered: a managed app is
        // created by appcrane_create_managed_app (it also creates the repo),
        // and an upload app is created through the artifact flow.
        source_type: { type: 'string', enum: ['github', 'image'], description: "'github' (default) clones and builds a repo; 'image' runs a prebuilt image and never builds. Implied when image_ref is passed." },
        github_url:  { type: 'string', description: 'GitHub repo URL, e.g. https://github.com/me/mysite. Required unless source_type is \'image\'.' },
        branch:      { type: 'string', description: 'Branch to track. Default: main', default: 'main' },
        image_ref:      { type: 'string', description: IMAGE_REF_DESC },
        container_port: { type: 'integer', minimum: 1, maximum: 65535, description: CONTAINER_PORT_DESC },
        health_path:    { type: 'string', description: HEALTH_PATH_DESC },
        description: { type: 'string' },
        domain:      { type: 'string', description: 'Optional custom domain. If omitted, the app lives under CRANE_DOMAIN/<slug>/.' },
        github_token:    { type: 'string', description: 'GitHub PAT for private repos. Stored encrypted; only used to clone.' },
        max_ram_mb:      { type: 'number', description: 'Per-container memory cap. Default: 512.' },
        max_cpu_percent: { type: 'number', description: 'Per-container CPU cap. Default: 50.' },
      },
      required: ['name', 'slug'],
      additionalProperties: false,
    },
    requiredRole: 'create_app',
    handler: async (user, args) => {
      // Mirror server/routes/apps.js POST / validation rules
      const { name, slug, github_url } = args;
      if (!name || !slug) throw new Error('name and slug are required');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('slug must be lowercase alphanumeric with dashes');
      if (args.branch && !/^[A-Za-z0-9._/\-]{1,200}$/.test(args.branch)) {
        throw new Error('branch must be alphanumeric with . _ / - (max 200 chars)');
      }
      // image_ref alone is enough to mean 'image'. An agent that passes the
      // reference but forgets the discriminator would otherwise create a github
      // app carrying an image reference nothing reads.
      const sourceType = args.source_type || (args.image_ref ? 'image' : 'github');
      const image = await validateImageFields(args);
      if (sourceType === 'image') {
        if (!image.image_ref) throw new Error("source_type='image' requires image_ref");
        if (github_url) throw new Error("source_type='image' takes no github_url — an image app has no repo to clone");
      } else {
        if (!github_url) throw new Error('github_url is required (or pass image_ref for an image app)');
        if (!/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+(\.git)?\/?$/.test(github_url)) {
          throw new Error('github_url must be a valid github.com URL');
        }
      }

      const db = getDb();
      if (db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug)) {
        throw new Error(`App slug '${slug}' already exists`);
      }

      const { getNextSlot, getPortsForSlot } = await import('./portAllocator.js');
      const { reloadCaddy } = await import('./caddy.js');

      const slot = getNextSlot(db);
      const ports = getPortsForSlot(slot);
      // v2.21.5: only platform admins choose CPU/memory; others get defaults.
      const platAdmin = user.role === 'platform_admin';
      const resourceLimits = JSON.stringify({
        max_ram_mb:      (platAdmin && args.max_ram_mb)      || 512,
        max_cpu_percent: (platAdmin && args.max_cpu_percent) || 50,
      });
      const tokenEncrypted = args.github_token ? encrypt(args.github_token) : null;
      const branch = args.branch || 'main';

      const result = db.prepare(`
        INSERT INTO apps (name, slug, slot, domain, description, category, source_type, github_url, branch, github_token_encrypted, resource_limits, created_by, image_ref, container_port, health_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, slug, slot, args.domain || null, args.description || null, null, sourceType,
        github_url || null, branch, tokenEncrypted, resourceLimits, user.id,
        image.image_ref ?? null, image.container_port ?? null, image.health_path ?? null);
      const appId = result.lastInsertRowid;

      for (const env of ['production', 'sandbox']) {
        db.prepare('INSERT INTO health_configs (app_id, env) VALUES (?, ?)').run(appId, env);
        db.prepare('INSERT INTO health_state (app_id, env) VALUES (?, ?)').run(appId, env);
      }
      // Auto-assign creator as both member and owner. The app_user_roles
      // owner row is what makes "⚠ No owner" go away on /applications and
      // gives this user per-app authz boundaries (e.g. the appcrane_*
      // access-management tools). Forgetting it was the v2.5.12 bug.
      db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(appId, user.id);
      db.prepare(`
        INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, 'owner')
        ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = 'owner'
      `).run(appId, user.id);

      const webhookToken = crypto.randomBytes(16).toString('hex');
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO webhook_configs (app_id, token, secret) VALUES (?, ?, ?)').run(appId, webhookToken, webhookSecret);

      const dataDir = process.env.DATA_DIR || './data';
      const appDir = join(dataDir, 'apps', slug);
      for (const env of ['production', 'sandbox']) {
        const envDir = join(appDir, env);
        mkdirSync(join(envDir, 'releases'), { recursive: true });
        mkdirSync(join(envDir, 'shared', 'data'), { recursive: true });
      }

      try { await reloadCaddy(); } catch (_) {}
      try {
        const { refreshAppChecks } = await import('./healthChecker.js');
        refreshAppChecks(appId);
      } catch (_) {}

      log.info(`MCP: app '${slug}' created by user ${user.id}`);
      const craneDomain = process.env.CRANE_DOMAIN;
      const urls = craneDomain ? {
        production: `https://${craneDomain}/${slug}`,
        sandbox:    `https://${craneDomain}/${slug}-sandbox`,
      } : null;
      return {
        app: {
          slug, name, branch,
          source_type: sourceType,
          github_url: github_url || null,
          image_ref: image.image_ref ?? null,
          container_port: image.container_port ?? null,
          health_path: image.health_path ?? null,
        },
        ports,
        urls,
        next: `Set secrets with appcrane_set_secret, then deploy with appcrane_deploy slug="${slug}" stage="sandbox".`,
      };
    },
  },

  {
    name: 'appcrane_update_app',
    description:
      'Patch fields on an existing app. Use this to fix a missing github_url after the fact, change branch, rotate the github_token, retag with category/visibility, point an image app at a new image_ref, or adjust resource limits — anything you would otherwise need direct DB access for. Only includes fields you pass; omitted fields are left alone. To clear a string field pass an empty string. Returns the same shape as appcrane_get_app.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:           { type: 'string', description: 'App slug to update.' },
        name:           { type: 'string' },
        description:    { type: 'string' },
        category:       { type: 'string' },
        domain:         { type: 'string' },
        // 'upload' added in v2.53.0 with the artifact-deploy flow; this enum was
        // missed, so the REST route accepted a source type the MCP tool rejected.
        // 'image' (v2.59.0) was the same story a second time — the enum here is
        // a THIRD gate on top of POST and PUT in routes/apps.js, so a source
        // type added to the column's CHECK is not usable until it is listed in
        // all three.
        // 'managed_legacy' stays readable but is not offered as a destination —
        // it marks pre-v2.3.1 rows that replay an old release directory.
        source_type:    { type: 'string', enum: ['github', 'managed', 'upload', 'image'] },
        github_url:     { type: 'string', description: 'github.com URL of the source repo. Pass empty string to clear.' },
        branch:         { type: 'string' },
        image_ref:      { type: 'string', description: IMAGE_REF_DESC + ' Pass empty string to clear.' },
        container_port: { type: 'integer', minimum: 1, maximum: 65535, description: CONTAINER_PORT_DESC },
        health_path:    { type: 'string', description: HEALTH_PATH_DESC + ' Pass empty string to restore the default.' },
        github_token:   { type: 'string', description: 'PAT for private clones. Stored encrypted (AES-256-GCM). Omit to leave the existing token alone; pass empty string to clear it; pass a value to rotate.' },
        visibility:     { type: 'string', enum: ['public', 'private', 'hidden'] },
        public_access:  { type: 'integer', enum: [0, 1] },
        image_retention: { type: 'integer', minimum: 0, maximum: 50 },
        frame_ancestors: { type: 'string' },
        auth_bypass_paths: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string' },
          description: 'v2.7.27: array of path prefixes (e.g. ["/ws/local-runner"]) that bypass SSO forward_auth on this app. Requests under these prefixes reach the container with NO X-AppCrane-* identity headers — the app authenticates them itself (e.g. token in query string). Caddy suppresses access logging for these paths to prevent token leakage to log storage. Pass [] or null to clear.',
        },
        max_ram_mb:      { type: 'number', description: 'Per-container memory cap.' },
        max_cpu_percent: { type: 'number', description: 'Per-container CPU cap (0-100).' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'admin',
    handler: async (user, args) => {
      const { slug } = args;
      if (!slug || typeof slug !== 'string') throw new Error('slug is required');

      const db = getDb();
      const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
      if (!app) throw new Error(`App not found: ${slug}`);

      // Validate any field that's been passed. Mirrors server/routes/apps.js
      // PUT validation; agents calling this through MCP shouldn't be able
      // to bypass the same checks.
      const updates = {};
      if (args.name        !== undefined) {
        if (!args.name || typeof args.name !== 'string') throw new Error('name must be a non-empty string');
        updates.name = args.name;
      }
      if (args.description !== undefined) updates.description = args.description ? String(args.description) : null;
      if (args.category    !== undefined) updates.category    = args.category    ? String(args.category)    : null;
      if (args.domain      !== undefined) {
        // v2.10.0: custom passthrough domain (served at root, no SSO/topbar).
        const { validateCustomDomain } = await import('../utils/customDomain.js');
        updates.domain = validateCustomDomain(args.domain, process.env.CRANE_DOMAIN);
        if (updates.domain) {
          const clash = db.prepare('SELECT slug FROM apps WHERE lower(domain) = ? AND id != ?').get(updates.domain, app.id);
          if (clash) throw new Error(`Domain "${updates.domain}" is already used by app "${clash.slug}"`);
        }
      }
      if (args.source_type !== undefined) updates.source_type = args.source_type;
      Object.assign(updates, await validateImageFields(args));
      // An app whose source_type says 'image' with no image_ref has nothing to
      // deploy, and the failure surfaces at deploy time as a docker error
      // rather than here as a rejected edit. Checked against the merged view so
      // either half of the pair can arrive in either call.
      const nextSourceType = updates.source_type ?? app.source_type;
      const nextImageRef   = 'image_ref' in updates ? updates.image_ref : app.image_ref;
      if (nextSourceType === 'image' && !nextImageRef) {
        throw new Error("source_type='image' requires image_ref — pass it in this same call");
      }
      if (args.github_url  !== undefined) {
        if (args.github_url && !/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+(\.git)?\/?$/.test(args.github_url)) {
          throw new Error('github_url must be a valid github.com URL or empty string to clear');
        }
        updates.github_url = args.github_url || null;
      }
      if (args.branch !== undefined) {
        if (args.branch && !/^[A-Za-z0-9._/\-]{1,200}$/.test(args.branch)) {
          throw new Error('branch must be alphanumeric with . _ / - (max 200 chars)');
        }
        updates.branch = args.branch || null;
      }
      // v2.20.2: visibility + public_access stay in lock-step via the shared
      // resolveVisibility helper (visibility wins if both are passed), so this
      // path can't drift from the REST update. Setting one without the other
      // used to leave an app publicly reachable yet catalog-private, which made
      // the launcher prompt users to "Request access" to an already-open app.
      Object.assign(updates, resolveVisibility({ visibility: args.visibility, public_access: args.public_access }));
      if (args.image_retention !== undefined) {
        const n = parseInt(args.image_retention, 10);
        if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error('image_retention must be 0-50');
        updates.image_retention = n;
      }
      if (args.frame_ancestors !== undefined) updates.frame_ancestors = args.frame_ancestors ? String(args.frame_ancestors) : null;
      if (args.auth_bypass_paths !== undefined) {
        const parsed = validateBypassPaths(args.auth_bypass_paths);
        updates.auth_bypass_paths = parsed && parsed.length > 0 ? JSON.stringify(parsed) : null;
      }

      if (args.github_token !== undefined) {
        // '' clears, undefined leaves alone, anything else rotates
        updates.github_token_encrypted = args.github_token ? encrypt(args.github_token) : null;
      }

      if (args.max_ram_mb !== undefined || args.max_cpu_percent !== undefined) {
        // v2.21.5: CPU/memory limits are platform-admin only.
        if (user.role !== 'platform_admin') {
          throw new Error('Only platform admins can change CPU/memory limits.');
        }
        let limits = {};
        try { limits = app.resource_limits ? JSON.parse(app.resource_limits) : {}; } catch (_) {}
        if (args.max_ram_mb      !== undefined) limits.max_ram_mb      = args.max_ram_mb;
        if (args.max_cpu_percent !== undefined) limits.max_cpu_percent = args.max_cpu_percent;
        updates.resource_limits = JSON.stringify(limits);
      }

      const keys = Object.keys(updates);
      if (keys.length === 0) throw new Error('No fields to update — pass at least one field besides slug.');

      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values    = keys.map(k => updates[k]);
      db.prepare(`UPDATE apps SET ${setClause} WHERE id = ?`).run(...values, app.id);

      // v2.24.4: on a custom-domain change, keep the old domain alive as a 301
      // redirect to the new one (same as the REST path) so links don't break.
      if ('domain' in updates) {
        const { autoSeedAliasOnDomainChange } = await import('./domainAliases.js');
        autoSeedAliasOnDomainChange(db, app, app.domain, updates.domain);
      }

      log.info(`MCP: app '${slug}' updated by user ${user.id}; fields=${keys.join(',')}`);

      // frame_ancestors / auth_bypass_paths / domain change the Caddyfile.
      // Reload to apply (a custom domain adds/removes a whole site block).
      if ('frame_ancestors' in updates || 'auth_bypass_paths' in updates || 'domain' in updates) {
        try {
          const { reloadCaddy } = await import('./caddy.js');
          await reloadCaddy();
        } catch (e) { log.warn(`MCP set_app_meta: Caddy reload failed (non-fatal): ${e.message}`); }
      }

      // Return the same shape as appcrane_get_app so the agent can verify
      // what landed without a separate get_app round-trip.
      const fresh = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
      const enriched = enrichAppRow(db, fresh);
      let resourceLimits = null;
      try { resourceLimits = fresh.resource_limits ? JSON.parse(fresh.resource_limits) : null; } catch (_) {}
      return {
        ...enriched,
        updated_fields: keys,
        config: {
          source_type:    fresh.source_type,
          github_url:     fresh.github_url,
          branch:         fresh.branch,
          image_ref:      fresh.image_ref,
          container_port: fresh.container_port,
          health_path:    fresh.health_path,
          token_set:      !!fresh.github_token_encrypted,
          domain:         fresh.domain,
          category:       fresh.category,
          visibility:     fresh.visibility,
          public_access:  fresh.public_access,
          auth_mode:      effectiveAuthMode(fresh.auth_mode),
          ingress_type:   effectiveIngressType(fresh.ingress_type),
          public_port:    publicPortForApp(fresh),
          data_plane_port: effectiveDataPlanePort(fresh),
          pending_port_release: pendingPortRelease(fresh),
          image_retention: fresh.image_retention,
          frame_ancestors: fresh.frame_ancestors,
          auth_bypass_paths: (() => { try { return fresh.auth_bypass_paths ? JSON.parse(fresh.auth_bypass_paths) : []; } catch (_) { return []; } })(),
          max_ram_mb:      resourceLimits?.max_ram_mb      ?? null,
          max_cpu_percent: resourceLimits?.max_cpu_percent ?? null,
        },
      };
    },
  },

  {
    name: 'appcrane_set_app_meta',
    description:
      'Set an app\'s category, visibility, auth_mode, and/or auth_bypass_paths — the owner self-service fields (same controls the dashboard Launcher exposes to owners). Owner of the app (or global admin) required. visibility is one of public / private / hidden. auth_mode is `authenticated` (default — all routes go through AppCrane SSO) or `headless` (the app bypasses forward_auth ENTIRELY and is reachable without identity — right tool for telemetry ingest, public webhooks, status pages; the app\'s own server is responsible for any payload-level authn). A headless app is still served BY CADDY over HTTP — TLS, security headers and access logging all still apply; it is not a raw port. An app that does not speak HTTP at all needs ingress_type=\'tcp\', and an app that speaks HTTP AND needs a second raw port for non-HTTP clients needs ingress_type=\'dual\' (both via appcrane_set_app_ingress, platform admin only) — different and far more exposed things. auth_bypass_paths (v2.7.27+) is an array of path prefixes (e.g. ["/ws/local-runner"]) that bypass SSO on this app only — narrower than headless mode; the app authenticates those paths itself (e.g. token in query string). The platform strips incoming X-AppCrane-* headers on bypass paths (forgery defense intact) and suppresses access logging for them (token-in-query never sits in log storage). Owners may only assign an EXISTING category; creating a brand-new category is reserved for global admins. For powerful fields (github_url, branch, token, source_type, resource limits) use appcrane_update_app (admin only).',
    inputSchema: {
      type: 'object',
      properties: {
        slug:       { type: 'string', description: 'App slug.' },
        category:   { type: 'string', description: 'Category/tag. Owners must pick one already in use; pass empty string to clear.' },
        visibility: { type: 'string', enum: ['public', 'private', 'hidden'], description: 'public = anyone; private = assigned users; hidden = not discoverable.' },
        auth_mode:  { type: 'string', enum: ['authenticated', 'headless'], description: 'authenticated = AppCrane SSO + per-app role checks; headless = NO auth at the proxy (the entire app is reachable by anyone on the internet).' },
        auth_bypass_paths: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string' },
          description: 'v2.7.27: array of path prefixes (e.g. ["/ws/local-runner"]) that bypass SSO forward_auth on this app. Requests under these prefixes reach the container with NO X-AppCrane-* identity headers — the app authenticates them itself. Caddy suppresses access logging for these paths to prevent query-string-token leakage. Pass [] or null to clear.',
        },
        domain: {
          type: 'string',
          description: 'v2.10.0: custom domain (e.g. "raise.glick.run") that serves this app at the ROOT of that domain with NO AppCrane SSO and NO topbar — the app does its own auth. Maps to production. Requires the domain\'s DNS to point at this host (Caddy auto-provisions TLS). Pass "" or null to remove. The /<slug> path under the platform domain stays.',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // handler enforces owner-or-admin per-slug
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      const globalAdmin = isAdmin(user);
      if (!globalAdmin && roleForUserOnApp(user, app) !== 'owner') {
        throw new Error('Forbidden: only the app owner (or a global admin) can change category/visibility/auth_mode/auth_bypass_paths/domain.');
      }
      if (args.category === undefined && args.visibility === undefined && args.auth_mode === undefined && args.auth_bypass_paths === undefined && args.domain === undefined) {
        throw new Error('Pass at least one of category, visibility, auth_mode, auth_bypass_paths, or domain.');
      }
      const db = getDb();
      const updates = {};

      // v2.20.2: shared invariant helper (see resolveVisibility) — no-op when
      // visibility isn't in the patch.
      Object.assign(updates, resolveVisibility({ visibility: args.visibility }));

      if (args.category !== undefined) {
        const newCat = args.category ? String(args.category).trim() : null;
        // Owners can't create new categories — must already exist on an app
        // they can see (public or assigned). Mirrors POST/PUT /api/apps.
        if (!globalAdmin && newCat) {
          const exists = db.prepare(`
            SELECT 1 FROM apps a
            WHERE a.category = ? AND a.category IS NOT NULL AND a.category != ''
              AND (
                a.visibility = 'public'
                OR EXISTS (SELECT 1 FROM app_users au WHERE au.app_id = a.id AND au.user_id = ?)
                OR EXISTS (SELECT 1 FROM app_user_roles aur WHERE aur.app_id = a.id AND aur.user_id = ?)
              )
            LIMIT 1
          `).get(newCat, user.id, user.id);
          if (!exists) throw new Error('Only admins can create new categories — pick an existing one.');
        }
        updates.category = newCat;
      }

      if (args.auth_mode !== undefined) {
        if (!['authenticated', 'headless'].includes(args.auth_mode)) {
          throw new Error("auth_mode must be 'authenticated' or 'headless'");
        }
        updates.auth_mode = args.auth_mode;
      }

      if (args.auth_bypass_paths !== undefined) {
        const parsed = validateBypassPaths(args.auth_bypass_paths);
        updates.auth_bypass_paths = parsed && parsed.length > 0 ? JSON.stringify(parsed) : null;
      }

      if (args.domain !== undefined) {
        const { validateCustomDomain } = await import('../utils/customDomain.js');
        updates.domain = validateCustomDomain(args.domain, process.env.CRANE_DOMAIN);
        if (updates.domain) {
          const clash = db.prepare('SELECT slug FROM apps WHERE lower(domain) = ? AND id != ?').get(updates.domain, app.id);
          if (clash) throw new Error(`Domain "${updates.domain}" is already used by app "${clash.slug}"`);
        }
      }

      const keys = Object.keys(updates);
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE apps SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), app.id);

      // v2.7.22: auth_mode flips the Caddy block shape (forward_auth on/off);
      // v2.7.28: auth_bypass_paths emits inner handle blocks; v2.10.0: domain
      // adds/removes a whole custom-domain site. Reload Caddy when any change.
      if ('auth_mode' in updates || 'auth_bypass_paths' in updates || 'domain' in updates) {
        try {
          const { reloadCaddy } = await import('./caddy.js');
          await reloadCaddy();
        } catch (e) { log.warn(`Caddy reload after meta change failed: ${e.message}`); }
      }

      log.info(`MCP: app '${app.slug}' meta updated by user ${user.id}; fields=${keys.join(',')}`);
      const fresh = db.prepare('SELECT category, visibility, public_access, auth_mode, auth_bypass_paths FROM apps WHERE id = ?').get(app.id);
      let bypassPaths = [];
      try { bypassPaths = fresh.auth_bypass_paths ? JSON.parse(fresh.auth_bypass_paths) : []; } catch (_) {}
      return {
        app: app.slug,
        category: fresh.category,
        visibility: fresh.visibility,
        public_access: fresh.public_access,
        auth_mode: effectiveAuthMode(fresh.auth_mode),
        auth_bypass_paths: bypassPaths,
        updated_fields: keys,
      };
    },
  },

  {
    name: 'appcrane_get_app_ingress',
    description:
      'Read HOW an app is reachable. ingress_type is `http` (default — every request goes through Caddy: TLS, AppCrane SSO/forward_auth, X-AppCrane-* identity headers, security headers, access logs), `tcp` (the container port is published DIRECTLY on the host at public_port, with Caddy not in the path at all — for apps that do not speak HTTP, e.g. a forward/CONNECT proxy handing back a raw tunnel), or `dual` (v2.45.0 — BOTH at once: an ordinary HTTP control plane still served through Caddy on container port ' + CONTROL_PLANE_PORT + ' with every Caddy control intact, PLUS a raw data plane published at 0.0.0.0:<public_port> -> <data_plane_port>, a DIFFERENT port inside the same container, with none of them). For a dual app the two planes have different security properties and the answer to "is this app behind AppCrane auth" is different for each — read `exposure.control_plane` and `exposure.data_plane` rather than the enum. Read this before debugging "why does my app see no identity headers" or "what port do clients connect to". IMPORTANT — this is NOT auth_mode: auth_mode=`headless` still goes through Caddy and only skips forward_auth, so it keeps TLS, security headers and request logging; a published port under `tcp` or `dual` keeps NONE of that. Requires access to the app.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'App slug.' } },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any', // gated per-slug by getAppForUser
    readOnly: true,
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      const ingressType = effectiveIngressType(app.ingress_type);
      const publicPort = publicPortForApp(app);
      // The container port the raw publish targets. CONTROL_PLANE_PORT for a
      // pure-tcp app (which has no second plane), the app's own port for a dual
      // one. Read from the helper rather than assumed, because assuming it was
      // always 3000 is exactly what made a dual app inexpressible.
      const containerPort = dataPlanePortForApp(app);
      // A port this app was flipped away from but whose container has not been
      // recreated yet. Reported on its own key because it is the one state
      // where ingress_type alone lies about the host: AppCrane publishes
      // nothing, and the port still answers.
      const stillBound = pendingPortRelease(app);
      // v2.45.3: what the RUNNING container actually binds. Everything above is
      // the app row — intent — and reporting intent as fact is what sent an
      // operator chasing SDP and firewall rules for a port whose container had
      // simply never been recreated. The publish is a docker run flag.
      const { publishedPortsBySlug } = await import('./docker.js');
      const { ingressDrift } = await import('./ingressDrift.js');
      const draining = drainingPorts(getDb(), app.id);
      const observedMap = await publishedPortsBySlug();
      const observed = observedMap ? (observedMap.get(`${app.slug}:production`) ?? null) : null;
      const { applied, drift } = ingressDrift(app, observed);
      // One string for both publishing types: the filtering story is a property
      // of a Docker publish, not of why the app asked for one.
      // published_as used to be built purely from the row, so it asserted a
      // mapping that might not exist anywhere. It now carries the verdict with
      // it — an agent reading only this one string must not come away believing
      // a port is live when it is not.
      // Only annotated when the container was actually READ and found not to
      // carry the publish. An unreadable container leaves the string clean and
      // says so in publish_applied: null — appending "could not verify" to every
      // read on a host where Docker is unreachable would put noise on the common
      // case to describe a state that already has its own field, and would make
      // the string harder to parse for the exact readers it exists to inform.
      const withReality = (intent) =>
        applied === false && drift ? `${intent} — CONFIGURED BUT NOT LIVE: ${drift.message}` : intent;
      const FIREWALL_NOTE = 'AppCrane publishes the port; it does not manage host filtering. Do NOT treat the host firewall as an independent second key: a published port is a DNAT rule evaluated in nat/FORWARD and never traverses INPUT, so a plain `ufw deny` or a default-deny INPUT policy does NOT block it. Filter in the DOCKER-USER chain, or upstream of the host. On this deployment the host sits behind SDP, so the boundary is the perimeter rather than the internet — the port is reachable by everything SDP admits.';
      return {
        app: app.slug,
        ingress_type: ingressType,
        public_port: publicPort,
        data_plane_port: effectiveDataPlanePort(app),
        pending_port_release: stillBound,
        // v2.47.0: ports this app still has RESERVED after a re-pin. A running
        // container is bound to them; AppCrane holds them so nobody else is
        // given them, and frees them on the next recreate. Reported so an agent
        // is never told a port is closed while it answers.
        ...(draining.length ? {
          draining_ports: draining,
          draining_note: `Still bound: ${draining.map(d => `${d.host_port} (${d.env})`).join(', ')}. ` +
            'The publish is a `docker run` flag, so a re-pin cannot close the old port on its own — ' +
            'the container that is up keeps binding it until it is RECREATED, and AppCrane keeps the ' +
            'number reserved to this app until then rather than reissuing one a live container holds. ' +
            'Do not report these as closed.',
        } : {}),
        // The row says what SHOULD be published; these say what IS. null means
        // the container could not be read — not that the port is closed.
        publish_applied: applied,
        ...(drift ? { publish_drift: drift } : {}),
        ...(stillBound !== null ? {
          pending_port_release_note: `This app was switched back to http while a container was running. AppCrane no longer publishes port ${stillBound} and will not give it to another app, but the container that is up right now still binds 0.0.0.0:${stillBound}, so the port stays reachable and unauthenticated until the container is recreated (a deploy, or POST /api/apps/${app.slug}/restart/production). Do not report the exposure as closed before that.`,
        } : {}),
        auth_mode: effectiveAuthMode(app.auth_mode),
        // Spelled out rather than left for the agent to infer: the loss of every
        // Caddy-side control is the whole meaning of a published port, and an
        // agent that reads only the enum will assume the platform still guards
        // the door.
        exposure: ingressType === 'tcp'
          ? {
              published_as: withReality(publicPort ? `0.0.0.0:${publicPort} -> container:${containerPort}` : 'not published — no public_port allocated yet'),
              behind_appcrane_auth: false,
              summary: 'This port does NOT pass through Caddy: no forward_auth/SSO, no X-AppCrane-* identity headers, no per-request audit, no rate limiting, no security headers, no TLS from AppCrane. The app authenticates every connection itself. This host is behind SDP, so the port is not internet-facing — it is reachable by everything inside that perimeter. For a forward/CONNECT proxy, a gap in the app\'s own proxy auth is therefore an unaudited egress path out of the perimeter, which AppCrane cannot log because the traffic never touches Caddy. The app can still authenticate callers against AppCrane: /api/me with the user\'s bearer token, or /api/service with its own APPCRANE_SERVICE_TOKEN over the docker bridge.',
              firewall: FIREWALL_NOTE,
            }
          // A dual app has TWO answers, and collapsing them into one boolean is
          // how an agent ends up either ignoring a raw port or reporting a
          // perfectly ordinary Caddy-fronted app as unguarded. behind_appcrane_auth
          // stays false because a door exists that AppCrane does not guard —
          // the safe reading when only one field is looked at — and the two
          // planes are then reported separately.
          : ingressType === 'dual'
          ? {
              published_as: withReality(publicPort && containerPort
                ? `0.0.0.0:${publicPort} -> container:${containerPort}`
                : (publicPort === null
                    ? 'not published — no public_port allocated yet'
                    : `not published — data_plane_port is missing or is the control plane (${CONTROL_PLANE_PORT}), so AppCrane refuses to publish anything for this app`)),
              behind_appcrane_auth: false,
              summary: `This app has TWO planes with different security properties. CONTROL plane: ordinary HTTP on container port ${CONTROL_PLANE_PORT}, served through Caddy exactly like any http app — TLS, AppCrane SSO/forward_auth, X-AppCrane-* identity headers, security headers and access logs all still apply, and that is the plane its health check probes. DATA plane: container port ${containerPort ?? app.data_plane_port} published raw at 0.0.0.0:${publicPort ?? '<unallocated>'}, with Caddy nowhere in the path — no forward_auth/SSO, no identity headers, no per-request audit, no rate limiting, no security headers, no TLS from AppCrane. The app authenticates every connection on the data plane itself. This host is behind SDP, so the published port is not internet-facing — it is reachable by everything inside that perimeter. Note what the split does NOT protect: the two planes are the same process in the same container, so a flaw reachable on the data plane is reachable in the code that serves the control plane too.`,
              control_plane: {
                container_port: CONTROL_PLANE_PORT,
                reached_via: 'Caddy, at the app\'s normal AppCrane URL',
                behind_appcrane_auth: true,
              },
              data_plane: {
                container_port: containerPort ?? effectiveDataPlanePort(app),
                host_port: publicPort,
                reached_via: 'a direct Docker publish on the host — Caddy is not in this path',
                behind_appcrane_auth: false,
              },
              firewall: FIREWALL_NOTE,
            }
          : stillBound !== null
            ? {
                published_as: null,
                // Not `true`. AppCrane publishes nothing for this app, but the
                // container that is up was started when it did, and that port
                // is still open and still unauthenticated. Answering true here
                // would be the exact false all-clear this field exists to give
                // honestly.
                behind_appcrane_auth: false,
                summary: `AppCrane publishes no port for this app any more, but the RUNNING container still binds 0.0.0.0:${stillBound} from before the switch, with none of Caddy's controls in front of it. It closes when the container is recreated.`,
              }
            : { published_as: null, behind_appcrane_auth: true },
      };
    },
  },

  {
    name: 'appcrane_set_app_ingress',
    description:
      'Switch an app between HTTP ingress, raw TCP ingress and dual (both), and choose its public host port. PLATFORM ADMIN ONLY — this is not an owner self-service field like auth_mode. ingress_type=`tcp` publishes 0.0.0.0:<public_port> -> the container in ADDITION to the loopback publish every app has, so clients connect straight to the host and Caddy never sees the traffic: no forward_auth/SSO, no identity headers, no per-request audit, no rate limiting, no security headers, no TLS from AppCrane. Every control AppCrane has assumes Caddy is the only door; this adds a second one the platform does not control, and the app then owns authentication completely. Do NOT reach for this to make an app reachable without login — that is auth_mode=`headless`, which still goes through Caddy and keeps TLS, security headers and logging. Use `tcp` ONLY when the app does not speak HTTP at all (a forward/CONNECT proxy tunnels raw bytes; no reverse proxy can express that). ingress_type=`dual` (v2.45.0) is for an app that is BOTH: its HTTP control plane keeps being served through Caddy on container port ' + CONTROL_PLANE_PORT + ' with every control intact (and stays the plane its health check probes), while a SECOND listener inside the same container — data_plane_port, which is REQUIRED and must not be ' + CONTROL_PLANE_PORT + ' — is published raw at 0.0.0.0:<public_port> with none of them. Setting data_plane_port to ' + CONTROL_PLANE_PORT + ' is refused: that would republish the ordinary HTTP origin Caddy fronts, unauthenticated and unaudited, which is the exact surface Caddy is in the path to protect. Omit public_port to keep the existing allocation, or to have the lowest free port in ' + `${AUTO_PORT_MIN}-${AUTO_PORT_MAX}` + ' allocated — a dedicated band so the operator firewalls one predictable block; an explicitly NAMED port may be anything in ' + `${PUBLIC_PORT_MIN}-${PUBLIC_PORT_MAX}` + ', because clients are configured with a port by hand or by MDM and a number like 8080 is often not the platform\'s to choose. Naming a port outside the auto band is legal and safe — the guards that matter (the WHATWG blocked list, AppCrane\'s own listening port, collisions with slot-derived backend ports, and one-app-per-host-port) apply at every value — but the operator must open the firewall for that port too. Switching back to `http` STOPS THE PUBLISH but does not close the port: the publish is a `docker run` flag, so a running container keeps binding it until it is RECREATED (next deploy, or POST /api/apps/<slug>/restart/<env>, which does stop+start). Until then the port stays reachable and unauthenticated, so AppCrane keeps it RESERVED to this app — no other app can be given it, and it goes back in the pool automatically when the container comes back without the publish. Recreate the container to actually close a port, and do not report an exposure as revoked before that; the app reports the number under `pending_port_release` in the meantime. Do NOT treat the host firewall as a second lock holding this shut: on a Linux host Docker\'s publish is a DNAT rule evaluated in FORWARD that never traverses INPUT, so a plain `ufw deny <port>` does NOT block it — filter in DOCKER-USER or upstream. This host also sits behind SDP, so the boundary that exists is the perimeter: publishing makes the port reachable by everything inside it, not by the internet and not by nobody.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        // The vocabulary itself, not a copy of it: a fourth type added to
        // tcpIngress.js must not be silently unreachable through MCP, and a
        // type removed there must not stay advertised here.
        ingress_type: { type: 'string', enum: INGRESS_TYPES, description: `http = through Caddy (default). tcp = the container port is published on the host, with no AppCrane authentication in front of it. dual = both — the HTTP control plane stays behind Caddy on container port ${CONTROL_PLANE_PORT}, and a separate data_plane_port in the same container is published raw alongside it.` },
        public_port: {
          type: 'integer',
          minimum: PUBLIC_PORT_MIN,
          maximum: PUBLIC_PORT_MAX,
          description: `HOST port to publish. Only valid with ingress_type='tcp' or 'dual'. Omit to keep the port the app already holds, or to have one allocated from ${AUTO_PORT_MIN}-${AUTO_PORT_MAX}; name one explicitly and it may be anything in ${PUBLIC_PORT_MIN}-${PUBLIC_PORT_MAX}, which is what makes a client fleet already pinned to e.g. 8080 expressible. A port is stored, never derived from the app's slot, so it survives redeploys and renames — clients pinned to it keep working. Two apps cannot hold the same host port.`,
        },
        sandbox_public_port: {
          type: ['integer', 'null'],
          minimum: PUBLIC_PORT_MIN,
          maximum: PUBLIC_PORT_MAX,
          description: `HOST port to publish for the SANDBOX container, so a raw data plane can be exercised before it goes live. Opt-in and independent of public_port — omit it and sandbox publishes nothing, exactly as before. Pass null to drop it. Must not equal any port any other app holds in EITHER environment; the registry enforces that. Only valid with ingress_type='tcp' or 'dual'. SECURITY: this is a SECOND unauthenticated door, on the container running your least-reviewed code — it has no forward_auth, no identity headers, no audit and no TLS from AppCrane, and behind SDP it is reachable by everything inside the perimeter.`,
        },
        data_plane_port: {
          // null is admitted so the ONE way to drop a pinned data plane is
          // expressible here too: flipping a dual app to 'tcp' is refused while
          // it still holds one, because that flip would repoint the same host
          // port onto the control plane.
          type: ['integer', 'null'],
          minimum: PUBLIC_PORT_MIN,
          maximum: PUBLIC_PORT_MAX,
          description: `CONTAINER port the raw publish targets, ${PUBLIC_PORT_MIN}-${PUBLIC_PORT_MAX}. REQUIRED with ingress_type='dual'. On any other type the only accepted value is null, which DROPS a data plane the app still has pinned — required to flip a dual app to 'tcp', since that publishes container port ${CONTROL_PLANE_PORT} instead. Must NOT be ${CONTROL_PLANE_PORT}: that is the app's HTTP control plane, the port Caddy proxies to, and publishing it raw would expose the ordinary HTTP origin with no TLS, no forward_auth, no identity headers and no request audit. Give the data plane its own listener on another port inside the container. Unlike public_port this is not globally unique — container network namespaces are separate, so two apps may each use the same container-side port.`,
        },
      },
      required: ['slug', 'ingress_type'],
      additionalProperties: false,
    },
    // 'admin' is the coarsest gate the registry has; the platform_admin check
    // below is the real one, matching the CPU/memory-limit precedent in
    // appcrane_update_app and the PUT /api/apps/:slug gate.
    requiredRole: 'admin',
    handler: async (user, args) => {
      if (user.role !== 'platform_admin') {
        throw new Error('Only platform admins can change ingress_type, public_port, sandbox_public_port or data_plane_port — publishing a host port bypasses every control AppCrane has.');
      }
      const app = getAppForUser(user, args.slug);
      validateIngressType(args.ingress_type);
      if (args.public_port !== undefined && args.ingress_type === 'http') {
        throw new Error("public_port only applies to an app with ingress_type='tcp' or 'dual'");
      }
      // Only 'dual' has two planes to tell apart. A pure-tcp app IS its data
      // plane — the container is told PORT=3000 and the whole of it is
      // published — so a second number there would be a second way to say the
      // same thing, and the two could silently disagree. An explicit null is
      // the exception: it CLEARS a pinned data plane, which is what makes the
      // tcp refusal below escapable.
      if (args.sandbox_public_port !== undefined && args.sandbox_public_port !== null
          && args.ingress_type === 'http') {
        throw new Error("sandbox_public_port only applies to an app with ingress_type='tcp' or 'dual'");
      }
      if (args.data_plane_port !== undefined && args.data_plane_port !== null && args.ingress_type !== 'dual') {
        throw new Error("data_plane_port only applies to an app with ingress_type='dual'");
      }
      if (args.data_plane_port === null && args.ingress_type === 'dual') {
        throw new Error(
          "A dual app must keep a data plane port — send ingress_type='http' or 'tcp' together with " +
          'data_plane_port: null to drop it'
        );
      }
      // SECURITY: 'dual' with no data-plane port is not a half-configured app,
      // it is a request to publish the control plane raw — the publish must
      // target SOME container port, and CONTROL_PLANE_PORT is the only other
      // one there. AppCrane refuses rather than defaulting. The stored number
      // is honoured (it survives a flip away from dual so flipping back
      // restores the port clients are configured for) but REVALIDATED rather
      // than trusted, so a value that became illegal while the app sat on http
      // cannot be reinstated by a flip. Mirrors PUT /api/apps/:slug.
      let nextDataPlanePort = null;
      if (args.ingress_type === 'dual') {
        nextDataPlanePort = args.data_plane_port !== undefined
          ? args.data_plane_port
          : (Number.isInteger(app.data_plane_port) ? app.data_plane_port : null);
        if (nextDataPlanePort === null) {
          throw new Error(
            "ingress_type='dual' requires data_plane_port — the raw publish must target a port INSIDE the " +
            'container that is not the HTTP control plane, and AppCrane will not guess one'
          );
        }
        validateDataPlanePort(nextDataPlanePort);
      }
      // SECURITY: 'tcp' publishes CONTROL_PLANE_PORT itself — right for an app
      // whose whole container IS the data plane, wrong for a row that still
      // carries a data_plane_port. That flip repoints the SAME pinned host port
      // from the data plane onto the HTTP control plane, which is the publish
      // validateDataPlanePort refuses outright, reached instead by a call that
      // named only the type. Mirrors PUT /api/apps/:slug.
      if (args.ingress_type === 'tcp') {
        const stillPinned = args.data_plane_port === undefined
          ? (Number.isInteger(app.data_plane_port) ? app.data_plane_port : null)
          : args.data_plane_port;
        if (stillPinned !== null) {
          throw new Error(
            `This app still has data_plane_port ${stillPinned}. ingress_type='tcp' publishes container port ` +
            `${CONTROL_PLANE_PORT} — the HTTP control plane — on the host, so the flip would repoint the ` +
            'published port away from the data plane and onto the origin Caddy fronts, with no TLS, no ' +
            'forward_auth, no identity headers and no request audit. Send data_plane_port: null in the same ' +
            'call to drop the data plane deliberately.'
          );
        }
      }

      const db = getDb();
      const before = {
        ingress_type: effectiveIngressType(app.ingress_type),
        public_port: publicPortForApp(app),
        sandbox_public_port: publicPortForApp(app, 'sandbox'),
        data_plane_port: effectiveDataPlanePort(app),
        pending_port_release: pendingPortRelease(app),
      };
      const { logAudit } = await import('../middleware/audit.js');

      // The column write, the port allocation and the audit entry are ONE
      // transaction, matching the REST path. public_port still goes through the
      // allocator rather than this UPDATE — picking a free port and claiming it
      // has to be atomic so two admins can't double-book a host port — but a
      // failed allocation has to roll the ingress_type write back with it.
      // Committing the type first left a rejected call having permanently
      // flipped the app to tcp with public_port null and NO 'app-ingress-change'
      // entry, because the audit write is past the throw: the transition that
      // actually happened became unrecoverable from the log, which is the one
      // thing this action is audited to guarantee.
      const result = db.transaction(() => {
        db.prepare('UPDATE apps SET ingress_type = ? WHERE id = ?').run(args.ingress_type, app.id);
        if (args.data_plane_port !== undefined) {
          db.prepare('UPDATE apps SET data_plane_port = ? WHERE id = ?').run(args.data_plane_port, app.id);
        }
        if (args.ingress_type !== 'http') {
          assignPublicPort(db, app.id, args.public_port === undefined ? null : args.public_port, 'production');
        }
        // Sandbox is OPT-IN and only ever touched when named. An app that never
        // asks keeps publishing nothing there — a second unauthenticated port
        // must not appear because an unrelated ingress field was edited.
        if (args.sandbox_public_port === null) {
          releasePublicPort(db, app.id, 'sandbox');
        } else if (args.sandbox_public_port !== undefined) {
          assignPublicPort(db, app.id, args.sandbox_public_port, 'sandbox');
        }
        // Switching to http deliberately leaves public_port alone. The publish
        // is a `docker run` flag, so the container that is up keeps binding the
        // port; freeing the number here handed a live, still-bound port to the
        // next app that asked, whose `docker run` then died with "port is
        // already allocated" while traffic to it kept reaching the OLD app. The
        // row holds the number as a reservation until docker.js sees the
        // container come back without the publish. See pendingPortRelease().
        const after = db.prepare('SELECT ingress_type, public_port, sandbox_public_port, data_plane_port FROM apps WHERE id = ?').get(app.id);
        const out = {
          ingress_type: effectiveIngressType(after.ingress_type),
          public_port: publicPortForApp(after),
          sandbox_public_port: publicPortForApp(after, 'sandbox'),
          data_plane_port: effectiveDataPlanePort(after),
          pending_port_release: pendingPortRelease(after),
        };
        // Same dedicated audit action the REST path writes. Every MCP call is
        // audited generically, but "a port was opened on the host" has to be
        // findable by name regardless of which door the change came through.
        logAudit(user.id, app.id, 'app-ingress-change', { from: before, to: out });
        return out;
      })();

      log.info(`MCP: app '${app.slug}' ingress set to ${result.ingress_type}${result.public_port ? `:${result.public_port}` : ''}${result.data_plane_port ? ` -> container:${result.data_plane_port}` : ''} by user ${user.id}`);
      return {
        app: app.slug,
        ...result,
        applies_on: 'the container is next RECREATED — the publish is a `docker run` flag, so it lands on the next deploy or on POST /api/apps/<slug>/restart/<env> (that route does stop+start, not `docker restart`). Nothing changes on a running container. This is true in BOTH directions: switching to http stops the publish at the same moment, and AppCrane holds the port reserved to this app until then rather than reissuing a number a live container still binds.',
        warning: result.ingress_type === 'tcp'
          ? `Port ${result.public_port} is NOT behind AppCrane authentication: no forward_auth, no identity headers, no request audit, no rate limiting, no TLS from AppCrane. The app must authenticate every connection itself. Publishing is the exposing act — do not assume a firewall is holding it shut. On a Linux host a plain \`ufw deny\` will NOT block it (Docker's publish is a DNAT rule evaluated in FORWARD, never INPUT); filter in DOCKER-USER or upstream. Behind SDP the port is reachable by everything inside the perimeter.`
          : result.ingress_type === 'dual'
          ? `Host port ${result.public_port} -> container port ${result.data_plane_port} is NOT behind AppCrane authentication: no forward_auth, no identity headers, no request audit, no rate limiting, no TLS from AppCrane. The app must authenticate every connection on that plane itself. The app's HTTP control plane on container port ${CONTROL_PLANE_PORT} is unaffected and still served through Caddy with every control intact — including the health check, which still probes the control plane because a TCP handshake on the data port would read healthy while the plane users actually reach was wedged. Publishing is the exposing act — do not assume a firewall is holding it shut. On a Linux host a plain \`ufw deny\` will NOT block it (Docker's publish is a DNAT rule evaluated in FORWARD, never INPUT); filter in DOCKER-USER or upstream, and remember ${result.public_port} needs its own rule if it is outside the ${AUTO_PORT_MIN}-${AUTO_PORT_MAX} block. Behind SDP the port is reachable by everything inside the perimeter.`
          : result.pending_port_release !== null
            ? `Port ${result.pending_port_release} is NOT closed yet. AppCrane will not publish it again and no other app can be given it — it stays reserved to '${app.slug}' — but the container running right now still binds it, because the publish is a \`docker run\` flag. Recreate the container (deploy, or POST /api/apps/${app.slug}/restart/production) to actually close the port; AppCrane returns it to the pool at that moment. Do not report the exposure as revoked before then.`
            : 'This app publishes no host port and holds no reserved one.',
      };
    },
  },

  {
    name: 'appcrane_list_app_members',
    description:
      'List every user who has access to an app, with their per-app role (owner / admin / user / viewer / none). Use this before granting or revoking to see who is already in. Returns email + name + role for each member. App-admin or owner of the app required (or global admin / platform_admin).',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) {
        // Owners are accepted by isAppAdmin in v2.3.x; this guards against
        // a regular user reading the full member roster.
        const db = getDb();
        const row = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (row?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can list members');
      }
      const db = getDb();
      const rows = db.prepare(`
        SELECT u.id, u.name, u.email, u.username, COALESCE(aur.app_role, 'none') AS role
        FROM users u
        LEFT JOIN app_user_roles aur ON aur.user_id = u.id AND aur.app_id = ?
        WHERE u.active = 1
          AND (aur.app_id IS NOT NULL OR EXISTS (SELECT 1 FROM app_users au WHERE au.app_id = ? AND au.user_id = u.id))
        ORDER BY
          CASE COALESCE(aur.app_role, 'none')
            WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
            WHEN 'user'  THEN 2 WHEN 'viewer' THEN 3 ELSE 4
          END, u.name
      `).all(app.id, app.id);
      return { app: app.slug, members: rows };
    },
  },

  {
    name: 'appcrane_grant_app_access',
    description:
      'Grant a user access to an app at a specific per-app role. `user` accepts a numeric user id, an email, or a username — first match wins. role defaults to "user". Idempotent: existing rows are upgraded/downgraded to the new role. App-admin or owner of the app required (or global admin).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        user: { type: 'string', description: 'User id (numeric string), email, or username' },
        role: { type: 'string', enum: ['user', 'admin', 'owner'], default: 'user' },
      },
      required: ['slug', 'user'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) {
        const db = getDb();
        const r = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (r?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can grant access');
      }
      const role = args.role || 'user';
      if (!['user', 'admin', 'owner'].includes(role)) {
        throw new Error('role must be one of: user, admin, owner');
      }
      const db = getDb();
      const target = db.prepare(`
        SELECT id, name, email, username FROM users
        WHERE active = 1 AND (CAST(id AS TEXT) = ? OR email = ? OR username = ?)
        LIMIT 1
      `).get(args.user, args.user, args.user);
      if (!target) throw new Error(`User not found: ${args.user}`);

      // Both tables: app_users (membership) + app_user_roles (role).
      // getAppForUser walks both, so we keep them in sync.
      db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(app.id, target.id);
      db.prepare(`
        INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, ?)
        ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = excluded.app_role
      `).run(app.id, target.id, role);

      log.info(`MCP: granted ${role} on ${app.slug} to user ${target.id} by ${user.id}`);
      return { app: app.slug, user: { id: target.id, name: target.name, email: target.email }, role };
    },
  },

  {
    name: 'appcrane_revoke_app_access',
    description:
      'Remove a user\'s access from an app entirely. Idempotent: returns ok even if the user had no access. App-admin or owner of the app required (or global admin). Refuses to remove the only remaining owner.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        user: { type: 'string', description: 'User id, email, or username' },
      },
      required: ['slug', 'user'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) {
        const db = getDb();
        const r = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (r?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can revoke access');
      }
      const db = getDb();
      const target = db.prepare(`
        SELECT id, name, email FROM users WHERE active = 1
          AND (CAST(id AS TEXT) = ? OR email = ? OR username = ?) LIMIT 1
      `).get(args.user, args.user, args.user);
      if (!target) throw new Error(`User not found: ${args.user}`);

      // Owner-protection: refuse to remove the last owner — would leave
      // the app un-ownable. Caller must promote a different user first.
      const cur = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, target.id);
      if (cur?.app_role === 'owner') {
        const ownerCount = db.prepare("SELECT COUNT(*) AS c FROM app_user_roles WHERE app_id = ? AND app_role = 'owner'").get(app.id).c;
        if (ownerCount <= 1) {
          throw new Error(`Refusing to revoke: ${target.email || target.id} is the only owner of ${app.slug}. Promote another user first.`);
        }
      }

      const r1 = db.prepare('DELETE FROM app_user_roles WHERE app_id = ? AND user_id = ?').run(app.id, target.id);
      const r2 = db.prepare('DELETE FROM app_users      WHERE app_id = ? AND user_id = ?').run(app.id, target.id);
      // v2.41.0: and the roles the APP defined for them. Left behind, they come
      // back in full the moment the user is re-granted bare access.
      const appRolesRemoved = clearUserRoleGrants(app.id, target.id);

      // Purge the revoked user's per-tenant DB dir (multitenant apps only).
      // Best-effort — never let a purge failure fail the revoke.
      const mt = db.prepare('SELECT multitenant FROM apps WHERE id = ?').get(app.id);
      if (mt?.multitenant) {
        try {
          const { purgeTenant } = await import('./tenants.js');
          purgeTenant(app.slug, target.email, target.id);
        } catch (e) {
          log.warn(`MCP revoke: tenant purge failed for ${app.slug}/${target.id}: ${e.message}`);
        }
      }

      log.info(`MCP: revoked access on ${app.slug} from user ${target.id} by ${user.id}`);
      return { app: app.slug, user: { id: target.id, email: target.email }, removed: { roles: r1.changes, members: r2.changes, app_defined_roles: appRolesRemoved } };
    },
  },

  // --- App-defined roles (v2.41.0) ------------------------------------------
  //
  // The three tools below manage the roles an app invents FOR ITSELF. They are a
  // different system from appcrane_grant_app_access / _list_app_members directly
  // above, which set AppCrane's own per-app tier (owner/admin/user/viewer —
  // deploy, env, delete). The descriptions say so in their first two sentences
  // because an agent picking by name alone would pick the wrong one, and picking
  // wrong here means handing out real platform power while intending to hand out
  // an app label.
  //
  // Nothing AppCrane decides ever reads these keys back; they are stored so they
  // can be handed to the app in X-AppCrane-App-Roles and /api/me's app_roles.

  {
    name: 'appcrane_list_app_roles',
    description:
      'List the roles an app defines FOR ITSELF (approver, auditor, reviewer — whatever that app invented). Any member sees the roles and how many hold each; an owner or admin also gets `members`, the roster of who holds what. ' +
      'These are NOT AppCrane permissions: they grant nothing on the platform and are only handed to the app, in the X-AppCrane-App-Roles request header and in /api/me\'s app_roles array, for the app\'s own code to enforce. ' +
      'For AppCrane\'s own per-app tier — owner/admin/user/viewer, i.e. who may deploy, read env vars, or delete the app — use appcrane_list_app_members instead. ' +
      'Call this before creating a role (to avoid duplicating one) or before setting a user\'s roles (to see the valid keys). Requires being assigned to the app.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      requireAppRoleTier(user, app, { manage: false });
      // v2.41.2: the roster rides along only for an owner/admin. The catalog is
      // what a member needs (to read their own roles, to avoid duplicating a
      // key); who else holds what is a roster, and every other roster read in
      // AppCrane — appcrane_list_app_members, GET /:slug/identity/users — asks
      // for the owner/admin tier. Same data, same gate.
      const tier = roleForUserOnApp(user, app);
      const canSeeRoster = tier === 'owner' || tier === 'admin';
      return {
        app: app.slug,
        roles: listRoles(app.id),
        ...(canSeeRoster
          ? { members: listMembersWithRoles(app.id) }
          : { members_omitted: 'Owner or admin of this app required to see who holds each role.' }),
      };
    },
  },

  {
    name: 'appcrane_create_app_role',
    description:
      'Define a new role for an app to enforce itself — the vocabulary side of app-defined roles. ' +
      'This does NOT grant AppCrane privileges of any kind, and it does NOT give anyone the role: use appcrane_set_user_app_roles for that. ' +
      'To change who may deploy / read env / delete, you want appcrane_grant_app_access, not this tool. ' +
      `key is what the app\'s code compares against and is immutable once created; it must match /^[a-z][a-z0-9_-]{0,31}$/ and may not be one of the AppCrane-reserved words (${RESERVED_KEYS.join(', ')}). ` +
      `label is the human name shown in the dashboard. An app may define at most ${MAX_ROLES_PER_APP} roles. Owner or admin of the app required.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        key: { type: 'string', description: 'Machine key the app matches on, e.g. "approver". Lowercase, immutable.' },
        label: { type: 'string', description: 'Human-readable name, e.g. "Budget approver"' },
        description: { type: 'string', description: 'Optional. What the app lets this role do.' },
      },
      required: ['slug', 'key', 'label'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      requireAppRoleTier(user, app, { manage: true });
      const role = createRole(
        app.id,
        { key: args.key, label: args.label, description: args.description },
        user.id,
      );
      log.info(`MCP: app-defined role '${role.key}' created on ${app.slug} by user ${user.id}`);
      return { app: app.slug, role };
    },
  },

  {
    name: 'appcrane_set_user_app_roles',
    description:
      'Set which app-defined roles a user holds on one app. Replaces their whole set: keys omitted from the list are removed, and keys: [] clears every role they hold. ' +
      'This changes only what the app itself enforces — it does NOT change the user\'s AppCrane per-app tier, so it can neither grant nor remove deploy / env / delete power. Use appcrane_grant_app_access for that. ' +
      'Every key must already be defined on this app (appcrane_create_app_role) and the user must already have access to the app (appcrane_grant_app_access) — a role on a non-member is unenforceable, since the app never sees them. ' +
      'The result is what the app receives in X-AppCrane-App-Roles on the user\'s next request. Owner or admin of the app required.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        user: { type: 'string', description: 'User id (numeric string), email, or username' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'The COMPLETE set of app-defined role keys this user should hold. [] removes all of them.',
        },
      },
      required: ['slug', 'user', 'keys'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      requireAppRoleTier(user, app, { manage: true });
      const db = getDb();
      const target = db.prepare(`
        SELECT id, name, email, username FROM users
        WHERE active = 1 AND (CAST(id AS TEXT) = ? OR email = ? OR username = ?)
        LIMIT 1
      `).get(args.user, args.user, args.user);
      if (!target) throw new Error(`User not found: ${args.user}`);

      const app_roles = setUserRoleKeys(app.id, target.id, args.keys, user.id);
      log.info(`MCP: app-defined roles on ${app.slug} for user ${target.id} set to [${app_roles.join(',')}] by ${user.id}`);
      return { app: app.slug, user: { id: target.id, name: target.name, email: target.email }, app_roles };
    },
  },

  {
    name: 'appcrane_list_access_requests',
    description:
      'List pending access requests — enhancement_requests rows whose message starts with "Access request for app …" (the portal\'s Request-access button posts these). With slug, scopes to one app; without, returns access requests across every app the caller can administer. App-admin / owner / global admin required.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Optional. Limit to one app.' } },
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const db = getDb();
      // Determine which slugs the caller can administer. Global admins get
      // every slug; otherwise only slugs where they are owner / admin.
      let scopedSlugs;
      if (isAdmin(user)) {
        scopedSlugs = null; // null = unrestricted
      } else {
        scopedSlugs = db.prepare(`
          SELECT DISTINCT a.slug FROM apps a
          JOIN app_user_roles aur ON aur.app_id = a.id AND aur.user_id = ?
          WHERE aur.app_role IN ('owner', 'admin')
        `).all(user.id).map(r => r.slug);
        if (scopedSlugs.length === 0) return { requests: [], count: 0 };
      }

      // v2.42.1 SECURITY: the admin branch above resolves to "every app", which
      // walked straight past an explicit mcp_app_scope — a scoped admin key read
      // pending access requests, with requester names, for the whole platform.
      const ceiling = mcpScope(user);
      if (ceiling) {
        scopedSlugs = scopedSlugs ? scopedSlugs.filter(s => ceiling.includes(s)) : ceiling;
        if (scopedSlugs.length === 0) return { requests: [], count: 0 };
      }

      let where = "er.status != 'done' AND er.message LIKE 'Access request for app%'";
      const params = [];
      if (args.slug) {
        where += ' AND er.app_slug = ?';
        params.push(args.slug);
      }
      if (scopedSlugs) {
        const placeholders = scopedSlugs.map(() => '?').join(',');
        where += ` AND er.app_slug IN (${placeholders})`;
        params.push(...scopedSlugs);
      }

      const rows = db.prepare(`
        SELECT er.id, er.app_slug, er.user_id, er.user_name, er.message, er.status, er.created_at
        FROM enhancement_requests er
        WHERE ${where}
        ORDER BY er.created_at DESC
        LIMIT 100
      `).all(...params);

      return { requests: rows, count: rows.length };
    },
  },

  {
    name: 'appcrane_approve_access_request',
    description:
      'Approve a pending access request: grants the requester access to the app at `role` (default "user") and marks the enhancement_request as done. Verifies the request is actually an access request before acting. App-admin / owner / global admin required.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'integer', description: 'enhancement_requests.id from appcrane_list_access_requests' },
        role:       { type: 'string', enum: ['user', 'admin', 'owner'], default: 'user' },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const db = getDb();
      const req = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(args.request_id);
      if (!req) throw new Error(`Request ${args.request_id} not found`);
      if (!/^Access request for app/i.test(req.message || '')) {
        throw new Error(`Request ${args.request_id} is not an access request — refusing to grant`);
      }
      if (req.status === 'done') throw new Error(`Request ${args.request_id} is already closed`);

      const app = getAppForUser(user, req.app_slug);
      if (!isAppAdmin(user, app)) {
        const r = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (r?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can approve access');
      }

      const role = args.role || 'user';
      db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(app.id, req.user_id);
      db.prepare(`
        INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, ?)
        ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = excluded.app_role
      `).run(app.id, req.user_id, role);
      db.prepare("UPDATE enhancement_requests SET status = 'done' WHERE id = ?").run(req.id);

      log.info(`MCP: approved access request #${req.id} → ${role} on ${app.slug} for user ${req.user_id} by ${user.id}`);
      return {
        request_id: req.id,
        app: app.slug,
        granted_to: { id: req.user_id, name: req.user_name },
        role,
        status: 'approved',
      };
    },
  },

  {
    name: 'appcrane_deny_access_request',
    description:
      'Deny a pending access request: marks the enhancement_request as done WITHOUT granting access. Optionally appends a reason to the original message so the requester (and the audit trail) sees why. App-admin / owner / global admin required.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'integer' },
        reason:     { type: 'string', description: 'Optional. Appended to the request message.' },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const db = getDb();
      const req = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(args.request_id);
      if (!req) throw new Error(`Request ${args.request_id} not found`);
      if (!/^Access request for app/i.test(req.message || '')) {
        throw new Error(`Request ${args.request_id} is not an access request`);
      }
      if (req.status === 'done') throw new Error(`Request ${args.request_id} is already closed`);

      const app = getAppForUser(user, req.app_slug);
      if (!isAppAdmin(user, app)) {
        const r = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (r?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can deny access');
      }

      const newMessage = args.reason
        ? `${req.message}\n\n[DENIED by ${user.email || user.username || user.id} on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}]\n${args.reason}`
        : req.message;
      db.prepare("UPDATE enhancement_requests SET status = 'done', message = ? WHERE id = ?").run(newMessage, req.id);

      log.info(`MCP: denied access request #${req.id} on ${app.slug} by ${user.id}`);
      return { request_id: req.id, app: app.slug, status: 'denied', reason: args.reason || null };
    },
  },

  {
    name: 'appcrane_set_app_icon',
    description:
      'Set the tile icon for an app (shown on the Dashboard, the Launcher cards, the Manage table, and the frame topbar). Accepts a base64-encoded image in PNG / SVG / WEBP / JPEG / GIF. ' +
      'For repo-tracked icons prefer committing public/icon.png to the repo — AppCrane picks it up automatically on each deploy. Use this MCP tool when the icon needs to change without a redeploy, or when the source isn\'t in the repo. ' +
      'Replaces any existing icon. App-admin or owner required (or global admin).',
    inputSchema: {
      type: 'object',
      properties: {
        slug:    { type: 'string', description: 'App slug.' },
        format:  { type: 'string', enum: ['png', 'svg', 'webp', 'jpg', 'jpeg', 'gif'], description: 'Image format. Determines the on-disk file extension (icon.<format>).' },
        base64:  { type: 'string', description: 'Base64-encoded image payload. May or may not include the data URL prefix (data:image/png;base64,…) — both work. Max 500 KB decoded.' },
      },
      required: ['slug', 'format', 'base64'],
      additionalProperties: false,
    },
    requiredRole: 'any',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) {
        const db = getDb();
        const r = db.prepare("SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?").get(app.id, user.id);
        if (r?.app_role !== 'owner') throw new Error('Forbidden: only app admins / owners can set the app icon');
      }

      const ext = String(args.format || '').toLowerCase();
      const ICON_EXTS = ['png', 'svg', 'webp', 'jpg', 'jpeg', 'gif'];
      if (!ICON_EXTS.includes(ext)) throw new Error(`format must be one of: ${ICON_EXTS.join(', ')}`);

      // Strip an optional data-URL prefix so callers can paste either form.
      let raw = String(args.base64 || '').trim();
      const m = raw.match(/^data:[^;]+;base64,(.+)$/i);
      if (m) raw = m[1];
      if (!raw) throw new Error('base64 payload is empty');

      let buf;
      try { buf = Buffer.from(raw, 'base64'); } catch (e) { throw new Error(`base64 decode failed: ${e.message}`); }
      const MAX_BYTES = 500 * 1024;
      if (buf.length === 0)        throw new Error('decoded payload is empty');
      if (buf.length > MAX_BYTES)  throw new Error(`icon too large (${buf.length} bytes > ${MAX_BYTES} cap)`);

      const { writeFileSync, unlinkSync, existsSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const dataDir = process.env.DATA_DIR || './data';
      const appIconDir = join(dataDir, 'apps', app.slug);
      mkdirSync(appIconDir, { recursive: true });

      // Wipe stale-extension siblings so the GET endpoint doesn't keep
      // serving an old icon under a different extension. Mirrors what
      // the POST /api/apps/:slug/icon upload endpoint does.
      for (const oldExt of ICON_EXTS) {
        if (oldExt === ext) continue;
        const oldPath = join(appIconDir, `icon.${oldExt}`);
        if (existsSync(oldPath)) { try { unlinkSync(oldPath); } catch (_) {} }
      }

      const destPath = join(appIconDir, `icon.${ext}`);
      writeFileSync(destPath, buf);

      log.info(`MCP: app icon updated for ${app.slug} (${ext}, ${buf.length} bytes) by user ${user.id}`);
      return {
        app: app.slug,
        format: ext,
        size_bytes: buf.length,
        url: `/api/apps/${app.slug}/icon`,
      };
    },
  },

  {
    name: 'appcrane_get_guide',
    description:
      'Fetch the latest AppCrane playbook on a given topic. Use this at the START of any non-trivial workflow so you operate on the current authoritative guidance, not on whatever you remember from a past session. Topics: "onboarding" = the full new-app onboarding playbook (paths a/b/c/d, health-endpoint contract, common pitfalls). "operations" = the comprehensive agent operations guide (deploy, env, logs, rollback, every appcrane_* tool). "email" = how a hosted app sends email through AppCrane (the /api/service/email endpoint, env vars, recipient rules). Topic defaults to "onboarding" if omitted. Returns markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['onboarding', 'operations', 'email'],
          description: 'Which guide to fetch. Default: onboarding.',
        },
      },
      additionalProperties: false,
    },
    requiredRole: 'any',
    readOnly: true,
    handler: async (_user, args) => {
      const topic = ['operations', 'email'].includes(args.topic) ? args.topic : 'onboarding';
      const { readFileSync, existsSync } = await import('fs');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));

      // v2.5.24: both guides now live in server/services/guides/. The
      // legacy AGENT_GUIDE.md at the repo root was retired along with
      // its REST/curl examples — AppCrane is MCP-only for agents now.
      const path = join(__dirname, 'guides', `${topic}.md`);
      if (!existsSync(path)) throw new Error(`Guide '${topic}' not found on this AppCrane install`);

      let content = readFileSync(path, 'utf8');
      // Substitute {{HOST}} placeholder with the configured CRANE_DOMAIN so
      // the agent sees the right host in its instructions. Falls back to a
      // generic phrasing when CRANE_DOMAIN is unset.
      const host = process.env.CRANE_DOMAIN || 'your AppCrane host';
      content = content.replace(/\{\{HOST\}\}/g, host);

      return {
        topic,
        host,
        markdown: content,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    },
  },

  {
    name: 'appcrane_create_managed_app',
    description:
      'Create a new app using AppCrane\'s GitHub service-account — the platform creates a repo on the configured org/user, owns it, and the agent works against it through github_* tools without the end user ever needing their own PAT. Use this when the user does not have a GitHub account or does not want to deal with GitHub at all. Requires the platform admin to have configured the service-account in Settings → GitHub. Returns the same shape as appcrane_create_app, plus the auto-created repo metadata. IDEMPOTENT RECOVERY: if the slug already exists as a managed app but its AMC_ repo was never created (a half-created app from an earlier failure — push then returns REPO_NOT_FOUND), calling this again re-provisions the missing repo and returns { repaired: true } instead of erroring. So if a create attempt half-failed, just call it again with the same slug. Owner-or-admin to repair an existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Display name (human-readable)' },
        slug:        { type: 'string', description: 'URL slug, lowercase-alphanumeric-with-dashes. Becomes the repo name.' },
        description: { type: 'string', description: 'Optional. Used as both app description and repo description.' },
        branch:      { type: 'string', description: 'Default branch for the new repo. Defaults to "main".' },
        domain:      { type: 'string', description: 'Optional custom domain.' },
        max_ram_mb:      { type: 'number', description: 'Per-container memory cap. Default: 512.' },
        max_cpu_percent: { type: 'number', description: 'Per-container CPU cap. Default: 50.' },
      },
      required: ['name', 'slug'],
      additionalProperties: false,
    },
    requiredRole: 'create_app',
    handler: async (user, args) => {
      const { name, slug } = args;
      if (!name || !slug) throw new Error('name and slug are required');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('slug must be lowercase alphanumeric with dashes');
      if (args.branch && !/^[A-Za-z0-9._/\-]{1,200}$/.test(args.branch)) {
        throw new Error('branch must be alphanumeric with . _ / - (max 200 chars)');
      }

      const db = getDb();
      const { createAppRepo, getServiceConfig } = await import('./githubService.js');
      const cfg = getServiceConfig();
      if (!cfg.enabled) throw new Error('GitHub service-account is disabled. Enable it in Settings → GitHub before using managed mode.');
      if (!cfg.configured) throw new Error('GitHub service-account has no token. Configure it in Settings → GitHub before using managed mode.');

      // v2.10.4: self-heal a half-created managed app. If an earlier attempt
      // wrote the app row but never landed the AMC_ repo (e.g. it died on a
      // 401 mid-provision), the app is stuck: create says "slug exists", push
      // says REPO_NOT_FOUND, and there's no MCP delete. Re-calling this tool
      // now RE-PROVISIONS the missing repo instead of erroring — idempotent
      // recovery the agent can drive itself.
      const existing = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
      if (existing) {
        if (existing.source_type !== 'managed') {
          throw new Error(`App slug '${slug}' already exists (source_type='${existing.source_type}'). Pick a different slug.`);
        }
        if (!isAdmin(user) && roleForUserOnApp(user, existing) !== 'owner') {
          throw new Error(`App slug '${slug}' already exists and you are not its owner.`);
        }
        let repaired;
        try {
          repaired = await createAppRepo(slug, { description: args.description || existing.description || '' });
        } catch (e) {
          if (/REPO_EXISTS/.test(e.message)) {
            throw new Error(`App '${slug}' already exists and its AMC_ repo is provisioned — nothing to repair. Use appcrane_push_to_managed_app + appcrane_deploy.`);
          }
          throw new Error(`Failed to re-provision repo for '${slug}': ${e.message}`);
        }
        db.prepare("UPDATE apps SET github_url = ?, branch = COALESCE(NULLIF(branch, ''), ?), source_type = 'managed' WHERE id = ?")
          .run(repaired.html_url, repaired.default_branch || 'main', existing.id);
        log.info(`MCP: repaired half-created managed app '${slug}' — re-provisioned ${repaired.full_name || repaired.name} by user ${user.id}`);
        return {
          app: slug,
          repaired: true,
          repo: { name: repaired.name, html_url: repaired.html_url, default_branch: repaired.default_branch },
          next: `Repo (re)provisioned. Next: appcrane_push_to_managed_app slug="${slug}" files=[…], then appcrane_deploy slug="${slug}" stage="sandbox".`,
        };
      }

      // Create the GitHub repo first — if this fails (token misconfigured,
      // owner is wrong, slug collides), bail before touching the DB so we
      // don't leave half-baked apps behind.

      let repo;
      try {
        repo = await createAppRepo(slug, { description: args.description || '' });
      } catch (e) {
        throw new Error(`Failed to create managed repo for '${slug}': ${e.message}`);
      }

      const { getNextSlot, getPortsForSlot } = await import('./portAllocator.js');
      const { reloadCaddy } = await import('./caddy.js');

      const slot = getNextSlot(db);
      const ports = getPortsForSlot(slot);
      // v2.21.5: only platform admins choose CPU/memory; others get defaults.
      const platAdmin = user.role === 'platform_admin';
      const resourceLimits = JSON.stringify({
        max_ram_mb:      (platAdmin && args.max_ram_mb)      || 512,
        max_cpu_percent: (platAdmin && args.max_cpu_percent) || 50,
      });
      const branch = args.branch || repo.default_branch || 'main';

      const result = db.prepare(`
        INSERT INTO apps (name, slug, slot, domain, description, category, source_type, github_url, branch, github_token_encrypted, resource_limits, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'managed', ?, ?, NULL, ?, ?)
      `).run(name, slug, slot, args.domain || null, args.description || null, null, repo.html_url, branch, resourceLimits, user.id);
      const appId = result.lastInsertRowid;

      for (const env of ['production', 'sandbox']) {
        db.prepare('INSERT INTO health_configs (app_id, env) VALUES (?, ?)').run(appId, env);
        db.prepare('INSERT INTO health_state (app_id, env) VALUES (?, ?)').run(appId, env);
      }
      // Auto-assign creator as both member and owner. The app_user_roles
      // owner row is what makes "⚠ No owner" go away on /applications and
      // gives this user per-app authz boundaries (e.g. the appcrane_*
      // access-management tools). Forgetting it was the v2.5.12 bug.
      db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(appId, user.id);
      db.prepare(`
        INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, 'owner')
        ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = 'owner'
      `).run(appId, user.id);

      const webhookToken = crypto.randomBytes(16).toString('hex');
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO webhook_configs (app_id, token, secret) VALUES (?, ?, ?)').run(appId, webhookToken, webhookSecret);

      const dataDir = process.env.DATA_DIR || './data';
      const appDir = join(dataDir, 'apps', slug);
      for (const env of ['production', 'sandbox']) {
        const envDir = join(appDir, env);
        mkdirSync(join(envDir, 'releases'), { recursive: true });
        mkdirSync(join(envDir, 'shared', 'data'), { recursive: true });
      }

      try { await reloadCaddy(); } catch (_) {}
      try {
        const { refreshAppChecks } = await import('./healthChecker.js');
        refreshAppChecks(appId);
      } catch (_) {}

      log.info(`MCP: managed app '${slug}' created by user ${user.id}; repo=${repo.full_name}`);
      const craneDomain = process.env.CRANE_DOMAIN;
      const urls = craneDomain ? {
        production: `https://${craneDomain}/${slug}`,
        sandbox:    `https://${craneDomain}/${slug}-sandbox`,
      } : null;
      return {
        app: { slug, name, github_url: repo.html_url, branch, source_type: 'managed' },
        repo: {
          full_name:      repo.full_name,
          html_url:       repo.html_url,
          clone_url:      repo.clone_url,
          default_branch: repo.default_branch,
          private:        repo.private,
          owner_type:     repo.owner_type,
        },
        ports,
        urls,
        next: `Push scaffolding via appcrane_push_to_managed_app slug="${slug}" files=[…], then appcrane_deploy slug="${slug}" stage="sandbox". Do NOT use github_push_files for this repo — that's authed with the user's PAT and has zero access to the service account.`,
      };
    },
  },

  {
    name: 'appcrane_push_to_managed_app',
    description:
      'Push a batch of files to a managed app\'s AMC_<slug> repo, authenticated server-side via AppCrane\'s service-account credential. Use this — NOT github_push_files — for managed apps, because github_* tools authenticate with the caller\'s personal PAT, which has zero access to the service account\'s repos. Multiple files become a single commit. files: [{ path, content, encoding? }] where encoding defaults to "utf-8" (use "base64" for binaries like icons). Requires the app to already exist via appcrane_create_managed_app. v2.7.22: response now includes per-file `sha256` (hex) and decoded `bytes` length so you can verify integrity — compute the SHA-256 of the bytes you sent, compare to the server\'s echo, and fail loudly if they differ. Essential for binary files where inline-string truncation or trailing-byte issues would otherwise produce a silently-broken commit. ' +
      'v2.10.7: for a large CODE file, do NOT inline it — upload the bytes over HTTP and commit by token. (1) ' + '`' + 'curl -F file=@big.js -H "X-API-Key: <your dhk_mcp_ key>" https://<host>/api/files/staged' + '`' + ' returns { token, sha256, size_bytes }. (2) Pass that file as { path, staged_token } instead of { path, content }. The server reads the staged bytes and commits them verbatim, so 100+ KB sources push reliably without the model having to emit the content (which is where inline truncation comes from). Per file, provide exactly one of content or staged_token. Staged tokens are owner-scoped and expiring.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:    { type: 'string', description: 'Managed app slug. Repo name resolved as AMC_<slug>.' },
        files:   {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              path:         { type: 'string', description: 'Repo-relative path (no leading slash, no ..)' },
              content:      { type: 'string', description: 'Inline file content. For binary, base64-encode and set encoding="base64". Omit when using staged_token.' },
              encoding:     { type: 'string', enum: ['utf-8', 'base64'], description: 'Defaults to utf-8. Ignored when staged_token is used (staged bytes are committed as-is).' },
              staged_token: { type: 'string', description: 'Token from POST /api/files/staged. Commits the uploaded bytes verbatim — use instead of content for large code files. Exactly one of content / staged_token per file.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        message: { type: 'string', description: 'Commit message. Defaults to "chore: scaffolding for <slug>".' },
        branch:  { type: 'string', description: 'Target branch. Defaults to the repo\'s default branch (usually "main").' },
      },
      required: ['slug', 'files'],
      additionalProperties: false,
    },
    // v2.7.0: was 'admin' — that blocked the non-admin path (d) flow, where a
    // user granted platform.create_app calls appcrane_create_managed_app (now
    // create_app-gated), becomes owner, and then needs to push scaffolding.
    // app_admin matches set_env; getAppForUser + isAppAdmin enforce per-slug
    // ownership.
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: pushing to a managed repo requires admin or app-admin role');
      if (app.source_type !== 'managed') {
        throw new Error(`App '${app.slug}' is source_type='${app.source_type || 'github'}' — appcrane_push_to_managed_app only works for source_type='managed' apps. For regular GitHub apps, use the github_* MCP tools with your X-Github-Token.`);
      }
      // v2.10.7: a file entry may carry { staged_token } instead of inline
      // { content }. Resolve each token to its HTTP-uploaded bytes (POST
      // /api/files/staged) so large code files commit reliably without the
      // model emitting them verbatim. Same owner/expiry checks as
      // appcrane_push_staged_file; consumed rows are reaped after the commit.
      const db = getDb();
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const consumedTokens = [];
      let resolvedFiles = args.files;
      if (args.files.some((f) => typeof f.staged_token === 'string' && f.staged_token)) {
        const { readFileSync } = await import('fs');
        resolvedFiles = args.files.map((f) => {
          const hasInline = typeof f.content === 'string';
          const hasStaged = typeof f.staged_token === 'string' && f.staged_token.length > 0;
          if (hasStaged && hasInline) throw new Error(`File '${f.path}': provide either content or staged_token, not both`);
          if (!hasStaged && !hasInline) throw new Error(`File '${f.path}': must provide content or staged_token`);
          if (!hasStaged) return { path: f.path, content: f.content, encoding: f.encoding };

          const row = db.prepare('SELECT * FROM staged_files WHERE token = ?').get(f.staged_token);
          if (!row)                    throw new Error(`File '${f.path}': staged file not found (token unknown or already swept)`);
          if (row.user_id !== user.id) throw new Error(`File '${f.path}': staged file is owned by a different user`);
          if (row.pushed_at)           throw new Error(`File '${f.path}': staged file was already consumed`);
          if (row.expires_at < now)    throw new Error(`File '${f.path}': staged file expired at ${row.expires_at}`);
          let buf;
          try { buf = readFileSync(row.scratch_path); } catch (e) { throw new Error(`File '${f.path}': cannot read staged bytes: ${e.message}`); }
          consumedTokens.push(row);
          return { path: f.path, content: buf.toString('base64'), encoding: 'base64' };
        });
      }

      const { pushFilesToManagedRepo } = await import('./githubService.js');
      const result = await pushFilesToManagedRepo(app.slug, resolvedFiles, {
        message: args.message,
        branch:  args.branch || app.branch,
      });
      // v2.10.2: record the SHA we just authored+pushed so the next deploy's
      // supply-chain verify can compare the clone HEAD to THIS, not to GitHub's
      // lagging branch-API HEAD (read-after-write race on the mirror push).
      if (result?.commit?.sha && /^[0-9a-f]{40}$/.test(result.commit.sha)) {
        db.prepare('UPDATE apps SET last_managed_push_sha = ? WHERE id = ?').run(result.commit.sha, app.id);
      }
      // v2.10.7: mark consumed staged rows + free their scratch dirs now the
      // commit landed (the 5-min sweeper would catch them at expiry anyway).
      if (consumedTokens.length) {
        const { rmSync } = await import('fs');
        const { dirname } = await import('path');
        for (const row of consumedTokens) {
          try { rmSync(dirname(row.scratch_path), { recursive: true, force: true }); } catch (_) { /* sweeper retries */ }
          try { db.prepare("UPDATE staged_files SET pushed_at = datetime('now') WHERE token = ?").run(row.token); } catch (_) {}
        }
      }
      log.info(`MCP: pushed ${result.files.length} file(s) to managed repo AMC_${app.slug} (commit ${result.commit.sha.slice(0, 7)}) by user ${user.id}${consumedTokens.length ? ` [${consumedTokens.length} staged]` : ''}`);
      return {
        app:     app.slug,
        commit:  result.commit,
        branch:  result.branch,
        files:   result.files,
        message: result.message,
        next:    `Files pushed. Next: appcrane_deploy slug="${app.slug}" stage="sandbox" to ship.`,
      };
    },
  },

  // v2.21.17: pure-MCP large-file push. appcrane_push_to_managed_app inlines
  // whole files, so a 100+ KB source risks silent truncation as the model emits
  // it (the staged_token path fixes that but needs an HTTP upload). These two
  // tools push a big file entirely over MCP: split it into small parts, send
  // each with push_chunk, then assemble. Each part is small enough to emit
  // reliably, and an optional per-part + final SHA-256 makes corruption fail
  // loudly instead of committing a broken file.
  {
    name: 'appcrane_managed_push_chunk',
    description:
      'Stage ONE part of a large file for a managed app, entirely over MCP (no HTTP upload). ' +
      'Use this + appcrane_managed_assemble when a file is too large to emit reliably inline via appcrane_push_to_managed_app (roughly >64 KB of code). ' +
      'Workflow: pick an opaque `session` id (any unique string, e.g. "app.tsx-1"), split the file into N parts, and call this once per part with part=1..N and of=N. The parts are held server-side keyed by (session, part); appcrane_managed_assemble then concatenates them in order, verifies the whole, and commits. ' +
      'Split on any boundary you like (byte or line) — assemble concatenates the decoded bytes verbatim, so the split points do not need to be newlines. Keep each part small (≤ ~48 KB of content) so inline emission stays reliable. ' +
      'encoding defaults to "utf-8"; use "base64" for binary. If you provide `sha256` (hex SHA-256 of THIS part\'s decoded bytes), the server verifies it on arrival and rejects a corrupted part immediately. Re-sending the same (session, part) overwrites it, so a failed part is safe to retry.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:     { type: 'string', description: 'Managed app slug (repo AMC_<slug>).' },
        path:     { type: 'string', description: 'Repo-relative destination path (no leading slash, no ".."). Must be identical across every part of a session.' },
        session:  { type: 'string', description: 'Opaque upload id grouping the parts. Any unique string; reuse the same value for every part of one file.' },
        part:     { type: 'integer', minimum: 1, description: '1-based part number.' },
        of:       { type: 'integer', minimum: 1, description: 'Total number of parts. Must be identical across every part of a session.' },
        content:  { type: 'string', description: 'This part\'s bytes, encoded per `encoding`.' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Defaults to utf-8. Use base64 for binary files.' },
        sha256:   { type: 'string', description: 'Optional hex SHA-256 of this part\'s decoded bytes. If given, the server verifies it and rejects a mismatch.' },
      },
      required: ['slug', 'path', 'session', 'part', 'of', 'content'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: pushing to a managed repo requires admin or app-admin role');
      if (app.source_type !== 'managed') {
        throw new Error(`App '${app.slug}' is source_type='${app.source_type || 'github'}' — appcrane_managed_push_chunk only works for source_type='managed' apps.`);
      }
      const { path, session, part, of } = args;
      if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) {
        throw new Error(`invalid file path '${path}': must be repo-relative, no ".." or leading slash`);
      }
      if (!Number.isInteger(part) || !Number.isInteger(of) || of < 1 || part < 1 || part > of) {
        throw new Error(`invalid part/of: part must be an integer in 1..of (got part=${part}, of=${of})`);
      }
      const encoding = args.encoding || 'utf-8';
      const decoded = encoding === 'base64'
        ? Buffer.from(args.content, 'base64')
        : Buffer.from(args.content, 'utf-8');
      const actualSha = crypto.createHash('sha256').update(decoded).digest('hex');
      if (args.sha256 && args.sha256.toLowerCase() !== actualSha) {
        throw new Error(`part ${part} SHA-256 mismatch: you declared ${args.sha256} but the received bytes hash to ${actualSha}. The part was corrupted in transit — resend it.`);
      }

      const db = getDb();
      // Defensive: sweep upload sessions that were never assembled (>2h old).
      db.prepare("DELETE FROM managed_push_chunks WHERE created_at < datetime('now', '-2 hours')").run();

      // Enforce consistency across a session: same owner, slug, path, of_total.
      const existing = db.prepare('SELECT user_id, slug, path, of_total FROM managed_push_chunks WHERE session = ? LIMIT 1').get(session);
      if (existing) {
        if (existing.user_id !== user.id) throw new Error(`session '${session}' belongs to a different user`);
        if (existing.slug !== app.slug)   throw new Error(`session '${session}' is already in use for a different app ('${existing.slug}')`);
        if (existing.path !== path)        throw new Error(`session '${session}' is already staging a different path ('${existing.path}') — use a distinct session per file`);
        if (existing.of_total !== of)      throw new Error(`session '${session}' was started with of=${existing.of_total}, not ${of}`);
      }

      db.prepare(
        `INSERT INTO managed_push_chunks (session, user_id, slug, path, part, of_total, encoding, content, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session, part) DO UPDATE SET
           encoding = excluded.encoding, content = excluded.content, sha256 = excluded.sha256, created_at = datetime('now')`
      ).run(session, user.id, app.slug, path, part, of, encoding, args.content, actualSha);

      const have = db.prepare('SELECT part FROM managed_push_chunks WHERE session = ? ORDER BY part').all(session).map(r => r.part);
      const missing = [];
      for (let p = 1; p <= of; p++) if (!have.includes(p)) missing.push(p);
      return {
        session,
        path,
        stored_part: part,
        of,
        bytes: decoded.length,
        sha256: actualSha,
        received_parts: have.length,
        missing_parts: missing,
        next: missing.length === 0
          ? `All ${of} parts received. Next: appcrane_managed_assemble slug="${app.slug}" session="${session}" path="${path}" to commit.`
          : `Still need part(s) ${missing.join(', ')}.`,
      };
    },
  },

  {
    name: 'appcrane_managed_assemble',
    description:
      'Finish a chunked upload started with appcrane_managed_push_chunk: concatenate all parts of a `session` in order, verify the whole, and commit the assembled file to the managed app\'s AMC_<slug> repo as a single commit. ' +
      'Fails if any part is missing. If you pass `sha256` (hex SHA-256 of the ENTIRE original file\'s bytes), the server verifies the reassembled bytes against it and refuses to commit on mismatch — always pass it for large or binary files. On success the staged parts are deleted. Returns the commit sha plus the committed file\'s sha256 and byte length.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:    { type: 'string', description: 'Managed app slug (repo AMC_<slug>).' },
        session: { type: 'string', description: 'The upload id you used for appcrane_managed_push_chunk.' },
        path:    { type: 'string', description: 'The destination path; must match what the parts were staged with.' },
        sha256:  { type: 'string', description: 'Optional hex SHA-256 of the whole original file. If given, the reassembled bytes are verified against it before committing.' },
        message: { type: 'string', description: 'Commit message. Defaults to "chore: update <path>".' },
        branch:  { type: 'string', description: 'Target branch. Defaults to the app\'s branch / repo default.' },
      },
      required: ['slug', 'session', 'path'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: pushing to a managed repo requires admin or app-admin role');
      if (app.source_type !== 'managed') {
        throw new Error(`App '${app.slug}' is source_type='${app.source_type || 'github'}' — appcrane_managed_assemble only works for source_type='managed' apps.`);
      }
      const db = getDb();
      const rows = db.prepare('SELECT * FROM managed_push_chunks WHERE session = ? ORDER BY part').all(args.session);
      if (rows.length === 0) throw new Error(`no staged parts for session '${args.session}' (unknown, already assembled, or swept)`);
      const first = rows[0];
      if (first.user_id !== user.id) throw new Error(`session '${args.session}' belongs to a different user`);
      if (first.slug !== app.slug)   throw new Error(`session '${args.session}' was staged for app '${first.slug}', not '${app.slug}'`);
      if (first.path !== args.path)  throw new Error(`session '${args.session}' was staged for path '${first.path}', not '${args.path}'`);

      const of = first.of_total;
      const seen = new Set(rows.map(r => r.part));
      const missing = [];
      for (let p = 1; p <= of; p++) if (!seen.has(p)) missing.push(p);
      if (missing.length) throw new Error(`cannot assemble session '${args.session}': missing part(s) ${missing.join(', ')} of ${of}`);

      // Concatenate decoded bytes in part order.
      const buf = Buffer.concat(rows.map(r =>
        r.encoding === 'base64' ? Buffer.from(r.content, 'base64') : Buffer.from(r.content, 'utf-8')
      ));
      const fullSha = crypto.createHash('sha256').update(buf).digest('hex');
      if (args.sha256 && args.sha256.toLowerCase() !== fullSha) {
        throw new Error(`assembled file SHA-256 mismatch: you declared ${args.sha256} but the reassembled bytes hash to ${fullSha}. Not committing. Re-check the parts.`);
      }

      const { pushFilesToManagedRepo } = await import('./githubService.js');
      const result = await pushFilesToManagedRepo(app.slug, [{ path: args.path, content: buf.toString('base64'), encoding: 'base64' }], {
        message: args.message || `chore: update ${args.path}`,
        branch:  args.branch || app.branch,
      });
      if (result?.commit?.sha && /^[0-9a-f]{40}$/.test(result.commit.sha)) {
        db.prepare('UPDATE apps SET last_managed_push_sha = ? WHERE id = ?').run(result.commit.sha, app.id);
      }
      db.prepare('DELETE FROM managed_push_chunks WHERE session = ?').run(args.session);
      log.info(`MCP: assembled ${of}-part upload (${buf.length} bytes) to AMC_${app.slug}:${args.path} (commit ${result.commit.sha.slice(0, 7)}) by user ${user.id}`);
      return {
        app:    app.slug,
        commit: result.commit,
        branch: result.branch,
        file:   { path: args.path, bytes: buf.length, sha256: fullSha, ...result.files[0] },
        next:   `File committed. Next: appcrane_deploy slug="${app.slug}" stage="sandbox" to ship.`,
      };
    },
  },

  {
    name: 'appcrane_managed_patch',
    description:
      'Edit an existing text file in a managed app\'s AMC_<slug> repo by applying a unified diff, entirely over MCP — you emit only the changed hunks, not the whole file. ' +
      'Ideal for small edits to a large file (avoids re-emitting the whole thing, which is where inline truncation comes from). The server fetches the current file, applies your `unified_diff`, and commits the result as a single commit. ' +
      'The diff must be a standard unified diff (as from `git diff` / `diff -u`): `@@ -old,len +new,len @@` hunk headers, lines prefixed with " " (context), "-" (remove), "+" (add). Include a few context lines around each change. Hunks are matched by CONTENT (not just line numbers), so small line drift is tolerated — but if a hunk\'s context does not match the current file, the whole patch is rejected and nothing is committed (re-read the file and regenerate the diff). Only single-file diffs are supported; the target is `path`, not the diff\'s ---/+++ headers.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:        { type: 'string', description: 'Managed app slug (repo AMC_<slug>).' },
        path:        { type: 'string', description: 'Repo-relative path of the file to patch (no leading slash, no "..").' },
        unified_diff:{ type: 'string', description: 'A standard unified diff to apply to the current contents of `path`.' },
        message:     { type: 'string', description: 'Commit message. Defaults to "chore: patch <path>".' },
        branch:      { type: 'string', description: 'Target branch. Defaults to the app\'s branch / repo default.' },
      },
      required: ['slug', 'path', 'unified_diff'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: patching a managed repo requires admin or app-admin role');
      if (app.source_type !== 'managed') {
        throw new Error(`App '${app.slug}' is source_type='${app.source_type || 'github'}' — appcrane_managed_patch only works for source_type='managed' apps.`);
      }
      if (typeof args.path !== 'string' || args.path.includes('..') || args.path.startsWith('/')) {
        throw new Error(`invalid file path '${args.path}': must be repo-relative, no ".." or leading slash`);
      }
      const branch = args.branch || app.branch;
      const { readManagedRepoFile, pushFilesToManagedRepo } = await import('./githubService.js');
      const { applyUnifiedDiff } = await import('./unifiedDiff.js');

      const current = await readManagedRepoFile(app.slug, args.path, { branch });
      const patched = applyUnifiedDiff(current.content, args.unified_diff);
      if (patched === current.content) {
        throw new Error(`the unified_diff produced no change to '${args.path}' — it may already be applied, or the diff is empty.`);
      }

      const db = getDb();
      const result = await pushFilesToManagedRepo(app.slug, [{ path: args.path, content: patched, encoding: 'utf-8' }], {
        message: args.message || `chore: patch ${args.path}`,
        branch,
      });
      if (result?.commit?.sha && /^[0-9a-f]{40}$/.test(result.commit.sha)) {
        db.prepare('UPDATE apps SET last_managed_push_sha = ? WHERE id = ?').run(result.commit.sha, app.id);
      }
      log.info(`MCP: patched AMC_${app.slug}:${args.path} (${current.bytes}→${Buffer.byteLength(patched, 'utf-8')} bytes, commit ${result.commit.sha.slice(0, 7)}) by user ${user.id}`);
      return {
        app:    app.slug,
        commit: result.commit,
        branch: result.branch,
        file:   { path: args.path, bytes_before: current.bytes, bytes_after: Buffer.byteLength(patched, 'utf-8'), ...result.files[0] },
        next:   `Patch committed. Next: appcrane_deploy slug="${app.slug}" stage="sandbox" to ship.`,
      };
    },
  },

  {
    name: 'appcrane_set_secret',
    description:
      'Set or update a secret (an encrypted environment variable injected into the app). Encrypted at rest; only the running app process can read the plaintext. ' +
      'Defaults to sandbox; require explicit stage="production" only when the user asks. ' +
      'App-admin or AppCrane admin only. Respects the caller\'s mcp_app_scope.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:  { type: 'string' },
        env:   { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        key:   { type: 'string', description: 'Env var name. Letters, digits, underscores; must not start with a digit.' },
        value: { type: 'string', description: 'The value to store (will be encrypted server-side).' },
      },
      required: ['slug', 'key', 'value'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: setting env vars requires admin or app-admin role');
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(args.key)) {
        throw new Error(`Invalid env var key: ${args.key} (must match /^[A-Z_][A-Z0-9_]*$/i)`);
      }
      const db = getDb();
      const encrypted = encrypt(String(args.value));
      db.prepare(`
        INSERT INTO env_vars (app_id, env, key, value_encrypted, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(app_id, env, key) DO UPDATE SET
          value_encrypted = excluded.value_encrypted,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(app.id, env, args.key, encrypted, user.id);
      log.info(`MCP: env var ${args.key} set on ${app.slug}/${env} by user ${user.id}`);
      return { app: app.slug, env, key: args.key, ok: true };
    },
  },

  {
    name: 'appcrane_cp',
    description:
      'Copy/upload a file straight into the app\'s persistent /data volume on the host (aliases: appcrane_upload, appcrane_set_data_blob) — single hop, no container round-trip, no GitHub round-trip, no inline size ceiling. The bytes land at /data/apps/<slug>/<env>/shared/data/<path>, which is the SAME path the running container sees mounted as /data/<path>. Right tool for multi-MB datasets, large fixtures, or anything where appcrane_push_to_managed_app\'s tool-arg ceiling would force chunking. Returns the SHA-256 + byte count of what was stored so the caller can verify integrity. App-admin or owner of the app required. NEVER returns secrets in the response. Path must be repo-relative, no `..`, no leading slash.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:     { type: 'string', description: 'App slug.' },
        env:      { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox', description: 'Which env\'s /data volume to write to.' },
        path:     { type: 'string', description: 'Path within /data, e.g. "datasets/threats.json" or "cache/build.tar.gz". No leading slash, no "..".' },
        content:  { type: 'string', description: 'The data to write. utf-8 string or base64-encoded bytes depending on encoding.' },
        encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8', description: 'Defaults to utf-8. Use base64 for binary blobs.' },
      },
      required: ['slug', 'path', 'content'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: writing to /data requires admin or app-admin role on this app');

      // Path validation — repo-relative, no traversal, no absolute. resolveSafe
      // verifies the final path is within the shared/data root after symlink
      // expansion (same primitive deployer.js uses).
      const rel = String(args.path || '').trim();
      if (!rel) throw new Error('path is required');
      if (rel.startsWith('/')) throw new Error('path must NOT start with "/" — it is relative to /data');
      if (rel.split('/').some(seg => seg === '..' || seg === '.')) {
        throw new Error('path must not contain "." or ".." segments');
      }

      const { mkdirSync, writeFileSync } = await import('fs');
      const { resolve, join, dirname } = await import('path');
      const { createHash } = await import('crypto');

      const dataDir = resolve(process.env.DATA_DIR || './data');
      const sharedRoot = resolve(join(dataDir, 'apps', app.slug, env, 'shared', 'data'));
      const targetPath = resolve(join(sharedRoot, rel));
      if (!targetPath.startsWith(sharedRoot + '/') && targetPath !== sharedRoot) {
        throw new Error('Security: resolved path escapes shared/data');
      }

      // Decode content. utf-8 string passthrough or base64 → buffer.
      const encoding = args.encoding === 'base64' ? 'base64' : 'utf-8';
      const buf = encoding === 'base64'
        ? Buffer.from(String(args.content), 'base64')
        : Buffer.from(String(args.content), 'utf-8');

      mkdirSync(dirname(targetPath), { recursive: true });
      // Atomic write: write to .tmp, rename. Readers never see a partial file.
      const tmpPath = targetPath + '.tmp-' + Date.now();
      writeFileSync(tmpPath, buf);
      const { renameSync } = await import('fs');
      renameSync(tmpPath, targetPath);

      const sha256 = createHash('sha256').update(buf).digest('hex');
      log.info(`MCP: /data write ${app.slug}/${env}/${rel} ← ${buf.length} bytes (sha256=${sha256.slice(0, 12)}) by user ${user.id}`);
      return {
        app: app.slug,
        env,
        path: rel,
        bytes: buf.length,
        sha256,
        encoding,
        container_path: '/data/' + rel,
        host_path: targetPath,
      };
    },
  },

  {
    name: 'appcrane_list_cron',
    description:
      'List the scheduled jobs declared in an app\'s deployhub.json `cron` array (after the most recent deploy). Each entry includes the cron schedule, the command, when it last ran, the exit code, and the tail of the last run\'s stdout/stderr. Use to verify a job was registered, debug a missing run, or read the recent log. App-admin or owner.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        env:  { type: 'string', enum: ['sandbox', 'production'], description: 'Optional — omit to list both envs.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    readOnly: true,
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: reading cron jobs requires admin or app-admin role on this app');
      const db = getDb();
      const filters = args.env ? 'AND env = ?' : '';
      const params = args.env ? [app.id, args.env] : [app.id];
      const rows = db.prepare(`
        SELECT id, env, name, schedule, command, enabled, timeout_seconds,
               last_run_at, last_exit_code, last_log
        FROM app_cron_jobs
        WHERE app_id = ? ${filters}
        ORDER BY env, name
      `).all(...params);
      return { app: app.slug, jobs: rows };
    },
  },

  {
    name: 'appcrane_run_cron_now',
    description:
      'Trigger a scheduled cron job RIGHT NOW, regardless of its schedule. Useful for "I want to test my daily rebuild without waiting until midnight" or "rerun yesterday\'s failed job." Runs the same `docker exec` the tick loop would, against the app\'s container; updates last_run_at / last_exit_code / last_log just like a scheduled run. Returns the exit code and last-log tail. App-admin or owner. Idempotent: if the job is already running (mutex held), reports it and skips rather than overlapping.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        env:  { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
        name: { type: 'string', description: 'Job name from deployhub.json `cron[].name`.' },
      },
      required: ['slug', 'name'],
      additionalProperties: false,
    },
    requiredRole: 'app_admin',
    handler: async (user, args) => {
      const env = args.env === 'production' ? 'production' : 'sandbox';
      const app = getAppForUser(user, args.slug);
      if (!isAppAdmin(user, app)) throw new Error('Forbidden: running cron jobs requires admin or app-admin role on this app');
      const db = getDb();
      const job = db.prepare(`
        SELECT id, app_id, env, name, schedule, command, timeout_seconds
        FROM app_cron_jobs
        WHERE app_id = ? AND env = ? AND name = ?
      `).get(app.id, env, String(args.name));
      if (!job) throw new Error(`No cron job named "${args.name}" on ${app.slug}/${env}. Check deployhub.json or appcrane_list_cron.`);
      const { runCronJob } = await import('./cronScheduler.js');
      const result = await runCronJob(job);
      return { app: app.slug, env, name: job.name, ...result };
    },
  },
  {
    name: 'appcrane_check_resource_limits',
    description:
      'Which containers are NOT running with the CPU/RAM limits AppCrane has configured for them? Compares every app row against the limits actually in force on its container and reports only the mismatches. `--memory` and `--cpus` are `docker run` flags, so changing a limit rewrites the database and nothing else until the container is RECREATED — a container created before the limit was set keeps running without it, and every other AppCrane surface reports the CONFIGURED number, so the two are indistinguishable without this. `memory state=not_applied` means NO limit at all: that container can take the whole host, and on a host with no swap that ends as a global OOM kill of whatever the kernel judges largest. Answers `applied: null` (unknown) rather than guessing when Docker cannot be read. ADMIN ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Check one app instead of the whole fleet.' },
        include_ok: { type: 'boolean', default: false, description: 'Also list containers whose limits ARE applied. Default false — the point is the exceptions.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    readOnly: true,
    handler: async (user, args) => {
      const { containerResourcesBySlug } = await import('./docker.js');
      const { resourceDrift } = await import('./resourceDrift.js');
      const db = getDb();

      const apps = args.slug
        ? [getAppForUser(user, args.slug)]
        : db.prepare('SELECT id, slug, resource_limits FROM apps ORDER BY slug').all();

      const observedMap = await containerResourcesBySlug();
      if (observedMap === null) {
        return {
          checked: 0, unknown: true,
          summary: 'Docker could not be read, so whether any limit is in force is UNKNOWN. This is not a report that limits are missing.',
        };
      }

      const rows = [];
      for (const app of apps) {
        for (const env of ['production', 'sandbox']) {
          const observed = observedMap.get(`${app.slug}:${env}`) ?? null;
          if (observed === null) continue;   // no container for this env — nothing to compare
          const d = resourceDrift(app, observed);
          if (d.applied && !args.include_ok) continue;
          rows.push({
            app: app.slug, env,
            running: observed.running,
            applied: d.applied,
            configured: d.expected,
            actual: d.actual,
            findings: d.findings,
          });
        }
      }

      const unlimited = rows.filter(r => r.findings.some(f => f.state === 'not_applied'));
      return {
        checked: apps.length,
        mismatches: rows.length,
        containers_with_no_limit: unlimited.length,
        rows,
        summary: rows.length === 0
          ? 'Every container is running with the limits AppCrane has configured for it.'
          : `${rows.length} container(s) differ from their configured limits` +
            (unlimited.length ? `, and ${unlimited.length} are running with NO limit on at least one resource — those can take the whole host.` : '.') +
            ' A limit is a `docker run` flag: recreate the container (a deploy, or POST /api/apps/<slug>/restart/<env>) to apply it. `docker restart` reuses the existing container and will NOT.',
      };
    },
  },
  // ── Off-site backup (v2.48.0) ───────────────────────────────────────────
  //
  // AppCrane has had scheduled S3/R2 backup since v2.21.9, and its whole
  // configuration — the SQLite DB, .env, icons, appdata — goes up in one zip.
  // It is a no-op until an operator fills in a bucket and credentials, and
  // there was no way to ASK whether that had happened except by opening
  // Settings. An August 2026 incident review consequently recorded "no SQLite
  // backup exists" as an open risk, when the truth was "the feature exists and
  // nobody enabled it" — a settings task filed as a missing capability.
  //
  // These three answer it from an agent: is it configured, make it so, run it
  // now. Platform admin only, checked as the FIRST statement in every handler,
  // matching appcrane_set_app_ingress: a backup destination is where a copy of
  // every secret on the platform gets written, so it is not an app-owner field.
  {
    name: 'appcrane_get_backup_status',
    description:
      'Is off-site backup actually working? Reports the scheduled S3/R2 backup config together with a verdict — `configured`, `enabled`, `healthy`, when it last ran and what is missing — so "are we backed up" is one call rather than an inference from raw settings. The backup covers the SQLite database (apps, users, settings, encrypted env vars), .env, icons and appdata, uploaded nightly as one zip. NEVER returns the secret access key; `has_secret` reports only whether one is stored. Read the `summary` first: a config can be fully populated and still not be running (enabled=false), and it can be enabled and failing every night (see last_error). PLATFORM ADMIN ONLY.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiredRole: 'admin',
    readOnly: true,
    handler: async (user) => {
      if (user.role !== 'platform_admin') {
        throw new Error('Only platform admins can read the backup configuration — it names the destination every platform secret is copied to.');
      }
      const { getBackupConfig } = await import('./backupScheduler.js');
      const cfg = getBackupConfig();
      const configured = !!(cfg.bucket && cfg.access_key_id && cfg.has_secret);

      // Staleness is measured, not assumed from `enabled`. A nightly job that
      // has not run in three days is the case an operator most needs told, and
      // it looks identical to a healthy one if you only read the config.
      const lastRunMs = cfg.last_run ? Date.parse(cfg.last_run) : NaN;
      const hoursSince = Number.isFinite(lastRunMs)
        ? Math.floor((Date.now() - lastRunMs) / 3600000)
        : null;
      const overdue = hoursSince !== null && hoursSince > 36;
      const healthy = configured && cfg.enabled && !cfg.last_error && hoursSince !== null && !overdue;

      const missing = [];
      if (!cfg.bucket) missing.push('bucket');
      if (!cfg.access_key_id) missing.push('access_key_id');
      if (!cfg.has_secret) missing.push('secret_access_key');

      let summary;
      if (!configured) {
        summary = `NOT CONFIGURED — no off-site backup is being taken. Missing: ${missing.join(', ')}. ` +
          'Everything AppCrane knows lives in one SQLite file on this host; until this is set there is no copy of it anywhere else.';
      } else if (!cfg.enabled) {
        summary = 'CONFIGURED BUT DISABLED — credentials are stored and nothing is being uploaded. Set enabled=true to start the nightly schedule.';
      } else if (cfg.last_error) {
        summary = `ENABLED BUT FAILING — the last attempt errored: ${cfg.last_error}`;
      } else if (hoursSince === null) {
        summary = 'ENABLED, NEVER RUN — the schedule is on but no upload has completed yet. Use appcrane_run_backup_now to prove it works rather than waiting for tonight.';
      } else if (overdue) {
        summary = `ENABLED BUT OVERDUE — last successful upload was ${hoursSince}h ago, and this runs nightly. Something is stopping it.`;
      } else {
        summary = `Healthy — last uploaded ${hoursSince}h ago to s3://${cfg.bucket}/${cfg.prefix || ''}`;
      }

      return {
        ...cfg,
        configured,
        healthy,
        missing,
        hours_since_last_run: hoursSince,
        summary,
        covers: ['deployhub.db (apps, users, settings, encrypted env vars)', '.env', 'icons', 'appdata'],
      };
    },
  },
  {
    name: 'appcrane_set_backup_config',
    description:
      'Configure the scheduled off-site (S3 / S3-compatible, e.g. Cloudflare R2) backup. Every field is optional — only what you pass is changed. Enabling is REFUSED unless bucket, access_key_id and a stored secret are all present, because an enabled-but-unconfigured backup fails silently every night while every status surface reads "enabled", which is worse than being plainly off. SECURITY: `secret_access_key` is write-only — AppCrane encrypts it and never returns it — but passing it here means the plaintext value travels through this conversation and whatever logs it. Prefer Settings → Backup in the dashboard for the secret itself, and use this tool for the rest. PLATFORM ADMIN ONLY: this names the destination a copy of every secret on the platform is written to, so pointing it at the wrong bucket is an exfiltration path, not a misconfiguration.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled:           { type: 'boolean', description: 'Turn the nightly schedule on or off. Refused with enabled=true unless bucket, access_key_id and a stored secret all exist.' },
        bucket:            { type: 'string',  description: 'Destination bucket name.' },
        region:            { type: 'string',  description: 'Region, e.g. us-east-1. Defaults to us-east-1.' },
        prefix:            { type: 'string',  description: 'Key prefix inside the bucket, e.g. "appcrane/". Optional.' },
        endpoint:          { type: 'string',  description: 'Custom S3 endpoint for a non-AWS provider (Cloudflare R2, MinIO). Leave empty for AWS.' },
        access_key_id:     { type: 'string',  description: 'Access key id. Not a secret on its own; stored in the clear.' },
        secret_access_key: { type: 'string',  description: 'Secret access key. Write-only: encrypted at rest, never returned by any read surface. NOTE: passing it here puts the plaintext in this conversation — the dashboard is the better place for it.' },
        hour:              { type: 'integer', minimum: 0, maximum: 23, description: 'Hour of day (server local time) to run. Default 3.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    handler: async (user, args) => {
      if (user.role !== 'platform_admin') {
        throw new Error('Only platform admins can change the backup configuration — it names the destination every platform secret is copied to.');
      }
      const { getBackupConfig, setBackupConfig } = await import('./backupScheduler.js');
      const before = getBackupConfig();

      // Refuse to enable a backup that cannot run. The scheduler would throw
      // "not fully configured" nightly into the log while every status surface
      // reported enabled:true — the reassuring-but-false state this whole tool
      // exists to make visible.
      if (args.enabled === true) {
        const bucket = args.bucket ?? before.bucket;
        const keyId  = args.access_key_id ?? before.access_key_id;
        const secret = args.secret_access_key ? true : before.has_secret;
        const missing = [];
        if (!bucket) missing.push('bucket');
        if (!keyId) missing.push('access_key_id');
        if (!secret) missing.push('secret_access_key');
        if (missing.length) {
          throw new Error(
            `Cannot enable backup — still missing: ${missing.join(', ')}. An enabled backup with no destination ` +
            'fails every night while reporting itself enabled. Supply the missing fields in this same call, or set ' +
            'them first and enable afterwards.');
        }
      }

      const after = setBackupConfig(args, user.id);

      // Audited under its own action. A generic MCP call entry records that a
      // tool ran; an operator reviewing where platform secrets are shipped to
      // needs to find the destination change by name. The secret is recorded
      // as a fact, never as a value.
      const { logAudit } = await import('../middleware/audit.js');
      const changed = {};
      for (const k of ['enabled', 'bucket', 'region', 'prefix', 'endpoint', 'access_key_id', 'hour']) {
        if (args[k] !== undefined && before[k] !== after[k]) changed[k] = { from: before[k], to: after[k] };
      }
      if (args.secret_access_key) changed.secret_access_key = { from: '(redacted)', to: '(redacted, replaced)' };
      logAudit(user.id, null, 'backup-config-change', { changed });

      return {
        ...after,
        changed_fields: Object.keys(changed),
        next: after.enabled
          ? 'Enabled. Run appcrane_run_backup_now to prove the credentials work rather than finding out at 03:00.'
          : 'Saved but NOT enabled — nothing is being uploaded yet. Set enabled=true when ready.',
      };
    },
  },
  {
    name: 'appcrane_run_backup_now',
    description:
      'Run the off-site backup immediately and report what was uploaded. Use this to PROVE a new configuration works instead of waiting for the nightly run to fail quietly — it exercises the real credentials, the real bucket and the real upload path, and records the result in last_run / last_error exactly as the scheduled job does. Works whether or not the schedule is enabled, so a configuration can be verified before turning it on. Uploads a zip of the SQLite database, .env, icons and appdata. PLATFORM ADMIN ONLY.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiredRole: 'admin',
    handler: async (user) => {
      if (user.role !== 'platform_admin') {
        throw new Error('Only platform admins can run a backup — it writes a copy of every platform secret to the configured destination.');
      }
      const { runS3Backup, getBackupConfig } = await import('./backupScheduler.js');
      const { logAudit } = await import('../middleware/audit.js');
      const cfg = getBackupConfig();
      try {
        const r = await runS3Backup();
        logAudit(user.id, null, 'backup-run', { ok: true, bucket: cfg.bucket, key: r.key, size: r.size });
        return {
          ok: true,
          ...r,
          bucket: cfg.bucket,
          note: `Uploaded ${r.size} bytes to s3://${cfg.bucket}/${r.key}. This is a full copy of the platform's secrets — treat the bucket as such.`,
        };
      } catch (e) {
        // Returned rather than thrown: a failed backup is an ANSWER to "does
        // this work", and the message (bad credentials, wrong region, no such
        // bucket) is the useful part. last_error is already recorded by the
        // service, so this is visible to every other surface too.
        logAudit(user.id, null, 'backup-run', { ok: false, bucket: cfg.bucket, error: String(e.message).slice(0, 300) });
        return { ok: false, error: e.message, bucket: cfg.bucket, configured: !!(cfg.bucket && cfg.access_key_id && cfg.has_secret) };
      }
    },
  },
  // ── Fleet memory budget (v2.49.0) ───────────────────────────────────────
  //
  // From the same August 2026 review as the backup tools. A container was
  // OOM-killed on a swapless host while its configuration promised it 512 MB of
  // swap; separately, the fleet's per-container ceilings sum to roughly 25 GB on
  // a 7.6 GB host. Both are the same defect — a number that reads as a guarantee
  // and is not one — and neither was answerable without adding up 50 app rows by
  // hand.
  //
  // The single most important thing about this tool is what its numbers are NOT.
  // `committed_mb` is the sum of CONFIGURED ceilings; it is not, and cannot be,
  // a measurement of memory in use. An agent that reads "25 GB committed" and
  // reports "the host is using 25 GB" has invented an outage. That distinction
  // is stated in the description, restated in the summary, and carried in the
  // field names, because it is the only way this tool can be read wrong.
  {
    name: 'appcrane_memory_budget',
    description:
      'Does the sum of every app\'s CONFIGURED memory ceiling fit in this host\'s RAM? Adds up the per-container `--memory` limits AppCrane has on file and compares the total against total host memory. THESE ARE CONFIGURED CEILINGS, NOT MEASURED USAGE: a report of "25 GB committed on a 7.6 GB host" does NOT mean the host is using 25 GB, and must never be relayed as one — it means the limits promise more than the host can deliver if the containers ever ask for it at once. Nothing here reads a running container; for what is actually in force on the containers use appcrane_check_resource_limits, and for live consumption read the host. Over-commitment is normal and is not by itself a fault (containers idle far below their ceilings) — it matters because it means there is no headroom guarantee, so a correlated event such as a post-reboot cold start, when every container loads at once, is resolved by the kernel\'s global OOM killer. Counts both stages of every app, which is exactly what a cold start brings up. ADMIN ONLY.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiredRole: 'admin',
    readOnly: true,
    handler: async () => {
      const { memoryBudget } = await import('./memoryBudget.js');
      const b = memoryBudget();
      const gb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
      const pct = Math.round(b.ratio * 100);

      // Every branch says "configured" before it says a number. An operator
      // skimming one line is the reader this is written for, and the one
      // misreading available is the one that turns a headroom report into a
      // phantom outage.
      const summary = b.over_committed
        ? `OVER-COMMITTED: ${b.app_count} app(s) have configured memory ceilings totalling ${gb(b.committed_mb)} ` +
          `on a host with ${gb(b.host_mb)} of RAM — ${pct}% of it. This is a sum of LIMITS, not a measurement: ` +
          'the host is almost certainly not using anywhere near that, because containers idle far below their ' +
          'ceilings. What it does mean is that there is no headroom guarantee — if enough containers claim their ' +
          'limit at the same time (a post-reboot cold start is the realistic case) the kernel resolves it with the ' +
          'global OOM killer, which picks the largest process and not the guilty one.'
        : `Configured memory ceilings total ${gb(b.committed_mb)} across ${b.app_count} app(s), within this host's ` +
          `${gb(b.host_mb)} of RAM (${pct}%), leaving ${gb(b.headroom_mb)} uncommitted. This is a sum of LIMITS, ` +
          'not a measurement of memory in use.';

      return {
        ...b,
        measures: 'configured per-container memory limits (docker --memory), summed across both stages of every app',
        does_not_measure: 'actual memory usage — nothing here reads a running container',
        summary,
      };
    },
  },
  // ── Hosted-app vulnerability scanning and platform policy (v2.52.0) ─────
  //
  // AppCrane has scanned its own dependency tree since v2.49.1 and has never
  // looked at the apps it hosts, whose lockfiles are already on disk at deploy
  // time. These tools make that scan — and the two platform levers beside it —
  // operable from an agent.
  //
  // Two properties are load-bearing, stated in every description here and
  // repeated in every payload, because an agent that misreads either does real
  // damage with it:
  //
  //   1. The scan REPORTS, it never blocks. These apps belong to other teams
  //      who did not choose this control and cannot fix a transitive advisory
  //      on someone else's schedule. A finding must never be relayed as a
  //      deploy failure, because no deploy has ever failed for one.
  //   2. 'skipped' and 'error' are NOT "no vulnerabilities". A missing lockfile
  //      and an unreachable OSV both leave a row with no findings on it, which
  //      reads exactly like a clean scan to anything that only counts findings.
  //      So `assurance` and `unscanned` travel beside the counts, and every
  //      summary names the missing coverage before it names a number.
  //
  // Each handler checks that `app_vuln_scans` exists before reading it, for the
  // same reason policyViolations() does: the table arrives with the scanner's
  // migration, an admin can call these on a box whose migrations have not
  // reached it, and a SQLITE_ERROR there would be indistinguishable from a
  // quiet fleet. No table means nothing has ever been scanned, and that is what
  // gets reported.
  {
    name: 'appcrane_scan_report',
    description:
      'Which hosted apps have known-vulnerable dependencies? Reports the recorded CVE scan state for the whole fleet, or for one app with `slug`. REPORT ONLY: this scan has never blocked a deploy and cannot — the apps belong to other teams who did not choose the control, so findings are recorded and mailed and the deploy proceeds either way. Never relay a finding as a deploy failure. READ `status` BEFORE READING COUNTS. It is four-valued: `ok` (scanned, nothing found) and `findings` (scanned, something found) are results; `skipped` (no lockfile AppCrane can read) and `error` (OSV unreachable, unparseable lockfile) mean the app was NOT SCANNED, as does having no scan row at all. Those two carry no findings for the same reason an unopened box is empty, and an agent that reports such an app as clean has stated the opposite of what is known — "no vulnerabilities found" is only ever true of an app whose status is `ok`. `assurance` (none / partial / complete), `unscanned_count` and `unscanned_by_status` say how much of the fleet the numbers actually cover; read them before the findings. EVERY FINDING CARRIES `ecosystem` AND `fixed` beside `name`, `version` and `ids`. `fixed` is the version that resolves those advisories, or null when OSV PUBLISHED NO FIXED VERSION — a null means there is nothing to upgrade to yet, NEVER that no fix is needed and never that AppCrane did not look, so a null-`fixed` finding is not a harmless one. `manifests_scanned` says WHICH manifests were actually read, because coverage is per manifest and not per app: one scan row reads ONE manifest — the ecosystem named on it — so an app whose Go service was never read appears here beside its scanned npm frontend with an empty findings list, and that emptiness is evidence about the frontend only. Scans run at deploy AND daily, and the daily run is the one that matters, because it catches an advisory published against code that was already deployed and has not changed since. ADMIN ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Report one app (both stages) instead of the whole fleet.' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    readOnly: true,
    handler: async (user, args) => {
      const db = getDb();
      const haveHistory = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_vuln_scans'"
      ).get();

      // A scan that COMPLETED is the only thing that counts as coverage, and
      // finding something is a completed scan. Everything else — skipped,
      // error, no row — goes in one bucket, because the distinction this tool
      // exists to hold open is scanned vs not, not which flavour of not.
      const isScanned = (r) => r?.status === 'ok' || r?.status === 'findings';
      const REPORT_ONLY = 'Report-only: a finding here has never blocked and cannot block a deploy.';

      if (args.slug) {
        const app = getAppForUser(user, args.slug);
        const scans = { production: null, sandbox: null };
        if (haveHistory) {
          const { latestScan } = await import('./appScan.js');
          for (const env of ['production', 'sandbox']) scans[env] = latestScan(db, app.id, env) ?? null;
        }
        const stages = ['production', 'sandbox'];
        for (const env of stages) {
          if (scans[env]) scans[env] = projectScanRow(scans[env], `${app.slug}/${env}`);
        }
        const unscanned = stages.filter((e) => !isScanned(scans[e]));
        const vulnerable = stages.filter((e) => scans[e]?.status === 'findings');
        const readManifests = stages.filter((e) => isScanned(scans[e]) && scans[e].manifest);
        return {
          app: app.slug,
          scans,
          scanned: unscanned.length === 0,
          unscanned,
          vulnerable_stages: vulnerable,
          manifests_scanned: [...new Set(readManifests.map((e) => scans[e].manifest))],
          manifests_by_stage: Object.fromEntries(stages.map((e) => [e, isScanned(scans[e]) ? scans[e].manifest : null])),
          assurance: unscanned.length === 2 ? 'none' : unscanned.length ? 'partial' : 'complete',
          enforcement: 'report-only',
          summary: [
            unscanned.length
              ? `NOT SCANNED: ${unscanned.map((e) => `${e} (${scans[e]?.status ?? 'no scan on record'})`).join(', ')}. ` +
                `Nothing is known about ${app.slug}'s dependencies in ${unscanned.length === 2 ? 'either stage' : 'that stage'} — ` +
                'that is an absence of evidence and must not be reported as a clean result. Use appcrane_scan_app to scan it now.'
              : null,
            vulnerable.length
              ? `Known-vulnerable dependencies in: ${vulnerable.join(', ')}.`
              : null,
            !unscanned.length && !vulnerable.length
              ? `Both stages of ${app.slug} were scanned and nothing was found.`
              : null,
            readManifests.length
              ? `Manifests read: ${readManifests.map((e) => `${e} (${scans[e].manifest})`).join(', ')}. ` +
                'Coverage is per manifest, not per app: any other manifest in the release — a go.mod, a ' +
                'requirements.txt, a second service\'s lockfile — was never read, so the findings above ' +
                'cover only the manifests named here.'
              : `No manifest was read in either stage, so no dependency of ${app.slug} has been looked at.`,
            REPORT_ONLY,
          ].filter(Boolean).join(' '),
        };
      }

      if (!haveHistory) {
        return {
          scanned: false,
          assurance: 'none',
          row_count: 0,
          unscanned_count: null,
          apps: [],
          enforcement: 'report-only',
          summary:
            'NEVER SCANNED — this deployment has no scan history at all, so there is nothing to report about any hosted app. ' +
            'This is NOT a clean fleet: no findings here means no evidence. Use appcrane_scan_app to scan one now; deploys ' +
            'and the daily job fill this in from then on.',
        };
      }

      const { fleetScanSummary } = await import('./appScan.js');
      // SECURITY: the ceiling has to hold on BOTH paths. callTool enforces
      // mcp_app_scope on `args.slug`, so the per-app branch above is covered —
      // but this branch takes no slug, and fleetScanSummary() is an unfiltered
      // SELECT over apps. Without this filter a key scoped to one app received
      // the slug, name, status and full findings list of every app on the
      // platform: other teams' CVE inventories, from a key explicitly denied
      // access to them. Same shape as the v2.42.1 note further up this file —
      // a ceiling that holds on one path and not another is not a ceiling.
      // appcrane_list_apps already routes through this helper; so does this now.
      const visible = new Set(accessibleSlugsForUser(user));
      const rows = fleetScanSummary(db)
        .filter((r) => visible.has(r.slug))
        .map((r) => projectScanRow(r, `${r.slug}/${r.env}`));
      const unscanned = rows.filter((r) => !isScanned(r));
      const vulnerable = rows.filter((r) => r.status === 'findings');
      const byStatus = {};
      for (const r of unscanned) {
        const k = r.status ?? 'no scan on record';
        byStatus[k] = (byStatus[k] ?? 0) + 1;
      }
      const manifests = {};
      for (const r of rows) {
        if (!isScanned(r)) continue;
        const m = r.manifest ?? 'unrecorded';
        manifests[m] = (manifests[m] ?? 0) + 1;
      }
      const manifestsRead = Object.entries(manifests);
      return {
        scanned: unscanned.length === 0,
        assurance: unscanned.length === 0 ? 'complete' : unscanned.length === rows.length ? 'none' : 'partial',
        row_count: rows.length,
        unscanned_count: unscanned.length,
        unscanned_by_status: byStatus,
        vulnerable_count: vulnerable.length,
        manifests_scanned: manifests,
        apps: rows,
        enforcement: 'report-only',
        summary: [
          unscanned.length
            ? `${unscanned.length} of ${rows.length} app/stage row(s) have NO usable scan result ` +
              `(${Object.entries(byStatus).map(([k, n]) => `${k}: ${n}`).join(', ')}). Those are UNKNOWN, not clean — ` +
              'their dependencies were never read, so the absence of findings beside them is the absence of a scan.'
            : `All ${rows.length} app/stage row(s) were scanned, so the findings below are the whole of what is known.`,
          vulnerable.length
            ? `${vulnerable.length} scanned row(s) have known-vulnerable dependencies.`
            : 'No scanned row has known-vulnerable dependencies.',
          manifestsRead.length
            ? `Manifests read: ${manifestsRead.map(([m, n]) => `${m}: ${n} row(s)`).join(', ')}. ` +
              'Coverage is per manifest, not per app: one row reads ONE manifest, so a go.mod or a ' +
              'requirements.txt beside a scanned lockfile was never read and cannot appear above.'
            : 'NO MANIFEST WAS READ in any row, so no dependency of any app here has been looked at.',
          REPORT_ONLY,
        ].join(' '),
      };
    },
  },
  {
    name: 'appcrane_scan_app',
    description:
      'Scan one app\'s dependencies against OSV right now and record the result, instead of waiting for its next deploy or the nightly run. Use it after fixing a lockfile to confirm a finding is gone, or on an app whose last result was `skipped` or `error` to find out what it actually contains. REPORT ONLY — it records a row and feeds the daily digest; it never blocks, fails or rolls back anything, and running it cannot disturb the app. It does not throw on a failed scan either: an unreachable OSV or a missing lockfile comes back as `ok: false` with status `error` or `skipped`, meaning the app was NOT scanned and is NOT known to be clean. `ok: true` with status `findings` is the opposite case — the scan worked and found something. Reads the LIVE release through the same `current` symlink the running container was built from. Defaults to the PRODUCTION stage: most AppCrane tools default to sandbox, but the code an advisory applies to is the code that is serving. ADMIN ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App to scan.' },
        env:  { type: 'string', enum: ['sandbox', 'production'], default: 'production', description: 'Stage to scan. Defaults to production — that is the deployed code an advisory applies to.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    requiredRole: 'admin',
    handler: async (user, args) => {
      const app = getAppForUser(user, args.slug);
      const env = args.env === 'sandbox' ? 'sandbox' : 'production';
      const db = getDb();
      const haveHistory = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_vuln_scans'"
      ).get();

      // Returned as a failed scan rather than thrown, for the same reason the
      // service records an 'error' row instead of throwing: "the scan did not
      // happen" is the answer to the question, and it is not the same answer
      // as "nothing was found".
      if (!haveHistory) {
        return {
          ok: false,
          app: app.slug,
          env,
          status: 'unavailable',
          error: 'This deployment has no scan history table yet, so a scan has nowhere to be recorded.',
          note: `${app.slug}/${env} was NOT scanned. This is not a clean result.`,
        };
      }

      const { scanApp } = await import('./appScan.js');
      // 'manual' rather than 'deploy' or 'scheduled': source exists to say what
      // a row is attributable to, and an on-demand scan is attributable to the
      // person who asked for it — not to a change, and not to the advisory feed.
      const row = await scanApp(db, app, env, 'manual');
      // Same projection the report uses: this is the other place a finding
      // reaches an agent, and handing back the raw row would leave the shape
      // unchecked on exactly the path that produced it.
      const scan = projectScanRow(row, `${app.slug}/${env}`);
      const ok = scan.status === 'ok' || scan.status === 'findings';
      return {
        ok,
        app: app.slug,
        env,
        scan,
        note: !ok
          ? `Status "${scan.status}" means ${app.slug}/${env} was NOT scanned — its dependencies were never read` +
            (scan.error ? ` (${scan.error})` : '') +
            ', so this result says nothing about whether it is vulnerable. Report-only either way: no deploy was affected.'
          : scan.status === 'findings'
            ? `Scanned ${scan.package_count} package(s) from the ${scan.manifest} manifest and found known-vulnerable dependencies. ` +
              'A finding with `fixed: null` has no published fix to upgrade to; it is not a harmless one. ' +
              'Report-only: nothing was blocked or rolled back.'
            : `Scanned ${scan.package_count} package(s) from the ${scan.manifest} manifest, nothing found — that covers ` +
              'that manifest only, not any other language in the release. Report-only: nothing was blocked or rolled back.',
      };
    },
  },
  {
    name: 'appcrane_platform_policy',
    description:
      'Read or set the two platform-wide policy levers, and list the apps currently in violation. `ban_public_apps` refuses visibility=public on every write path; `mandate_security_scans` reports every app without a completed scan in the last 48h. Both default OFF, so an upgrade enforces nothing until an admin turns one on. Call with no arguments to read the current policy plus violations; pass either boolean to change it. POLICY IS NOT RETROACTIVE: turning a lever on refuses the NEXT write and REPORTS what is already in violation — it does not reach into the database and change existing apps, and the violations it lists keep working exactly as they did. That is deliberate: silently making live public apps private would break their URLs with no warning to their owners and no record of what changed, so the list exists for an admin to work through deliberately. Never describe enabling a lever as having fixed the apps it reports; nothing about them has changed. PLATFORM ADMIN ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        ban_public_apps:        { type: 'boolean', description: 'Refuse visibility=public everywhere. Existing public apps keep serving and are reported as violations.' },
        mandate_security_scans: { type: 'boolean', description: 'Report every app with no completed dependency scan in the last 48h (two missed daily runs).' },
      },
      additionalProperties: false,
    },
    requiredRole: 'admin',
    handler: async (user, args) => {
      if (user.role !== 'platform_admin') {
        throw new Error('Only platform admins can read or change platform policy — it overrides what every app owner on this platform is allowed to set.');
      }
      const db = getDb();
      const { getPolicy, setPolicy, policyViolations } = await import('./platformPolicy.js');

      const patch = {};
      for (const k of ['ban_public_apps', 'mandate_security_scans']) {
        if (typeof args[k] === 'boolean') patch[k] = args[k];
      }
      const before = getPolicy(db);
      const changed = Object.keys(patch).filter((k) => before[k] !== patch[k]);
      const policy = Object.keys(patch).length ? setPolicy(db, patch, user.id) : before;
      const violations = policyViolations(db);
      const byPolicy = {};
      for (const v of violations) byPolicy[v.policy] = (byPolicy[v.policy] ?? 0) + 1;

      return {
        policy,
        changed_fields: changed,
        retroactive: false,
        violations,
        violation_count: violations.length,
        violations_by_policy: byPolicy,
        summary:
          (changed.length ? `Changed: ${changed.join(', ')}. ` : 'Read only — no lever was changed. ') +
          (violations.length
            ? `${violations.length} app(s) violate the policy as it now stands. They were NOT changed and keep working exactly as before — ` +
              'policy applies to the next write, never to rows already in the database. Each has to be converted deliberately by its owner or an admin.'
            : 'No app currently violates the policy.'),
      };
    },
  },

  // ── Managed databases (v2.64.0) ─────────────────────────────────────────
  //
  // 54 of the 64 catalogue entries need an external database and 503 without
  // one — linuxserver/bookstack's own docs open by saying so — which meant a
  // one-click install produced a blank page. The platform now runs ONE shared
  // Postgres and ONE shared MariaDB and hands each app its own database and its
  // own login inside them (server/services/managedDb.js).
  //
  // These two tools exist because an AGENT hits exactly the 503 a human does
  // and, until now, had no way out of it: the capability existed only on the
  // HTTP surface and in the dashboard. An agent that cannot provision can only
  // report the failure.
  //
  // TWO THINGS ARE NON-NEGOTIABLE HERE, and both are about the credential:
  //
  //   1. NO TOOL RETURNS THE PASSWORD. provision() resolves to the plaintext
  //      password AND a URL with it embedded — deliberately, because that is
  //      the deployer's input. A tool result is transcript; a transcript is
  //      forwarded, logged and pasted. Both handlers rebuild their response
  //      from listForApp(), which decrypts nothing, and the provision handler
  //      never binds provision()'s return value to a variable.
  //   2. NO ENGINE MESSAGE IS ECHOED. runAdminSql throws with the failing
  //      command's output, and the failing command is `CREATE ROLE … LOGIN
  //      PASSWORD '<pw>'`. Passing err.message through would be a straight line
  //      from "the database hiccuped" to "the password is in the transcript".
  //      Nothing logs it either — that would only move the leak to disk.
  {
    name: 'appcrane_provision_database',
    description:
      'Create a real managed database for an app: one dedicated database plus its own login inside the platform\'s shared Postgres or MariaDB server. '
      + 'Reach for this when an app 503s, restarts in a loop, or logs a connection error against a database nobody ever created — most catalogue apps '
      + '(BookStack, Ghost, Akaunting, Gitea and ~50 more) ship no database of their own and cannot boot without one. '
      + 'THIS CREATES REAL INFRASTRUCTURE: it starts the shared engine container if it is not already running, then creates a database and a login role that '
      + 'exist until somebody deletes them. Idempotent per app+engine — a second call returns the existing database rather than making another, and never rotates '
      + 'the password out from under a running container — so retrying after a timeout is safe. '
      + 'IT DOES NOT RETURN THE PASSWORD, and no AppCrane tool does. The credential is generated server-side, stored encrypted, and injected into the container\'s '
      + 'environment AT DEPLOY TIME under the variable names that app\'s own image reads. Do not ask for it, do not try to reconstruct it, and do not tell the user '
      + 'to paste it anywhere — no supported workflow needs a human or an agent to hold it. '
      + 'WHAT THIS DOES NOT DO: it does not restart or redeploy the app, so a container that is already running sees nothing change — call appcrane_deploy afterwards '
      + 'or the app will keep failing in exactly the same way. It does not create or migrate a schema; the app does that on its first successful boot. It does not '
      + 'delete anything, and deprovisioning is deliberately absent from the MCP surface — dropping a database is unrecoverable data loss and belongs to a human in '
      + 'the dashboard, not to an agent recovering from a 503. '
      + 'You must name the engine: pass the one the image documents (BookStack and most linuxserver.io images want mariadb; Postgres-native apps want postgres). '
      + 'Guessing wrong is not destructive but does not help either — it leaves an unused empty database and the app keeps 503ing. An app may hold one of each. '
      + 'ACCESS: requires an app-user assignment on that app, the same tier as env vars and backups. Being an AppCrane admin is NOT enough on its own — assign '
      + 'yourself with appcrane_grant_app_access first, which is the audited step the dashboard also requires.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug the database belongs to, e.g. "bookstack".' },
        engine: {
          type: 'string',
          enum: ['postgres', 'mariadb'],
          description: 'Which shared engine to create the database in. Required — an app may hold one of each, and this is not guessed for you.',
        },
      },
      required: ['slug', 'engine'],
      additionalProperties: false,
    },
    // 'any' rather than 'app_admin': the HTTP route this mirrors accepts any
    // ASSIGNED app user, and app_admin would hide the tool from exactly those
    // callers (they hold an app_users row, not an admin/owner role). The real
    // gate is requireAppUserTier in the handler, per-slug, which is stricter
    // than app_admin in the direction that matters — an unassigned platform
    // admin is refused.
    requiredRole: 'any',
    handler: async (user, args) => {
      const svc = await managedDbModule();
      const engine = String(args.engine || '').toLowerCase();
      // Validated against the engine's own list, not a copy of it — a second
      // allowlist in this file is a second thing to keep in sync with the
      // module that turns the string into container and SQL identifiers.
      if (!svc.SUPPORTED_ENGINES.includes(engine)) {
        throw new Error(`engine must be one of: ${svc.SUPPORTED_ENGINES.join(', ')} — got ${JSON.stringify(args.engine)}`);
      }

      const app = getAppForUser(user, args.slug);
      requireAppUserTier(user, app, 'provision a database for it');

      // tenant stays null: namesForScope() hashes a tenant into the database
      // and role names, but there is no authorization model for one yet, and a
      // tenant dimension without one is an IDOR with a nicer name. The HTTP
      // route refuses a client-supplied tenant for the same reason; here the
      // schema simply does not accept the field.
      const scope = { appId: app.id, tenant: null };
      try {
        // RETURN VALUE DELIBERATELY DISCARDED — never bind it. It resolves to
        // the plaintext password and a URL containing it.
        await svc.provision(scope, engine);
      } catch (err) {
        // Fixed text. See the note above the tool: err.message can carry the
        // CREATE ROLE statement, password included.
        throw new Error(
          `The managed database engine failed to provision a ${engine} database for ${app.slug}. `
          + 'The engine\'s own message is withheld deliberately: the statement that fails can contain the generated '
          + 'credential. An operator can read it in the server log. Nothing was left half-created — the engine rolls '
          + 'back its own row and role on failure — so this is safe to retry once the engine is healthy.'
        );
      }

      const databases = svc.listForApp(app.id).map((row) => publicManagedDbView(row, app));
      return {
        app: app.slug,
        database: databases.find((d) => d.engine === engine) || null,
        databases,
        next: `Ready, but the running container does not have it yet. Deploy ${app.slug} (appcrane_deploy) so the credential is injected into its environment.`,
        note: 'No password is returned here or anywhere else — it is stored encrypted and injected at deploy time.',
      };
    },
  },
  {
    name: 'appcrane_list_databases',
    description:
      'What managed databases an app already has: engine, database name, login name and when it was created. '
      + 'Call it before appcrane_provision_database so you do not ask for something that exists, and when debugging a database-related failure to settle which '
      + 'fault you are looking at — "this app has no database" and "this app has a database it cannot reach" are different problems with different fixes, and they '
      + 'look identical from the app\'s error message. '
      + 'AN EMPTY LIST IS AN ANSWER, NOT AN ERROR: it means no managed database has been provisioned, which is the correct and expected state for an app that '
      + 'brings its own database or needs none. Do not read it as a failure. '
      + 'NEVER returns a password, a connection URL, a host or a port — no AppCrane surface hands the credential out, because the deployer injects it into the '
      + 'container environment and nothing asks a human or an agent to hold it. What is here is identity, not access. '
      + 'It reports what AppCrane has on file; it does not connect to the engine, so it cannot tell you whether the server is up or whether the app\'s own '
      + 'connection is working. ACCESS: requires access to the app.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. "bookstack".' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    // The read mirrors the app-ACCESS tier of GET /api/apps/:slug/database, one
    // step below the write, exactly as backups.js grades its own pair: the
    // response is identifiers and no credential, so it is app info rather than
    // app secrets. getAppForUser is this file's app-access gate.
    requiredRole: 'any',
    readOnly: true,
    handler: async (user, args) => {
      const svc = await managedDbModule();
      const app = getAppForUser(user, args.slug);
      const databases = svc.listForApp(app.id).map((row) => publicManagedDbView(row, app));
      return {
        app: app.slug,
        count: databases.length,
        databases,
        engines: svc.SUPPORTED_ENGINES,
        note: databases.length
          ? 'Credentials are stored encrypted and injected into the container at deploy time; they are deliberately not returned here.'
          : `No managed database is provisioned for ${app.slug}. If it needs one, appcrane_provision_database creates it.`,
      };
    },
  },
];

/**
 * A managed_databases row as an agent may see it.
 *
 * Built field by field from an explicit list rather than by spreading the row,
 * for the same reason routes/managedDb.js publicView() is: listForApp() already
 * selects only non-secret columns, but this should not be the thing that breaks
 * if that SELECT ever becomes `SELECT *`. password_enc is one careless edit away
 * from a tool result.
 *
 * THERE IS NO PASSWORD FIELD AND NONE SHOULD BE ADDED, plaintext or encrypted.
 * Host and port are omitted for the same reason they are not needed: the deploy
 * injects them.
 */
function publicManagedDbView(row, app) {
  return {
    engine: row.engine,
    database: row.db_name,
    username: row.db_user,
    created_at: row.created_at,
    scope: { app: app.slug, tenant: row.tenant || null },
  };
}

// v2.11.0: AWS-friendly naming. The catalog the LLM sees presents the
// sandbox/production dimension as `stage` (Copilot/eb vocabulary) instead of
// `env`; callTool bridges `stage` back to the `env` handlers still read, so no
// handler or schema-literal changes are needed. One transform covers all 14
// env-taking tools, keeping the convention consistent from a single place.
function stageifySchema(schema) {
  if (!schema || !schema.properties || !schema.properties.env) return schema;
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    if (k === 'env') {
      properties.stage = { ...v, description: `${v.description ? v.description + ' ' : ''}Target stage (legacy alias: env).` };
    } else {
      properties[k] = v;
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.map((r) => (r === 'env' ? 'stage' : r))
    : schema.required;
  return { ...schema, properties, required };
}

// Old tool names kept working after the v2.11.0 rename so existing agents and
// saved scripts don't break — accepted on call, no longer advertised.
const TOOL_NAME_ALIASES = {
  appcrane_set_env:       'appcrane_set_secret',
  appcrane_get_env:       'appcrane_get_secret',
  appcrane_set_data_blob: 'appcrane_cp',
  appcrane_upload:        'appcrane_cp',
};

export function listTools(user, userMcpKey = null) {
  // v2.42.1: a key locked out by an empty scope gets an empty catalogue. The
  // lockout lived only in callTool, so such a key was refused every call while
  // tools/list still handed it the whole tool surface — an operator reading
  // "locked out" would see the key still answering.
  if (isMcpLockedOut(user)) return [];
  // Stash userMcpKey on user so canUseTool's helpers (and future custom checks)
  // can see it.
  const userView = userMcpKey ? { ...user, _mcpUserKey: userMcpKey } : user;
  // v2.44.0: a read-only key is advertised only the read tools. This mirrors
  // the callTool gate rather than replacing it — MCP clients cache the catalogue
  // at connect and callers may invoke a name they were never shown.
  const readOnlyKey = isReadOnlyKey(user, userMcpKey);
  return TOOLS.filter((t) => (!readOnlyKey || t.readOnly) && canUseTool(userView, t)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: stageifySchema(t.inputSchema),
  }));
}

export async function callTool(user, name, args, userMcpKey = null) {
  const canonicalName = TOOL_NAME_ALIASES[name] || name;
  const tool = TOOLS.find((t) => t.name === canonicalName);
  if (!tool) {
    auditMcpCall(user, name, args, new Error('unknown tool'));
    throw new Error(`Unknown tool: ${name}`);
  }
  // v2.44.0: the read-only gate runs before the role gate. It is a property of
  // the credential rather than of the caller's standing, so a read-only key
  // must hear "this key is read-only" whatever role its issuer holds — an
  // admin's read-only key is still read-only.
  try {
    assertToolAllowedForKey(user, tool, userMcpKey);
  } catch (err) {
    auditMcpCall(user, name, args, err);
    throw err;
  }
  if (!canUseTool(user, tool)) {
    const err = new Error(`Forbidden: tool ${name} requires ${tool.requiredRole}`);
    auditMcpCall(user, name, args, err);
    throw err;
  }
  // Reject keys with empty MCP scope outright (per-user mcp_scope override)
  const scope = mcpScope(user);
  if (scope && scope.length === 0) {
    const err = new Error('Forbidden: this key has an empty MCP scope (locked out)');
    auditMcpCall(user, name, args, err);
    throw err;
  }
  // v2.42.1 SECURITY: enforce the scope ceiling on the ARGUMENT, at the one
  // place every tool passes through, instead of trusting each handler to route
  // through getAppForUser(). Several do not: appcrane_update_app looks the app
  // row up itself, so a scoped key that was correctly refused READ access to an
  // app could still rewrite it — flip its visibility to public, add
  // auth_bypass_paths that disable SSO forward_auth, or rotate its GitHub PAT.
  // A ceiling that holds for reads and not for writes is not a ceiling.
  if (scope && typeof (args || {}).slug === 'string' && !scope.includes(args.slug)) {
    const err = new Error(`Forbidden: app ${args.slug} is outside this key's MCP scope`);
    auditMcpCall(user, name, args, err);
    throw err;
  }
  // Stash auth context on user so helpers (accessibleSlugsForUser,
  // getAppForUser) can constrain output.
  const userWithKey = userMcpKey ? { ...user, _mcpUserKey: userMcpKey } : user;
  // v2.11.0: 'stage' is the canonical sandbox/production param; bridge it to the
  // legacy 'env' the handlers still read (and vice-versa, so both callers work).
  const callArgs = { ...(args || {}) };
  if (callArgs.stage != null && callArgs.env == null) callArgs.env = callArgs.stage;
  else if (callArgs.env != null && callArgs.stage == null) callArgs.stage = callArgs.env;
  try {
    const result = await tool.handler(userWithKey, callArgs);
    auditMcpCall(user, name, args, null);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    auditMcpCall(user, name, args, err);
    throw err;
  }
}

function canUseTool(user, tool) {
  if (tool.requiredRole === 'admin') return isAdmin(user);
  // v2.7.0: app-creation tools gated by the configurable platform.create_app
  // permission — global admins always, plus any role a platform admin
  // granted at /settings#roles. Mirrors POST /api/apps.
  if (tool.requiredRole === 'create_app') return userHasPlatformPermission(user, 'platform.create_app');
  if (tool.requiredRole === 'app_admin') {
    if (isAdmin(user)) return true;
    // v2.7.1: also surface app_admin tools to anyone who can create apps.
    // Without this, a create_app holder connects owning zero apps → app_admin
    // tools (set_env, push_to_managed_app) are filtered out → they create a
    // managed app and become its owner, but the MCP client cached the tool
    // list at connect (server advertises tools.listChanged=false) and never
    // re-fetches, so the write tools never appear without a reconnect. They
    // WILL own what they create, so showing the tools up front is correct;
    // per-slug ownership is still enforced by getAppForUser/isAppAdmin in
    // each handler, so visibility never widens actual access.
    if (userHasPlatformPermission(user, 'platform.create_app')) return true;
    // Caller must be admin or owner of at least one app for this tool to even appear.
    // Per-slug authz still happens inside the handler when invoked.
    const db = getDb();
    const row = db.prepare(
      `SELECT 1 FROM app_user_roles WHERE user_id = ? AND app_role IN ('admin', 'owner') LIMIT 1`
    ).get(user.id);
    return !!row;
  }
  return true;
}

export function getToolCatalog() {
  // For the admin /mcp page — expose tool metadata without auth filtering
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: stageifySchema(t.inputSchema),
    requiredRole: t.requiredRole,
    readOnly: !!t.readOnly,
  }));
}
