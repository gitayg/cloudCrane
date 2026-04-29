CREATE TABLE IF NOT EXISTS coder_sessions (
  id TEXT PRIMARY KEY,
  app_slug TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  branch_name TEXT NOT NULL,
  container_id TEXT,
  workspace_dir TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  claude_session_id TEXT,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  shipped_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS coder_session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES coder_sessions(id) ON DELETE CASCADE
);
