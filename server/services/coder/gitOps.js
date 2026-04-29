import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import log from '../../utils/logger.js';

/**
 * Stage all changes, commit, regenerate package-lock if needed, and push.
 * Returns { pushed: true } or { pushed: false, reason } if nothing to commit.
 */
export async function commitAndPush({ workspaceDir, branchName, commitMsg, onLog }) {
  const git = (args, opts = {}) =>
    execFileSync('git', ['-c', `safe.directory=${workspaceDir}`, '-C', workspaceDir, ...args], {
      stdio: 'pipe', timeout: 60000, ...opts,
    });

  onLog?.('[coder:git] Staging all changes…');
  git(['add', '-A']);

  const diffOut = (() => { try { return git(['diff', '--cached', '--name-only']).toString().trim(); } catch (_) { return ''; } })();
  const changed = diffOut ? diffOut.split('\n').filter(Boolean) : [];

  if (changed.length === 0) {
    onLog?.('[coder:git] No file changes to commit');
    return { pushed: false, reason: 'no_changes' };
  }

  if (changed.includes('package.json') && existsSync(`${workspaceDir}/package.json`)) {
    onLog?.('[coder:git] package.json changed — regenerating package-lock.json…');
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
        cwd: workspaceDir, stdio: 'pipe', timeout: 120000,
      });
      git(['add', 'package-lock.json']);
      onLog?.('[coder:git] package-lock.json updated');
    } catch (err) {
      onLog?.(`[coder:git] Warning: could not regenerate package-lock.json: ${err.message}`);
    }
  }

  onLog?.(`[coder:git] ${changed.length} file(s) staged`);
  git(['commit', '-m', commitMsg]);
  onLog?.('[coder:git] Committed');

  onLog?.(`[coder:git] Pushing ${branchName}…`);
  try {
    git(['push', '-u', 'origin', branchName]);
  } catch (_) {
    onLog?.('[coder:git] Remote branch exists — force-pushing…');
    git(['push', '--force', '-u', 'origin', branchName]);
  }
  onLog?.(`[coder:git] Branch ${branchName} pushed`);
  log.info(`Coder: pushed branch ${branchName}`);
  return { pushed: true };
}
