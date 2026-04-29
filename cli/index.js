import { Command } from 'commander';
import { getApiUrl, getApiKey, saveConfig, getConfig } from './config.js';
import * as out from './output.js';

const program = new Command();

// HTTP helper
async function api(method, path, body) {
  const url = `${getApiUrl()}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) {
      out.err(data.error?.message || `HTTP ${res.status}`);
      process.exit(1);
    }
    return data;
  } catch (e) {
    out.err(`Connection failed: ${e.message}`);
    out.dim(`API URL: ${url}`);
    out.dim('Is the AppCrane server running? Start with: node server/index.js');
    process.exit(1);
  }
}

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __clidir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__clidir, '..', 'package.json'), 'utf8'));

program
  .name('crane')
  .description('AppCrane - Self-hosted deployment manager')
  .version(pkg.version);

// ── Config ──────────────────────────────
program
  .command('config')
  .description('Configure CLI connection')
  .option('--url <url>', 'API server URL')
  .option('--key <key>', 'API key')
  .option('--show', 'Show current config')
  .action((opts) => {
    if (opts.show) {
      const config = getConfig();
      out.header('AppCrane Config');
      out.keyValue({
        'API URL': config.api_url,
        'API Key': config.api_key ? config.api_key.slice(0, 12) + '...' : '(not set)',
      });
      return;
    }
    const config = getConfig();
    if (opts.url) config.api_url = opts.url;
    if (opts.key) config.api_key = opts.key;
    saveConfig(config);
    out.ok('Config saved');
  });

// ── Init (direct DB access, no server needed) ──────────────────────────────
program
  .command('init')
  .description('Initialize AppCrane (first run - creates admin directly in DB)')
  .option('--name <name>', 'Admin name', 'admin')
  .option('--email <email>', 'Admin email')
  .action(async (opts) => {
    try {
      // Import DB and encryption directly - no API call needed
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const { initDb, getDb } = await import(join(__dirname, '..', 'server', 'db.js'));
      const { generateApiKey, hashApiKey } = await import(join(__dirname, '..', 'server', 'services', 'encryption.js'));

      initDb();
      const db = getDb();

      // Check if admin already exists
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      if (userCount > 0) {
        out.err('AppCrane is already initialized. Admin user exists.');
        process.exit(1);
      }

      const adminName = opts.name || 'admin';
      const adminEmail = opts.email || 'admin@localhost';
      const apiKey = generateApiKey('dhk_admin');
      const keyHash = hashApiKey(apiKey);

      db.prepare(
        'INSERT INTO users (name, email, role, api_key_hash) VALUES (?, ?, ?, ?)'
      ).run(adminName, adminEmail, 'admin', keyHash);

      // Generate and save ENCRYPTION_KEY to .env if not present
      const crypto = await import('crypto');
      const { readFileSync, writeFileSync, existsSync } = await import('fs');
      const envPath = join(__dirname, '..', '.env');
      let envContent = '';
      if (existsSync(envPath)) {
        envContent = readFileSync(envPath, 'utf8');
      }
      if (!envContent.includes('ENCRYPTION_KEY=')) {
        const encKey = crypto.randomBytes(32).toString('hex');
        envContent += `\nENCRYPTION_KEY=${encKey}\n`;
        writeFileSync(envPath, envContent);
        process.env.ENCRYPTION_KEY = encKey;
        out.ok('ENCRYPTION_KEY generated and saved to .env');
      }

      out.ok('AppCrane initialized!');
      out.header('Admin User');
      out.keyValue({ Name: adminName, Email: adminEmail, Role: 'admin' });
      console.log('');
      out.warn(`API Key: ${apiKey}`);
      out.warn('Save this key! It will not be shown again.');

      // Auto-save key
      const config = getConfig();
      config.api_key = apiKey;
      saveConfig(config);
      console.log('');
      out.ok('API key auto-saved to ~/.appcrane/config.json');
    } catch (e) {
      out.err(`Init failed: ${e.message}`);
      out.dim('Make sure you run this from the appCrane directory.');
      process.exit(1);
    }
  });

// ── Regenerate Admin Key (direct DB, server-only) ──────────────────────────────
program
  .command('regenerate-key')
  .description('Regenerate admin API key (must run on server)')
  .action(async () => {
    try {
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const { initDb, getDb } = await import(join(__dirname, '..', 'server', 'db.js'));
      const { generateApiKey, hashApiKey } = await import(join(__dirname, '..', 'server', 'services', 'encryption.js'));

      initDb();
      const db = getDb();

      const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
      if (!admin) {
        out.err('No admin user found. Run: crane init');
        process.exit(1);
      }

      const apiKey = generateApiKey('dhk_admin');
      const keyHash = hashApiKey(apiKey);
      db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(keyHash, admin.id);

      out.ok(`Admin key regenerated for ${admin.name}`);
      out.warn(`New API Key: ${apiKey}`);
      out.warn('Save this key! The old key no longer works.');

      // Auto-save
      const config = getConfig();
      config.api_key = apiKey;
      saveConfig(config);
      out.ok('API key auto-saved to ~/.appcrane/config.json');
    } catch (e) {
      out.err(`Failed: ${e.message}`);
      out.dim('Make sure you run this from the appCrane directory.');
      process.exit(1);
    }
  });

// ── Update (git pull + systemctl restart) ──────────────────────────────
program
  .command('update')
  .description('Pull latest code from GitHub and restart AppCrane')
  .action(async () => {
    try {
      const { execSync, execFileSync } = await import('child_process');
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const { readFileSync } = await import('fs');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const projectDir = join(__dirname, '..');
      const pkgPath = join(projectDir, 'package.json');
      const readVersion = () => {
        try { return JSON.parse(readFileSync(pkgPath, 'utf8')).version; }
        catch (_) { return 'unknown'; }
      };

      const fromVersion = readVersion();
      out.info(`Current version: v${fromVersion}`);

      out.info('Pulling latest from GitHub...');
      const pullOutput = execSync('git fetch origin && git reset --hard origin/main', { cwd: projectDir, stdio: 'pipe' }).toString().trim();
      console.log(pullOutput);

      const toVersion = readVersion();
      if (toVersion === fromVersion) {
        out.dim(`Already on latest (v${toVersion}) — no version change.`);
      } else {
        out.ok(`Updated v${fromVersion} → v${toVersion}`);
      }

      out.info('Installing dependencies...');
      try {
        execSync('npm install --omit=dev --prefer-offline', { cwd: projectDir, stdio: 'pipe', timeout: 120000 });
        out.ok('Dependencies installed');
      } catch (e) {
        out.warn('npm install failed: ' + e.message);
      }

      out.info('Restarting AppCrane...');
      try {
        execFileSync('systemctl', ['restart', 'appcrane'], { stdio: 'pipe' });
        out.ok(`AppCrane v${toVersion} restarted!`);
      } catch (e) {
        out.warn('systemctl restart failed: ' + e.message);
        out.dim('Try manually: systemctl restart appcrane');
      }
    } catch (e) {
      out.err(`Update failed: ${e.message}`);
      process.exit(1);
    }
  });

// ── Caddy ──────────────────────────────
program
  .command('caddy')
  .description('Show or reload Caddy reverse proxy config')
  .option('--reload', 'Regenerate and reload Caddy config')
  .option('--show', 'Show current generated Caddyfile')
  .action(async (opts) => {
    if (opts.reload) {
      out.info('Regenerating Caddy config and reloading...');
      const data = await api('POST', '/api/caddy/reload');
      if (data.success) {
        out.ok('Caddy reloaded');
      } else {
        out.err(`Caddy reload failed: ${data.error || 'unknown'}`);
      }
      if (data.caddyfile) {
        console.log('');
        console.log(data.caddyfile);
      }
    } else {
      // Show generated config (plain text)
      const url = `${getApiUrl()}/api/caddy/config`;
      const key = getApiKey();
      const res = await fetch(url, { headers: { 'X-API-Key': key } });
      if (!res.ok) { out.err('Failed to get config'); process.exit(1); }
      console.log(await res.text());
    }
  });

// ── Setup HTTPS ──────────────────────────────
program
  .command('setup-https')
  .description('Install Caddy, configure HTTPS, set up firewall')
  .requiredOption('--domain <domain>', 'Domain for AppCrane (e.g., crane.example.com)')
  .action(async (opts) => {
    const { execSync } = await import('child_process');
    const { existsSync, readFileSync, writeFileSync } = await import('fs');
    const domain = opts.domain;

    // Check if running as root
    try {
      execSync('whoami', { stdio: 'pipe' });
    } catch (e) {}
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) {
      out.err('setup-https must be run as root (use sudo)');
      process.exit(1);
    }

    // Step 1: Install Caddy
    out.header('Step 1: Installing Caddy');
    try {
      execSync('which caddy', { stdio: 'pipe' });
      out.ok('Caddy already installed');
    } catch (e) {
      out.info('Installing Caddy...');
      try {
        execSync('apt install -y debian-keyring debian-archive-keyring apt-transport-https curl', { stdio: 'inherit' });
        execSync("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg", { stdio: 'inherit' });
        execSync("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list", { stdio: 'inherit' });
        execSync('apt update', { stdio: 'inherit' });
        execSync('apt install -y caddy', { stdio: 'inherit' });
        out.ok('Caddy installed');
      } catch (e2) {
        out.err(`Caddy install failed: ${e2.message}`);
        out.dim('Install manually: https://caddyserver.com/docs/install');
        process.exit(1);
      }
    }

    // Step 2: Create Caddyfile (replaces default)
    out.header('Step 2: Configuring Caddy');
    const caddyfilePath = '/etc/caddy/Caddyfile';

    // Extract root domain (e.g., crane.example.com -> example.com)
    const parts = domain.split('.');
    const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : null;

    let caddyfile = `# Managed by AppCrane\n\n`;
    caddyfile += `${domain} {\n    reverse_proxy localhost:5001\n}\n`;

    if (rootDomain && rootDomain !== domain) {
      caddyfile += `\n${rootDomain} {\n    redir https://${domain}{uri} permanent\n}\n`;
      out.ok(`${domain} → AppCrane`);
      out.ok(`${rootDomain} → redirects to ${domain}`);
    } else {
      out.ok(`${domain} → AppCrane`);
    }

    writeFileSync(caddyfilePath, caddyfile);
    out.ok('Caddyfile written');

    // Step 3: Restart Caddy
    out.header('Step 3: Starting Caddy');
    try {
      execSync('systemctl restart caddy', { stdio: 'inherit' });
      execSync('systemctl enable caddy', { stdio: 'pipe' });
      out.ok('Caddy started (auto-HTTPS enabled)');
    } catch (e) {
      out.err(`Caddy start failed: ${e.message}`);
      out.dim('Check: systemctl status caddy');
      process.exit(1);
    }

    // Step 4: Configure firewall
    out.header('Step 4: Configuring firewall');
    try {
      // Check if ufw is available
      execSync('which ufw', { stdio: 'pipe' });
      execSync('ufw allow 22/tcp', { stdio: 'pipe' });
      execSync('ufw allow 80/tcp', { stdio: 'pipe' });
      execSync('ufw allow 443/tcp', { stdio: 'pipe' });
      execSync('ufw deny 5001', { stdio: 'pipe' });
      try {
        execSync('echo "y" | ufw enable', { stdio: 'pipe' });
      } catch (e) {
        // ufw may already be enabled
      }
      out.ok('Firewall configured (80, 443 open | 5001 blocked externally)');
    } catch (e) {
      out.warn('ufw not available. Configure firewall manually:');
      out.dim('  Allow ports 22, 80, 443. Deny port 5001.');
    }

    // Step 5: Update CLI config + .env
    out.header('Step 5: Updating config');
    const config = getConfig();
    config.api_url = `https://${domain}`;
    saveConfig(config);
    out.ok(`CLI URL set to https://${domain}`);

    // Save CRANE_DOMAIN to .env so Caddy config includes AppCrane's route
    const { dirname: dn, join: jn } = await import('path');
    const { fileURLToPath: fu } = await import('url');
    const projDir = jn(dn(fu(import.meta.url)), '..');
    const envPath = jn(projDir, '.env');
    let envContent = '';
    try { envContent = readFileSync(envPath, 'utf8'); } catch (e) {}

    if (envContent.includes('CRANE_DOMAIN=')) {
      envContent = envContent.replace(/CRANE_DOMAIN=.*/g, `CRANE_DOMAIN=${domain}`);
    } else {
      envContent += `\nCRANE_DOMAIN=${domain}\n`;
    }

    // Also set BASE_DOMAIN from the domain (e.g., myapp.example.com -> example.com)
    const baseDomain = parts.slice(-2).join('.');
    if (envContent.includes('BASE_DOMAIN=')) {
      envContent = envContent.replace(/BASE_DOMAIN=.*/g, `BASE_DOMAIN=${baseDomain}`);
    } else {
      envContent += `BASE_DOMAIN=${baseDomain}\n`;
    }

    writeFileSync(envPath, envContent);
    out.ok(`CRANE_DOMAIN=${domain} saved to .env`);
    out.ok(`BASE_DOMAIN=${baseDomain} saved to .env`);

    // Step 6: Verify
    out.header('Step 6: Verifying');
    out.info(`Testing https://${domain}/api/info ...`);
    // Wait a moment for Caddy to provision cert
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`https://${domain}/api/info`);
      const data = await res.json();
      if (data.name === 'AppCrane') {
        out.ok(`HTTPS is working! https://${domain}`);
      } else {
        out.warn('Got a response but it may not be AppCrane');
      }
    } catch (e) {
      out.warn(`Could not verify yet: ${e.message}`);
      out.dim('DNS may need a few minutes to propagate. Try:');
      out.dim(`  curl -s https://${domain}/api/info`);
    }

    console.log('');
    out.header('Done!');
    out.keyValue({
      'Dashboard': `https://${domain}`,
      'API': `https://${domain}/api/info`,
      'Docs': `https://${domain}/docs`,
      'Agent guide': `https://${domain}/agent-guide`,
    });
    console.log('');
    out.dim('Make sure DNS A records point to this server:');
    try {
      const ip = execSync('curl -s ifconfig.me', { stdio: 'pipe', timeout: 5000 }).toString().trim();
      out.dim(`  ${domain}  →  ${ip}`);
      if (rootDomain && rootDomain !== domain) {
        out.dim(`  ${rootDomain}  →  ${ip}  (redirects to ${domain})`);
      }
      out.dim(`  *.${parts.slice(-2).join('.')}  →  ${ip}  (for app subdomains)`);
    } catch (e) {
      out.dim(`  ${domain}  →  YOUR_SERVER_IP`);
    }
  });

