import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getDb } from '../../db.js';
import log from '../../utils/logger.js';

const SOURCE_EXTS = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rb|java|sql|json|html|css|md)$/i;
const MAX_FILE_BYTES = 50_000;
const MAX_TOTAL_BYTES = 3_000_000;

function getGitHash(repoDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
  } catch (_) {
    return null;
  }
}

function buildFileTree(repoDir) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
  } catch (_) {
    return '';
  }
}

function buildFilesMap(repoDir, fileTree) {
  const paths = fileTree.split('\n').filter(p => p && SOURCE_EXTS.test(p) && !p.includes('node_modules'));
  const map = {};
  let totalBytes = 0;
  for (const p of paths) {
    const abs = join(repoDir, p);
    if (!existsSync(abs)) continue;
    try {
      const size = statSync(abs).size;
      if (size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES) continue;
      map[p] = readFileSync(abs, 'utf8');
      totalBytes += size;
    } catch (_) {}
  }
  return map;
}

/**
 * Returns { fileTree, filesMap, gitHash, fromCache } for repoDir.
 * Rebuilds and stores the cache if the git hash has changed.
 */
export function getOrBuildCache(appSlug, repoDir) {
  if (!existsSync(repoDir)) return { fileTree: '', filesMap: {}, gitHash: null, fromCache: false };

  const db = getDb();
  const gitHash = getGitHash(repoDir);

  if (gitHash) {
    const cached = db.prepare('SELECT * FROM app_codebase_cache WHERE app_slug = ?').get(appSlug);
    if (cached && cached.git_hash === gitHash) {
      let filesMap = {};
      try { filesMap = JSON.parse(cached.files_json || '{}'); } catch (_) {}
      log.info(`AppStudio cache HIT for ${appSlug} @ ${gitHash.slice(0, 8)}`);
      return { fileTree: cached.file_tree || '', filesMap, gitHash, fromCache: true, builtAt: cached.built_at };
    }
  }

  log.info(`AppStudio cache MISS for ${appSlug} — building context snapshot`);
  const fileTree = buildFileTree(repoDir);
  const filesMap = buildFilesMap(repoDir, fileTree);

  if (gitHash) {
    db.prepare(`
      INSERT INTO app_codebase_cache (app_slug, git_hash, built_at, file_tree, files_json)
      VALUES (?, ?, datetime('now'), ?, ?)
      ON CONFLICT(app_slug) DO UPDATE SET
        git_hash = excluded.git_hash,
        built_at = excluded.built_at,
        file_tree = excluded.file_tree,
        files_json = excluded.files_json
    `).run(appSlug, gitHash, fileTree, JSON.stringify(filesMap));
  }

  return { fileTree, filesMap, gitHash, fromCache: false };
}

/**
 * Invalidate cache for an app (call after a new production deploy).
 */
export function invalidateCache(appSlug) {
  try {
    getDb().prepare('DELETE FROM app_codebase_cache WHERE app_slug = ?').run(appSlug);
  } catch (_) {}
}
