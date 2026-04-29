import { spawn, execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { decrypt } from '../encryption.js';
import { assertCapacity } from '../containerLimit.js';
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
export async function ensureStudioImage(onLog) {
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
    });
    const emit = (l) => { if (l.trim()) onLog?.(`[build] ${l}`); };
    build.stdout.on('data', (c) => c.toString().split('\n').forEach(emit));
    build.stderr.on('data', (c) => c.toString().split('\n').forEach(emit));
    build.on('error', rej);
    build.on('close', (code) => code === 0 ? res() : rej(new Error(`docker build failed (exit ${code})`)));
  });

  onLog?.('[studio] Studio image ready');
}

async function cloneForCode(dir, app, baseBranch, branchName, onLog) {
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  chmodSync(workspaceDir, 0o777); // explicit chmod — mkdirSync mode is clipped by umask

  let cloneUrl = app.github_url;
  if (app.github_token_encrypted) {
    try {
      const token = decrypt(app.github_token_encrypted);
      const url = new URL(app.github_url);
      url.username = token;
      cloneUrl = url.toString();
    } catch (_) {}
  }

  onLog?.(`[studio:git] Cloning ${app.github_url} (${baseBranch})…`);
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', baseBranch, cloneUrl, workspaceDir], {
      timeout: 120000, stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(err.message.replaceAll(cloneUrl, app.github_url));
  }

  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'appstudio@appcrane.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'AppStudio'], { stdio: 'pipe' });
  onLog?.(`[studio:git] Creating branch ${branchName}…`);
  execFileSync('git', ['-C', workspaceDir, 'checkout', '-b', branchName], { stdio: 'pipe' });

  // Make workspace fully accessible to the container's studio user.
  // chmod 777 works regardless of who runs AppCrane (no root needed) and
  // ensures directory execute bits are set so the studio user can traverse all paths.
  try { execFileSync('chmod', ['-R', '777', workspaceDir], { stdio: 'pipe' }); } catch (_) {}
  try { execFileSync('chown', ['-R', '1000:1000', workspaceDir], { stdio: 'pipe' }); } catch (_) {}

  writeFileSync(join(workspaceDir, 'CLAUDE.md'), buildWorkspaceClaude(), { mode: 0o644 }); // nosemgrep

  onLog?.(`[studio:git] Workspace ready at host path ${workspaceDir}`);
  return workspaceDir;
}

function buildWorkspaceClaude() {
  return `# AppStudio Coder Agent — Environment Guide

## Where you are
You are running inside a Docker container as the \`studio\` user.
- Your working directory is \`/workspace\` — the full app codebase, pre-cloned from GitHub.
- You can read and write all files in \`/workspace\`.
- \`/studio/prompt.txt\` contains the full task description (already loaded as your prompt).

## Your job
Implement exactly the files described in the approved plan.
Make all changes directly in \`/workspace\`.

## When you are done
Run \`git add\` to stage every file you changed or created — nothing more.
Do NOT commit. Do NOT push. The host handles commit, push, and deploy automatically after you exit.

Example:
\`\`\`
git add path/to/changed/file.js path/to/new/file.jsx
\`\`\`
Or to stage everything you touched:
\`\`\`
git add -A
\`\`\`

Then exit. That's it.

## Version bump (required)
Always apply a patch version bump to \`package.json\` — increment the last digit of the \`version\` field (e.g. \`1.2.3\` → \`1.2.4\`). Do this even if the plan does not list it. This is mandatory for every enhancement.

## Hard constraints
- Do NOT run \`npm install\` or \`yarn\` for a full install — the host regenerates \`package-lock.json\` automatically after you finish if you modified \`package.json\`.
- Do NOT start or restart any server or process.
- Do NOT run tests.
- Do NOT push to git.
- Do NOT modify files outside the plan unless fixing a direct dependency.
- Do NOT add unrelated refactoring or "improvements".
- Do NOT modify database schemas or deploy configs unless the plan explicitly lists them.

## Git safe directory
If git warns about safe.directory, run:
\`\`\`
git config --global --add safe.directory /workspace
\`\`\`
`;
}

