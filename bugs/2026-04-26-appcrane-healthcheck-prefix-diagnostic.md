# FEATURE: Health-check should diagnose sub-path prefix misconfiguration

**Component:** AppCrane
**Severity:** Medium
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

When a user deploys a sub-path app and incorrectly prefixes their backend
routes with `APP_BASE_PATH`, the AppCrane health probe gets a 404 from
the container. The only signal is "health check failed" — the user has
no easy way to know *why*.

## Proposed enhancement

When the health probe at the configured path (e.g. `/api/health`) returns
404, AppCrane should automatically retry the probe at the *prefixed* path
(`${APP_BASE_PATH}/api/health`). If that prefixed path returns 200, the
health-check log should surface a specific actionable error:

```
Health check failed at /api/health (404)
↳ Detected: container responds at /navi-pl/api/health (200)
↳ Likely cause: backend routes are prefixed with APP_BASE_PATH
↳ Caddy strips this prefix before forwarding. Mount routes at '/' instead.
↳ See: AGENT_GUIDE.md → Common pitfalls → APP_BASE_PATH
```

## Acceptance

- Failed health probes try the prefixed path automatically (one-shot,
  not on every retry).
- If the prefixed probe succeeds, log a structured error with the above
  format — visible in the AppStudio dashboard logs panel.
- If the prefixed probe also fails, fall back to the existing "health
  check failed" message (no false positives).

## Implementation notes

- This is a one-time probe per failed deploy, not part of the steady-state
  health-check loop — keep it cheap.
- Should only fire if `APP_BASE_PATH` is non-empty (i.e. sub-path deploy).

## Related

- `2026-04-26-appcrane-app-base-path-semantics.md`
- `2026-04-26-appcrane-boot-route-inspection.md`