// ── Me ──────────────────────────────
program
  .command('me')
  .description('Show current user info')
  .action(async () => {
    const data = await api('GET', '/api/auth/me');
    out.header('Current User');
    out.keyValue({
      Name: data.user.name,
      Email: data.user.email || '-',
      Role: data.user.role,
      Apps: data.apps.map(a => a.slug).join(', ') || 'none',
    });
  });

// ── Server ──────────────────────────
program
  .command('status')
  .description('Show server health and all apps')
  .action(async () => {
    const data = await api('GET', '/api/server/health');
    const s = data.system;

    out.header('AppCrane Server');
    out.keyValue({
      Host: s.hostname,
      Platform: s.platform,
      CPU: `${s.cpu.percent}% (${s.cpu.count} cores)`,
      Memory: `${s.memory_formatted.used} / ${s.memory_formatted.total} (${s.memory.percent}%)`,
      Disk: `${s.disk_formatted.used} / ${s.disk_formatted.total} (${s.disk.percent}%)`,
    });

    console.log('');
    out.header('Apps');
    out.keyValue({
      Total: data.apps.total,
      Environments: data.apps.environments,
      Healthy: data.apps.healthy,
      Down: data.apps.down,
    });

    if (data.recent_deploys?.length) {
      console.log('');
      out.header('Recent Deploys');
      out.table(
        ['App', 'Env', 'Version', 'Status', 'When'],
        data.recent_deploys.slice(0, 5).map(d => [
          d.slug, d.env, d.version || '-', d.status, d.finished_at || d.started_at
        ])
      );
    }
  });

