CREATE TABLE IF NOT EXISTS app_codebase_cache (
  app_slug   TEXT PRIMARY KEY,
  git_hash   TEXT NOT NULL,
  built_at   TEXT NOT NULL DEFAULT (datetime('now')),
  file_tree  TEXT,
  files_json TEXT
);
