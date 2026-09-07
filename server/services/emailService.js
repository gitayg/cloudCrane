import log from '../utils/logger.js';

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST) {
    log.debug('SMTP not configured. Emails will be logged only.');
    return null;
  }

  try {
    const nodemailer = await import('nodemailer');
    transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: parseInt(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return transporter;
  } catch (e) {
    log.error(`Failed to create email transporter: ${e.message}`);
    return null;
  }
}

/**
 * Send one email. Transport precedence: Microsoft Graph (if configured) →
 * SMTP (if configured) → mock log. `fromName` sets only the display name; the
 * address is always the platform-configured sender. `replyTo` is optional.
 */
export async function sendEmail({ to, subject, text, html, fromName, replyTo, attachments }) {
  // 1. Microsoft Graph — the production transport (sends as the shared mailbox).
  try {
    const { isGraphConfigured, sendViaGraph } = await import('./graphMailer.js');
    if (isGraphConfigured()) {
      const result = await sendViaGraph({ to, subject, text, html, fromName, replyTo, attachments });
      log.info(`Email sent to ${to} via Graph: ${subject}`);
      return result;
    }
  } catch (e) {
    // A configured-but-failing Graph send must propagate so the queue retries.
    if (String(e.message) !== 'Graph not configured') throw e;
  }

  // 2. SMTP fallback.
  const transport = await getTransporter();
  if (!transport) {
    log.info(`[EMAIL mock] To: ${to} | Subject: ${subject}`);
    log.debug(`[EMAIL mock] Body: ${text?.slice(0, 200)}`);
    return { mock: true };
  }

  const { getDb } = await import('../db.js');
  const addr = getDb().prepare("SELECT value FROM settings WHERE key='email_from_address'").get()?.value
    || process.env.SMTP_FROM || 'appcrane@example.com';
  const from = fromName ? `${JSON.stringify(fromName)} <${addr}>` : addr;

  const result = await transport.sendMail({
    from, to, subject, text, html,
    ...(replyTo && { replyTo }),
    ...(attachments?.length && {
      attachments: attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        encoding: 'base64',
        contentType: a.contentType || 'application/octet-stream',
      })),
    }),
  });
  log.info(`Email sent to ${to} via SMTP: ${subject}`);
  return result;
}

/**
 * Recipients for an app-scoped SECURITY notice (v2.44.0).
 *
 * Deliberately NOT notification_configs: those are per-user opt-ins for deploy
 * and health noise, and a security notice must not be something the person
 * being alerted about can quietly switch off. Deliberately not "every platform
 * admin" either — on a box with dozens of apps that trains admins to filter the
 * alert away, and the people who can actually judge "should this key have been
 * read?" are the app's owners.
 *
 * Falls back to platform admins only when the app has NO active owner, because
 * the alternative is an app whose secrets can be read with nobody told at all.
 */
function securityRecipients(db, appId) {
  const owners = db.prepare(`
    SELECT DISTINCT u.email FROM app_user_roles r
    JOIN users u ON u.id = r.user_id
    WHERE r.app_id = ? AND r.app_role = 'owner'
      AND u.active = 1 AND u.email IS NOT NULL AND u.email != ''
  `).all(appId).map(r => r.email);
  if (owners.length) return owners;
  return db.prepare(`
    SELECT email FROM users
    WHERE role = 'platform_admin' AND active = 1 AND email IS NOT NULL AND email != ''
  `).all().map(r => r.email);
}

// Cap the key list in the body. The subject already carries the true count, and
// a 400-key env would otherwise produce an unreadable mail that some gateways
// truncate mid-list — which reads as if fewer keys were taken than really were.
const MAX_KEYS_LISTED = 40;

/**
 * Tell an app's owners that someone read their secrets in plaintext (v2.44.0).
 *
 * v2.43.0 added the `env-reveal` audit event and the MCP path already logged
 * `secret-reveal`, so the RECORD existed — but nobody was told, which makes it
 * forensics rather than detection: you learn who took the keys only once you
 * already know to go looking. This is the "new sign-in on your account" mail —
 * its whole value is that it reaches a human unprompted.
 *
 * ONE mail per reveal event, listing every key. A reveal of 20 keys is one
 * decision by one person at one moment; 20 mails would be the same information
 * shaped so nobody reads it.
 *
 * The actor is NOT excluded from the recipients. If an owner reveals their own
 * app's secrets the mail is redundant to them — but a stolen owner session is
 * exactly the case this must catch, and the account holder is the only person
 * who can say "that was not me". The caller is responsible for coalescing
 * repeats so ordinary work does not become a mail storm.
 */
export async function notifySecretReveal(app, env, actor, keys) {
  const { getDb } = await import('../db.js');
  const db = getDb();

  const recipients = securityRecipients(db, app.id);
  if (!recipients.length) {
    log.error(`SECRET REVEAL on ${app.slug}/${env} could not be notified: no owner and no platform admin has an email address`);
    return;
  }

  const subject = `[AppCrane] SECRET REVEAL - ${app.slug} ${env} (${keys.length} key(s))`;

  const who = actor?.email || `user id ${actor?.id ?? 'unknown'}`;
  let body = `Someone read the PLAINTEXT values of environment variables.\n\n`;
  body += `App: ${app.name} (${app.slug})\n`;
  body += `Environment: ${env}\n`;
  body += `Read by: ${who}\n`;
  body += `Time: ${new Date().toISOString()}\n`;
  body += `Keys revealed (${keys.length}):\n`;
  for (const k of keys.slice(0, MAX_KEYS_LISTED)) body += `  - ${k}\n`;
  if (keys.length > MAX_KEYS_LISTED) body += `  ... and ${keys.length - MAX_KEYS_LISTED} more\n`;
  body += `\nIf this was expected, no action is needed.\n`;
  body += `If it was not, treat every key listed above as exposed and rotate it.\n`;
  body += `The full record is in the app's audit log (action: env-reveal).\n`;

  for (const to of recipients) {
    // Platform identity, not app.name: a notice ABOUT an app must not look like
    // it came FROM that app, or a compromised app could pass off forgeries as
    // AppCrane security mail.
    await sendEmail({ to, subject, text: body, fromName: 'AppCrane Security' }).catch(e => {
      log.error(`Failed to send secret-reveal notification to ${to}: ${e.message}`);
    });
  }
}

