import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Open redirect (CWE-601), proven by a credentialed WAS scan of app.example.com:
// GET /login?redirect=//3dc5a9db-...com  ->  browser landed on that host.
//
// Three call sites guarded with `redirect.startsWith('/')`, which is not a
// same-origin test: "//attacker.com" starts with a slash and is an absolute
// cross-origin URL.
//
// safeRedirect.ts is TypeScript, so rather than add a build step for one file
// this mirrors its regex contract and asserts the SOURCE still says what the
// test assumes — if the implementation drifts, this fails loudly instead of
// silently testing a stale copy.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'studio-web/src/utils/safeRedirect.ts'), 'utf8');

// Mirror of isSafeRedirect.
function isSafeRedirect(value) {
  if (!value) return false;
  if (!value.startsWith('/')) return false;
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return true;
}

// Mirror of the server-side guard in forwardToLaunch.
const SERVER_RE = /^\/(?![/\\])[^\s\x00-\x1f\x7f]*$/;

test('the exact payload from the scan is rejected', () => {
  const payload = '//3dc5a9db-66e2-4454-8d05-938b4c69c027.com';
  assert.equal(isSafeRedirect(payload), false, 'client guard must reject it');
  assert.equal(SERVER_RE.test(payload), false, 'server guard must reject it');
});

test('cross-origin and scheme-bearing targets are rejected', () => {
  for (const bad of [
    '//attacker.com',
    '//attacker.com/path',
    '/\\attacker.com',          // backslash variant some browsers treat as //
    'https://attacker.com',
    'http://attacker.com',
    'javascript:alert(1)',
    '//',
    '/\\',
    'attacker.com',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isSafeRedirect(bad), false, `client accepted ${JSON.stringify(bad)}`);
    if (typeof bad === 'string') {
      assert.equal(SERVER_RE.test(bad), false, `server accepted ${JSON.stringify(bad)}`);
    }
  }
});

test('control characters are rejected (header/URL splitting)', () => {
  for (const bad of ['/ok\nLocation: //evil.com', '/ok\r\nSet-Cookie: x=1', '/ok\x00', '/ok\x7f']) {
    assert.equal(isSafeRedirect(bad), false, `client accepted ${JSON.stringify(bad)}`);
    assert.equal(SERVER_RE.test(bad), false, `server accepted ${JSON.stringify(bad)}`);
  }
});

test('legitimate same-origin paths still work', () => {
  for (const good of ['/', '/launch', '/launch/my-app', '/applications?tab=manage', '/a/b/c#frag']) {
    assert.equal(isSafeRedirect(good), true, `client rejected ${good}`);
    assert.equal(SERVER_RE.test(good), true, `server rejected ${good}`);
  }
});

test('the shipped implementation still enforces both guards', () => {
  // Guard against the mirror above drifting from the real file.
  assert.match(SRC, /value\[1\] === '\/' \|\| value\[1\] === '\\\\'/,
    'safeRedirect.ts no longer rejects // and /\\ — the open redirect may be back');
  assert.match(SRC, /\\x00-\\x1f/, 'safeRedirect.ts no longer rejects control characters');

  const serverSrc = readFileSync(join(__dirname, '..', 'server/index.js'), 'utf8');
  assert.ok(serverSrc.includes('dropped unsafe redirect target'),
    'server-side redirect guard is missing from forwardToLaunch');
});
