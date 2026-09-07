// One daily email per recipient about vulnerable dependencies in hosted apps.
//
// Findings that live only in a database get read the day someone goes looking,
// which is usually the day after they mattered. The digest is the delivery
// mechanism; appScan.js is the detection.
//
// Two audiences, deliberately different: a platform admin gets the fleet, an
// app owner gets only their own apps. Sending owners the whole fleet would leak
// which other apps are vulnerable to someone with no access to them.
//
// One mail per recipient per day, idempotency-keyed on the date, so a restart
// or a second scheduler tick cannot mail the same person twice.

import { getDb } from '../db.js';
import { enqueueEmail } from './emailQueue.js';
import { scanApp, fleetScanSummary } from './appScan.js';
import { assertFindings } from './scanShapes.js';
import log from '../utils/logger.js';

const K = {
  lastRun: 'vuln_scan_last_run',
  hour: 'vuln_scan_hour',
};
const DEFAULT_HOUR = 6;

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? row.value : fallback;
}
function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value));
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Exported for the clock test. The choice of clock here is a correctness
// property, not an implementation detail — mixing a UTC day key with a local
// hour gate produced duplicate digests — so it is worth being able to assert
// directly rather than by grepping this file.
export function today() {
  // LOCAL date, not UTC — the hour gate below uses getHours(), which is local,
  // and mixing clocks makes the day key roll at a different moment than the
  // hour it is compared against. Measured with a 30-hour tick walk: a scheduler
  // arming mid-morning in a timezone BEHIND UTC fired at local 08:00 and again
  // at local 17:00 when the UTC key rolled — two full fleet scans and two
  // duplicate digests to every recipient on that day. Steady state was one per
  // day, so it only shows up on the first day after a start, restart or reset,
  // which is exactly when nobody is watching for it. One clock, both halves.
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// appScan.js owns the app_vuln_scans table and its migration. The digest has to
// read scan rows on a box where that migration has not run yet — a partially
// applied upgrade, or a test that exercises the digest alone — and a missing
// table there means "nothing scanned yet", not a crash in the daily scheduler.
function scansTableExists(db) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_vuln_scans'"
  ).get();
}

/**
 * Findings come out of app_vuln_scans in the shape scanShapes.js freezes:
 * { name, version, ecosystem, ids[], fixed }. They are ASSERTED here, not
 * coerced.
 *
 * The previous round's producer wrote { name, version, ids } while the brief
 * for this file described { package, id, fixed_version }, and the mail rendered
 * only because this function read `f.name ?? f.package`. That defensive read is
 * the bug, not the safety net: it turns a broken contract into a digest that
 * quietly says less than it should, and a finding nobody sees reads as safe.
 * Failing loudly puts the mismatch in a test run instead of an inbox.
 */
function readFindings(list, where) {
  if (!Array.isArray(list)) return [];
  return assertFindings(list, where);
}

/**
 * Latest scan per app/env that found something, with the app's owner attached.
 * fleetScanSummary owns the "newest row per app+env" query, including its
 * tie-break; duplicating that here would give the digest and the dashboard two
 * answers that drift apart.
 */
function vulnerableApps(db) {
  if (!scansTableExists(db)) return [];
  // Owner identity, not just the id. The platform digest lists apps the reader
  // does not own, and "chatwoot has 3 vulnerable packages" leaves an admin with
  // a second lookup before they can tell anyone. Resolving it here keeps that
  // join in one place rather than in the renderer.
  //
  // `created_by` is the definition of owner this digest has always used. It is
  // not the only one — app_user_roles carries an 'owner' role too — but changing
  // which one counts would silently re-address the mail, so it stays as it was.
  const owners = new Map(
    db.prepare(`
      SELECT a.id, a.created_by, u.name AS owner_name, u.email AS owner_email
      FROM apps a LEFT JOIN users u ON u.id = a.created_by
    `).all().map((a) => [a.id, a]),
  );
  const out = [];
  for (const r of fleetScanSummary(db)) {
    const findings = readFindings(r.findings, `${r.slug}/${r.env} findings`);
    if (!findings.length) continue;
    out.push({
      appId: r.app_id,
      appName: r.name || r.slug,
      slug: r.slug,
      env: r.env,
      ownerId: owners.get(r.app_id)?.created_by ?? null,
      ownerName: owners.get(r.app_id)?.owner_name ?? null,
      ownerEmail: owners.get(r.app_id)?.owner_email ?? null,
      scannedAt: r.scanned_at || null,
      findings,
    });
  }
  return out;
}

/**
 * @returns {{ recipients: Array<{ email: string, scope: 'platform'|'owner', apps: Array<object> }> }}
 *   Empty recipients when nothing is vulnerable — silence is the correct output
 *   for a clean fleet, and a daily "nothing to report" trains people to ignore it.
 */
