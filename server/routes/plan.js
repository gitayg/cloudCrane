import { Router } from 'express';
import { getDb } from '../db.js';
import { hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import log from '../utils/logger.js';

const router = Router();

function isAppAdmin(userId, appSlug) {
  if (!userId || !appSlug) return false;
  const db = getDb();
  const app = db.prepare('SELECT id FROM apps WHERE slug = ?').get(appSlug);
  if (!app) return false;
  const row = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(app.id, userId);
  return row?.app_role === 'admin';
}

function resolveUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = (authHeader.replace(/^Bearer\s+/i, '').trim()) || (req.query.token || '');
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

function getEnhancement(id, user) {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');
  if (enh.user_id !== user.userId && user.role !== 'admin') throw new AppError('Access denied', 403, 'FORBIDDEN');
  return enh;
}

// GET /api/plan/:enhancementId — get current plan status
router.get('/:enhancementId', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const id = parseInt(req.params.enhancementId, 10);
  if (isNaN(id)) throw new AppError('Invalid enhancement id', 400, 'VALIDATION');

  const enh = getEnhancement(id, user);
  const db = getDb();
  const job = db.prepare(`
    SELECT id, phase, status, output_json, error_message, created_at
    FROM enhancement_jobs
    WHERE enhancement_id = ? AND phase IN ('plan', 'revise_plan')
    ORDER BY id DESC LIMIT 1
  `).get(id);

  let jobOutput = null;
  if (job?.output_json) { try { jobOutput = JSON.parse(job.output_json); } catch (_) {} }

  res.json({
    id: enh.id,
    status: enh.status,
    message: enh.message,
    plan: enh.ai_plan_json ? (() => { try { return JSON.parse(enh.ai_plan_json); } catch (_) { return null; } })() : null,
    job: job ? { id: job.id, phase: job.phase, status: job.status, output: jobOutput, error: job.error_message } : null,
  });
});

