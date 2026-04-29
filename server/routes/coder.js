import { Router } from 'express';
import { getDb } from '../db.js';
import { hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import { auditMiddleware } from '../middleware/audit.js';
import { commitAndPush } from '../services/coder/gitOps.js';
import {
  createSession,
  resumeSession,
  dispatch,
  stopDispatch,
  subscribe,
} from '../services/coder/coderSession.js';
import log from '../utils/logger.js';

const router = Router();

// Auth: accepts X-API-Key header, Bearer identity token, or query-param equivalents
// (query params used by SSE because EventSource cannot send custom headers).
router.use((req, res, next) => {
  const db = getDb();
  // Promote SSE query params to headers
  if (req.query.api_key && !req.headers['x-api-key']) req.headers['x-api-key'] = req.query.api_key;
  if (req.query.token && !req.headers.authorization) req.headers.authorization = `Bearer ${req.query.token}`;

  // Try X-API-Key first
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = db.prepare('SELECT * FROM users WHERE api_key_hash = ?').get(hashApiKey(apiKey));
    if (user?.active) { req.user = user; return next(); }
  }

  // Try Bearer (identity session)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const session = db.prepare(`
      SELECT s.*, u.id as id, u.name, u.email, u.username, u.role, u.active
      FROM identity_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(hashApiKey(token));
    if (session?.active) { req.user = session; return next(); }
  }

  return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
});

function getApp(slug) {
  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
  if (!app) throw new AppError(`App '${slug}' not found`, 404, 'NOT_FOUND');
  return app;
}

function getSession(sessionId, slug) {
  const db = getDb();
  const s = db.prepare('SELECT * FROM coder_sessions WHERE id = ?').get(sessionId);
  if (!s) throw new AppError('Session not found', 404, 'NOT_FOUND');
  if (s.app_slug !== slug) throw new AppError('Session does not belong to this app', 403, 'FORBIDDEN');
  return s;
}

// ── POST /api/coder/:slug/session — start a new session ─────────────────

router.post('/:slug/session', auditMiddleware('coder.start'), async (req, res) => {
  const app = getApp(req.params.slug);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY not configured', 503, 'NOT_CONFIGURED');
  }
  if (!app.github_url) {
    throw new AppError('App must have a GitHub URL configured to use Coder', 400, 'NO_GITHUB');
  }

  const logs = [];
  const onLog = (msg) => {
    logs.push(msg);
    log.info(`[coder:${app.slug}] ${msg}`);
  };

  const sessionId = await createSession(app, req.user.id, onLog);
  res.status(201).json({ session_id: sessionId, log: logs });
});

// ── GET /api/coder/:slug/session — get active/latest session ─────────────

router.get('/:slug/session', (req, res) => {
  getApp(req.params.slug);
  const db = getDb();
  const session = db.prepare(`
    SELECT * FROM coder_sessions WHERE app_slug = ? ORDER BY created_at DESC LIMIT 1
  `).get(req.params.slug);
  if (!session) return res.json({ session: null });
  res.json({ session });
});

// ── GET /api/coder/:slug/session/:id — get specific session ──────────────

router.get('/:slug/session/:id', (req, res) => {
  const session = getSession(req.params.id, req.params.slug);
  const db = getDb();
  const messages = db.prepare(
    "SELECT * FROM coder_session_messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 100"
  ).all(session.id).reverse();
  res.json({ session, messages });
});

// ── POST /api/coder/:slug/session/:id/dispatch — send a message ──────────

router.post('/:slug/session/:id/dispatch', async (req, res) => {
  getApp(req.params.slug);
  const session = getSession(req.params.id, req.params.slug);
  if (!['idle', 'active'].includes(session.status)) {
    throw new AppError(`Session is '${session.status}', must be idle to dispatch`, 400, 'WRONG_STATUS');
  }

  const { prompt } = req.body || {};
  if (!prompt?.trim()) throw new AppError('prompt is required', 400, 'VALIDATION');

  await dispatch(req.params.id, prompt.trim());
  res.json({ message: 'Dispatch started' });
});