export function buildDigest(db) {
  const apps = vulnerableApps(db);
  if (!apps.length) return { recipients: [] };

  const admins = db.prepare(`
    SELECT id, email, name FROM users
    WHERE role = 'platform_admin' AND active = 1 AND email IS NOT NULL
  `).all();
  const adminIds = new Set(admins.map((u) => u.id));

  const recipients = admins.map((u) => ({
    email: u.email, name: u.name, scope: 'platform', apps,
  }));

  // An owner who is also a platform admin already has the fleet, which is a
  // superset of their own apps. A second mail would say less and arrive twice.
  const byOwner = new Map();
  for (const app of apps) {
    if (app.ownerId == null || adminIds.has(app.ownerId)) continue;
    if (!byOwner.has(app.ownerId)) byOwner.set(app.ownerId, []);
    byOwner.get(app.ownerId).push(app);
  }
  const findUser = db.prepare(
    'SELECT id, email, name FROM users WHERE id = ? AND active = 1 AND email IS NOT NULL'
  );
  for (const [ownerId, ownerApps] of byOwner) {
    const u = findUser.get(ownerId);
    if (!u) continue;
    recipients.push({ email: u.email, name: u.name, scope: 'owner', apps: ownerApps });
  }

  return { recipients };
}

function renderDigest(recipient, date) {
  const nApps = recipient.apps.length;
  const nFindings = recipient.apps.reduce((n, a) => n + a.findings.length, 0);
  const appWord = nApps === 1 ? 'app' : 'apps';
  const scopeLine = recipient.scope === 'platform'
    ? `Fleet dependency scan for ${date}.`
    : `Dependency scan for ${date} on the ${appWord} you own.`;
  const subject = `[AppCrane] ${nFindings} vulnerable ${nFindings === 1 ? 'package' : 'packages'} across ${nApps} ${appWord}`;

  // The package, its ecosystem, the advisory ids and the fixed version are all
  // in the mail on purpose: a digest that only says "you have vulnerabilities"
  // costs the reader a login before they can judge whether it is urgent.
  //
  // The ecosystem is named per finding because one scan can now report npm and
  // Go packages together, and names collide across registries — "requests" and
  // "yaml" exist on both npm and PyPI. "lodash 4.17.15" alone leaves the reader
  // guessing which registry to go upgrade in.
  //
  // A null `fixed` is stated, never omitted. The shape guarantees it means "OSV
  // published no fixed version", so the reader can act on it; a missing line
  // would be indistinguishable from "we did not check", which is the reading
  // that gets a real advisory ignored.
  const fixLabel = (f) => (f.fixed ? `fix: ${f.fixed}` : 'no fixed version published');

  // Named only in the fleet digest. An owner reading their own scoped mail does
  // not need to be told who owns these — they do — and repeating their address
  // back at them reads like a mistake. The admin is the one who has to work out
  // who to tell, which is the whole reason this is here.
  const showOwner = recipient.scope === 'platform';
  const ownerLabel = (a) => (a.ownerName || a.ownerEmail
    ? `${a.ownerName || a.ownerEmail}${a.ownerName && a.ownerEmail ? ` <${a.ownerEmail}>` : ''}`
    : 'no owner recorded');
  const ownerSuffix = (a) => (showOwner ? ` — owner: ${ownerLabel(a)}` : '');

  let text = `${scopeLine}\n\n`;
  for (const a of recipient.apps) {
    text += `${a.appName} (${a.env}) — ${a.findings.length} vulnerable package${a.findings.length === 1 ? '' : 's'}${ownerSuffix(a)}\n`;
    for (const f of a.findings) {
      text += `  - ${f.name} ${f.version} (${f.ecosystem}) — ${f.ids.join(', ')} — ${fixLabel(f)}\n`;
    }
    text += '\n';
  }
  text += `Scans are report-only: nothing here blocked or failed a deploy.\n`;

  const sections = recipient.apps.map((a) => {
    const rows = a.findings.map((f) => (
      `<tr>` +
      `<td style="padding:6px 10px;border-top:1px solid #eef0f3;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#111827;">${esc(f.name)} ${esc(f.version)}</td>` +
      `<td style="padding:6px 10px;border-top:1px solid #eef0f3;font-size:12px;color:#6b7280;">${esc(f.ecosystem)}</td>` +
      `<td style="padding:6px 10px;border-top:1px solid #eef0f3;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#6b7280;">${esc(f.ids.join(', '))}</td>` +
      `<td style="padding:6px 10px;border-top:1px solid #eef0f3;font-size:12px;color:#111827;">${esc(fixLabel(f))}</td>` +
      `</tr>`
    )).join('');
    return `<div style="margin:22px 0 0;">` +
      `<div style="font-size:15px;font-weight:600;color:#111827;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">` +
        `${esc(a.appName)} <span style="font-weight:400;color:#6b7280;">&middot; ${esc(a.env)} &middot; ${a.findings.length}` +
        `${showOwner ? ` &middot; owner: ${esc(ownerLabel(a))}` : ''}</span></div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>` +
    `</div>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">` +
    `<p style="font-size:15px;margin:0 0 4px;">Hi${recipient.name ? ' ' + esc(recipient.name) : ''},</p>` +
    `<p style="font-size:14px;color:#374151;margin:0;">${esc(scopeLine)}</p>` +
    `${sections}` +
    `<p style="font-size:12px;color:#9ca3af;margin-top:24px;">Scans are report-only &mdash; nothing here blocked or failed a deploy.</p>` +
  `</div>`;

  return { subject, text, html };
}

/** Enqueue today's digests. @returns {{ sent: number, skipped: number }} */
export function sendVulnDigest(db) {
  const date = today();
  const { recipients } = buildDigest(db);
  let sent = 0, skipped = 0;

  // The key is checked here rather than left to enqueueEmail's dedupe because
  // that dedupe is keyed on (app_id, idempotency_key) and only runs when app_id
  // is set. A digest spans several apps, so it is platform mail with app_id
  // NULL — and NULLs are distinct in a SQLite unique index, which would let a
  // second tick insert the same message again.
  const seen = db.prepare('SELECT id FROM email_queue WHERE idempotency_key = ?');

  for (const r of recipients) {
    const idempotencyKey = `vuln-digest:${date}:${String(r.email).toLowerCase()}`;
    if (seen.get(idempotencyKey)) { skipped++; continue; }
    const { subject, text, html } = renderDigest(r, date);
    try {
      enqueueEmail({ to: r.email, subject, text, html, appId: null, idempotencyKey, source: 'vuln-digest' });
      sent++;
    } catch (e) {
      // A recipient who is no longer a platform user is not a reason to drop
      // the rest of the fleet's digests.
      log.warn(`[vuln-digest] skipped ${r.email}: ${e.message}`);
      skipped++;
    }
  }
  log.info(`[vuln-digest] queued ${sent} digest(s), skipped ${skipped}`);
  return { sent, skipped };
}

async function runDailyScan(db) {
  const targets = db.prepare(
    "SELECT DISTINCT app_id, env FROM deployments WHERE status = 'live'"
  ).all();
  const getApp = db.prepare('SELECT * FROM apps WHERE id = ?');
  let scanned = 0;
  for (const t of targets) {
    const app = getApp.get(t.app_id);
    if (!app) continue;
    // scanApp never throws by contract; the try is for the contract being
    // broken, not for a scan that fails — a failed scan is a recorded row.
    try { await scanApp(db, app, t.env, 'scheduled'); scanned++; }
    catch (e) { log.error(`[vuln-scan] ${app.slug}/${t.env} threw: ${e.message}`); }
  }
  log.info(`[vuln-scan] scanned ${scanned} app/env pair(s)`);
  return scanned;
}

let _timer = null;

/** Daily scan of every app, then the digest. Started from index.js. */
export function startVulnScheduler() {
  if (_timer) return;
  const tick = async () => {
    let db;
    try {
      db = getDb();
      // `parseInt(...) || DEFAULT_HOUR` read a configured hour of 0 as 6:
      // midnight is falsy. Measured at 03:10 local with vuln_scan_hour = '0' —
      // the gate compared 3 < 6 and returned, so the digest an admin scheduled
      // for midnight never fired until 06:00 and the scheduler test passed only
      // when the suite happened to run after breakfast. Range-check instead, so
      // 0 is a valid hour and only a genuinely unparseable value falls back.
      const configured = parseInt(getSetting(db, K.hour, String(DEFAULT_HOUR)), 10);
      const hour = Number.isInteger(configured) && configured >= 0 && configured <= 23
        ? configured : DEFAULT_HOUR;
      if (getSetting(db, K.lastRun, '') === today() || new Date().getHours() < hour) return;
      // Claimed before the scan, not after it. A fleet scan is dozens of
      // network round-trips to OSV and can outlast the hourly interval; a
      // last-run written afterwards would let the next tick start a second
      // concurrent pass over the same apps.
      setSetting(db, K.lastRun, today());
    } catch (e) {
      log.warn(`[vuln-scan] scheduler tick failed: ${e.message}`);
      return;
    }
    try {
      await runDailyScan(db);
      sendVulnDigest(db);
    } catch (e) {
      log.error(`[vuln-scan] daily run failed: ${e.message}`);
    }
  };
  tick().catch(() => {});
  _timer = setInterval(() => { tick().catch(() => {}); }, 60 * 60 * 1000);
  log.info('[vuln-scan] daily scheduler started (hourly check)');
}

export function stopVulnScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
