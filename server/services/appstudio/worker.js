import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { getDb } from '../../db.js';
import { decrypt } from '../encryption.js';
import { planEnhancement } from './planner.js';
import { generateCode, cloneForBuild, cleanupWorkspace } from './generator.js';
import log from '../../utils/logger.js';

const POLL_MS          = parseInt(process.env.APPSTUDIO_POLL_MS || '5000', 10);
const MAX_PLAN_PARALLEL = parseInt(process.env.APPSTUDIO_MAX_PLAN_PARALLEL || '3', 10);

let _running       = false;
let _activePlans   = 0;  // concurrent plan/revise_plan jobs (read-only, safe to parallelize)
let _activeCodeJob = false; // only one code/build/open_pr job at a time

function recoverOrphanedJobs() {
  const db = getDb();
  const stuck = db.prepare("SELECT * FROM enhancement_jobs WHERE status = 'running'").all();
  if (!stuck.length) return;

  // Get all live studio container names in one docker ps call
  let liveContainers = new Set();
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}', '--filter', 'label=appcrane.container.type=job'], { stdio: 'pipe', timeout: 8000 });
    out.toString().split('\n').forEach(n => { if (n.trim()) liveContainers.add(n.trim()); });
  } catch (_) {}

  const phaseEnhStatus = { plan: 'planning', revise_plan: 'planning', code: 'plan_approved', build: 'pushing', open_pr: 'sandbox_ready' };

  for (const job of stuck) {
    const containerName = `appcrane-studio-${job.id}`;
    if (liveContainers.has(containerName)) continue; // still running, leave it

    const enhStatus = phaseEnhStatus[job.phase] || 'planning';
    db.prepare("UPDATE enhancement_jobs SET status = 'queued', started_at = NULL, error_message = 'Recovered from orphan on restart' WHERE id = ?").run(job.id);
    db.prepare('UPDATE enhancement_requests SET status = ? WHERE id = ?').run(enhStatus, job.enhancement_id);
    log.warn(`AppStudio: orphaned job #${job.id} (phase=${job.phase}) reset to queued — container ${containerName} not found`);
  }
}

export function startWorker() {
  if (_running) return;
  _running = true;
  log.info('AppStudio worker started');
  recoverOrphanedJobs();
  tick();
}

export function stopWorker() {
  _running = false;
}

async function tick() {
  if (!_running) return;
  try {
    // Drain plan queue — run up to MAX_PLAN_PARALLEL concurrently (fire-and-forget per job)
    while (_activePlans < MAX_PLAN_PARALLEL) {
      const job = claimJob(['plan', 'revise_plan']);
      if (!job) break;
      _activePlans++;
      runJob(job).finally(() => { _activePlans--; });
    }

    // Run at most one code/build/open_pr job at a time
    if (!_activeCodeJob) {
      const job = claimJob(['code', 'build', 'open_pr']);
      if (job) {
        _activeCodeJob = true;
        runJob(job).finally(() => { _activeCodeJob = false; });
      }
    }
  } catch (err) {
    log.error(`AppStudio worker tick error: ${err.message}`);
  }
  if (_running) setTimeout(tick, POLL_MS);
}

function claimJob(phases) {
  const db = getDb();
  const placeholders = phases.map(() => '?').join(',');
  return db.transaction(() => {
    const job = db.prepare(`
      SELECT * FROM enhancement_jobs
      WHERE status = 'queued' AND phase IN (${placeholders})
      ORDER BY id ASC LIMIT 1
    `).get(...phases);
    if (!job) return null;
    db.prepare(`
      UPDATE enhancement_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?
    `).run(job.id);
    return job;
  })();
}

async function runJob(job) {
  log.info(`AppStudio job #${job.id} phase=${job.phase} enh=${job.enhancement_id}`);
  try {
    switch (job.phase) {
      case 'plan':
      case 'revise_plan':
        await handlePlan(job);
        break;
      case 'code':
        await handleCode(job);
        break;
      case 'build':
        await handleBuild(job);
        break;
      case 'open_pr':
        await handleOpenPr(job);
        break;
      default:
        throw new Error(`Unknown phase: ${job.phase}`);
    }
    finishJob(job.id, 'done', null);
  } catch (err) {
    log.error(`AppStudio job #${job.id} failed: ${err.message}`);
    finishJob(job.id, 'failed', err.message);
    getDb().prepare("UPDATE enhancement_requests SET status = 'auto_failed' WHERE id = ?")
      .run(job.enhancement_id);
  }
}

