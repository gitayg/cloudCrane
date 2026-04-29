# AppCrane - AI Agent Operations Guide

You are an AI agent with a **deployment key** for a specific app on an AppCrane server. Your key is scoped to one app — you can deploy code, manage environment variables, configure health checks, rollback, and promote for that app. You cannot access hub administration (other apps, user management, etc.).

## Connection

```bash
# Set these two values (provided by the admin)
export CC="https://crane.example.com"
export KEY="your_api_key_here"

# All requests use the X-API-Key header
# Example: curl -s -H "X-API-Key: $KEY" $CC/api/apps
```

## App Requirements

Every app managed by AppCrane must be a Node.js app (React frontend + Express backend). Here's what the agent needs to know when building or preparing an app for deployment.

### Required: deployhub.json manifest

Every app MUST have a `deployhub.json` in its root directory:

```json
{
  "name": "MyApp",
  "version": "1.0.0",
  "icon": "/icon.svg",
  "fe": {
    "build": "npm run build",
    "serve": "npx serve -s dist"
  },
  "be": {
    "entry": "node server.js",
    "health": "/api/health"
  },
  "data_dirs": ["data/"],
  "env_example": ".env.example"
}
```

> **Note on `data_dirs`:** this field is currently **documentary only** —
> AppCrane does not read it at deploy time. The bind mount is always
> `/data` → `data/apps/<slug>/<env>/shared/data/` regardless of what you
> list here. Leave it in for forward-compatibility and as a signal to
> reviewers of which dirs the app treats as persistent, but don't rely
> on it to create hostdirs, copy seeds, or change the mount path.

### Required: Version management

The version is the single source of truth for what's deployed. It must be consistent across three places:

**1. `deployhub.json`** -- AppCrane reads this during deploy:
```json
{
  "name": "MyApp",
  "version": "1.2.0"
}
```

**2. Health endpoint** -- MUST return `version` in the JSON response. AppCrane reads this live to display the running version in the dashboard:
```javascript
// Read version from deployhub.json so it's always in sync
import { readFileSync } from 'fs';
const manifest = JSON.parse(readFileSync('./deployhub.json', 'utf8'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: manifest.version });
});
```

**3. Frontend UI** -- display the version somewhere visible (footer, settings, about):
```javascript
// Option A: Import at build time (Vite)
// In vite.config.js:
import { readFileSync } from 'fs';
const manifest = JSON.parse(readFileSync('./deployhub.json', 'utf8'));
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(manifest.version) }
});
// In your React component:
<span>v{__APP_VERSION__}</span>

// Option B: Serve from backend API
app.get('/api/version', (req, res) => {
  res.json({ version: manifest.version, name: manifest.name });
});
// Frontend fetches /api/version on load and displays it
```

**Version bump workflow:**
1. Update `version` in `deployhub.json` (single place to change)
2. Commit and push
3. Deploy -- AppCrane picks up the new version automatically
4. Health endpoint and frontend both reflect the new version

**Never hardcode the version string in multiple files.** Always read from `deployhub.json` so there's one source of truth.

### Required: Health endpoint

### Required: Path-based routing — make your app slug-aware

