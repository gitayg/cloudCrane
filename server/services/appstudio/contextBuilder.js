import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../../db.js';
import log from '../../utils/logger.js';

const MODEL = process.env.APPSTUDIO_PLANNER_MODEL || 'claude-sonnet-4-6';

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function getGitHash(repoDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
  } catch (_) { return null; }
}

function getFileTree(repoDir) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
  } catch (_) { return ''; }
}

function readKeySafe(path, max = 8000) {
  try {
    const c = readFileSync(path, 'utf8');
    return c.length > max ? c.slice(0, max) + '\n...(truncated)' : c;
  } catch (_) { return null; }
}

function collectKeyFiles(repoDir, fileTree) {
  const priority = [
    'README.md', 'package.json', 'crane.yaml', 'deployhub.json',
    'server/index.js', 'src/index.js', 'src/main.js', 'src/app.js',
    'app.js', 'index.js', 'main.py', 'app.py',
  ];
  const lines = fileTree.split('\n').filter(Boolean);
  const result = [];
  const seen = new Set();

  for (const p of priority) {
    const abs = join(repoDir, p);
    if (existsSync(abs)) {
      const content = readKeySafe(abs);
      if (content) { result.push({ path: p, content }); seen.add(p); }
    }
  }

  // Add up to 6 more files: entry points, routes, DB schemas
  const extras = lines.filter(f =>
    !seen.has(f) &&
    /\.(js|ts|py|go|sql)$/.test(f) &&
    !f.includes('node_modules') && !f.includes('.git') &&
    (/route|model|schema|controller|service|store|api/i.test(f))
  ).slice(0, 6);

  for (const p of extras) {
    const content = readKeySafe(join(repoDir, p));
    if (content) { result.push({ path: p, content }); seen.add(p); }
  }

  return result;
}

async function callClaude(prompt) {
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.find(b => b.type === 'text')?.text || '';
}

async function buildContextDoc(repoDir, fileTree, keyFiles) {
  const filesSection = keyFiles
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const prompt = `You are analyzing a software project to create a concise technical reference for an AI coding assistant.

## File tree
\`\`\`
${fileTree}
\`\`\`

## Key files
${filesSection}

---

Write a structured technical reference document that covers:

1. **App purpose & tech stack** — what it does, language/framework, key dependencies
2. **Directory structure** — what each major directory and key file does
3. **Architecture & patterns** — how the code is organized (MVC, functional, layered, etc.), naming conventions
4. **Data flows** — how a typical request flows through the system, database/state interactions
5. **Key APIs and entry points** — main routes, functions, or modules an agent would likely touch
6. **Constraints & gotchas** — things an agent must NOT break, known limitations, important invariants

Be concise (aim for ~500-800 words). Focus on what an AI needs to make precise surgical changes without breaking things. Do not include generic advice — only facts specific to this codebase.`;

  return callClaude(prompt);
}

async function updateContextDoc(existingDoc, changedFiles, repoDir) {
  if (!changedFiles.length) return existingDoc;

  const diffs = changedFiles.slice(0, 10).map(({ status, path, newPath }) => {
    if (status === 'D') return `DELETED: ${path}`;
    const target = newPath || path;
    const content = readKeySafe(join(repoDir, target));
    const prefix = status.startsWith('R') ? `RENAMED ${path} → ${target}` : `MODIFIED: ${target}`;
    return content ? `${prefix}\n\`\`\`\n${content}\n\`\`\`` : `${prefix} (unreadable)`;
  }).join('\n\n');

  const prompt = `You maintain a codebase context document for an AI coding assistant.

## Existing context document
${existingDoc}

## Files that changed since this document was written
${diffs}

Update the context document to reflect these changes. Update only the sections affected by the changes. Preserve the structure and everything that is still accurate. Return the full updated document.`;

  return callClaude(prompt);
}

function getChangedFiles(repoDir, oldHash, newHash) {
  try {
    const out = execFileSync('git', ['diff', '--name-status', oldHash, newHash], {
      cwd: repoDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
    return out.split('\n').filter(Boolean).map(line => {
      const [status, ...parts] = line.split('\t');
      return status.startsWith('R')
        ? { status, path: parts[0], newPath: parts[1] }
        : { status, path: parts[0] };
    });
  } catch (_) { return null; }
}

function saveContext(appSlug, gitHash, fileTree, contextDoc) {
  getDb().prepare(`
    INSERT INTO app_codebase_context (app_slug, git_hash, built_at, file_tree, context_doc)
    VALUES (?, ?, datetime('now'), ?, ?)
    ON CONFLICT(app_slug) DO UPDATE SET
      git_hash = excluded.git_hash,
      built_at = excluded.built_at,
      file_tree = excluded.file_tree,
      context_doc = excluded.context_doc
  `).run(appSlug, gitHash, fileTree, contextDoc);
}

/**
 * Returns the cached context document for this app, building or updating it as needed.
 * Returns { contextDoc, fileTree, gitHash, fromCache }
 */
export async function ensureCodebaseContext(appSlug, repoDir) {
  if (!existsSync(repoDir)) return { contextDoc: null, fileTree: '', gitHash: null, fromCache: false };

  const db = getDb();
  const gitHash = getGitHash(repoDir);
  const cached = db.prepare('SELECT * FROM app_codebase_context WHERE app_slug = ?').get(appSlug);

  // Cache hit — same git hash
  if (cached && gitHash && cached.git_hash === gitHash) {
    log.info(`AppStudio context HIT for ${appSlug} @ ${gitHash.slice(0, 8)}`);
    return { contextDoc: cached.context_doc, fileTree: cached.file_tree || '', gitHash, fromCache: true, builtAt: cached.built_at };
  }

  const fileTree = getFileTree(repoDir);

  // Existing context but hash changed — try incremental update
  if (cached && gitHash) {
    log.info(`AppStudio context STALE for ${appSlug} — updating (${cached.git_hash.slice(0, 8)} → ${gitHash.slice(0, 8)})`);
    const changedFiles = getChangedFiles(repoDir, cached.git_hash, gitHash);

    if (changedFiles !== null) {
      const updatedDoc = await updateContextDoc(cached.context_doc, changedFiles, repoDir);
      saveContext(appSlug, gitHash, fileTree, updatedDoc);
      return { contextDoc: updatedDoc, fileTree, gitHash, fromCache: false, builtAt: new Date().toISOString() };
    }
    // Diff unavailable — fall through to full rebuild
  }

  // No cache or unreachable old hash — full build
  log.info(`AppStudio context BUILD for ${appSlug} @ ${gitHash?.slice(0, 8)}`);
  const keyFiles = collectKeyFiles(repoDir, fileTree);
  const contextDoc = await buildContextDoc(repoDir, fileTree, keyFiles);
  if (gitHash) saveContext(appSlug, gitHash, fileTree, contextDoc);

  return { contextDoc, fileTree, gitHash, fromCache: false, builtAt: new Date().toISOString() };
}
