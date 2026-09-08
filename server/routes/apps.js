import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin, requireAppAccess } from '../middleware/auth.js';
import { auditMiddleware, logAudit } from '../middleware/audit.js';
import { getNextSlot, getPortsForSlot } from '../services/portAllocator.js';
import { encrypt, generateApiKey, hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import { resolveSafe } from '../utils/paths.js';
import { reloadCaddy } from '../services/caddy.js';
import { validateBypassPaths } from '../utils/authBypassPaths.js';
import { ingressDrift } from '../services/ingressDrift.js';
import { resolveVisibility } from '../utils/appVisibility.js';
import {
  getPolicy, setPolicy, assertVisibilityAllowed, policyViolations,
} from '../services/platformPolicy.js';
import { pruneGrantsForNonMembers } from '../services/appDefinedRoles.js';
import { assessMemoryChange } from '../services/memoryBudget.js';
import {
  effectiveIngressType, publicPortForApp, pendingPortRelease, validateIngressType,
  assignPublicPort, releasePublicPort, drainingPorts, effectiveDataPlanePort, validateDataPlanePort, CONTROL_PLANE_PORT,
} from '../services/tcpIngress.js';

// v2.42.0: ingress_type and public_port are REPORTED on every app payload, not
// merely accepted on write. auth_mode spent three versions write-only and that
// blind spot is what made "my app gets no identity headers" a recurring
// triage; a port published straight to the host is a bigger thing for an
// operator to be unable to see. public_port reads back as null on an http app
// even if a stale value survives in the column, because that is what the
// runtime does with it.
//
// SECURITY: `canSeePort` exists for GET /api/apps, which lists every app on the
// platform to every authenticated user — including apps whose detail route
// answers that caller 403. The pre-existing `ports` field is already withheld
// there unless the caller is an admin, and those are slot-derived LOOPBACK
// ports; public_port is the port that is reachable with no authentication at
// all, so it cannot be less guarded than the ports that aren't. Handing it out
// on the catalog would turn "there is a private app I can't reach" into "here
// is the unauthenticated port for that private app". ingress_type stays
// visible — knowing an app is layer-4 is not the same as being told where.
// Every other caller of this helper is already behind requireAppAccess.
//
// pending_port_release is the same secret and is withheld on the same terms: it
// is a port that may STILL be answering on the host, which is if anything the
// more useful number to an attacker of the two. It is reported separately from
// public_port rather than folded into it because the two facts are genuinely
// different — AppCrane publishes nothing for this app any more (public_port
// null, and the next `docker run` will carry no public -p), yet the container
// that is running right now still binds the port. Reporting only public_port
// would tell an operator a port is closed while it is open.
//
// v2.45.0: data_plane_port joins them on the same terms. It is the CONTAINER
// side of a dual app's publish, so on its own it reaches nothing — but it is
// half of "0.0.0.0:<public_port> goes to <data_plane_port>", and withholding
// the pair together is simpler to reason about than deciding which half is the
// secret. Reported EFFECTIVE, so a number left over from a previous dual
// configuration reads as null on an app that is no longer dual.
//
// v2.45.3: `observed` carries what the RUNNING container actually binds, so a
// reader can tell a configured publish from a live one. Everything above this
// point is the app ROW — intent — and a port publish is a `docker run` flag, so
// setting ingress on a running app changes the row and nothing else until the
// container is recreated. Reporting intent as fact is what turned a stale
// container into an afternoon of firewall and VPN debugging.
//
// Optional, and `undefined` when not supplied rather than `false`: a caller that
// did not look must not be made to say the port is closed. Gated behind the same
// canSeePort check as the ports themselves — the drift message names them.
//
// v2.47.0: `draining` is the list of ports this app still has RESERVED but no
// longer publishes — a number a running container is bound to after a re-pin,
// held so nobody else can be given it and released on the next recreate.
// Reported so no surface ever calls a port closed while it answers.
//
// Passed in rather than queried here: this helper runs once per app on the
// catalog endpoint, and a lookup inside it would be one query per app.
function ingressFields(app, canSeePort = true, observed = undefined, draining = undefined) {
  const drift = canSeePort && observed !== undefined ? ingressDrift(app, observed) : null;
  return {
    ingress_type: effectiveIngressType(app.ingress_type),
    public_port: canSeePort ? publicPortForApp(app) : undefined,
    // v2.46.0. Reported on the same terms as public_port — it is the other
    // unauthenticated door, so it cannot be less guarded than the one that is
    // already withheld from the catalog for callers without access.
    sandbox_public_port: canSeePort ? publicPortForApp(app, 'sandbox') : undefined,
    data_plane_port: canSeePort ? effectiveDataPlanePort(app) : undefined,
    pending_port_release: canSeePort ? pendingPortRelease(app) : undefined,
    ...(drift ? { publish_applied: drift.applied, publish_drift: drift.drift } : {}),
    ...(canSeePort && draining !== undefined && draining.length
      ? { draining_ports: draining }
      : {}),
  };
}

/** Every draining row on the platform, grouped by app — ONE query for the catalog. */
function drainingByApp(db) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT app_id, host_port, env FROM app_host_ports WHERE state = 'draining' ORDER BY host_port"
  ).all()) {
    if (!out.has(r.app_id)) out.set(r.app_id, []);
    out.get(r.app_id).push({ host_port: r.host_port, env: r.env });
  }
  return out;
}

// The before/after shape of the 'app-ingress-change' audit entry — the same
// three facts every read surface reports, so a log entry and a GET can be
// compared without translating between them.
function ingressAudit(row) {
  return {
    ingress_type: effectiveIngressType(row.ingress_type),
    public_port: publicPortForApp(row),
    sandbox_public_port: publicPortForApp(row, 'sandbox'),
    data_plane_port: effectiveDataPlanePort(row),
    pending_port_release: pendingPortRelease(row),
  };
}

// auth_bypass_paths is stored as a JSON string (or NULL). The UI expects an
// array, so always parse it before returning an app row — a raw string would
// crash the dashboard's `.join()` (bug: v2.7.27 added the column but several
// serialization points returned it unparsed).
function parseBypassPathsField(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// auth_mode was settable but never returned — write-only config, so nobody
// could see which mode an app was in. That blind spot is the root of the
// recurring "my app receives no X-AppCrane-* identity headers" triage, since a
// headless app skips forward_auth entirely and never gets identity by design.
//
// Report the EFFECTIVE mode rather than the raw column: the value is not
// validated on write, so a legacy or hand-edited row can hold something like
// 'forward_auth', which caddy.js treats as authenticated. Mirroring caddy.js
// (only the literal 'headless' bypasses forward_auth) keeps the answer the API
// gives identical to the behaviour the proxy actually implements.
function effectiveAuthMode(raw) {
  return raw === 'headless' ? 'headless' : 'authenticated';
}
import { userHasAppPermission, userHasPlatformPermission, roleForUserOnApp } from '../services/permissions.js';
import { isAdmin } from '../utils/roles.js';
import log from '../utils/logger.js';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { reconcileOrphanedApps } from '../services/reconcile.js';
import { parseImageRef } from '../services/imageSource.js';

const router = Router();

// Owners we know can't be real GitHub accounts. Catches the placeholder
// patterns (e.g. github.com/local/foo) the 2026-05-02 triage flagged on
// `healthchampion`.
const PLACEHOLDER_GH_OWNERS = new Set([
  'local', 'localhost', 'example', 'test', 'placeholder', 'todo', 'tbd', 'unknown',
]);

function validateGithubUrl(url) {
  if (!/^https:\/\//.test(url)) {
    throw new AppError('github_url must use HTTPS', 400, 'VALIDATION');
  }
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/);
  if (!m) {
    throw new AppError('github_url must look like https://github.com/owner/repo[.git]', 400, 'VALIDATION');
  }
  if (PLACEHOLDER_GH_OWNERS.has(m[1].toLowerCase())) {
    throw new AppError(
      `github_url owner "${m[1]}" looks like a placeholder — use the real GitHub repo URL`,
      400, 'VALIDATION',
    );
  }
}

// The three fields a source_type='image' app has and no other kind does.
//
// image_ref is to an image app what github_url + branch + a build are to a git
// app: the whole of what will run. It is validated here, at the write boundary,
// so the value sitting in apps.image_ref is safe no matter which surface reads
// it later — not only the argv-based callers in services/imageSource.js.
//
// The grammar is NOT reimplemented. parseImageRef transcribes Docker's own
// reference rules, including the part every hand-rolled split gets wrong (the
// ':' in 'localhost:5000/odoo' is a port, the ':' in 'odoo:19' is a tag). A
// second regex in this file would be the one that drifts.
function validateImageRef(ref) {
  let parsed;
  try {
    parsed = parseImageRef(ref);
  } catch (e) {
    throw new AppError(`image_ref is not a valid image reference: ${e.message}`, 400, 'VALIDATION');
  }

  // v1 refuses a reference where the operator named no version at all — a bare
  // name ('odoo', which Docker resolves as ':latest') or an explicit ':latest'.
  //
  // The reason is what AppCrane records. A deploy resolves the reference to a
  // digest and stores it on the deployment as the release's identity; against a
  // tag the publisher republishes at will, that digest stops describing what
  // 'odoo:latest' means about ten minutes later, and a rollback to that
  // deployment restores something else under the recorded identity.
  //
  // An explicit tag is not immutable either — this is not pretending otherwise.
  // It is the line where the operator has stated WHICH release they meant, so a
  // history of digests against 'odoo:19' reads as patch releases of one version
  // rather than as an unexplained sequence. A digest is the real pin, and is
  // accepted with or without a tag beside it.
  if (!parsed.digest && (parsed.tag === null || parsed.tag === 'latest')) {
    const why = parsed.tag === null
      ? 'it has no tag, so Docker resolves it as :latest'
      : ':latest points at a different image whenever the publisher pushes';
    throw new AppError(
      `image_ref "${ref}" is not pinned — ${why}. Give an explicit tag (odoo:19) or a digest ` +
      '(odoo@sha256:<64 hex>); AppCrane records the resolved digest as the deployment\'s identity, ' +
      'and against a moving tag that record is wrong as soon as upstream moves.',
      400, 'VALIDATION',
    );
  }
  return parsed;
}

