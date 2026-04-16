-- AppStudio: extend enhancement_requests with AI plan/code/delivery fields.
-- Existing rows stay mode='manual' and are unaffected.

ALTER TABLE enhancement_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE enhancement_requests ADD COLUMN ai_plan_json TEXT;
ALTER TABLE enhancement_requests ADD COLUMN ai_cost_estimate TEXT;
ALTER TABLE enhancement_requests ADD COLUMN user_comments TEXT;
ALTER TABLE enhancement_requests ADD COLUMN admin_comments TEXT;
ALTER TABLE enhancement_requests ADD COLUMN branch_name TEXT;
ALTER TABLE enhancement_requests ADD COLUMN pr_url TEXT;
ALTER TABLE enhancement_requests ADD COLUMN sandbox_deploy_id INTEGER;
ALTER TABLE enhancement_requests ADD COLUMN ai_log TEXT;
ALTER TABLE enhancement_requests ADD COLUMN cost_tokens INTEGER DEFAULT 0;
ALTER TABLE enhancement_requests ADD COLUMN cost_usd_cents INTEGER DEFAULT 0;
ALTER TABLE enhancement_requests ADD COLUMN max_cost_cents INTEGER DEFAULT 500;

CREATE TABLE IF NOT EXISTS enhancement_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enhancement_id INTEGER NOT NULL REFERENCES enhancement_requests(id),
  phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  input_json TEXT,
  output_json TEXT,
  cost_tokens INTEGER,
  cost_usd_cents INTEGER,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_enhancement_jobs_queued ON enhancement_jobs(status) WHERE status = 'queued';
