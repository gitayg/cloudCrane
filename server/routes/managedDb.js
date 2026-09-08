import { Router } from 'express';
import { requireAuth, requireAppUser, requireAppAccess } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

/**
 * Managed databases — the HTTP surface.
 *
 * WHY THIS EXISTS. 22 of the catalogue's 61 images need an external database
 * and 503 without one: linuxserver/bookstack's own docs open with "This
 * application is dependent on a MariaDB database", so a one-click BookStack
 * install produced a blank page. The platform now runs ONE shared Postgres and
 * ONE shared MariaDB, and hands each app its OWN database and its OWN user
 * inside them.
 *
 * THIS FILE DOES NOT ISOLATE ANYTHING. That has to be said plainly, because the
 * usual instinct — "the app can only reach its own database because of the
 * network" — is false here, and reading it as true is how this feature gets
 * built wrong.
 *
 * server/services/docker.js:18-40 puts every app container on ONE shared
 * network with `enable_icc=false`, so the daemon drops container-to-container
 * traffic (a deliberate v2.42.1 fix: before it, any compromised app could reach
 * a sibling's origin behind Caddy with no auth, no audit, no rate limit). Apps
 * therefore cannot reach a database container over the docker network at all;
 * they reach it through the host gateway, the same route that already carries
 * CRANE_INTERNAL_URL=http://host.docker.internal:<port> (deployer.js:1349,
 * addHostGateway at :1382).
 *
 * The consequence is the whole security model: ANY container with the host
 * gateway can open a socket to the database server. Network isolation is not
 * available and is not coming — a network per app was considered and rejected
 * in docker.js because Docker's default address pools run out at 16-31
 * networks and the failure lands mid-deploy as an unrelated-looking subnet
 * error. So isolation lives INSIDE the engine (REVOKE ALL ON DATABASE … FROM
 * PUBLIC, REVOKE ALL ON SCHEMA public FROM PUBLIC, a NOSUPERUSER NOCREATEDB
 * role, per-database MariaDB grants), in server/services/managedDb.js. Nothing
 * in this router should be read as providing it.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR:
 *   1. Per-app authorization — who may create a database for WHICH app.
 *   2. Keeping the generated password server-side. The engine's provision()
 *      returns the password AND a `url` with it inline, by design, because the
 *      deployer needs both. This router discards that return value unread and
 *      builds every response from listForApp(), which never decrypts. See
 *      publicView().
 *   3. Naming the provisioning SCOPE, so multitenancy has somewhere to land.
 *
 * A NOTE ON THE PROSE BELOW. The per-route comments say "the app-user tier" and
 * "the app-access tier" rather than naming the middleware, and that is not
 * style. scripts/check-route-authz.mjs treats the literal strings
 * `requireAppAccess` / `requireAppUser` ANYWHERE in a route's block — comments
 * included — as evidence the route is guarded. With the names written out in
 * these doc comments, deleting the real guard from a route declaration left the
 * watchdog reporting OK (measured, twice). Keep the identifiers out of the
 * comments so the watchdog stays able to fail on a removed guard;
 * test/managed-db-routes.test.js covers the same ground from the other side.
 */

const router = Router();

router.use(requireAuth);

/**
 * The engine module, loaded on first use rather than at import.
 *
 * Dynamic import inside a handler is this repo's existing convention for
 * service dependencies (deployer.js:1345 does it for appServiceToken.js). Here
 * it also means an instance whose managed-database engine is unavailable fails
 * on these three routes instead of failing to boot.
 */
let enginePromise = null;
async function engineModule() {
  if (!enginePromise) {
    enginePromise = import('../services/managedDb.js').catch(() => {
      enginePromise = null; // don't cache the failure — a later request retries
      throw new AppError(
        'Managed databases are not available on this instance',
        503, 'MANAGED_DB_UNAVAILABLE'
      );
    });
  }
  return enginePromise;
}

/**
 * Test seam: swap the engine for a double. Not used by production code.
 *
 * Not a convenience. provision() calls ensureServer(), which docker-runs a real
 * Postgres or MariaDB container; a test suite that exercised the live engine
 * would pull images and hold ports. The double lets these routes be tested for
 * the two things they are actually responsible for — authorization, and not
 * leaking the credential — without that. test/managed-db-routes.test.js also
 * asserts the real module still exports what this file calls, so the double
 * cannot drift away from the engine unnoticed.
 */