/**
 * Tell an app's owners AND the platform admins that an app's /data has crossed
 * its disk quota (v2.44.0).
 *
 * Platform admins are on this one — unlike the secret-reveal notice — because
 * the quota is not enforced by the kernel. An app over budget is consuming a
 * shared host filesystem, so the blast radius of ignoring it is every other app
 * on the box, which is the platform admin's problem and not only the owner's.
 */
export async function notifyDiskQuota(app, env, usedBytes, quotaBytes) {
  const { getDb } = await import('../db.js');
  const db = getDb();

  const admins = db.prepare(`
    SELECT email FROM users
    WHERE role = 'platform_admin' AND active = 1 AND email IS NOT NULL AND email != ''
  `).all().map(r => r.email);
  const recipients = [...new Set([...securityRecipients(db, app.id), ...admins])];
  if (!recipients.length) return;

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const subject = `[AppCrane] DISK QUOTA EXCEEDED - ${app.slug} ${env} (${mb(usedBytes)})`;

  let body = `An app's data directory is over its disk budget.\n\n`;
  body += `App: ${app.name} (${app.slug})\n`;
  body += `Environment: ${env}\n`;
  body += `Used: ${mb(usedBytes)}\n`;
  body += `Quota: ${mb(quotaBytes)}\n`;
  body += `Time: ${new Date().toISOString()}\n`;
  body += `\nThis quota is ADVISORY — nothing stops the app from writing more.\n`;
  body += `The host filesystem is shared, so an app that keeps growing can fill\n`;
  body += `the disk and take every other app on this box down with it.\n`;
  body += `\nACTION: reclaim space in the app's /data, or raise the platform\n`;
  body += `setting 'app_disk_quota_mb' if this usage is legitimate.\n`;

  for (const to of recipients) {
    await sendEmail({ to, subject, text: body, fromName: 'AppCrane Security' }).catch(e => {
      log.error(`Failed to send disk-quota notification to ${to}: ${e.message}`);
    });
  }
}

export async function notifyDeploy(app, env, version, status, errorMsg) {
  const { getDb } = await import('../db.js');
  const db = getDb();

  const eventCol = status === 'success' ? 'on_deploy_success' : 'on_deploy_fail';

  const configs = db.prepare(`
    SELECT nc.email FROM notification_configs nc
    WHERE nc.app_id = ? AND nc.${eventCol} = 1
  `).all(app.id);

  const icon = status === 'success' ? 'OK' : 'FAILED';
  const subject = `[AppCrane] ${app.slug} ${env} deploy ${icon}`;

  let body = `App: ${app.name} (${app.slug})\n`;
  body += `Environment: ${env}\n`;
  body += `Version: ${version}\n`;
  body += `Status: ${status.toUpperCase()}\n`;
  body += `Time: ${new Date().toISOString()}\n`;

  if (errorMsg) {
    body += `\nError: ${errorMsg}\n`;
  }

  for (const config of configs) {
    // v2.21.29: send as the app's own name ("AgentClub <appcrane@example.com>").
    // Without fromName the transport emits no display name and the recipient's
    // client falls back to the shared mailbox's directory name ("AIMI"), so
    // every app's notifications looked identical. The address stays
    // platform-controlled — only the display name is per-app.
    await sendEmail({ to: config.email, subject, text: body, fromName: app.name }).catch(e => {
      log.error(`Failed to send deploy notification to ${config.email}: ${e.message}`);
    });
  }
}

export async function notifyHealthChange(appId, env, status) {
  const { getDb } = await import('../db.js');
  const db = getDb();

  const eventCol = status === 'down' ? 'on_app_down' : 'on_app_recovered';

  const configs = db.prepare(`
    SELECT nc.email FROM notification_configs nc
    WHERE nc.app_id = ? AND nc.${eventCol} = 1
  `).all(appId);

  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId);
  if (!app) return;

  const icon = status === 'down' ? 'DOWN' : 'RECOVERED';
  const subject = `[AppCrane] ${app.slug} ${env} is ${icon}`;

  let body = `App: ${app.name} (${app.slug})\n`;
  body += `Environment: ${env}\n`;
  body += `Status: ${icon}\n`;
  body += `Time: ${new Date().toISOString()}\n`;

  if (status === 'down') {
    body += `\nACTION REQUIRED: Check app logs and consider rollback.\n`;
  }

  for (const config of configs) {
    // v2.21.29: send as the app's own name ("AgentClub <appcrane@example.com>").
    // Without fromName the transport emits no display name and the recipient's
    // client falls back to the shared mailbox's directory name ("AIMI"), so
    // every app's notifications looked identical. The address stays
    // platform-controlled — only the display name is per-app.
    await sendEmail({ to: config.email, subject, text: body, fromName: app.name }).catch(e => {
      log.error(`Failed to send health notification to ${config.email}: ${e.message}`);
    });
  }
}