function buildPrompt({ plan, summary, agentContext, contextDoc, enhancementMessage }) {
  const testSection = plan?.test_files?.length
    ? `# Test files to write\nThe plan requires these test files (create or update each one):\n${
        plan.test_files.map(f => `- ${f.path} (${f.action}): ${f.what}`).join('\n')
      }\nFollow the testing framework and style already used in the repo.`
    : '# Tests\nNo specific test files were planned. If you can identify an appropriate test file to add coverage for your changes, create it.';

  const contextSection = contextDoc
    ? `# Codebase context\nUse this architectural overview to skip broad exploration. Read specific files directly when you need exact details.\n\n${contextDoc}\n`
    : '';

  return `You are implementing an approved change to an existing application.
The codebase is already cloned into the current working directory.

${contextSection}# Enhancement request
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
// The workspace is pre-cloned by the host — this script only runs Claude Code
// and writes a sentinel file when done. No git credentials inside the container.
function buildRunnerScript() {
  return `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');

const model = process.env.STUDIO_MODEL;
const apiKey = fs.readFileSync('/studio/api_key', 'utf8').trim();

process.chdir('/workspace');
console.log('[studio] Coder agent starting (model: ' + model + ')…');

const prompt = fs.readFileSync('/studio/prompt.txt', 'utf8');
const claudeEnv = {
  ...process.env,
  HOME: '/home/studio',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  ANTHROPIC_API_KEY: apiKey,
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
  console.error('[studio] Claude Code exited with status ' + result.status);
  process.exit(result.status || 1);
}

// Write sentinel — host picks this up and runs git add/commit/push
fs.writeFileSync('/sentinel/done', new Date().toISOString());
console.log('[studio] Coding complete — host will handle commit and push');
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
 * The repo is cloned on the host before the container starts — no git credentials
 * are passed into the container. When Claude Code finishes writing files it writes
 * a sentinel file; the host detects it and calls onCodingDone(workspaceDir, branchName)
 * to run git add/commit/push. Returns { branchName }.
 */
export async function generateCode({ jobId, app, enhancementId, plan, summary, agentContext, contextDoc, enhancementMessage, onLog, onCodingDone }) {
  const dir = jobDir(jobId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await ensureStudioImage(onLog);

  const branchName   = `appstudio/${enhancementId}-${app.slug}`;
  const studioDir    = join(dir, 'studio');
  const sentinelDir  = join(dir, 'sentinel');
  mkdirSync(studioDir, { recursive: true });
  mkdirSync(sentinelDir, { recursive: true });
  chmodSync(sentinelDir, 0o777); // world-writable so the studio user inside the container can write the sentinel

  // Clone the repo on the host — no credentials reach the container
  const workspaceDir = await cloneForCode(dir, app, app.branch || 'main', branchName, onLog);

  writeFileSync(join(studioDir, 'prompt.txt'), buildPrompt({ plan, summary, agentContext, contextDoc, enhancementMessage })); // nosemgrep
  writeFileSync(join(studioDir, 'runner.js'), buildRunnerScript()); // nosemgrep
  writeFileSync(join(studioDir, 'api_key'), process.env.ANTHROPIC_API_KEY || '', { mode: 0o600 }); // nosemgrep — key written to ro-mounted dir, not passed via docker env
  if (contextDoc) onLog?.(`[studio] Injected codebase context (${contextDoc.length} chars) — coder will skip orientation exploration`);

  const containerName = `appcrane-studio-${jobId}`;
  const sentinelPath  = join(sentinelDir, 'done');

  const containerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--label', 'appcrane=true',
    '--label', 'appcrane.container.type=job',
    '--label', `enhancement_id=${enhancementId}`,
    '--memory=2g', '--cpus=1',
    '-e', `STUDIO_MODEL=${GEN_MODEL}`,
    '-v', `${workspaceDir}:/workspace`,   // rw — Claude Code writes files here
    '-v', `${studioDir}:/studio:ro`,      // ro — prompt + runner only
    '-v', `${sentinelDir}:/sentinel`,     // rw — sentinel file only (no git files)
    STUDIO_IMAGE,
    'node', '/studio/runner.js',
  ];

  assertCapacity();
  onLog?.(`[studio] Starting container ${containerName} (git credentials stay on host)`);
  log.info(`AppStudio: running container ${containerName}`);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', containerArgs, { stdio: 'pipe' });

    let timedOut            = false;
    let codingDoneHandled   = false;
    let codingDonePromise   = null;
    let pendingCodingError  = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync('docker', ['stop', '-t', '5', containerName], { stdio: 'pipe', timeout: 15000 }); } catch (_) {}
      child.kill('SIGTERM');
    }, GEN_TIMEOUT_MS + 60000);

    // Poll every 2s for the sentinel file written by the runner when coding is done.
    // codingDonePromise is captured so the close handler can await it if the container
    // exits while the async git work is still in flight.
    const sentinelPoll = setInterval(() => {
      if (codingDoneHandled || timedOut) return;
      if (existsSync(sentinelPath)) {
        codingDoneHandled = true;
        clearInterval(sentinelPoll);
        onLog?.('[studio] Coding complete — committing and pushing…');
        codingDonePromise = (async () => {
          try {
            await onCodingDone?.(workspaceDir, branchName);
          } catch (err) {
            pendingCodingError = err;
          }
        })();
      }
    }, 2000);

    const emit = (line) => { if (line.trim()) onLog?.(line); };
    child.stdout.on('data', (c) => c.toString().split('\n').forEach(emit));
    child.stderr.on('data', (c) => c.toString().split('\n').forEach(l => emit(`[stderr] ${l}`)));

    child.on('error', (err) => {
      clearTimeout(timer); clearInterval(sentinelPoll);
      reject(err);
    });

    child.on('close', async (code) => {
      clearTimeout(timer); clearInterval(sentinelPoll);
      // Await any in-flight onCodingDone before making decisions
      if (codingDonePromise) await codingDonePromise;
      if (pendingCodingError) return reject(pendingCodingError);
      if (timedOut)           return reject(new Error('Code generation timed out'));
      // Final sentinel check — file may have been written in the last poll window before exit
      if (!codingDoneHandled && existsSync(sentinelPath)) {
        codingDoneHandled = true;
        onLog?.('[studio] Coding complete — committing and pushing…');
        try { await onCodingDone?.(workspaceDir, branchName); } catch (err) { return reject(err); }
        return resolve({ branchName });
      }
      if (!codingDoneHandled && code !== 0) return reject(new Error(`Studio container exited with code ${code}`));
      if (!codingDoneHandled) return reject(new Error('Container exited before coding sentinel was written'));
      resolve({ branchName });
    });
  });
}
