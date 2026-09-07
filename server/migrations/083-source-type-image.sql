-- migration:no-transaction
--
-- Let apps.source_type be 'image': deploy a prebuilt container image instead of
-- building one from source.
--
-- The three existing source types all end in the same place — AppCrane has a
-- tree of files and builds an image out of it. 'image' skips the build: the
-- image already exists in a registry, and the only thing AppCrane resolves is
-- WHICH image. So the app needs three facts a git or upload app never had:
--
--   image_ref      the reference as the operator wrote it ('odoo:19',
--                  'ghcr.io/o/a@sha256:...'). Stored as typed rather than
--                  pre-resolved, because a tag is a moving target on purpose —
--                  re-deploying 'odoo:19' is how you pick up a patch release.
--   container_port the port the image listens on. NULL means the 3000 default,
--                  which is what AppCrane's own build produces; a third-party
--                  image has no reason to agree (odoo is 8069, nginx is 80).
--   health_path    NULL means /api/health, again the AppCrane-built default. A
--                  stock image will not serve that path, and a health check
--                  against a 404 marks a working app unhealthy.
--
-- deployments.image_ref is separate and is NOT the same value. apps.image_ref
-- is the request ('odoo:19'); deployments.image_ref is the fully-resolved
-- digest ref actually started. Recording only the tag would make two deploys of
-- 'odoo:19' three months apart indistinguishable in history, which defeats the
-- point of recording anything.
--
-- Table rebuild, matching 046 / 048 / 049 / 052 / 081. SQLite cannot ALTER a
-- CHECK, and the writable_schema shortcut is unavailable: better-sqlite3 runs
-- with SQLITE_DBCONFIG_DEFENSIVE and rejects the UPDATE with "table
-- sqlite_master may not be modified".
--
-- The column list below is the live schema as of 082, verified against
-- PRAGMA table_info(apps) on a freshly migrated database: the 32 columns 081
-- restated, unchanged, plus the three new ones. A rebuild that omits a column
-- is not an error — it succeeds and the data is gone. test/image-source.test.js
-- compares this file's CREATE TABLE against the live table so an omission fails
-- a test instead of silently losing a column in production.

PRAGMA foreign_keys = OFF;

CREATE TABLE apps_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT NOT NULL,
  slug                        TEXT UNIQUE NOT NULL,
  slot                        INTEGER UNIQUE NOT NULL,
  domain                      TEXT,
  source_type                 TEXT NOT NULL DEFAULT 'github'
                                CHECK(source_type IN ('github', 'managed', 'managed_legacy', 'upload', 'image')),
  github_url                  TEXT,
  branch                      TEXT DEFAULT 'main',
  github_token_encrypted      TEXT,
  resource_limits             TEXT DEFAULT '{"max_ram_mb":512,"max_cpu_percent":50}',
  created_by                  INTEGER REFERENCES users(id),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  description                 TEXT,
  public_access               INTEGER NOT NULL DEFAULT 0,
  runtime                     TEXT NOT NULL DEFAULT 'docker',
  category                    TEXT,
  slug_aliases                TEXT,
  visibility                  TEXT NOT NULL DEFAULT 'private',
  image_retention             INTEGER NOT NULL DEFAULT 0,
  frame_ancestors             TEXT,
  claude_credentials_encrypted TEXT,
  auth_mode                   TEXT NOT NULL DEFAULT 'authenticated',
  auth_bypass_paths           TEXT,
  service_token_hash          TEXT,
  service_token_encrypted     TEXT,
  email_from_name             TEXT,
  last_managed_push_sha       TEXT,
  multitenant                 INTEGER NOT NULL DEFAULT 0,
  ingress_type                TEXT NOT NULL DEFAULT 'http',
  public_port                 INTEGER,
  data_plane_port             INTEGER,
  sandbox_public_port         INTEGER,
  image_ref                   TEXT,
  container_port              INTEGER,
  health_path                 TEXT
);

-- The three new columns are absent from both lists on purpose: no existing row
-- has a value for them, and naming them here would require a NULL literal per
-- column for no gain.
INSERT INTO apps_new (
  id, name, slug, slot, domain, source_type, github_url, branch,
  github_token_encrypted, resource_limits, created_by, created_at,
  description, public_access, runtime, category, slug_aliases,
  visibility, image_retention, frame_ancestors, claude_credentials_encrypted,
  auth_mode, auth_bypass_paths, service_token_hash, service_token_encrypted,
  email_from_name, last_managed_push_sha, multitenant, ingress_type,
  public_port, data_plane_port, sandbox_public_port
)
SELECT
  id, name, slug, slot, domain, source_type, github_url, branch,
  github_token_encrypted, resource_limits, created_by, created_at,
  description, public_access, runtime, category, slug_aliases,
  visibility, image_retention, frame_ancestors, claude_credentials_encrypted,
  auth_mode, auth_bypass_paths, service_token_hash, service_token_encrypted,
  email_from_name, last_managed_push_sha, multitenant, ingress_type,
  public_port, data_plane_port, sandbox_public_port
FROM apps;

DROP TABLE apps;
ALTER TABLE apps_new RENAME TO apps;

-- Dropping the table dropped its indexes with it. These three are the explicit
-- ones; the UNIQUE constraints on slug and slot rebuild themselves from the
-- column definitions above. The two partial unique indexes are what stop two
-- apps claiming one host port (076), so losing them here would silently undo
-- per-env port safety.
CREATE INDEX IF NOT EXISTS idx_apps_service_token ON apps(service_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_public_port
  ON apps(public_port) WHERE public_port IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_sandbox_public_port
  ON apps(sandbox_public_port) WHERE sandbox_public_port IS NOT NULL;

PRAGMA foreign_keys = ON;

-- deployments needs no rebuild — it has no CHECK to widen, so a plain ADD
-- COLUMN is enough and leaves the table's existing rows and indexes alone.
ALTER TABLE deployments ADD COLUMN image_ref TEXT;
