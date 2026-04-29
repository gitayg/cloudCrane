# AppCrane — Enterprise AI Applications Platform

Self-hosted deployment platform for AI applications. Run on your own server — Docker isolation, enterprise SSO, an AI code pipeline, and real-time team presence. A production-ready alternative to Railway and Coolify with enterprise features neither offers.

**CLI + REST API + Dashboard.** AI agents can use the curl API via `/agent-guide`.

## Why AppCrane

| Feature | AppCrane | Railway | Coolify |
|---|---|---|---|
| Price | Free (self-hosted) | $5–20 / app / mo | Free (self-hosted) |
| Data ownership | Your server | Railway cloud | Your server |
| Docker isolation | ✓ per app | ✓ | ✓ |
| Enterprise SSO | SAML / OIDC / SCIM | ✗ | ✗ |
| AI code pipeline | ✓ AppStudio | ✗ | ✗ |
| Real-time presence | ✓ | ✗ | ✗ |
| Dual environments | ✓ built-in | Manual | Manual |
| Zero-downtime deploy | ✓ | ✓ | Partial |
| Open source | MIT | ✗ | Apache 2 |
| Vendor lock-in | None | High | None |

## Features

- **Docker container isolation** — every app runs in its own container; no shared dependencies, no runaway processes
- **Enterprise SSO** — SAML 2.0, OIDC, and SCIM provisioning; connect to Okta, Azure AD, Google Workspace
- **AppStudio AI pipeline** — AI proposes code improvements on a schedule; you review and approve before anything ships
- **Real-time presence** — see who's active on each app, which environment, and when they last deployed
- **Dual environments** per app: production + sandbox, always-on, separate ports
- **Auto-HTTPS** via Caddy reverse proxy with Let's Encrypt
- **GitHub webhook auto-deploy** on push (HMAC-verified)
- **Zero-downtime deploys** (start new, health check, swap, drain old)
- **Rollback in seconds** (symlink-based, keeps last 5 releases)
- **Encrypted env vars** (AES-256-GCM) — admin cannot read them by design
- **Health checks** with auto-restart and email notifications
- **Audit log** for every action
- **AI-agent friendly** API at `/agent-guide` (plain markdown, all curl commands)

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/gitayg/appCrane/main/install.sh | sudo bash
```

Or manually:

```bash
# 1. Clone and install
git clone https://github.com/gitayg/appCrane.git
cd appCrane
npm install
npm link    # makes 'crane' command available globally

# 2. Install and start via systemd
cp scripts/appcrane.service /etc/systemd/system/appcrane.service
systemctl daemon-reload
systemctl enable --now appcrane

# 2.5. (Optional) Set Anthropic API key for AppStudio
# Add to the systemd unit so it survives restarts:
systemctl edit appcrane --force
# Add under [Service]: Environment="ANTHROPIC_API_KEY=sk-ant-..."
# Then: systemctl daemon-reload && systemctl restart appcrane

# 3. Initialize admin (must run on the server)
crane init --name admin --email admin@example.com

# 4. Create an app
crane app create \
  --name "MyApp" \
  --slug myapp \
  --domain myapp.example.com \
  --repo https://github.com/yourorg/myapp

# 5. Create a user and assign to the app
crane user create --name sarah --email sarah@example.com
crane app assign myapp --email sarah@example.com

# 6. Deploy
crane config --key dhk_user_the_key_from_step_5
crane deploy myapp --env sandbox
```

## CLI Reference

### Server
```bash
crane status                              # Server health: CPU, RAM, disk, apps
crane config --show                       # Show CLI config
crane config --url http://localhost:5001  # Set API URL
crane config --key dhk_admin_xxx          # Set API key
```

### Apps (admin)
```bash
crane app list
crane app create --name X --slug x --domain x.example.com --repo https://github.com/...
crane app info myapp
crane app delete myapp --confirm
crane app assign myapp --email user@example.com
```

### Deploy (app user)
```bash
crane deploy myapp --env sandbox
crane deploy myapp --env production
crane deploy:history myapp --env prod
crane deploy:log myapp --id 5
crane rollback myapp --env production
crane promote myapp                       # sandbox → production, zero downtime
```

### Env Vars (app user — admin cannot access)
```bash
crane env set myapp --env sandbox DATABASE_URL=postgres://... API_KEY=sk-test
crane env list myapp --env production
crane env list myapp --env sandbox --reveal
crane env delete myapp API_KEY --env sandbox
```

### Health, Webhooks, Backups
```bash
crane health status myapp
crane health config myapp --env prod --endpoint /api/health --interval 30
crane webhook myapp --auto-sandbox on
crane backup create myapp --env prod
crane backup list myapp
crane logs myapp --env production
crane audit --app myapp
```

## curl API (for AI agents)

```bash
curl https://crane.example.com/agent-guide
```

Returns a markdown document with every operation as a copy-paste curl command.

```bash
export CC="https://crane.example.com"
export KEY="dhk_admin_your_key"

curl -s -H "X-API-Key: $KEY" $CC/api/apps
curl -s -X POST $CC/api/apps/myapp/deploy/sandbox -H "X-API-Key: $KEY"
curl -s -H "X-API-Key: $KEY" $CC/api/server/health
```

## Architecture

```
Ubuntu Server
├── Caddy (reverse proxy, auto-HTTPS)
│   ├── myapp.example.com          → production app
│   └── myapp-sandbox.example.com  → sandbox app
├── Docker (container isolation)
│   ├── myapp-production           ← isolated container per env
│   └── myapp-sandbox
├── AppCrane API (:5001)
│   ├── Express 5 + SQLite
│   ├── Health checker (cron)
│   ├── SSO (SAML / OIDC / SCIM)
│   ├── AppStudio AI pipeline
│   └── Presence (WebSocket)
└── /data/apps/myapp/
    ├── production/releases/       (symlink-based, last 5)
    └── sandbox/releases/
```

## Security

- **Init locked to localhost** — admin setup only from the server itself
- **API key auth** — all requests require `X-API-Key` header
- **Admin isolation** — admin cannot read env vars or `/data/`; enforced at middleware level
- **AES-256-GCM** encrypted env vars at rest
- **Webhook HMAC** verification for GitHub
- **SCIM deprovisioning** — removing a user from your IdP revokes AppCrane access automatically
- **All actions audited** — who did what, when

## Permission Model

| Action | Admin | App User |
|--------|-------|----------|
| Create/delete apps | Yes | No |
| Assign users | Yes | No |
| Server health | Yes | No |
| Deploy / rollback / promote | **No** | Yes (own apps) |
| View/edit env vars | **No** | Yes (own apps) |
| Configure health/webhooks | **No** | Yes (own apps) |
| Backups | **No** | Yes (own apps) |

## Tech Stack

Node.js 20, Express 5, SQLite, Docker, Caddy 2, SAML/OIDC/SCIM, AES-256-GCM, Commander.js, Ubuntu 22.04+

## License

FSL-1.1-ALv2 (Functional Source License). Free to use, modify, and self-host. The only restriction is offering it as a competing commercial hosted service. Each release converts to Apache 2.0 two years after its release date.

## Feedback & Contributions

Open an issue: https://github.com/gitayg/appCrane/issues

Pull requests welcome.
