# BUG: APP_BASE_PATH name is misleading — consider renaming or splitting

**Component:** AppCrane
**Severity:** Medium
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

The current variable name `APP_BASE_PATH` reads as "the path your app is
served under, available everywhere". In practice it only applies to one
context (serve-time) and should *not* be used in another (backend route
mounting). A clearer name, or splitting into two vars, would prevent the
recurring misconfiguration.

## Options

### Option A — Rename (cheap, breaking)

Rename `APP_BASE_PATH` → `APP_MOUNT_PATH` (or `APP_PUBLIC_PATH`).

- Pros: instantly disambiguates from "use this in your routes".
- Cons: breaks any deployments that read the env var today.
- Mitigation: keep `APP_BASE_PATH` populated as a deprecated alias for
  one minor version, log warning if read.

### Option B — Split into two vars (clearer, more work)

Inject **both**:
- `APP_PUBLIC_PATH` (build-time, available during `npm run build`) —
  for bundlers that need to emit asset URLs with a prefix.
- `APP_MOUNT_PATH` (serve-time, available at container runtime) —
  informational only; backends still mount at `/`.

This matches the actual runtime behavior and makes "should I prefix
backend routes?" a pure no-op question (`APP_MOUNT_PATH` is *informational*).

### Option C — Inject APP_BASE_PATH at build time too

Inject the same var at both build time and serve time. Users still need
to know "don't use this on backend routes", but at least Vite configs
that read it actually get a value.

## Recommendation

Start with Option C (smallest change, eliminates the build-time silent
failure) plus the Option A rename in a future major.

## Acceptance

- Decision documented in `AGENT_GUIDE.md`.
- Whichever path is chosen is implemented and the docs and starter
  template reflect it.

## Related

- `2026-04-26-appcrane-app-base-path-semantics.md`
