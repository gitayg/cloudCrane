# BUG: AGENT_GUIDE.md does not call out the APP_BASE_PATH gotcha

**Component:** AppCrane / docs
**Severity:** Low (docs-only, but high cumulative pain)
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

The Vite section of `AGENT_GUIDE.md` was recently updated to use
`base: process.env.APP_BASE_PATH || './'`, but does not explicitly explain
the **build-time vs serve-time** asymmetry, nor warn against using
`APP_BASE_PATH` on backend routes.

## Proposed addition

Add a "Common pitfalls" callout to AGENT_GUIDE.md under the AppCrane section:

```markdown
> **Pitfall: APP_BASE_PATH is serve-time only**
>
> AppCrane injects `APP_BASE_PATH` into the container at *runtime*, not
> at *build time*. Caddy strips this prefix from incoming requests before
> they reach your container.
>
> ✅ **Frontend (Vite):** use `base: './'` so emitted asset URLs are
> relative and work at any sub-path. Do NOT rely on reading
> `APP_BASE_PATH` in `vite.config.js` — it isn't set at build time.
>
> ✅ **Backend (Express/Fastify/etc.):** mount routes at `/`, not at
> `${APP_BASE_PATH}`. Caddy already stripped the prefix.
>
> ❌ Prefixing backend routes with `APP_BASE_PATH` will cause every
> request to 404.
```

## Why now

This pitfall has hit at least one recent deployment (navi-pl) and the
root cause was misreading the env var as bidirectional.

## Acceptance

- AGENT_GUIDE.md has an explicit, fenced "common pitfalls" block.
- Block uses ✅/❌ for visual distinction.
- Block lives next to the existing Vite recommendation.
