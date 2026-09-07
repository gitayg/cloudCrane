import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join } from 'path';

// Credential alert addressing (v2.25.3 → this change).
//
// The failing-credential mail used to read "[AppCrane] GitHub service account
// credential is FAILING … Fix it in Settings → GitHub." Two failures that cost
// the reader time at the worst possible moment:
//   1. An admin running more than one AppCrane could not tell WHICH box was
//      broken — every instance sends a byte-identical mail.
//   2. "Settings → GitHub" is a breadcrumb, not a link. Nothing to click.
// The fix names the instance in the subject and carries an absolute https URL
// in the body — and, when CRANE_DOMAIN is unset, must NOT invent one
// ("https://undefined/settings#github") or emit a bare path a mail client
// cannot linkify.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-credalert-'));
process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const { PROBES, buildFailureAlert, buildRecoveryAlert } =
  await import('../server/services/credentialChecker.js');

const GITHUB = PROBES.find(p => p.name === 'GitHub service account');
const DOMAIN = 'crane.example.test';
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function withDomain(value, fn) {
  const prev = process.env.CRANE_DOMAIN;
  if (value === null) delete process.env.CRANE_DOMAIN;
  else process.env.CRANE_DOMAIN = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CRANE_DOMAIN;
    else process.env.CRANE_DOMAIN = prev;
  }
}

// --- probe definitions -----------------------------------------------------

test('every probe carries both a breadcrumb and an in-app href', () => {
  assert.ok(PROBES.length >= 2, 'expected the Graph + GitHub probes');
  for (const p of PROBES) {
    // `fix` must survive: CredentialAlertBanner.tsx renders "(fix in {f.fix})"
    // and the health route serves it. Dropping it blanks the banner.
    assert.equal(typeof p.fix, 'string', `${p.name} lost its fix breadcrumb`);
    assert.ok(p.fix.length > 0, `${p.name} has an empty fix breadcrumb`);
    assert.match(p.href, /^\/[a-z]+#[a-z]+$/, `${p.name} href is not an in-app path: ${p.href}`);
  }
});

test('probe hrefs point at settings tabs the SPA actually has', () => {
  // Guards against drift: a renamed tab would otherwise mail admins a link
  // that silently lands on the default "security" tab.
  const src = readFileSync(
    new URL('../studio-web/src/pages/Settings.tsx', import.meta.url), 'utf8');
  const decl = src.match(/const VALID_TABS: Tab\[\] = \[([^\]]+)\]/);
  assert.ok(decl, 'could not find VALID_TABS in Settings.tsx');
  const tabs = [...decl[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(tabs.includes('github') && tabs.includes('mail'), `VALID_TABS looks wrong: ${tabs}`);

  for (const p of PROBES) {
    const [path, hash] = p.href.split('#');
    assert.equal(path, '/settings', `${p.name} href leaves /settings: ${p.href}`);
    assert.ok(tabs.includes(hash), `${p.name} href #${hash} is not a real Settings tab`);
  }
});

// --- failing alert, CRANE_DOMAIN set ---------------------------------------

test('failing subject names the instance', () => {
  const { subject } = withDomain(DOMAIN, () =>
    buildFailureAlert(GITHUB, { ok: false, error: 'bad credentials' }, NOW));
  assert.ok(subject.includes(DOMAIN), `subject does not name the instance: ${subject}`);
  assert.ok(subject.includes(GITHUB.name), `subject lost the probe name: ${subject}`);
  assert.ok(subject.includes('FAILING'), `subject lost the severity: ${subject}`);
});

test('failing body carries the absolute fix URL', () => {
  const { body } = withDomain(DOMAIN, () =>
    buildFailureAlert(GITHUB, { ok: false, error: 'bad credentials' }, NOW));
  assert.ok(body.includes(`https://${DOMAIN}/settings#github`),
    `body has no absolute fix link:\n${body}`);
  assert.ok(body.includes('bad credentials'), 'body dropped the probe error');
  assert.ok(body.includes(new Date(NOW).toISOString()), 'body dropped the check timestamp');
});

// --- failing alert, CRANE_DOMAIN unset -------------------------------------

test('with CRANE_DOMAIN unset the mail degrades to the breadcrumb, not a broken link', () => {
  const { subject, body } = withDomain(null, () =>
    buildFailureAlert(GITHUB, { ok: false, error: 'bad credentials' }, NOW));

  for (const [label, s] of [['subject', subject], ['body', body]]) {
    assert.ok(!s.includes('undefined'), `${label} rendered "undefined": ${s}`);
    assert.ok(!s.includes('null'), `${label} rendered "null": ${s}`);
    // No origin-less URL, and no scheme with an empty/garbage host.
    assert.ok(!/https?:\/\/(\s|\/|$)/.test(s), `${label} has a hostless URL: ${s}`);
    assert.ok(!s.includes('/settings#'), `${label} emitted an unclickable bare path: ${s}`);
  }
  // It must still say WHERE to go, and still say WHICH box.
  assert.ok(body.includes(GITHUB.fix), `body lost the breadcrumb fallback:\n${body}`);
  assert.ok(subject.includes(hostname()),
    `subject must still identify the instance without CRANE_DOMAIN: ${subject}`);
});

test('a blank/whitespace CRANE_DOMAIN is treated as unset', () => {
  const { body } = withDomain('   ', () =>
    buildFailureAlert(GITHUB, { ok: false, error: 'x' }, NOW));
  assert.ok(!body.includes('https:// '), `whitespace domain produced a broken URL:\n${body}`);
  assert.ok(body.includes(GITHUB.fix), 'blank domain should fall back to the breadcrumb');
});

test('a probe with no detail still produces a usable mail', () => {
  const { body } = withDomain(DOMAIN, () => buildFailureAlert(GITHUB, { ok: false }, NOW));
  assert.ok(!body.includes('undefined'), `missing error rendered "undefined":\n${body}`);
  assert.ok(body.includes(`https://${DOMAIN}/settings#github`), 'link missing on detail-less alert');
});

// --- recovery notice -------------------------------------------------------

test('recovery notice names the instance too', () => {
  const { subject, body } = withDomain(DOMAIN, () => buildRecoveryAlert(GITHUB, NOW));
  assert.ok(subject.includes(DOMAIN), `recovery subject does not name the instance: ${subject}`);
  assert.ok(subject.includes('RECOVERED'), `recovery subject lost the severity: ${subject}`);
  assert.ok(body.includes(DOMAIN), `recovery body does not name the instance:\n${body}`);
});

test('recovery notice with CRANE_DOMAIN unset stays clean', () => {
  const { subject, body } = withDomain(null, () => buildRecoveryAlert(GITHUB, NOW));
  for (const [label, s] of [['subject', subject], ['body', body]]) {
    assert.ok(!s.includes('undefined'), `${label} rendered "undefined": ${s}`);
    assert.ok(!/https?:\/\/(\s|\/|$)/.test(s), `${label} has a hostless URL: ${s}`);
  }
  assert.ok(subject.includes(hostname()), `recovery subject must still identify the box: ${subject}`);
});
