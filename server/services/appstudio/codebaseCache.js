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
    const abs = join(repoDir, p); // nosemgrep: path-join-resolve-traversal — p comes from git ls-tree, not user input
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
 * Refresh cache for an app after a production deploy.
 * If the git hash is unchanged, does nothing.
 * If hash changed, rebuilds only the diff (changed/new/deleted files).
 */
export function refreshCache(appSlug, repoDir) {
  if (!existsSync(repoDir)) return;

  const db = getDb();
  const gitHash = getGitHash(repoDir);
  if (!gitHash) return;

  const cached = db.prepare('SELECT * FROM app_codebase_cache WHERE app_slug = ?').get(appSlug);

  if (cached && cached.git_hash === gitHash) {
    log.info(`AppStudio cache for ${appSlug} unchanged @ ${gitHash.slice(0, 8)}`);
    return;
  }

  let filesMap = {};
  if (cached) {
    try { filesMap = JSON.parse(cached.files_json || '{}'); } catch (_) {}

    // Get files changed between old and new commit
    try {
      const diff = execFileSync('git', ['diff', '--name-status', cached.git_hash, gitHash], {
        cwd: repoDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
      }).trim();

      for (const line of diff.split('\n')) {
        if (!line) continue;
        const [status, ...parts] = line.split('\t');
        const filePath = parts[parts.length - 1]; // handles renames (R old\tnew)
        const oldPath = parts[0];

        if (!filePath) continue;

        if (status === 'D') {
          // Deleted
          delete filesMap[filePath];
        } else if (status.startsWith('R')) {
          // Renamed: remove old, add new
          delete filesMap[oldPath];
          if (SOURCE_EXTS.test(filePath)) {
            const abs = join(repoDir, filePath); // nosemgrep: path-join-resolve-traversal — filePath from git diff output
            if (existsSync(abs)) {
              try {
                const content = readFileSync(abs, 'utf8');
                if (content.length <= MAX_FILE_BYTES) filesMap[filePath] = content;
              } catch (_) {}
            }
          }
        } else {
          // Added or modified
          if (SOURCE_EXTS.test(filePath)) {
            const abs = join(repoDir, filePath); // nosemgrep: path-join-resolve-traversal — filePath from git diff output
            if (existsSync(abs)) {
              try {
                const content = readFileSync(abs, 'utf8');
                if (content.length <= MAX_FILE_BYTES) filesMap[filePath] = content;
                else delete filesMap[filePath]; // file grew too large — evict
              } catch (_) {}
            }
          }
        }
      }
      log.info(`AppStudio cache for ${appSlug} updated (diff from ${cached.git_hash.slice(0, 8)} → ${gitHash.slice(0, 8)})`);
    } catch (_) {
      // Old commit unreachable (shallow clone, etc.) — full rebuild
      log.info(`AppStudio cache for ${appSlug} — diff unavailable, full rebuild`);
      const fileTree = buildFileTree(repoDir);
      filesMap = buildFilesMap(repoDir, fileTree);
      db.prepare(`
        INSERT INTO app_codebase_cache (app_slug, git_hash, built_at, file_tree, files_json)
        VALUES (?, ?, datetime('now'), ?, ?)
        ON CONFLICT(app_slug) DO UPDATE SET
          git_hash = excluded.git_hash, built_at = excluded.built_at,
          file_tree = excluded.file_tree, files_json = excluded.files_json
      `).run(appSlug, gitHash, buildFileTree(repoDir), JSON.stringify(filesMap));
      return;
    }
  } else {
    // No existing cache — full build
    const fileTree = buildFileTree(repoDir);
    filesMap = buildFilesMap(repoDir, fileTree);
    log.info(`AppStudio cache for ${appSlug} — initial build @ ${gitHash.slice(0, 8)}`);
  }

  const fileTree = buildFileTree(repoDir);
  db.prepare(`
    INSERT INTO app_codebase_cache (app_slug, git_hash, built_at, file_tree, files_json)
    VALUES (?, ?, datetime('now'), ?, ?)
    ON CONFLICT(app_slug) DO UPDATE SET
      git_hash = excluded.git_hash, built_at = excluded.built_at,
      file_tree = excluded.file_tree, files_json = excluded.files_json
  `).run(appSlug, gitHash, fileTree, JSON.stringify(filesMap));
}