function finishJob(id, status, error) {
  getDb().prepare(`
    UPDATE enhancement_jobs SET status = ?, error_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, error, id);
}

function getEnhancement(id) {
  return getDb().prepare('SELECT * FROM enhancement_requests WHERE id = ?').get(id);
}

function getApp(slug) {
  return getDb().prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
}

function getAgentContext(slug) {
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const ctxPath = join(dataDir, 'apps', slug, 'agent-context.md'); // nosemgrep: path-join-resolve-traversal — slug is DB-validated regex ^[a-z0-9][a-z0-9-]*$
  return existsSync(ctxPath) ? readFileSync(ctxPath, 'utf8') : '';
}

function getRepoDir(app) {
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const current = join(dataDir, 'apps', app.slug, 'production', 'current'); // nosemgrep: path-join-resolve-traversal — slug is DB-validated
  if (existsSync(current)) return current;
  return null;
}

async function handlePlan(job) {
  const db = getDb();
  const enh = getEnhancement(job.enhancement_id);
  if (!enh) throw new Error(`Enhancement ${job.enhancement_id} not found`);
  const app = enh.app_slug ? getApp(enh.app_slug) : null;

  const repoDir = app ? getRepoDir(app) : null;
  if (!repoDir) throw new Error(`No deployed code found for ${enh.app_slug}`);

  const agentContext = enh.app_slug ? getAgentContext(enh.app_slug) : '';
  const priorComments = enh.user_comments || enh.admin_comments || null;

  let lastWriteMs = 0;
  const onChunk = (fullText) => {
    const now = Date.now();
    if (now - lastWriteMs > 600) {
      db.prepare('UPDATE enhancement_jobs SET output_json = ? WHERE id = ?')
        .run(JSON.stringify({ streaming: true, text: fullText }), job.id);
      lastWriteMs = now;
    }
  };

  const onTokens = (total) => {
    db.prepare('UPDATE enhancement_jobs SET cost_tokens = ? WHERE id = ?').run(total, job.id);
  };

  const result = await planEnhancement({
    appSlug: enh.app_slug,
    request: enh.message,
    repoDir,
    agentContext,
    priorComments,
    onChunk,
    onTokens,
  });

  const costCents = Math.ceil(result.costUsd * 100);
  db.prepare(`
    UPDATE enhancement_requests
    SET status = 'pending_user_review_plan',
        ai_plan_json = ?,
        ai_cost_estimate = ?,
        cost_tokens = cost_tokens + ?,
        cost_usd_cents = cost_usd_cents + ?,
        ai_log = COALESCE(ai_log, '') || ?
    WHERE id = ?
  `).run(
    JSON.stringify(result.plan),
    JSON.stringify({ tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd }),
    result.tokensIn + result.tokensOut,
    costCents,
    `\n[${new Date().toISOString()}] Plan generated ($${result.costUsd.toFixed(4)}, ${result.tokensIn + result.tokensOut} tokens)\n${result.summary}\n`,
    job.enhancement_id,
  );

  db.prepare('UPDATE enhancement_jobs SET output_json = ?, cost_tokens = ?, cost_usd_cents = ? WHERE id = ?')
    .run(JSON.stringify(result.plan), result.tokensIn + result.tokensOut, costCents, job.id);

  log.info(`AppStudio plan ready for enh #${job.enhancement_id} ($${result.costUsd.toFixed(4)})`);
}

async function handleCode(job) {
  const db = getDb();
  const enh = getEnhancement(job.enhancement_id);
  if (!enh) throw new Error(`Enhancement ${job.enhancement_id} not found`);
  const app = enh.app_slug ? getApp(enh.app_slug) : null;
  if (!app) throw new Error(`App ${enh.app_slug} not found`);

  const plan = JSON.parse(enh.ai_plan_json || 'null');
  if (!plan) throw new Error('No approved plan');

  db.prepare("UPDATE enhancement_requests SET status = 'coding' WHERE id = ?").run(enh.id);

  const agentContext = getAgentContext(app.slug);
  const logLines = [];
  let codeOutputTokens = 0;
  let codeLastInputTokens = 0;

  const onLog = (line) => {
    logLines.push(line);

    // Parse Claude Code stream-json events for real-time token tracking
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'result' && evt.usage) {
        const tokens = (evt.usage.input_tokens || 0) + (evt.usage.output_tokens || 0);
        const cents = evt.total_cost_usd ? Math.ceil(evt.total_cost_usd * 100) : 0;
        db.prepare('UPDATE enhancement_jobs SET cost_tokens = ?, cost_usd_cents = ? WHERE id = ?')
          .run(tokens, cents, job.id);
      } else if (evt.type === 'assistant' && evt.message?.usage) {
        const u = evt.message.usage;
        codeOutputTokens += (u.output_tokens || 0);
        codeLastInputTokens = u.input_tokens || 0;
        db.prepare('UPDATE enhancement_jobs SET cost_tokens = ? WHERE id = ?')
          .run(codeLastInputTokens + codeOutputTokens, job.id);
      }
    } catch (_) {}

    if (logLines.length % 20 === 0) {
      db.prepare('UPDATE enhancement_jobs SET output_json = ? WHERE id = ?')
        .run(JSON.stringify({ log: logLines.slice(-100) }), job.id);
    }
  };

  const branchName = `appstudio/${enh.id}-${app.slug}`;
  const commitMsg  = `appstudio: ${(plan?.summary || enh.message).slice(0, 72)}`;
  let pushConflict = false;
  let noChanges = false;

  const onCodingDone = async (workspaceDir, _branch) => {
    onLog('[studio:git] Staging all file changes…');
    execFileSync('git', ['-C', workspaceDir, 'add', '-A'], { stdio: 'pipe' });

    let changedFiles = [];
    try {
      const out = execFileSync('git', ['-C', workspaceDir, 'diff', '--cached', '--name-only'], { stdio: 'pipe' }).toString().trim();
      changedFiles = out ? out.split('\n').filter(Boolean) : [];
    } catch (_) {}

    if (changedFiles.length === 0) {
      onLog('[studio:git] No file changes detected — enhancement may already be implemented');
      noChanges = true;
      return;
    } else {
      onLog(`[studio:git] ${changedFiles.length} file(s) staged:\n` + changedFiles.map(f => `  + ${f}`).join('\n'));
      onLog(`[studio:git] Committing: "${commitMsg}"`);
      execFileSync('git', ['-C', workspaceDir, 'commit', '-m', commitMsg], { stdio: 'pipe' });
      onLog('[studio:git] Commit created');
    }

    onLog(`[studio:git] Pushing branch ${branchName} to origin…`);
    try {
      execFileSync('git', ['-C', workspaceDir, 'push', '-u', 'origin', branchName], { stdio: 'pipe', timeout: 60000 });
      onLog(`[studio:git] Branch ${branchName} pushed`);
    } catch (_) {
      if (branchName.startsWith('appstudio/')) {
        onLog('[studio:git] Remote branch exists from prior attempt — force-pushing…');
        execFileSync('git', ['-C', workspaceDir, 'push', '--force', '-u', 'origin', branchName], { stdio: 'pipe', timeout: 60000 });
        onLog(`[studio:git] Branch ${branchName} force-pushed`);
      } else {
        pushConflict = true;
        onLog('[studio:git] Push conflict — branch has diverged, will re-plan');
        return;
      }
    }

    // Update DB immediately — container may still be running at this point
    db.prepare('UPDATE enhancement_jobs SET output_json = ? WHERE id = ?')
      .run(JSON.stringify({ log: logLines.slice(-200), branchName }), job.id);
    db.prepare(`
      UPDATE enhancement_requests
      SET status = 'pushing', branch_name = ?, fix_version = ?,
          ai_log = COALESCE(ai_log, '') || ?
      WHERE id = ?
    `).run(
      branchName, branchName,
      `\n[${new Date().toISOString()}] Code generated and pushed to branch ${branchName}\n`,
      enh.id,
    );
    onLog(`[studio:git] Enhancement #${enh.id} status → pushing`);
  };

  const { branchName: _b } = await generateCode({
    jobId: job.id,
    app,
    enhancementId: enh.id,
    plan,
    summary: plan.summary || enh.message,
    agentContext,
    enhancementMessage: enh.message,
    onLog,
    onCodingDone,
  });

  cleanupWorkspace(job.id);

  if (noChanges) {
    const note = `\n[${new Date().toISOString()}] Claude made no file changes — enhancement appears already implemented or no action needed.\n`;
    db.prepare(`
      UPDATE enhancement_requests
      SET status = 'no_changes_needed',
          ai_log = COALESCE(ai_log, '') || ?
      WHERE id = ?
    `).run(note, enh.id);
    log.info(`AppStudio: enh #${enh.id} → no_changes_needed (no files modified by Claude)`);
    finishJob(job.id, 'done', null);
    return;
  }

  if (pushConflict) {
    const note = `\n[${new Date().toISOString()}] Push rejected — branch ${branchName} already has remote changes. Re-planning with updated context.\n`;
    db.prepare(`
      UPDATE enhancement_requests
      SET status = 'planning', ai_plan_json = NULL,
          admin_comments = COALESCE(admin_comments, '') || ?,
          ai_log = COALESCE(ai_log, '') || ?
      WHERE id = ?
    `).run(
      `\n[${new Date().toISOString()}] Note: branch ${branchName} has existing remote changes — review and incorporate if needed.`,
      note,
      enh.id,
    );
    db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'revise_plan');
    log.info(`AppStudio: push conflict on enh #${enh.id}, re-queued for replanning`);
    finishJob(job.id, 'done', null);
    return;
  }

  db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'build');

  // Auto-replan any enhancements for the same app whose plan is now stale
  if (enh.app_slug) {
    const stale = db.prepare(`
      SELECT id FROM enhancement_requests
      WHERE app_slug = ? AND status = 'pending_user_review_plan' AND id != ?
    `).all(enh.app_slug, enh.id);
    for (const s of stale) {
      db.prepare(`
        UPDATE enhancement_requests
        SET status = 'planning', ai_plan_json = NULL,
            ai_log = COALESCE(ai_log, '') || ?
        WHERE id = ?
      `).run(`\n[${new Date().toISOString()}] Plan invalidated — new code committed for ${enh.app_slug} (enh #${enh.id}). Re-planning…\n`, s.id);
      db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(s.id, 'plan');
      log.info(`AppStudio: stale plan re-queued for enh #${s.id} after code commit on ${enh.app_slug}`);
    }
  }
}

