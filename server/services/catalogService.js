import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseImageRef } from './imageSource.js';

// The curated catalogue of self-hostable apps, and the live figures beside it.
//
// Three properties drive every decision in this file.
//
// 1. NOTHING IS DOWNLOADED. The repo ships `appCatalog.json` — names, repos and
//    image references. Image CONTENT is pulled by services/imageSource.js
//    `pullImage()` on the AppCrane host at DEPLOY time, and by nothing else.
//    Existence is checked with `docker manifest inspect`, which fetches manifest
//    JSON. This module talks to two HTTP APIs for metadata and never to a
//    registry blob endpoint.
//
// 2. NO FIGURE IS COMMITTED. A star count written into the repo is true the day
//    it is written and misleading a month later, so the manifest carries none.
//    Every number here is fetched at runtime and cached, which makes the cache
//    the feature rather than an optimisation — see the outage rule below.
//
// 3. THE PAGE MUST RENDER WHEN THE INTERNET DOES NOT. GitHub rate-limits
//    unauthenticated callers at 60 requests/hour and 76 repos need more than
//    that, so a refresh WILL sometimes fail. A catalogue that 500s because
//    Docker Hub is throttling is worse than one showing no stars. Therefore:
//    the read path never awaits the network, a failed refresh leaves the
//    previous cache in place (stale forever beats empty), and an entry that has
//    never been enriched renders with `enrichment: null`.
//
// SSRF. The manifest is repo data, but enrichment talks to the public internet,
// so no manifest field is ever interpolated into a URL. Hosts come from a fixed
// allowlist that no input can influence; the `owner/repo` and image-reference
// shapes are validated and then percent-encoded per path segment; the final URL
// is re-parsed and its hostname re-checked before the request. This is a
// stricter posture than services/remoteFetch.js needs — that one resolves and
// filters addresses because the HOST itself is caller-supplied. Here the host is
// a constant, so there is no attacker-chosen destination to resolve.

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'appCatalog.json');

// The complete set of hosts this module may contact. Not a prefix match, not a
// suffix match — set membership on the parsed hostname.
const ALLOWED_HOSTS = new Set(['api.github.com', 'hub.docker.com']);

// Registries whose metadata Docker Hub's public API can answer for. An image on
// ghcr.io / quay.io / a private registry is a normal, expected case: it gets no
// pull count and no tag list, reported as `source: 'unsupported'` rather than
// as an error.
const DOCKER_HUB_REGISTRIES = new Set([null, 'docker.io', 'index.docker.io', 'registry-1.docker.io']);

const ENRICH_TTL_MS = 6 * 60 * 60 * 1000;   // figures on the catalogue page
// A refresh that only PARTIALLY filled the cache is retried far sooner.
//
// Measured on this host against the real APIs with no token: a cold refresh of
// the 76 entries enriched 34 of them and then hit GitHub's anonymous ceiling of
// 60 requests/hour, after which every remaining repo answered 403. Under the
// six-hour TTL those 42 entries would have stayed blank for six hours, which
// reads to a user as "this project has no stars" rather than "we have not asked
// yet". Retrying on a short cycle lets each hourly quota window fill in another
// slice until the catalogue is complete. Setting CATALOG_GITHUB_TOKEN raises the
// ceiling to 5000/hour and the first refresh completes outright.
const PARTIAL_TTL_MS = 15 * 60 * 1000;
const VERSIONS_TTL_MS = 60 * 60 * 1000;     // the per-app version dropdown
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_BUDGET_MS = 90_000;
const CONCURRENCY = 6;

// Newest N. Some projects have thousands of tags; returning all of them is a
// denial of service against AppCrane's own page, paid for by AppCrane's own
// bandwidth. 20 is a dropdown, not a database.
export const VERSION_CAP = 20;

// Tags that name a moving pointer rather than a version. Excluded when picking
// "the latest image version" — reporting `latest` as the version answers the
// question with the question.
const FLOATING_TAGS = new Set([
  'latest', 'main', 'master', 'edge', 'nightly', 'dev', 'develop',
  'stable', 'rolling', 'beta', 'alpha', 'canary', 'next', 'unstable',
]);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

let manifestCache = null;   // { entries, mtimeMs }

/**
 * The manifest, parsed. Re-read when the file's mtime changes.
 *
 * A failed re-read keeps the previous good copy. The manifest is a checked-in
 * file that gets edited, and a read that lands mid-write yields truncated JSON;
 * serving the last good parse is strictly better than serving a 500 because
 * somebody was saving the file.
 */
