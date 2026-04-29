# AppCrane bug reports — index

| Date | File | Severity | Title |
|---|---|---|---|
| 2026-04-26 | [app-base-path-semantics](2026-04-26-appcrane-app-base-path-semantics.md) | Medium | Root issue: APP_BASE_PATH conflates two semantics |
| 2026-04-26 | [app-base-path-docs](2026-04-26-appcrane-app-base-path-docs.md) | Low | AGENT_GUIDE.md missing common-pitfalls callout |
| 2026-04-26 | [app-base-path-rename](2026-04-26-appcrane-app-base-path-rename.md) | Medium | Rename or split env var to disambiguate |
| 2026-04-26 | [subpath-starter-template](2026-04-26-appcrane-subpath-starter-template.md) | Medium | Ship a working sub-path SPA + API starter |
| 2026-04-26 | [healthcheck-prefix-diagnostic](2026-04-26-appcrane-healthcheck-prefix-diagnostic.md) | Medium | Health-check should diagnose prefix misconfig |
| 2026-04-26 | [boot-route-inspection](2026-04-26-appcrane-boot-route-inspection.md) | Low | Proactive boot-time route inspection |

## Theme

All six reports trace back to a single root cause: `APP_BASE_PATH` is
serve-time only, while users naturally read it as bidirectional. The
reports cover docs (cheap), starter template (medium effort), runtime
diagnostics (more invasive), and a longer-term API rename.

## Suggested implementation order

1. **Docs** (`app-base-path-docs`) — same-day fix, prevents new occurrences.
2. **Starter template** (`subpath-starter-template`) — captures the
   correct pattern in code.
3. **Health-check diagnostic** (`healthcheck-prefix-diagnostic`) — turns
   silent failures into actionable errors.
4. **Boot-time inspection** (`boot-route-inspection`) — proactive layer
   on top of (3).
5. **Build-time injection / rename** (`app-base-path-rename`) — larger
   API change, schedule for next minor.