Apps are served at `{CRANE_URL}/{slug}/` (production) and `{CRANE_URL}/{slug}-sandbox/` (sandbox). Caddy strips the `/{slug}` prefix before forwarding to the app, so the app itself sees requests at `/`. **But** any URL the app emits to the browser as **root-relative** (`/assets/...`, `/api/...`, `<a href="/foo">`) will be sent back without the slug prefix, miss every Caddy `/{slug}*` route, and either 404 (unknown path) or 401 (collides with one of AppCrane's own `/api/*` routes — `/api/auth/verify` is the common gotcha).

If you see any of these in the browser console, this is the cause:
- `assets/index-XXXX.js` 404
- `api/state` 401 / `api/auth/verify` 401
- `personas.json` 404
- the app's router showing the "not found" route on hard refresh

To fix it, **every URL the browser sees must include the slug prefix**. AppCrane injects the prefix at **build time only**, so the bundler can bake it into asset URLs:

`APP_BASE_PATH`, `PUBLIC_URL`, and `VITE_BASE_PATH` are set during `docker build` (auto-generated Dockerfiles and as `--build-arg` for user-provided Dockerfiles). They are **not** present in the runtime container env — Caddy strips the slug prefix before requests reach your container, so backends mount at `/`.

> **Sub-path apps: `APP_BASE_PATH` is for the bundler only.**
>
> Mount your backend at `/`. Caddy strips the slug prefix (`/{slug}/`) before requests reach your container — prefixing backend routes will 404 every request. `APP_BASE_PATH` is set during build (so Vite/CRA/Next emit prefixed asset URLs), but is **unset at runtime**. If your backend code does `app.use(\`${process.env.APP_BASE_PATH}/api\`, …)`, the variable is undefined at runtime and reduces to `app.use('/api', …)` — which is the right thing.

AppCrane injects these standard env vars automatically — **do not hardcode these values**:

| Var | Example value | Phase | Purpose |
|-----|--------------|-------|---------|
| `APP_BASE_PATH` | `/myapp/` or `/myapp-sandbox/` | Build only | Path prefix for the bundler (asset URLs) |
| `VITE_BASE_PATH` | same | Build only | Vite-prefixed alias for `vite.config.js` |
| `PUBLIC_URL` | same | Build only | CRA-convention alias |
| `CRANE_URL` | `https://your-crane-domain.com` | Build + runtime | Public AppCrane URL — browser-side redirects/links |
| `CRANE_INTERNAL_URL` | `http://localhost:5001` | Runtime | Server-to-server URL — identity/verify fetches from backend |
| `PORT` | `4001` | Runtime | Backend listen port |

> **User-provided Dockerfiles:** to receive the build-time vars, add `ARG APP_BASE_PATH` (and optionally `ARG PUBLIC_URL` / `ARG VITE_BASE_PATH`) near the top of your Dockerfile, then reference them in your build `RUN`. Without `ARG`, your bundler can't see them.

**Identity verify calls** — always use `CRANE_INTERNAL_URL` from server code (avoids public-IP loopback issues where the machine can't reach its own HTTPS endpoint):
```javascript
// ✅ server-side auth middleware — use CRANE_INTERNAL_URL
const CRANE = process.env.CRANE_INTERNAL_URL || 'http://localhost:5001';
const res = await fetch(`${CRANE}/api/identity/verify?app=myapp`, { headers: { Authorization: req.headers.authorization } });

// ✅ browser-side redirect after logout — use CRANE_URL
const loginUrl = process.env.CRANE_URL + '/login';

// ❌ never hardcode the instance URL
fetch('https://your-crane-domain.com/api/identity/verify?app=myapp', ...);
```

#### 1. Bundler config

**Vite** (`vite.config.js`):
```javascript
import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.APP_BASE_PATH || './',
});
```
This makes `import.meta.env.BASE_URL` resolve to `/{slug}/` in your built code.

> **Vite fallback must be `'./'`, not `'/'`.**
> AppCrane passes `APP_BASE_PATH` to `docker build` as a `--build-arg` (and bakes it into the auto-generated Dockerfile's build step). Custom Dockerfiles must declare `ARG APP_BASE_PATH` to receive it. If neither path applies, Vite falls back to the `|| …` value. Using `'/'` causes a MIME type error: the browser requests `/{slug}/assets/index.js`, the SPA catch-all serves `index.html` instead, and the JS never executes. Using `'./'` makes all asset paths relative so they resolve correctly at any sub-path even without the env var.

**Create React App**: `PUBLIC_URL` is read automatically — no config change needed, but you must reference assets via `process.env.PUBLIC_URL` (e.g. `<img src={process.env.PUBLIC_URL + '/logo.png'}>`), not as plain `/logo.png`.

**Next.js** (`next.config.js`):
```javascript
module.exports = {
  basePath: (process.env.APP_BASE_PATH || '').replace(/\/$/, ''),
  assetPrefix: process.env.APP_BASE_PATH || undefined,
};
```

#### 2. Router

**React Router**:
```javascript
// ⚠️ React Router v6 rejects trailing slashes in basename — strip it.
// import.meta.env.BASE_URL is "/myapp/" (trailing slash), but basename must be "/myapp".
<BrowserRouter basename={(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}>
```

#### 3. `fetch` / `axios` calls

The bundler does **not** rewrite runtime `fetch('/api/...')` strings. You have to do this yourself. Pick one of these patterns and use it consistently:

```javascript
// Vite — use import.meta.env.BASE_URL (already includes the trailing slash)
const API = import.meta.env.BASE_URL + 'api';
fetch(`${API}/state`);

// CRA — use PUBLIC_URL
const API = process.env.PUBLIC_URL + '/api';
fetch(`${API}/state`);

// Or use a relative URL that resolves against the current page
fetch('api/state');     // ✅ resolves to /{slug}/api/state when on /{slug}/
fetch('/api/state');    // ❌ always /api/state — hits AppCrane, not your app
```

If the app uses `axios`, set `axios.defaults.baseURL = import.meta.env.BASE_URL + 'api'` once at startup.

#### 4. HTML/CSS asset references

In hand-written HTML or CSS that the bundler doesn't process, the same rule applies. Use relative paths (`./logo.svg`, `assets/foo.png`) or template the base path in.

#### 5. Anchor tags / programmatic navigation

```javascript
<Link to="/dashboard">      // ✅ React Router prepends basename automatically
<a href="/dashboard">       // ❌ goes to {CRANE_URL}/dashboard, not {CRANE_URL}/{slug}/dashboard
window.location = '/login'; // ❌ same problem
```

#### Quick check before deploying

After running your build locally, grep the `dist/` (or `build/`) output:
```bash
grep -r 'src="/' dist/ | grep -v '/{slug}/'
grep -r "fetch('/" src/
```
Anything that matches needs updating.

#### After changing your app

You must **redeploy** so AppCrane re-runs the build with `APP_BASE_PATH` set. Existing built bundles stay broken until rebuilt.

### Required: App icon/thumbnail

Upload an icon when creating the app (admin UI or API). AppCrane stores it at `data/apps/{slug}/icon.svg` and serves it at `{CRANE_URL}/api/apps/{slug}/icon` — no app code needed, and the icon stays available even when the app backend is down.

The icon should be:
- SVG format (preferred) or PNG
- Square, works at 32x32px
- Accessible without authentication (the AppCrane endpoint is public)

### Required: Health endpoint

The backend MUST expose a health check endpoint (default `/api/health`):

```javascript
import { readFileSync } from 'fs';
const manifest = JSON.parse(readFileSync('./deployhub.json', 'utf8'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: manifest.version });
});
```

AppCrane pings this endpoint every 30s. If it fails 3 times, the app auto-restarts. If it fails 5 times, the app is marked DOWN and an email alert is sent.

### Standard: Express server setup

Use the standard Node.js pattern for your server. AppCrane handles all port routing internally via Caddy -- your app is accessed by domain name, never by port:

```javascript
const app = express();
// ... your routes ...
app.listen(process.env.PORT || 3000);
```

### GitHub Access (Private Repos)

If the app repo is private, provide a GitHub Personal Access Token (PAT) when creating the app:

```bash
# Via curl (include github_token in the create app request)
curl -s -X POST $CC/api/apps -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"MyApp","slug":"myapp","source_type":"github","github_url":"https://github.com/yourorg/private-repo","github_token":"ghp_your_token_here"}'
```

- The token is stored per-app (not global) and encrypted at rest (AES-256-GCM)
- The token is used only during `git clone` to pull the repo
- Generate a token at: https://github.com/settings/tokens (needs `repo` scope)
- Each app can have a different token (different repos, different orgs)
- Token can be updated later: `PUT /api/apps/SLUG` with `{"github_token":"ghp_new_token"}`

### CI/CD Deploy (artifact upload — no GitHub token on server)

The `POST /api/apps/:slug/deploy/upload` endpoint accepts a pre-built artifact from any CI system and deploys it in one step. AppCrane never touches GitHub — the CI pipeline has repo access via its own built-in token.

**Form fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | `.zip`, `.tar.gz`, or `.tgz` bundle |
| `env` | yes | `sandbox` or `production` |
| `commit_sha` | no | Full or short SHA (stored in deploy record, fixes "unknown" hash) |
| `commit_message` | no | Commit message (stored in deploy record) |

The bundle must contain `deployhub.json` in its root. AppCrane unpacks it, runs `npm install`, builds the frontend, writes the `.env`, starts the container via Docker, and swaps the `current` symlink — identical to a GitHub-sourced deploy.

**GitHub Actions example:**

```yaml
name: Deploy to AppCrane

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci && npm run build   # your build steps

      - name: Package artifact
        run: zip -r artifact.zip . -x "*.git*" "node_modules/*"

      - name: Deploy to AppCrane sandbox
        run: |
          curl -s -X POST ${{ vars.CRANE_URL }}/api/apps/${{ vars.APP_SLUG }}/deploy/upload \
            -H "X-API-Key: ${{ secrets.CRANE_KEY }}" \
            -F "file=@artifact.zip" \
            -F "env=sandbox" \
            -F "commit_sha=$GITHUB_SHA" \
            -F "commit_message=${{ github.event.head_commit.message }}"
```

Store `CRANE_URL` and `APP_SLUG` as repository variables, `CRANE_KEY` as a repository secret. `GITHUB_SHA` is the full commit SHA — AppCrane stores the first 8 chars in the deploy record so the dashboard shows the correct hash instead of "unknown".

Response:
```json
{
  "deployment": { "id": 42, "app": "myapp", "env": "sandbox", "status": "pending" },
  "message": "Deployment #42 started. Check status with GET /api/apps/myapp/deployments/sandbox"
}
```

### Secrets and Environment Variables

- Secrets (API keys, database URLs, tokens) are NEVER stored in code or committed to git
- Set them via the AppCrane API as env vars: `PUT /api/apps/SLUG/env/ENV`
- AppCrane encrypts them at rest (AES-256-GCM) and writes them to `.env` at deploy time
- Access them in your app via `process.env.YOUR_VAR`
- Each environment (production/sandbox) has its own separate env vars
- ALWAYS use different database URLs for production and sandbox

**`VITE_*` variables do NOT work with AppCrane env vars.**  
AppCrane injects env vars at `docker run` time — after `npm run build` has already completed. Vite embeds env vars into the bundle at build time, so any `VITE_*` var set in AppCrane will always be `undefined` in the browser.

**The correct pattern for frontend config / API keys:**
- Keep the key in an AppCrane env var (e.g. `ANTHROPIC_API_KEY`) — server-side only
- Add a backend route that reads the key from `process.env` and proxies the API call
- The frontend calls your backend route — the raw key never touches the browser

Changing the key then only requires updating the env var and restarting the container — no rebuild needed, key never exposed in the bundle.

**Never build UI for system-wide LLM/provider keys (Anthropic, OpenAI, etc.).** Do not add a settings page, admin form, or DB row that asks an admin to paste an `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / similar. These are infrastructure secrets, not app data:

- Read them only from `process.env.ANTHROPIC_API_KEY` (set via `PUT /api/apps/SLUG/env/ENV`)
- Remove any existing "Anthropic API Key — system-wide key, visible to admins only" UI and the table/column backing it
- If the key is missing at runtime, fail fast on startup with a clear log message naming the env var — do not surface a UI prompt
- Do expose a **"Test connection"** action (admin-only button or `POST /api/admin/llm/test`) that makes one cheap call using the env-var key and returns ok / error + provider message, so admins can verify the key without seeing or editing it

Common env vars to set:
```
DATABASE_URL=postgres://user:pass@host:5432/dbname
API_KEY=sk-your-api-key
NODE_ENV=production (or development for sandbox)
SESSION_SECRET=random-string-here
SMTP_HOST=smtp.example.com
```

### Persistent data — must use `/data` (absolute), not a relative path

AppCrane runs every app in an isolated Docker container. The image layers are
immutable, so **anything your app writes to a path inside the image will
disappear on the next restart**. There is exactly one writable, persistent
location per env: the `/data` volume, which AppCrane bind-mounts from
`data/apps/<slug>/<env>/shared/data/` on the host onto `/data` in the container.

> ⚠️ **Silent-drift warning.** Apps that resolve their data dir with
> `./data`, `path.join(__dirname, '../data')`, `'../data'`, or any
> relative path will silently read/write the **baked-in image path**, not
> the persistent volume. Writes disappear on every rebuild and reads
> serve whatever seed shipped in the image. App code must reference
> `/data` directly, or read it from `DATA_DIR=/data`.
>
> **Symptom:** the UI shows stale/seed data while the operator sees
> *live* data under `/root/appCrane/data/apps/<slug>/<env>/shared/data/`
> on the host. If these two views disagree, the app is reading the wrong
> path.

**Rules for any app that writes state** (SQLite DBs, uploads, caches, session
files, logs you want to keep):

- Use the absolute path `/data` — **never** a relative path like `./db/app.db`
  or `./uploads`. Relative paths resolve inside the read-only image layer and
  either silently vanish on restart or hard-crash with `SQLITE_CANTOPEN`
  / `ENOENT: unable to open file`.
- AppCrane injects `DATA_DIR=/data` into every container. Prefer reading that
  env var so local dev (where `DATA_DIR` might be `./data`) and prod work the
  same way: `const dataDir = process.env.DATA_DIR || './data';`
- Create subdirectories on startup (`fs.mkdirSync(dataDir, { recursive: true })`).
- **Log the resolved data dir on boot** and include it in `/api/health`:
  ```js
  console.log('[boot] DATA_DIR =', dataDir);
  app.get('/api/health', (req, res) => res.json({ status: 'ok', data_dir: dataDir, version: manifest.version }));
  ```
  This turns "writes not persisting" from a multi-hour debug into a 10-second
  diagnosis — one `curl` at the health endpoint reveals the wrong path.
- `/data` survives redeploys, rollbacks, and container recreation. It is
  included in backups. Production and sandbox get separate `/data` volumes.

```js
// ✅ Works in Docker
const dbPath = path.join(process.env.DATA_DIR || './data', 'app.db');

// ❌ Breaks in Docker — path is inside the image, not writable, not persistent
const dbPath = './db/app.db';
const dbPath = path.join(__dirname, 'db', 'app.db');
const dbPath = path.join(__dirname, '..', 'data', 'app.db');
const dbPath = '../data/app.db';
```

### Database

- AppCrane does NOT provision databases. The app must bring its own.
- Recommended: SQLite (simplest, file-based, stored under `/data`) or external PostgreSQL
- For SQLite: build the path from `process.env.DATA_DIR` (see rules above)
- `DATABASE_URL=sqlite:/data/app.db` is a safe default the admin can override per env

### File structure expected by AppCrane

```
myapp/
  deployhub.json          ← REQUIRED manifest
  package.json            ← npm dependencies
  server.js               ← backend entry (or whatever be.entry says)
  data/                   ← persistent data (DB files, uploads) - survives deploys
  .env.example            ← template showing required env vars
  src/                    ← frontend source (if React app)
  dist/                   ← built frontend (after npm run build)
```

Or with separate frontend/backend directories — set `be.workdir` and `fe.workdir`
in `deployhub.json` so AppCrane knows where to install deps and run the entry:
```
myapp/
  deployhub.json     # must declare be.workdir + fe.workdir
  frontend/
    package.json     # installed under /app/frontend in the container
    src/
    dist/
  backend/
    package.json     # installed under /app/backend; container CWD is here
    server.js        # entry runs from /app/backend
  data/
  .env.example
```

**Required** `deployhub.json` for the monorepo layout above:
```jsonc
{
  "name": "myapp",
  "version": "1.0.0",
  "be": {
    "workdir": "backend",         // where the backend's package.json lives
    "entry": "node server.js",    // run inside /app/backend
    "health": "/health"
  },
  "fe": {
    "workdir": "frontend",        // where the frontend's package.json lives
    "build": "npm run build"      // runs inside /app/frontend
  }
}
```

Without these `workdir` fields, AppCrane only `npm install`s at the repo root —
your subdirectory `package.json` files are ignored and your container will
crash at runtime with `Cannot find package 'X'`. Optional related fields:

| Field | Default | Purpose |
|---|---|---|
| `be.install` | `npm ci --omit=dev` (falls back to `npm install`) | Custom backend install command |
| `fe.install` | `npm ci` (devDeps included for build) | Custom frontend install command |
| `be.workdir` | `.` (repo root) | Path to backend's package.json + entry |
| `fe.workdir` | `.` (repo root) | Path to frontend's package.json + build |

### Custom Dockerfile (optional)

By default AppCrane generates a `Dockerfile` for every app (Node Alpine, non-root user, tini entrypoint). If you need full control over the OS layer or installed system packages, ship your own `Dockerfile` at the repo root — AppCrane will use it as-is and skip generation.

**Rules for user-provided Dockerfiles:**
- Must include `EXPOSE <port>` matching the port in `deployhub.json` (default 3000)
- Must not run as root — end with `USER <non-root-user>`
- Must not hardcode secrets in `ENV` instructions — use AppCrane env vars instead
- Do not declare `VOLUME /data` — AppCrane mounts it at runtime

> **UID caveat.** AppCrane chowns the host-side `shared/data/` dir to
> `1000:1000` on deploy because that's the UID the stock `node:*-alpine`
> base image uses for the `node` user. If your custom Dockerfile runs as
> a different non-root user (e.g. debian/ubuntu bases typically don't
> pre-create a UID-1000 user; Python images use `app` / UID varies),
> either: (a) create a user with UID 1000 in your Dockerfile
> (`RUN adduser -u 1000 ...`), or (b) ensure your non-root user can read
> `/data` some other way — but do **not** blindly `chown 1000:1000`
> inside your own Dockerfile if you're not running as that UID.

**What AppCrane always controls at runtime (regardless of your Dockerfile):**
- `CRANE_URL`, `CRANE_INTERNAL_URL`, `DATA_DIR` are injected via `docker run --env` and override any Dockerfile values
- `APP_BASE_PATH` is **build-time only** (passed as `--build-arg` to `docker build`); not present in the runtime env
- The `/data` volume is mounted by AppCrane at container start

AppCrane validates your Dockerfile before building and fails the deploy with a clear error if any rule is violated.

### What happens during deploy

1. AppCrane pulls code from GitHub (or uses uploaded files)
2. Reads `deployhub.json` for build/start commands
3. Checks for a `Dockerfile` at repo root — uses it if present, generates one (Node Alpine) if not
4. If user-provided: validates Dockerfile (EXPOSE, non-root, no hardcoded secrets)
5. Builds Docker image
6. Injects runtime env vars and mounts `/data` volume at container start
7. Runs health check on the health endpoint
8. If healthy: swaps the `current` symlink to new release
9. If unhealthy: marks deploy as failed, keeps previous version running

### What persists across deploys

| Persists | Does NOT persist |
|----------|-----------------|
| `/data/` directory (symlinked) | `node_modules/` (reinstalled each deploy) |
| `.env` file (written from AppCrane) | Source code (replaced each deploy) |
| Backup history | Build artifacts (rebuilt each deploy) |

### Fresh install checklist (for the agent)

When deploying a brand new app for the first time:

1. Ensure `deployhub.json` exists in repo root
2. Ensure `server.js` uses `app.listen(process.env.PORT || 3000)`
3. Ensure `/api/health` endpoint exists and returns 200
4. Ensure `package.json` has all dependencies
5. Ensure `.env.example` lists all required env vars
6. Push code to GitHub
7. Create the app on AppCrane (you are auto-assigned):
   ```bash
   curl -s -X POST $CC/api/apps \
     -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"name":"My App","slug":"myapp","description":"Short description shown to users on the login portal","source_type":"github","github_url":"https://github.com/yourorg/myapp"}'
   ```
   The app will be accessible at `$CC/myapp` (production) and `$CC/myapp-sandbox` (sandbox).
8. Set env vars for sandbox: `PUT /api/apps/SLUG/env/sandbox`
9. Deploy to sandbox: `POST /api/apps/SLUG/deploy/sandbox`
10. Test health: `POST /api/apps/SLUG/health/sandbox/test`
11. Set env vars for production: `PUT /api/apps/SLUG/env/production`
12. Promote to production: `POST /api/apps/SLUG/promote`
13. Configure health check: `PUT /api/apps/SLUG/health/production`
14. Configure webhook for auto-deploy: `PUT /api/apps/SLUG/webhook`

---

## API Key Management

AppCrane has two types of keys:

| Type | Scope | Created by |
|------|-------|------------|
| **Admin key** (`dhk_admin_*`) | Full hub access — manage all apps, users, Caddy | `crane init` CLI on the server |
| **Deployment key** (`dhk_user_*`) | One specific app — deploy, env vars, health, rollback | Admin via dashboard "Onboard" button or API |

**IMPORTANT: API keys are shown ONLY ONCE at creation. They cannot be retrieved later.**

```bash
# Create a deployment key scoped to one app (admin only)
curl -s -X POST $CC/api/apps/SLUG/deployment-key -H "X-API-Key: $ADMIN_KEY"
# Response: { "api_key": "dhk_user_abc123...", "app": "myapp" }

# Regenerate lost key (admin) - returns new key, old one is invalidated
curl -s -X POST $CC/api/users/2/regenerate-key -H "X-API-Key: $ADMIN_KEY"
# Response: { "api_key": "dhk_user_newkey...", "warning": "Save this key!" }
```

If you are an agent, your deployment key was provided by the admin. It is already scoped to your app — you do not need to create users or manage permissions.

## Available API Endpoints

All endpoints require `X-API-Key` header unless noted.

```
GET    /api/info                           # Public, no auth
GET    /agent-guide                        # Public, no auth
GET    /docs                               # Public, no auth
GET    /login                              # Public, login page

# Identity (public, no X-API-Key needed)
POST   /api/identity/login                 # Login: { login, password, app? } → token
GET    /api/identity/verify                # Verify token: Authorization: Bearer TOKEN → user + role
GET    /api/identity/me                    # User profile from token
POST   /api/identity/logout                # Invalidate token

GET    /api/auth/me                        # Current API key user info
GET    /api/apps                           # List apps
POST   /api/apps                           # Create app (admin)
GET    /api/apps/:slug                     # App details
PUT    /api/apps/:slug                     # Update app (admin)
DELETE /api/apps/:slug?confirm=true        # Delete app (admin)
PUT    /api/apps/:slug/users               # Assign users (admin)

POST   /api/apps/:slug/deploy/:env         # Deploy (app user)
GET    /api/apps/:slug/deployments/:env    # Deploy history
GET    /api/apps/:slug/deployments/:env/:id/log  # Deploy log
POST   /api/apps/:slug/rollback/:env       # Rollback (app user)
POST   /api/apps/:slug/promote             # Promote sandbox→prod (app user)

GET    /api/apps/:slug/env/:env            # List env vars (app user)
PUT    /api/apps/:slug/env/:env            # Set env vars (app user)
DELETE /api/apps/:slug/env/:env/:key       # Delete env var (app user)

GET    /api/apps/:slug/health/:env         # Health config + state
PUT    /api/apps/:slug/health/:env         # Configure health (app user)
POST   /api/apps/:slug/health/:env/test    # Test health now

GET    /api/apps/:slug/webhook             # Webhook config
PUT    /api/apps/:slug/webhook             # Configure webhook (app user)

POST   /api/apps/:slug/backup/:env         # Create backup (app user)
GET    /api/apps/:slug/backups             # List backups
POST   /api/apps/:slug/restore/:id         # Restore backup (app user)
POST   /api/apps/:slug/copy-data           # Copy prod data→sandbox (app user)

GET    /api/apps/:slug/logs/:env           # App logs
GET    /api/apps/:slug/audit               # App audit log
GET    /api/audit                          # Global audit log (admin)

GET    /api/apps/:slug/metrics/:env        # App metrics
GET    /api/server/health                  # Server health (admin)

POST   /api/apps/:slug/deployment-key      # Create scoped deployment key (admin)
GET    /api/users                          # List users (admin)
POST   /api/users                          # Create user (admin)
DELETE /api/users/:id                      # Delete user (admin)
POST   /api/users/:id/regenerate-key       # New API key (admin)
PUT    /api/users/:id/password             # Set/change password (admin)
PUT    /api/users/:id/profile              # Update profile (admin)
PUT    /api/apps/:slug/roles               # Set per-app identity role (admin)
GET    /api/apps/:slug/identity/users      # List app identity users with roles (admin)

GET    /api/apps/:slug/notifications       # Notification config
PUT    /api/apps/:slug/notifications       # Configure notifications (app user)
POST   /api/apps/:slug/notifications/test  # Send test email (app user)

POST   /api/apps/:slug/deploy/upload        # Upload artifact + deploy in one step (app user)
POST   /api/apps/:slug/upload/:env         # Upload app bundle only — does NOT deploy (app user)

GET    /api/settings                       # All settings (app user)
GET    /api/settings/:key                  # Single setting value (app user)
PUT    /api/settings/:key                  # Update setting (admin only)
```

## Quick Reference

All commands use your API key: `-H "X-API-Key: $KEY"`

### App Management

| Action | Command |
|--------|---------|
| List my apps | `curl -s -H "X-API-Key: $KEY" $CC/api/apps` |
| Create app | `curl -s -X POST $CC/api/apps -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"name":"AppName","slug":"appslug","source_type":"github","github_url":"https://github.com/yourorg/repo"}'` |
| App details | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG` |
| Delete app | `curl -s -X DELETE "$CC/api/apps/SLUG?confirm=true" -H "X-API-Key: $KEY"` |

### Deployment

| Action | Command |
|--------|---------|
| Deploy from GitHub | `curl -s -X POST $CC/api/apps/SLUG/deploy/sandbox -H "X-API-Key: $KEY"` |
| Deploy artifact (upload) | `curl -s -X POST $CC/api/apps/SLUG/deploy/upload -H "X-API-Key: $KEY" -F "file=@artifact.zip" -F "env=sandbox" -F "commit_sha=$SHA"` |
| Promote sandbox to prod | `curl -s -X POST $CC/api/apps/SLUG/promote -H "X-API-Key: $KEY"` |
| Rollback | `curl -s -X POST $CC/api/apps/SLUG/rollback/production -H "X-API-Key: $KEY"` |
| Deploy history | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/deployments/ENV` |
| Deploy log | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/deployments/ENV/ID/log` |

### Environment Variables

| Action | Command |
|--------|---------|
| Set env vars | `curl -s -X PUT $CC/api/apps/SLUG/env/ENV -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"vars":{"DATABASE_URL":"...","API_KEY":"..."}}'` |
| List env vars | `curl -s -H "X-API-Key: $KEY" "$CC/api/apps/SLUG/env/ENV?reveal=true"` |
| Delete env var | `curl -s -X DELETE $CC/api/apps/SLUG/env/ENV/VARNAME -H "X-API-Key: $KEY"` |