// NULL means the 3000 default AppCrane's own builds listen on. A third-party
// image has no reason to agree (odoo is 8069, nginx is 80), and a wrong number
// here is an app that starts and answers nothing.
//
// typeof-guarded before Number(): Number(true) is 1, which is a valid port, so
// a `container_port: true` would otherwise be stored as port 1 rather than
// refused.
function validateContainerPort(port) {
  if (typeof port !== 'number' && typeof port !== 'string') {
    throw new AppError('container_port must be an integer between 1 and 65535', 400, 'VALIDATION');
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new AppError('container_port must be an integer between 1 and 65535', 400, 'VALIDATION');
  }
  return n;
}

// NULL means /api/health, again the AppCrane-built default. A stock image does
// not serve that path, and a health check against a 404 reports a working app
// as unhealthy.
//
// The value is appended to a URL by the health checker, so whitespace and
// control characters are refused at the boundary rather than left to whichever
// URL builder sees it first.
function validateHealthPath(p) {
  if (typeof p !== 'string') {
    throw new AppError("health_path must be a string starting with '/'", 400, 'VALIDATION');
  }
  const v = p.trim();
  if (!v.startsWith('/')) {
    throw new AppError(`health_path must start with '/' — got "${p}"`, 400, 'VALIDATION');
  }
  if (v.length > 512) {
    throw new AppError('health_path is too long (max 512 chars)', 400, 'VALIDATION');
  }
  for (const ch of v) {
    const code = ch.codePointAt(0);
    if (code <= 0x20 || code === 0x7f) {
      throw new AppError('health_path contains whitespace or control characters', 400, 'VALIDATION');
    }
  }
  return v;
}

// catalog_slug — the app's link back to the entry in
// server/services/appCatalog.json it was installed from (migration 086).
//
// WHY IT IS VALIDATED AT ALL. This is a client-supplied string whose only job
// is to be looked up in a manifest, and the deployer will read that entry's
// `needs` block to decide WHICH ENV VAR NAMES a managed database credential is
// injected under. So the value selects a set of variable names on a live
// container. An unconstrained string here is a lookup key an attacker chooses.
//
// THE SHAPE IS THE MANIFEST'S OWN. Every one of the 64 entries in
// appCatalog.json matches /^[a-z0-9][a-z0-9-]*$/, longest 16 chars; the bound
// below is 64, generous against future entries without being unbounded.
// Consequences worth naming explicitly:
//   - no '_', so '__proto__' cannot be stored;
//   - no '/', '.' or whitespace, so the value cannot be a path, a traversal, or
//     a shell word if it ever reaches one.
//
// 'constructor' is refused by name, and it is the ONLY name that needs to be.
// Every other member of Object.prototype is camelCase (toString, valueOf,
// hasOwnProperty, ...) and so is already rejected by the lowercase-only shape;
// 'constructor' is the single one that survives it. It matters because a reader
// that indexes the catalogue as a plain object — `byslug[app.catalog_slug]` —
// gets a truthy function back for that key and believes it found an entry. The
// manifest is an array today and a .find() over it is immune, but the value is
// stored for OTHER modules to look up, and one word here costs nothing.
//
// EXISTENCE IN THE MANIFEST IS NOT CHECKED, deliberately. Entries come and go
// between releases, and an app installed from an entry that is later removed
// must keep working — a slug that resolves to nothing degrades to "inject
// nothing", which is the safe direction. Refusing at write time would trade
// that for app creation failing on catalogue drift, and would not make the
// stored value any safer than the shape check already does.
function validateCatalogSlug(v) {
  if (typeof v !== 'string' || v === 'constructor' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) {
    throw new AppError(
      'catalog_slug must be a catalogue entry slug: lowercase letters, digits and dashes, ' +
      "starting with a letter or digit (max 64 chars) — e.g. 'bookstack'",
      400, 'VALIDATION',
    );
  }
  return v;
}

/**
 * Returns a list of apps whose github_url is missing, malformed, or uses a
 * known placeholder owner. Used by the admin triage page to surface rows
 * that slipped past validation in earlier versions of this service.
 */
function listSuspiciousGithubUrls() {
  const db = getDb();
  const rows = db.prepare('SELECT id, slug, name, github_url FROM apps').all();
  return rows.filter(r => {
    const u = r.github_url;
    if (!u) return false; // empty is OK — app simply has no repo
    try { validateGithubUrl(u); return false; } catch { return true; }
  });
}

const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
function hasIconFile(slug) {
  const dir = join(process.env.DATA_DIR || './data', 'apps', slug);
  return ICON_EXTS.some(ext => existsSync(join(dir, `icon.${ext}`)));
}

router.use(requireAuth);

/**
 * GET /api/apps - List apps.
 *
 * v2.6.7: visibility rules:
 *   - admin / platform_admin → every app
 *   - other authed users     → every app EXCEPT visibility='hidden'.
 *                              That's both the apps they have a role on
 *                              and the ones they don't — the latter
 *                              render as "Request access" tiles in the
 *                              Launcher. Public apps openable for all,
 *                              private apps openable only if the user
 *                              has an explicit role row
 *
 * The previous query only returned assigned apps, which meant a brand-
 * new user with no assignments saw an empty Launcher and no way to
 * discover what was available. Per the user direction: "if user is
 * able to access the system he should see discoverable apps (to request
 * access), public apps, private apps that he is user or an admin."
 *
 * Hidden apps still stay invisible to non-admins.
 */
router.get('/', async (req, res) => {
  const db = getDb();
  let apps;

  if (isAdmin(req.user)) {
    apps = db.prepare('SELECT * FROM apps ORDER BY created_at DESC').all();
  } else {
    apps = db.prepare(`
      SELECT a.* FROM apps a
      WHERE a.visibility != 'hidden'
      ORDER BY a.created_at DESC
    `).all();
  }

  // v2.6.7: per-user role on every returned app, so the Launcher can
  // decide whether the user can open the app or needs to request
  // access. Batch-fetched up front to avoid N+1 query per app row.
  // For admins, role is implicitly 'admin' on every app via the global
  // gate — we still surface it so the SPA doesn't have to special-case.
  // v2.45.3: one `docker ps` for the whole catalog, cached for a few seconds and
  // invalidated whenever a container is created or destroyed. Per-app inspects
  // here would put one subprocess spawn per app on the platform's hottest
  // endpoint — the same cost shape that made Settings slow.
  const { publishedPortsBySlug } = await import('../services/docker.js');
  const observedBySlug = await publishedPortsBySlug();
  const drainingMap = drainingByApp(db);

  const userRolesBySlug = new Map();
  if (!isAdmin(req.user)) {
    const rows = db.prepare(`
      SELECT a.slug, aur.app_role
      FROM app_user_roles aur
      JOIN apps a ON a.id = aur.app_id
      WHERE aur.user_id = ?
    `).all(req.user.id);
    for (const r of rows) userRolesBySlug.set(r.slug, r.app_role);
  }
  function userAppRole(app) {
    if (isAdmin(req.user)) return 'admin';                       // global admins everywhere
    const explicit = userRolesBySlug.get(app.slug);
    if (explicit && explicit !== 'none') return explicit;         // 'user' / 'admin' / 'owner'
    if (app.visibility === 'public') return 'viewer';             // public apps openable by anyone
    return 'none';                                                 // discoverable: needs request access
  }

  // Enrich with ports and health status
  const enriched = apps.map(app => {
    const ports = getPortsForSlot(app.slot);

    const healthProd = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'production');
    const healthSand = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');

    const lastDeployProd = db.prepare(
      'SELECT version, status, finished_at FROM deployments WHERE app_id = ? AND env = ? ORDER BY started_at DESC LIMIT 1'
    ).get(app.id, 'production');
    const lastDeploySand = db.prepare(
      'SELECT version, status, finished_at FROM deployments WHERE app_id = ? AND env = ? ORDER BY started_at DESC LIMIT 1'
    ).get(app.id, 'sandbox');

    // Get assigned users
    const users = db.prepare(`
      SELECT u.id, u.name, u.email FROM users u
      JOIN app_users au ON u.id = au.user_id
      WHERE au.app_id = ?
    `).all(app.id);

    // The app's owners. Usually one, but multiple are allowed — v2.21.0
    // returns them all (`owners`); `owner` stays as the first for back-compat.
    // Empty when the owner record was never created (e.g. apps from before
    // migration 048 fixed the latent CHECK bug, or apps whose creator was
    // deleted leaving created_by NULL).
    const ownerRows = db.prepare(`
      SELECT u.id, u.name, u.email FROM users u
      JOIN app_user_roles aur ON aur.user_id = u.id
      WHERE aur.app_id = ? AND aur.app_role = 'owner'
      ORDER BY u.id
    `).all(app.id);

    const craneDomain = process.env.CRANE_DOMAIN;
    const urls = craneDomain ? {
      production: `https://${craneDomain}/${app.slug}`,
      sandbox: `https://${craneDomain}/${app.slug}-sandbox`,
    } : null;

    return {
      ...app,
      resource_limits: JSON.parse(app.resource_limits || '{}'),
      auth_bypass_paths: parseBypassPathsField(app.auth_bypass_paths),
      auth_mode: effectiveAuthMode(app.auth_mode),
      ...ingressFields(app, userAppRole(app) !== 'none',
        observedBySlug ? (observedBySlug.get(`${app.slug}:production`) ?? null) : null,
        drainingMap.get(app.id) ?? []),
      has_icon: hasIconFile(app.slug),
      // Boolean flags derived from secret-bearing columns so the UI can
      // show "this app has its own X" without ever shipping the secret.
      has_claude_credentials: !!app.claude_credentials_encrypted,
      has_github_token:       !!app.github_token_encrypted,
      // v2.6.7: per-user role on this app from the caller's perspective.
      // 'admin' / 'owner' / 'user' / 'viewer' / 'none'.
      app_role: userAppRole(app),
      ...(isAdmin(req.user) ? { ports } : {}),
      owner: ownerRows[0] || null,
      owners: ownerRows,
      urls,
      base_path: { production: `/${app.slug}/`, sandbox: `/${app.slug}-sandbox/` },
      production: {
        health: healthProd ? { status: healthProd.is_down ? 'down' : (healthProd.last_status === 200 ? 'healthy' : 'unknown'), last_check: healthProd.last_check_at, response_ms: healthProd.last_response_ms } : { status: 'unknown' },
        deploy: lastDeployProd || null,
      },
      sandbox: {
        health: healthSand ? { status: healthSand.is_down ? 'down' : (healthSand.last_status === 200 ? 'healthy' : 'unknown'), last_check: healthSand.last_check_at, response_ms: healthSand.last_response_ms } : { status: 'unknown' },
        deploy: lastDeploySand || null,
      },
      users,
      // v2.24.4: old domains that 301-redirect to this app's primary domain.
      domain_aliases: db.prepare('SELECT id, domain, source, created_at FROM app_domain_aliases WHERE app_id = ? ORDER BY created_at, id').all(app.id),
    };
  });

  res.json({ apps: enriched });
});

