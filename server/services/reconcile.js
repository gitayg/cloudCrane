import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../db.js';
import { getPortsForSlot } from './portAllocator.js';
import { reloadCaddy } from './caddy.js';
import log from '../utils/logger.js';

const ENVS = ['production', 'sandbox'];

function getDockerContainers() {
  try {
    const out = execFileSync('docker', ['ps', '-a', '--filter', 'label=appcrane=true',
      '--format', '{{.Names}}|{{.Label "slug"}}|{{.Label "env"}}|{{.Status}}'],
      { timeout: 10000, encoding: 'utf8' });
    if (!out.trim()) return [];
    return out.trim().split('\n').map(line => {
      const [name, slug, env, status] = line.split('|');
      return { name, slug, env, status };
    });
  } catch (_) {
    return [];
  }
}

function extractSlug(containerName) {
  // Docker container names: appcrane-<slug>-<env>
  const m = containerName.match(/^appcrane-(.+)-(production|sandbox)$/);
  return m ? m[1] : null;
}


function readAppMeta(slug, dataDir) {
  const appDir = join(dataDir, 'apps', slug);
  for (const env of ENVS) {
    const current = join(appDir, env, 'current');
    if (!existsSync(current)) continue;
    for (const file of ['deployhub.json', 'package.json']) {
      const filePath = join(current, file);
      if (!existsSync(filePath)) continue;
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        return {
          name: data.name || slug,
          description: data.description || null,
          source_type: data.github_url ? 'github' : 'upload',
          github_url: data.github_url || null,
          branch: data.branch || 'main',
        };
      } catch (_) {}
    }
  }
  return { name: slug, description: null, source_type: 'upload', github_url: null, branch: 'main' };
}

/**
 * Scan data/apps/ directory, find slugs missing from the apps table,
 * and register them. Reloads Caddy after any registrations.
 *
 * @param {{ dryRun?: boolean, dataDir?: string }} opts
 * @returns {{ orphaned: number, registered: Array, skipped: Array, caddy: object|null }}
 */
export async function reconcileOrphanedApps({ dryRun = false, dataDir } = {}) {
  const DATA_DIR = dataDir || resolve(process.env.DATA_DIR || './data');
  const db = getDb();

  // ── Collect slugs from Docker containers ──────────────────────────────────
  const slugInfo = {}; // slug → { processes: { production: { status }, sandbox: {...} }, fromDocker, fromFs }

  for (const c of getDockerContainers()) {
    const slug = c.slug || extractSlug(c.name);
    if (!slug) continue;
    if (!slugInfo[slug]) slugInfo[slug] = { processes: {}, fromDocker: true };
    slugInfo[slug].processes[c.env] = { status: c.status };
  }

  // Only running Docker containers count as orphans — not stale filesystem dirs.
  // Old data/apps/ directories from pre-Docker installs are just leftover data.

  // ── Cross-reference against DB ────────────────────────────────────────────
  const existingSlugs = new Set(db.prepare('SELECT slug FROM apps').all().map(r => r.slug));
  const usedSlots     = new Set(db.prepare('SELECT slot FROM apps').all().map(r => r.slot));

  const orphaned = Object.entries(slugInfo).filter(([slug]) => !existingSlugs.has(slug));
  if (orphaned.length === 0) {
    return { orphaned: 0, registered: [], skipped: [] };
  }

  // ── Register each orphaned app ────────────────────────────────────────────
  const registerApp = db.transaction((slug, slot, meta) => {
    const result = db.prepare(`
      INSERT INTO apps (name, slug, slot, source_type, github_url, branch, description, resource_limits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meta.name, slug, slot,
      meta.source_type, meta.github_url, meta.branch, meta.description,
      JSON.stringify({ max_ram_mb: 512, max_cpu_percent: 50 })
    );
    const appId = result.lastInsertRowid;
    for (const env of ENVS) {
      db.prepare('INSERT OR IGNORE INTO health_configs (app_id, env) VALUES (?, ?)').run(appId, env);
      db.prepare('INSERT OR IGNORE INTO health_state (app_id, env) VALUES (?, ?)').run(appId, env);
    }
    const webhookToken  = crypto.randomBytes(16).toString('hex');
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT OR IGNORE INTO webhook_configs (app_id, token, secret) VALUES (?, ?, ?)').run(appId, webhookToken, webhookSecret);
    return appId;
  });

  const registered = [];
  const skipped    = [];

  for (const [slug, info] of orphaned) {
    let s = (usedSlots.size > 0 ? Math.max(...usedSlots) : 0) + 1;
    while (usedSlots.has(s)) s++;
    const slot = s;

    const meta = readAppMeta(slug, DATA_DIR);
    const ports = getPortsForSlot(slot);
    const dockerStatus = Object.entries(info.processes).map(([e, p]) => `${e}=${p.status || '?'}`).join(' ') || 'not running';

    if (dryRun) {
      registered.push({ slug, slot, name: meta.name, ports, docker: dockerStatus, dry_run: true });
      usedSlots.add(slot);
      continue;
    }

    try {
      registerApp(slug, slot, meta);
      usedSlots.add(slot);
      registered.push({ slug, slot, name: meta.name, ports, docker: dockerStatus });
      log.info(`reconcile: registered '${slug}' at slot ${slot} (${meta.name})`);
    } catch (e) {
      skipped.push({ slug, error: e.message });
      log.error(`reconcile: failed to register '${slug}': ${e.message}`);
    }
  }

  let caddy = null;
  if (!dryRun && registered.length > 0) {
    caddy = await reloadCaddy();
  }

  return { orphaned: orphaned.length, registered, skipped, caddy };
}

/**
 * Lightweight check for startup warnings — returns orphaned slug list without writing anything.
 */
export function getOrphanedSlugs(dataDir) {
  const DATA_DIR = dataDir || resolve(process.env.DATA_DIR || './data');
  const db = getDb();
  const existingSlugs = new Set(db.prepare('SELECT slug FROM apps').all().map(r => r.slug));
  const found = new Set();

  for (const c of getDockerContainers()) {
    const slug = c.slug || extractSlug(c.name);
    if (slug && !existingSlugs.has(slug)) found.add(slug);
  }

  // Only Docker containers count as orphans (they're actually running but untracked).
  // Stale filesystem dirs in data/apps/ are just old data — not actionable.
  return [...found];
}
