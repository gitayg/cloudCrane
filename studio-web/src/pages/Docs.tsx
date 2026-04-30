export function Docs() {
  return (
    <div className="docs-page">
      <style>{`
.docs-page { --code-bg: #1e2130; color: var(--text); line-height: 1.7; font-size: 15px; }
.docs-page * { box-sizing: border-box; }
.docs-page .docs-container { max-width: 900px; margin: 0 auto; padding: 24px 20px 60px; }
.docs-page h1 { font-size: 2rem; margin-bottom: 4px; color: var(--text); }
.docs-page h1 span { color: var(--accent); }
.docs-page .sub { color: var(--dim); margin-bottom: 32px; }
.docs-page h2 { font-size: 1.3rem; margin: 40px 0 12px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.docs-page h3 { font-size: 1rem; margin: 20px 0 6px; color: var(--text); }
.docs-page p, .docs-page li { color: var(--dim); margin: 4px 0; }
.docs-page ul { padding-left: 20px; }
.docs-page code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-size: .9em; font-family: 'SF Mono', Monaco, monospace; color: var(--text); }
.docs-page pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px; overflow-x: auto; margin: 8px 0; font-size: .85rem; line-height: 1.5; color: var(--text); }
.docs-page pre code { background: none; padding: 0; }
.docs-page .g { color: var(--green); }
.docs-page .y { color: var(--yellow); }
.docs-page .r { color: var(--red); }
.docs-page .d { color: var(--dim); }
.docs-page .b { color: var(--accent); }
.docs-page .warn { background: #eab30811; border: 1px solid #eab30844; border-radius: 6px; padding: 10px 14px; margin: 8px 0; font-size: .9rem; color: var(--text); }
.docs-page table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: .9rem; }
.docs-page th, .docs-page td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); color: var(--text); }
.docs-page th { color: var(--dim); font-weight: 500; }
.docs-page .docs-nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 20px; position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.docs-page .docs-nav a { color: var(--dim); text-decoration: none; font-size: .85rem; }
.docs-page .docs-nav a:hover { color: var(--accent); }
.docs-page .docs-nav .logo { font-weight: 700; color: var(--text); font-size: 1.1rem; margin-right: 12px; }
.docs-page .docs-footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--dim); font-size: .85rem; }
.docs-page .docs-footer a { color: var(--accent); text-decoration: none; }
.docs-page .docs-footer a:hover { text-decoration: underline; }
      `}</style>

      <nav className="docs-nav">
        <span className="logo">App<span style={{ color: 'var(--accent)' }}>Crane</span></span>
        <a href="#setup">Setup</a>
        <a href="#auth">Auth</a>
        <a href="#apps">Apps</a>
        <a href="#users">Users</a>
        <a href="#deploy">Deploy</a>
        <a href="#env">Env Vars</a>
        <a href="#health">Health</a>
        <a href="#webhook">Webhooks</a>
        <a href="#backup">Backups</a>
        <a href="#logs">Logs</a>
        <a href="#notify">Notifications</a>
        <a href="#server">Server</a>
        <a href="#manifest">Manifest</a>
        <a href="#permissions">Permissions</a>
      </nav>

      <div className="docs-container">

        <h1>App<span>Crane</span> API Reference</h1>
        <p className="sub">
          AI-powered app builder — ship and manage apps without DevOps.<br />
          All operations available via curl. No client installation required.<br />
          Base URL: <code>https://crane.example.com</code> (or <code>http://localhost:5001</code> for local)
        </p>

        <h2 id="setup">Setup</h2>

        <h3>1. Install</h3>
        <pre><code>{`git clone https://github.com/gitayg/appCrane.git
cd appCrane
npm install
npm link    `}<span className="d"># makes 'crane' command available globally</span></code></pre>

        <h3>2. Initialize admin (on server only, direct DB access)</h3>
        <pre><code>{`crane init --name admin --email admin@example.com
`}<span className="d"># ✓ AppCrane initialized!</span>{`
`}<span className="d"># API Key: dhk_admin_abc123...</span>{`
`}<span className="d"># ✓ API key auto-saved to ~/.appcrane/config.json</span></code></pre>

        <h3>3. Start the server</h3>
        <pre><code>{`npx pm2 start server/index.js --name appcrane
`}<span className="d"># AppCrane running on :5001</span></code></pre>

        <h3>4. Set your API key for curl requests</h3>
        <pre><code><span className="d"># For curl/AI agent access (crane CLI auto-saves the key)</span>{`
export CC="https://crane.example.com"
export KEY="dhk_admin_your_key_here"`}</code></pre>

        <h2 id="auth">Authentication</h2>
        <p>All API requests require the <code>X-API-Key</code> header (except <code>/api/info</code> and webhook endpoints).</p>
        <div className="warn"><strong>Init is CLI-only:</strong> Run <code>crane init</code> on the server. There is no API endpoint for initialization.</div>

        <h3>GET /api/auth/me - Current user info</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/auth/me`}</code></pre>

        <h2 id="apps">App Management</h2>
        <p>Apps are managed by <span className="y">admin</span> users. Each app gets two environments (production + sandbox), four ports, and its own process isolation.</p>

        <h3>GET /api/apps - List all apps</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps | jq '.apps[] | {slug,name,domain}'`}</code></pre>

        <h3>POST /api/apps - Create app <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps \\
  -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "MyApp",
    "slug": "myapp",
    "domain": "myapp.example.com",
    "source_type": "github",
    "github_url": "https://github.com/yourorg/myapp",
    "branch": "main",
    "max_ram_mb": 512,
    "max_cpu_percent": 50
  }'

`}<span className="d"># Response includes: app details, allocated ports, webhook URL</span></code></pre>

        <h3>GET /api/apps/:slug - App details</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp`}</code></pre>

        <h3>PUT /api/apps/:slug - Update app <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp \\
  -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"domain":"newdomain.example.com","branch":"develop"}'`}</code></pre>

        <h3>DELETE /api/apps/:slug?confirm=true - Delete app <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X DELETE "$CC/api/apps/myapp?confirm=true" \\
  -H "X-API-Key: $KEY"`}</code></pre>

        <h3>PUT /api/apps/:slug/users - Assign users to app <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp/users \\
  -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_emails":["sarah@example.com","dev@example.com"]}'`}</code></pre>

        <h2 id="users">User Management</h2>
        <p>Only <span className="y">admin</span> can manage users. Users get API keys for authentication.</p>

        <h3>GET /api/users - List users <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/users`}</code></pre>

        <h3>POST /api/users - Create user <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/users \\
  -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"sarah","email":"sarah@example.com","role":"user"}'

`}<span className="d"># Response: {`{ "api_key": "dhk_user_xyz...", "warning": "Save this key!" }`}</span></code></pre>

        <h3>DELETE /api/users/:id - Delete user <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X DELETE $CC/api/users/2 -H "X-API-Key: $KEY"`}</code></pre>

        <h3>POST /api/users/:id/regenerate-key - New API key <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/users/2/regenerate-key -H "X-API-Key: $KEY"`}</code></pre>

        <h2 id="deploy">Deployment</h2>
        <p>Deploy operations require <span className="b">app user</span> role (NOT admin). Admin cannot deploy.</p>

        <h3>POST /api/apps/:slug/deploy/:env - Deploy <span className="b">(app user)</span></h3>
        <pre><code><span className="d"># Deploy to sandbox</span>{`