/**
 * POST /api/apps - Create app (any authenticated user, auto-assigns creator)
 */
router.post('/', requireAuth, auditMiddleware('app-create'), async (req, res) => {
  // v2.7.0: app creation is gated by the configurable platform.create_app
  // permission instead of plain requireAuth. Global admins always pass;
  // plain users pass only if a platform admin granted the `user` tier at
  // /settings#roles. Closes the old gap where any authenticated key could
  // create apps via the API while the dashboard button was admin-only.
  if (!userHasPlatformPermission(req.user, 'platform.create_app')) {
    throw new AppError('You do not have permission to create apps.', 403, 'FORBIDDEN');
  }

  const { name, slug, domain, description, category, source_type, github_url, branch, github_token, max_ram_mb, max_cpu_percent, visibility, public_access, image_ref, container_port, health_path, catalog_slug } = req.body;

  if (!name || !slug) throw new AppError('Name and slug are required', 400, 'VALIDATION');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new AppError('Slug must be lowercase alphanumeric with dashes', 400, 'VALIDATION');
  if (github_url) validateGithubUrl(github_url);
  // SECURITY: same regex as PUT — branch flows into `sh -c` calls.
  if (branch && !/^[A-Za-z0-9._/\-]{1,200}$/.test(branch)) {
    throw new AppError('branch must be alphanumeric with . _ / - (max 200 chars)', 400, 'VALIDATION');
  }
  // v2.3.1: 'upload' is dead. Only 'github' (user/external repo) and
  // 'managed' (service-account-owned repo) are valid for new apps.
  // 'managed_legacy' is the deprecation marker for existing upload apps;
  // it can't be set via API.
  // v2.53.0: 'upload' is a deliberate mode again, not the deprecated
  // 'managed_legacy' marker. v2.3.1 removed it because an uploaded release had
  // no provenance — commit_hash was whatever the uploader typed, or 'unknown'.
  // That objection is answered rather than reversed: an upload now records a
  // SHA-256 over the bytes received (services/artifactDigest.js), so the release
  // has an identity AppCrane computed instead of one it was handed.
  //
  // Kept distinct from 'managed' on purpose. An upload-only app has no repo, and
  // conflating the two leaves every surface unable to tell "deliberately
  // upload-only" from "repo not configured yet" — the second reads as broken.
  //
  // v2.59.0: 'image' deploys a prebuilt image instead of building one. The
  // other three source types all end in the same place — AppCrane holds a tree
  // of files and builds an image out of it — and this one skips the build
  // entirely, so the app carries three facts none of the others has
  // (image_ref / container_port / health_path, migration 083).
  const VALID_SOURCE_TYPES = new Set(['github', 'managed', 'upload', 'image']);
  if (source_type && !VALID_SOURCE_TYPES.has(source_type)) {
    throw new AppError(
      `source_type must be one of ${[...VALID_SOURCE_TYPES].map(t => `'${t}'`).join(', ')} — ` +
      `'${source_type}' is not supported`,
      400, 'VALIDATION',
    );
  }

  // An image app with no image_ref names nothing to run. Refused here rather
  // than at deploy time: the app would be created, look ordinary on every
  // surface, and fail on the first deploy with an error about a column instead
  // of about the field the operator did not fill in.
  if (source_type === 'image' && !image_ref) {
    throw new AppError(
      "source_type 'image' requires image_ref — the image to run, e.g. 'odoo:19' or " +
      "'ghcr.io/owner/app@sha256:<64 hex>'",
      400, 'VALIDATION',
    );
  }
  // Validated whenever supplied, not only when source_type is 'image'. The
  // check is on the VALUE, and a ref that is unsafe or unpinned is just as
  // unsafe sitting on a row whose source_type changes to 'image' later.
  //
  // Deliberately NOT carried on github_url. That column is validated by
  // validateGithubUrl (which rejects every image reference there is) and
  // deployer.js branches on it being truthy, so an image ref smuggled through
  // it would select the git path with a nonsense URL.
  let imageRefValue = null;
  if (image_ref !== undefined && image_ref !== null && image_ref !== '') {
    validateImageRef(image_ref);
    imageRefValue = String(image_ref).trim();
  }
  const containerPortValue = container_port === undefined || container_port === null
    ? null
    : validateContainerPort(container_port);
  const healthPathValue = health_path === undefined || health_path === null || health_path === ''
    ? null
    : validateHealthPath(health_path);

  // v2.65.0: the catalogue link. Set once, at install, and never again — there
  // is deliberately no catalog_slug branch in PUT below, and the field is
  // absent from that route's destructuring so a later edit cannot introduce one
  // by accident. This is the same reasoning that ruled out matching an app back
  // to its catalogue entry by github_url or image_ref: those are editable, and
  // repointing one would repoint which entry's env var names a database
  // credential is injected under. An immutable link cannot be steered.
  //
  // Empty string and null both mean "not from the catalogue" and store NULL;
  // anything else must be a real slug shape or the request is refused, rather
  // than a junk value being written for the deployer to look up later.
  const catalogSlugValue = catalog_slug === undefined || catalog_slug === null || catalog_slug === ''
    ? null
    : validateCatalogSlug(catalog_slug);

  const db = getDb();

  // v2.52.0: the platform policy gate, on CREATE as well as on PUT. A policy
  // enforced on one of the two write paths is not a policy — an owner refused
  // at PUT would simply pass the field to POST instead.
  //
  // This route does not persist visibility (the column takes its 'private'
  // default and a later PUT sets it), so the assert catches a request that ASKS
  // for a public app rather than one that makes one. Refusing beats the silent
  // drop: a caller that sent visibility='public' and got a 201 believes the app
  // is public, and under a ban that is the one belief nobody should be left with.
  let wantedVisibility;
  try { wantedVisibility = resolveVisibility({ visibility, public_access }).visibility; }
  catch { /* An unparseable value was ignored here before the policy existed and
             still is. Turning it into a 400 now would make a lever that is OFF
             change what this route does, which is the one thing it must not. */ }
  if (wantedVisibility !== undefined) assertVisibilityAllowed(db, wantedVisibility);

  // Check uniqueness
  if (db.prepare('SELECT id FROM apps WHERE slug = ?').get(slug)) {
    throw new AppError(`App slug '${slug}' already exists`, 409, 'DUPLICATE');
  }

  const slot = getNextSlot(db);
  const ports = getPortsForSlot(slot);
  // v2.21.5: only platform admins pick CPU/memory. A non-platform-admin
  // creating an app gets the defaults regardless of what they pass.
  const platAdmin = req.user.role === 'platform_admin';
  const resourceLimits = JSON.stringify({
    max_ram_mb: (platAdmin && max_ram_mb) || 512,
    max_cpu_percent: (platAdmin && max_cpu_percent) || 50,
  });

  const tokenEncrypted = github_token ? encrypt(github_token) : null;

  // domain is a custom override only — routing uses CRANE_DOMAIN/slug by default
  const appDomain = domain || null;

  const result = db.prepare(`
    INSERT INTO apps (name, slug, slot, domain, description, category, source_type, github_url, branch, github_token_encrypted, resource_limits, created_by, image_ref, container_port, health_path, catalog_slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, slug, slot, appDomain, description || null, category || null, source_type || 'github', github_url || null, branch || 'main', tokenEncrypted, resourceLimits, req.user.id, imageRefValue, containerPortValue, healthPathValue, catalogSlugValue);

  const appId = result.lastInsertRowid;

  // Create health configs for both envs
  for (const env of ['production', 'sandbox']) {
    db.prepare('INSERT INTO health_configs (app_id, env) VALUES (?, ?)').run(appId, env);
    db.prepare('INSERT INTO health_state (app_id, env) VALUES (?, ?)').run(appId, env);
  }

  // Auto-assign creator to the app — both as a member (app_users) and as
  // the owner (app_user_roles). Two tables because they predate each other:
  // - app_users: bare "this user has access" rows
  // - app_user_roles: per-app role (none/user/admin/owner)
  // Forgetting the second was the v2.5.12 "⚠ No owner" bug — apps would
  // be created without anyone to administer them per-app, and only global
  // admins could touch them. Both inserts are idempotent (INSERT OR IGNORE
  // / ON CONFLICT) so re-running this code path is safe.
  db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)').run(appId, req.user.id);
  db.prepare(`
    INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, 'owner')
    ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = 'owner'
  `).run(appId, req.user.id);

  // Create webhook config
  const webhookToken = crypto.randomBytes(16).toString('hex');
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO webhook_configs (app_id, token, secret) VALUES (?, ?, ?)').run(appId, webhookToken, webhookSecret);

  // Create app directories
  const dataDir = process.env.DATA_DIR || './data';
  const appDir = join(dataDir, 'apps', slug);
  for (const env of ['production', 'sandbox']) {
    const envDir = join(appDir, env);
    mkdirSync(join(envDir, 'releases'), { recursive: true });
    mkdirSync(join(envDir, 'shared', 'data'), { recursive: true });
  }

  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);

  // Update Caddy reverse proxy config
  const caddyResult = await reloadCaddy();
  if (!caddyResult.success) {
    log.warn(`Caddy reload failed after app create: ${caddyResult.error}`);
  }

  // Start health checks for the new app
  try {
    const { refreshAppChecks } = await import('../services/healthChecker.js');
    refreshAppChecks(appId);
  } catch (e) {}

  const craneDomain = process.env.CRANE_DOMAIN;
  const urls = craneDomain ? {
    production: `https://${craneDomain}/${slug}`,
    sandbox: `https://${craneDomain}/${slug}-sandbox`,
  } : null;

  res.status(201).json({
    app: { ...app, resource_limits: JSON.parse(app.resource_limits), auth_bypass_paths: parseBypassPathsField(app.auth_bypass_paths), auth_mode: effectiveAuthMode(app.auth_mode), ...ingressFields(app) },
    urls,
    base_path: { production: `/${slug}/`, sandbox: `/${slug}-sandbox/` },
    webhook_url: `/api/webhooks/${webhookToken}`,
    message: `App '${name}' created. Assign users with PUT /api/apps/${slug}/users`,
  });
});