// ── Apps ────────────────────────────
const appCmd = program.command('app').description('Manage apps');

appCmd
  .command('list')
  .description('List all apps')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const data = await api('GET', '/api/apps');
    if (opts.json) { out.json(data.apps); return; }

    out.header(`Apps (${data.apps.length})`);
    if (data.apps.length === 0) {
      out.dim('  No apps yet. Create one with: cc app create');
      return;
    }
    out.table(
      ['Slug', 'Name', 'Domain', 'Prod', 'Sandbox', 'Version'],
      data.apps.map(a => [
        a.slug,
        a.name,
        a.domain || '-',
        out.statusBadge(a.production?.health?.status || 'unknown'),
        out.statusBadge(a.sandbox?.health?.status || 'unknown'),
        a.production?.deploy?.version || '-',
      ])
    );
  });

appCmd
  .command('create')
  .description('Create a new app')
  .requiredOption('--name <name>', 'App display name')
  .requiredOption('--slug <slug>', 'URL-safe identifier')
  .option('--domain <domain>', 'Custom domain')
  .option('--source <type>', 'Source type: github or upload', 'github')
  .option('--repo <url>', 'GitHub repository URL')
  .option('--branch <branch>', 'Git branch', 'main')
  .option('--token <token>', 'GitHub personal access token (for private repos)')
  .option('--max-ram <mb>', 'Max RAM in MB', '512')
  .option('--max-cpu <percent>', 'Max CPU percent', '50')
  .action(async (opts) => {
    const data = await api('POST', '/api/apps', {
      name: opts.name,
      slug: opts.slug,
      domain: opts.domain,
      source_type: opts.source,
      github_url: opts.repo,
      branch: opts.branch,
      github_token: opts.token || undefined,
      max_ram_mb: parseInt(opts.maxRam),
      max_cpu_percent: parseInt(opts.maxCpu),
    });
    out.ok(`App '${data.app.name}' created (slot: ${data.app.slot})`);
    out.keyValue({
      Slug: data.app.slug,
      'Production': data.urls?.production || '-',
      'Sandbox': data.urls?.sandbox || '-',
      Webhook: data.webhook_url,
    });
    console.log('');
    out.info(`Next: assign a user with: cc app assign ${data.app.slug} --email user@example.com`);
  });