### Health & Monitoring

| Action | Command |
|--------|---------|
| Health status | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/health/ENV` |
| Test health now | `curl -s -X POST $CC/api/apps/SLUG/health/ENV/test -H "X-API-Key: $KEY"` |
| Configure health | `curl -s -X PUT $CC/api/apps/SLUG/health/ENV -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"endpoint":"/api/health","interval_sec":30,"fail_threshold":3,"down_threshold":5}'` |
| Live version | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/live-version/ENV` |
| App logs | `curl -s -H "X-API-Key: $KEY" "$CC/api/apps/SLUG/logs/ENV?lines=100"` |

### Webhooks & Backups

| Action | Command |
|--------|---------|
| Webhook config | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/webhook` |
| Enable auto-deploy | `curl -s -X PUT $CC/api/apps/SLUG/webhook -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"auto_deploy_sandbox":true,"auto_deploy_prod":false}'` |
| Create backup | `curl -s -X POST $CC/api/apps/SLUG/backup/ENV -H "X-API-Key: $KEY"` |
| List backups | `curl -s -H "X-API-Key: $KEY" $CC/api/apps/SLUG/backups` |
| Restore backup | `curl -s -X POST $CC/api/apps/SLUG/restore/BACKUP_ID -H "X-API-Key: $KEY"` |

