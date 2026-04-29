# AppCrane bug reports — index

## Decision (2026-04-26)

**[app-base-path-resolution](2026-04-26-appcrane-app-base-path-resolution.md)** — flip
`APP_BASE_PATH` from serve-time-only to build-time-only, plus a docs callout.
Read this first; it supersedes parts of the reports below.

## Reports

| Date | File | Status | Title |
|---|---|---|---|
| 2026-04-26 | [app-base-path-resolution](2026-04-26-appcrane-app-base-path-resolution.md) | **Implemented v1.17.0** | Resolution: build-time only + docs callout |
| 2026-04-26 | [app-base-path-semantics](2026-04-26-appcrane-app-base-path-semantics.md) | Open (root cause) | Root issue: APP_BASE_PATH conflates two semantics |
| 2026-04-26 | [app-base-path-docs](2026-04-26-appcrane-app-base-path-docs.md) | Open — text in resolution | AGENT_GUIDE.md missing common-pitfalls callout |
| 2026-04-26 | [subpath-starter-template](2026-04-26-appcrane-subpath-starter-template.md) | Open | Ship a working sub-path SPA + API starter |
| 2026-04-26 | [app-base-path-rename](2026-04-26-appcrane-app-base-path-rename.md) | Superseded by resolution | Rename or split env var to disambiguate |
| 2026-04-26 | [healthcheck-prefix-diagnostic](2026-04-26-appcrane-healthcheck-prefix-diagnostic.md) | Lower priority post-fix | Health-check diagnoses prefix misconfig |
| 2026-04-26 | [boot-route-inspection](2026-04-26-appcrane-boot-route-inspection.md) | Lower priority post-fix | Proactive boot-time route inspection |
| 2026-04-26 | [enhancements-silent-skip](2026-04-26-appcrane-enhancements-silent-skip.md) | **Implemented v1.17.1** | Enhancement enqueue silently skips when ANTHROPIC_API_KEY missing |

## Theme

All reports trace back to a single root cause: `APP_BASE_PATH` is
currently serve-time only, while users naturally read it as bidirectional.
The decided resolution flips the injection to build-time only, which
makes the variable accidentally safe (a backend that prefixes its
routes with `APP_BASE_PATH` reduces to `/` at runtime since the var
is unset).

## Suggested implementation order

1. **Resolution** (`app-base-path-resolution`) — code (Option 2) + docs
   (Option 3). Single same-day fix; unlocks navi-pl with no app-side
   change.
2. **Starter template** (`subpath-starter-template`) — onboarding aid
   that captures the post-fix pattern.
3. **Health-check / boot-route diagnostics** — lower priority once
   the resolution ships; useful for unrelated prefix issues only.
