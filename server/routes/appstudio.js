import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import log from '../utils/logger.js';

const router = Router();

router.use(requireAuth);

function isAppAdmin(userId, appSlug) {
  if (!userId || !appSlug) return false;
  const db = getDb();
  const app = db.prepare('SELECT id FROM apps WHERE slug = ?').get(appSlug);
  if (!app) return false;
  const row = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(app.id, userId);
  return row?.app_role === 'admin';
}

const AUTO_STATUSES = [
  'new', 'selected', 'planning', 'pending_user_review_plan',
  'plan_approved', 'coding', 'sandbox_ready', 'merged',
  'auto_failed', 'in_progress', 'done', 'no_changes_needed',
];

// ── Enhancement requests (extends existing) ─────────────────────────────

/**
 * POST /api/appstudio/:id/plan - Trigger AI plan generation for an enhancement
 */
router.post('/:id/plan', requireAdmin, auditMiddleware('appstudio.plan'), (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY not configured. Add it to .env and restart.', 503, 'NOT_CONFIGURED');
  }

  db.prepare("UPDATE enhancement_requests SET mode = 'auto', status = 'planning' WHERE id = ?")
    .run(enh.id);
  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'plan');

  res.json({ message: 'Plan queued', enhancement_id: enh.id });
});

/**
 * POST /api/appstudio/:id/approve-plan - Approve the AI plan → trigger code generation
 */
router.post('/:id/approve-plan', auditMiddleware('appstudio.approve-plan'), (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');
  if (req.user.role !== 'admin' && !isAppAdmin(req.user.id, enh.app_slug)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  if (!enh.ai_plan_json) throw new AppError('No plan to approve', 400, 'NO_PLAN');

  db.prepare("UPDATE enhancement_requests SET status = 'plan_approved' WHERE id = ?").run(enh.id);
  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'code');

  res.json({ message: 'Plan approved, code generation queued', enhancement_id: enh.id });
});

/**
 * POST /api/appstudio/:id/plan-feedback - Send revision feedback → re-plan
 */
router.post('/:id/plan-feedback', auditMiddleware('appstudio.plan-feedback'), (req, res) => {
  const { comment } = req.body;
  if (!comment?.trim()) throw new AppError('Comment is required', 400, 'VALIDATION');

  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');

  const isAdmin = req.user?.role === 'admin';
  const existing = isAdmin ? (enh.admin_comments || '') : (enh.user_comments || '');
  const updated = existing + `\n[${new Date().toISOString()}] ${comment.trim()}`;

  if (isAdmin) {
    db.prepare("UPDATE enhancement_requests SET admin_comments = ?, status = 'planning' WHERE id = ?").run(updated, enh.id);
  } else {
    db.prepare("UPDATE enhancement_requests SET user_comments = ?, status = 'planning' WHERE id = ?").run(updated, enh.id);
  }
  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'revise_plan');

  res.json({ message: 'Feedback saved, re-planning queued' });
});

/**
 * POST /api/appstudio/:id/approve-sandbox - Approve sandbox → open PR + promote
 */
router.post('/:id/approve-sandbox', auditMiddleware('appstudio.approve-sandbox'), (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');
  if (req.user.role !== 'admin' && !isAppAdmin(req.user.id, enh.app_slug)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
  if (!enh.branch_name) throw new AppError('No branch to open PR from', 400, 'NO_BRANCH');

  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'open_pr');

  res.json({ message: 'PR creation queued' });
});

/**
 * POST /api/appstudio/:id/reject - Reject enhancement (stop all processing)
 */
router.post('/:id/reject', auditMiddleware('appstudio.reject'), (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');
  if (req.user.role !== 'admin' && !isAppAdmin(req.user.id, enh.app_slug)) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  db.prepare("UPDATE enhancement_requests SET status = 'done', ai_log = COALESCE(ai_log, '') || ? WHERE id = ?")
    .run(`\n[${new Date().toISOString()}] Rejected by ${req.user.name}\n`, enh.id);
  db.prepare("UPDATE enhancement_jobs SET status = 'failed', error_message = 'rejected' WHERE enhancement_id = ? AND status IN ('queued', 'running')")
    .run(enh.id);

  res.json({ message: 'Enhancement rejected' });
});

