# AppCrane email service — how an app sends email

AppCrane sends email on a hosted app's behalf. It is **server-side only**,
**async**, and can only deliver to **registered platform users** — an app can
never email an arbitrary address.

## Prerequisites

1. The platform admin has configured **Settings → Mail** (Microsoft Graph
   credentials). Without it, messages queue and then dead-letter to the admin.
2. The app has been **deployed on AppCrane 2.8.3+**. Every deploy injects two
   env vars into the container — no setup, no toggle, available to every app:

   | Env var | Value |
   |---|---|
   | `APPCRANE_SERVICE_TOKEN` | the app's credential for the email API |
   | `CRANE_INTERNAL_URL` | `http://host.docker.internal:5001` — AppCrane, reachable from inside the container |

   If the app is already running, **redeploy once** so the vars are present.

## The request

`POST {CRANE_INTERNAL_URL}/api/service/email`

Headers:

- `Content-Type: application/json`
- `X-AppCrane-Service-Token: {APPCRANE_SERVICE_TOKEN}`

Body fields:

| Field | Required | Notes |
|---|---|---|
| `to` | yes | Must be a registered platform user's email |
| `subject` | yes | |
| `text` | one of text/html | Plain-text body |
| `html` | one of text/html | HTML body (used over text if both given) |
| `replyTo` | no | Reply-To address |
| `fromName` | no | Sender display name. **Defaults to the app's own name** — MarketMind sends as `MarketMind <appcrane@example.com>`. Pass this to override per-send (e.g. `"IntelOP"`). The address never changes. |
| `env` | no | `sandbox` (default) or `production` |
| `idempotencyKey` | no | Safe retries — the same key never double-sends |
| `attachments` | no | Array of files: `[{ filename, content, contentType? }]`. `content` is **base64**. Max **10** files, **3 MB** total (decoded). `contentType` defaults to `application/octet-stream`. |

Returns **`202 { queued: true, queue_id }`** immediately. A worker delivers it
async (5 retries with backoff; on permanent failure the platform admin is
emailed).

## Node example

```js
async function notify(toEmail, subject, body) {
  const res = await fetch(`${process.env.CRANE_INTERNAL_URL}/api/service/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AppCrane-Service-Token": process.env.APPCRANE_SERVICE_TOKEN,
    },
    body: JSON.stringify({ to: toEmail, subject, text: body }),
  });
  if (res.status !== 202) throw new Error(`email failed (${res.status}): ${await res.text()}`);
  return res.json();
}
```

## Python example

```python
import os, requests

def notify(to_email, subject, body):
    res = requests.post(
        f"{os.environ['CRANE_INTERNAL_URL']}/api/service/email",
        headers={"X-AppCrane-Service-Token": os.environ["APPCRANE_SERVICE_TOKEN"]},
        json={"to": to_email, "subject": subject, "text": body},
    )
    res.raise_for_status()   # 202 on success
    return res.json()
```

## Attachments

Attach files by passing base64-encoded bytes. Max 10 files, 3 MB total decoded
(the cap keeps sends within Microsoft Graph's single-request budget).

```js
import { readFileSync } from "fs";
await fetch(`${process.env.CRANE_INTERNAL_URL}/api/service/email`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-AppCrane-Service-Token": process.env.APPCRANE_SERVICE_TOKEN,
  },
  body: JSON.stringify({
    to: userEmail,
    subject: "Your report",
    text: "Report attached.",
    attachments: [
      { filename: "report.pdf",
        content: readFileSync("/data/report.pdf").toString("base64"),
        contentType: "application/pdf" },
    ],
  }),
});
```

A bad attachment (missing filename, non-base64 `content`, a `filename` with path
separators or `..`, more than 10 files, or over the 3 MB total) returns `400`
and nothing is queued.

## Emailing the logged-in user

AppCrane already injects the SSO user's email on every request as
`X-AppCrane-User-Email`. Use it as the recipient — it is guaranteed to be a
platform user:

```js
const userEmail = req.headers["x-appcrane-user-email"];
await notify(userEmail, "Your report is ready", "Open the app to download it.");
```

## Rules and guarantees

- **Server-side only.** The endpoint is reachable only from the container (via
  `host.docker.internal`), 404s on the public domain, and rejects anything that
  arrived through the proxy. The token is a server env var the browser never
  sees. Never call this from frontend code.
- **Recipients are platform users only.** A non-user address returns `400`.
- **The address is platform-controlled; the display name is the app's.** From
  address is fixed (the Settings → Mail mailbox, e.g. `appcrane@example.com`). The
  display name defaults to the app's own name and can be overridden per-send
  via `fromName` — no admin setting. Apps may also set `replyTo`.

## Errors

| Status | Meaning |
|---|---|
| `202` | Queued (success) |
| `400` | Recipient is not a platform user, or subject/body missing |
| `401` | Missing or invalid `X-AppCrane-Service-Token` |
| `403` | Request reached the endpoint via the public proxy (must be internal) |