curl -s -X POST $CC/api/apps/myapp/deploy/sandbox \\
  -H "X-API-Key: $USER_KEY"

`}<span className="d"># Deploy to production</span>{`
curl -s -X POST $CC/api/apps/myapp/deploy/production \\
  -H "X-API-Key: $USER_KEY"

`}<span className="d"># Response: {`{ "deployment": { "id": 1, "status": "pending" } }`}</span></code></pre>

        <h3>GET /api/apps/:slug/deployments/:env - Deploy history</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/deployments/production`}</code></pre>

        <h3>GET /api/apps/:slug/deployments/:env/:id/log - Deploy build log</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/deployments/sandbox/1/log`}</code></pre>

        <h3>POST /api/apps/:slug/rollback/:env - Rollback <span className="b">(app user)</span></h3>
        <pre><code><span className="d"># Rollback to previous version</span>{`
curl -s -X POST $CC/api/apps/myapp/rollback/production \\
  -H "X-API-Key: $USER_KEY"

`}<span className="d"># Rollback to specific deployment ID</span>{`
curl -s -X POST $CC/api/apps/myapp/rollback/production \\
  -H "X-API-Key: $USER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"deployment_id": 3}'`}</code></pre>

        <h3>POST /api/apps/:slug/promote - Promote sandbox to production <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/promote \\
  -H "X-API-Key: $USER_KEY"