export function loadCatalog() {
  let mtimeMs = null;
  try { mtimeMs = statSync(MANIFEST_PATH).mtimeMs; } catch (_) { mtimeMs = null; }
  if (manifestCache && mtimeMs !== null && manifestCache.mtimeMs === mtimeMs) {
    return manifestCache.entries;
  }
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('appCatalog.json is not an array');
    manifestCache = { entries: Object.freeze(parsed), mtimeMs };
    return manifestCache.entries;
  } catch (err) {
    if (manifestCache) return manifestCache.entries;
    throw new Error(`catalogue manifest unreadable: ${err.message}`);
  }
}

export function findEntry(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  return loadCatalog().find(e => e && e.slug === slug) || null;
}

// ---------------------------------------------------------------------------
// URL construction — the whole SSRF surface, in one place
// ---------------------------------------------------------------------------

// A GitHub owner or repository name. GitHub's own rules are narrower than this
// (no leading dot on an owner, etc.); being slightly permissive is fine because
// the output is percent-encoded anyway. What matters is that '/', '..', '@',
// ':' and every other path- or authority-bending character is absent.
const GH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Split a manifest `repo` into {owner, repo}, or null if it is not that shape. */
export function parseRepoField(repo) {
  if (typeof repo !== 'string') return null;
  const parts = repo.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  for (const p of [owner, name]) {
    if (!GH_SEGMENT_RE.test(p)) return null;
    // Belt and braces against a traversal segment slipping through a future
    // loosening of the regex above.
    if (p === '.' || p === '..') return null;
  }
  return { owner, repo: name };
}

/**
 * Build an api.github.com URL for a validated repo, or return null.
 *
 * `path` is chosen by THIS module from a closed set of literals; only the
 * owner/repo segments come from the manifest and both are encoded. The result
 * is re-parsed and its hostname re-checked, so a bug in the assembly above
 * cannot produce a request to somewhere else.
 */
export function githubApiUrl(repoField, path = '', query = '') {
  const parsed = parseRepoField(repoField);
  if (!parsed) return null;
  const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  return assertAllowedUrl(base + path + query);
}

/** Docker Hub coordinates for an image reference, or null if Hub can't answer. */
export function dockerHubRepo(imageRef) {
  if (typeof imageRef !== 'string' || !imageRef.trim()) return null;
  let parsed;
  try { parsed = parseImageRef(imageRef); } catch (_) { return null; }
  if (!DOCKER_HUB_REGISTRIES.has(parsed.registry)) return null;
  const parts = parsed.name.split('/');
  // An unqualified single-component name is an official image: 'odoo' lives at
  // library/odoo on the Hub API even though `docker pull odoo` works.
  const namespace = parts.length === 1 ? 'library' : parts[0];
  const name = parts.length === 1 ? parts[0] : parts.slice(1).join('/');
  // The Hub API addresses a repository with exactly two path segments.
  if (!namespace || !name || name.includes('/')) return null;
  return { namespace, name };
}

export function dockerHubUrl(imageRef, path = '', query = '') {
  const repo = dockerHubRepo(imageRef);
  if (!repo) return null;
  const base = `https://hub.docker.com/v2/repositories/${encodeURIComponent(repo.namespace)}/${encodeURIComponent(repo.name)}`;
  return assertAllowedUrl(base + path + query);
}

/** Re-parse a URL and confirm scheme + host. Returns the string, or null. */
export function assertAllowedUrl(candidate) {
  let u;
  try { u = new URL(candidate); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(u.hostname)) return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  return u.toString();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Swappable so tests can drive every branch — outage, throttle, malformed body
// — without a network. The SSRF checks run BEFORE this is called and are pure
// functions tested on their own, so replacing it does not replace them.
let fetchImpl = (...args) => globalThis.fetch(...args);
export function setFetchImpl(fn) { fetchImpl = fn || ((...a) => globalThis.fetch(...a)); }

function githubHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AppCrane-Catalog',
  };
  // Optional. Unauthenticated GitHub allows 60 requests/hour, which one refresh
  // of 76 repos exceeds on its own; an operator who sets a token gets 5000.
  // Server-side is the point — a token in the browser would be a token given
  // away.
  const token = process.env.CATALOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * GET a JSON body from an already-validated URL.
 *
 * Returns `{ ok: true, data }`, or `{ ok: false, reason }`. Never throws: every
 * caller's correct response to a failure is "no figure", and an exception
 * escaping into the refresh loop would take the other 75 entries with it.
 */
