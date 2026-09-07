import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// Integrity guard for server/services/appCatalog.json — the curated list behind
// the self-hostable app catalogue.
//
// This file has no owner and no CI that reads it, which is exactly the shape of
// data that rots. The MCP connector catalogue in this repo did precisely that:
// it drifted 22 tools behind the platform, silently, because nothing failed when
// it fell out of date. The fix there was a guard test, so this is the same guard
// for the same failure mode.
//
// Deliberately NETWORK-FREE. Whether an image still resolves is a question for a
// live registry and would make this suite flaky and rate-limited; this asserts
// the invariants that a human edit can break without noticing.

const CATALOG = JSON.parse(
  readFileSync(new URL('../server/services/appCatalog.json', import.meta.url), 'utf8'),
);

test('the catalogue is a non-empty array of objects', () => {
  assert.ok(Array.isArray(CATALOG), 'catalogue must be an array');
  assert.ok(CATALOG.length > 0, 'catalogue must not be empty');
});

test('every entry carries the fields the page and the deploy path need', () => {
  for (const e of CATALOG) {
    for (const k of ['name', 'slug', 'category', 'repo', 'short']) {
      assert.equal(typeof e[k], 'string', `${e.slug || '(no slug)'}: ${k} must be a string`);
      assert.ok(e[k].trim(), `${e.slug || '(no slug)'}: ${k} must not be blank`);
    }
    // owner/repo, because catalogService builds a GitHub URL out of it. A value
    // of any other shape is how a manifest field becomes an SSRF vector.
    assert.match(e.repo, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, `${e.slug}: repo must be owner/repo`);
  }
});

test('slugs are unique — a duplicate silently shadows an entry in any keyed lookup', () => {
  const seen = new Map();
  for (const e of CATALOG) {
    assert.ok(!seen.has(e.slug), `duplicate slug: ${e.slug}`);
    seen.set(e.slug, true);
  }
});

test('image is a non-empty string or explicitly null, never an empty string', () => {
  // null means "this project publishes no usable first-party image", which the
  // page reads to offer the GitHub path only. An empty string would pass a
  // truthiness check somewhere and render a Deploy button that cannot work.
  for (const e of CATALOG) {
    if (e.image === null) continue;
    assert.equal(typeof e.image, 'string', `${e.slug}: image must be a string or null`);
    assert.ok(e.image.trim(), `${e.slug}: image must be null rather than blank`);
    assert.ok(!e.image.startsWith('library/'),
      `${e.slug}: 'library/x' is Docker Hub's internal namespace for official images; the pullable reference is 'x'`);
  }
});

test('no volatile figures are committed', () => {
  // Stars, pull counts and versions are true the day they are written and
  // misleading a month later. They are fetched live and cached by
  // catalogService; committing one guarantees the page eventually lies.
  const VOLATILE = ['stars', 'pulls', 'version', 'release', 'last', 'pushed', 'archived', 'status'];
  for (const e of CATALOG) {
    for (const k of VOLATILE) {
      assert.ok(!(k in e), `${e.slug}: '${k}' is volatile and must not be committed — fetch it live`);
    }
  }
});

test('no entry ships an image that is one component of a multi-container app', () => {
  // Such an image resolves, so registry validation passes, but deploying it
  // alone produces a container that starts and cannot work: it wants a database,
  // a worker, or a separate frontend. Seven entries were removed for this
  // (Plane, Saleor, Huly, AppFlowy, Bigcapital, Taiga, metasfresh). This guard
  // stops one being reintroduced by a well-meaning addition.
  //
  // 'element-web' is deliberately NOT caught: Element Web is the whole product,
  // not a fragment of one, and runs standalone.
  const COMPONENTISH = /(^|[/_-])(server|backend|back|frontend|webapi|webui|cloud)($|[/_:-])/i;
  for (const e of CATALOG) {
    if (!e.image) continue;
    const name = e.image.split(':')[0];
    assert.ok(!COMPONENTISH.test(name),
      `${e.slug}: image '${e.image}' looks like one component of a multi-container app. `
      + 'Deploying it alone yields a broken app. Remove the entry, or set image to null and '
      + 'offer the GitHub path only.');
  }
});

test('entries stay sorted by category then name', () => {
  // Plain codepoint comparison, not localeCompare: localeCompare is
  // case-insensitive and locale-aware, so it orders 'Commerce' before 'CRM'
  // while the file is generated in codepoint order. It also varies with the
  // runtime's ICU data, which is not something a test should depend on.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = [...CATALOG].sort(
    (a, b) => cmp(a.category, b.category) || cmp(a.name.toLowerCase(), b.name.toLowerCase()),
  );
  assert.deepEqual(CATALOG.map((e) => e.slug), sorted.map((e) => e.slug),
    'keep the file sorted so diffs stay readable and additions land in an obvious place');
});

test('the catalogue carries no personal or employer identifiers', () => {
  // This repo is public and was cleaned of exactly this in v2.59.0. A catalogue
  // entry is an easy place to reintroduce one via a copied URL.
  const raw = readFileSync(new URL('../server/services/appCatalog.json', import.meta.url), 'utf8');
  assert.ok(!/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(raw.replace(/https?:\/\/[^"]*/g, '')),
    'catalogue contains what looks like an email address');
});