appCmd
  .command('info <slug>')
  .description('Show app details')
  .action(async (slug) => {
    const data = await api('GET', `/api/apps/${slug}`);
    const a = data.app;

    out.header(`${a.name} (${a.slug})`);
    out.keyValue({
      Domain: a.domain || '-',
      Source: a.source_type,
      Repo: a.github_url || '-',
      Branch: a.branch || '-',
      Created: a.created_at,
    });

    console.log('');
    out.header('URLs');
    out.keyValue({
      'Production': data.urls?.production || '-',
      'Sandbox': data.urls?.sandbox || '-',
    });

    console.log('');
    out.header('Health');
    out.keyValue({
      Production: out.statusBadge(data.health.production?.state?.is_down ? 'down' :
        data.health.production?.state?.last_status === 200 ? 'healthy' : 'unknown'),
      Sandbox: out.statusBadge(data.health.sandbox?.state?.is_down ? 'down' :
        data.health.sandbox?.state?.last_status === 200 ? 'healthy' : 'unknown'),
    });

    if (data.users?.length) {
      console.log('');
      out.header('Users');
      data.users.forEach(u => out.info(`${u.name} (${u.email})`));
    }

    if (data.deployments?.length) {
      console.log('');
      out.header('Recent Deployments');
      out.table(
        ['Env', 'Version', 'Status', 'When'],
        data.deployments.slice(0, 5).map(d => [d.env, d.version || '-', d.status, d.finished_at || d.started_at])
      );
    }

    if (data.webhook) {
      console.log('');
      out.header('Webhook');
      out.keyValue({
        URL: data.webhook.url,
        'Auto sandbox': data.webhook.auto_deploy_sandbox ? 'ON' : 'OFF',
        'Auto prod': data.webhook.auto_deploy_prod ? 'ON' : 'OFF',
      });
    }
  });

