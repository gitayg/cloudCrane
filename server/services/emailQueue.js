/**
 * Async email queue for the app email service (v2.8.0).
 *
 * enqueueEmail() validates + inserts a row and returns immediately — the
 * caller (an app's server, or AppCrane's own request-lifecycle notifications)
 * never blocks on SMTP. A worker ticks every few seconds, claims due rows,
 * sends via the shared transport (emailService), and retries with backoff.
 * After MAX_ATTEMPTS a row is dead-lettered and the platform admin is emailed
 * so a broken relay surfaces to a human, not just a log line.
 *
 * Recipient policy: a message may only go to the email of a KNOWN, active
 * platform user (see assertValidRecipient). This bounds the service to
 * "notify a platform user" — no arbitrary recipients, no spam vector.
 */

import { getDb } from '../db.js';
import { sendEmail } from './emailService.js';
import log from '../utils/logger.js';

const TICK_MS = 5_000;
const MAX_ATTEMPTS = 5;
const BATCH = 10;
// Backoff schedule (seconds) indexed by attempt number. Last value repeats.
const BACKOFF_S = [30, 120, 600, 1800];
let timer = null;

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

// Attachment limits. The total cap keeps us within Microsoft Graph's simple
// sendMail request budget (no upload-session dance) and is comfortably fine
// for SMTP too.
const MAX_ATTACH_COUNT = 10;
const MAX_ATTACH_TOTAL_BYTES = 3 * 1024 * 1024; // 3 MB across all attachments
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate + normalize an attachments array into the stored/sent shape:
 * [{ filename, content(base64), contentType }]. Throws on any malformed or
 * oversized input. Returns [] for null/undefined.
 */
export function normalizeAttachments(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('attachments must be an array');
  if (input.length > MAX_ATTACH_COUNT) throw new Error(`too many attachments (max ${MAX_ATTACH_COUNT})`);
  let total = 0;
  const out = [];
  for (const a of input) {
    if (!a || typeof a !== 'object') throw new Error('each attachment must be an object');
    const filename = String(a.filename ?? a.name ?? '').trim();
    if (!filename) throw new Error('each attachment needs a filename');
    if (/[/\\]/.test(filename) || filename.includes('..')) throw new Error(`invalid attachment filename: ${filename}`);
    const content = String(a.content ?? '').replace(/\s+/g, '');
    if (!content) throw new Error(`attachment "${filename}" has no content`);
    if (!B64_RE.test(content)) throw new Error(`attachment "${filename}" content must be base64`);
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length === 0) throw new Error(`attachment "${filename}" decoded to empty`);
    total += bytes.length;
    if (total > MAX_ATTACH_TOTAL_BYTES) {
      throw new Error(`attachments exceed the ${Math.round(MAX_ATTACH_TOTAL_BYTES / 1024 / 1024)} MB total cap`);
    }
    const contentType = a.contentType ?? a.content_type;
    out.push({
      filename: filename.slice(0, 255),
      content,
      contentType: contentType ? String(contentType).slice(0, 128) : 'application/octet-stream',
    });
  }
  return out;
}

/**
 * Resolve the recipient if and only if it's a known, active platform user
 * (any auth method — SSO, SAML, OIDC, or local). Returns the canonical email
 * or throws. This is the hard bound on the service: it can only ever email
 * people who already have an account on this AppCrane — no arbitrary
 * recipients, no spam vector.
 */
export function assertValidRecipient(db, to) {
  const addr = String(to || '').trim().toLowerCase();
  if (!addr || !addr.includes('@')) throw new Error(`Invalid recipient: ${to}`);
  const user = db.prepare('SELECT email FROM users WHERE lower(email) = ? AND active = 1').get(addr);
  if (!user) {
    throw new Error(`Recipient ${addr} is not a platform user — email may only be sent to registered AppCrane users`);
  }
  return user.email;
}

/**
 * Per-app hourly send budget (v2.44.0).
 *
 * The recipient policy bounds WHO an app can mail; nothing bounded HOW MUCH.
 * Inside the SDP perimeter the reachable population is every registered
 * platform user, so one app in a loop — buggy or hostile — could put a message
 * in every colleague's inbox, repeatedly, under a display name of its choosing.
 *
 * 100/hour is set above the shape of real usage and below the shape of abuse:
 * app mail here is per-event notification (a deploy finished, a request needs
 * review), and the heaviest existing sender fans one event out to a handful of
 * people. 100/hour still allows ~2400 messages a day per app, so a legitimate
 * digest app is unaffected, while a runaway loop stops within the hour instead
 * of after the weekend.
 *
 * Operators can raise or lower it with the `email_app_hourly_limit` setting.
 * A missing or non-positive value falls back to the default rather than
 * disabling the budget — "0 means unlimited" is the kind of config that reads
 * as safe and behaves as off.
 *
 * Counted from email_queue rows rather than an in-memory bucket so a server
 * restart does not reset an app's allowance. Only `source = 'app'` rows count:
 * the caller-controlled path is the one being bounded, and platform notices
 * (dead-letter alerts, request digests) must never be starved by an app's spam.
 */
