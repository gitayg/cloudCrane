import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { decrypt } from '../encryption.js';
import log from '../../utils/logger.js';

const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN || 'claude';
const GEN_MODEL = process.env.APPSTUDIO_CODER_MODEL || 'claude-sonnet-4-6';
const GEN_TIMEOUT_MS = parseInt(process.env.APPSTUDIO_TIMEOUT_MS || '1800000', 10);

function workspaceRoot() {
  return join(resolve(process.env.DATA_DIR || './data'), 'appstudio-jobs');
}

export function prepareWorkspace(jobId, app) {
  const dir = join(workspaceRoot(), String(jobId));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  if (app.github_url) {
    let cloneUrl = app.github_url;
    if (app.github_token_encrypted) {
      try {
        const token = decrypt(app.github_token_encrypted);
        const url = new URL(app.github_url);
        url.username = token;
        cloneUrl = url.toString();
      } catch (_) {}
    }
    execFileSync('git', ['clone', '--depth', '1', '--branch', app.branch || 'main', cloneUrl, dir], {
      timeout: 120000, stdio: 'pipe',
    });
    log.info(`Cloned ${app.github_url} into workspace ${dir}`);
  }

  return dir;
}

export function cleanupWorkspace(jobId) {
  const dir = join(workspaceRoot(), String(jobId));
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function buildPrompt({ plan, summary, agentContext, enhancementMessage }) {
  return `You are implementing an approved change to an existing application.
The codebase is already cloned into the current working directory.

# Enhancement request
${enhancementMessage}

# Approved plan
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`

# Plan summary
${summary}

# Per-app context from the operator
${agentContext || '(none)'}

# Rules
- Stay within the files listed in files_to_change. You may read other files for context.
- Do NOT modify database schemas or deploy configs unless the plan explicitly lists them.
- Do NOT add unrelated refactoring or "improvements".
- When done, commit all changes with message: "appstudio: ${plan?.summary?.slice(0, 60) || 'enhancement'}"
- Do NOT push. Do NOT run npm install, tests, or servers.`;
}

export function generateCode({ workspace, plan, summary, agentContext, enhancementMessage, onLog }) {
  return new Promise((resolve, reject) => {
    const prompt = buildPrompt({ plan, summary, agentContext, enhancementMessage });
    const args = [
      '-p', prompt,
      '--model', GEN_MODEL,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    log.info(`AppStudio: spawning Claude Code in ${workspace}`);
    const child = spawn(CLAUDE_BIN, args, { cwd: workspace, env: process.env });

    let buf = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, GEN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (onLog) onLog(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      if (onLog) onLog(`[stderr] ${chunk.toString()}`);
    });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Code generation timed out'));
      if (code !== 0) return reject(new Error(`Claude Code exited with code ${code}`));
      resolve({ workspace });
    });
  });
}
