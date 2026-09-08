-- Managed databases: AppCrane provisions the database an app needs.
--
-- WHY. 22 of the 61 catalogue images need an external SQL database and 503 (or
-- render a blank page) without one — linuxserver/bookstack's own docs open with
-- "This application is dependent on a MariaDB database". A one-click deploy that
-- cannot work until the user hand-rolls a database is not a one-click deploy.
--
-- THE SHAPE: one shared Postgres container and one shared MariaDB container for
-- the whole platform, with a database and a login role per scope inside them.
-- Not a container per app — 57 apps would mean 57 idle database servers, and the
-- memory budget (server/services/memoryBudget.js) has no room for that.
--
-- TWO TABLES, and the split is the point:
--
--   managed_db_servers  one row per ENGINE. The shared container: which image,
--                       which host port, and the superuser password the image
--                       was initialised with.
--   managed_databases   one row per SCOPE per engine. The per-app database,
--                       its login role, and that role's password.
--
-- WHY THE SERVER ROW EXISTS AT ALL. The obvious simplification is to generate
-- the superuser password on every start and hand it to the container. That
-- breaks on the second start: POSTGRES_PASSWORD / MARIADB_ROOT_PASSWORD are
-- honoured only when the image INITIALISES an empty data directory. The data
-- directory lives in a volume under DATA_DIR and survives, so a second start
-- with a fresh password leaves a container whose env says one thing and whose
-- stored credential says another — and the mismatch does not surface until the
-- first provisioning call months later. The password is generated once, stored
-- here, and reused for the life of the volume.
--
-- host_port is stored rather than recomputed because it is what already-deployed
-- app containers were handed in their connection strings. Changing the default
-- in code must not silently repoint a running fleet; an operator who moves the
-- port has to move this row too, and see that they are doing it.
--
-- PASSWORDS ARE ENCRYPTED, NOT HASHED. AppCrane has to be able to REPLAY these
-- to the engine (redeploy, credential rotation, "show me my connection string"),
-- so a one-way hash is not an option the way it is for users.password_hash.
-- Both columns hold the output of services/encryption.js encrypt() —
-- AES-256-GCM under ENCRYPTION_KEY, same as env_vars.value. Consequence, stated
-- plainly: losing ENCRYPTION_KEY loses every database credential on the box, and
-- the recovery is to reprovision, not to decrypt.
--
-- THE SCOPE IS (app_id, tenant), NOT app_id.
-- Multitenancy is already planned (server/services/tenants.js ships the
-- cooperative per-tenant model), and the expensive version of that change is the
-- one where every managed database has to be renamed because the identifier was
-- built from the app alone. tenant is here from the first migration, NOT NULL
-- with '' meaning "the app itself" — deliberately not NULL, because SQLite's
-- UNIQUE index treats every NULL as distinct and two provisions of the same
-- app-level scope would both be allowed to insert.
--
-- No CHECK on engine, following the precedent 072/076/077/078 set: SQLite cannot
-- ALTER a CHECK, so one here forces a table rebuild the first time a third
-- engine is added. Validated in server/services/managedDb.js instead, which is
-- the only writer.

CREATE TABLE IF NOT EXISTS managed_db_servers (
  engine             TEXT    PRIMARY KEY,
  container_name     TEXT    NOT NULL,
  image              TEXT    NOT NULL,
  host_port          INTEGER NOT NULL,
  admin_password_enc TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS managed_databases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant       TEXT    NOT NULL DEFAULT '',
  engine       TEXT    NOT NULL,
  db_name      TEXT    NOT NULL,
  db_user      TEXT    NOT NULL,
  password_enc TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One database per (scope, engine). The provisioning path is not idempotent at
-- the engine level — CREATE DATABASE on an existing name is an error, and a
-- second CREATE ROLE would clobber the password the running container is using
-- — so the uniqueness has to be enforced here rather than discovered there.
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_databases_scope
  ON managed_databases(app_id, tenant, engine);

-- The name collision guard. managedDb.js derives db_name from the scope through
-- one function and hashes the tenant precisely so two scopes cannot land on the
-- same identifier, but a derivation bug there is a CROSS-APP DATA LEAK — app B
-- handed app A's database — and it would look like a working deploy. This index
-- turns that class of bug into a failed INSERT before any SQL reaches the
-- engine. It is a cheap assertion on the most expensive mistake available here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_databases_name
  ON managed_databases(engine, db_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_databases_user
  ON managed_databases(engine, db_user);

-- ON DELETE CASCADE removes the ROW when an app is deleted. It does NOT drop the
-- database inside the engine — SQLite cannot reach Postgres. Deleting an app
-- must call managedDb.deprovisionApp() BEFORE `DELETE FROM apps`, or the
-- database and its login role survive with nothing left in AppCrane pointing at
-- them: an orphan holding the deleted app's data, still reachable by anyone
-- holding the old credentials. See server/routes/apps.js.
CREATE INDEX IF NOT EXISTS idx_managed_databases_app
  ON managed_databases(app_id);
