import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../db.js';
import { hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import { runAskJob, hasActiveContainer } from '../services/askClaude.js';
import { ensureCodebaseContext } from '../services/appstudio/contextBuilder.js';
import log from '../utils/logger.js';

const router = Router();

const pendingJobs = new Map(); // jobId -> { logs, clients, done, answer, error }

function resolveUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const db = getDb();
    const session = db.prepare(`
      SELECT s.*, u.id as user_id, u.name, u.role
      FROM identity_sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(hashApiKey(token));
    if (session) return { userId: session.user_id, userName: session.name, role: session.role };
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE api_key_hash = ?').get(hashApiKey(apiKey));
    if (user && user.active) return { userId: user.id, userName: user.name, role: user.role };
  }
  return null;
}

// POST /api/ask/:appSlug — submit a question
router.post('/:appSlug', async (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY not configured', 503, 'NOT_CONFIGURED');
  }

  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(req.params.appSlug);
  if (!app) throw new AppError('App not found', 404, 'NOT_FOUND');
  if (!app.github_url) throw new AppError('App has no GitHub repository — Ask Claude requires source code access', 400, 'NO_REPO');

  if (user.role !== 'admin') {
    const access = db.prepare('SELECT 1 FROM app_users WHERE app_id = ? AND user_id = ?').get(app.id, user.userId);
    if (!access) throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  const { question, session_id } = req.body || {};
  if (!question?.trim()) throw new AppError('question is required', 400, 'VALIDATION');

  let sessionId = session_id ? Number(session_id) : null;
  if (sessionId) {
    const s = db.prepare('SELECT id FROM ask_sessions WHERE id = ? AND user_id = ? AND app_slug = ?').get(sessionId, user.userId, app.slug);
    if (!s) sessionId = null;
  }
  if (!sessionId) {
    const { lastInsertRowid } = db.prepare('INSERT INTO ask_sessions (app_slug, user_id, title) VALUES (?, ?, ?)').run(app.slug, user.userId, question.trim().slice(0, 80));
    sessionId = lastInsertRowid;
  }

  db.prepare("INSERT INTO ask_messages (session_id, role, content) VALUES (?, 'user', ?)").run(sessionId, question.trim());
  db.prepare("UPDATE ask_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);

  const history = db.prepare("SELECT role, content FROM ask_messages WHERE session_id = ? ORDER BY id DESC LIMIT 20").all(sessionId).reverse().slice(0, -1);

  const ctxPath = join(resolve(process.env.DATA_DIR || './data'), 'apps', app.slug, 'agent-context.md'); // nosemgrep: path-join-resolve-traversal — slug is DB-validated
  const agentContext = existsSync(ctxPath) ? readFileSync(ctxPath, 'utf8') : '';

  const repoDir = join(resolve(process.env.DATA_DIR || './data'), 'apps', app.slug, 'production', 'current'); // nosemgrep: path-join-resolve-traversal — slug is DB-validated
  let contextDoc = null;
  try {
    if (existsSync(repoDir)) {
      const result = await ensureCodebaseContext(app.slug, repoDir);
      contextDoc = result.contextDoc || null;
    } else {
      const cached = getDb().prepare('SELECT context_doc FROM app_codebase_context WHERE app_slug = ?').get(app.slug);
      contextDoc = cached?.context_doc || null;
    }
  } catch (_) {}

  const jobId = Date.now();
  const jobState = { logs: [], clients: new Set(), done: false, answer: null, error: null, sessionId, tokens: 0 };
  pendingJobs.set(jobId, jobState);

  runAskJob({ sessionId, app, question: question.trim(), history, agentContext, contextDoc,
    onTokens: (count) => {
      jobState.tokens = count;
      for (const c of jobState.clients) c.write(`data: ${JSON.stringify({ type: 'tokens', count })}\n\n`);
    },
    onLog: (line) => {
      jobState.logs.push(line);
      for (const c of jobState.clients) c.write(`data: ${JSON.stringify({ type: 'log', text: line })}\n\n`);
    },
  }).then(answer => {
    db.prepare("INSERT INTO ask_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(sessionId, answer);
    db.prepare("UPDATE ask_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
    jobState.done = true; jobState.answer = answer;
    for (const c of jobState.clients) { c.write(`data: ${JSON.stringify({ type: 'done', answer, session_id: sessionId })}\n\n`); c.end(); }
    setTimeout(() => pendingJobs.delete(jobId), 120000);
  }).catch(err => {
    log.error(`Ask job ${jobId} failed: ${err.message}`);
    jobState.done = true; jobState.error = err.message;
    for (const c of jobState.clients) { c.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); c.end(); }
    setTimeout(() => pendingJobs.delete(jobId), 120000);
  });

  res.json({ session_id: sessionId, job_id: jobId });
});

// GET /api/ask/stream/:jobId — SSE stream
router.get('/stream/:jobId', (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job id' });
  const job = pendingJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/Caddy proxy buffering

  // Send an immediate comment so the proxy sees bytes and doesn't time out the connection
  res.write(': connected\n\n');

  for (const line of job.logs) res.write(`data: ${JSON.stringify({ type: 'log', text: line })}\n\n`);
  if (job.tokens > 0) res.write(`data: ${JSON.stringify({ type: 'tokens', count: job.tokens })}\n\n`);

  if (job.done) {
    if (job.error) res.write(`data: ${JSON.stringify({ type: 'error', message: job.error })}\n\n`);
    else res.write(`data: ${JSON.stringify({ type: 'done', answer: job.answer, session_id: job.sessionId })}\n\n`);
    return res.end();
  }

  // Keepalive ping every 20s so proxies don't close the connection during long cold starts
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);

  job.clients.add(res);
  req.on('close', () => {
    clearInterval(keepalive);
    job.clients.delete(res);
  });
});

// GET /api/ask/sessions/:appSlug
router.get('/sessions/:appSlug', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const sessions = getDb().prepare('SELECT id, title, created_at, updated_at FROM ask_sessions WHERE app_slug = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 20').all(req.params.appSlug, user.userId);
  res.json({ sessions });
});

// GET /api/ask/session/:sessionId
router.get('/session/:sessionId', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const db = getDb();
  const session = db.prepare('SELECT * FROM ask_sessions WHERE id = ?').get(parseInt(req.params.sessionId, 10));
  if (!session) throw new AppError('Session not found', 404, 'NOT_FOUND');
  if (session.user_id !== user.userId && user.role !== 'admin') throw new AppError('Access denied', 403, 'FORBIDDEN');
  const messages = db.prepare('SELECT role, content, created_at FROM ask_messages WHERE session_id = ? ORDER BY id').all(session.id);
  res.json({ session, messages });
});

// GET /api/ask/jobs — active jobs + user's own requests (Bearer auth)
// Optional query: ?app_slug=xxx — if admin, also returns app_requests for that app
router.get('/jobs', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const db = getDb();

  const my_requests = db.prepare(`
    SELECT er.id, er.app_slug, er.message, er.status, er.created_at,
           j.id as job_id, j.phase, j.status as job_status
    FROM enhancement_requests er
    LEFT JOIN enhancement_jobs j ON j.enhancement_id = er.id AND j.status IN ('queued', 'running')
    WHERE er.user_id = ?
    ORDER BY er.created_at DESC
    LIMIT 20
  `).all(user.userId);

  let active_jobs = [];
  let app_requests = [];

  if (user.role === 'admin') {
    active_jobs = db.prepare(`
      SELECT j.id, j.phase, j.status, j.created_at,
             er.message as enhancement_message, er.app_slug, er.user_name
      FROM enhancement_jobs j
      JOIN enhancement_requests er ON er.id = j.enhancement_id
      WHERE j.status IN ('queued', 'running')
      ORDER BY j.id DESC
      LIMIT 30
    `).all();

    const appSlug = req.query.app_slug;
    if (appSlug) {
      app_requests = db.prepare(`
        SELECT er.id, er.app_slug, er.user_name, er.message, er.status, er.created_at,
               j.id as latest_job_id, j.phase, j.status as job_status
        FROM enhancement_requests er
        LEFT JOIN enhancement_jobs j ON j.id = (
          SELECT id FROM enhancement_jobs WHERE enhancement_id = er.id ORDER BY id DESC LIMIT 1
        )
        WHERE er.app_slug = ?
        ORDER BY er.created_at DESC
        LIMIT 50
      `).all(appSlug);
    }
  }

  res.json({ active_jobs, my_requests, app_requests });
});

// GET /api/ask/active/:appSlug — is any coder container live for this app?
// Returns true when an Ask session container OR an AppStudio coding job is running.
router.get('/active/:appSlug', (req, res) => {
  const slug = req.params.appSlug;
  const askActive = hasActiveContainer(slug);
  if (askActive) return res.json({ active: true });

  const db = getDb();
  const job = db.prepare(`
    SELECT j.id FROM enhancement_jobs j
    JOIN enhancement_requests er ON er.id = j.enhancement_id
    WHERE er.app_slug = ? AND j.phase = 'code' AND j.status IN ('queued', 'running')
    LIMIT 1
  `).get(slug);
  res.json({ active: !!job });
});

export default router;
