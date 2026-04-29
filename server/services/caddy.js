import { getDb } from '../db.js';
import { getPortsForSlot } from './portAllocator.js';
import { isLinux } from './platform.js';
import log from '../utils/logger.js';

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL || 'http://localhost:2019';

/**
 * Generate full Caddy config JSON (path-based routing).
 * Note: the Caddyfile format (generateCaddyfile) is used in production via systemctl reload.
 */
export function generateCaddyConfig() {
  const db = getDb();
  const apps = db.prepare('SELECT * FROM apps').all();
  const cranePort = parseInt(process.env.PORT || '5001');
  const liveRows = db.prepare("SELECT app_id, env FROM deployments WHERE status = 'live'").all();
  const liveSet = new Set(liveRows.map(r => `${r.app_id}:${r.env}`));
  const routes = [];

  for (const app of apps) {
    const ports = getPortsForSlot(app.slot);
    const slug = app.slug;

    // Sandbox path route — only if a live sandbox deployment exists
    if (liveSet.has(`${app.id}:sandbox`)) {
      routes.push({
        match: [{ path: [`/${slug}-sandbox*`] }],
        handle: [
          { handler: 'rewrite', strip_path_prefix: `/${slug}-sandbox` },
          { handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${ports.sand_be}` }] },
        ],
      });
    }

    // Production path route — only if a live production deployment exists
    if (liveSet.has(`${app.id}:production`)) {
      routes.push({
        match: [{ path: [`/${slug}*`] }],
        handle: [
          { handler: 'rewrite', strip_path_prefix: `/${slug}` },
          { handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${ports.prod_be}` }] },
        ],
      });
    }
  }

  // Catch-all → AppCrane
  routes.push({
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${cranePort}` }] }],
  });

  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443', ':80'],
            routes,
            automatic_https: {},
          },
        },
      },
    },
  };
}

/**
 * Generate Caddyfile format — path-based routing on a single CRANE_DOMAIN.
 * Apps are served at /{slug}/* and /{slug}-sandbox/* under the crane domain.
 * Sandbox routes are listed first so their longer prefix wins mutual-exclusivity.
 */
export function generateCaddyfile() {
  const db = getDb();
  const apps = db.prepare('SELECT * FROM apps').all();
  const cranePort = process.env.PORT || 5001;
  const craneDomain = process.env.CRANE_DOMAIN || null;
  const liveRows = db.prepare("SELECT app_id, env FROM deployments WHERE status = 'live'").all();
  const liveSet = new Set(liveRows.map(r => `${r.app_id}:${r.env}`));

  // TLS mode: manual cert (DB settings or env vars) or ACME (Caddy default)
  const tlsRows = db.prepare("SELECT key, value FROM settings WHERE key IN ('tls_cert_file','tls_key_file')").all();
  const tlsMap = Object.fromEntries(tlsRows.map(r => [r.key, r.value || '']));
  const certFile = tlsMap.tls_cert_file || process.env.TLS_CERT_FILE || '';
  const keyFile  = tlsMap.tls_key_file  || process.env.TLS_KEY_FILE  || '';
  const manualTls = certFile && keyFile;

  // Any *.caddy files in /etc/caddy/sites/ are imported and never overwritten by AppCrane.
  // Put custom domains (e.g. your own static sites) there.
  let caddyfile = '# Managed by AppCrane - do not edit manually\n\nimport /etc/caddy/sites/*.caddy\n\n';

  if (!craneDomain) {
    caddyfile += '# CRANE_DOMAIN not configured — no routing generated\n';
    return caddyfile;
  }

  caddyfile += `${craneDomain} {\n`;
  if (manualTls) {
    caddyfile += `    tls ${certFile} ${keyFile}\n\n`;
  }

  for (const app of apps) {
    const ports = getPortsForSlot(app.slot);
    const slug = app.slug;

    // Sandbox — longer prefix /${slug}-sandbox* wins over /${slug}* via mutual exclusivity
    caddyfile += `    handle /${slug}-sandbox* {\n`;
    if (liveSet.has(`${app.id}:sandbox`)) {
      caddyfile += `        forward_auth 127.0.0.1:${cranePort} {\n`;
      caddyfile += `            uri /api/identity/verify?app=${slug}\n`;
      caddyfile += `        }\n`;
      caddyfile += `        uri strip_prefix /${slug}-sandbox\n`;
      caddyfile += `        reverse_proxy 127.0.0.1:${ports.sand_be}\n`;
    } else {
      caddyfile += `        respond "Not deployed" 503\n`;
    }
    caddyfile += `    }\n\n`;

    // Production
    caddyfile += `    handle /${slug}* {\n`;
    if (liveSet.has(`${app.id}:production`)) {
      caddyfile += `        forward_auth 127.0.0.1:${cranePort} {\n`;
      caddyfile += `            uri /api/identity/verify?app=${slug}\n`;
      caddyfile += `        }\n`;
      caddyfile += `        uri strip_prefix /${slug}\n`;
      caddyfile += `        reverse_proxy 127.0.0.1:${ports.prod_be}\n`;
    } else {
      caddyfile += `        respond "Not deployed" 503\n`;
    }
    caddyfile += `    }\n\n`;
  }

  // Everything else → AppCrane itself
  caddyfile += `    handle {\n`;
  caddyfile += `        reverse_proxy 127.0.0.1:${cranePort}\n`;
  caddyfile += `    }\n\n`;

  // Friendly crash page when a proxied app is down (container exited, port
  // refused, etc.). Caddy turns connection-refused into a 502, we catch
  // 502/503/504 here, rewrite to AppCrane's /api/_crashed handler which
  // extracts the slug from the original path and renders a friendly HTML
  // page with a link to logs.
  caddyfile += `    handle_errors {\n`;
  caddyfile += `        @appdown expression \`{err.status_code} in [502, 503, 504]\`\n`;
  caddyfile += `        handle @appdown {\n`;
  caddyfile += `            rewrite * /api/_crashed{uri}\n`;
  caddyfile += `            reverse_proxy 127.0.0.1:${cranePort}\n`;
  caddyfile += `        }\n`;
  caddyfile += `    }\n`;
  caddyfile += `}\n`;

  return caddyfile;
}

/**
 * Push config to Caddy admin API and reload.
 */
export async function reloadCaddy() {
  if (!isLinux()) {
    const config = generateCaddyfile();
    log.info('[Caddy mock] Would write Caddyfile:\n' + config);
    return { success: true, mock: true };
  }

  // Write Caddyfile and reload via systemctl (most reliable)
  try {
    const { writeFileSync } = await import('fs');
    const caddyfile = generateCaddyfile();
    writeFileSync('/etc/caddy/Caddyfile', caddyfile);
    const { execSync } = await import('child_process');
    execSync('systemctl reload caddy', { timeout: 10000, stdio: 'pipe' });
    log.info('Caddy reloaded: ' + caddyfile.split('\n').filter(l => l.includes('{')).map(l => l.trim().split(' ')[0]).join(', '));
    return { success: true };
  } catch (e) {
    log.error(`Caddy reload failed: ${e.message}`);
    // Try restart instead of reload
    try {
      const { execSync } = await import('child_process');
      execSync('systemctl restart caddy', { timeout: 15000, stdio: 'pipe' });
      log.info('Caddy restarted (reload failed)');
      return { success: true, restarted: true };
    } catch (e2) {
      log.error(`Caddy restart also failed: ${e2.message}`);
      return { success: false, error: e.message };
    }
  }
}