appCmd
  .command('delete <slug>')
  .description('Delete an app')
  .option('--confirm', 'Confirm deletion')
  .action(async (slug, opts) => {
    if (!opts.confirm) {
      out.warn(`This will delete app '${slug}' and all its data.`);
      out.info(`Run: cc app delete ${slug} --confirm`);
      return;
    }
    await api('DELETE', `/api/apps/${slug}?confirm=true`);
    out.ok(`App '${slug}' deleted`);
  });

appCmd
  .command('deploy-key <slug>')
  .description('Create or recycle the deployment API key for an app')
  .option('--recycle', 'Rotate the existing key (invalidates the old one)')
  .action(async (slug, opts) => {
    if (opts.recycle) {
      const data = await api('POST', `/api/apps/${slug}/deployment-key/recycle`);
      out.ok(`Deployment key rotated for '${slug}'`);
      out.warn(`New API key: ${data.api_key}`);
      out.warn('Save this key — the old one is now invalid.');
    } else {
      const data = await api('POST', `/api/apps/${slug}/deployment-key`);
      out.ok(`Deployment key created for '${slug}'`);
      out.warn(`API key: ${data.api_key}`);
      out.warn('Save this key — it will not be shown again.');
    }
  });

appCmd
  .command('assign <slug>')
  .description('Assign users to app')
  .option('--email <emails...>', 'User emails to assign')
  .action(async (slug, opts) => {
    if (!opts.email?.length) { out.err('Provide --email'); return; }
    const data = await api('PUT', `/api/apps/${slug}/users`, { user_emails: opts.email });
    out.ok(`Users assigned to ${slug}:`);
    data.users.forEach(u => out.info(`${u.name} (${u.email})`));
  });

// ── Deploy ──────────────────────────
program
  .command('deploy <slug>')
  .description('Deploy an app')
  .option('--env <env>', 'Environment: production or sandbox', 'sandbox')
  .action(async (slug, opts) => {
    out.info(`Deploying ${slug} to ${opts.env}...`);
    const data = await api('POST', `/api/apps/${slug}/deploy/${opts.env}`);
    out.ok(data.message);
    out.info(`Track progress: cc deploy:log ${slug} --id ${data.deployment.id}`);
  });

program
  .command('deploy:history <slug>')
  .description('Show deployment history')
  .option('--env <env>', 'Environment', 'production')
  .action(async (slug, opts) => {
    const data = await api('GET', `/api/apps/${slug}/deployments/${opts.env}`);
    out.header(`Deployments - ${slug} (${opts.env})`);
    out.table(
      ['ID', 'Version', 'Status', 'By', 'Started', 'Finished'],
      data.deployments.map(d => [d.id, d.version || '-', d.status, d.deployed_by_name || '-', d.started_at, d.finished_at || '-'])
    );
  });

program
  .command('deploy:log <slug>')
  .description('Show deploy build log')
  .requiredOption('--id <id>', 'Deployment ID')
  .option('--env <env>', 'Environment', 'sandbox')
  .action(async (slug, opts) => {
    const data = await api('GET', `/api/apps/${slug}/deployments/${opts.env}/${opts.id}/log`);
    out.header(`Deploy Log #${opts.id} (${data.status})`);
    console.log(data.log || '(no log yet)');
  });

program
  .command('rollback <slug>')
  .description('Rollback to previous version')
  .option('--env <env>', 'Environment', 'production')
  .option('--to <id>', 'Specific deployment ID to rollback to')
  .action(async (slug, opts) => {
    const body = opts.to ? { deployment_id: parseInt(opts.to) } : {};
    const data = await api('POST', `/api/apps/${slug}/rollback/${opts.env}`, body);
    out.ok(data.message);
  });

program
  .command('promote <slug>')
  .description('Promote sandbox code to production')
  .action(async (slug) => {
    const data = await api('POST', `/api/apps/${slug}/promote`);
    out.ok(data.message);
  });

// ── Env Vars ────────────────────────
const envCmd = program.command('env').description('Manage environment variables');

