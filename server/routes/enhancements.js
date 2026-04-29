import { Router } from 'express';
import { getDb } from '../db.js';
import { hashApiKey } from '../services/encryption.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const VALID_STATUSES = ['new', 'selected', 'planning', 'in_progress', 'done'];

/**
 * Resolve an identity Bearer token to a user row.
 * Returns null if invalid/expired.
 */
function getUserFromBearer(token) {
  if (!token) return null;
  const db = getDb();
  const tokenHash = hashApiKey(token);
  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.name, u.email, u.username, u.role
    FROM identity_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenHash);
  return session || null;
}

/**
 * POST /api/enhancements
 * Submit an enhancement request. Requires identity Bearer token.
 * Body: { message: "...", app_slug: "..." (optional) }
 */
router.post('/', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = getUserFromBearer(token);

  // Fall back to API key auth (for admin dashboard submissions)
  let userId, userName, userRole;
  if (session) {
    userId = session.user_id;
    userName = session.name;
    userRole = session.role;
  } else {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    const db2 = getDb();
    const user = db2.prepare('SELECT * FROM users WHERE api_key_hash = ?').get(hashApiKey(apiKey));
    if (!user) throw new AppError('Invalid API key', 401, 'UNAUTHORIZED');
    userId = user.id;
    userName = user.name;
    userRole = user.role;
  }

  const { message, app_slug } = req.body || {};
  if (!message || !message.trim()) {
    throw new AppError('message is required', 400, 'VALIDATION');
  }

  const db = getDb();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO enhancement_requests (app_slug, user_id, user_name, message, status)
    VALUES (?, ?, ?, ?, 'new')
  `).run(app_slug || null, userId, userName, message.trim());

  if (process.env.ANTHROPIC_API_KEY) {
    if (userRole === 'admin') {
      db.prepare("UPDATE enhancement_requests SET mode = 'auto', status = 'planning' WHERE id = ?").run(lastInsertRowid);
    } else {
      db.prepare("UPDATE enhancement_requests SET status = 'planning' WHERE id = ?").run(lastInsertRowid);
    }
    db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(lastInsertRowid, 'plan');
  }

  res.json({ message: 'Enhancement request submitted. Thank you!', enhancement_id: lastInsertRowid });
});

/**
 * GET /api/enhancements/my
 * Get the current user's own enhancement requests. Requires Bearer token.
 */
router.get('/my', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = getUserFromBearer(token);
  if (!session) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, app_slug, message, created_at, status
    FROM enhancement_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(session.user_id);
  res.json({ requests: rows });
});

/**
 * GET /api/enhancements
 * List all enhancement requests. Requires admin API key.
 */
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      er.id, er.app_slug, er.user_name, er.message, er.created_at, er.status,
      er.fix_version, er.cost_tokens, er.cost_usd_cents, er.branch_name, er.pr_url,
      j.id        AS latest_job_id,
      j.phase     AS latest_job_phase,
      j.status    AS latest_job_status,
      j.error_message AS latest_job_error,
      j.cost_tokens   AS latest_job_tokens,
      j.cost_usd_cents AS latest_job_cents
    FROM enhancement_requests er
    LEFT JOIN enhancement_jobs j ON j.id = (
      SELECT id FROM enhancement_jobs WHERE enhancement_id = er.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY er.created_at DESC
  `).all();
  res.json({ requests: rows });
});

/**
 * POST /api/enhancements/:id/set-status
 * Set status for an enhancement request. Requires admin.
 * Body: { status: 'consideration' | 'in_progress' | 'done' }
 */
router.post('/:id/set-status', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.includes(status)) {
    throw new AppError(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400, 'VALIDATION');
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM enhancement_requests WHERE id = ?').get(id);
  if (!row) throw new AppError('Not found', 404, 'NOT_FOUND');
  db.prepare('UPDATE enhancement_requests SET status = ? WHERE id = ?').run(status, id);
  res.json({ status });
});

/**
 * POST /api/enhancements/:id/delete
 * Delete an enhancement request. Requires admin.
 */
router.post('/:id/delete', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM enhancement_requests WHERE id = ?').get(id);
  if (!row) throw new AppError('Not found', 404, 'NOT_FOUND');
  db.prepare('DELETE FROM enhancement_jobs WHERE enhancement_id = ?').run(id);
  db.prepare('DELETE FROM enhancement_requests WHERE id = ?').run(id);
  res.json({ message: 'Deleted' });
});

export default router;
