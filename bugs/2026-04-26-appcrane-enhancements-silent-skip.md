# BUG: Enhancement enqueue silently skips when ANTHROPIC_API_KEY is missing

**Component:** AppCrane / AppStudio
**Severity:** Medium (UX — forever-spinner)
**Status:** Implemented 2026-04-26 (v1.17.1)
**Reporter:** itay.glick@opswat.com

## Symptom

When `ANTHROPIC_API_KEY` is not set in the AppCrane env, submitting an
enhancement request via `POST /api/enhancements` succeeds (request is
inserted with status `'new'`) but **no job is enqueued**. The
`enhancement_jobs` table has no row for the request. The dashboard
shows the request stuck with no job status and no error — a
forever-spinner.

## Root cause

`server/routes/enhancements.js:66` wraps the `INSERT INTO
enhancement_jobs` call in `if (process.env.ANTHROPIC_API_KEY)` with no
`else` branch, so the missing-key path silently does nothing.

## Fix

If the key is missing, still insert the job — but pre-failed:

```js
INSERT INTO enhancement_jobs (enhancement_id, phase, status,
  error_message, finished_at)
VALUES (?, 'plan', 'failed', 'ANTHROPIC_API_KEY not configured',
  datetime('now'))
```

The `/api/enhancements` list response already exposes `latest_job_status`
and `latest_job_error`, so the dashboard renders the actionable error
without any UI change.

## Acceptance

- Submitting an enhancement when the key is missing produces a job row
  with `status='failed'` and a clear `error_message`.
- Dashboard shows the failure instead of spinning.
- Submitting when the key IS present continues to work unchanged.
