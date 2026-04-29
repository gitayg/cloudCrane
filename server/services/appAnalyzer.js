import Anthropic from '@anthropic-ai/sdk';
import { execFile, execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { decrypt } from './encryption.js';
import log from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const MODEL = process.env.APPSTUDIO_PLANNER_MODEL || 'claude-sonnet-4-6';

// Files to read for analysis, in priority order
const ANALYSIS_FILES = [
  '.env.example', '.env.sample', '.env.template', '.env.dist',
  'package.json', 'deployhub.json', 'crane.yaml',
  'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Dockerfile',
  'README.md',
  'server.js', 'index.js', 'app.js', 'main.js', 'src/index.js', 'src/app.js',
  'main.go', 'main.py', 'app.py', 'src/main.rs',
];

const MAX_FILE_BYTES = 8000;

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function tmpDir() {
  return resolve(process.env.DATA_DIR || './data', 'analyzer-tmp');
}

function cloneDir(jobId) {
  return join(tmpDir(), String(jobId)); // nosemgrep: path-join-resolve-traversal — jobId is a timestamp integer
}

function readFileSafe(path, maxBytes = MAX_FILE_BYTES) {
  try {
    const buf = readFileSync(path);
    const text = buf.toString('utf8', 0, maxBytes);
    return buf.length > maxBytes ? text + `\n...(truncated, ${buf.length} bytes total)` : text;
  } catch (_) { return null; }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export async function analyzeGithubRepo({ githubUrl, branch = 'main', githubTokenEncrypted }) {
  const jobId = Date.now();
  const dir = cloneDir(jobId);
  mkdirSync(dir, { recursive: true });

  let cloneUrl = githubUrl;
  if (githubTokenEncrypted) {
    try {
      const token = decrypt(githubTokenEncrypted);
      const url = new URL(githubUrl);
      url.username = token;
      cloneUrl = url.toString();
    } catch (_) {}
  }

  try {
    log.info(`AppAnalyzer: cloning ${githubUrl} (${branch})`);
    await execFileAsync('git', ['clone', '--depth', '1', '--branch', branch, cloneUrl, dir], {
      timeout: 60000, stdio: 'pipe',
    }).catch(err => {
      throw new Error(err.message.replaceAll(cloneUrl, githubUrl));
    });

    // Collect file contents
    const files = {};
    for (const rel of ANALYSIS_FILES) {
      const content = readFileSafe(join(dir, rel));
      if (content) files[rel] = content;
    }

    // Also grab git file tree for reference
    let fileTree = '';
    try {
      fileTree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: dir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
      }).trim().split('\n').slice(0, 200).join('\n');
    } catch (_) {}

    const repoName = githubUrl.split('/').pop()?.replace(/\.git$/, '') || 'app';

    const prompt = `You are analyzing a GitHub repository to onboard it into AppCrane, a self-hosted deployment platform.

Repository: ${githubUrl}
Branch: ${branch}

## File tree (first 200 entries)
\`\`\`
${fileTree || '(unavailable)'}
\`\`\`

## Key files
${Object.entries(files).map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``).join('\n\n')}

## Task
Analyze this project and return a JSON object with the following fields. Be accurate — do not guess if you cannot determine a value.

\`\`\`json
{
  "name": "Human-readable app name",
  "slug": "url-safe-slug (lowercase, dashes, no spaces)",
  "description": "One sentence description of what this app does",
  "framework": "e.g. Next.js, Express, FastAPI, Go, React+Vite, etc.",
  "language": "e.g. Node.js, Python, Go, Rust",
  "port": 3000,
  "branch": "${branch}",
  "env_vars": [
    {
      "key": "VAR_NAME",
      "description": "What this var is for",
      "example": "example-value-or-empty-string",
      "required": true
    }
  ],
  "notes": "Any important setup notes the operator should know (e.g. needs a PostgreSQL DB, Redis, etc.) — or empty string"
}
\`\`\`

Rules:
- Extract env vars from .env.example / .env.sample / source code references to process.env
- Do NOT include AppCrane-managed vars: APP_BASE_PATH, CRANE_URL, DATA_DIR, PORT, NODE_ENV
- Do NOT include VITE_* vars — they cannot be set via AppCrane env vars (Vite bakes them at build time)
- Set port to the actual listen port (default 3000 for Node.js, 8000 for Python/FastAPI, 8080 for Go)
- slug must match ^[a-z0-9][a-z0-9-]*$
- Return ONLY the JSON object, no prose, no markdown fences`;

    log.info('AppAnalyzer: calling Claude for analysis');
    const msg = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = msg.content[0]?.text?.trim() || '';
    // Strip markdown fences if Claude added them
    const jsonText = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const analysis = JSON.parse(jsonText);

    // Sanitize
    analysis.slug = slugify(analysis.slug || repoName);
    analysis.port = Number(analysis.port) || 3000;
    analysis.env_vars = Array.isArray(analysis.env_vars) ? analysis.env_vars : [];
    analysis.github_url = githubUrl;
    analysis.branch = branch;

    log.info(`AppAnalyzer: done — ${analysis.name} (${analysis.slug}), ${analysis.env_vars.length} env vars`);
    return analysis;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