## Key Rules

1. **Your deployment key is scoped to one app.** It lets you deploy, rollback, promote, manage env vars, and check health for that app only. It cannot access other apps or hub administration.
2. **Each app has TWO environments**: `production` and `sandbox`. Use ENV = `production` or `sandbox` in URLs.
3. **SLUG** is the app's URL-safe identifier (e.g., `myapp`). Lowercase, alphanumeric with dashes.
4. **Promote copies CODE only** from sandbox to production. It never copies .env or /data/.
5. **Rollback** swaps to the previous deployment. Last 5 releases are kept.
6. **deployhub.json** manifest is required in each app's root directory.
7. **Env vars** are encrypted at rest.
8. **Ports are internal.** AppCrane assigns them automatically. Apps are accessed at `{CRANE_DOMAIN}/{slug}` and `{CRANE_DOMAIN}/{slug}-sandbox`, never by port directly.
9. **data/** directory persists across deploys. Store SQLite DBs and uploads there.
10. **Identity is enforced automatically at the proxy level.** Caddy blocks unauthenticated requests before they reach your app — you do not need to implement login redirects or callbacks. If your app needs user/role info, read `req.cookies.cc_token` and call `/api/identity/verify`. Identity users (managed via `/api/identity/*`) are entirely separate from deployment API keys (X-API-Key).
11. **node_modules/** is reinstalled on every deploy. Don't rely on local state in it.
12. **NEVER change a GitHub repository from private to public.** If the repo is private, keep it private. Use a GitHub token when creating the app to access private repos. Do not alter repository visibility settings.
13. **ALWAYS deploy to sandbox first.** Never deploy directly to production. The workflow is: deploy to sandbox → test → promote to production. This protects production from broken code.
14. **ALWAYS set a `description`** when creating an app. It is shown to users on the login portal under the app name. Keep it one sentence, plain English (e.g. `"Track and manage your marketing campaigns"`). Set it in `POST /api/apps` or update it later with `PUT /api/apps/SLUG`.

## Branding Guidelines

**Read branding guidelines before building any UI — treat it like reading this agent guide.**

Just as you fetched this guide at the start of your session, fetch the branding settings now:

```bash
curl -s $CC/api/settings/branding -H "X-API-Key: $KEY"
# Returns: { "key": "branding", "value": "...", "updated_at": "..." }
```

Extract the value:

```bash
BRANDING=$(curl -s $CC/api/settings/branding -H "X-API-Key: $KEY" | jq -r '.value')
```

If `value` is non-null, apply those guidelines to everything you build: colors, fonts, border radius, tone of voice, layout conventions. If `value` is null or empty, use sensible defaults (dark theme, clean minimal UI, `#3b82f6` accent blue).

---

## Best Practices

After delivering an initial working version of the app, walk through the following best practices **one at a time**. For each one, ask the user before applying it:

> "Would you like me to apply this best practice: [one-sentence description]?"

Wait for a yes/no before moving to the next item. Never batch them or apply them silently.

### BP-1: Do not display time or date in the UI

**Ask:** *"Would you like me to remove any live clocks or current-date displays from the UI?"*

- Do **not** render the current time or date anywhere in the interface — no live clocks, no "Today is …" banners, no date headers in sidebars or footers.
- Timestamps on individual data rows (e.g. "Created 3 hours ago", a `created_at` column from the database) are fine — they describe the data, not the current moment.
- Check: page headers, footers, dashboards, sidebars, any `setInterval` or `Date.now()` call that feeds a displayed value.
- Reason: live clocks add visual noise, create timezone confusion for multi-region users, and are rarely actionable for the end user.

---

## Typical Workflow (for an AI agent)

You have an API key. Here's the full flow to build and deploy an app:

0. **Read branding guidelines** (same as you read this guide):
   `curl -s $CC/api/settings/branding | jq -r '.value'`
   Apply any guidelines returned before writing a single line of UI code.
1. Build your app (React frontend + Express backend)
   After the initial UI is ready, **ask the user**:
   > "Would you like to apply your organization's branding colors to the app?"
   - If **yes**: open the main stylesheet (typically the `:root {}` block at the top of your CSS file or `<style>` tag) and show the user the key CSS variables to change:
     ```css
     :root {
       --bg:       #0f1117;   /* page background */
       --surface:  #1a1d27;   /* card / panel background */
       --surface2: #222536;   /* input / secondary surface */
       --border:   #2a2d3a;   /* border color */
       --text:     #e4e4e7;   /* primary text */
       --dim:      #71717a;   /* secondary / muted text */
       --accent:   #3b82f6;   /* primary brand color — change this first */
       --green:    #22c55e;   /* success */
       --red:      #ef4444;   /* error / destructive */
       --yellow:   #f59e0b;   /* warning */
     }
     ```
     Tell the user: *"Change `--accent` to your brand color (e.g. `#e85d26`). You can also adjust `--bg` and `--surface` for a light or custom-colored theme. The rest will follow automatically."*
   - If **no**: keep the defaults and continue.
