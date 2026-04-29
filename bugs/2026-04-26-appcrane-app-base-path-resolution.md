# RESOLUTION: APP_BASE_PATH becomes build-time only

**Component:** AppCrane
**Status:** Implemented 2026-04-26 (v1.17.0)
**Decision owner:** itay.glick@opswat.com

## Decision

Ship two things together:

### Option 2 (code) — flip the injection point

Stop injecting `APP_BASE_PATH` into the **container runtime env**. Inject
it instead into the **build environment** (so Vite's bundler reads it
for `base`).

After this change:

| Phase | APP_BASE_PATH | Why |
|---|---|---|
| Build (Vite) | **Set** | Bundler emits asset URLs with the slug prefix the browser will send |
| Serve (Node, Express, etc.) | **Unset** | Caddy already strips the prefix; backends mount at `/` |

This makes the env var **accidentally safe**: a backend that does
`app.use(\`${process.env.APP_BASE_PATH}/api\`, ...)` reduces to
`app.use('/api', ...)` at runtime — i.e. the right thing — because
`APP_BASE_PATH` is undefined when the container runs.

### Option 3 (docs) — prominent callout

Add a callout in `/agent-guide` and `/docs`:

> **Sub-path apps:** mount your backend at `/`. The slug prefix is
> stripped by Caddy before requests reach your container.
> `APP_BASE_PATH` is for the bundler only.

## Why this approach

- **Symmetric with reality:** Caddy strips the prefix → backends mount
  at `/`. The env var should match where it's actually needed (build).
- **Backwards compatible by accident:** existing apps that mistakenly
  wrote `${process.env.APP_BASE_PATH}/api/...` keep working without
  edits, because the var is now unset at runtime.
- **Zero new surface area:** no rename, no second var, no diagnostic
  probes. Just remove an env injection and add a build-time one.

## Migration impact

| App pattern | Before fix | After fix |
|---|---|---|
| Backend mounted at `/` (correct) | works | works |
| Backend mounted at `${APP_BASE_PATH}` (wrong) | broken | **works** (var is unset → reduces to `/`) |
| Vite `base: './'` | works | works |
| Vite `base: process.env.APP_BASE_PATH` | broken at build (var unset) | **works** (now injected at build) |

navi-pl ships as-is once the deploy completes against the fixed AppCrane.

## What this supersedes

- `2026-04-26-appcrane-app-base-path-rename.md` — rename / split-var
  options are no longer needed; the variable is unambiguous because
  it only exists in one phase.
- `2026-04-26-appcrane-healthcheck-prefix-diagnostic.md` — lower
  priority. The class of bug it diagnosed (backend prefixed with
  `APP_BASE_PATH`) cannot occur after this change.
- `2026-04-26-appcrane-boot-route-inspection.md` — same; lower
  priority once Option 2 ships.

## What still applies

- `2026-04-26-appcrane-app-base-path-docs.md` — Option 3 above replaces
  the proposed callout text. Update the AGENT_GUIDE Vite recommendation
  to: `base: process.env.APP_BASE_PATH || './'` (still correct — the
  var will now actually be set at build, and `./` remains a safe
  fallback).
- `2026-04-26-appcrane-subpath-starter-template.md` — still valuable
  as an onboarding aid; should adopt the post-fix pattern.

## Acceptance

- AppCrane no longer sets `APP_BASE_PATH` in container runtime env.
- AppCrane sets `APP_BASE_PATH` in the build environment passed to
  the bundler step.
- AGENT_GUIDE has the callout in Option 3.
- `crane.glick.run` deploy of navi-pl succeeds without app-side changes.

## Implementation (v1.17.0, 2026-04-26)

- `server/services/deployer.js` — removed `APP_BASE_PATH` from
  `runtimeEnvVars`; pass `appBasePath` through to `buildImageIfNeeded`.
- `server/routes/deploy.js` — removed `APP_BASE_PATH` from the
  restart-with-env-update path.
- `server/services/docker.js` — `buildImage` / `buildImageIfNeeded`
  accept `appBasePath` and emit `--build-arg APP_BASE_PATH=…` (plus
  `PUBLIC_URL` and `VITE_BASE_PATH` for CRA/Vite ergonomics).
- `server/services/dockerfileGen.js` — auto-generated Dockerfiles now
  scope `APP_BASE_PATH` / `PUBLIC_URL` / `VITE_BASE_PATH` to the build
  `RUN` command only (no `ENV` declaration), so they don't persist
  into the runtime image.
- `server/services/dockerfileValidator.js` — dropped `APP_BASE_PATH`
  from `MANAGED_VARS` (no longer runtime-managed).
- `AGENT_GUIDE.md` — replaced the build+runtime split with a build-only
  description, added the prominent "Sub-path apps: APP_BASE_PATH is
  for the bundler only" callout, added a note for user-provided
  Dockerfiles to declare `ARG APP_BASE_PATH`.

### Migration note for user-provided Dockerfiles

Previously, AppCrane injected `APP_BASE_PATH` into the runtime env, so
user Dockerfiles that ran a build step would only see it if they had
their own `ENV APP_BASE_PATH=…` line — meaning bundler `base` config
relying on this var was already inconsistent. Now the var is passed
explicitly as `--build-arg`, and Dockerfiles that want it must declare
`ARG APP_BASE_PATH` near the top.