/**
 * GET /api/apps/platform-policy — the two platform levers plus the apps that
 * violate them right now. PUT to change them. Platform admin only.
 *
 * Registered ABOVE `/:slug` on purpose: Express matches in registration order,
 * so the parameterised app route would otherwise swallow this path (and answer
 * 404/403 for a policy read) if an app were ever slugged 'platform-policy'.
 *
 * Platform admin, matching the ingress gate in PUT below rather than plain
 * requireAdmin: a tier-2 global admin administers apps, and a lever that
 * constrains what every app owner on the box may do is a platform-tier control.
 *
 * The violations list ships with the GET rather than behind its own endpoint
 * because the two are one question. An admin turning ban_public_apps on needs
 * to see in the same response that the switch does NOT convert the four public
 * apps already on the platform — policy is not retroactive, and a settings
 * toggle with no such list reads as though it were.
 */
router.get('/platform-policy', (req, res) => {
  if (req.user.role !== 'platform_admin') {
    throw new AppError('Only platform admins can read platform policy', 403, 'FORBIDDEN');
  }
  const db = getDb();
  res.json({ policy: getPolicy(db), violations: policyViolations(db) });
});

router.put('/platform-policy', (req, res) => {
  if (req.user.role !== 'platform_admin') {
    throw new AppError('Only platform admins can change platform policy', 403, 'FORBIDDEN');
  }
  const db = getDb();
  const { ban_public_apps, mandate_security_scans } = req.body || {};
  if (ban_public_apps === undefined && mandate_security_scans === undefined) {
    throw new AppError(
      'Supply ban_public_apps and/or mandate_security_scans', 400, 'VALIDATION');
  }
  const before = getPolicy(db);
  const policy = setPolicy(db, { ban_public_apps, mandate_security_scans }, req.user.id);
  // Audited by hand rather than via auditMiddleware: this route has no :slug, so
  // there is no app_id to attribute the entry to, and the middleware's whole
  // shape is per-app. Recorded from/to because "who turned the ban off" is the
  // question this log answers.
  logAudit(req.user.id, null, 'platform-policy-change', { from: before, to: policy });
  res.json({ policy, violations: policyViolations(db) });
});

/**
 * GET /api/apps/:slug - App detail
 */
router.get('/:slug', requireAppAccess, async (req, res) => {
  const db = getDb();
  const app = req.app;
  const ports = getPortsForSlot(app.slot);

  const users = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN app_users au ON u.id = au.user_id WHERE au.app_id = ?
  `).all(app.id);

  const deployments = db.prepare(
    'SELECT id, env, version, status, commit_hash, started_at, finished_at FROM deployments WHERE app_id = ? ORDER BY started_at DESC LIMIT 10'
  ).all(app.id);

  const healthProd = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'production');
  const healthSand = db.prepare('SELECT * FROM health_state WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');
  const healthConfigProd = db.prepare('SELECT * FROM health_configs WHERE app_id = ? AND env = ?').get(app.id, 'production');
  const healthConfigSand = db.prepare('SELECT * FROM health_configs WHERE app_id = ? AND env = ?').get(app.id, 'sandbox');

  const webhook = db.prepare('SELECT token, auto_deploy_sandbox, auto_deploy_prod, branch_filter FROM webhook_configs WHERE app_id = ?').get(app.id);

  const craneDomainDetail = process.env.CRANE_DOMAIN;
  const urlsDetail = craneDomainDetail ? {
    production: `https://${craneDomainDetail}/${app.slug}`,
    sandbox: `https://${craneDomainDetail}/${app.slug}-sandbox`,
  } : null;

  // What the production container actually binds, so the payload can say whether
  // the configured publish is live. `null` from the reader (Docker unreachable)
  // and a slug with no running container both resolve to null, which
  // ingressDrift reports as UNKNOWN rather than as closed.
  const { publishedPortsBySlug } = await import('../services/docker.js');
  const observedMap = await publishedPortsBySlug();
  const observedDetail = observedMap ? (observedMap.get(`${app.slug}:production`) ?? null) : null;

  res.json({
    app: { ...app, resource_limits: JSON.parse(app.resource_limits || '{}'), auth_bypass_paths: parseBypassPathsField(app.auth_bypass_paths), auth_mode: effectiveAuthMode(app.auth_mode), ...ingressFields(app, true, observedDetail, drainingPorts(db, app.id)) },
    urls: urlsDetail,
    base_path: { production: `/${app.slug}/`, sandbox: `/${app.slug}-sandbox/` },
    ...(isAdmin(req.user) ? { ports } : {}),
    users,
    deployments,
    health: {
      production: { config: healthConfigProd, state: healthProd },
      sandbox: { config: healthConfigSand, state: healthSand },
    },
    webhook: webhook ? { ...webhook, url: `/api/webhooks/${webhook.token}` } : null,
  });
});

/**
 * GET /api/apps/:slug/metrics - CPU/memory time-series for the resource charts.
 * v2.21.8. Query: env (production|sandbox, optional), hours (1-168, default 24).
 */
router.get('/:slug/metrics', requireAppAccess, (req, res) => {
  const app = req.app;
  const env = ['production', 'sandbox'].includes(req.query.env) ? req.query.env : null;
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const db = getDb();
  const args = env ? [app.id, env, `-${hours} hours`] : [app.id, `-${hours} hours`];
  const rows = db.prepare(`
    SELECT env, cpu_percent, mem_mb, recorded_at
    FROM metrics_history
    WHERE app_id = ? ${env ? 'AND env = ?' : ''} AND recorded_at >= datetime('now', ?)
    ORDER BY recorded_at ASC
  `).all(...args);
  res.json({ metrics: rows, hours });
});

/**
 * GET /api/apps/:slug/storage - persistent-storage (/data volume) usage in bytes,
 * per env. The app's persistent data lives at
 * <DATA_DIR>/apps/<slug>/<env>/shared/data — the only bytes that survive a
 * redeploy (release checkouts under releases/ are ephemeral). v2.21.20.
 */
router.get('/:slug/storage', requireAppAccess, async (req, res) => {
  const app = req.app;
  const { dirSizeBytes } = await import('../services/diskUsage.js');
  const dataDir = process.env.DATA_DIR || './data';
  const envs = {};
  for (const env of ['production', 'sandbox']) {
    let bytes = 0;
    try {
      const dataPath = resolveSafe(dataDir, 'apps', app.slug, env, 'shared', 'data');
      bytes = dirSizeBytes(dataPath);
    } catch (_) { bytes = 0; }
    envs[env] = bytes;
  }
  res.json({ slug: app.slug, storage: envs, total_bytes: envs.production + envs.sandbox });
});

/**
 * PUT /api/apps/:slug - Update app (admin or assigned user)
 */