2. Add `deployhub.json` to the root (see manifest section above)
3. Add `/api/health` endpoint that returns `{ status: 'ok', version: '1.0.0' }`
4. Push to GitHub
5. Create the app on AppCrane (auto-assigns you):
   `POST /api/apps` with `{ "name": "My App", "slug": "myapp", "description": "One sentence shown to users on the login portal", "source_type": "github", "github_url": "https://github.com/..." }`
6. Set sandbox env vars → `PUT /api/apps/myapp/env/sandbox`
7. Deploy to sandbox → `POST /api/apps/myapp/deploy/sandbox`
8. Test health → `POST /api/apps/myapp/health/sandbox/test`
9. Set prod env vars → `PUT /api/apps/myapp/env/production`
10. Promote to production → `POST /api/apps/myapp/promote`
11. If broken, rollback → `POST /api/apps/myapp/rollback/production`

**You do NOT need admin help.** Your API key can create apps, deploy, manage env vars, and monitor health.

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Deploy fails at npm install | Missing dependencies in package.json | Add missing packages, push, redeploy |
| Deploy fails at build | Build command wrong in deployhub.json | Fix `fe.build` in deployhub.json |
| Health check fails | App not starting correctly | Check deploy log, ensure `app.listen(process.env.PORT \|\| 3000)` |
| Health check 404 | Wrong health endpoint | Fix `be.health` in deployhub.json or `PUT /health/ENV` config |
| App crashes after deploy | Check deploy log | `GET /api/apps/SLUG/deployments/ENV/ID/log` |
| Container restart-loops with `Cannot find package 'X'` | App is a monorepo (subdir `package.json`) but `be.workdir`/`fe.workdir` not set | Add `be.workdir` (and `fe.workdir` if applicable) to `deployhub.json` so AppCrane installs deps in the right directory |
| Build succeeds but runtime fails on missing deps | Same as above — flat-layout install only ran at root | Add `be.workdir` pointing at the backend folder |
| Env var missing | Not set for this environment | `PUT /api/apps/SLUG/env/ENV` with the missing var |
| Database lost after deploy | DB file stored inside the image layer instead of `/data` | Move SQLite to `/data/app.db`; in code, use `process.env.DATA_DIR \|\| './data'` as the base path |
| `SQLITE_CANTOPEN` / `unable to open database file` at runtime | Relative path resolves inside the read-only image | Switch to absolute `/data/...` path or `process.env.DATA_DIR` — never a relative or `__dirname`-based path |
| UI shows stale/seed data, operator sees different data on host | App resolved data dir to a relative path — reads from image, not from mounted volume | Run the 3-line diagnostic below; switch to `/data` or `process.env.DATA_DIR` |
| Can't deploy (403) | Wrong API key or not assigned | Check with admin, use app user key not admin key |