async function handleBuild(job) {
  const db = getDb();
  const enh = getEnhancement(job.enhancement_id);
  if (!enh) throw new Error(`Enhancement ${job.enhancement_id} not found`);
  const app = enh.app_slug ? getApp(enh.app_slug) : null;
  if (!app) throw new Error(`App ${enh.app_slug} not found`);

  const branchName = enh.branch_name;
  if (!branchName) throw new Error('No branch from code phase');

  db.prepare("UPDATE enhancement_requests SET status = 'building' WHERE id = ?").run(enh.id);

  const workspace = cloneForBuild(job.id, app, branchName);

  // Trigger AppCrane deploy from the workspace
  const { deployApp } = await import('../deployer.js');
  const { getPortsForSlot } = await import('../portAllocator.js');
  const ports = getPortsForSlot(app.slot);

  const deployResult = db.prepare(`
    INSERT INTO deployments (app_id, env, status, log, commit_hash)
    VALUES (?, 'sandbox', 'pending', ?, ?)
  `).run(app.id, `AppStudio enhancement #${enh.id}`, enh.branch_name || 'appstudio');

  await deployApp(deployResult.lastInsertRowid, app, 'sandbox', ports, {
    preExtractedDir: workspace,
    commitHash: enh.branch_name || 'appstudio',
  });

  db.prepare(`
    UPDATE enhancement_requests
    SET status = 'sandbox_ready', sandbox_deploy_id = ?,
        ai_log = COALESCE(ai_log, '') || ?
    WHERE id = ?
  `).run(
    deployResult.lastInsertRowid,
    `\n[${new Date().toISOString()}] Sandbox deploy #${deployResult.lastInsertRowid} triggered\n`,
    enh.id,
  );

  try { cleanupWorkspace(`build-${job.id}`); } catch (_) {}
  log.info(`AppStudio: sandbox deploy queued for enh #${enh.id}`);

  if (enh.mode === 'auto') {
    db.prepare('INSERT INTO enhancement_jobs (enhancement_id, phase) VALUES (?, ?)').run(enh.id, 'open_pr');
    log.info(`AppStudio: auto-queuing open_pr for auto-mode enh #${enh.id}`);
  }
}