router.put('/:slug', requireAppAccess, auditMiddleware('app-update'), async (req, res) => {
  const db = getDb();
  const app = req.app;
  const { name, domain, description, category, source_type, github_url, branch, github_token, max_ram_mb, max_cpu_percent, public_access, visibility, image_retention, frame_ancestors, auth_mode, auth_bypass_paths, email_from_name, ingress_type, public_port, sandbox_public_port, data_plane_port, image_ref, container_port, health_path } = req.body;

  // Configurable RBAC: changes to repo-related fields gated by code.modify_repo_settings.
  // Other fields (name, description, category, visibility, etc.) stay open to any
  // app-assigned user via requireAppAccess.
  //
  // image_ref joins the list on the same footing as github_url: for an image
  // app it IS the code selection, so a role that may not repoint the repo must
  // not be able to repoint the image either. container_port and health_path are
  // deliberately left out — they describe where the image answers, not what it
  // is, and are no more sensitive than the other open fields.
  const repoFieldChanged =
    github_url !== undefined ||
    branch !== undefined ||
    github_token !== undefined ||
    source_type !== undefined ||
    image_ref !== undefined;
  if (repoFieldChanged && !userHasAppPermission(req.user, app, 'code.modify_repo_settings')) {
    throw new AppError('Modifying repo settings is not permitted by your role on this app', 403, 'FORBIDDEN');
  }

  // Same allowlist as POST. 'managed_legacy' stays absent from it: it is the
  // deprecation marker for pre-052 upload apps, so existing rows keep it but no
  // request may set it.
  // v2.59.0: 'image' is settable here as well as on POST. The two allowlists are
  // separate declarations, and a value added to one of them is accepted by half
  // the API — an app created as an image app that could never be edited, or the
  // reverse.
  if (source_type !== undefined) {
    const VALID_SOURCE_TYPES = new Set(['github', 'managed', 'upload', 'image']);
    if (!VALID_SOURCE_TYPES.has(source_type)) {
      throw new AppError(
        `source_type must be one of ${[...VALID_SOURCE_TYPES].map(t => `'${t}'`).join(', ')} — ` +
        `'${source_type}' is not supported`,
        400, 'VALIDATION',
      );
    }
  }

  // The image fields. Validated on the VALUE whenever supplied — see the
  // matching block in POST — and image_ref is additionally REQUIRED by the time
  // the row is an image app.
  //
  // The requirement is checked against the effective value, not against
  // req.body: a PUT that only flips source_type to 'image' on a row that
  // already carries an image_ref is complete, and a PUT that supplies both at
  // once is the ordinary case. Only the combination that would leave the row
  // naming nothing to run is refused.
  let imageRefValue = null;
  if (image_ref !== undefined && image_ref !== null && image_ref !== '') {
    validateImageRef(image_ref);
    imageRefValue = String(image_ref).trim();
  }
  const nextSourceType = source_type === undefined ? app.source_type : source_type;
  const nextImageRef = image_ref === undefined ? (app.image_ref || null) : imageRefValue;
  if (nextSourceType === 'image' && !nextImageRef) {
    throw new AppError(
      "source_type 'image' requires image_ref — the image to run, e.g. 'odoo:19' or " +
      "'ghcr.io/owner/app@sha256:<64 hex>'",
      400, 'VALIDATION',
    );
  }

  // v2.7.6: category changes are owner/admin-only, and only global admins may
  // CREATE a new category. Owners pick from the existing set; plain app 'user'
  // members can't change the category at all. (Other open fields below stay
  // editable by any app-assigned user via requireAppAccess.)
  if (category !== undefined) {
    const newCat = category ? String(category).trim() : null;
    const curCat = app.category || null;
    if (newCat !== curCat) {
      const globalAdmin = isAdmin(req.user);
      const isOwner = roleForUserOnApp(req.user, app) === 'owner';
      if (!globalAdmin && !isOwner) {
        throw new AppError('Only the app owner can change the category.', 403, 'FORBIDDEN');
      }
      // Owners may only assign an existing category; creating new categories
      // is reserved for global admins. v2.7.8: scope the "does this category
      // exist" check to apps the owner can actually see (public, or apps
      // they're assigned to) — matches the Launcher dropdown and avoids a
      // cross-app oracle that would reveal categories used by apps hidden
      // from this user.
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
        `).get(newCat, req.user.id, req.user.id);
        if (!exists) {
          throw new AppError('Only admins can create new categories — pick an existing one.', 403, 'NEW_CATEGORY_FORBIDDEN');
        }
      }
    }
  }

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (domain !== undefined) {
    // v2.10.0: domain = a custom passthrough domain (served at root, no SSO,
    // no topbar — the app does its own auth). Owner/admin only (it's a public
    // exposure), validated so a bad value can't break the Caddyfile.
    const globalAdmin = isAdmin(req.user);
    const isOwner = roleForUserOnApp(req.user, app) === 'owner';
    if (!globalAdmin && !isOwner) {
      throw new AppError('Only the app owner can set a custom domain.', 403, 'FORBIDDEN');
    }
    try {
      const { validateCustomDomain } = await import('../utils/customDomain.js');
      updates.domain = validateCustomDomain(domain, process.env.CRANE_DOMAIN);
    } catch (e) { throw new AppError(e.message, 400, 'VALIDATION'); }
    // Reject if another app already claims this domain.
    if (updates.domain) {
      const clash = db.prepare('SELECT slug FROM apps WHERE lower(domain) = ? AND id != ?').get(updates.domain, app.id);
      if (clash) throw new AppError(`Domain "${updates.domain}" is already used by app "${clash.slug}"`, 409, 'DOMAIN_TAKEN');
    }
  }
  if (description !== undefined) updates.description = description;
  if (category !== undefined) updates.category = category ? String(category).trim() : null;
  if (source_type !== undefined) updates.source_type = source_type;
  if (image_ref !== undefined) updates.image_ref = imageRefValue;
  if (container_port !== undefined) {
    updates.container_port = container_port === null ? null : validateContainerPort(container_port);
  }
  if (health_path !== undefined) {
    updates.health_path = health_path === null || health_path === ''
      ? null
      : validateHealthPath(health_path);
  }
  if (github_url !== undefined) {
    if (github_url) validateGithubUrl(github_url);
    updates.github_url = github_url;
  }
  if (branch !== undefined) {
    // SECURITY: branch flows into `sh -c` arguments inside container start
    // commands (askClaude.js, generator.js). Validate at the write boundary
    // so a future inline interpolation can't be exploited via this column.
    // Regex matches the chars git accepts in a ref name plus '/' for paths.
    if (branch && !/^[A-Za-z0-9._/\-]{1,200}$/.test(branch)) {
      throw new AppError('branch must be alphanumeric with . _ / - (max 200 chars)', 400, 'VALIDATION');
    }
    updates.branch = branch;
  }
  // v2.20.2: the visibility/public_access invariant lives in one shared helper
  // (resolveVisibility) so REST and the MCP config tools can't drift.
  let visibilityUpdates;
  try {
    visibilityUpdates = resolveVisibility({ visibility, public_access });
  } catch (e) {
    throw new AppError(e.message, 400, 'VALIDATION');
  }
  // v2.7.9: visibility changes are owner/admin-only (it controls public
  // exposure). Plain app 'user' members can't flip it.
  if (visibility !== undefined && visibility !== (app.visibility || 'hidden')) {
    const globalAdmin = isAdmin(req.user);
    const isOwner = roleForUserOnApp(req.user, app) === 'owner';
    if (!globalAdmin && !isOwner) {
      throw new AppError('Only the app owner can change visibility.', 403, 'FORBIDDEN');
    }
  }
  // v2.52.0: the platform policy gate, after the authz check above so a caller
  // who may not touch visibility at all is told that, rather than being told
  // what the platform's policy is.
  //
  // Checked on the RESOLVED value, not on req.body.visibility. `public_access:
  // true` is the second way to reach visibility='public' (resolveVisibility maps
  // it), so a check on the named field alone would leave the older of the two
  // fields as an open route around the ban.
  //
  // Change-not-presence, the same rule the owner check above and the ingress
  // gate below already use. The policy is deliberately not retroactive: an app
  // that was public before the lever went on stays public and is REPORTED by
  // policyViolations, so a read-modify-write client echoing back the value it
  // was handed while editing a description must not be refused. What is refused
  // is a write that makes an app public that was not.
  if (visibilityUpdates.visibility !== undefined
      && visibilityUpdates.visibility !== (app.visibility || 'hidden')) {
    assertVisibilityAllowed(db, visibilityUpdates.visibility);
  }
  Object.assign(updates, visibilityUpdates);
  if (github_token !== undefined) updates.github_token_encrypted = encrypt(github_token);
  if (image_retention !== undefined) {
    if (!isAdmin(req.user)) {
      throw new AppError('Only admins can change image retention', 403, 'FORBIDDEN');
    }
    const ret = Number(image_retention);
    if (!Number.isFinite(ret) || ret < 0 || ret > 50 || !Number.isInteger(ret)) {
      throw new AppError('image_retention must be an integer between 0 and 50', 400, 'VALIDATION');
    }
    updates.image_retention = ret;
  }
  let memoryBudgetReport = null;
  if (max_ram_mb !== undefined || max_cpu_percent !== undefined) {
    // v2.21.5: CPU/memory limits are platform-admin only — not app owners,
    // app-admins, or even tier-2 global admins.
    if (req.user.role !== 'platform_admin') {
      throw new AppError('Only platform admins can change CPU/memory limits', 403, 'FORBIDDEN');
    }
    const ram = max_ram_mb !== undefined ? Number(max_ram_mb) : null;
    const cpu = max_cpu_percent !== undefined ? Number(max_cpu_percent) : null;
    if (ram !== null && (!Number.isFinite(ram) || ram < 64 || ram > 16384)) {
      throw new AppError('max_ram_mb must be between 64 and 16384', 400, 'VALIDATION');
    }
    if (cpu !== null && (!Number.isFinite(cpu) || cpu < 5 || cpu > 800)) {
      throw new AppError('max_cpu_percent must be between 5 and 800', 400, 'VALIDATION');
    }
    const current = JSON.parse(app.resource_limits || '{}');
    const nextRam = ram ?? current.max_ram_mb ?? 512;
    updates.resource_limits = JSON.stringify({
      max_ram_mb: nextRam,
      max_cpu_percent: cpu ?? current.max_cpu_percent ?? 50,
    });
    // v2.49.0: REPORT, DO NOT BLOCK. The August 2026 incident was a number that
    // read as a guarantee and was not one — a container promised 512 MB of swap
    // on a host with none. The fleet-wide version of the same thing is ~25 GB of
    // per-container ceilings committed against a 7.6 GB host, and nothing on
    // this route ever said so. It says so now, on the 200, rather than at the
    // next cold start.
    //
    // Deliberately not a gate: the fleet is ALREADY ~3x over, so a refusal would
    // reject every ordinary edit from the moment it shipped, including the edits
    // that REDUCE the total. Assessed against the PROPOSED limit and before the
    // write, so `level` describes the change the caller asked for rather than
    // the state they have already been left in.
    memoryBudgetReport = assessMemoryChange(db, app.id, nextRam);
  }

  if (frame_ancestors !== undefined) {
    // SECURITY: changing frame_ancestors lets the app be embedded in
    // arbitrary origins → clickjacking on /login (which strips
    // X-Frame-Options for that slug's redirect). Restrict to admin so an
    // app-assigned user can't open the door (security review v1.27.34 H3).
    if (!isAdmin(req.user)) {
      throw new AppError('Only admins can change frame_ancestors', 403, 'FORBIDDEN');
    }
    if (frame_ancestors === null || frame_ancestors === '') {
      updates.frame_ancestors = null;
    } else {
      // Validate CSP source-list syntax: tokens separated by spaces, each
      // either 'self' / 'none' (with quotes) or a scheme://host[:port]
      // (optional wildcards in subdomain only). Reject anything containing
      // ;, newlines, double-quotes, or other CSP-injection characters.
      const v = String(frame_ancestors).trim();
      if (!/^[A-Za-z0-9 _.\-:/'*]+$/.test(v))     throw new AppError("frame_ancestors contains invalid characters", 400, 'VALIDATION');
      if (v.length > 512)                          throw new AppError("frame_ancestors too long (max 512 chars)", 400, 'VALIDATION');
      const tokens = v.split(/\s+/).filter(Boolean);
      const TOKEN_RE = /^('self'|'none'|https?:\/\/(\*\.)?[a-z0-9.\-]+(:\d+)?)$/i;
      const bad = tokens.find(t => !TOKEN_RE.test(t));
      if (bad) throw new AppError(`frame_ancestors token "${bad}" is not a valid CSP source`, 400, 'VALIDATION');
      updates.frame_ancestors = tokens.join(' ');
    }
  }

  // v2.7.27: auth_bypass_paths. Per-path bypass of forward_auth — narrower
  // than headless mode (which removes SSO from the entire app). Same exposure
  // class as auth_mode, so same gate: owner-or-admin. Validated centrally in
  // utils/authBypassPaths.js so the API write path AND the Caddy generator
  // read-back share one set of rules. Stored as JSON; Caddy emits one inner
  // `handle` block per entry, BEFORE the forward_auth'd parent block.
  if (auth_bypass_paths !== undefined) {
    const globalAdmin = isAdmin(req.user);
    const isOwner = roleForUserOnApp(req.user, app) === 'owner';
    if (!globalAdmin && !isOwner) {
      throw new AppError('Only the app owner can change auth_bypass_paths.', 403, 'FORBIDDEN');
    }
    let parsed;
    try { parsed = validateBypassPaths(auth_bypass_paths); }
    catch (e) { throw new AppError(e.message, 400, 'VALIDATION'); }
    updates.auth_bypass_paths = parsed && parsed.length > 0 ? JSON.stringify(parsed) : null;
  }

  // v2.7.22: auth_mode. 'headless' bypasses forward_auth entirely and exposes
  // the app to unauthenticated traffic. Owner-or-admin only, same gate as
  // visibility/category (it's an exposure change).
  if (auth_mode !== undefined) {
    if (!['authenticated', 'headless'].includes(auth_mode)) {
      throw new AppError("auth_mode must be 'authenticated' or 'headless'", 400, 'VALIDATION');
    }
    if (auth_mode !== (app.auth_mode || 'authenticated')) {
      const globalAdmin = isAdmin(req.user);
      const isOwner = roleForUserOnApp(req.user, app) === 'owner';
      if (!globalAdmin && !isOwner) {
        throw new AppError('Only the app owner can change auth_mode.', 403, 'FORBIDDEN');
      }
    }
    updates.auth_mode = auth_mode;
  }

  // v2.8.3: email is available to every app automatically (token injected on
  // deploy) — no enable flag. Only the display-name override remains settable.
  if (email_from_name !== undefined) {
    updates.email_from_name = email_from_name ? String(email_from_name).slice(0, 100) : null;
  }

  // v2.42.0: TCP ingress. ingress_type='tcp' publishes the container port
  // straight onto the host (0.0.0.0:<public_port>) with Caddy out of the path,
  // for apps that aren't HTTP at all — a forward/CONNECT proxy hands back a raw
  // tunnel that no reverse proxy can express.
  //
  // SECURITY: this is not an app-owner setting. auth_mode='headless' says
  // "AppCrane steps back, the app owns authn" but the request still goes
  // through Caddy — TLS, security headers, the auth-mode stamp, request
  // logging. A published TCP port has none of that: no forward_auth, no
  // identity headers, no audit of traffic, no rate limiting. It is a SECOND
  // DOOR that AppCrane does not control, so the gate is the PLATFORM tier, not
  // the app tier.
  //
  // Deliberately gated on req.user.role rather than on app assignment. This
  // route runs under requireAppAccess, and since v2.39.0 assignment is
  // authoritative for app DATA (requireAppUser) even for platform admins —
  // that guardrail keeps platform admins out of an app's env vars unless they
  // step down and join it. Routing this through that gate would invert it:
  // opening a host port would require a platform admin to first assign
  // themselves to the app, which hands them the env/data access the guardrail
  // exists to withhold. So: platform tier for a platform-tier decision, and no
  // app membership is created as a side effect.
  //
  // This gate is the ONLY thing standing between the request and an open host
  // port. Do not read the operator's firewall as a second key: on Linux a
  // Docker publish is a DNAT rule evaluated in FORWARD and never in INPUT, so a
  // plain `ufw deny` does not hold it shut — filtering has to happen in
  // DOCKER-USER or upstream. An earlier version of this comment claimed the
  // opposite ("two keys, so a mis-click here cannot put an app on the
  // internet"); the guide's docs test now forbids that claim by name.
  //
  // The branch engages on a CHANGE, not on the mere presence of the fields.
  // ingressFields() puts ingress_type and public_port on every GET payload, so
  // any read-modify-write client echoes them back on the next PUT; gating on
  // presence made an http app's own unmodified payload a 400 (public_port null
  // with a non-tcp type) and made a non-admin's unrelated edit a 403. Both
  // silently dropped the rest of the request. A caller that sends the values it
  // was given is not changing the ingress.
  //
  // v2.45.0: ingress_type='dual' is an app with BOTH planes — an HTTP control
  // plane still served through Caddy on the loopback publish, plus a raw data
  // plane published at 0.0.0.0:<public_port> -> <data_plane_port> inside the
  // same container. Same gate, same audit: it opens the same undefended door,
  // and data_plane_port is the field that decides what is behind it.
  const currentType = effectiveIngressType(app.ingress_type);
  const currentPort = publicPortForApp(app);
  const currentDataPlanePort = effectiveDataPlanePort(app);
  const wantsTypeChange = ingress_type !== undefined && ingress_type !== currentType;
  const wantsPortChange = public_port !== undefined && public_port !== currentPort;
  const wantsDataPlaneChange = data_plane_port !== undefined && data_plane_port !== currentDataPlanePort;
  // v2.46.0. Same change-not-presence rule as the others, so a read-modify-write
  // client echoing back the value it was handed is not treated as a change.
  const currentSandboxPort = publicPortForApp(app, 'sandbox');
  const wantsSandboxPortChange = sandbox_public_port !== undefined
    && sandbox_public_port !== currentSandboxPort;
  // A publishing app with no port allocated publishes nothing, so re-sending
  // the same ingress_type has to be able to finish the job rather than read as
  // "no change".
  const needsAllocation = ingress_type !== undefined && ingress_type === currentType
    && currentType !== 'http' && currentPort === null;

  let ingressWork = null;
  if (wantsTypeChange || wantsPortChange || wantsDataPlaneChange || wantsSandboxPortChange || needsAllocation) {
    if (req.user.role !== 'platform_admin') {
      throw new AppError('Only platform admins can change ingress_type, public_port, sandbox_public_port or data_plane_port', 403, 'FORBIDDEN');
    }
    let nextType = currentType;
    if (ingress_type !== undefined) {
      try { validateIngressType(ingress_type); }
      catch (e) { throw new AppError(e.message, e.status || 400, e.code || 'VALIDATION'); }
      nextType = ingress_type;
      updates.ingress_type = ingress_type;
    }
    if (sandbox_public_port !== undefined && sandbox_public_port !== null && nextType === 'http') {
      throw new AppError(
        "sandbox_public_port only applies to an app with ingress_type='tcp' or 'dual'", 400, 'VALIDATION');
    }
    if (public_port !== undefined) {
      if (nextType === 'http') {
        throw new AppError("public_port only applies to an app with ingress_type='tcp' or 'dual'", 400, 'VALIDATION');
      }
      if (public_port === null) {
        throw new AppError("A published app must keep its public port — set ingress_type='http' to release it", 400, 'VALIDATION');
      }
    }
    if (data_plane_port !== undefined) {
      if (data_plane_port === null) {
        // Explicit null CLEARS the pinned data plane. It is the only way to
        // drop it, which is what makes the tcp refusal below escapable: an
        // operator who genuinely wants v2.42.0's whole-container publish has to
        // say so in the same request rather than reach it by a flip that reads
        // as changing only the type.
        if (nextType === 'dual') {
          throw new AppError(
            "A dual app must keep a data plane port — send ingress_type='http' or 'tcp' together with " +
            'data_plane_port: null to drop it',
            400, 'VALIDATION',
          );
        }
        updates.data_plane_port = null;
      } else {
        // Only 'dual' has two planes to tell apart. A pure-tcp app IS its data
        // plane — the container is told PORT=3000 and the whole of it is
        // published — so a second number there would be a second way to say the
        // same thing, and the ports would silently disagree.
        if (nextType !== 'dual') {
          throw new AppError("data_plane_port only applies to an app with ingress_type='dual'", 400, 'VALIDATION');
        }
        try { validateDataPlanePort(data_plane_port); }
        catch (e) { throw new AppError(e.message, e.status || 400, e.code || 'VALIDATION'); }
        updates.data_plane_port = data_plane_port;
      }
    }
    // SECURITY: 'tcp' publishes CONTROL_PLANE_PORT itself — correct for an app
    // whose whole container IS the data plane, and wrong for a row that still
    // carries a data_plane_port. Flipping such an app to tcp repoints the SAME
    // pinned host port from the data plane to the HTTP control plane: exactly
    // the publish validateDataPlanePort refuses outright, reached instead by a
    // request that named only the type. Clients stay pointed at the port; what
    // answers them becomes the origin Caddy fronts, stripped of TLS,
    // forward_auth, identity headers and audit. Refuse unless the same request
    // drops the data plane, so the exposure change is something the operator
    // said rather than something the flip did.
    if (nextType === 'tcp') {
      const stillPinned = updates.data_plane_port === undefined
        ? (Number.isInteger(app.data_plane_port) ? app.data_plane_port : null)
        : updates.data_plane_port;
      if (stillPinned !== null) {
        throw new AppError(
          `This app still has data_plane_port ${stillPinned}. ingress_type='tcp' publishes container port ` +
          `${CONTROL_PLANE_PORT} — the HTTP control plane — on the host, so the flip would repoint ` +
          `the published port away from the data plane and onto the origin Caddy fronts, with no TLS, no ` +
          'forward_auth, no identity headers and no request audit. Send data_plane_port: null in the same ' +
          'request to drop the data plane deliberately.',
          400, 'VALIDATION',
        );
      }
    }
    // SECURITY: 'dual' without a data-plane port is not a half-configured app,
    // it is a request to publish the control plane raw. The publish has to
    // target SOME container port, and the only other one in the container is
    // CONTROL_PLANE_PORT — the HTTP origin Caddy fronts, which would then be
    // reachable with no TLS, no forward_auth, no identity headers and no audit.
    // Refuse the flip instead of picking a default. (The runtime refuses such a
    // row too; this is the error the operator should actually see.)
    //
    // Read from the STORED column, not the effective value: like public_port,
    // the number survives a flip away from dual so that flipping back restores
    // the port clients are configured for — and the whole point of pinning is
    // that they do not have to be reconfigured. Revalidated on the way back in
    // rather than trusted, so a value that became illegal while the app sat on
    // http (hand-edited, or a rule that moved) cannot be reinstated by a flip.
    if (nextType === 'dual') {
      const nextDataPlanePort = updates.data_plane_port
        ?? (Number.isInteger(app.data_plane_port) ? app.data_plane_port : null);
      if (nextDataPlanePort === null) {
        throw new AppError(
          "ingress_type='dual' requires data_plane_port — the raw publish must target a port INSIDE the " +
          "container that is not the HTTP control plane, and AppCrane will not guess one",
          400, 'VALIDATION',
        );
      }
      try { validateDataPlanePort(nextDataPlanePort); }
      catch (e) { throw new AppError(e.message, e.status || 400, e.code || 'VALIDATION'); }
    }
    if (nextType !== 'http') {
      // Automatic allocation: switching an app to a publishing type with no
      // port set picks one. An already-allocated port is returned untouched,
      // which is how it survives redeploys and slot changes — nothing else
      // recomputes it.
      ingressWork = {
        kind: 'assign',
        requested: public_port === undefined ? null : public_port,
        // v2.46.0. `undefined` means "leave sandbox exactly as it is" — a
        // sandbox port is opt-in and must never appear because some other
        // ingress field was edited. `null` explicitly drops it.
        sandbox: sandbox_public_port,
      };
    } else {
      // Flipping to http stops the PUBLISH and nothing else. It deliberately
      // does not free the port number: the publish is a `docker run` flag, so
      // the container that is running right now keeps binding
      // 0.0.0.0:<public_port> until it is recreated. Freeing it here let the
      // allocator hand a live, still-bound port to the next app — that app's
      // `docker run` then died with "port is already allocated" while traffic
      // to the port kept reaching the OLD app, and every surface reported the
      // port closed. The row keeps the number as a reservation instead;
      // docker.js releases it the moment the container comes back without the
      // publish. See pendingPortRelease().
      //
      // Unconditional, not gated on the app currently holding a port: this is
      // the branch that writes the 'app-ingress-change' entry, and a tcp -> http
      // flip is exactly the transition an operator reviewing an exposure needs
      // to find. Skipping it when public_port happened to be NULL left the flip
      // recorded nowhere.
      ingressWork = { kind: 'stop-publishing' };
    }
  }

  if (Object.keys(updates).length === 0 && !ingressWork) {
    // Normalize auth_mode here too: a caller can't tell which branch of this
    // route answered, so both must report the same effective mode.
    return res.json({ app: { ...app, auth_mode: effectiveAuthMode(app.auth_mode), ...ingressFields(app) }, message: 'No changes' });
  }

  const ALLOWED_APP_COLS = new Set(['name','domain','description','category','source_type','github_url','branch','public_access','visibility','github_token_encrypted','resource_limits','runtime','image_retention','frame_ancestors','auth_mode','auth_bypass_paths','email_from_name','ingress_type','data_plane_port','image_ref','container_port','health_path']);
  const invalidKey = Object.keys(updates).find(k => !ALLOWED_APP_COLS.has(k));
  if (invalidKey) throw new AppError(`Invalid field: ${invalidKey}`, 400, 'VALIDATION');

  // The column write and the port allocation are ONE transaction. public_port
  // still goes through the allocator rather than the generic UPDATE — picking
  // the lowest free port and claiming it has to be atomic, and the partial
  // unique index is what makes a concurrent second allocation fail instead of
  // double-booking a host port — but if that allocation throws, the
  // ingress_type write must roll back with it. Committing the type first left
  // a rejected request having permanently flipped the app to tcp with
  // public_port null AND no 'app-ingress-change' entry (the audit write is
  // past the throw), so the transition that actually happened was
  // unrecoverable from the log — the one thing this action is audited to
  // guarantee. Failing atomically means a rejected change leaves no trace
  // because it left no change.
  const applyWrites = db.transaction(() => {
    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updates);

      db.prepare(`UPDATE apps SET ${setClauses} WHERE id = ?`).run(...values, app.id);
    }

    if (!ingressWork) return;

    const before = ingressAudit(app);
    if (ingressWork.kind === 'assign') {
      assignPublicPort(db, app.id, ingressWork.requested, 'production');
      // Only when named. Opt-in is the whole rollout policy: a published port
      // has no forward_auth, no TLS from AppCrane, no identity headers and no
      // audit, so one must not appear on a container because an unrelated
      // ingress field was edited.
      if (ingressWork.sandbox === null) {
        releasePublicPort(db, app.id, 'sandbox');
      } else if (ingressWork.sandbox !== undefined) {
        assignPublicPort(db, app.id, ingressWork.sandbox, 'sandbox');
      }
    }
    const after = db.prepare('SELECT ingress_type, public_port, sandbox_public_port, data_plane_port FROM apps WHERE id = ?').get(app.id);
    // Audited on its own action, not folded into the generic 'app-update'
    // entry: "a port was opened on the host" is the one change here an
    // operator reviewing the log must be able to find by name.
    //
    // public_port is the EFFECTIVE value, matching every read surface, with the
    // port that is still bound recorded beside it. An entry that said only
    // `public_port: null` would read as "the port was closed at this timestamp"
    // — which is the one thing this transition does not do.
    logAudit(req.user.id, app.id, 'app-ingress-change', { from: before, to: ingressAudit(after) });
  });

  try { applyWrites(); }
  catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(e.message, e.status || 400, e.code || 'VALIDATION');
  }

  // v2.24.4: when the custom domain changes, keep the old one alive as a 301
  // redirect to the new one so already-sent login links / bookmarks don't break.
  if ('domain' in updates) {
    const { autoSeedAliasOnDomainChange } = await import('../services/domainAliases.js');
    autoSeedAliasOnDomainChange(db, app, app.domain, updates.domain);
  }

  // frame_ancestors and auth_mode change the per-app Caddyfile block — reload to apply.
  // auth_mode flips whether forward_auth runs at all; without a reload the new
  // setting wouldn't take effect on the live proxy.
  // ingress_type is deliberately NOT in this list. The Caddyfile generator does
  // not read the column — a tcp app still gets its ordinary HTTP vhost, behind
  // forward_auth, on its loopback port; the published host port is a second
  // door Caddy never sees. Generating the config with an app flipped either way
  // produces a byte-identical file, so reloading here would be a no-op that
  // reads as "Caddy special-cases tcp apps" to the next person.
  if ('frame_ancestors' in updates || 'auth_mode' in updates || 'auth_bypass_paths' in updates || 'domain' in updates) {
    await reloadCaddy().catch(e => log.warn(`Caddy reload after app meta update: ${e.message}`));
  }

  const updated = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
  // A 200 on a tcp -> http flip must not read as "the port is closed". Said in
  // prose as well as in the pending_port_release field, because the caller that
  // most needs to hear it is a script or an agent that checked the status code
  // and moved on to telling someone the exposure is revoked.
  const stillBound = pendingPortRelease(updated);
  res.json({
    // Present only on a request that actually touched the limits — the whole
    // fleet is summed to produce it, and an unrelated field edit should not pay
    // for that, nor read as though it moved the total.
    ...(memoryBudgetReport ? { memory_budget: memoryBudgetReport } : {}),
    ...(stillBound !== null && ingressWork ? {
      ingress_notice: `Port ${stillBound} is NOT closed yet. AppCrane will not publish it again and no other app can be given it, but the container that is running right now still binds 0.0.0.0:${stillBound} — the publish is a \`docker run\` flag. Deploy the app, or POST /api/apps/${app.slug}/restart/production, to recreate the container and actually close the port; AppCrane returns the port to the pool at that moment.`,
    } : {}),
    app: {
      ...updated,
      resource_limits: JSON.parse(updated.resource_limits || '{}'),
      auth_bypass_paths: parseBypassPathsField(updated.auth_bypass_paths),
      auth_mode: effectiveAuthMode(updated.auth_mode),
      ...ingressFields(updated),
      domain_aliases: db.prepare('SELECT id, domain, source, created_at FROM app_domain_aliases WHERE app_id = ? ORDER BY created_at, id').all(app.id),
    },
  });
});

/**
 * POST /api/apps/:slug/domain-aliases  { domain } — add a redirect alias (v2.24.4).
 * DELETE /api/apps/:slug/domain-aliases/:aliasId  — remove one.
 * Owner/admin only (aliases are public exposure, same gate as the custom domain).
 */
async function requireDomainAdmin(req) {
  const app = req.app;
  const globalAdmin = isAdmin(req.user);
  const isOwner = roleForUserOnApp(req.user, app) === 'owner';
  if (!globalAdmin && !isOwner) {
    throw new AppError('Only the app owner can manage domain aliases.', 403, 'FORBIDDEN');
  }
  return app;
}

router.post('/:slug/domain-aliases', requireAppAccess, auditMiddleware('app-domain-alias-add'), async (req, res) => {
  const app = await requireDomainAdmin(req);
  const db = getDb();
  const { addAlias } = await import('../services/domainAliases.js');
  let alias;
  try {
    alias = addAlias(db, app, (req.body || {}).domain);
  } catch (e) {
    throw new AppError(e.message, e.message.includes('already used') ? 409 : 400, 'VALIDATION');
  }
  await reloadCaddy().catch(e => log.warn(`Caddy reload after alias add: ${e.message}`));
  res.json({ alias });
});

router.delete('/:slug/domain-aliases/:aliasId', requireAppAccess, auditMiddleware('app-domain-alias-remove'), async (req, res) => {
  const app = await requireDomainAdmin(req);
  const db = getDb();
  const { removeAlias } = await import('../services/domainAliases.js');
  const removed = removeAlias(db, app, parseInt(req.params.aliasId, 10));
  if (removed) await reloadCaddy().catch(e => log.warn(`Caddy reload after alias remove: ${e.message}`));
  res.json({ ok: true, removed });
});

/**
 * DELETE /api/apps/:slug - Delete app
 * Configurable RBAC: gated by app.delete permission. AppCrane global admin
 * always allowed; per-app deletion follows the role_permissions matrix
 * (default: Owner only). Requires ?confirm=true.
 */
router.delete('/:slug', requireAppAccess, auditMiddleware('app-delete'), async (req, res) => {
  if (!userHasAppPermission(req.user, req.app, 'app.delete')) {
    throw new AppError('Deleting this app is not permitted by your role', 403, 'FORBIDDEN');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('confirm') !== 'true') {
    throw new AppError('Add ?confirm=true to delete', 400, 'CONFIRMATION_REQUIRED');
  }

  const db = getDb();
  const slug = req.app.slug;

  // Stop containers
  try {
    const { stopApp } = await import('../services/docker.js');
    await stopApp(slug, 'production').catch(() => {});
    await stopApp(slug, 'sandbox').catch(() => {});
  } catch (e) {}

  // v2.65.0: drop the app's managed databases BEFORE the row goes away.
  //
  // Migration 085's foreign key cascades the managed_databases ROW when apps is
  // deleted, and that is the whole of what SQLite can do — it cannot reach into
  // Postgres or MariaDB. So a delete that skipped this would leave the database
  // itself and a live login role standing, holding the deleted app's data, with
  // nothing left in AppCrane pointing at either and anyone who still has the
  // credentials able to open it. The cascade makes the leak INVISIBLE rather
  // than loud, which is why this runs first rather than being left to a sweeper.
  //
  // After stopApp on purpose: the engine-side drop is what has to survive a
  // container that has not finished shutting down (managedDb uses
  // DROP DATABASE ... WITH (FORCE) for exactly that), but there is no reason to
  // race it when stopping first is free.
  //
  // Called plainly, not wrapped: deprovisionApp catches per row and logs, and
  // returns {requested, dropped} counts rather than throwing, so a database
  // server that is down leaves a warning in the log and a deletable app. Read
  // rather than assumed — server/services/managedDb.js, deprovisionApp().
  // The counts are safe to return: they are integers, never a name or a secret.
  const { deprovisionApp } = await import('../services/managedDb.js');
  const dbDrop = await deprovisionApp(req.app.id);
  if (dbDrop.requested !== dbDrop.dropped) {
    log.warn(
      `App delete '${slug}': ${dbDrop.requested - dbDrop.dropped} of ${dbDrop.requested} managed ` +
      'databases could not be dropped — they are now orphaned in the engine',
    );
  }

  // Delete related records first to avoid FK constraint failures
  const appId = req.app.id;
  db.transaction(() => {
    db.prepare('DELETE FROM app_users WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM app_user_roles WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM app_domain_aliases WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM deployments WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM env_vars WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM health_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM health_state WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM webhook_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM backups WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM notification_configs WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM identity_sessions WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM audit_log WHERE app_id = ?').run(appId);
    db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  })();

  // Update Caddy config (removes app routes)
  await reloadCaddy().catch(e => log.warn(`Caddy reload after delete: ${e.message}`));

  res.json({
    message: `App '${slug}' deleted`,
    managed_databases: dbDrop,
  });
});

/**
 * POST /api/apps/:slug/rename - Rename app slug (admin only)
 * Stops containers, renames data dir, updates DB, reloads Caddy, redeploys.
 */
router.post('/:slug/rename', requireAdmin, requireAppAccess, auditMiddleware('app-rename'), async (req, res) => {
  // Logic lives in services/appRename.js so appcrane_rename_app can call the
  // same code — REST is unreachable for the dhk_mcp_* keys agents hold.
  const { renameApp } = await import('../services/appRename.js');
  const out = await renameApp({
    app: req.app,
    newSlug: req.body?.new_slug,
    redirect: req.body?.redirect !== false,
    userId: req.user.id,
  });
  res.json({ message: `App renamed from '${out.old_slug}' to '${out.new_slug}'`, ...out });
});

/**
 * PUT /api/apps/:slug/users - Assign users to app (admin or assigned user)
 */
router.put('/:slug/users', requireAppAccess, auditMiddleware('app-assign-users'), (req, res) => {
  const { user_ids, user_emails } = req.body;
  const db = getDb();
  const appId = req.app.id;

  let ids = user_ids || [];

  // Resolve emails to IDs
  if (user_emails && user_emails.length) {
    for (const email of user_emails) {
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (!user) throw new AppError(`User with email '${email}' not found`, 404, 'NOT_FOUND');
      ids.push(user.id);
    }
  }

  // Replace all assignments
  db.transaction(() => {
    db.prepare('DELETE FROM app_users WHERE app_id = ?').run(appId);
    const insert = db.prepare('INSERT OR IGNORE INTO app_users (app_id, user_id) VALUES (?, ?)');
    for (const uid of ids) {
      insert.run(appId, uid);
    }
    // v2.41.0: anyone missing from the new list has just lost access, so the
    // roles the APP defined for them go too. Otherwise re-adding them later
    // silently restores every one, with no re-grant and nothing in the audit
    // log to explain where the powers came back from.
    // v2.42.1: the platform TIER goes with membership. Deleting only app_users
    // left the app_user_roles row behind, and resolveAppRole reads that row
    // FIRST — so a removed member still resolved to their old tier instead of
    // 'none', passed the /api/identity/verify deny gate, and walked back into
    // the app through Caddy. AppCrane's own routes denied them (requireAppUser
    // reads app_users), which is why the dashboard showed removal as complete.
    db.prepare(
      'DELETE FROM app_user_roles WHERE app_id = ? AND user_id NOT IN (SELECT user_id FROM app_users WHERE app_id = ?)'
    ).run(appId, appId);
    pruneGrantsForNonMembers(appId);
  })();

  const users = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN app_users au ON u.id = au.user_id WHERE au.app_id = ?
  `).all(appId);

  res.json({ app: req.app.slug, users });
});

/*
 * Retired in v2.6.0: POST /api/apps/:slug/deployment-key (+ /recycle).
 *
 * These endpoints minted per-app `user_<random>` REST keys for an
 * X-Deployment-Key flow that duplicated MCP. AppCrane is MCP-only for
 * agents now (see appcrane_get_guide topic="operations"); per-app
 * access lives in app_user_roles, not in paste-key headers.
 *
 * Existing keys keep authenticating until v3.0; no new ones are issued.
 */
router.post('/:slug/deployment-key', requireAuth, (_req, res) => {
  res.status(410).json({
    error: {
      code: 'GONE',
      message: 'Deployment keys are retired (v2.6.0). Agents authenticate via MCP; use appcrane_grant_app_access for per-app access.',
    },
  });
});

/* Recycle path also retired — same rationale as above. */
router.post('/:slug/deployment-key/recycle', requireAuth, (_req, res) => {
  res.status(410).json({
    error: {
      code: 'GONE',
      message: 'Deployment keys are retired (v2.6.0). Use appcrane_grant_app_access for per-app access.',
    },
  });
});

/**
 * POST /api/apps/:slug/icon - Upload app icon SVG (admin or assigned app user)
 */
router.post('/:slug/icon', requireAuth, requireAppAccess, async (req, res) => {
  const app = req.app;  // set by requireAppAccess

  const multer = (await import('multer')).default;
  const dataDir = process.env.DATA_DIR || './data';
  const tmpDir = join(dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const ALLOWED_ICON_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 500 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_ICON_MIMES[file.mimetype]) {
        cb(null, true);
      } else {
        cb(new AppError('Only PNG, JPEG, WEBP, and GIF icons are accepted', 400, 'INVALID_FILE'));
      }
    },
  }).single('icon');

  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    if (!req.file) return res.status(400).json({ error: { code: 'NO_FILE', message: 'No icon file uploaded' } });
    const ext = ALLOWED_ICON_MIMES[req.file.mimetype] || 'png';
    const appIconDir = join(dataDir, 'apps', app.slug);
    // App dir might not exist yet (rare — app created but never deployed).
    mkdirSync(appIconDir, { recursive: true });
    // Wipe any prior icons with a different extension so the GET endpoint
    // (which scans ICON_EXTS in order) doesn't keep serving the stale one.
    // Without this, uploading a JPG over an existing PNG silently kept
    // returning the PNG forever.
    for (const oldExt of ICON_EXTS) {
      if (oldExt === ext) continue;
      const oldPath = join(appIconDir, `icon.${oldExt}`);
      if (existsSync(oldPath)) {
        try { unlinkSync(oldPath); } catch (_) {}
      }
    }
    const iconPath = join(appIconDir, `icon.${ext}`);
    renameSync(req.file.path, iconPath);
    res.json({ message: 'Icon uploaded', url: `/api/apps/${app.slug}/icon` });
  });
});

/**
 * POST /api/reconcile - Register orphaned filesystem apps into the DB and reload Caddy
 */
router.post('/reconcile', requireAdmin, async (req, res) => {
  const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
  const result = await reconcileOrphanedApps({ dryRun });
  res.json({ ...result, dry_run: dryRun });
});

/**
 * GET /api/apps/suspicious-github-urls — admin-only triage list of apps
 * whose github_url is malformed or uses a placeholder owner. Backstop
 * for rows that slipped past validation in earlier service versions.
 */
router.get('/suspicious-github-urls', requireAdmin, (req, res) => {
  res.json({ apps: listSuspiciousGithubUrls() });
});

// ── Per-app Claude Code OAuth credentials ──────────────────────────────
//
// Operators upload a credentials.json (the file `claude login` writes)
// scoped to a specific app. AppCrane mounts it into that app's CLI
// containers so the agent authenticates as the operator's Claude.ai
// subscription instead of charging the global ANTHROPIC_API_KEY wallet.
// Stored encrypted on the app row; never returned in plaintext.

/**
 * GET /api/apps/:slug/claude-credentials — public summary of what's stored.
 * Never returns the raw tokens — just `{ present, expiresAt, accountUuid,
 * accessTokenTail }` so the UI can show a "configured" state without leaking.
 */
router.get('/:slug/claude-credentials', requireAppAccess, async (req, res) => {
  const { credentialsInfo } = await import('../services/claudeCredentials.js');
  res.json(credentialsInfo(req.params.slug));
});

/**
 * PUT /api/apps/:slug/claude-credentials — upload/replace the stored creds.
 * Body: { credentials: <full JSON object> }  OR  raw JSON body that itself
 * is the credentials.json contents. Either shape is accepted to keep the
 * UI form simple (just FileReader → fetch).
 *
 * SECURITY: admin only. An app-assigned (non-admin) user must not be able
 * to overwrite the operator's billing credentials with their own — see
 * the v1.27.34 security review (H2).
 */
router.put('/:slug/claude-credentials', requireAdmin, requireAppAccess, auditMiddleware('app-claude-credentials'), async (req, res) => {
  const body = req.body || {};
  const payload = body.credentials && typeof body.credentials === 'object'
    ? body.credentials
    : body;
  const { setCredentials, validateCredentials } = await import('../services/claudeCredentials.js');
  try {
    validateCredentials(payload);
    setCredentials(req.params.slug, payload);
    // Long-lived per-app builder containers mount credentials.json at
    // start-time only. If one is running, evict it so the next Build/
    // Code dispatch starts a fresh container with the new creds —
    // otherwise the user uploads new creds and the container keeps
    // using the stale (or absent) mount, surfacing as "Not logged in"
    // or "Credit balance is too low" depending on auth precedence.
    try {
      const { evict } = await import('../services/builder/appContainer.js');
      evict(req.params.slug, 'credentials-changed');
    } catch (_) {}
    // Return the fresh summary so the UI can update without a second fetch.
    const { credentialsInfo } = await import('../services/claudeCredentials.js');
    res.json(credentialsInfo(req.params.slug));
  } catch (e) {
    throw new AppError(`invalid credentials: ${e.message}`, 400, 'VALIDATION');
  }
});

/**
 * DELETE /api/apps/:slug/claude-credentials — clear stored creds. The next
 * dispatch falls back to the global ANTHROPIC_API_KEY.
 *
 * SECURITY: admin only. Same reasoning as PUT.
 */
router.delete('/:slug/claude-credentials', requireAdmin, requireAppAccess, auditMiddleware('app-claude-credentials'), async (req, res) => {
  const { clearCredentials } = await import('../services/claudeCredentials.js');
  clearCredentials(req.params.slug);
  // Same reasoning as PUT — evict the running builder so it stops
  // mounting the (now-deleted) creds and falls back to API key auth
  // on the next dispatch.
  try {
    const { evict } = await import('../services/builder/appContainer.js');
    evict(req.params.slug, 'credentials-cleared');
  } catch (_) {}
  res.json({ present: false });
});

export default router;