#### Runbook: writes are not persisting

If users report data loss after deploys, or the UI disagrees with what the
operator sees on the host, run these three commands in order:

```bash
# 1. What the container sees at /data
docker exec appcrane-<slug>-<env> ls -la /data/

# 2. What's actually on the host (the persistent volume)
ssh root@<appcrane-host> ls -la /root/appCrane/data/apps/<slug>/<env>/shared/data/

# 3. Is there a *second* data file baked into the image?
docker exec appcrane-<slug>-<env> sh -c 'cat /data/db.json | head; echo; find / -name db.json 2>/dev/null'
```

If (1) and (2) show different files, or (3) reveals a `db.json` (or `app.db`,
etc.) inside the image at a path like `/app/data/`, the app is reading the
image copy instead of the mounted volume. Fix by switching the data path in
code to `process.env.DATA_DIR` (always `/data` in the container).

## Identity Manager

AppCrane acts as a central identity provider for all managed apps. Users log in once at AppCrane and get access to all their assigned apps.

### How authentication works (automatic enforcement)

**You do not need to implement a login redirect or callback route.** AppCrane enforces authentication at the Caddy proxy level before any request reaches your app:

1. User visits `crane.example.com/myapp`
2. Caddy calls `crane.example.com/api/identity/verify?app=myapp` with the user's `cc_token` cookie
3. If no valid session → Caddy redirects the browser to the AppCrane login page automatically
4. User logs in at AppCrane → `cc_token` cookie is set for `crane.example.com`
5. User is sent back to your app — this time the cookie is present, Caddy allows the request through

