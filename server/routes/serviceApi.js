/**
 * Internal service API for hosted apps (v2.8.0).
 *
 * Reachable ONLY from an app's own server process:
 *   - the app authenticates with APPCRANE_SERVICE_TOKEN (a container env var),
 *   - it reaches AppCrane at CRANE_INTERNAL_URL (http://host.docker.internal:5001),
 *     i.e. straight off the docker bridge, NOT through Caddy.
 *
 * Two guards keep it server-side-only:
 *   1. Caddy 404s /api/service/* on the public domain (see caddy.js).
 *   2. This handler rejects any request that arrived via Caddy (a proxied
 *      request carries Via / X-Forwarded-* that a direct bridge call does not).
 * Plus the token itself, which a browser can never obtain.
 */

import { Router } from 'express';
import { AppError } from '../utils/errors.js';
import { appForServiceToken } from '../services/appServiceToken.js';
import { enqueueEmail } from '../services/emailQueue.js';
import log from '../utils/logger.js';

const router = Router();

// Reject anything that came through the public reverse proxy. Legit internal
// callers hit host.docker.internal:5001 directly and carry none of these.
function assertInternal(req) {
  if (req.headers['via'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for']) {
    throw new AppError('This endpoint is reachable only from an app container, not the public domain.', 403, 'NOT_INTERNAL');
  }
}

function authApp(req) {
  // v2.8.3: email is available to every app — a valid service token is the
  // only requirement (no per-app enable flag).
  const token = (req.headers['x-appcrane-service-token'] || '').toString().trim();
  const app = appForServiceToken(token);
  if (!app) throw new AppError('Invalid or missing X-AppCrane-Service-Token', 401, 'BAD_SERVICE_TOKEN');
  return app;
}

/**
 * POST /api/service/email
 * Body: { to, subject, text?, html?, replyTo?, env?, idempotencyKey?, fromName?,
 *         attachments? }
 *   attachments: [{ filename, content(base64), contentType? }] — max 10, 3 MB total.
 * The recipient must be a registered platform user. Returns 202 + queue id.
 */
router.post('/email', (req, res) => {
  assertInternal(req);
  const app = authApp(req);
  const { to, subject, text, html, replyTo, env, idempotencyKey, fromName, attachments } = req.body || {};

  try {
    const { id, deduped } = enqueueEmail({
      appId: app.id,
      env: env === 'production' ? 'production' : 'sandbox',
      to, subject, text, html, replyTo, attachments,
      // Display name: the app decides per-send (fromName in the body), and it
      // defaults to the app's own name — so MarketMind's mail shows
      // "MarketMind <appcrane@example.com>" with no setup. Only the display name
      // varies; the address is always the platform mailbox.
      //
      // v2.44.0: whatever name lands here, the queue renders it as
      // "<name> via <slug> (AppCrane)" and appends a footer naming the app.
      // An app can still choose how it presents itself; it can no longer
      // choose to present itself as somebody else.
      fromName: (typeof fromName === 'string' && fromName.trim()) ? fromName.trim().slice(0, 100) : app.name,
      idempotencyKey,
      source: 'app',
    });
    log.info(`[service] email queued #${id} for app ${app.slug} → ${to}${deduped ? ' (deduped)' : ''}`);
    res.status(202).json({ queued: true, queue_id: id, deduped: !!deduped });
  } catch (e) {
    // A send budget exhausted is not a malformed request — 429 tells a
    // well-behaved app to back off and retry, where 400 tells it to give up.
    if (e.code === 'EMAIL_RATE_LIMITED') {
      log.warn(`[service] email rate limit hit by app ${app.slug}`);
      throw new AppError(e.message, 429, 'EMAIL_RATE_LIMITED');
    }
    // Validation failures (bad/disallowed recipient, missing fields) → 400.
    throw new AppError(e.message, 400, 'EMAIL_REJECTED');
  }
});

export default router;