const APP_HOURLY_LIMIT_DEFAULT = 100;

function assertAppSendBudget(db, appId) {
  const configured = Number(getSetting(db, 'email_app_hourly_limit', APP_HOURLY_LIMIT_DEFAULT));
  const limit = Number.isFinite(configured) && configured > 0 ? configured : APP_HOURLY_LIMIT_DEFAULT;
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM email_queue
    WHERE app_id = ? AND source = 'app' AND created_at >= datetime('now', '-1 hour')
  `).get(appId);
  if (n >= limit) {
    const e = new Error(`This app has reached its email limit (${limit} messages per hour). Try again later.`);
    e.code = 'EMAIL_RATE_LIMITED';
    throw e;
  }
}

/**
 * Enqueue one message. Validates the recipient against the SSO directory.
 * @param {object} m { appId?, env?, to, subject, text?, html?, replyTo?, fromName?, idempotencyKey?, source?, attachments? }
 *   attachments: [{ filename, content(base64), contentType? }] — max 10, 3 MB total.
 * @returns {{ id:number, deduped?:boolean }}
 */
export function enqueueEmail(m) {
  const db = getDb();
  const to = assertValidRecipient(db, m.to);
  if (!m.subject || !String(m.subject).trim()) throw new Error('subject is required');
  if (!m.text && !m.html) throw new Error('text or html body is required');
  const attachments = normalizeAttachments(m.attachments);

  // Idempotency: a retrying caller with the same key gets the existing row.
  if (m.idempotencyKey && m.appId != null) {
    const existing = db.prepare(
      'SELECT id FROM email_queue WHERE app_id = ? AND idempotency_key = ?'
    ).get(m.appId, m.idempotencyKey);
    if (existing) return { id: existing.id, deduped: true };
  }

  // After the dedupe check, so a caller retrying with an idempotency key gets
  // its existing row back instead of burning budget on a message already sent.
  if ((m.source || 'app') === 'app' && m.appId != null) assertAppSendBudget(db, m.appId);

  const res = db.prepare(`
    INSERT INTO email_queue (app_id, env, to_email, from_name, reply_to, subject, body_text, body_html, idempotency_key, source, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.appId ?? null, m.env ?? null, to, m.fromName ?? null, m.replyTo ?? null,
    String(m.subject), m.text ?? null, m.html ?? null,
    m.idempotencyKey ?? null, m.source || 'app',
    attachments.length ? JSON.stringify(attachments) : null
  );
  return { id: res.lastInsertRowid };
}

/**
 * The app a queued row was sent ON BEHALF OF, or null for platform mail.
 *
 * Only `source = 'app'` rows get attributed. Platform notices already announce
 * themselves with an "[AppCrane]" subject prefix, and tagging them as if an app
 * had sent them would be a lie in the other direction.
 */