Your app receives only authenticated requests. The `cc_token` cookie is available in `req.cookies.cc_token` if your app needs to identify the user.

### Getting user info in your app

If your app needs the user's name, email, or role (e.g., to show a profile or enforce role-based access), call the verify endpoint using the cookie AppCrane already set:

```bash
curl -s -H "Authorization: Bearer SESSION_TOKEN" \
  $CC/api/identity/verify?app=YOUR_SLUG
```

Response:
```json
{
  "user": { "id": 1, "name": "Sarah", "email": "sarah@example.com", "username": "sarah", "avatar_url": null, "phone": null, "year_of_birth": 1990 },
  "role": "admin",
  "app": "myapp"
}
```

**Role values:** `admin` (full access), `user` (standard access). Users with no role are blocked before reaching your app.

### Identity endpoints (no X-API-Key needed)

```bash
# Login (returns token + user + apps list)
curl -s -X POST $CC/api/identity/login \
  -H "Content-Type: application/json" \
  -d '{"login":"sarah@example.com","password":"xxx","app":"myapp"}'

# Verify token (app calls this to check user)
curl -s -H "Authorization: Bearer TOKEN" "$CC/api/identity/verify?app=myapp"

# Get user profile from token
curl -s -H "Authorization: Bearer TOKEN" $CC/api/identity/me

# Logout
curl -s -X POST $CC/api/identity/logout -H "Authorization: Bearer TOKEN"
```

