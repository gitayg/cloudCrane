import { execFileSync, execSync } from 'child_process';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../../db.js';
import { decrypt } from '../encryption.js';
import { ensureStudioImage } from '../appstudio/generator.js';
import { ClaudeRunner } from './claudeRunner.js';
import log from '../../utils/logger.js';

const STUDIO_IMAGE  = process.env.APPSTUDIO_IMAGE || 'appcrane-studio:latest';
const IDLE_EVICT_MS = parseInt(process.env.CODER_IDLE_MS || '1800000', 10); // 30 min

function coderRoot() {
  return resolve(join(process.env.DATA_DIR || './data', 'coder-sessions'));
}

function sessionDir(sessionId) {
  return join(coderRoot(), sessionId);
}

function apiKeyPath(sessionId) {
  return join(sessionDir(sessionId), 'api_key');
}

/** In-memory map of active sessions { sessionId → SessionState } */
const sessions = new Map();

/** SSE subscriber lists { sessionId → Set<(event)=>void> } */
const subscribers = new Map();

function publish(sessionId, event) {
  const subs = subscribers.get(sessionId);
  if (subs) for (const fn of subs) fn(event);
}

export function subscribe(sessionId, fn) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(fn);
  return () => subscribers.get(sessionId)?.delete(fn);
}

