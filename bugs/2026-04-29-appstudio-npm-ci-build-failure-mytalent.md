# BUG: AppStudio Docker build fails with npm ci usage-help output on mytalent

**Component:** AppStudio — build phase
**Severity:** High (blocks every AppStudio deployment on mytalent)
**Reporter:** itay.glick@opswat.com
**Date:** 2026-04-29
**Enhancement request:** #48 (mytalent — category filter on table header)

## Summary

AppStudio's build phase fails on the `npm ci --omit=dev` step inside the
generated Docker image. npm prints its own usage/help text instead of
installing packages, and exits with code 1. The failure is reproducible
across multiple retry attempts on the same enhancement (#48).

## Error (job #147, 2026-04-29 00:26:16)

```
docker build failed:
ror [--no-bin-links] [--no-fund] [--dry-run]
npm error [-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]
npm error [-ws|--workspaces] [--include-workspace-root] [--install-links]
npm error
npm error aliases: clean-install, ic, install-clean, isntall-clean
npm error
npm error Run "npm help ci" for more info

npm error A complete log of this run can be found in:
  /root/.npm/_logs/2026-04-29T00_26_17_889Z-debug-0.log

The command '/bin/sh -c if [ -f package-lock.json ]; then npm ci --omit=dev;
else npm install --omit=dev; fi' returned a non-zero code: 1
```

The truncated `"ror"` at the start is the tail of `"Error"` — AppCrane's
`outputBuf.slice(-800)` clips the beginning of npm's error output.

npm prints its usage guide when `npm ci` is invoked with an unrecognised
flag or receives an argument it cannot parse. Since `--omit=dev` is valid
in npm 10.8.2 (the version on `node:20-alpine`), the likely cause is that
AppStudio modified `package.json` (adding Vitest / @testing-library/react
devDependencies per its plan) without regenerating `package-lock.json`.
A `package-lock.json` that is out of sync causes `npm ci` to abort with an
error that includes the command's usage text.

## Reproduction

1. Enhancement #48 on mytalent — AppStudio plan adds devDependencies
   (`vitest`, `@testing-library/react`) to `package.json` but does not
   run `npm install` to regenerate `package-lock.json`.
2. `npm ci` sees a mismatch between `package.json` and `package-lock.json`,
   exits 1, and prints help text.
3. AppCrane's `outputBuf.slice(-800)` captures only the npm help text —
   the actual sync-error message is lost.

## Root cause hypothesis

AppStudio's code agent edits `package.json` to add new dependencies but
does not regenerate `package-lock.json` in the same commit. The Dockerfile
build step then runs `npm ci`, which requires the lock file to be in sync.

## Fix recommendation

In AppStudio's code-generation phase, after any `package.json` edit that
adds or removes dependencies, run `npm install` (or `npm install --package-lock-only`)
inside the working directory to regenerate `package-lock.json` and commit
it alongside the source changes.

Alternatively, change the generated Dockerfile install command to
`npm install --omit=dev` unconditionally when AppStudio detects that
devDependencies were added — `npm install` tolerates a stale or missing
lock file.

## Secondary issue: error truncation masks root cause

`docker.js` line 90 uses `outputBuf.slice(-800)` for the error message.
The deprecation warning from the legacy Docker builder consumes ~200 chars
of that budget, and npm's usage help text is long — the actual
`"npm error: Missing or invalid package-lock.json"` line is pushed out
of the window. The logged error appears to be a flag-parsing error rather
than a lock-file sync error.

**Related:** `2026-04-28` billboard deployment failure had the same
symptom (npm ci exit code 1, error truncated) for the same underlying
reason (outputBuf.slice(-800)).

## Workaround

Delete enhancement #48 and re-submit without the test-file additions, or
manually regenerate `package-lock.json` in the AppStudio branch before
re-triggering the build.
