/**
 * Platform credential health checker (v2.25.2).
 *
 * Every 15 minutes, probes the platform's integration credentials — the tokens
 * whose silent expiry breaks core features:
 *   - Microsoft Graph mail client secret (email sending)
 *   - GitHub service-account PAT (managed-app repos / deploys)
 * and emails every platform admin when one stops working. Probes skip cleanly
 * when a credential isn't configured (nothing to check).
 *
 * State is persisted in settings.credcheck_state so we alert on the *transition*
 * to failing (not every tick), re-alert at most once a day while still failing,
 * and send a one-line recovery notice when it comes back. Each state entry
 * carries the probe's `fix` breadcrumb and `href` so GET /api/credentials/health
 * can serve both to the dashboard banner without re-deriving them.
 *
 * Caveat: if the failing credential is Graph itself and Graph is the only mail
 * transport, the alert email can't be delivered — that case is logged loudly
 * (ERROR) so it surfaces in the server logs / log drain.
 */

import { hostname } from 'os';
import { getDb } from '../db.js';
import { sendEmail } from './emailService.js';
import { probeGraph } from './graphMailer.js';
import { probeServiceAccount } from './githubService.js';
import log from '../utils/logger.js';

const CHECK_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;      // let the app finish booting
const RE_ALERT_MS = 24 * 60 * 60_000;     // renotify at most once/day while broken
const STATE_KEY = 'credcheck_state';
let timer = null;

// `fix` is the human breadcrumb (CredentialAlertBanner renders it, the health
// route serves it); `href` is the same destination as something clickable —
// a real SPA route + Settings tab hash (studio-web/src/pages/Settings.tsx
// VALID_TABS). Both are kept: dropping `fix` would blank the banner.
export const PROBES = [
  { name: 'Microsoft Graph (email)', fix: 'Settings → Mail',   href: '/settings#mail',   run: probeGraph },
  { name: 'GitHub service account',  fix: 'Settings → GitHub', href: '/settings#github', run: probeServiceAccount },
];

/** Breadcrumb + in-app path for a probe name, for callers holding only the name. */
export function probeLink(name) {
  const p = PROBES.find(x => x.name === name);
  return p ? { fix: p.fix, href: p.href } : null;
}

/**
 * Which AppCrane this is. An admin running more than one instance could not act
 * on the old alert at all — every box sent a byte-identical "[AppCrane] GitHub
 * service account credential is FAILING". CRANE_DOMAIN is the instance's public
 * identity; when it is unset (dev / direct-IP boxes) the OS hostname still
 * tells two machines apart, which is the whole point of naming it.
 */
function instanceName() {
  return craneDomain() || hostname();
}

function craneDomain() {
  return (process.env.CRANE_DOMAIN || '').trim();
}

/**
 * Absolute https URL to the page that fixes `probe`, or null when CRANE_DOMAIN
 * is unset. Deliberately null rather than a guessed origin: the alternatives
 * are mailing `https://undefined/settings#github`, or a bare `/settings#github`
 * that no mail client can turn into a link — both worse than the breadcrumb.
 * (server/routes/saml.js falls back to http://localhost:PORT for its own base
 * URL; that is right for a SAML callback the server itself resolves, and wrong
 * for a link a human reads on another machine.)
 */
function fixUrl(probe) {
  const domain = craneDomain();
  return domain ? `https://${domain}${probe.href}` : null;
}

/** Where-to-go line: a clickable URL when we know the domain, breadcrumb otherwise. */
function fixDirection(probe) {
  const url = fixUrl(probe);
  return url ? `Fix it here: ${url}` : `Fix it in ${probe.fix} on this instance.`;
}