envCmd
  .command('list <slug>')
  .description('List env vars')
  .option('--env <env>', 'Environment', 'production')
  .option('--reveal', 'Show actual values')
  .action(async (slug, opts) => {
    const reveal = opts.reveal ? '?reveal=true' : '';
    const data = await api('GET', `/api/apps/${slug}/env/${opts.env}${reveal}`);
    out.header(`Env Vars - ${slug} (${opts.env})`);
    if (data.vars.length === 0) { out.dim('  No env vars set'); return; }
    out.table(['Key', 'Value', 'Updated'], data.vars.map(v => [v.key, v.value, v.updated_at]));
    if (data.warnings?.length) {
      console.log('');
      data.warnings.forEach(w => out.warn(w));
    }
  });

envCmd
  .command('set <slug>')
  .description('Set env vars (KEY=VALUE pairs)')
  .option('--env <env>', 'Environment', 'sandbox')
  .argument('<pairs...>', 'KEY=VALUE pairs')
  .action(async (slug, pairs, opts) => {
    const vars = {};
    for (const pair of pairs) {
      const [key, ...rest] = pair.split('=');
      vars[key] = rest.join('=');
    }
    const data = await api('PUT', `/api/apps/${slug}/env/${opts.env}`, { vars });
    out.ok(data.message);
  });

envCmd
  .command('delete <slug> <key>')
  .description('Delete an env var')
  .option('--env <env>', 'Environment', 'sandbox')
  .action(async (slug, key, opts) => {
    const data = await api('DELETE', `/api/apps/${slug}/env/${opts.env}/${key}`);
    out.ok(data.message);
  });

// ── Health ──────────────────────────
const healthCmd = program.command('health').description('Health checks');

healthCmd
  .command('status <slug>')
  .description('Show health status')
  .action(async (slug) => {
    for (const env of ['production', 'sandbox']) {
      const data = await api('GET', `/api/apps/${slug}/health/${env}`);
      out.header(`Health - ${slug} (${env})`);
      if (data.config) {
        out.keyValue({
          Endpoint: data.config.endpoint,
          Interval: `${data.config.interval_sec}s`,
          'Fail threshold': data.config.fail_threshold,
          'Down threshold': data.config.down_threshold,
          Enabled: data.config.enabled ? 'yes' : 'no',
        });
      }
      if (data.state) {
        out.keyValue({
          Status: out.statusBadge(data.state.is_down ? 'down' : (data.state.last_status === 200 ? 'healthy' : 'unknown')),
          'Last check': data.state.last_check_at || 'never',
          'Response': data.state.last_response_ms ? `${data.state.last_response_ms}ms` : '-',
          'Consecutive fails': data.state.consecutive_fails,
        });
      }
    }
  });

healthCmd
  .command('config <slug>')
  .description('Configure health check')
  .option('--env <env>', 'Environment', 'production')
  .option('--endpoint <path>', 'Health endpoint path')
  .option('--interval <sec>', 'Check interval in seconds')
  .option('--fail-threshold <n>', 'Failures before restart')
  .option('--down-threshold <n>', 'Failures before marking down')
  .action(async (slug, opts) => {
    const body = {};
    if (opts.endpoint) body.endpoint = opts.endpoint;
    if (opts.interval) body.interval_sec = parseInt(opts.interval);
    if (opts.failThreshold) body.fail_threshold = parseInt(opts.failThreshold);
    if (opts.downThreshold) body.down_threshold = parseInt(opts.downThreshold);
    const data = await api('PUT', `/api/apps/${slug}/health/${opts.env}`, body);
    out.ok(data.message || 'Health config updated');
  });

healthCmd
  .command('test <slug>')
  .description('Test health endpoint now')
  .option('--env <env>', 'Environment', 'production')
  .action(async (slug, opts) => {
    out.info(`Testing ${slug} ${opts.env} health...`);
    const data = await api('POST', `/api/apps/${slug}/health/${opts.env}/test`);
    if (data.healthy) {
      out.ok(`${data.url} → ${data.status} (${data.response_ms}ms)`);
      if (data.body) out.dim(`  Response: ${JSON.stringify(data.body)}`);
    } else {
      out.err(`${data.url} → ${data.status || 'UNREACHABLE'} (${data.response_ms}ms)`);
      if (data.error) out.dim(`  Error: ${data.error}`);
    }
  });

// ── Webhook ─────────────────────────
program
  .command('webhook <slug>')
  .description('Show/configure webhook')
  .option('--auto-sandbox <on|off>', 'Auto-deploy sandbox on push')
  .option('--auto-prod <on|off>', 'Auto-deploy production on push')
  .option('--branch <branch>', 'Branch filter')
  .action(async (slug, opts) => {
    if (opts.autoSandbox || opts.autoProd || opts.branch) {
      const body = {};
      if (opts.autoSandbox) body.auto_deploy_sandbox = opts.autoSandbox === 'on';
      if (opts.autoProd) body.auto_deploy_prod = opts.autoProd === 'on';
      if (opts.branch) body.branch_filter = opts.branch;
      const data = await api('PUT', `/api/apps/${slug}/webhook`, body);
      out.ok(data.message);
    }
    const data = await api('GET', `/api/apps/${slug}/webhook`);
    out.header(`Webhook - ${slug}`);
    out.keyValue({
      URL: data.webhook_url,
      'Auto sandbox': data.auto_deploy_sandbox ? 'ON' : 'OFF',
      'Auto prod': data.auto_deploy_prod ? 'ON' : 'OFF',
      'Branch filter': data.branch_filter || '*',
    });
  });