export function __setEngineForTests(mod) {
  enginePromise = mod ? Promise.resolve(mod) : null;
}

/**
 * The provisioning scope, in the shape services/managedDb.js documents:
 * `{ appId, tenant }`, where tenant is null today — the app itself — and is
 * the dimension multitenancy will fill in. namesForScope() hashes the tenant
 * into the database and role names, so nothing downstream assumes the app is
 * the only dimension.
 *
 * `tenant` stays null here and the API REFUSES to accept one from the client —
 * see assertNoTenantScope(). A tenant dimension without an authorization model
 * for it is an IDOR with a nice name on it: user A would ask for tenant B's
 * database and this router has nothing to check that against. When per-tenant
 * provisioning ships, the check that authorizes the tenant ships with it.
 */
function scopeFor(app) {
  return { appId: app.id, tenant: null };
}

function assertNoTenantScope(tenant) {
  if (tenant !== undefined && tenant !== null) {
    throw new AppError(
      'Per-tenant databases are not implemented yet — provisioning is per-app. Omit `tenant`.',
      400, 'TENANT_SCOPE_UNSUPPORTED'
    );
  }
}

/**
 * A managed_databases row as the outside world may see it.
 *
 * Built field by field from an explicit list rather than by spreading the row.
 * listForApp() already selects only non-secret columns, but this router should
 * not be the thing that breaks if that SELECT ever becomes `SELECT *` — the
 * password_enc column is one careless edit away from a response body.
 *
 * THERE IS NO PASSWORD FIELD AND NONE SHOULD BE ADDED, in plaintext or
 * encrypted form. The credential is generated on the server, stored encrypted
 * (services/encryption.js) and injected into the container's environment at
 * deploy time. A response carrying it would put a live database credential into
 * a browser tab, then a screenshot, then a support ticket — and it buys
 * nothing, because no supported workflow asks a human to type it anywhere. An
 * app that needs it already has it in its own env.
 *
 * Host and port are omitted for the same reason they are not needed: the deploy
 * injects them. What a human wants from this endpoint is which engine, which
 * database, which user — exactly what is here.
 */
function publicView(row, app) {
  return {
    engine: row.engine,
    database: row.db_name,
    username: row.db_user,
    created_at: row.created_at,
    scope: { app: app.slug, tenant: row.tenant || null },
  };
}

/** This app's managed databases, across engines and (later) tenants. */
function listPublic(svc, app) {
  return svc.listForApp(app.id).map((row) => publicView(row, app));
}

/**
 * Re-throw an engine failure without echoing its message.
 *
 * The engine builds SQL that contains the generated password (provisionSql's
 * `CREATE ROLE … LOGIN PASSWORD '<pw>'`), and runAdminSql throws with the
 * command's output on failure. Passing err.message through would be a credible
 * route from "the database server hiccuped" to "the password is in the user's
 * browser console". An AppError is the engine author's deliberate,
 * caller-facing text and passes through; anything else becomes a fixed 502.
 */
function rethrowEngineError(err) {
  if (err instanceof AppError) throw err;
  throw new AppError(
    'The managed database engine failed to complete the request',
    502, 'MANAGED_DB_ENGINE_ERROR'
  );
}

/** Query params, read without req.query — see the note in the DELETE handler. */
function queryOf(req) {
  return new URL(req.url, `http://${req.headers.host}`).searchParams;
}

/**
 * Validate against the engine's own list rather than a copy of it. A second
 * allowlist in this file would be one more thing to keep in sync with the
 * module that turns the string into container and SQL identifiers.
 */
function assertKnownEngine(svc, engine) {
  if (!svc.SUPPORTED_ENGINES.includes(engine)) {
    throw new AppError(
      `engine must be one of: ${svc.SUPPORTED_ENGINES.join(', ')}`,
      400, 'INVALID_ENGINE'
    );
  }
}

