-- SCIM 2.0 Groups: the entity /api/scim/v2/Groups provisions, and the explicit
-- bridge from IdP group membership to AppCrane app access.
--
-- Four tables, and the split between them is the whole point:
--
--   scim_groups          what the IdP owns. Okta/Entra push group objects here
--   scim_group_members   what the IdP owns. Membership, and nothing else
--   scim_group_app_roles what APPCRANE owns. "group 3 grants app 7 at 'admin'"
--   scim_group_access    the ledger of what the reconciler actually wrote
--
-- WHY THE MAPPING IS SEPARATE FROM THE GROUP. If group membership implied app
-- access by some naming rule ("a group called appcrane-legal-admin grants
-- 'legal' at admin"), then whoever can rename a group in the IdP can grant
-- themselves production env-var access on any app. The SCIM token would become
-- a privilege-escalation primitive. So the IdP decides WHO is in a group and a
-- platform admin decides WHAT a group is worth — the two halves are written
-- through different credentials (SCIM bearer token vs. an authenticated
-- platform_admin session) and stored in different tables.
--
-- WHY THERE IS A LEDGER. Enforcement in AppCrane reads app_users (membership)
-- and app_user_roles (tier) — server/middleware/auth.js and
-- server/services/permissions.js. Group access has to end up in those two
-- tables or it means nothing. But those tables are also written by hand
-- through the dashboard, and the rows are indistinguishable once written. If
-- the reconciler simply deleted every (app,user) pair that no longer had a
-- group behind it, removing someone from an IdP group would silently revoke
-- access an admin had granted them directly, for unrelated reasons.
--
-- scim_group_access records, per (app,user), whether the reconciler was the
-- one that created the app_users row and whether it created the app_user_roles
-- row. On revocation it removes only what it created. A pre-existing direct
-- grant survives; a pre-existing role is never overwritten while the group is
-- in force either, so a hand-set 'owner' is not downgraded to the group's
-- 'user'. The rule in both directions is: the reconciler owns its own rows and
-- nobody else's.
--
-- No CHECK is being widened and no existing table is being rebuilt, so this
-- runs inside the normal migration transaction — no `migration:no-transaction`.

CREATE TABLE IF NOT EXISTS scim_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  external_id  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- displayName is how an IdP re-finds a group it already pushed
-- (GET /Groups?filter=displayName eq "..."), so two groups with one name would
-- make that lookup ambiguous and the second create silently shadow the first.
-- POST /Groups turns the violation into a SCIM 409, matching POST /Users.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_groups_display_name
  ON scim_groups(display_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_groups_external_id
  ON scim_groups(external_id) WHERE external_id IS NOT NULL;

-- ON DELETE CASCADE on user_id is load-bearing, not tidiness: DELETE
-- /Users/:id is a hard delete, and a membership row pointing at a vanished
-- user would be returned by GET /Groups/:id as a member whose $ref 404s, and
-- would keep feeding the access reconciler a user id that no longer exists.
-- (db.js sets `PRAGMA foreign_keys = ON` on every connection, so the cascade
-- is live rather than decorative.)
CREATE TABLE IF NOT EXISTS scim_group_members (
  group_id INTEGER NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_scim_group_members_user
  ON scim_group_members(user_id);

-- The platform-admin half. app_role deliberately excludes 'none': a mapping
-- exists to grant something, and 'none' is app_user_roles' marker for "not a
-- member" (see 073), which would make a grant that revokes.
CREATE TABLE IF NOT EXISTS scim_group_app_roles (
  group_id   INTEGER NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  app_id     INTEGER NOT NULL REFERENCES apps(id)        ON DELETE CASCADE,
  app_role   TEXT NOT NULL CHECK(app_role IN ('user', 'admin', 'owner')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_scim_group_app_roles_app
  ON scim_group_app_roles(app_id);

-- The ledger. One row per (app,user) the reconciler currently holds open.
-- app_role is the effective tier it resolved (highest of every group that
-- grants this pair), kept so a later reconcile can tell an unchanged grant
-- from a re-tiered one without re-deriving history.
CREATE TABLE IF NOT EXISTS scim_group_access (
  app_id             INTEGER NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_role           TEXT NOT NULL,
  created_membership INTEGER NOT NULL DEFAULT 0,
  created_role       INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (app_id, user_id)
);