function sendingApp(db, row) {
  if (row.source !== 'app' || row.app_id == null) return null;
  return db.prepare('SELECT name, slug FROM apps WHERE id = ?').get(row.app_id) || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function resolveFromName(db, row) {
  // Display name only — the address is platform-controlled and resolved by the
  // transport (the Graph mailbox / SMTP From), never per-app.
  const base = row.from_name || getSetting(db, 'email_from_name', 'AIMI');

  // v2.44.0: attribution the recipient can actually see.
  //
  // `from_name` is chosen by the sending app (POST /api/service/email), and the
  // address is a real corporate mailbox — so an app could put any colleague's or
  // any team's name on the From line, and the only record of which app really
  // sent it was a DB column nobody reads. Recipients are bounded to registered
  // platform users, so this is not an open relay; it is a spoofing problem
  // aimed at everyone inside the perimeter, which is worse for phishing than a
  // stranger's mail would be.
  //
  // "<chosen name> via <slug>" is the Google Groups convention, and it works
  // here for the same reason: the app keeps the display name it wants, the true
  // origin is appended where it cannot be styled away, and it survives the
  // mobile clients that show the display name and nothing else.
  const app = sendingApp(db, row);
  return app ? `${base} via ${app.slug} (AppCrane)`.slice(0, 200) : base;
}

/**
 * Footer naming the sending app, appended to the rendered body.
 *
 * The From line is the attribution most recipients see, but it is also the part
 * a forwarded or quoted copy loses first. The footer travels with the text.
 */
function attributionFooter(db, row) {
  const app = sendingApp(db, row);
  if (!app) return null;
  const where = row.env ? ` (${row.env})` : '';
  return {
    text: `\n\n-- \nSent by the app "${app.name}" [${app.slug}]${where} through AppCrane, at that app's request.\n`
        + `AppCrane did not write this message. The sender's display name is chosen by the app.\n`,
    html: `<hr style="margin-top:24px;border:none;border-top:1px solid #ccc">`
        + `<p style="color:#666;font-size:12px;line-height:1.5">Sent by the app <strong>${escapeHtml(app.name)}</strong>`
        + ` [${escapeHtml(app.slug)}]${escapeHtml(where)} through AppCrane, at that app's request.<br>`
        + `AppCrane did not write this message. The sender's display name is chosen by the app.</p>`,
  };
}

async function deadLetter(db, row) {
  // Notify every platform admin by email that a message failed for good.
  const admins = db.prepare("SELECT email FROM users WHERE role = 'platform_admin' AND active = 1 AND email IS NOT NULL").all();
  const subject = `[AppCrane] email delivery FAILED after ${MAX_ATTEMPTS} attempts`;
  const text =
    `A queued email could not be delivered.\n\n` +
    `Queue id: ${row.id}\nApp id: ${row.app_id ?? '(platform)'}  env: ${row.env ?? '-'}\n` +
    `To: ${row.to_email}\nSubject: ${row.subject}\nSource: ${row.source}\n` +
    `Last error: ${row.error || '(none recorded)'}\n`;
  for (const a of admins) {
    // Send directly (not via the queue) so a queue/transport fault can't
    // swallow its own alarm.
    await sendEmail({ to: a.email, subject, text }).catch(e =>
      log.error(`[email] dead-letter notice to ${a.email} failed: ${e.message}`));
  }
}

async function processRow(db, row) {
  db.prepare("UPDATE email_queue SET status='sending' WHERE id = ?").run(row.id);
  try {
    let attachments;
    try { attachments = row.attachments ? JSON.parse(row.attachments) : undefined; }
    catch (_) { attachments = undefined; }
    // Appended at send time, not at enqueue, so the stored row keeps exactly
    // what the app submitted and the attribution can never be edited out of it.
    const footer = attributionFooter(db, row);
    const result = await sendEmail({
      to: row.to_email,
      subject: row.subject,
      text: row.body_text ? row.body_text + (footer?.text || '') : undefined,
      html: row.body_html ? row.body_html + (footer?.html || '') : undefined,
      fromName: resolveFromName(db, row),
      replyTo: row.reply_to || undefined,
      attachments,
    });
    // Clear the attachment blob on success so sent rows don't retain up to 3 MB.
    db.prepare("UPDATE email_queue SET status='sent', sent_at=datetime('now'), message_id=?, attempts=attempts+1, attachments=NULL WHERE id = ?")
      .run(result?.messageId || (result?.mock ? 'mock' : null), row.id);
    log.info(`[email] sent #${row.id} → ${row.to_email} (${row.source})`);
  } catch (e) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE email_queue SET status='failed', attempts=?, error=? WHERE id = ?")
        .run(attempts, String(e.message).slice(0, 500), row.id);
      log.error(`[email] #${row.id} dead-lettered after ${attempts} attempts: ${e.message}`);
      await deadLetter(db, { ...row, attempts, error: e.message });
    } else {
      const delay = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)];
      db.prepare(`UPDATE email_queue SET status='queued', attempts=?, error=?,
        next_attempt_at=datetime('now', '+' || ? || ' seconds') WHERE id = ?`)
        .run(attempts, String(e.message).slice(0, 500), delay, row.id);
      log.warn(`[email] #${row.id} attempt ${attempts} failed (retry in ${delay}s): ${e.message}`);
    }
  }
}

async function tick() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM email_queue
      WHERE status = 'queued' AND next_attempt_at <= datetime('now')
      ORDER BY id ASC LIMIT ?
    `).all(BATCH);
    for (const row of rows) {
      await processRow(db, row);
    }
  } catch (e) {
    log.error(`[email] tick error: ${e.message}`);
  }
}

/** Start the worker. Idempotent. Resets rows orphaned mid-send by a restart. */
export function startEmailWorker() {
  if (timer) return;
  try {
    const db = getDb();
    const reset = db.prepare("UPDATE email_queue SET status='queued' WHERE status='sending'").run();
    if (reset.changes > 0) log.warn(`[email] reset ${reset.changes} orphaned 'sending' row(s) to 'queued' on boot`);
  } catch (e) {
    log.warn(`[email] boot orphan-reset failed: ${e.message}`);
  }
  log.info(`[email] queue worker started (tick every ${TICK_MS / 1000}s)`);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
}

export function stopEmailWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}
