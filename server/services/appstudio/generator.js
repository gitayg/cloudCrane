import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { decrypt } from '../encryption.js';
import log from '../../utils/logger.js';

const GEN_MODEL       = process.env.APPSTUDIO_CODER_MODEL || 'claude-sonnet-4-6';
const GEN_TIMEOUT_MS  = parseInt(process.env.APPSTUDIO_TIMEOUT_MS || '1800000', 10);
const STUDIO_IMAGE    = process.env.APPSTUDIO_IMAGE || 'appcrane-studio:latest';

function workspaceRoot() {
  return join(resolve(process.env.DATA_DIR || './data'), 'appstudio-jobs');
}

function jobDir(jobId) {
  return join(workspaceRoot(), String(jobId)); // nosemgrep: path-join-resolve-traversal — jobId is an integer from DB
}

export function cleanupWorkspace(jobId) {
  try { rmSync(jobDir(jobId), { recursive: true, force: true }); } catch (_) {}
}

const STUDIO_IMAGE_VERSION = '2'; // bump to force image rebuild

// Build the studio Docker image when missing or outdated
async function ensureStudioImage(onLog) {
  try {
    const info = execFileSync('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "appcrane.studio.version"}}', STUDIO_IMAGE], { stdio: 'pipe', timeout: 10000 });
    if (info.toString().trim() === STUDIO_IMAGE_VERSION) return;
    onLog?.('[studio] Studio image outdated, rebuilding…');
  } catch (_) {
    onLog?.('[studio] Building studio image (one-time setup, ~2 min)…');
  }

  const buildDir = join(workspaceRoot(), '_image-build');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, 'Dockerfile'), [
    'FROM node:20-alpine',
    `LABEL appcrane.studio.version="${STUDIO_IMAGE_VERSION}"`,
    'RUN apk add --no-cache git',
    'RUN npm install -g @anthropic-ai/claude-code',
    'RUN addgroup -S studio && adduser -S -G studio studio \\',
    '    && mkdir -p /home/studio /workspace \\',
    '    && chown studio:studio /home/studio /workspace',
    'USER studio',
  ].join('\n'));

  await new Promise((res, rej) => {
    const build = spawn('docker', ['build', '-t', STUDIO_IMAGE, buildDir], {
      stdio: 'pipe',
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    });
    const emit = (l) => { if (l.trim()) onLog?.(`[build] ${l}`); };
    build.stdout.on('data', (c) => c.toString().split('\n').forEach(emit));
    build.stderr.on('data', (c) => c.toString().split('\n').forEach(emit));
    build.on('error', rej);
    build.on('close', (code) => code === 0 ? res() : rej(new Error(`docker build failed (exit ${code})`)));
  });

  onLog?.('[studio] Studio image ready');
}