// ── Backup ──────────────────────────
const backupCmd = program.command('backup').description('Backup management');

backupCmd
  .command('create <slug>')
  .option('--env <env>', 'Environment', 'production')
  .description('Create backup')
  .action(async (slug, opts) => {
    out.info(`Creating backup of ${slug} ${opts.env}...`);
    const data = await api('POST', `/api/apps/${slug}/backup/${opts.env}`);
    out.ok(data.message);
    out.keyValue({ ID: data.backup.id, Size: `${data.backup.size_bytes} bytes` });
  });

backupCmd
  .command('list <slug>')
  .description('List backups')
  .action(async (slug) => {
    const data = await api('GET', `/api/apps/${slug}/backups`);
    out.header(`Backups - ${slug}`);
    out.table(
      ['ID', 'Env', 'Size', 'Created', 'By'],
      data.backups.map(b => [b.id, b.env, `${b.size_bytes} B`, b.created_at, b.created_by_name || '-'])
    );
  });

backupCmd
  .command('restore <slug>')
  .requiredOption('--id <id>', 'Backup ID')
  .description('Restore from backup')
  .action(async (slug, opts) => {
    out.warn('This will overwrite current data!');
    const data = await api('POST', `/api/apps/${slug}/restore/${opts.id}`);
    out.ok(data.message);
  });

// ── Logs ────────────────────────────
program
  .command('logs <slug>')
  .description('View app logs')
  .option('--env <env>', 'Environment', 'production')
  .option('--lines <n>', 'Number of lines', '100')
  .action(async (slug, opts) => {
    const data = await api('GET', `/api/apps/${slug}/logs/${opts.env}?lines=${opts.lines}`);
    if (data.logs?.length) {
      data.logs.forEach(line => console.log(line));
    } else {
      out.dim('No logs available');
    }
  });

program
  .command('audit')
  .description('View audit log')
  .option('--app <slug>', 'Filter by app')
  .option('--limit <n>', 'Number of entries', '30')
  .action(async (opts) => {
    const params = `?limit=${opts.limit}${opts.app ? '&app=' + opts.app : ''}`;
    const data = await api('GET', `/api/audit${params}`);
    out.header('Audit Log');
    out.table(
      ['Time', 'User', 'App', 'Action', 'Detail'],
      data.entries.map(e => [
        e.created_at, e.user_name || 'system', e.app_slug || '-', e.action,
        typeof e.detail === 'string' ? (e.detail.length > 40 ? e.detail.slice(0, 40) + '...' : e.detail) : '-',
      ])
    );
  });

// ── Users ───────────────────────────
const userCmd = program.command('user').description('User management');

userCmd
  .command('list')
  .description('List users')
  .action(async () => {
    const data = await api('GET', '/api/users');
    out.header('Users');
    out.table(
      ['ID', 'Name', 'Email', 'Role', 'Apps'],
      data.users.map(u => [u.id, u.name, u.email || '-', u.role, u.assigned_apps || '-'])
    );
  });

userCmd
  .command('create')
  .description('Create user')
  .requiredOption('--name <name>', 'User name')
  .option('--email <email>', 'Email')
  .option('--username <username>', 'Username (for identity login)')
  .option('--password <password>', 'Password (for identity login)')
  .option('--role <role>', 'AppCrane role: admin or user', 'user')
  .option('--phone <phone>', 'Phone number')
  .option('--year-of-birth <year>', 'Year of birth')
  .action(async (opts) => {
    const data = await api('POST', '/api/users', {
      name: opts.name, email: opts.email, role: opts.role,
      username: opts.username, password: opts.password,
      phone: opts.phone, year_of_birth: opts.yearOfBirth ? parseInt(opts.yearOfBirth) : undefined,
    });
    out.ok(`User '${data.user.name}' created`);
    out.warn(`API Key: ${data.api_key}`);
    out.warn('Save this! It will not be shown again.');
    if (opts.password) out.ok('Password set - user can login at /login');
  });

userCmd
  .command('set-password <id>')
  .description('Set/change user password')
  .requiredOption('--password <password>', 'New password')
  .action(async (id, opts) => {
    const data = await api('PUT', `/api/users/${id}/password`, { password: opts.password });
    out.ok(data.message);
  });