`}<span className="d"># Copies CODE only from sandbox to production.</span>{`
`}<span className="d"># Does NOT copy .env or /data/ (production keeps its own).</span></code></pre>

        <h2 id="env">Environment Variables</h2>
        <p><span className="r">Admin CANNOT access env vars.</span> Only <span className="b">app users</span> can view/edit env vars. Values are encrypted at rest (AES-256-GCM).</p>

        <h3>GET /api/apps/:slug/env/:env - List env vars <span className="b">(app user)</span></h3>
        <pre><code><span className="d"># Values masked by default</span>{`
curl -s -H "X-API-Key: $USER_KEY" $CC/api/apps/myapp/env/production

`}<span className="d"># Reveal actual values</span>{`
curl -s -H "X-API-Key: $USER_KEY" "$CC/api/apps/myapp/env/production?reveal=true"`}</code></pre>

        <h3>PUT /api/apps/:slug/env/:env - Set env vars (bulk) <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp/env/sandbox \\
  -H "X-API-Key: $USER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "vars": {
      "DATABASE_URL": "postgres://user:pass@db:5432/myapp",
      "API_KEY": "sk-test-abc123",
      "NODE_ENV": "development"
    }
  }'`}</code></pre>

        <h3>DELETE /api/apps/:slug/env/:env/:key - Delete env var <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X DELETE $CC/api/apps/myapp/env/sandbox/API_KEY \\
  -H "X-API-Key: $USER_KEY"`}</code></pre>

        <div className="warn">
          <strong>Safety:</strong> When sandbox DATABASE_URL matches production, the API returns a warning. Always use different database URLs per environment.
        </div>

        <h2 id="health">Health Checks</h2>
        <p>AppCrane pings each app's health endpoint periodically. After <code>fail_threshold</code> consecutive failures, it auto-restarts the app via PM2. After <code>down_threshold</code> failures, it marks the app as DOWN and sends email notification.</p>

        <h3>GET /api/apps/:slug/health/:env - Health config + state</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/health/production`}</code></pre>

        <h3>PUT /api/apps/:slug/health/:env - Configure health check <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp/health/production \\
  -H "X-API-Key: $USER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "endpoint": "/api/health",
    "interval_sec": 30,
    "fail_threshold": 3,
    "down_threshold": 5
  }'`}</code></pre>

        <h3>POST /api/apps/:slug/health/:env/test - Test health now</h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/health/production/test \\
  -H "X-API-Key: $KEY"

`}<span className="d"># Response: {`{ "url": "http://localhost:4001/api/health", "status": 200, "response_ms": 45, "healthy": true }`}</span></code></pre>

        <h2 id="webhook">Webhooks</h2>
        <p>Each app has a webhook URL. Add it to your GitHub repository settings to trigger auto-deploy on push.</p>

        <h3>GET /api/apps/:slug/webhook - Get webhook config</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/webhook

`}<span className="d"># Response: {`{ "webhook_url": "https://crane.example.com/api/webhooks/abc123", "auto_deploy_sandbox": true, "auto_deploy_prod": false }`}</span></code></pre>

        <h3>PUT /api/apps/:slug/webhook - Configure auto-deploy <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp/webhook \\
  -H "X-API-Key: $USER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "auto_deploy_sandbox": true,
    "auto_deploy_prod": false,
    "branch_filter": "main"
  }'`}</code></pre>

        <h3>POST /api/webhooks/:token - GitHub webhook receiver (public, HMAC verified)</h3>
        <pre><code><span className="d"># This URL is called by GitHub, not by you.</span>{`
`}<span className="d">{`# Add the webhook_url to GitHub repo Settings > Webhooks.`}</span>{`
`}<span className="d"># Set content type to application/json.</span>{`
`}<span className="d"># Set secret to the webhook secret (shown at app creation).</span></code></pre>

        <h2 id="backup">Backups</h2>
        <p>Backups archive the <code>/data/</code> directory of an app environment as a .tar.gz file.</p>

        <h3>POST /api/apps/:slug/backup/:env - Create backup <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/backup/production \\
  -H "X-API-Key: $USER_KEY"`}</code></pre>

        <h3>GET /api/apps/:slug/backups - List backups</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/backups`}</code></pre>

        <h3>POST /api/apps/:slug/restore/:id - Restore backup <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/restore/3 \\
  -H "X-API-Key: $USER_KEY"

`}<span className="d"># WARNING: Stops the app, overwrites /data/, restarts.</span></code></pre>

        <h3>POST /api/apps/:slug/copy-data - Copy production data to sandbox <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/copy-data \\
  -H "X-API-Key: $USER_KEY"`}</code></pre>

        <h2 id="logs">Logs &amp; Audit</h2>

        <h3>GET /api/apps/:slug/logs/:env - App runtime logs (PM2)</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" "$CC/api/apps/myapp/logs/production?lines=100"`}</code></pre>

        <h3>GET /api/audit - Global audit log <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" "$CC/api/audit?limit=20"

