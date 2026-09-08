-- migration:no-transaction
--
-- apps.catalog_slug — the link from an installed app back to the catalogue
-- entry it came from.
--
-- WHY IT HAS TO EXIST. 54 of the 64 entries in server/services/appCatalog.json
-- carry a `needs` block naming the engine an image requires AND the env var
-- names that image reads. They are NOT standardised: linuxserver/bookstack
-- wants DB_HOST/DB_USER/DB_PASS/DB_DATABASE, Akaunting wants
-- DB_HOST/DB_PORT/DB_NAME/DB_USERNAME/DB_PASSWORD, others take a single
-- DATABASE_URL. So "provision a database for this app" is only half the job —
-- the deployer also has to know WHICH VARIABLE NAMES to set, and that fact
-- lives in the catalogue entry, not in the app row.
--
-- Before this column there was no way to get back to the entry: the install
-- flow posts name, slug, source_type and image_ref, and nothing that names the
-- catalogue.
--
-- WHY NOT MATCH ON github_url OR image_ref INSTEAD. Considered and rejected.
-- Both are user-editable after creation (PUT /api/apps/:slug), and both repeat
-- across entries — several catalogue apps share a base image. A wrong match is
-- not a missing feature, it is app B being handed app A's variable names and,
-- through them, a live database credential under a name its image will read.
-- A stored slug can be stale (the entry is gone from a later catalogue), and a
-- stale slug degrades to "no injection", which is the safe direction.
--
-- NULLABLE, no default. An app that did not come from the catalogue has no
-- catalogue entry, and '' would be a slug-shaped value that looks up nothing —
-- NULL says "not from the catalogue" in the one way every reader already
-- understands.
--
-- NO CHECK, following the precedent 072/076/077/078 set and 085 restated:
-- SQLite cannot ALTER a CHECK, so one here would force a table rebuild the
-- first time the catalogue's own slug shape changes. The shape is validated at
-- the single writer instead — server/routes/apps.js, POST /api/apps — against
-- the shape the manifest actually uses.
--
-- ================================================================
-- WHY THIS IS A TABLE REBUILD AND NOT `ALTER TABLE apps ADD COLUMN`
-- ================================================================
-- ADD COLUMN works here (there is no CHECK to widen) and was tried first. It is
-- rejected because it breaks an invariant this repo enforces with a test:
-- test/upload-source-type.test.js asserts that the HIGHEST-NUMBERED migration
-- containing `CREATE TABLE apps_new` describes the live apps table exactly,
-- column for column. Measured: with the ADD COLUMN version of this file in
-- place, `node --test test/image-source.test.js test/upload-source-type.test.js`
-- reported 63 pass / 2 fail, both on "the live table and the migration disagree
-- on the column count".
--
-- That guard is not incidental. Every rebuild restates the whole column list by
-- hand, and a column missing from that list is not an error — the rebuild
-- succeeds and the data is gone. A column added by ALTER after the newest
-- rebuild is invisible to whoever writes the next one, so catalog_slug would be
-- silently dropped by the next widening of source_type, and the symptom would
-- be catalogue apps quietly losing their database credentials on a schema
-- change that had nothing to do with them. Restating the list here keeps the
-- newest rebuild self-describing, which is the whole point of the guard.
--
-- The column list below is the live schema as of 085, verified against
-- PRAGMA table_info(apps) on a freshly migrated database: the 35 columns 083
-- restated, unchanged, plus catalog_slug.

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
  health_path                 TEXT,
  catalog_slug                TEXT
);

-- catalog_slug is absent from both lists on purpose: no existing row has a
-- value for it, and naming it here would require a NULL literal for no gain.
INSERT INTO apps_new (
  id, name, slug, slot, domain, source_type, github_url, branch,
  github_token_encrypted, resource_limits, created_by, created_at,
  description, public_access, runtime, category, slug_aliases,
  visibility, image_retention, frame_ancestors, claude_credentials_encrypted,
  auth_mode, auth_bypass_paths, service_token_hash, service_token_encrypted,
  email_from_name, last_managed_push_sha, multitenant, ingress_type,
  public_port, data_plane_port, sandbox_public_port,
  image_ref, container_port, health_path
)
SELECT
  id, name, slug, slot, domain, source_type, github_url, branch,
  github_token_encrypted, resource_limits, created_by, created_at,
  description, public_access, runtime, category, slug_aliases,
  visibility, image_retention, frame_ancestors, claude_credentials_encrypted,
  auth_mode, auth_bypass_paths, service_token_hash, service_token_encrypted,
  email_from_name, last_managed_push_sha, multitenant, ingress_type,
  public_port, data_plane_port, sandbox_public_port,
  image_ref, container_port, health_path
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
