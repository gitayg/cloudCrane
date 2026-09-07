#!/usr/bin/env node
/**
 * Watchdog: every app-scoped route must enforce per-app authorization.
 *
 * Why this exists: missing per-tenant authorization on `:slug`-style routes
 * (IDOR / cross-tenant access) is one of the two bug classes behind the 2026
 * disclosure wave against self-hosted PaaS products — Coolify and Dokploy
 * between them published 130 advisories, 55 of them critical, dominated by
 * this and by shell injection (see check-shell-injection.mjs). `requireAuth`
 * alone is NOT enough: it proves *a* user, not that this user may touch THIS
 * app. See the "Per-app authz on per-app resources" feedback memory.
 *
 * A route is app-scoped if its path contains an app identifier param
 * (:slug / :appSlug). Such a route is considered guarded when ANY of:
 *   1. inline middleware in the route declaration (requireAppAccess, …)
 *   2. a file-level `router.use(...)` carrying such a guard
 *   3. an explicit ownership check inside the handler body (ask.js does this)
 *
 * Exit 0 always, unless --strict, which exits 1 on findings. Same contract as
 * check-role-patterns.sh so it can be wired into the pre-commit hook and CI.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(ROOT, 'server', 'routes');
const STRICT = process.argv.includes('--strict');

// Middleware that establishes the caller may act on THIS app (or is a
// platform-wide admin, which is allowed everywhere by design).
const APP_GUARDS = [
  'requireAppAccess', 'requireAppUser', 'requireAdmin', 'requirePlatformAdmin',
];

// Evidence of an ownership/access check performed inside the handler itself.
const IN_HANDLER_MARKERS = [
  'requireAppAccess', 'getAppForUser', 'roleForUserOnApp', 'userHasAppPermission',
  'FROM app_users', 'FROM app_user_roles', 'isAppAdmin', 'appForServiceToken',
  'requireDomainAdmin',
  // An explicit admin-only gate inside the handler is also sufficient: a
  // platform/global admin is authorized on every app by design.
  "role !== 'admin'", 'role !== "admin"',
];

// Routes that are intentionally unauthenticated, with the reason they're safe.
// Keep this list short and justified — every entry is a deliberate exception.
const ALLOWLIST = {
  'webhooks.js POST /:token':
    'GitHub webhook — authenticated by an unguessable token + HMAC signature, not a user session',
  'apps.js POST /:slug/deployment-key':
    'Retired in v2.6.0 — returns 410 GONE unconditionally, touches no data',
  'apps.js POST /:slug/deployment-key/recycle':
    'Retired in v2.6.0 — returns 410 GONE unconditionally, touches no data',
  'ask.js GET /sessions/:appSlug':
    'Query is scoped `WHERE app_slug = ? AND user_id = ?` — returns only the caller\'s own sessions',
  'catalog.js GET /:slug/versions':
    'The :slug is a CATALOGUE slug (a curated public project like `odoo`), not an AppCrane app '
    + 'slug — there is no per-app permission that could apply, because the catalogue is identical '
    + 'for every user. The router is behind requireAuth (catalog.js:30), and findEntry() matches '
    + 'the slug against the shipped manifest by exact equality and 404s before any network call, '
    + 'so a caller-supplied slug can never reach an outbound URL.',
};

const APP_PARAM_RE = /:(?:slug|appSlug)\b/;
const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)(?:=>|function)/g;

const findings = [];
const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js')).sort();

for (const file of files) {
  const src = readFileSync(join(ROUTES_DIR, file), 'utf8');

  // File-level guards: identifiers passed to router.use(...) on one line.
  const fileGuards = [...src.matchAll(/router\.use\(([^)]*)\)/g)]
    .flatMap(m => APP_GUARDS.filter(g => m[1].includes(g)));

  // File-local authorization helpers. Several routers do the per-app check via
  // a small helper defined once at the top (coder.js's `getApp(slug, user)`
  // queries app_users and throws 403). Those live outside any route body, so
  // find them here and treat a CALL to one as satisfying authorization.
  const localHelpers = [];
  for (const m of src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g)) {
    const bodyStart = m.index + m[0].length;
    // Crude but sufficient: scan a window forward to the next top-level
    // `function`/`router.` declaration and look for an authz query.
    const nextDecl = src.slice(bodyStart).search(/\n(?:function\s|router\.|const\s+router)/);
    const body = src.slice(bodyStart, nextDecl === -1 ? src.length : bodyStart + nextDecl);
    if (IN_HANDLER_MARKERS.some(marker => body.includes(marker))) localHelpers.push(`${m[1]}(`);
  }

  // Split into route blocks so a handler body can be inspected.
  const routeStarts = [...src.matchAll(ROUTE_RE)];
  for (let i = 0; i < routeStarts.length; i++) {
    const m = routeStarts[i];
    const [, method, path, chain] = m;
    if (!APP_PARAM_RE.test(path)) continue;                 // not app-scoped

    const key = `${file} ${method.toUpperCase()} ${path}`;
    if (ALLOWLIST[key]) continue;

    const inlineGuard = APP_GUARDS.some(g => chain.includes(g));
    const fileGuard   = fileGuards.length > 0;

    // Handler body = from this route to the start of the next one.
    const bodyStart = m.index;
    const bodyEnd = i + 1 < routeStarts.length ? routeStarts[i + 1].index : src.length;
    const body = src.slice(bodyStart, bodyEnd);
    const inHandler = IN_HANDLER_MARKERS.some(marker => body.includes(marker))
      || localHelpers.some(fn => body.includes(fn));

    if (!inlineGuard && !fileGuard && !inHandler) {
      const line = src.slice(0, bodyStart).split('\n').length;
      findings.push({ file, line, key });
    }
  }
}

if (findings.length === 0) {
  console.log('[check-route-authz] OK — every app-scoped route enforces per-app authorization.');
  process.exit(0);
}

console.error('[check-route-authz] App-scoped routes with no per-app authorization:\n');
for (const f of findings) {
  console.error(`  server/routes/${f.file}:${f.line}  ${f.key}`);
}
console.error(`
${findings.length} route(s) take an app identifier but never check the caller may
access THAT app. requireAuth alone is not sufficient — it proves a valid user,
not an authorized one. Fix by adding requireAppAccess/requireAppUser to the
route, or an explicit ownership check in the handler. If the route is
deliberately public, add it to ALLOWLIST in this script with a reason.`);
process.exit(STRICT ? 1 : 0);
