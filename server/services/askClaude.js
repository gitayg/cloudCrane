import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { decrypt } from './encryption.js';
import { ensureStudioImage } from './appstudio/generator.js';
import log from '../utils/logger.js';

const ASK_IMAGE      = process.env.APPSTUDIO_IMAGE || 'appcrane-studio:latest';
const ASK_MODEL      = process.env.APPSTUDIO_CODER_MODEL || 'claude-sonnet-4-6';
const ASK_TIMEOUT_MS = parseInt(process.env.ASK_TIMEOUT_MS || '300000', 10);

function workspaceRoot() {
  return join(resolve(process.env.DATA_DIR || './data'), 'ask-jobs');
}

function jobDir(jobId) {
  return join(workspaceRoot(), String(jobId)); // nosemgrep: path-join-resolve-traversal — jobId is timestamp integer
}

export function cleanupAskWorkspace(jobId) {
  try { rmSync(jobDir(jobId), { recursive: true, force: true }); } catch (_) {}
}

function buildRunnerScript() {
  return `#!/usr/bin/env node
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');

const cloneUrl = process.env.ASK_CLONE_URL;
const branch   = process.env.ASK_BASE_BRANCH || 'main';
const model    = process.env.ASK_MODEL;

console.log('[ask] Cloning ' + branch + '...');
execFileSync('git', ['clone', '--depth', '1', '--branch', branch, cloneUrl, '/workspace'], { stdio: 'inherit' });
process.chdir('/workspace');

const ctx = JSON.parse(fs.readFileSync('/studio/context.json', 'utf8'));

let prompt = '';
if (ctx.agentContext) {
  prompt += 'Context about this application:\\n' + ctx.agentContext + '\\n\\n';
}
if (ctx.history && ctx.history.length > 0) {
  prompt += 'Previous conversation:\\n';
  for (const m of ctx.history) {
    prompt += (m.role === 'user' ? 'User' : 'Assistant') + ': ' + m.content + '\\n\\n';
  }
  prompt += '---\\n\\n';
}
prompt += 'Question: ' + ctx.question + '\\n\\n';
prompt += 'Instructions: Answer based on the codebase in /workspace. Read relevant source files as needed. Be concise and accurate. Do NOT modify any files.';

console.log('[ask] Running Claude Code...');
const claudeEnv = { ...process.env, HOME: '/home/studio', PATH: '/usr/local/bin:/usr/bin:/bin' };
const result = spawnSync('claude', [
  '-p', prompt,
  '--model', model,
  '--dangerously-skip-permissions',
  '--output-format', 'text',
], { stdio: ['ignore', 'pipe', 'inherit'], cwd: '/workspace', timeout: ${ASK_TIMEOUT_MS}, env: claudeEnv });

if (result.error) { console.error('[ask] Error: ' + result.error.message); process.exit(1); }
if (result.status !== 0) { console.error('[ask] Claude exited with code ' + result.status); process.exit(result.status || 1); }

const answer = (result.stdout || '').toString().trim();
process.stdout.write('\\x00ASK_START\\x00' + answer + '\\x00ASK_END\\x00\\n');
console.log('[ask] Done');
`;
}

export async function runAskJob({ jobId, app, question, history, agentContext, onLog }) {
  const dir = jobDir(jobId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await ensureStudioImage(onLog);

  let cloneUrl = app.github_url;
  if (app.github_token_encrypted) {
    try {
      const token = decrypt(app.github_token_encrypted);
      const url = new URL(app.github_url);
      url.username = token;
      cloneUrl = url.toString();
    } catch (_) {}
  }

  writeFileSync(join(dir, 'context.json'), JSON.stringify({ question, history, agentContext })); // nosemgrep
  writeFileSync(join(dir, 'runner.js'), buildRunnerScript()); // nosemgrep

  const containerName = `appcrane-ask-${jobId}`;
  const containerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--label', 'appcrane=true',
    '--memory=1g', '--cpus=0.5',
    '-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
    '-e', `ASK_CLONE_URL=${cloneUrl}`,
    '-e', `ASK_BASE_BRANCH=${app.branch || 'main'}`,
    '-e', `ASK_MODEL=${ASK_MODEL}`,
    '-v', `${dir}:/studio:ro`,
    ASK_IMAGE,
    'node', '/studio/runner.js',
  ];

  onLog?.(`[ask] Starting container ${containerName}`);
  log.info(`AskClaude: running container ${containerName} for app ${app.slug}`);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', containerArgs, { stdio: 'pipe' });
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync('docker', ['stop', '-t', '5', containerName], { stdio: 'pipe', timeout: 15000 }); } catch (_) {}
      child.kill('SIGTERM');
    }, ASK_TIMEOUT_MS + 60000);

    child.stdout.on('data', (c) => {
      const text = c.toString();
      stdout += text;
      text.split('\n').forEach(line => { if (line.trim()) onLog?.(line); });
    });
    child.stderr.on('data', (c) => c.toString().split('\n').forEach(l => { if (l.trim()) onLog?.(`[stderr] ${l}`); }));

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Ask Claude timed out after 5 minutes'));
      if (code !== 0) return reject(new Error(`Container exited with code ${code}`));

      const startMark = '\x00ASK_START\x00';
      const endMark   = '\x00ASK_END\x00';
      const si = stdout.indexOf(startMark);
      const ei = stdout.indexOf(endMark);
      const answer = (si !== -1 && ei !== -1)
        ? stdout.slice(si + startMark.length, ei).trim()
        : stdout.split('\n').filter(l => !l.startsWith('[ask]') && !l.startsWith('[stderr]')).join('\n').trim();

      resolve(answer);
    });
  });
}