async function getJson(url, headers) {
  if (!url) return { ok: false, reason: 'invalid-url' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: ac.signal, redirect: 'follow' });
    // A redirect is followed (api.github.com 301s a renamed repository) but the
    // landing host is checked: following a redirect off the allowlist would
    // undo the check done on the original URL.
    const finalUrl = res.url || url;
    let host = null;
    try { host = new URL(finalUrl).hostname; } catch (_) { host = null; }
    if (host && !ALLOWED_HOSTS.has(host)) return { ok: false, reason: 'redirected-off-allowlist' };
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate-limited' };
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `jobs` with bounded concurrency. Each job resolves; none rejects. */
async function pool(items, worker, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------------------
// Upstream reads
// ---------------------------------------------------------------------------

function releaseName(r) {
  // `tag_name` is the thing a user would pin; `name` is a marketing title and
  // is frequently empty or a duplicate of the tag.
  return (r && (r.tag_name || r.name)) || null;
}

/**
 * Stars plus the newest GitHub version.
 *
 * Of the 76 catalogued projects, 69 publish Releases, 6 only push tags (they
 * cut no GitHub Release at all) and 1 has neither. So the tag list is a real
 * fallback rather than defensive padding, and "no version" is a real answer
 * that must be rendered honestly rather than filled in with something invented.
 */
export async function fetchGithubFacts(repoField) {
  const repoUrl = githubApiUrl(repoField);
  if (!repoUrl) return { stars: null, version: null, source: 'invalid-repo' };

  const headers = githubHeaders();
  const [repoRes, relRes] = await Promise.all([
    getJson(repoUrl, headers),
    getJson(githubApiUrl(repoField, '/releases/latest'), headers),
  ]);

  const stars = repoRes.ok && Number.isFinite(repoRes.data?.stargazers_count)
    ? repoRes.data.stargazers_count
    : null;

  if (relRes.ok && releaseName(relRes.data)) {
    return {
      stars,
      version: { value: releaseName(relRes.data), kind: 'release', published_at: relRes.data.published_at || null },
      source: 'releases',
    };
  }

  // 404 from /releases/latest means "this project cuts no Releases" — the
  // tag-only case. Any other failure (throttle, timeout) is NOT that, and
  // falling through to /tags would spend another request on a doomed call.
  if (relRes.reason && relRes.reason !== 'not-found') {
    return { stars, version: null, source: relRes.reason };
  }

  const tagsRes = await getJson(githubApiUrl(repoField, '/tags', '?per_page=1'), headers);
  if (tagsRes.ok && Array.isArray(tagsRes.data) && tagsRes.data[0]?.name) {
    return { stars, version: { value: tagsRes.data[0].name, kind: 'tag', published_at: null }, source: 'tags' };
  }
  // Neither releases nor tags. Reported as null, and the UI says "no version".
  return { stars, version: null, source: tagsRes.ok ? 'none' : (tagsRes.reason || 'none') };
}

/** Pull count plus the newest non-floating image tag. */
export async function fetchImageFacts(imageRef) {
  const repoUrl = dockerHubUrl(imageRef);
  if (!repoUrl) {
    // Either the manifest has no image for this entry (a normal case — an entry
    // whose image did not resolve carries `image: null`), or the image lives on
    // a registry whose metadata Docker Hub cannot answer for.
    return { pulls: null, version: null, source: imageRef ? 'unsupported-registry' : 'no-image' };
  }

  const [repoRes, tagsRes] = await Promise.all([
    getJson(repoUrl, { 'User-Agent': 'AppCrane-Catalog' }),
    getJson(dockerHubUrl(imageRef, '/tags', `?page_size=${VERSION_CAP * 5}&ordering=last_updated`),
      { 'User-Agent': 'AppCrane-Catalog' }),
  ]);

  const pulls = repoRes.ok && Number.isFinite(repoRes.data?.pull_count) ? repoRes.data.pull_count : null;

  let version = null;
  if (tagsRes.ok && Array.isArray(tagsRes.data?.results)) {
    const named = tagsRes.data.results
      .map(t => ({ name: t?.name, last_updated: t?.last_updated || null }))
      .filter(t => typeof t.name === 'string' && t.name);
    const concrete = named.find(t => !FLOATING_TAGS.has(t.name.toLowerCase()));
    if (concrete) version = { value: concrete.name, kind: 'tag', published_at: concrete.last_updated };
  }

  const source = repoRes.ok || tagsRes.ok ? 'dockerhub' : (repoRes.reason || tagsRes.reason || 'error');
  return { pulls, version, source };
}

// ---------------------------------------------------------------------------
// Enrichment cache
// ---------------------------------------------------------------------------

const enrichment = new Map();   // slug -> record
let lastRefreshAt = null;       // ms, last COMPLETED refresh (successful or not)
let lastSuccessAt = null;       // ms, last refresh that produced at least one figure
let inFlight = null;            // de-duplicates concurrent refreshes

export function getEnrichment(slug) { return enrichment.get(slug) || null; }

export function enrichmentStatus() {
  const withFigures = [...enrichment.values()].filter(r => r.stars !== null || r.pulls !== null).length;
  let total = 0;
  try { total = loadCatalog().length; } catch (_) { total = 0; }
  const complete = total > 0 && withFigures >= total;
  const ttl = complete ? ENRICH_TTL_MS : PARTIAL_TTL_MS;
  return {
    entries_total: total,
    entries_cached: enrichment.size,
    entries_with_figures: withFigures,
    complete,
    fetched_at: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    last_attempt_at: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    stale: !lastSuccessAt || (Date.now() - lastSuccessAt) > ttl,
    refreshing: inFlight !== null,
    // Named so the page can say WHY there are no numbers instead of rendering
    // an unexplained blank.
    degraded: withFigures === 0,
  };
}

/**
 * Refresh every entry's figures.
 *
 * A per-entry failure writes nothing, so the previous value survives. That is
 * the outage rule: the cache is not a copy of upstream, it is the last thing
 * upstream successfully said, and it is served for as long as upstream cannot
 * say anything better.
 */
export async function refreshEnrichment({ force = false } = {}) {
  if (inFlight) return inFlight;
  // One freshness rule, read from one place, so a partial cache cannot be
  // reported stale to the page and fresh to the refresher.
  if (!force && !enrichmentStatus().stale) {
    return { skipped: 'fresh', ...enrichmentStatus() };
  }
  const deadline = Date.now() + REFRESH_BUDGET_MS;
  const run = (async () => {
    let entries;
    try { entries = loadCatalog(); } catch (_) { entries = []; }
    let updated = 0;
    await pool(entries, async (entry) => {
      if (!entry || typeof entry.slug !== 'string') return;
      if (Date.now() > deadline) return;
      const [gh, img] = await Promise.all([
        fetchGithubFacts(entry.repo),
        fetchImageFacts(entry.image),
      ]);
      const prev = enrichment.get(entry.slug) || null;
      const got = gh.stars !== null || gh.version || img.pulls !== null || img.version;
      // Learned nothing. Whatever was already there survives, and an entry that
      // never had anything stays ABSENT rather than gaining a record of nulls —
      // a row of nulls carrying `sources: {github: 'network-error'}` reads to
      // the page as "enriched, and the answer is zero stars", which is a
      // different and false claim from "not enriched".
      if (!got) return;
      updated++;
      enrichment.set(entry.slug, {
        stars: gh.stars !== null ? gh.stars : (prev?.stars ?? null),
        pulls: img.pulls !== null ? img.pulls : (prev?.pulls ?? null),
        github_version: gh.version || prev?.github_version || null,
        image_version: img.version || prev?.image_version || null,
        sources: { github: gh.source, image: img.source },
        fetched_at: new Date().toISOString(),
      });
    });
    lastRefreshAt = Date.now();
    if (updated > 0) lastSuccessAt = lastRefreshAt;
    return { updated, ...enrichmentStatus() };
  })();
  inFlight = run.finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Kick a refresh if the cache is stale, WITHOUT awaiting it.
 *
 * The read path must not inherit the latency of 152 upstream calls, and must
 * not fail when they do. This is the only thing GET /api/catalog does about
 * freshness.
 */
export function maybeRefreshInBackground() {
  const s = enrichmentStatus();
  if (!s.stale || s.refreshing) return false;
  refreshEnrichment().catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Version lists (the pin-a-version dropdown)
// ---------------------------------------------------------------------------

const versionsCache = new Map();   // slug -> { at, ttl, payload }

// A response that learned nothing is still cached, briefly. Without it, a slug
// whose upstream is throttling re-issues three outbound requests on every hit,
// and an authenticated user holding down the dropdown becomes an amplifier
// pointed at GitHub from AppCrane's IP — which is how the throttle got there.
const VERSIONS_EMPTY_TTL_MS = 60_000;

export async function getVersions(slug) {
  const entry = findEntry(slug);
  if (!entry) return null;

  const hit = versionsCache.get(slug);
  if (hit && (Date.now() - hit.at) < hit.ttl) {
    return { ...hit.payload, cached: true };
  }

  const headers = githubHeaders();
  const [relRes, tagRes, imgRes] = await Promise.all([
    getJson(githubApiUrl(entry.repo, '/releases', `?per_page=${VERSION_CAP}`), headers),
    getJson(githubApiUrl(entry.repo, '/tags', `?per_page=${VERSION_CAP}`), headers),
    getJson(dockerHubUrl(entry.image, '/tags', `?page_size=${VERSION_CAP}&ordering=last_updated`),
      { 'User-Agent': 'AppCrane-Catalog' }),
  ]);

  const releases = relRes.ok && Array.isArray(relRes.data)
    ? relRes.data.filter(r => releaseName(r)).slice(0, VERSION_CAP).map(r => ({
        name: releaseName(r),
        published_at: r.published_at || null,
        prerelease: !!r.prerelease,
      }))
    : [];
  const tags = tagRes.ok && Array.isArray(tagRes.data)
    ? tagRes.data.filter(t => t?.name).slice(0, VERSION_CAP).map(t => ({ name: t.name }))
    : [];

  // Both sets are returned, always, and they are labelled. A GitHub release
  // shown next to a deploy-from-image button implies that deploying gets you
  // that version, and sometimes it does not: a project can cut v3.2.0 while its
  // :latest image still carries the previous build, or publish images from a
  // branch it never releases. Conflating them would state something false; the
  // honest interface is to name both facts and let the user pick.
  const github = {
    source: releases.length ? 'releases' : (tags.length ? 'tags' : 'none'),
    releases,
    tags,
    available: releases.length > 0 || tags.length > 0,
    error: relRes.ok || tagRes.ok ? null : (relRes.reason || tagRes.reason),
  };

  const hubRepo = dockerHubRepo(entry.image);
  const imageTags = imgRes.ok && Array.isArray(imgRes.data?.results)
    ? imgRes.data.results.filter(t => t?.name).slice(0, VERSION_CAP)
        .map(t => ({ name: t.name, last_updated: t.last_updated || null }))
    : [];
  const image = {
    ref: entry.image || null,
    source: !entry.image ? 'no-image' : (hubRepo ? 'dockerhub' : 'unsupported-registry'),
    tags: imageTags,
    available: imageTags.length > 0,
    error: !entry.image || !hubRepo ? null : (imgRes.ok ? null : imgRes.reason),
  };

  const payload = {
    slug: entry.slug,
    name: entry.name,
    cap: VERSION_CAP,
    github,
    image,
    fetched_at: new Date().toISOString(),
  };

  // A useful answer is held for an hour; an empty one for a minute. Caching a
  // throttled minute's emptiness for the full hour would blank the dropdown
  // long after upstream recovered.
  const learned = github.available || image.available;
  versionsCache.set(slug, {
    at: Date.now(),
    ttl: learned ? VERSIONS_TTL_MS : VERSIONS_EMPTY_TTL_MS,
    payload,
  });
  return { ...payload, cached: false };
}

// ---------------------------------------------------------------------------
// Installed matching
// ---------------------------------------------------------------------------

/** 'https://github.com/Owner/Repo.git' -> 'owner/repo'. Null when not a repo URL. */
export function normalizeGithubUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try { u = new URL(url.trim()); } catch (_) { return null; }
  if (!/^github\.com$/i.test(u.hostname) && !/^www\.github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** 'ghcr.io/owner/app:1.2@sha256:...' -> 'ghcr.io/owner/app'. Tag and digest dropped. */
export function normalizeImageRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  let p;
  try { p = parseImageRef(ref); } catch (_) { return null; }
  // A bare 'odoo' and 'docker.io/library/odoo' are the same image; both
  // normalise to 'odoo' so the manifest's short form matches an operator's
  // fully-qualified one.
  let name = p.name;
  let registry = p.registry;
  if (DOCKER_HUB_REGISTRIES.has(registry)) {
    registry = null;
    if (name.startsWith('library/')) name = name.slice('library/'.length);
  }
  return registry ? `${registry}/${name}` : name;
}

/** Drop every in-memory cache. Tests only — nothing in the server calls this. */
export function resetCatalogCaches() {
  enrichment.clear();
  versionsCache.clear();
  manifestCache = null;
  lastRefreshAt = null;
  lastSuccessAt = null;
}

export default {
  loadCatalog, findEntry, getVersions, refreshEnrichment, maybeRefreshInBackground,
  getEnrichment, enrichmentStatus, normalizeGithubUrl, normalizeImageRef,
};
