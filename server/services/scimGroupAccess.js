/**
 * SCIM group -> app access reconciler.
 *
 * Lives here rather than in server/routes/scim.js because it is the engine
 * behind five different routes (POST/PUT/PATCH/DELETE /Groups and the
 * platform-admin mapping route) and none of it is HTTP. The route file
 * decides what the IdP asked for; this file decides what that is worth.
 */

/**
 * Re-derive every app grant that exists because of a group, and make
 * app_users / app_user_roles agree with it.
 *
 * A full sweep rather than an incremental delta: the input is at most
 * (members x mappings) rows, and an incremental path would have to get every
 * one of add / remove / replace / group-delete / mapping-change right
 * separately. Idempotent, so calling it twice is free and calling it once too
 * often is never wrong.
 *
 * What it will and will not touch is the contract described in migration 084:
 * it deletes only rows it created (tracked in scim_group_access) and never
 * overwrites a tier a human set by hand.
 */
export function reconcileGroupAccess(db) {
  const RANK = { user: 1, admin: 2, owner: 3 };

  const rows = db.prepare(`
    SELECT r.app_id AS app_id, gm.user_id AS user_id, r.app_role AS app_role
      FROM scim_group_members gm
      JOIN scim_group_app_roles r ON r.group_id = gm.group_id
      JOIN users u ON u.id = gm.user_id
      JOIN apps  a ON a.id = r.app_id
  `).all();

  // Two groups can grant the same person the same app at different tiers.
  // Highest wins — the alternative is a grant whose effect depends on row order.
  const desired = new Map();
  for (const r of rows) {
    const key = `${r.app_id}:${r.user_id}`;
    const cur = desired.get(key);
    if (!cur || RANK[r.app_role] > RANK[cur.app_role]) desired.set(key, r);
  }

  const ledger = db.prepare('SELECT * FROM scim_group_access').all();

  const delRole   = db.prepare('DELETE FROM app_user_roles WHERE app_id = ? AND user_id = ?');
  const delMember = db.prepare('DELETE FROM app_users      WHERE app_id = ? AND user_id = ?');
  const delLedger = db.prepare('DELETE FROM scim_group_access WHERE app_id = ? AND user_id = ?');
  const hasMember = db.prepare('SELECT 1 FROM app_users      WHERE app_id = ? AND user_id = ?');
  const hasRole   = db.prepare('SELECT 1 FROM app_user_roles WHERE app_id = ? AND user_id = ?');
  const addMember = db.prepare('INSERT INTO app_users (app_id, user_id) VALUES (?, ?)');
  const addRole   = db.prepare('INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, ?)');
  const setRole   = db.prepare('UPDATE app_user_roles SET app_role = ? WHERE app_id = ? AND user_id = ?');
  const addLedger = db.prepare(`INSERT INTO scim_group_access
    (app_id, user_id, app_role, created_membership, created_role) VALUES (?, ?, ?, ?, ?)`);
  const setLedger = db.prepare(`UPDATE scim_group_access
    SET app_role = ?, updated_at = datetime('now') WHERE app_id = ? AND user_id = ?`);

  db.transaction(() => {
    for (const l of ledger) {
      if (desired.has(`${l.app_id}:${l.user_id}`)) continue;
      // Revoke: undo exactly what was created, and nothing that was not.
      if (l.created_role)       delRole.run(l.app_id, l.user_id);
      if (l.created_membership) delMember.run(l.app_id, l.user_id);
      delLedger.run(l.app_id, l.user_id);
    }

    const byKey = new Map(ledger.map(l => [`${l.app_id}:${l.user_id}`, l]));
    for (const [key, d] of desired) {
      const l = byKey.get(key);
      if (!l) {
        const hadMembership = !!hasMember.get(d.app_id, d.user_id);
        const hadRole       = !!hasRole.get(d.app_id, d.user_id);
        if (!hadMembership) addMember.run(d.app_id, d.user_id);
        if (!hadRole)       addRole.run(d.app_id, d.user_id, d.app_role);
        addLedger.run(d.app_id, d.user_id, d.app_role, hadMembership ? 0 : 1, hadRole ? 0 : 1);
      } else if (l.app_role !== d.app_role) {
        if (l.created_role) setRole.run(d.app_role, d.app_id, d.user_id);
        setLedger.run(d.app_role, d.app_id, d.user_id);
      }
    }
  })();
}