function buildPrompt({ plan, summary, agentContext, enhancementMessage }) {
  const testSection = plan?.test_files?.length
    ? `# Test files to write\nThe plan requires these test files (create or update each one):\n${
        plan.test_files.map(f => `- ${f.path} (${f.action}): ${f.what}`).join('\n')
      }\nFollow the testing framework and style already used in the repo.`
    : '# Tests\nNo specific test files were planned. If you can identify an appropriate test file to add coverage for your changes, create it.';

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

${testSection}

# Per-app context from the operator
${agentContext || '(none)'}

# Rules
- Implement all files listed in files_to_change AND all files listed in test_files.
- Do NOT modify database schemas or deploy configs unless the plan explicitly lists them.
- Do NOT add unrelated refactoring or "improvements".
- Do NOT run tests, npm install, or any server — just write the files.
- Stage all changes when done — the runner will commit and push.
- Do NOT push.`;
}

// Node.js runner script executed inside the container.
// Reads config from env vars, clones the repo, runs Claude Code, commits and pushes.
function buildRunnerScript() {
  return `#!/usr/bin/env node
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');

const cloneUrl   = process.env.STUDIO_CLONE_URL;
const branch     = process.env.STUDIO_BRANCH;
const baseBranch = process.env.STUDIO_BASE_BRANCH || 'main';
const model      = process.env.STUDIO_MODEL;
const commitMsg  = process.env.STUDIO_COMMIT_MSG;

function run(cmd, args, opts) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// Clone
console.log('[studio] Cloning ' + baseBranch + ' branch…');
run('git', ['clone', '--depth', '1', '--branch', baseBranch, cloneUrl, '/workspace']);

process.chdir('/workspace');
run('git', ['config', 'user.email', 'appstudio@appcrane.local']);
run('git', ['config', 'user.name', 'AppStudio']);
run('git', ['checkout', '-b', branch]);

// Run Claude Code
console.log('[studio] Running Claude Code on ' + model + '…');
const prompt = fs.readFileSync('/studio/prompt.txt', 'utf8');
const claudeEnv = {
  ...process.env,
  HOME: '/home/studio',
  PATH: '/usr/local/bin:/usr/bin:/bin',
};
const result = spawnSync('claude', [
  '-p', prompt,
  '--model', model,
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
], { stdio: 'inherit', cwd: '/workspace', timeout: ${GEN_TIMEOUT_MS}, env: claudeEnv });

if (result.error) {
  console.error('[studio] Failed to spawn Claude Code: ' + result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('[studio] Claude Code exited with code ' + result.status);
  process.exit(result.status || 1);
}

// Commit
run('git', ['add', '-A']);
try {
  execFileSync('git', ['diff', '--cached', '--quiet'], { stdio: 'pipe' });
  console.log('[studio] No file changes to commit');
} catch (_) {
  run('git', ['commit', '-m', commitMsg]);
}

// Push
console.log('[studio] Pushing branch ' + branch + '…');
run('git', ['push', '-u', 'origin', branch]);
console.log('[studio] Done — ' + branch);
`;
}

/**
 * Clone a specific branch from GitHub to a local dir for the build/deploy phase.
 */
export function cloneForBuild(jobId, app, branch) {
  const dir = join(workspaceRoot(), `build-${jobId}`); // nosemgrep: path-join-resolve-traversal — jobId is integer
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let cloneUrl = app.github_url;
  if (app.github_token_encrypted) {
    try {
      const token = decrypt(app.github_token_encrypted);
      const url = new URL(app.github_url);
      url.username = token;
      cloneUrl = url.toString();
    } catch (_) {}
  }

  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', branch, cloneUrl, dir], {
      timeout: 120000, stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(err.message.replaceAll(cloneUrl, app.github_url));
  }
  log.info(`AppStudio: cloned branch ${branch} for build into ${dir}`);
  return dir;
}

/**
 * Run Claude Code inside a Docker container to implement the plan.
 * Clones the repo, applies changes, commits, and pushes a new branch.
 * Returns { branchName }.
 */
export async function generateCode({ jobId, app, enhancementId, plan, summary, agentContext, enhancementMessage, onLog }) {
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

  const branchName  = `appstudio/${enhancementId}-${app.slug}`;
  const commitMsg   = `appstudio: ${(plan?.summary || enhancementMessage).slice(0, 72)}`;

  writeFileSync(join(dir, 'prompt.txt'), buildPrompt({ plan, summary, agentContext, enhancementMessage })); // nosemgrep
  writeFileSync(join(dir, 'runner.js'), buildRunnerScript()); // nosemgrep

  const containerName = `appcrane-studio-${jobId}`;

  const containerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--label', 'appcrane=true',
    '--label', 'appstudio=true',
    '--label', `enhancement_id=${enhancementId}`,
    '--memory=2g', '--cpus=1',
    '-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
    '-e', `STUDIO_CLONE_URL=${cloneUrl}`,
    '-e', `STUDIO_BRANCH=${branchName}`,
    '-e', `STUDIO_BASE_BRANCH=${app.branch || 'main'}`,
    '-e', `STUDIO_MODEL=${GEN_MODEL}`,
    '-e', `STUDIO_COMMIT_MSG=${commitMsg}`,
    '-v', `${dir}:/studio:ro`,
    STUDIO_IMAGE,
    'node', '/studio/runner.js',
  ];

  onLog?.(`[studio] Starting container ${containerName}`);
  log.info(`AppStudio: running container ${containerName}`);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', containerArgs, { stdio: 'pipe' });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync('docker', ['stop', '-t', '5', containerName], { stdio: 'pipe', timeout: 15000 }); } catch (_) {}
      child.kill('SIGTERM');
    }, GEN_TIMEOUT_MS + 60000);

    const emit = (line) => { if (line.trim()) onLog?.(line); };

    child.stdout.on('data', (c) => c.toString().split('\n').forEach(emit));
    child.stderr.on('data', (c) => c.toString().split('\n').forEach(l => emit(`[stderr] ${l}`)));

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Code generation timed out'));
      if (code !== 0) return reject(new Error(`Studio container exited with code ${code}`));
      resolve({ branchName });
    });
  });
}