/**
 * POST /api/appstudio/jobs/:jobId/retry - Re-queue a failed job
 */
router.post('/jobs/:jobId/retry', requireAdmin, auditMiddleware('appstudio.retry'), (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM enhancement_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  if (job.status !== 'failed') throw new AppError('Only failed jobs can be retried', 400, 'NOT_FAILED');

  db.transaction(() => {
    db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(job.enhancement_id, job.phase);
    db.prepare("UPDATE enhancement_requests SET status = 'plan_approved', ai_log = COALESCE(ai_log, '') || ? WHERE id = ? AND status = 'auto_failed'")
      .run(`\n[${new Date().toISOString()}] Job #${job.id} (${job.phase}) retried\n`, job.enhancement_id);
  })();

  res.json({ message: 'Job re-queued' });
});

/**
 * DELETE /api/appstudio/jobs/:jobId - Delete a job record
 */
router.delete('/jobs/:jobId', requireAdmin, auditMiddleware('appstudio.delete-job'), (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM enhancement_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) throw new AppError('Job not found', 404, 'NOT_FOUND');
  if (job.status === 'running') throw new AppError('Cannot delete a running job', 400, 'JOB_RUNNING');

  db.prepare('DELETE FROM enhancement_jobs WHERE id = ?').run(job.id);
  res.json({ message: 'Job deleted' });
});

// ── Anthropic API key management ────────────────────────────────────────
// MUST be registered before GET /:id to prevent "anthropic-key" matching as an id param.

const envFilePath = join(resolve(import.meta.dirname, '..', '..'), '.env');

function writeEnvKey(key, value) {
  let content = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.trim().startsWith(key + '='));
  if (idx !== -1) {
    lines[idx] = `${key}=${value}`;
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    lines.push(`${key}=${value}`);
  }
  writeFileSync(envFilePath, lines.join('\n'), 'utf8');
}

router.get('/anthropic-key', requireAdmin, async (req, res) => {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  if (!configured) return res.json({ configured: false, source: null });
  const inFile = existsSync(envFilePath) &&
    readFileSync(envFilePath, 'utf8').split('\n').some(l => l.trim().startsWith('ANTHROPIC_API_KEY='));
  if (req.query.test === '1') {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      return res.json({ configured: true, source: inFile ? 'file' : 'env', suffix: process.env.ANTHROPIC_API_KEY.slice(-4), valid: true });
    } catch (err) {
      return res.json({ configured: true, source: inFile ? 'file' : 'env', suffix: process.env.ANTHROPIC_API_KEY.slice(-4), valid: false, error: err.message });
    }
  }
  const suffix = process.env.ANTHROPIC_API_KEY.slice(-4);
  res.json({ configured: true, source: inFile ? 'file' : 'env', suffix });
});

router.put('/anthropic-key', requireAdmin, auditMiddleware('appstudio.set-anthropic-key'), async (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new AppError('key is required', 400, 'VALIDATION');
  }
  const trimmed = key.trim();
  writeEnvKey('ANTHROPIC_API_KEY', trimmed);
  process.env.ANTHROPIC_API_KEY = trimmed;
  try {
    const { startWorker } = await import('../services/appstudio/worker.js');
    startWorker();
  } catch (_) {}
  log.info('Anthropic API key updated via settings');
  res.json({ message: 'Anthropic API key saved and applied' });
});

/**
 * GET /api/appstudio/:id/trace - Full job trace with parsed output
 */
router.get('/:id/trace', (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT id, status, ai_log FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');

  const jobs = db.prepare('SELECT * FROM enhancement_jobs WHERE enhancement_id = ? ORDER BY id ASC').all(enh.id);

  const trace = jobs.map(j => {
    let output = null;
    if (j.output_json) { try { output = JSON.parse(j.output_json); } catch (_) {} }
    const startMs = j.started_at ? new Date(j.started_at + 'Z').getTime() : null;
    const endMs   = j.finished_at ? new Date(j.finished_at + 'Z').getTime() : null;
    return {
      id: j.id,
      phase: j.phase,
      status: j.status,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      duration_ms: startMs && endMs ? endMs - startMs : null,
      error: j.error_message,
      log: output?.log || null,
      text: output?.text || null,
      branch: output?.branchName || null,
      cost_tokens: j.cost_tokens || 0,
      cost_usd_cents: j.cost_usd_cents || 0,
    };
  });

  res.json({
    id: enh.id,
    status: enh.status,
    ai_log: enh.ai_log || '',
    active: jobs.some(j => j.status === 'running' || j.status === 'queued'),
    trace,
  });
});

