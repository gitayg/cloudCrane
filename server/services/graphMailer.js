/**
 * Microsoft Graph email transport (v2.8.0).
 *
 * Sends as the configured shared mailbox (email_from_address, e.g.
 * appcrane@example.com) using OAuth2 client-credentials (application permission
 * Mail.Send). Config lives in the settings table — the client secret is
 * stored encrypted and decrypted here at send time; nothing is hardcoded.
 *
 * The access token is cached in-process until shortly before expiry so we
 * mint one token per ~hour, not one per email.
 */

import { getDb } from '../db.js';
import { decrypt } from './encryption.js';
import log from '../utils/logger.js';

let _token = null;       // { value, expiresAt(ms) }

function setting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? null;
}

/**
 * Read Graph config from settings (env vars override for local/dev).
 * Returns null if not fully configured — callers fall back to SMTP/mock.
 */
export function getGraphConfig() {
  const db = getDb();
  const tenant = process.env.GRAPH_TENANT_ID || setting(db, 'graph_tenant_id');
  const clientId = process.env.GRAPH_CLIENT_ID || setting(db, 'graph_client_id');
  let secret = process.env.GRAPH_CLIENT_SECRET || null;
  if (!secret) {
    const enc = setting(db, 'graph_client_secret_encrypted');
    if (enc) { try { secret = decrypt(enc); } catch (e) { log.error(`[graph] client secret decrypt failed: ${e.message}`); } }
  }
  const mailbox = setting(db, 'email_from_address') || 'appcrane@example.com';
  if (!tenant || !clientId || !secret) return null;
  return { tenant, clientId, secret, mailbox };
}

export function isGraphConfigured() {
  return getGraphConfig() !== null;
}

/**
 * Liveness probe for the Graph mail credential (v2.25.2). Attempts to obtain an
 * access token (client-credentials) — the same step every send makes — so an
 * expired/rotated client secret or bad tenant/client id surfaces. Returns
 * `{ ok, skipped?, error? }`; `skipped` when Graph isn't configured (nothing to
 * check). Never throws.
 */
export async function probeGraph() {
  const cfg = getGraphConfig();
  if (!cfg) return { ok: true, skipped: true };
  try {
    await getAccessToken(cfg, Date.now());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getAccessToken(cfg, nowMs) {
  if (_token && _token.expiresAt > nowMs + 60_000) return _token.value;
  const url = `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    scope: 'https://graph.microsoft.com/.default',
    client_secret: cfg.secret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Graph token request failed (${res.status}): ${data.error_description || data.error || 'no access_token'}`);
  }
  _token = { value: data.access_token, expiresAt: nowMs + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

/**
 * Send one message via Graph sendMail. Address is always the configured
 * mailbox; `fromName` only sets the display name. Throws on non-2xx so the
 * queue's retry/backoff handles transient Graph/network failures.
 */
export async function sendViaGraph({ to, subject, text, html, fromName, replyTo, attachments }) {
  const cfg = getGraphConfig();
  if (!cfg) throw new Error('Graph not configured');
  const nowMs = Date.now();
  const token = await getAccessToken(cfg, nowMs);

  const message = {
    subject: subject || '',
    body: html
      ? { contentType: 'HTML', content: html }
      : { contentType: 'Text', content: text || '' },
    toRecipients: [{ emailAddress: { address: to } }],
    from: { emailAddress: { address: cfg.mailbox, ...(fromName && { name: fromName }) } },
    ...(replyTo && { replyTo: [{ emailAddress: { address: replyTo } }] }),
    // Inline file attachments (base64 contentBytes). Total size is capped
    // upstream (emailQueue) to stay within Graph's simple sendMail budget.
    ...(attachments?.length && {
      attachments: attachments.map(a => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType || 'application/octet-stream',
        contentBytes: a.content,
      })),
    }),
  };

  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.mailbox)}/sendMail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, saveToSentItems: false }),
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 202) {
    return { messageId: res.headers.get('request-id') || null, transport: 'graph' };
  }
  const errText = await res.text().catch(() => '');
  // Invalidate a possibly-stale token on 401 so the next attempt re-mints.
  if (res.status === 401) _token = null;
  throw new Error(`Graph sendMail failed (${res.status}): ${errText.slice(0, 300)}`);
}
