CREATE TABLE IF NOT EXISTS ask_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug   TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ask_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES ask_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ask_sessions_user ON ask_sessions(user_id, app_slug);
CREATE INDEX IF NOT EXISTS idx_ask_messages_session ON ask_messages(session_id);
