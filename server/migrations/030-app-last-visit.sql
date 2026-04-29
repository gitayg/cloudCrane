CREATE TABLE IF NOT EXISTS app_last_visit (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id        INTEGER NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  last_visit_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, app_id)
);