### Admin: manage identity users

```bash
# Create user with password
curl -s -X POST $CC/api/users -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Sarah","email":"sarah@example.com","username":"sarah","password":"temp123","phone":"+1234567890","year_of_birth":1990}'

# Set/change password
curl -s -X PUT $CC/api/users/2/password -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"password":"newpass123"}'

# Update profile
curl -s -X PUT $CC/api/users/2/profile -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"avatar_url":"https://example.com/avatar.jpg","phone":"+1234567890"}'

# Set per-app role (admin/user/viewer)
curl -s -X PUT $CC/api/apps/myapp/roles -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"user_id":2,"app_role":"admin"}'

# List users + roles for an app
curl -s -H "X-API-Key: $KEY" $CC/api/apps/myapp/identity/users
```

### App roles
- **admin** -- full access within the app
- **user** -- standard access
- **viewer** -- read-only access

Roles are per-app. A user can be admin on MyApp but viewer on another app.

### User fields available to apps
| Field | Type | Description |
|-------|------|-------------|
| id | int | Stable user ID across all apps |
| name | string | Display name |
| email | string | Email address |
| username | string | Login username |
| avatar_url | string | Profile picture URL |
| phone | string | Phone number |
| year_of_birth | int | Year of birth |
| role | string | Role for THIS app (admin/user/viewer) |

### Implementing auth in your app (code examples)

> **Caddy handles the auth gate automatically.** You do NOT need a login redirect or `/auth/callback` route. Every request that reaches your app is already authenticated. The sections below are only needed if you want user/role information inside your app.

**Backend (Express) -- optional user-info middleware:**

```javascript
// auth.js -- add to your Express app if you need user context

const CRANE_URL = process.env.CRANE_URL || 'https://crane.example.com';
const APP_SLUG = process.env.APP_SLUG || 'myapp';
// Your app is at: CRANE_URL/APP_SLUG (production) and CRANE_URL/APP_SLUG-sandbox (sandbox)

// Middleware: fetch user info from AppCrane using the cc_token cookie.
// Only needed if your app uses req.user or req.userRole.
// Caddy already blocked unauthenticated requests before they reach here.
async function loadUser(req, res, next) {
  const token = req.cookies?.cc_token;
  if (!token) return next(); // shouldn't happen (Caddy blocks unauthenticated requests)

  try {
    const r = await fetch(`${CRANE_URL}/api/identity/verify?app=${APP_SLUG}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (r.ok) {
      const data = await r.json();
      req.user = data.user;      // { id, name, email, username, avatar_url, phone, year_of_birth }
      req.userRole = data.role;  // 'admin' or 'user'
    }
  } catch (_) {}
  next();
}

// Optional: enforce a minimum role on specific routes
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Logout: invalidate session at AppCrane and clear cookie
app.post('/auth/logout', async (req, res) => {
  const token = req.cookies?.cc_token;
  if (token) {
    await fetch(`${CRANE_URL}/api/identity/logout`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).catch(() => {});
  }
  res.clearCookie('cc_token');
  res.redirect('/');
});

// API: get current user (for frontend to fetch)
app.get('/api/me', loadUser, (req, res) => {
  res.json({ user: req.user || null, role: req.userRole || null });
});

// Example: admin-only route
app.get('/api/admin/settings', loadUser, requireRole('admin'), (req, res) => {
  res.json({ settings: '...' });
});
```

**Frontend (React) -- check auth and show user:**

```javascript
// useAuth.js -- React hook for user info
import { useState, useEffect } from 'react';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { setUser(data.user); setRole(data.role); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return {
    user,           // { id, name, email, avatar_url, ... }
    role,           // 'admin' or 'user'
    loading,
    isAdmin: role === 'admin',
    logout: () => fetch('/auth/logout', { method: 'POST' }).then(() => window.location.reload()),
  };
}

// App.jsx -- use it
function App() {
  const { user, role, loading, isAdmin, logout } = useAuth();

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <header>
        <span>Welcome {user?.name}</span>
        <span>{isAdmin ? 'Admin' : 'User'}</span>
        {user?.avatar_url && <img src={user.avatar_url} alt="" />}
        <button onClick={logout}>Logout</button>
      </header>
      {/* Your app content — all users here are already authenticated */}
    </div>
  );
}
```

**Required env var for your app:**
```
CRANE_URL=https://crane.example.com
APP_SLUG=myapp
```
Your app is accessible at `$CRANE_URL/$APP_SLUG` — no additional domain configuration needed.

Set via AppCrane: `PUT /api/apps/myapp/env/production`

## Full API docs with examples

Visit: `$CC/docs` (e.g., https://crane.example.com/docs)
