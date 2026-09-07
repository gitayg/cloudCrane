import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// Every path the SPA router knows must ALSO be registered in server/index.js.
//
// React Router handles in-app navigation client-side, so a missing server route
// is invisible while you click around — and only appears when someone loads the
// URL directly, refreshes, or follows a shared link. Then the request falls past
// every route in index.js to the API's 404 handler and the user is shown raw
// JSON: {"error":{"code":"NOT_FOUND","message":"GET /catalog not found"}}.
//
// That is exactly how /catalog shipped in v2.61.0. The nav entry worked, so it
// looked fine.
//
// There is deliberately NO catch-all: a single-segment path is an app slug
// first, and a catch-all would let a typo'd SPA route shadow a real app.
// The cost of that choice is this list, and this test is what keeps it honest.

const SPA = readFileSync(new URL('../studio-web/src/AdminApp.tsx', import.meta.url), 'utf8');
const SRV = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

const spaPaths = [...SPA.matchAll(/<Route\s+path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p !== '*' && p !== '/')      // catch-all and root are handled separately
  .filter((p) => !p.includes(':'))            // parameterised paths use *splat on the server
  .map((p) => p.replace(/\/$/, ''));

const served = new Set(
  [...SRV.matchAll(/app\.get\(\s*'([^']+)'/g)].map((m) => m[1].replace(/\/\*splat$/, '')),
);

test('the SPA router knows some routes (the parse actually found something)', () => {
  // Without this, a change to AdminApp.tsx's formatting turns the real assertion
  // into a vacuous pass over an empty list.
  assert.ok(spaPaths.length >= 8, `parsed only ${spaPaths.length} SPA routes — the regex is stale`);
  assert.ok(served.size >= 8, `parsed only ${served.size} server routes — the regex is stale`);
});

test('every SPA route is also served by the server on a direct load', () => {
  const missing = spaPaths.filter((p) => !served.has(p));
  assert.deepEqual(missing, [],
    `these SPA routes 404 on a direct load or refresh — add `
    + `app.get('<path>', (req, res) => sendHtml(res, adminSpa)) to server/index.js: ${missing.join(', ')}`);
});
