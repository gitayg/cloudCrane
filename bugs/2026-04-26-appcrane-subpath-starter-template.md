# FEATURE: Provide a sub-path SPA + API starter template

**Component:** AppCrane
**Severity:** Medium (preventative)
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-26

## Summary

The most reliable way to prevent `APP_BASE_PATH` confusion is to ship a
working starter template that demonstrates the correct configuration end
to end. Right now users assemble it from docs, mostly correctly, with
occasional silent misconfigurations.

## Proposed template

A `crane init --template subpath-spa` (or similar) that scaffolds:

```
my-app/
├── frontend/
│   ├── vite.config.js          # base: './' fallback
│   ├── package.json            # build → dist/
│   └── src/...
├── server/
│   ├── index.js                # Express on '/', routes NOT prefixed
│   ├── routes/
│   └── package.json
├── Dockerfile                   # multi-stage: build frontend, copy to server/public, run node
└── README.md                    # explains build-time vs serve-time
```

Key design points the template demonstrates:

1. **Vite `base: process.env.APP_BASE_PATH || './'`** — relative-fallback
   pattern that works even when AppCrane doesn't inject at build time.
2. **Express routes mounted at `/`** — explicit comment: "Caddy strips
   the sub-path; do not prefix routes."
3. **Health check at `/api/health`** — confirms the at-`/` mount works.
4. **Static file serve from `dist/`** — frontend assets resolve under
   any sub-path because their URLs are relative.

## Acceptance

- `crane init --template subpath-spa` produces a working app.
- Deploying the template under any sub-path "just works" without code edits.
- README in the template includes the same "common pitfalls" block as
  AGENT_GUIDE.md.

## Related

- `2026-04-26-appcrane-app-base-path-docs.md`
- `2026-04-26-appcrane-app-base-path-semantics.md`