/**
 * GET /api/appstudio/:id - Full enhancement detail with plan + jobs
 */
router.get('/:id', (req, res) => {
  const db = getDb();
  const enh = db.prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(req.params.id);
  if (!enh) throw new AppError('Enhancement not found', 404, 'NOT_FOUND');

  const jobs = db.prepare('SELECT * FROM enhancement_jobs WHERE enhancement_id = ? ORDER BY id ASC').all(enh.id);

  let plan = null;
  if (enh.ai_plan_json) {
    try { plan = JSON.parse(enh.ai_plan_json); } catch (_) {}
  }

  res.json({
    enhancement: {
      ...enh,
      ai_plan: plan,
    },
    jobs,
  });
});

/**
 * GET /api/appstudio/jobs - All active/recent jobs
 */
router.get('/jobs/list', requireAdmin, (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT j.*, er.message as enhancement_message, er.app_slug
    FROM enhancement_jobs j
    JOIN enhancement_requests er ON er.id = j.enhancement_id
    ORDER BY j.id DESC LIMIT 50
  `).all();
  res.json({ jobs });
});

// ── Agent context per app ───────────────────────────────────────────────

function agentContextPath(slug) {
  return join(resolve(process.env.DATA_DIR || './data'), 'apps', slug, 'agent-context.md');
}

/**
 * GET /api/appstudio/context/:slug - Read agent context for an app
 */
router.get('/context/:slug', (req, res) => {
  const path = agentContextPath(req.params.slug);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  res.json({ slug: req.params.slug, content });
});

/**
 * PUT /api/appstudio/context/:slug - Write agent context for an app
 */
router.put('/context/:slug', requireAdmin, auditMiddleware('appstudio.agent-context'), (req, res) => {
  const { content } = req.body;
  if (content == null) throw new AppError('content is required', 400, 'VALIDATION');

  const path = agentContextPath(req.params.slug);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');

  res.json({ slug: req.params.slug, message: 'Agent context saved' });
});

// ── Usage / cost summary ────────────────────────────────────────────────

/**
 * GET /api/appstudio/usage - Monthly cost summary
 */
router.get('/usage/summary', requireAdmin, (req, res) => {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_jobs,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(COALESCE(cost_tokens, 0)) as total_tokens,
      SUM(COALESCE(cost_usd_cents, 0)) as total_cents
    FROM enhancement_jobs
    WHERE created_at >= ?
  `).get(`${month}-01`);

  res.json({
    month,
    ...stats,
    total_usd: ((stats?.total_cents || 0) / 100).toFixed(2),
  });
});


/**
 * POST /api/appstudio/chat - Conversational pre-planning with AI (Feature 17)
 */
router.post('/chat', requireAdmin, async (req, res) => {
  const { app_slug, messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    throw new AppError('messages array required', 400, 'VALIDATION');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY not configured', 503, 'NOT_CONFIGURED');
  }

  const db = getDb();
  let appContext = '';
  if (app_slug) {
    const app = db.prepare('SELECT name, description FROM apps WHERE slug = ?').get(app_slug);
    if (app) appContext = `App: ${app.name}${app.description ? ` — ${app.description}` : ''}.`;
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = [
    'You are a product planning assistant for AppCrane, an AI-powered app deployment platform.',
    appContext,
    'Help the user clarify and scope their feature request. Ask one focused question at a time.',
    'Keep responses under 3 sentences. When requirements are clear, offer a concise summary starting with "Summary:".',
  ].filter(Boolean).join(' ');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: String(m.content) })),
  });

  res.json({ content: response.content[0].text });
});

export default router;