async function handleOpenPr(job) {
  const db = getDb();
  const enh = getEnhancement(job.enhancement_id);
  if (!enh) throw new Error(`Enhancement ${job.enhancement_id} not found`);
  const app = enh.app_slug ? getApp(enh.app_slug) : null;
  if (!app?.github_url || !enh.branch_name) throw new Error('Missing GitHub URL or branch');

  const plan = JSON.parse(enh.ai_plan_json || '{}');

  let token = null;
  if (app.github_token_encrypted) {
    try { token = decrypt(app.github_token_encrypted); } catch (_) {}
  }

  const m = app.github_url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error('Could not parse GitHub URL');
  const [, owner, repo] = m;

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AppCrane-AppStudio',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `token ${token}`;

  const prBody = [
    `## ${plan.summary || enh.message}`,
    '',
    '### Files changed',
    ...(plan.files_to_change || []).map(f => `- \`${f.path}\` (${f.action}): ${f.rationale}`),
    '',
    '### Test plan',
    plan.test_plan || 'Manual verification in sandbox.',
    '',
    `Generated by AppStudio (enhancement #${enh.id})`,
  ].join('\n');

  let prUrl, prNumber;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `appstudio: ${plan.summary?.slice(0, 60) || enh.message.slice(0, 60)}`,
      body: prBody,
      head: enh.branch_name,
      base: app.branch || 'main',
    }),
  });
  const data = await res.json();

  if (!res.ok) {
    // PR already exists for this branch — find and reuse it
    const alreadyExists = res.status === 422 && (
      data.message?.toLowerCase().includes('already exists') ||
      (data.errors || []).some(e => e.message?.toLowerCase().includes('already exists'))
    );
    if (!alreadyExists) throw new Error(`GitHub PR creation failed: ${data.message || res.status}`);

    onLog?.('[studio:git] PR already exists for this branch — looking it up…');
    const listRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${enh.branch_name}&state=open`,
      { headers }
    );
    const listData = await listRes.json();
    if (!listRes.ok || !listData[0]) throw new Error('PR already exists but could not be found');
    prUrl    = listData[0].html_url;
    prNumber = listData[0].number;
    onLog?.(`[studio:git] Reusing existing PR #${prNumber}: ${prUrl}`);
  } else {
    prUrl    = data.html_url;
    prNumber = data.number;
  }
  log.info(`AppStudio: PR #${prNumber} opened for enh #${enh.id}: ${prUrl}`);

  db.prepare(`
    UPDATE enhancement_requests
    SET status = 'pr_open', pr_url = ?,
        ai_log = COALESCE(ai_log, '') || ?
    WHERE id = ?
  `).run(prUrl, `\n[${new Date().toISOString()}] PR opened: ${prUrl}\n`, enh.id);

  // Merge the PR on GitHub
  const mergeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      commit_title: `appstudio: ${plan.summary?.slice(0, 60) || enh.message.slice(0, 60)}`,
      commit_message: `Merged by AppCrane AppStudio (enhancement #${enh.id})`,
      merge_method: 'squash',
    }),
  });
  const mergeData = await mergeRes.json();

  if (!mergeRes.ok) {
    throw new Error(`GitHub PR merge failed: ${mergeData.message || mergeRes.status}`);
  }

  db.prepare(`
    UPDATE enhancement_requests
    SET status = 'merged',
        ai_log = COALESCE(ai_log, '') || ?
    WHERE id = ?
  `).run(`\n[${new Date().toISOString()}] PR #${prNumber} merged: ${mergeData.sha || ''}\n`, enh.id);

  log.info(`AppStudio: PR #${prNumber} merged for enh #${enh.id}`);
}