// ── POST /api/coder/:slug/session/:id/stop — stop current dispatch ───────

router.post('/:slug/session/:id/stop', (req, res) => {
  getApp(req.params.slug);
  getSession(req.params.id, req.params.slug);
  stopDispatch(req.params.id);
  res.json({ message: 'Stopped' });
});

// ── POST /api/coder/:slug/session/:id/resume — re-start evicted session ──

router.post('/:slug/session/:id/resume', auditMiddleware('coder.resume'), async (req, res) => {
  getApp(req.params.slug);
  const session = getSession(req.params.id, req.params.slug);
  if (session.status !== 'paused') {
    throw new AppError(`Session is '${session.status}', must be paused to resume`, 400, 'WRONG_STATUS');
  }

  const logs = [];
  await resumeSession(req.params.id, (msg) => { logs.push(msg); log.info(`[coder:resume] ${msg}`); });
  res.json({ message: 'Session resumed', log: logs });
});

// ── POST /api/coder/:slug/session/:id/ship — commit, push, deploy sandbox

router.post('/:slug/session/:id/ship', auditMiddleware('coder.ship'), async (req, res) => {
  const app = getApp(req.params.slug);
  const session = getSession(req.params.id, req.params.slug);
  if (!['idle', 'paused'].includes(session.status)) {
    throw new AppError(`Session is '${session.status}', stop the current run before shipping`, 400, 'WRONG_STATUS');
  }
  if (!session.workspace_dir) {
    throw new AppError('Workspace not found — session may have been evicted', 400, 'NO_WORKSPACE');
  }

  const db = getDb();
  const { getPortsForSlot } = await import('../services/portAllocator.js');
  const { deployApp } = await import('../services/deployer.js');

  const summaryMsg = req.body?.message?.trim() || `coder session ${session.id.slice(0, 8)}`;
  const commitMsg  = `coder: ${summaryMsg.slice(0, 72)}`;

  const logs = [];
  const onLog = (msg) => { logs.push(msg); log.info(`[coder:ship] ${msg}`); };

  const { pushed, reason } = await commitAndPush({
    workspaceDir: session.workspace_dir,
    branchName: session.branch_name,
    commitMsg,
    onLog,
  });

  if (!pushed) {
    return res.json({ message: `Nothing to ship (${reason})`, deployed: false });
  }

  const deployRow = db.prepare(
    "INSERT INTO deployments (app_id, env, status, log) VALUES (?, 'sandbox', 'pending', ?) RETURNING id"
  ).get(app.id, `Coder ship: ${summaryMsg}`);

  const ports = getPortsForSlot(app.slot);

  db.prepare("UPDATE coder_sessions SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?")
    .run(session.id);

  deployApp(deployRow.id, app, 'sandbox', ports, { preExtractedDir: session.workspace_dir })
    .catch(err => log.error(`Coder ship deploy failed for ${app.slug}: ${err.message}`));

  res.json({ message: 'Shipped to sandbox', deploy_id: deployRow.id, branch: session.branch_name });
});

// ── GET /api/coder/:slug/session/:id/events — SSE stream ─────────────────

router.get('/:slug/session/:id/events', (req, res) => {
  getApp(req.params.slug);
  const session = getSession(req.params.id, req.params.slug);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Replay recent messages from DB
  const afterId = parseInt(req.query.after || '0', 10);
  const db = getDb();
  const recent = db.prepare(
    "SELECT * FROM coder_session_messages WHERE session_id = ? AND id > ? AND role = 'system' ORDER BY id ASC LIMIT 200"
  ).all(session.id, afterId);
  for (const row of recent) {
    try { send(JSON.parse(row.content)); } catch (_) {}
  }

  // Send current status
  send({ type: 'status', status: session.status });

  const unsub = subscribe(req.params.id, send);

  req.on('close', unsub);
});

export default router;
