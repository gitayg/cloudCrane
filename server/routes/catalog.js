import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';
import { isAdmin } from '../utils/roles.js';
import { userHasPlatformPermission } from '../services/permissions.js';
import {
  loadCatalog, findEntry, getVersions, getEnrichment, enrichmentStatus,
  maybeRefreshInBackground, normalizeGithubUrl, normalizeImageRef,
} from '../services/catalogService.js';

// The catalogue page: 76 curated self-hostable apps, readable by every logged-in
// user, deployable by whoever holds `platform.create_app`.
//
// READ IS NOT DEPLOY. requireAuth, not requireAdmin — the point of the page is
// that a user without create rights can browse it and ask for one. What they
// may DO is reported in the payload (`can_create_app`) so the UI disables the
// button instead of offering it and then 403ing.
//
// THERE IS NO INSTALL ENDPOINT HERE, deliberately. POST /api/apps (routes/apps.js)
// already accepts every field an install needs — name, domain, source_type,
// github_url, branch, image_ref, container_port, auth_mode, public_access,
// health_path — behind the `platform.create_app` gate, with its own audit
// middleware and policy checks. A second route into app creation would be a
// second authorization surface to keep in sync with the first, and the pair
// would drift the first time one of them gained a check. The page posts to the
// existing endpoint.

const router = Router();
router.use(requireAuth);

/**
 * A platform admin can switch the catalogue off entirely (Settings -> Security).
 * Hiding the nav entry alone would be cosmetic: the routes would still answer,
 * and this endpoint reaches out to GitHub and Docker Hub, which is exactly what
 * an operator turning it off is likely trying to stop. So the gate is here, on
 * the server, and the nav follows it rather than the other way round.
 *
 * DEFAULT IS ON. An absent row means enabled — only an explicit '0' disables,
 * so an existing instance keeps the catalogue after upgrading without anyone
 * having to opt in.
 */
router.use((req, res, next) => {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'catalog_enabled'").get();
  if (row && row.value === '0') {
    return next(new AppError('The app catalogue is disabled on this instance', 404, 'CATALOG_DISABLED'));
  }
  next();
});

/**
 * Apps this caller is allowed to be told exist.
 *
 * SECURITY: this deliberately mirrors GET /api/apps exactly — admins see every
 * app, everyone else sees every app EXCEPT visibility='hidden'. Matching that
 * rule is the whole point: the catalogue's "already installed" badge must not
 * become a side channel that reveals an app the app list itself withholds. A
 * hidden app is hidden here too, so a non-admin sees the catalogue entry as
 * NOT installed — which is exactly what /api/apps tells them, and telling two
 * different stories is what an information leak looks like from the inside.
 */
function visibleApps(db, user) {
  if (isAdmin(user)) {
    return db.prepare('SELECT slug, name, github_url, image_ref, source_type FROM apps').all();
  }
  return db.prepare(
    "SELECT slug, name, github_url, image_ref, source_type FROM apps WHERE visibility != 'hidden'"
  ).all();
}

/** slug/image indexes over the apps this caller may see. */
function installedIndex(apps) {
  const byRepo = new Map();
  const byImage = new Map();
  for (const a of apps) {
    const repo = normalizeGithubUrl(a.github_url);
    if (repo) {
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(a);
    }
    const img = normalizeImageRef(a.image_ref);
    if (img) {
      if (!byImage.has(img)) byImage.set(img, []);
      byImage.get(img).push(a);
    }
  }
  return { byRepo, byImage };
}

function installedFor(entry, index) {
  const seen = new Map();
  const repoKey = typeof entry.repo === 'string' ? entry.repo.trim().toLowerCase() : null;
  for (const a of (repoKey ? index.byRepo.get(repoKey) || [] : [])) seen.set(a.slug, { app: a, matched: 'repo' });
  const imgKey = normalizeImageRef(entry.image);
  for (const a of (imgKey ? index.byImage.get(imgKey) || [] : [])) {
    if (!seen.has(a.slug)) seen.set(a.slug, { app: a, matched: 'image' });
  }
  return [...seen.values()].map(({ app, matched }) => ({ slug: app.slug, name: app.name, matched_on: matched }));
}

/**
 * GET /api/catalog — the manifest plus whatever live figures are cached.
 *
 * This never awaits the network. A stale cache triggers a background refresh
 * and the request returns immediately with what is already known, which is
 * sometimes nothing: an entry that has never been enriched carries
 * `enrichment: null` and the page renders it without figures. That is the
 * required behaviour, not a degraded one — a catalogue that 500s or hangs
 * because Docker Hub is throttling is worse than a catalogue without stars.
 */
router.get('/', (req, res, next) => {
  let entries;
  try {
    entries = loadCatalog();
  } catch (err) {
    return next(new AppError(`Catalogue unavailable: ${err.message}`, 500, 'CATALOG_UNAVAILABLE'));
  }

  maybeRefreshInBackground();

  const db = getDb();
  const index = installedIndex(visibleApps(db, req.user));
  const canCreate = userHasPlatformPermission(req.user, 'platform.create_app');

  const apps = entries.map((entry) => {
    const installed = installedFor(entry, index);
    return {
      ...entry,
      enrichment: getEnrichment(entry.slug),
      installed,
      is_installed: installed.length > 0,
    };
  });

  const categories = [...new Set(apps.map(a => a.category).filter(Boolean))].sort();

  res.json({
    catalog: apps,
    count: apps.length,
    categories,
    // What this caller may do with the page, so the UI never offers a button
    // that will 403. Read access is universal; deploying is not.
    can_create_app: canCreate,
    enrichment: enrichmentStatus(),
  });
});

/**
 * GET /api/catalog/:slug/versions — both version sets, capped.
 *
 * GitHub releases/tags and image tags are returned SEPARATELY and labelled,
 * because they are different facts. Merging them into one "version" list would
 * let the page show a release number beside a deploy-from-image button and
 * imply the deploy delivers it, which is false whenever the image lags the
 * release or is built from an unreleased branch.
 */
router.get('/:slug/versions', async (req, res, next) => {
  const entry = findEntry(req.params.slug);
  if (!entry) return next(new AppError(`No catalogue entry '${req.params.slug}'`, 404, 'NOT_FOUND'));
  try {
    const payload = await getVersions(entry.slug);
    res.json(payload);
  } catch (err) {
    next(new AppError(`Could not read versions: ${err.message}`, 502, 'CATALOG_UPSTREAM'));
  }
});

export default router;