function updateDb(sessionId, fields) {
  const db = getDb();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE coder_sessions SET ${sets} WHERE id = ?`)
    .run(...Object.values(fields), sessionId);
}

function appendMessage(sessionId, role, content, tokens) {
  const db = getDb();
  const row = db.prepare(
    'INSERT INTO coder_session_messages (session_id, role, content, tokens) VALUES (?, ?, ?, ?) RETURNING id'
  ).get(sessionId, role, content, tokens ?? null);
  return row?.id;
}

function touchActivity(sessionId) {
  updateDb(sessionId, { last_activity_at: new Date().toISOString() });
  const state = sessions.get(sessionId);
  if (state) state.lastActivityAt = Date.now();
}

// ── Idle eviction timer ──────────────────────────────────────────────────

setInterval(() => {
  const threshold = Date.now() - IDLE_EVICT_MS;
  for (const [sessionId, state] of sessions) {
    if (state.status !== 'idle') continue;
    if (state.lastActivityAt > threshold) continue;
    log.info(`Coder: idle evicting session ${sessionId}`);
    _evict(sessionId, state).catch(err => log.warn(`Coder evict error: ${err.message}`));
  }
}, 5 * 60 * 1000);

async function _evict(sessionId, state) {
  state.status = 'paused';
  if (state.containerId) {
    try {
      execFileSync('docker', ['stop', '-t', '10', state.containerId], { stdio: 'pipe', timeout: 20000 });
    } catch (_) {}
  }
  updateDb(sessionId, { status: 'paused', container_id: null });
  sessions.delete(sessionId);
  publish(sessionId, { type: 'status', status: 'paused' });
}

// ── On-startup orphan recovery ───────────────────────────────────────────

export function recoverOrphans() {
  const db = getDb();
  const orphans = db.prepare(
    "SELECT * FROM coder_sessions WHERE status IN ('starting', 'idle', 'active')"
  ).all();

  for (const s of orphans) {
    if (!s.container_id) {
      db.prepare("UPDATE coder_sessions SET status = 'paused' WHERE id = ?").run(s.id);
      continue;
    }
    try {
      execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', s.container_id], { stdio: 'pipe', timeout: 5000 });
      // Container still running — re-register in memory
      sessions.set(s.id, {
        containerId: s.container_id,
        workspaceDir: s.workspace_dir,
        branch: s.branch_name,
        status: 'idle',
        lastActivityAt: new Date(s.last_activity_at + 'Z').getTime() || Date.now(),
        runner: null,
      });
      log.info(`Coder: recovered session ${s.id} (container ${s.container_id})`);
    } catch (_) {
      db.prepare("UPDATE coder_sessions SET status = 'paused', container_id = NULL WHERE id = ?").run(s.id);
      log.warn(`Coder: orphan session ${s.id} — container gone, marked paused`);
    }
  }
}

// ── Clone helpers ─────────────────────────────────────────────────────────

function cloneWorkspace(sessionId, app, branchName, onLog) {
  const workspaceDir = join(sessionDir(sessionId), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  chmodSync(workspaceDir, 0o777);

  let cloneUrl = app.github_url;
  if (app.github_token_encrypted) {
    try {
      const token = decrypt(app.github_token_encrypted);
      const url = new URL(app.github_url);
      url.username = token;
      cloneUrl = url.toString();
    } catch (_) {}
  }

  onLog?.(`[coder:git] Cloning ${app.github_url} (${app.branch || 'main'})…`);
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', app.branch || 'main', cloneUrl, workspaceDir], {
      stdio: 'pipe', timeout: 120000,
    });
  } catch (err) {
    throw new Error(err.message.replaceAll(cloneUrl, app.github_url));
  }

  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'coder@appcrane.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'AppCrane Coder'], { stdio: 'pipe' });
  execFileSync('git', ['-C', workspaceDir, 'checkout', '-b', branchName], { stdio: 'pipe' });

  try { execFileSync('chmod', ['-R', '777', workspaceDir], { stdio: 'pipe' }); } catch (_) {}
  try { execFileSync('chown', ['-R', '1000:1000', workspaceDir], { stdio: 'pipe' }); } catch (_) {}

  onLog?.(`[coder:git] Workspace ready`);
  return workspaceDir;
}

function startContainer(sessionId, workspaceDir, onLog) {
  const containerName = `appcrane-coder-${sessionId}`;
  const sDir = sessionDir(sessionId);

  const args = [
    'run', '-d', '--rm',
    '--name', containerName,
    '--label', 'appcrane=true',
    '--label', 'appcrane.container.type=coder',
    '--label', `coder.session=${sessionId}`,
    '--memory=2g', '--cpus=1',
    '-v', `${workspaceDir}:/workspace`,
    '-v', `${sDir}:/studio:ro`,
    STUDIO_IMAGE,
    'tail', '-f', '/dev/null',
  ];

  onLog?.(`[coder] Starting container ${containerName}…`);
  const out = execFileSync('docker', args, { stdio: 'pipe', timeout: 30000 });
  const containerId = out.toString().trim();
  onLog?.(`[coder] Container ready: ${containerId.slice(0, 12)}`);
  return containerId;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function createSession(app, userId, onLog) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const db = getDb();

  const existing = db.prepare(
    "SELECT id FROM coder_sessions WHERE app_slug = ? AND status NOT IN ('shipped', 'paused', 'error')"
  ).get(app.slug);
  if (existing) throw new Error(`Active coder session already exists: ${existing.id}`);

  const sessionId  = randomUUID();
  const branchName = `coder/${sessionId}`;

  mkdirSync(sessionDir(sessionId), { recursive: true });
  writeFileSync(apiKeyPath(sessionId), process.env.ANTHROPIC_API_KEY, { mode: 0o600 }); // nosemgrep

  db.prepare(`
    INSERT INTO coder_sessions (id, app_slug, user_id, branch_name, status)
    VALUES (?, ?, ?, ?, 'starting')
  `).run(sessionId, app.slug, userId, branchName);

  try {
    await ensureStudioImage(onLog);
    const workspaceDir = cloneWorkspace(sessionId, app, branchName, onLog);
    const containerId  = startContainer(sessionId, workspaceDir, onLog);

    sessions.set(sessionId, {
      containerId,
      workspaceDir,
      branch: branchName,
      status: 'idle',
      lastActivityAt: Date.now(),
      runner: null,
    });

    updateDb(sessionId, {
      status: 'idle',
      container_id: containerId,
      workspace_dir: workspaceDir,
    });

    publish(sessionId, { type: 'status', status: 'idle' });
    return sessionId;
  } catch (err) {
    updateDb(sessionId, { status: 'error' });
    sessions.delete(sessionId);
    throw err;
  }
}

export async function resumeSession(sessionId, onLog) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM coder_sessions WHERE id = ?').get(sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'paused') throw new Error(`Session status is '${row.status}', expected 'paused'`);
  if (!row.workspace_dir || !existsSync(row.workspace_dir)) {
    throw new Error('Workspace directory no longer exists — session cannot be resumed');
  }

  await ensureStudioImage(onLog);
  const containerId = startContainer(sessionId, row.workspace_dir, onLog);

  sessions.set(sessionId, {
    containerId,
    workspaceDir: row.workspace_dir,
    branch: row.branch_name,
    status: 'idle',
    lastActivityAt: Date.now(),
    runner: null,
  });

  updateDb(sessionId, { status: 'idle', container_id: containerId });
  publish(sessionId, { type: 'status', status: 'idle' });
}

export async function dispatch(sessionId, prompt) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Session not active (start or resume first)');
  if (state.runner) throw new Error('A dispatch is already running');

  touchActivity(sessionId);
  appendMessage(sessionId, 'user', prompt);
  updateDb(sessionId, { status: 'active' });
  state.status = 'active';
  publish(sessionId, { type: 'status', status: 'active' });

  const runner = new ClaudeRunner({
    containerId:  state.containerId,
    workspaceDir: state.workspaceDir,
    prompt,
    apiKeyPath:   `/studio/api_key`,
  });
  state.runner = runner;

  let assistantBuf = '';

  runner.on('data', (ev) => {
    touchActivity(sessionId);
    if (ev.type === 'text') assistantBuf += ev.text;
    const db = getDb();
    db.prepare(`
      INSERT INTO coder_session_messages (session_id, role, content) VALUES (?, 'system', ?)
    `).run(sessionId, JSON.stringify(ev));
    publish(sessionId, { type: 'stream', event: ev });
  });

  runner.on('result', (ev) => {
    const db = getDb();
    const newTokens = (db.prepare('SELECT cost_tokens FROM coder_sessions WHERE id = ?').get(sessionId)?.cost_tokens || 0)
      + ev.inputTokens + ev.outputTokens;
    const newCents = (db.prepare('SELECT cost_usd_cents FROM coder_sessions WHERE id = ?').get(sessionId)?.cost_usd_cents || 0)
      + ev.costUsdCents;
    updateDb(sessionId, { cost_tokens: newTokens, cost_usd_cents: newCents });
    publish(sessionId, { type: 'cost', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsdCents: ev.costUsdCents });
  });

  runner.on('exit', (code) => {
    if (assistantBuf) appendMessage(sessionId, 'assistant', assistantBuf);
    state.runner = null;
    state.status = 'idle';
    updateDb(sessionId, { status: 'idle' });
    publish(sessionId, { type: 'status', status: 'idle', exitCode: code });
  });

  runner.on('error', (err) => {
    state.runner = null;
    state.status = 'idle';
    updateDb(sessionId, { status: 'idle' });
    publish(sessionId, { type: 'error', message: err.message });
    publish(sessionId, { type: 'status', status: 'idle' });
  });

  runner.start();
}

export function stopDispatch(sessionId) {
  const state = sessions.get(sessionId);
  if (!state?.runner) return;
  state.runner.stop();
  state.runner = null;
  state.status = 'idle';
  updateDb(sessionId, { status: 'idle' });
  publish(sessionId, { type: 'status', status: 'idle' });
}

export function getInMemorySession(sessionId) {
  return sessions.get(sessionId) ?? null;
}