`}<span className="d"># Filter by app</span>{`
curl -s -H "X-API-Key: $KEY" "$CC/api/audit?limit=20&app=myapp"`}</code></pre>

        <h3>GET /api/apps/:slug/audit - Per-app audit log</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" "$CC/api/apps/myapp/audit?limit=20"`}</code></pre>

        <h2 id="notify">Notifications</h2>

        <h3>GET /api/apps/:slug/notifications - Get notification config</h3>
        <pre><code>{`curl -s -H "X-API-Key: $USER_KEY" $CC/api/apps/myapp/notifications`}</code></pre>

        <h3>PUT /api/apps/:slug/notifications - Configure notifications <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X PUT $CC/api/apps/myapp/notifications \\
  -H "X-API-Key: $USER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "sarah@example.com",
    "on_deploy_success": true,
    "on_deploy_fail": true,
    "on_app_down": true,
    "on_app_recovered": true
  }'`}</code></pre>

        <h3>POST /api/apps/:slug/notifications/test - Send test email <span className="b">(app user)</span></h3>
        <pre><code>{`curl -s -X POST $CC/api/apps/myapp/notifications/test \\
  -H "X-API-Key: $USER_KEY"`}</code></pre>

        <h2 id="server">Server Health</h2>

        <h3>GET /api/server/health - Server overview <span className="y">(admin)</span></h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/server/health

`}<span className="d"># Response includes:</span>{`
`}<span className="d"># - system: cpu (percent, cores), memory (total, used, free), disk (total, used, free)</span>{`
`}<span className="d">{`# - apps: { total, environments, healthy, down }`}</span>{`
`}<span className="d"># - recent_deploys: last 10 deployments across all apps</span>{`
`}<span className="d"># - recent_audit: last 20 audit log entries</span></code></pre>

        <h3>GET /api/apps/:slug/metrics/:env - Per-app metrics</h3>
        <pre><code>{`curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/metrics/production

`}<span className="d"># Response: {`{ ports, process: { status, cpu, memory, uptime }, health, recent_deploys }`}</span></code></pre>

        <h2 id="manifest">deployhub.json Manifest</h2>
        <p>Required in each managed app's root directory. AppCrane reads this to know how to build and start the app.</p>

        <pre><code>{`{
  "name": "MyApp",
  "version": "1.0.0",
  "fe": {
    "build": "npm run build",
    "serve": "npx serve -s dist"
  },
  "be": {
    "entry": "node server.js",
    "health": "/api/health"
  },
  "data_dirs": ["data/", "uploads/"],
  "env_example": ".env.example"
}`}</code></pre>

        <table>
          <thead>
            <tr><th>Field</th><th>Required</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td><code>name</code></td><td>Yes</td><td>Display name of the app</td></tr>
            <tr><td><code>version</code></td><td>Yes</td><td>Semantic version (displayed in dashboard and deploy history)</td></tr>
            <tr><td><code>fe.build</code></td><td>No</td><td>Command to build frontend (e.g., <code>npm run build</code>)</td></tr>
            <tr><td><code>fe.serve</code></td><td>No</td><td>Command to serve built frontend</td></tr>
            <tr><td><code>be.entry</code></td><td>Yes</td><td>Command to start backend server</td></tr>
            <tr><td><code>be.health</code></td><td>No</td><td>Default health check endpoint path</td></tr>
            <tr><td><code>data_dirs</code></td><td>No</td><td>Directories persisted across deploys and included in backups</td></tr>
            <tr><td><code>env_example</code></td><td>No</td><td>Path to .env example file</td></tr>
          </tbody>
        </table>

        <h2 id="permissions">Permission Model</h2>

        <table>
          <thead>
            <tr><th>Action</th><th><span className="y">Admin</span></th><th><span className="b">App User</span></th></tr>
          </thead>
          <tbody>
            <tr><td>Create/delete apps</td><td>Yes</td><td>No</td></tr>
            <tr><td>Assign users to apps</td><td>Yes</td><td>No</td></tr>
            <tr><td>Create/delete users</td><td>Yes</td><td>No</td></tr>
            <tr><td>View app status/info</td><td>All apps</td><td>Own apps only</td></tr>
            <tr><td>View server health</td><td>Yes</td><td>No</td></tr>
            <tr><td>Deploy / rollback / promote</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>View/edit .env files</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>View/edit /data/ files</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>Configure health checks</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>Configure webhooks</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>Create/restore backups</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>Configure notifications</td><td><span className="r">No</span></td><td>Yes (own apps)</td></tr>
            <tr><td>View audit log</td><td>All apps</td><td>Own apps only</td></tr>
          </tbody>
        </table>

        <div className="warn">
          <strong>Key security rule:</strong> Admin manages infrastructure (create apps, assign users, set limits). App users manage their own apps (deploy, env vars, data, health). Admin can NEVER access .env or /data/ of any app.
        </div>

        <h2>Domain Routing</h2>
        <p>Each app gets two domains. Caddy handles HTTPS and routes traffic automatically. Internal ports are managed by AppCrane -- users never need to know or access them.</p>
        <table>
          <thead>
            <tr><th>Environment</th><th>URL pattern</th></tr>
          </thead>
          <tbody>
            <tr><td>Production</td><td><code>https://appslug.example.com</code></td></tr>
            <tr><td>Sandbox</td><td><code>https://appslug-sandbox.example.com</code></td></tr>
          </tbody>
        </table>

        <h2>Common Workflows</h2>

        <h3>Full deployment lifecycle</h3>
        <pre><code><span className="d"># 1. Admin creates app and assigns user</span>{`