// GET /api/plan/:enhancementId/stream — SSE stream of plan job progress
router.get('/:enhancementId/stream', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const id = parseInt(req.params.enhancementId, 10);
  if (isNaN(id)) throw new AppError('Invalid enhancement id', 400, 'VALIDATION');

  getEnhancement(id, user); // access check only

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');

  let lastText = '';
  let lastStatus = '';
  let lastJobId = null;
  let done = false;
  const connectedAt = Date.now();

  function elapsedSec() { return Math.round((Date.now() - connectedAt) / 1000); }

  function sendStatus(text, extra = {}) {
    res.write(`data: ${JSON.stringify({ type: 'status', text, elapsed: elapsedSec(), ...extra })}\n\n`);
  }

  function checkOnce() {
    if (done) return;
    try {
      const db = getDb();
      const job = db.prepare(`
        SELECT id, status, output_json, error_message, started_at
        FROM enhancement_jobs WHERE enhancement_id = ? AND phase IN ('plan', 'revise_plan')
        ORDER BY id DESC LIMIT 1
      `).get(id);

      if (!job) {
        if (lastStatus !== 'waiting') {
          lastStatus = 'waiting';
          sendStatus('Queued — waiting for worker to pick up the job…');
        }
        return;
      }

      if (lastJobId !== null && job.id !== lastJobId) { lastText = ''; lastStatus = ''; }
      lastJobId = job.id;

      if (job.status === 'queued') {
        // Count jobs ahead in queue
        const ahead = db.prepare(`SELECT COUNT(*) as n FROM enhancement_jobs WHERE status = 'queued' AND id < ?`).get(job.id)?.n || 0;
        const queueMsg = ahead > 0
          ? `Job queued — ${ahead} job${ahead > 1 ? 's' : ''} ahead in queue`
          : 'Job queued — worker will start shortly (checks every 5 seconds)';
        if (lastStatus !== 'queued' || ahead !== (lastStatus._ahead ?? -1)) {
          lastStatus = 'queued';
          lastStatus._ahead = ahead;
          sendStatus(queueMsg, { ahead });
        }
        return;
      }

      if (job.status === 'running') {
        const startedAt = job.started_at ? new Date(job.started_at.replace(' ', 'T') + 'Z').getTime() : null;
        const runSec = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
        const estTotal = 45; // typical plan generation ~30-60s
        const estRemaining = startedAt ? Math.max(0, estTotal - runSec) : null;
        const tokens = db.prepare('SELECT cost_tokens FROM enhancement_jobs WHERE id = ?').get(job.id)?.cost_tokens || 0;
        const runningMsg = runSec !== null
          ? `Analyzing codebase… (${runSec}s elapsed${estRemaining > 0 ? `, ~${estRemaining}s remaining` : ''})`
          : 'Analyzing codebase and generating plan…';
        if (lastStatus !== 'running') {
          lastStatus = 'running';
          sendStatus(runningMsg, { run_sec: runSec, est_remaining: estRemaining, tokens });
        } else if (runSec !== null && runSec % 5 === 0) {
          sendStatus(runningMsg, { run_sec: runSec, est_remaining: estRemaining, tokens });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'tokens', count: tokens })}\n\n`);
        }
        let output = null;
        try { output = job.output_json ? JSON.parse(job.output_json) : null; } catch (_) {}
        if (output?.streaming && output.text && output.text !== lastText) {
          lastText = output.text;
          res.write(`data: ${JSON.stringify({ type: 'progress', text: output.text })}\n\n`);
        }
        return;
      }

      done = true;
      clearInterval(poll);
      clearInterval(keepalive);

      if (job.status === 'done') {
        const enh = db.prepare('SELECT ai_plan_json FROM enhancement_requests WHERE id = ?').get(id);
        let plan = null;
        try { plan = enh?.ai_plan_json ? JSON.parse(enh.ai_plan_json) : null; } catch (_) {}
        res.write(`data: ${JSON.stringify({ type: 'plan', plan, elapsed: elapsedSec() })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'error', message: job.error_message || 'Planning failed' })}\n\n`);
      }
      res.end();
    } catch (err) {
      log.error(`Plan stream poll error: ${err.message}`);
    }
  }

  // Fire once immediately so the client sees status before the first 2s tick
  checkOnce();
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
  const poll = setInterval(checkOnce, 2000);

  req.on('close', () => {
    done = true;
    clearInterval(poll);
    clearInterval(keepalive);
  });
});

// POST /api/plan/:enhancementId/feedback — send refinement feedback, re-queue plan
router.post('/:enhancementId/feedback', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const id = parseInt(req.params.enhancementId, 10);
  if (isNaN(id)) throw new AppError('Invalid enhancement id', 400, 'VALIDATION');

  const enh = getEnhancement(id, user);
  const { comment } = req.body || {};
  if (!comment?.trim()) throw new AppError('comment is required', 400, 'VALIDATION');

  const db = getDb();
  const isAdmin = user.role === 'admin';
  const existing = isAdmin ? (enh.admin_comments || '') : (enh.user_comments || '');
  const updated = existing + `\n[${new Date().toISOString()}] ${comment.trim()}`;

  if (isAdmin) {
    db.prepare("UPDATE enhancement_requests SET admin_comments = ?, status = 'planning' WHERE id = ?").run(updated, id);
  } else {
    db.prepare("UPDATE enhancement_requests SET user_comments = ?, status = 'planning' WHERE id = ?").run(updated, id);
  }
  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(id, 'revise_plan');

  res.json({ message: 'Feedback submitted, re-planning queued' });
});

// POST /api/plan/:enhancementId/build — approve plan and trigger build
router.post('/:enhancementId/build', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const id = parseInt(req.params.enhancementId, 10);
  if (isNaN(id)) throw new AppError('Invalid enhancement id', 400, 'VALIDATION');

  const enh = getEnhancement(id, user);
  if (!enh.ai_plan_json) throw new AppError('No plan available to build', 400, 'NO_PLAN');

  const db = getDb();

  if (user.role === 'admin' || isAppAdmin(user.userId, enh.app_slug)) {
    db.prepare("UPDATE enhancement_requests SET status = 'plan_approved' WHERE id = ?").run(id);
    const { lastInsertRowid } = db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(id, 'code');
    res.json({ message: 'Build queued', auto: true, job_id: Number(lastInsertRowid) });
  } else {
    db.prepare("UPDATE enhancement_requests SET status = 'selected' WHERE id = ?").run(id);
    res.json({ message: 'Plan submitted for admin approval', auto: false });
  }
});

// GET /api/plan/active-job/:slug — returns the active code job for an app (admin only)
router.get('/active-job/:slug', (req, res) => {
  const user = resolveUser(req);
  if (!user || user.role !== 'admin') throw new AppError('Admin only', 403, 'FORBIDDEN');
  const { slug } = req.params;
  const db = getDb();
  const job = db.prepare(`
    SELECT j.id FROM enhancement_jobs j
    JOIN enhancement_requests er ON er.id = j.enhancement_id
    WHERE er.app_slug = ? AND j.phase = 'code' AND j.status IN ('queued', 'running')
    ORDER BY j.id DESC LIMIT 1
  `).get(slug);
  res.json({ job_id: job ? job.id : null });
});

// GET /api/plan/job/:jobId — job detail with logs and token count (polled by UI)
router.get('/job/:jobId', (req, res) => {
  const user = resolveUser(req);
  if (!user) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  const jobId = parseInt(req.params.jobId, 10);
  if (isNaN(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION');

  const db = getDb();
  const job = db.prepare(`
    SELECT j.id, j.phase, j.status, j.output_json, j.cost_tokens, j.cost_usd_cents,
           j.error_message, j.created_at, j.started_at, j.finished_at,
           j.enhancement_id,
           er.user_id, er.message as enhancement_message, er.app_slug
    FROM enhancement_jobs j
    JOIN enhancement_requests er ON er.id = j.enhancement_id
    WHERE j.id = ?
  `).get(jobId);

  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  if (job.user_id !== user.userId && user.role !== 'admin') throw new AppError('Access denied', 403, 'FORBIDDEN');

  let output = null;
  try { output = job.output_json ? JSON.parse(job.output_json) : null; } catch (_) {}

  res.json({
    id: job.id,
    phase: job.phase,
    status: job.status,
    output,
    cost_tokens: job.cost_tokens || 0,
    cost_usd_cents: job.cost_usd_cents || 0,
    error: job.error_message,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    enhancement_message: job.enhancement_message,
    app_slug: job.app_slug,
    enhancement_id: job.enhancement_id,
  });
});

export default router;