userCmd
  .command('profile <id>')
  .description('Update user profile')
  .option('--name <name>')
  .option('--email <email>')
  .option('--username <username>')
  .option('--avatar <url>', 'Avatar URL')
  .option('--phone <phone>')
  .option('--year-of-birth <year>')
  .action(async (id, opts) => {
    const body = {};
    if (opts.name) body.name = opts.name;
    if (opts.email) body.email = opts.email;
    if (opts.username) body.username = opts.username;
    if (opts.avatar) body.avatar_url = opts.avatar;
    if (opts.phone) body.phone = opts.phone;
    if (opts.yearOfBirth) body.year_of_birth = parseInt(opts.yearOfBirth);
    const data = await api('PUT', `/api/users/${id}/profile`, body);
    out.ok('Profile updated');
    out.keyValue(data.user);
  });

// ── App Roles ───────────────────────
program
  .command('role <slug>')
  .description('Set per-app role for a user')
  .requiredOption('--user-id <id>', 'User ID')
  .requiredOption('--role <role>', 'App role: admin, user, or viewer')
  .action(async (slug, opts) => {
    const data = await api('PUT', `/api/apps/${slug}/roles`, { user_id: parseInt(opts.userId), app_role: opts.role });
    out.ok(data.message);
  });

userCmd
  .command('delete <id>')
  .description('Delete user')
  .action(async (id) => {
    const data = await api('DELETE', `/api/users/${id}`);
    out.ok(data.message);
  });

// ── Notifications ───────────────────
program
  .command('notify <slug>')
  .description('Configure notifications')
  .option('--email <email>', 'Notification email')
  .option('--on-deploy-success', 'Notify on deploy success')
  .option('--on-deploy-fail', 'Notify on deploy failure')
  .option('--on-app-down', 'Notify when app goes down')
  .option('--on-app-recovered', 'Notify when app recovers')
  .option('--test', 'Send test notification')
  .action(async (slug, opts) => {
    if (opts.test) {
      const data = await api('POST', `/api/apps/${slug}/notifications/test`);
      out.ok(data.message);
      return;
    }
    if (opts.email) {
      const body = {
        email: opts.email,
        on_deploy_success: !!opts.onDeploySuccess,
        on_deploy_fail: !!opts.onDeployFail,
        on_app_down: !!opts.onAppDown,
        on_app_recovered: !!opts.onAppRecovered,
      };
      const data = await api('PUT', `/api/apps/${slug}/notifications`, body);
      out.ok(data.message);
    }
    const data = await api('GET', `/api/apps/${slug}/notifications`);
    if (data.config) {
      out.header(`Notifications - ${slug}`);
      out.keyValue({
        Email: data.config.email,
        'Deploy success': data.config.on_deploy_success ? 'ON' : 'OFF',
        'Deploy fail': data.config.on_deploy_fail ? 'ON' : 'OFF',
        'App down': data.config.on_app_down ? 'ON' : 'OFF',
        'App recovered': data.config.on_app_recovered ? 'ON' : 'OFF',
      });
    } else {
      out.dim('No notifications configured. Use --email to set up.');
    }
  });

// ── Reconcile ──────────────────────────────────────────────────────────────
program
  .command('reconcile')
  .description('Register orphaned filesystem apps into AppCrane DB and reload Caddy')
  .option('--dry-run', 'Preview what would be registered without making changes')
  .action(async (opts) => {
    try {
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      const __dirname = dirname(fileURLToPath(import.meta.url));

      const { initDb } = await import(join(__dirname, '..', 'server', 'db.js'));
      initDb();

      const { reconcileOrphanedApps } = await import(join(__dirname, '..', 'server', 'services', 'reconcile.js'));

      if (opts.dryRun) {
        out.info('Dry run — no changes will be made.');
      }

      out.info('Scanning data/apps/ directory...');
      const result = await reconcileOrphanedApps({ dryRun: opts.dryRun });

      if (result.orphaned === 0) {
        out.ok('No orphaned apps found. Everything is in sync.');
        return;
      }

      if (result.registered.length > 0) {
        out.header(opts.dryRun ? `Would register ${result.registered.length} app(s)` : `Registered ${result.registered.length} app(s)`);
        for (const app of result.registered) {
          out.keyValue({
            'App': `${app.name} (${app.slug})`,
            'Slot': app.slot,
            'Prod port': app.ports.prod_be,
            'Sandbox port': app.ports.sand_be,
          });
          console.log('');
        }
      }

      if (result.skipped.length > 0) {
        out.warn(`Skipped ${result.skipped.length} app(s) due to errors:`);
        for (const s of result.skipped) {
          out.err(`  ${s.slug}: ${s.error}`);
        }
      }

      if (!opts.dryRun) {
        if (result.caddy?.success) {
          out.ok('Caddy reloaded — app routes are now active.');
        } else if (result.caddy) {
          out.warn('Caddy reload failed: ' + (result.caddy.error || 'unknown'));
          out.dim('Run: crane caddy --reload');
        }

        const hasNeedsRestart = result.registered.some(a => a.needs_restart);
        if (hasNeedsRestart) {
          out.warn('Some apps have no running container. Redeploy them from the dashboard.');
        }
      }
    } catch (e) {
      out.err(`Reconcile failed: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