/**
 * POST /api/apps/:slug/database — provision this app's database.
 *
 * Gated by the app-USER tier, not the app-access tier. Creating a database
 * issues a credential that will be injected into the app's environment, which
 * puts it in the same class as env vars and backups: assigned app users only,
 * and assignment is authoritative for every role including platform_admin
 * (auth.js:212). An unassigned admin gets the actionable "assign yourself"
 * error rather than a silent capability — the v2.39.0 guardrail, applied to a
 * new resource that would otherwise have quietly opted out of it.
 *
 * Idempotent: the engine returns the existing database for a scope rather than
 * creating a second one or rotating the credential out from under a running
 * container. An app may hold one database per engine, so asking for mariadb
 * when postgres exists provisions the second rather than erroring — that is the
 * engine's model (rows key on app + tenant + engine), not a special case here.
 */
router.post('/:slug/database', requireAppUser, auditMiddleware('managed-db-provision'), async (req, res) => {
  const body = req.body || {};
  assertNoTenantScope(body.tenant);

  const svc = await engineModule();
  const engine = String(body.engine || '').toLowerCase();
  assertKnownEngine(svc, engine);

  const scope = scopeFor(req.app);
  try {
    // The return value is DELIBERATELY DISCARDED. provision() resolves to the
    // full connection details including the plaintext password and a URL with
    // it embedded — the deployer's input, not an API response. Never bind it to
    // a variable here; the response is rebuilt from listForApp(), which does
    // not decrypt anything.
    await svc.provision(scope, engine);
  } catch (err) {
    rethrowEngineError(err);
  }

  const databases = listPublic(svc, req.app);
  res.json({
    database: databases.find((d) => d.engine === engine) || null,
    databases,
    message:
      'Database ready. The credential is stored encrypted and injected into the '
      + 'container environment on the next deploy — it is deliberately not returned here.',
  });
});

/**
 * GET /api/apps/:slug/database — what this app currently has provisioned.
 *
 * Gated by the app-ACCESS tier, one step below the write. This mirrors
 * backups.js, where creating a backup takes the app-user tier and listing them
 * takes app-access: the read returns identifiers (engine, database name, user)
 * and no credential, so it is app info rather than app secrets. Either way it
 * is per-app — a logged-in user with no relationship to this app gets 403.
 *
 * 200 with an empty list rather than 404 when nothing is provisioned: "this app
 * has no database" is an answer, and the UI needs to distinguish it from "no
 * such app", which the app-access gate already 404s.
 */
router.get('/:slug/database', requireAppAccess, async (req, res) => {
  const svc = await engineModule();

  let databases;
  try {
    databases = listPublic(svc, req.app);
  } catch (err) {
    rethrowEngineError(err);
  }

  res.json({ databases, engines: svc.SUPPORTED_ENGINES });
});

/**
 * DELETE /api/apps/:slug/database?engine=<engine>&confirm=<slug>
 *
 * Drops the database and its login role. Destructive and unrecoverable, so it
 * takes an explicit confirmation in addition to authorization — a DELETE
 * reachable by URL alone is a DELETE reachable by a mistyped path in a script.
 * `engine` is required rather than defaulted: an app may hold both, and
 * guessing which one to destroy is not a thing this endpoint should do.
 */
router.delete('/:slug/database', requireAppUser, auditMiddleware('managed-db-deprovision'), async (req, res) => {
  const svc = await engineModule();

  // Express 5's req.query getter reads through `this.app` — and the app-access
  // middleware has by then replaced req.app with the AppCrane app ROW, so the
  // getter throws. envVars.js:60 hit the same trap and documents the same fix.
  const q = queryOf(req);
  const engine = String(q.get('engine') || '').toLowerCase();
  assertKnownEngine(svc, engine);

  if (q.get('confirm') !== req.app.slug) {
    throw new AppError(
      `Deprovisioning destroys this database and its data. Pass confirm=${req.app.slug} to proceed.`,
      400, 'CONFIRM_REQUIRED'
    );
  }

  const scope = scopeFor(req.app);
  let removed;
  try {
    removed = await svc.deprovision(scope, engine);
  } catch (err) {
    rethrowEngineError(err);
  }

  res.json({
    removed: Boolean(removed),
    databases: listPublic(svc, req.app),
    message: removed
      ? 'Database and user removed. The app will lose its connection on the next deploy.'
      : `No ${engine} database was provisioned for this app.`,
  });
});

export default router;
