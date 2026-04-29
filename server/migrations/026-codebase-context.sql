DROP TABLE IF EXISTS app_codebase_cache;

CREATE TABLE IF NOT EXISTS app_codebase_context (
  app_slug    TEXT PRIMARY KEY,
  git_hash    TEXT NOT NULL,
  built_at    TEXT NOT NULL DEFAULT (datetime('now')),
  file_tree   TEXT,
  context_doc TEXT NOT NULL
);
