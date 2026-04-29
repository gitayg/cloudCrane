# FEATURE: Boot-time route inspection for sub-path deployments

**Component:** AppCrane
**Severity:** Low
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

Complement the health-check diagnostic with a proactive boot-time check.
Right after a container starts on a sub-path deploy, AppCrane probes both
the configured paths and their prefixed variants and warns if the
container only responds to the prefixed ones.

## Proposed behavior

On container start (sub-path deploy only):

1. Wait for container to bind to the port.
2. Probe both:
   - `GET /` (and `/api/health`)
   - `GET ${APP_BASE_PATH}/` (and `${APP_BASE_PATH}/api/health`)
3. Compare:
   - Both at-`/` succeed → ✅ correct mounting, no warning.
   - Only prefixed succeed → ⚠️ log structured warning (same shape as
     the health-check diagnostic).
   - Both fail → defer to standard health-check failure handling.

## Why proactive

Health-check diagnostic (companion bug) only fires *after* a deploy is
declared failed. Boot-time inspection lets us flag the misconfiguration
before the user sees a generic failure, and lets us still mark the deploy
"live but misconfigured" if the user has no health check configured.

## Caveats

- Only run for apps where `APP_BASE_PATH` is non-empty.
- Skip apps that explicitly opt out (e.g. `crane.skip_route_inspection: true`
  in deployhub.json).
- Cap inspection time at e.g. 3 seconds — must not delay deploy ready.

## Acceptance

- Boot-time probe runs on sub-path deploys only.
- Mismatch logs an actionable warning to the deploy log.
- Deploy is not blocked by the inspection; it's purely advisory.

## Related

- `2026-04-26-appcrane-healthcheck-prefix-diagnostic.md`
- `2026-04-26-appcrane-app-base-path-semantics.md`