/** Subject + body for the "credential stopped working" alert. Exported for tests. */
export function buildFailureAlert(probe, result, now) {
  const instance = instanceName();
  return {
    subject: `[AppCrane: ${instance}] ${probe.name} credential is FAILING`,
    body:
      `Instance: ${instance}\n\n` +
      `This AppCrane's ${probe.name} credential stopped working.\n\n` +
      `Checked: ${new Date(now).toISOString()}\n` +
      `Error: ${result.error || '(no detail)'}\n\n` +
      `This usually means the token/secret expired, was rotated, or was revoked.\n` +
      `${fixDirection(probe)}\n` +
      `You'll get a recovery notice once it works again.\n`,
  };
}

/** Subject + body for the recovery notice — same addressing as the alert it clears. */
export function buildRecoveryAlert(probe, now) {
  const instance = instanceName();
  const url = fixUrl(probe);
  return {
    subject: `[AppCrane: ${instance}] ${probe.name} credential RECOVERED`,
    body:
      `Instance: ${instance}\n\n` +
      `This AppCrane's ${probe.name} credential is working again as of ` +
      `${new Date(now).toISOString()}.\n` +
      (url ? `Settings: ${url}\n` : ''),
  };
}

function loadState(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY);
    return row?.value ? JSON.parse(row.value) : {};
  } catch (_) { return {}; }
}

function saveState(db, state) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(STATE_KEY, JSON.stringify(state));
}

function platformAdminEmails(db) {
  return db.prepare(
    "SELECT email FROM users WHERE role = 'platform_admin' AND active = 1 AND email IS NOT NULL"
  ).all().map(r => r.email);
}

async function alertAdmins(db, subject, body) {
  const admins = platformAdminEmails(db);
  if (admins.length === 0) { log.warn(`[credcheck] no platform admins to alert: ${subject}`); return; }
  for (const to of admins) {
    // Send directly (not via the queue) so a broken mail credential surfaces
    // synchronously here rather than dead-lettering silently.
    await sendEmail({ to, subject, text: body, fromName: 'AppCrane' }).catch(e =>
      log.error(`[credcheck] could not email admin ${to} about "${subject}": ${e.message}`));
  }
}

async function runOnce(probes = PROBES) {
  const db = getDb();
  const state = loadState(db);
  const now = Date.now();

  for (const probe of probes) {
    let result;
    try { result = await probe.run(); }
    catch (e) { result = { ok: false, error: e.message }; } // probes shouldn't throw, but be safe

    const prev = state[probe.name] || { ok: true };

    if (result.skipped) {
      // Not configured → nothing to check; forget any prior state.
      delete state[probe.name];
      continue;
    }

    if (!result.ok) {
      const firstFailure = prev.ok !== false;
      const staleAlert = prev.lastAlertAt && (now - prev.lastAlertAt) >= RE_ALERT_MS;
      if (firstFailure || staleAlert) {
        const { subject, body } = buildFailureAlert(probe, result, now);
        await alertAdmins(db, subject, body);
        log.error(`[credcheck] ${probe.name} FAILING: ${result.error || '(no detail)'}`);
      }
      state[probe.name] = {
        ok: false,
        since: prev.ok === false ? prev.since : now,
        lastAlertAt: (firstFailure || staleAlert) ? now : prev.lastAlertAt,
        error: result.error || null,
        fix: probe.fix,
        href: probe.href,
      };
    } else {
      if (prev.ok === false) {
        const { subject, body } = buildRecoveryAlert(probe, now);
        await alertAdmins(db, subject, body);
        log.info(`[credcheck] ${probe.name} recovered`);
      }
      state[probe.name] = { ok: true };
    }
  }

  saveState(db, state);
}

/** Start the 15-minute credential checker. Idempotent. */
export function startCredentialChecker() {
  if (timer) return;
  log.info('[credcheck] platform credential checker started (every 15m)');
  setTimeout(() => { runOnce().catch(e => log.error(`[credcheck] first run: ${e.message}`)); }, FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => { runOnce().catch(e => log.error(`[credcheck] tick: ${e.message}`)); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

export function stopCredentialChecker() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Exported for tests / manual trigger.
export { runOnce as runCredentialCheckOnce };
