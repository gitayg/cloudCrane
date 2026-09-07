-- v2.8.0: app email service. Hosted apps can send email through AppCrane —
-- server-side only, async via a queue, recipients limited to known SSO users.
--
-- Why centralized: one verified sender identity (appcrane@example.com), one place
-- to enforce recipient policy + quota + audit, and apps never hold SMTP
-- creds. The app authenticates with a per-app service token injected into its
-- container env (server-side only — a browser never sees it), and POSTs to an
-- internal-only endpoint that enqueues the message. A worker drains the queue
-- and sends with retries; a dead letter pages the platform admin by email.

-- Per-app service token + display-name override. The email service is
-- available to EVERY app (no enable flag) — the deployer provisions a token on
-- first deploy and injects it into the container.
-- service_token_hash      → fast lookup of the calling app (hash of the token)
-- service_token_encrypted → the plaintext, AES-256-GCM, so the deployer can
--                           inject it into the container at start time
ALTER TABLE apps ADD COLUMN service_token_hash       TEXT;
ALTER TABLE apps ADD COLUMN service_token_encrypted  TEXT;
ALTER TABLE apps ADD COLUMN email_from_name          TEXT;

CREATE INDEX IF NOT EXISTS idx_apps_service_token ON apps(service_token_hash);

-- The queue. status: queued → sending → sent | failed.
-- source distinguishes app-originated sends from AppCrane's own
-- request-lifecycle notifications. idempotency_key (optional, per app) makes a
-- retrying caller safe against double-send.
CREATE TABLE IF NOT EXISTS email_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id          INTEGER,
  env             TEXT,
  to_email        TEXT    NOT NULL,
  from_name       TEXT,
  reply_to        TEXT,
  subject         TEXT    NOT NULL,
  body_text       TEXT,
  body_html       TEXT,
  status          TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT,
  message_id      TEXT,
  error           TEXT,
  source          TEXT    NOT NULL DEFAULT 'app',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_queue_drain ON email_queue(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_queue_idem ON email_queue(app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Sender identity, configurable in Settings → Mail. Address is the Graph
-- mailbox (fixed platform-wide); per-app override is display-name only
-- (apps.email_from_name). Graph credentials (graph_tenant_id, graph_client_id,
-- graph_client_secret_encrypted) are written by the Settings UI, not seeded.
-- Recipients are bounded to registered platform users (see emailQueue), so no
-- domain allowlist is needed.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('email_from_address', 'appcrane@example.com'),
  ('email_from_name',    'AIMI');