curl -s -X POST $CC/api/apps -H "X-API-Key: $ADMIN_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"MyApp","slug":"myapp","domain":"myapp.example.com","source_type":"github","github_url":"https://github.com/yourorg/myapp"}'

curl -s -X PUT $CC/api/apps/myapp/users -H "X-API-Key: $ADMIN_KEY" -H "Content-Type: application/json" \\
  -d '{"user_emails":["sarah@example.com"]}'

`}<span className="d"># 2. User sets env vars for sandbox</span>{`
curl -s -X PUT $CC/api/apps/myapp/env/sandbox -H "X-API-Key: $USER_KEY" -H "Content-Type: application/json" \\
  -d '{"vars":{"DATABASE_URL":"postgres://test:5432/myapp_test","NODE_ENV":"development"}}'

`}<span className="d"># 3. User deploys to sandbox</span>{`
curl -s -X POST $CC/api/apps/myapp/deploy/sandbox -H "X-API-Key: $USER_KEY"

`}<span className="d"># 4. User tests health</span>{`
curl -s -X POST $CC/api/apps/myapp/health/sandbox/test -H "X-API-Key: $USER_KEY"

`}<span className="d"># 5. User sets production env vars</span>{`
curl -s -X PUT $CC/api/apps/myapp/env/production -H "X-API-Key: $USER_KEY" -H "Content-Type: application/json" \\
  -d '{"vars":{"DATABASE_URL":"postgres://prod:5432/myapp","NODE_ENV":"production"}}'

`}<span className="d"># 6. User promotes sandbox to production</span>{`
curl -s -X POST $CC/api/apps/myapp/promote -H "X-API-Key: $USER_KEY"

`}<span className="d"># 7. If something goes wrong, rollback</span>{`
curl -s -X POST $CC/api/apps/myapp/rollback/production -H "X-API-Key: $USER_KEY"`}</code></pre>

        <h3>Set up webhook auto-deploy</h3>
        <pre><code><span className="d"># 1. Get webhook URL</span>{`
curl -s -H "X-API-Key: $USER_KEY" $CC/api/apps/myapp/webhook

`}<span className="d"># 2. Enable auto-deploy for sandbox</span>{`
curl -s -X PUT $CC/api/apps/myapp/webhook -H "X-API-Key: $USER_KEY" -H "Content-Type: application/json" \\
  -d '{"auto_deploy_sandbox":true,"auto_deploy_prod":false,"branch_filter":"main"}'

`}<span className="d">{`# 3. Add the webhook URL to GitHub: Settings > Webhooks > Add webhook`}</span>{`
`}<span className="d">#    Payload URL: the webhook_url from step 1</span>{`
`}<span className="d">#    Content type: application/json</span>{`
`}<span className="d">#    Events: Just the push event</span></code></pre>

        <h2>Architecture</h2>
        <pre><code>{`Ubuntu Server
