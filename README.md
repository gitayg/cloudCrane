# AppCrane

**Self-hosted PaaS where the agent is the operator and the platform keeps the receipts.**

[![GitHub stars](https://img.shields.io/github/stars/gitayg/appCrane?style=flat)](https://github.com/gitayg/appCrane/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Platform: Ubuntu 22.04+](https://img.shields.io/badge/platform-Ubuntu%2022.04%2B-e95420)

AppCrane runs the internal apps your team builds with Claude Code or Cursor, on a server you own. An agent creates the app, deploys it, reads the logs and rolls it back through 57 MCP tools — no browser, no curl — while the platform enforces SSO and per-app roles, records every action against the actor that took it (tagged **agent** or **human**), and keeps app secrets out of reach of the person administering the box.

It is for teams that have to self-host — data residency, a customer contract, an internal-only network — and still have to answer *who deployed this, what was in it, and can we undo it?*

## What is actually uncommon here

Self-hosted PaaS caught up on governance during 2026. Coolify shipped structured audit logging and first-class OIDC; Dokploy shipped SSO, SCIM, custom roles and audit logs. Komodo has had [granular per-resource permissions](https://komo.do/docs/configuration/permissioning) and a full audit trail for longer than either. Most of what used to be a differentiator here no longer is, and the claims below are the ones that survived checking their docs. Four things still stand out:

**1. Governance is in the open-source build, not behind a license key.** SAML 2.0, OIDC, SCIM provisioning, per-app roles and the audit log are all in the AGPL-3.0 build with nothing to activate. Dokploy ships the same category of capability as [Enterprise](https://docs.dokploy.com/docs/core/enterprise), gated on a license key. Coolify's are free, but its changelog lists OIDC and audit logging without SAML or SCIM. Komodo's are free too — GPL-3.0, with per-resource permissions and an audit trail in the box — but its [documented sign-on](https://komo.do/docs/intro) is username/password and OAuth (GitHub, Google, generic OIDC), with no SAML or SCIM in the docs. So the free-versus-paid line is really only Dokploy's; against Coolify and Komodo the difference is which enterprise-directory protocols are covered, not what you have to pay to turn them on.

**2. The built-in agent interface can change things.** Coolify's instance-level MCP server is deliberately **read-only** — ten list/get tools. AppCrane's 57 include `appcrane_deploy`, `appcrane_rollback`, `appcrane_promote`, `appcrane_set_secret` and `appcrane_grant_app_access`. Dokploy's official MCP package is write-capable too, and far larger (508 tools across 49 categories) — AppCrane's surface is smaller by choice, not by capability, and is paired with `appcrane_get_guide(topic="onboarding"|"operations")`, which serves the current playbook from the server so the agent reads the procedure instead of inferring it from a tool list. Komodo ships no MCP server of its own; neither its [repo](https://github.com/moghtech/komodo) nor its docs contain one, and the several that exist are third-party wrappers over its REST API.

**3. The audit log tells an agent from a person.** Every row carries `actor_kind`, so "what did the agents do on this box last week" is one query. The others record a user identity — Komodo's trail records "who made it and when" ([intro](https://komo.do/docs/intro)) — but none of their docs describe separating automated actors from humans.

**4. The operator is locked out of app secrets.** Env-var access follows app assignment, and that holds for `platform_admin` as well — the role that installs and updates the platform cannot read the plaintext of an app it is not assigned to. Reveals are throttled and audited across both doors, HTTP and MCP, so switching transport does not buy a fresh allowance. Komodo documents the opposite arrangement explicitly: marking a variable secret prevents access to the value for [non-admin users](https://komo.do/docs/configuration/variables), which is to say an admin can read it.

Four more that are unusual but worth measuring against your own requirements rather than reading as headlines: **per-tenant data isolation** for deployed apps; repo-less uploads identified by a **server-side SHA-256 over the received bytes** instead of a self-reported commit SHA; a **daily vulnerability digest** mailed per recipient — fleet-wide to a platform admin, own-apps-only to an app owner, so the digest cannot leak which other apps are exposed; and **managed repos**, so an agent can create and ship an app for someone who has no GitHub account at all.

Versus vendor-hosted governed platforms (Replit, Lovable, Retool, Superblocks), the trade is the usual one: their governance is more mature, and your app data, database connections and API keys live on their infrastructure.

### Against self-hosted PaaS

| | AppCrane | Coolify | Dokploy | Komodo | CapRover / Dokku |
|---|---|---|---|---|---|
| Multi-host / fleet deploys | **no — single host** | yes (experimental) | yes, remote servers | yes, agent per host | Swarm cluster (CapRover) |
| Built-in MCP that can deploy | 57 tools, incl. rollback | 10 tools, **read-only** | 508 tools (official package), incl. rollback | community projects only | community projects only |
| SAML 2.0 | yes | not in changelog | Enterprise | not documented | no |
| OIDC | yes | yes (v4.4-rc.1) | Enterprise | yes, generic OIDC | no |
| SCIM provisioning | yes | not in changelog | Enterprise | not documented | no |
| Audit log | yes, agent vs human attributed | yes, structured (v4.1.0) | Enterprise | yes, full change trail | no |
| Governance behind a paid tier | no | no | yes | no | n/a |
| Operator cannot read app secrets | yes | not documented | not documented | **no — admins can** | no |
| Per-tenant data isolation for apps | yes | not documented | not documented | not documented | no |
| Deploy identity for repo-less uploads | server-side SHA-256 | not documented | not documented | not documented | no |
| Core license | AGPL-3.0 | Apache-2.0 | Apache-2.0 + paid Enterprise | GPL-3.0 | open source |

The first row is the one AppCrane loses outright. [Komodo](https://github.com/moghtech/komodo) is built around fleet management: a Core web server plus a stateless [Periphery agent](https://komo.do/docs/setup/connect-servers) on every connected machine, with "no limit to the number of servers you can connect", Docker Swarm management, and declarative resource sync from a git repo. AppCrane has no agent, no host registry and no remote-execution path — it deploys containers on the machine it is installed on, and that is the whole design. [Coolify](https://coolify.io/docs/knowledge-base/server/multiple-servers) and [Dokploy](https://docs.dokploy.com/docs/core/remote-servers) both reach other servers too, and [CapRover](https://caprover.com/docs/app-scaling-and-cluster.html) joins nodes through Docker Swarm.

CapRover and Dokku are in one column because their access model is the same shape: a single admin account (CapRover) or SSH keys where the word `admin` in a key name grants key-management rights (Dokku), with multi-user access an [explicitly out-of-scope](https://github.com/caprover/caprover/discussions/1315) request in one and an unaudited community plugin in the other. That is a reasonable design for a one-operator box; it is not something to put an IdP in front of.

> Checked against each project's own documentation and changelog in September 2026. **"not documented"** means the capability does not appear in their docs — that is not proof it is absent, and a vendor page is a claim, not a test. Verify anything load-bearing on your own install.

**Honest scope.** Coolify has a far larger template marketplace, a much bigger community, and multi-server orchestration; if you want one-click Postgres and hundreds of app templates, use Coolify. Dokploy's API surface is broader than AppCrane's and it sells support with an SLA. Komodo is the better choice the moment the answer involves more than one machine — a fleet of hosts, a Swarm, builds farmed out to spot instances, configuration synced declaratively from git; AppCrane deploys to the box it runs on and nowhere else, so a multi-host estate is not a smaller version of this, it is a different product. Dokku and CapRover are simpler and lighter if one person operates the box. Choose AppCrane when the apps are agent-built, the agent should do the deploying, everything lands on one server you own, and someone will later ask you to prove who did what.

**Why it matters now.** Three things changed in 2026:

- **The bottleneck moved from writing software to operating it.** In Anthropic's [Claude Code study](https://www.anthropic.com/research/claude-code-expertise) (~400k sessions), "operating software" — deploying, configuring, running pipelines — grew from 14% to 21% of sessions while fixing broken code fell from 33% to 19%. Non-engineers now ship deployable code within 7 points of professional engineers. The scarce thing isn't the app any more; it's somewhere safe to run it.
- **Shadow AI became measurable.** The [2026 Verizon DBIR](https://www.verizon.com/business/resources/reports/dbir/) reports shadow-AI detections up 4×, AI use on corporate devices rising 15% → 45% in a year with 67% through non-corporate accounts — and source code as the most commonly submitted data type. Bans make it worse; a sanctioned platform is the answer that works.
- **Governance-by-console is the failure mode.** Platforms that gate every app behind a human clicking through an approval UI stall once there are hundreds of apps. AppCrane's answer is different in kind: the **agent** drives the governed lifecycle over MCP, and the platform records and constrains it — rather than a person mediating each step.

## Features

- **Docker container isolation** — every app runs in its own container; no shared dependencies, no runaway processes
- **Enterprise SSO** — SAML 2.0, OIDC, and SCIM provisioning; connect to Okta, Azure AD, Google Workspace
- **Identity forwarded to apps as headers** — `X-AppCrane-User-Role`, `X-AppCrane-App-Role`, etc. are injected by the proxy after `forward_auth` verifies the user; deployed apps read identity directly off the request without a callback (oauth2-proxy / IAP pattern)
- **`/api/me` endpoint** — canonical "who is the caller" for proxied apps; accepts the `cc_token` cookie, Bearer, or `X-API-Key`; returns global role + per-app role (`?app=<slug>` or `Referer`-inferred)
- **Headless app type** — set `auth_mode: 'headless'` to bypass `forward_auth` entirely on an app; right tool for telemetry ingest, public webhooks, status pages, and single-purpose unauthenticated services
- **TCP (layer-4) ingress** — for apps that aren't HTTP at all (a forward/CONNECT proxy hands back a raw tunnel no reverse proxy can express), a platform admin can publish the container's port directly on the host, with Caddy out of the path. No SSO, no identity headers, no TLS from AppCrane — the app owns authentication completely
- **Dual-plane apps** — `ingress_type: 'dual'` for an app that is both: an HTTP **control plane** still served through Caddy on container port 3000 with every control intact, plus a raw **data plane** on a different port inside the same container, published at `0.0.0.0:<public_port>`. The data-plane port may not be 3000 — that would republish the control plane unauthenticated — and health checks keep probing the control plane, the only plane that can actually answer
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
- **MCP server** at `/api/mcp` exposing 57 `appcrane_*` tools — agents operate the platform without ever touching curl, gh, or shell

## Quick Start

**One command** on a fresh Ubuntu server installs and wires up *everything* — Node,
Caddy (with automatic HTTPS), Docker, the systemd service, an encrypted-secrets key,
and your admin user:

```bash
curl -fsSL https://raw.githubusercontent.com/gitayg/appCrane/main/install.sh | sudo bash
```

It prompts for just two things — your **domain** and **admin email** — and is safe to
re-run. When it finishes, point your domain's DNS at the server and you're live.

**Prerequisites:** a fresh Ubuntu server (root / sudo) and a domain whose DNS `A`
record points at it — Caddy provisions TLS automatically on first request.

**Non-interactive** (CI / automation) — no prompts:

```bash
sudo CRANE_DOMAIN=crane.example.com ADMIN_EMAIL=admin@example.com bash install.sh
# flags also work: --domain / --admin-email / --admin-name / --tls-cert / --tls-key
```

<details>
<summary><b>What the installer sets up — and why installing by hand isn't recommended</b></summary>

Everything below is done for you, idempotently, by the one command above:

- **Node.js 22** + AppCrane, with the `crane` CLI linked globally
- **Caddy** — the reverse proxy that routes `<domain>/<slug>` to each app, runs the
  SSO auth, injects the `X-AppCrane-*` identity headers, and auto-provisions TLS —
  **plus** the group, file permissions, and a `sudoers` rule so AppCrane can reload
  Caddy on every deploy
- **Docker** + a **systemd** `appcrane` service (`Restart=always` — survives crashes
  and reboots, and powers one-click self-update)
- A `.env` with a freshly generated `ENCRYPTION_KEY` — **back this up; losing it makes
  every stored secret unrecoverable** — and your admin user (`crane init`)

Installing by hand means reproducing all of that — **especially the Caddy install +
permissions + sudoers**, which is the most-missed step and later surfaces as
permission errors or apps that never receive their identity headers. If you must,
treat [`install.sh`](install.sh) as the source of truth rather than a shortened list.

> **AppStudio (optional):** to enable AI app-building, set an Anthropic API key —
> `systemctl edit appcrane --force`, add `Environment="ANTHROPIC_API_KEY=sk-ant-..."`
> under `[Service]`, then `systemctl daemon-reload && systemctl restart appcrane`.

</details>

### Deploy your first app

The installer already created your admin user, so once DNS points at the box:

```bash
# Reachable at https://<your-domain>/myapp
crane app create --name "MyApp" --slug myapp --repo https://github.com/yourorg/myapp
crane deploy myapp --env sandbox

# Give a teammate access (optional)
crane user create --name sarah --email sarah@example.com
crane app assign myapp --email sarah@example.com
```

## CLI Reference

### Server
```bash
crane status                              # Server health: CPU, RAM, disk, apps
crane config --show                       # Show CLI config
crane config --url http://localhost:5001  # Set API URL
crane config --key dhk_admin_xxx          # Set API key

# Recover a lost platform-owner API key (run on the box, direct DB).
# Defaults to the platform_admin; override to target a specific account:
crane regenerate-key                      # Regenerate the platform owner's key
crane regenerate-key --email you@ex.com   # ...for a specific user by email
crane regenerate-key --user-id 1          # ...or by user id
```

### Migrate config between instances
Move the platform `settings` (including encrypted secrets) to another AppCrane —
without sharing encryption keys. Export keeps secrets ciphertext; import
re-encrypts them with the target instance's own key.
```bash
# On the SOURCE instance:
crane config export --out config.json

# Copy config.json to the TARGET, then on the TARGET:
OLD_ENCRYPTION_KEY=<source ENCRYPTION_KEY> crane config import config.json
```
The source `ENCRYPTION_KEY` (from the source's `.env`) is needed only to decrypt
the secrets during import; it is used transiently, never stored. One-way values
(e.g. the SCIM token, stored as a hash) can't be migrated — the import lists them
to regenerate on the target. Delete `config.json` afterward.

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

#### Deploying without GitHub

An app does not need a repo. Create it with `source_type: "upload"` and ship
releases as bundles (`.zip`, `.tar.gz`, `.tgz`):

```bash
curl -F file=@dist.zip -F env=sandbox \
     -H "X-API-Key: $CRANE_KEY" \
     https://<your-domain>/api/apps/myapp/deploy/upload
```

The response carries `artifact.sha256` — AppCrane computes it over the bytes it
received, before extraction, and records it as the release identity
(`commit_hash = sha256:<digest>`). Compare it against the digest you computed
locally to confirm what was deployed is what you sent. Any `commit_sha` you pass
is stored alongside as context and is explicitly *not* trusted as the identity.

Agents hold personal MCP keys (`dhk_mcp_*`), which are allow-listed to
`/api/mcp` and `/api/files/staged` only, so they take the same path in two
steps: `POST /api/files/staged` to upload the bytes, then
`appcrane_deploy_artifact(slug, env, token)`. This is also the deploy route that
still works when a repo-based path is broken — an expired service-account PAT
returns 401 on every managed-repo write, and this one never contacts GitHub.

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

## MCP (for AI agents)

AppCrane is MCP-first. One `claude mcp add` and the agent gets 57
`appcrane_*` tools — list apps, deploy, roll back, set/get secrets, read
logs, manage access, scan for vulnerable dependencies, the lot. Tool
names are AWS-aligned (`stage`, `set_secret`/`get_secret`, `cp`).

```bash
claude mcp add --transport http appcrane https://crane.example.com/api/mcp \
  --header "X-API-Key: dhk_admin_or_user_xxxxxxxxxxxxx" \
  --header "X-Github-Token: ghp_your_github_pat"
```

Then in any Claude Code session:

> Onboard a new app. Start by calling `appcrane_get_guide` with `topic="onboarding"` for the playbook.

The agent pulls the current guide from the server, so edits propagate
without a redeploy of your tooling. `topic="operations"` returns the
post-onboarding reference (deploy lifecycle, troubleshooting fast
failures, access management, etc.).

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

Every container is published to **loopback only** (`127.0.0.1:<port>:3000`), so
Caddy is the only way in. The exception is an app with `ingress_type` `tcp` or
`dual`, which additionally publishes a port at `0.0.0.0:<public_port>` — outside
Caddy, and outside every control Caddy provides. A `tcp` app publishes container
port 3000 itself; a `dual` app publishes a *different* container port and leaves
3000 loopback-only behind Caddy. See
[§6 below](#6-tcp-layer-4-ingress--no-proxy-no-identity).

## Security

- **Init locked to localhost** — admin setup only from the server itself
- **API key auth** — all requests require `X-API-Key` header
- **Admin isolation** — admin cannot read env vars or `/data/`; enforced at middleware level
- **AES-256-GCM** encrypted env vars at rest
- **Webhook HMAC** verification for GitHub
- **SCIM deprovisioning** — removing a user from your IdP revokes AppCrane access automatically
- **All actions audited** — who did what, when

### Supply chain — SBOM + build provenance

A deployment self-updates straight from git (`/api/self-update` runs `git fetch`
+ `git reset --hard origin/main`), so the question a reviewer asks is "how do I
know the source I pulled is the source you published?" Every tagged release
answers it with four attached artifacts:

| Artifact | What it is |
|---|---|
| `appcrane-<tag>-source.tar.gz` | Reproducible `git archive` of the tagged tree (tracked files only) |
| `appcrane-sbom.cdx.json` | CycloneDX SBOM of the **production** dependency tree |
| `appcrane-sbom.spdx.json` | Same, SPDX format |
| `SHA256SUMS.txt` | Checksums for all of the above |

The source archive carries **build provenance and an SBOM attestation** signed
via sigstore keyless (GitHub artifact attestations) — no long-lived signing key
exists to be stolen. Verify a downloaded archive with:

```bash
gh attestation verify appcrane-<tag>-source.tar.gz --repo gitayg/appCrane
```

Dev dependencies are deliberately excluded from the SBOM — they aren't shipped
to a deployment, and including them would overstate the real attack surface.

**Uploaded releases** get the equivalent of a commit SHA rather than being
exempt from the question. AppCrane hashes the bundle server-side, before
extraction, and stores that digest as the release identity — so "is what is
running what was reviewed?" has an answer for an app with no repo. Before
v2.53.0 it did not: `commit_hash` held whatever the uploader typed, or the
literal string `unknown`, and two unrelated bundles could claim one SHA.

## Identity contract for deployed apps

Apps deployed on AppCrane never need to implement their own auth. The Caddy proxy verifies every request against `/api/identity/verify` *before* forwarding it to the container, and the result is delivered to the app in three complementary ways. Apps should consume them in this **precedence order**:

### 1. Request headers (zero-fetch, recommended)

Caddy `copy_headers` the verified identity onto the upstream proxy request. The app reads them directly:

| Header | Value | Notes |
|---|---|---|
| `X-AppCrane-Auth-Mode` | `authenticated` \| `headless` \| `bypass` | Always present on every proxied request, including ones with no identity. Read it first. |
| `X-AppCrane-User` | email | Backward-compat single identifier. Set on `authenticated` requests. |
| `X-AppCrane-User-Id` | numeric id (string) | Set on `authenticated` requests. |
| `X-AppCrane-User-Email` | email | Granular. May be absent if the user has no email. |
| `X-AppCrane-User-Name` | display name, `encodeURIComponent`-d | `decodeURIComponent` on read. May be absent. |
| `X-AppCrane-User-Role` | `platform_admin` \| `admin` \| `user` | Platform-wide tier, raw token. **Not** a per-app permission. |
| `X-AppCrane-App-Role` | `owner` \| `admin` \| `user` \| `viewer` | Per-app role — the one to gate on. An explicit `app_user_roles` row wins over the global-admin fallback, so a platform admin who owns the app arrives as `owner`, not `admin`. |
| `X-AppCrane-Is-Admin` | `1` \| `0` | `1` when the per-app role is `admin` or `owner`. Use it instead of comparing role strings. |
| `X-AppCrane-App-Roles` | comma-separated keys, e.g. `approver,auditor` | The roles **the app defines for itself** — a different system from `X-AppCrane-App-Role` above. AppCrane stores and issues them; the app enforces them, and no AppCrane authz check ever reads them back. A user may hold several (a union, not a ladder). **Omitted entirely** when they hold none, so `split(',')` can't produce a phantom `''` role. Section 5 below. |

**Trust model:** the Caddy generator wraps the `request_header -X-AppCrane-*` strips and the `forward_auth` block in a `route { … }` so they execute in written order — Caddy's own directive sort would otherwise run the strips *after* `forward_auth` and delete the identity it had just copied. Caddy zeroes out any client-set `X-AppCrane-*` headers first, then `copy_headers` re-injects only what `/verify` returned. The strips are emitted on **every** route that proxies an app, including headless apps and `auth_bypass_paths` prefixes where no `forward_auth` runs at all — a route that verifies nobody must not accept the caller's own `X-AppCrane-Is-Admin`. Header smuggling is impossible — what the app receives is guaranteed platform-issued. Caddy also strips the platform's `cc_token` session cookie out of `Cookie` before it reaches any container (v2.39.0), so an app can't read a visitor's platform session and act as them — **apps must take identity from these headers, never from a cookie**.

**Identity does not require SSO.** `/api/identity/verify` resolves a session from `X-API-Key` or from `Authorization: Bearer` / the `cc_token` cookie against `identity_sessions`. SSO is one way to create such a session; local password login and API keys are others. An instance with no IdP still injects the full header set for logged-in users.

**Absence semantics:** on an `authenticated` app an unverified visitor never reaches the container at all (Caddy fails closed at `forward_auth` and redirects to `/login`), so **presence = trusted**. Identity legitimately absent means `X-AppCrane-Auth-Mode` is `headless` (whole app opted out) or `bypass` (this path is in `auth_bypass_paths`, **or** the app is served on its own custom domain) — in every case the request is served with no verified identity and the app owns its own authn. No `X-AppCrane-Auth-Mode` at all means the request didn't come through AppCrane's proxy — i.e. direct-to-container. A custom-domain app *is* proxied and does get `X-AppCrane-Auth-Mode: bypass`.

**Role ordering:** `none` < `viewer` < `user` < `admin` < `owner`. `appRole === 'admin'` is a bug — it denies owners.

```js
// Express example
const RANK = { none: 0, viewer: 1, user: 2, admin: 3, owner: 4 }
const atLeast = (appRole, min) => (RANK[appRole] ?? 0) >= RANK[min]

app.use((req, res, next) => {
  const mode    = req.get('X-AppCrane-Auth-Mode')   // 'authenticated' | 'headless' | 'bypass'
  const role    = req.get('X-AppCrane-User-Role')   // platform tier
  const appRole = req.get('X-AppCrane-App-Role')    // 'owner' | 'admin' | 'user' | 'viewer'
  const email   = req.get('X-AppCrane-User-Email') || req.get('X-AppCrane-User')
  req.user = (mode === 'authenticated' && role)
    ? { id: req.get('X-AppCrane-User-Id'), email, role, appRole, isAppAdmin: atLeast(appRole, 'admin') }
    : null
  next()
})
```

### 2. `GET /api/me` (when you need more than the basics)

Returns the full user object — name, email, username, global role — plus the per-app role for whatever app the caller is asking about. Same origin as the app, so the browser auto-sends `cc_token`; no SDK or token plumbing required:

```js
const r = await fetch('/api/me')        // ?app=<slug> optional; Referer-inferred otherwise
if (r.status === 401) { location.href = '/login?redirect=' + encodeURIComponent(location.href); return }
const { user, app_role } = await r.json()
```

Auth precedence inside `/api/me`:
1. `cc_token` cookie (proxied apps' default — `httpOnly`, browser-managed).
2. `Authorization: Bearer <session>` (CLI / programmatic).
3. `X-API-Key: dhk_*` (admin / agent keys).

App slug resolution:
1. Explicit `?app=<slug>` query.
2. `Referer`-inferred (first path segment; sandbox-suffix retry).
3. Lean global-only payload if neither resolves.

### 3. Headless apps — opt out entirely

For services where the *whole app* is meant to be unauthenticated — telemetry ingest, public webhooks, status pages, the squash CLI's `ping`/`stats` — set the app's `auth_mode` to `headless` (owner-only toggle in the Launcher, or `appcrane_set_app_meta slug=<…> auth_mode=headless` via MCP). The Caddy block then skips `forward_auth` and `copy_headers`: no identity headers, no `/api/me`, no `cc_token` (that cookie is stripped for every app regardless). The incoming `X-AppCrane-*` strip is **not** skipped — a headless route verifies nobody, so it must not let a caller supply its own identity headers either. `X-AppCrane-Auth-Mode: headless` still arrives, so the app can distinguish "identity is off by design" from a misconfigured proxy. The app's own server takes responsibility for any payload-level authn it needs (HMAC, install-id, IP allowlist, etc.).

Pick by shape:
- **The whole app is unauth ingest** → headless app (clean separation, smaller blast radius).
- **Mostly-auth app with a couple of public endpoints** → keep `authenticated`, gate the public paths at the app's own router.

### 4. Per-tenant DB (multitenancy) — opt in

Opt in with `"multitenant": true` in `deployhub.json` and AppCrane gives each of
your app's users an isolated SQLite database on the persistent `/data` volume —
you don't build tenant isolation yourself. A tenant is **(org, user)**, where
`org` is the user's email domain. This is **fully opt-in**: apps that don't set
the flag are completely unaffected.

When enabled, AppCrane injects `APPCRANE_TENANT_ROOT=/data/tenants`. Use the
[`appcrane-tenant`](packages/tenant) helper to derive the tenant DB from the
identity headers above (section 1) — no path-building by hand:

```js
import { tenantDb } from 'appcrane-tenant'

app.get('/api/notes', (req, res) => {
  const db = tenantDb(req)   // opens /data/tenants/<org>/u<userId>/db.sqlite
  res.json({ notes: db.prepare('SELECT * FROM notes').all() })
})
```

`tenantDbPath(req)` returns just the path if you use a different SQLite driver.
Each tenant also gets a `storage/` dir (`tenantStorageDir(req)` / `tenantFile(req, name)`)
for files. Set `"tenant_quota_mb": <n>` in `deployhub.json` to cap per-tenant
usage — AppCrane injects it and `assertTenantQuota(req)` throws once a tenant is
full (the quota covers DB + storage).

Always build tenant paths via the helper (never from raw user input) — the
identity headers are platform-signed and the org slug is sanitised against
traversal. When a user's access is revoked, AppCrane purges that tenant's dir
automatically. Consumer domains (e.g. `gmail.com`) share an `org` label, but
isolation is per-user, so data never mixes. The helper isn't on npm yet — copy
[`packages/tenant/index.js`](packages/tenant/index.js) or depend on it by path;
see the [multitenant-notes example](examples/multitenant-notes).

### 5. App-defined roles — the app's own vocabulary

An app can define roles of its own — `approver`, `auditor`, `reviewer` — and
AppCrane hands each user's set to the app on every request. **AppCrane is the
authority, the app is the enforcer**: the platform stores who holds which key and
issues it, and has no opinion on what the key permits.

The two are separate systems on purpose, down to separate tables and separate
wire fields. An app-defined role never confers an AppCrane privilege, and no
AppCrane authorization check reads one — otherwise an app owner could invent a
role named `admin`, assign it to themselves, and author their own escalation from
a settings form. For the same reason `owner`, `admin`, `user`, `viewer`, `none`
and `platform_admin` are rejected as keys, keys must match
`/^[a-z][a-z0-9_-]{0,31}$/`, and an app may define at most 16 of them (which also
bounds the header's length by design rather than by discovery).

- **On the server:** `X-AppCrane-App-Roles`, comma-separated and sorted, absent
  when the user holds none. A user may hold several — they are a union, so test
  set membership rather than equality. It is stripped off the client request and
  re-issued by `/verify` like every other identity header.
- **In the browser:** `GET /api/me?app=<slug>` returns `app_roles: [...]` beside
  `app_role` (`[]` when none).
- **Explicit grants only.** A `platform_admin` holds no app-defined role unless
  someone granted it, and neither does the app's `owner` — unlike `app_role`,
  there is no global-admin fallback. Holding an app role while being a plain
  platform `user` is the normal case, not an edge case.
- **Managed by** the app's own owner/admin tier, over
  `/api/apps/<slug>/app-roles` (note: not `/roles`, which is the platform tier) or
  the `appcrane_list_app_roles` / `appcrane_create_app_role` /
  `appcrane_set_user_app_roles` MCP tools. Deleting a role cascades its grants.

```js
const appRoles = new Set((req.get('X-AppCrane-App-Roles') || '').split(',').filter(Boolean))
if (!appRoles.has('approver')) return res.status(403).json({ error: 'approver role required' })
```

### 6. TCP (layer-4) ingress — no proxy, no identity

Sections 1–5 all rest on the same assumption: Caddy is in front of the app. Some
apps aren't HTTP and cannot be proxied at all — the motivating case is a
forward/**CONNECT** proxy, where the client opens a raw TCP connection and gets a
tunnel back, which no HTTP reverse proxy can express. For those, a **platform
admin** (not the app owner) can set `ingress_type: 'tcp'` — `PUT /api/apps/<slug>`
or `appcrane_set_app_ingress` — and AppCrane publishes the production container's
port on the host at `0.0.0.0:<public_port>`, the next time the container is
recreated (a deploy, or the restart route — the publish is a `docker run` flag, so
nothing changes on a running container). The existing loopback publish stays and
sandbox is unaffected; this adds a door rather than moving one.

**Two port ranges, and they are not the same numbers.** A host port AppCrane
*allocates* comes from a dedicated band, 31000 through 31999, so an operator
firewalls one predictable block. A host port named **explicitly** may be anything
in 1024–65535 — because clients are configured with a port by hand or by MDM, and
a fleet already pointing at 8080 is not something the platform gets to overrule.
Narrowing the range was never the safety property: the guards that refuse a port
apply at every value (WHATWG-blocked ports, AppCrane's own listening port, any
port the slot allocator could hand a container, and the partial unique index that
gives one host port to one app). A port outside the auto band just needs its own
firewall rule.

**The container must still answer `/api/health` over HTTP**, whatever its
`ingress_type`: the deploy gate polls it for 30 s and rolls the release back
without a 200 carrying `status` and `version`. So `tcp` ingress serves apps that
*also* speak HTTP on the container port — true of the motivating CONNECT proxy —
and an app speaking **only** a non-HTTP protocol cannot be deployed today. Note
too that the publish covers the whole container port, so every HTTP route on it,
including that health endpoint and any admin route, is exposed alongside the raw
protocol.

That door has **none** of the controls above, and none of the ones AppCrane
gained in v2.35–v2.41: no `forward_auth`, no `X-AppCrane-*` identity headers
(nothing injects or strips them), no per-request audit, no rate limiting, no
security headers, and no TLS terminated by AppCrane. **The app owns
authentication completely.** It is *not* `auth_mode: 'headless'` — a headless app
still goes through Caddy and still gets TLS, security headers and the
`X-AppCrane-Auth-Mode: headless` stamp.

**`ingress_type: 'dual'` — an app with both planes (v2.45.0).** Some apps are
genuinely both: an HTTP **control plane** (admin UI, REST API) that must keep
everything Caddy gives it, plus a raw **data plane** whose clients are already
pinned to a specific host port. Under `tcp` that was inexpressible, because both
publishes targeted the same hardcoded container port — so `tcp` could only
re-expose the very port Caddy was already serving. A `dual` app names a second
port inside its container:

```
control plane   Caddy → 127.0.0.1:<slot port> → container:3000
data plane      raw   → 0.0.0.0:<public_port> → container:<data_plane_port>
```

The control plane is untouched — same URL, same SSO, same identity headers, same
access logs. Only the data plane is undefended, and the loss table above is what
it loses. Three rules make that split real:

- **`data_plane_port` may not be 3000**, and a request that sets it is refused
  with a 400. Port 3000 is the container's HTTP control plane, the port Caddy
  proxies to; publishing it raw would re-expose the app's ordinary HTTP origin
  with no TLS, no `forward_auth`, no identity headers and no audit — exactly the
  surface Caddy is in the path to protect, with no signal to the operator that
  they had done it. `dual` with **no** `data_plane_port` is refused for the same
  reason: the publish must target *some* container port, 3000 is the only other
  one there, and AppCrane will not guess. The runtime refuses such a row too — it
  emits no public `-p` at all rather than falling back to 3000.
- **Health checks follow the control plane.** A `tcp` app gets a TCP handshake
  because it cannot answer an HTTP probe; a dual app can, so it keeps the ordinary
  HTTP health check on container port 3000 and its data plane is never probed. A
  handshake on a raw listener succeeds as long as the socket is bound, so probing
  the data plane would let a wedged control plane — the plane users actually reach
  — report healthy and a broken release go green.
- **The host port is unique; the container port deliberately is not.** The partial
  unique index on `apps(public_port)` still gives one host port to one app.
  `data_plane_port` has no such constraint and should not gain one: container
  network namespaces are separate, so two apps can each run a data plane on
  container port 8081 without ever meeting.

`dual` is a third enum value rather than a flag on an `http` app because
`ingress_type` is the field an operator, an audit entry and an MCP payload all read
to learn what doors an app has — a row saying `http` while the app published a raw
port would make that field actively wrong. It also fails safe: code that predates
`dual` compares `=== 'tcp'`, gets `false`, and takes the HTTP path, which is the
correct one for a dual app. An app that sets nothing is still `http` and behaves
exactly as before; a pre-v2.45.0 `tcp` app still publishes container port 3000 and
still gets its handshake health check.

An app on a published port can still authenticate against the platform if it
chooses to: `GET /api/me?app=<slug>` verifies a `Bearer` token or `X-API-Key: dhk_*`
the client supplied, and `POST /api/service/*` authenticates the app itself with
the `APPCRANE_SERVICE_TOKEN` injected into every container. Both go over the
docker bridge (`CRANE_INTERNAL_URL`), not through Caddy.

`public_port` is allocated and stored per app (never derived from the app's slot,
which can be reassigned), unique across apps, and every change — including
`data_plane_port` — is written to the audit log as `app-ingress-change`. Both
numbers are pinned: they survive a flip back to `http` so that flipping forward
restores the ports a client fleet is already configured for, and they read back as
`null` while the app is not publishing. On the way back in `data_plane_port` is
re-validated; `public_port` is not — a held number is reinstated as-is, so re-pin
it explicitly if the app has been parked on `http` while the platform grew.
Flipping a `dual` app to `tcp` is refused while it still holds a
`data_plane_port`, because `tcp` publishes container port 3000 and the flip would
silently repoint the same host port onto the control plane; send
`data_plane_port: null` in the same request to drop the data plane on purpose.
**Treat publishing as the exposing act** — do
not assume a host firewall is holding the port shut. A Docker publish is a DNAT
rule evaluated in `FORWARD` that never traverses `INPUT`, so a plain `ufw deny`
does **not** block it; filter in the `DOCKER-USER` chain or upstream of the host.
And where the platform runs behind SDP, the boundary that exists is the
perimeter: a published port is reachable by everything inside it from the moment
the container is recreated.

Switching back to `http` stops the publish but does **not** close the port: the
running container keeps the binding until it is recreated, so redeploy or restart
the app before treating the exposure as revoked. Because that port is still bound,
AppCrane keeps it **reserved to that app** rather than returning it to the pool —
no other app can be allocated a number a live container still holds — and releases
it automatically when the container comes back without the publish. Until then the
app reports the number as `pending_port_release` on every read surface, so nothing
claims the port is closed while it is open.

For a CONNECT proxy specifically: a published port is reachable by everything that
can already reach the host, so on an SDP-fronted deployment that is everyone inside
the perimeter rather than the internet. A gap in the app's proxy authentication is
therefore an **unaudited egress path out of the perimeter**, and AppCrane logs none
of it because the traffic never touches Caddy. The app's `407 Proxy-Authenticate`
path is the security boundary — the ingress isn't.

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

Node.js 22, Express 5, SQLite, Docker, Caddy 2, SAML/OIDC/SCIM, AES-256-GCM, Commander.js, Ubuntu 22.04+

## License

[GNU AGPL v3](LICENSE). Free and open source — use, modify, and self-host. If you run a modified version as a network service, you must make your source available under the same license. Need to run private modifications as a service, or embed AppCrane in a proprietary product? A [commercial license](COMMERCIAL-LICENSE.md) is available.

## Feedback & Contributions

Open an issue: https://github.com/gitayg/appCrane/issues

Pull requests welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. It includes the short CLA that keeps AppCrane's dual-licensing (AGPL + commercial) possible.
