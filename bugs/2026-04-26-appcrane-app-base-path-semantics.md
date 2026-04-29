# BUG: APP_BASE_PATH has two distinct semantics conflated into one env var

**Component:** AppCrane
**Severity:** Medium (cause of frequent user error, not a runtime crash)
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

`APP_BASE_PATH` is a single env var that users naturally assume applies to both
the frontend bundler and the backend, but in reality only one of those is true.
The conflation reliably leads users to misconfigure backend routing on sub-path
deployments.

## What users assume

> "`APP_BASE_PATH` is the deploy sub-path. So my Vite bundler emits asset URLs
> with that prefix, *and* my backend routes also live under that prefix."

## What actually happens

- **Caddy** strips the sub-path prefix before forwarding to the container.
- **Backend** must therefore mount at `/`, not at `${APP_BASE_PATH}`.
- **Frontend** asset URLs *do* need the prefix, because the browser sends
  pre-prefix URLs that Caddy will strip.
- **AppCrane only injects `APP_BASE_PATH` at serve time, not build time** —
  so reading it in `vite.config.js` doesn't actually work unless the user
  injects it themselves before building.

The result is a single env var with two contradictory implications:
1. Use it for asset paths (build time, but not actually injected at build time).
2. *Don't* use it on backend routes (serve time, where it *is* injected).

## Reproduction

1. Deploy a Vite + Express app under sub-path `/navi-pl/`.
2. Read `process.env.APP_BASE_PATH` in `server.js` and prefix all routes with it.
3. App returns 404 on every request — Caddy already stripped the prefix.

## Impact

Every new sub-path SPA deployment is at risk of this misconfiguration. It is
the single most common AppCrane onboarding bug observed.

## Proposed fix

Tracked in companion bugs:
- `2026-04-26-appcrane-app-base-path-rename.md` — disambiguate via rename
- `2026-04-26-appcrane-app-base-path-docs.md`   — louder docs and a "common pitfalls" callout
- `2026-04-26-appcrane-subpath-starter-template.md` — provide a working template
- `2026-04-26-appcrane-healthcheck-prefix-diagnostic.md` — detect the misconfiguration at runtime
- `2026-04-26-appcrane-boot-route-inspection.md` — warn at container start