├── Caddy (reverse proxy, auto-HTTPS)
│   ├── myapp.example.com          → localhost:3001 (prod FE) + :4001 (prod BE)
│   └── myapp-sandbox.example.com  → localhost:3002 (sand FE) + :4002 (sand BE)
├── PM2 (process manager)
│   ├── myapp-production (FE + BE processes)
│   └── myapp-sandbox   (FE + BE processes)
├── AppCrane API (:5001)
│   ├── Express 5 + SQLite
│   ├── Health checker (cron)
│   └── Email notifications
└── /data/apps/myapp/
    ├── production/
    │   ├── releases/       (last 5 deploys, symlink-based)
    │   ├── current → releases/latest/
    │   └── shared/
    │       ├── .env.production
    │       └── data/       (persistent app data)
    └── sandbox/
        ├── releases/
        ├── current → releases/latest/
        └── shared/
            ├── .env.sandbox
            └── data/`}</code></pre>

        <h2 id="https">HTTPS with Caddy</h2>
        <p>AppCrane runs on HTTP (:5001). Use <a href="https://caddyserver.com" style={{ color: 'var(--accent)' }}>Caddy</a> as a reverse proxy for automatic HTTPS with Let's Encrypt certificates.</p>

        <h3>1. Install Caddy</h3>
        <pre><code>{`apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy`}</code></pre>

        <h3>2. Configure DNS</h3>
        <p>Add these A records at your domain registrar, all pointing to your server IP:</p>
        <pre><code><span className="d"># Required</span>{`
crane.example.com    → YOUR_SERVER_IP   `}<span className="d"># AppCrane dashboard + API</span>{`

`}<span className="d"># Per app (production + sandbox)</span>{`
myapp.example.com      → YOUR_SERVER_IP   `}<span className="d"># MyApp production</span>{`
myapp-sandbox.example.com → YOUR_SERVER_IP `}<span className="d"># MyApp sandbox</span>{`

`}<span className="d"># Or use a wildcard for all subdomains</span>{`
*.example.com         → YOUR_SERVER_IP   `}<span className="d"># Covers all current and future apps</span></code></pre>

        <h3>3. Create Caddyfile</h3>
        <pre><code><span className="d"># /etc/caddy/Caddyfile</span>{`

`}<span className="d"># AppCrane dashboard + API</span>{`
crane.example.com {
    reverse_proxy localhost:5001
}

`}<span className="d"># MyApp production</span>{`
myapp.example.com {
    handle /api/* {
        reverse_proxy localhost:4001
    }
    reverse_proxy localhost:3001
}

`}<span className="d"># MyApp sandbox</span>{`
myapp-sandbox.example.com {
    handle /api/* {
        reverse_proxy localhost:4002
    }
    reverse_proxy localhost:3002
}`}</code></pre>

        <h3>4. Start Caddy</h3>
        <pre><code>{`systemctl restart caddy
systemctl enable caddy    `}<span className="d"># start on boot</span>{`

`}<span className="d"># Check status</span>{`
systemctl status caddy
`}<span className="d"># Caddy auto-provisions Let's Encrypt certificates. No config needed.</span></code></pre>

        <h3>5. Verify</h3>
        <pre><code><span className="d"># Should return AppCrane info over HTTPS</span>{`
curl -s https://crane.example.com/api/info

`}<span className="d"># Update your CLI to use HTTPS</span>{`
crane config --url https://crane.example.com

`}<span className="d"># Update AI agent guide base URL</span>{`
export CC="https://crane.example.com"`}</code></pre>

        <h3>Adding new apps</h3>
        <p>When you create a new app in AppCrane, add its domains to the Caddyfile:</p>
        <pre><code><span className="d"># For a new app with slug "myapp" on slot 2 (ports 3003/4003/3004/4004)</span>{`
myapp.example.com {
    handle /api/* {
        reverse_proxy localhost:4003
    }
    reverse_proxy localhost:3003
}

myapp-sandbox.example.com {
    handle /api/* {
        reverse_proxy localhost:4004
    }
    reverse_proxy localhost:3004
}
`}</code></pre>
        <pre><code><span className="d"># Then reload Caddy (zero downtime)</span>{`
systemctl reload caddy`}</code></pre>

        <div className="warn">
          <strong>Firewall:</strong> Make sure ports 80 and 443 are open for Caddy. Port 5001 can then be closed to external traffic since Caddy proxies it.<br />
          <code>ufw allow 80 &amp;&amp; ufw allow 443 &amp;&amp; ufw deny 5001</code>
        </div>

        <div className="docs-footer">
          AppCrane | <a href="/dashboard">Dashboard</a> | <a href="https://github.com/gitayg/appCrane" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>

      </div>
    </div>
  )
}
