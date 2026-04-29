import { Router } from 'express';
import { getDb } from '../db.js';
import { generateApiKey, hashApiKey, hashPassword, encrypt } from '../services/encryption.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/users - List all users (admin only)
 */
router.get('/', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.created_at, u.last_login_at,
      CASE WHEN u.password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
      CASE WHEN u.saml_name_id IS NOT NULL THEN 'saml' WHEN u.sso_sub IS NOT NULL THEN 'oidc' ELSE NULL END as sso_provider,
      (SELECT GROUP_CONCAT(a.slug, ', ') FROM app_users au JOIN apps a ON a.id = au.app_id WHERE au.user_id = u.id) as assigned_apps
    FROM users u ORDER BY u.created_at DESC
  `).all();

  res.json({ users });
});

/**
 * POST /api/users - Create user (admin only)
 */
router.post('/', requireAdmin, auditMiddleware('user-create'), (req, res) => {
  const { name, email, role, username, password, avatar_url, phone, year_of_birth } = req.body;
  if (!name) throw new AppError('Name is required', 400, 'VALIDATION');

  const userRole = role === 'admin' ? 'admin' : 'user';
  const prefix = userRole === 'admin' ? 'dhk_admin' : 'dhk_user';
  const apiKey = generateApiKey(prefix);
  const keyHash = hashApiKey(apiKey);
  const pwHash = password ? hashPassword(password) : null;

  const db = getDb();

  // Check email uniqueness
  if (email) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new AppError('Email already registered', 409, 'DUPLICATE');
  }

  // Check username uniqueness
  if (username) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) throw new AppError('Username already taken', 409, 'DUPLICATE');
  }

  const result = db.prepare(
    'INSERT INTO users (name, email, role, api_key_hash, username, password_hash, avatar_url, phone, year_of_birth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, email || null, userRole, keyHash, username || null, pwHash, avatar_url || null, phone || null, year_of_birth || null);

  res.json({
    user: { id: result.lastInsertRowid, name, email, role: userRole },
    api_key: apiKey,
    warning: 'Save this API key! It will not be shown again.',
  });
});

/**
 * DELETE /api/users/:id - Delete user (admin only)
 */
router.delete('/:id', requireAdmin, auditMiddleware('user-delete'), (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.id);

  if (userId === 1) {
    throw new AppError('Cannot delete the owner account', 400, 'OWNER_PROTECTED');
  }

  if (userId === req.user.id) {
    throw new AppError('Cannot delete yourself', 400, 'SELF_DELETE');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

  // Delete related records first to avoid FK constraint failures
  db.transaction(() => {
    // NULL out non-cascading FK references to this user
    db.prepare('UPDATE apps SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE deployments SET deployed_by = NULL WHERE deployed_by = ?').run(userId);
    db.prepare('UPDATE env_vars SET updated_by = NULL WHERE updated_by = ?').run(userId);
    db.prepare('UPDATE backups SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(userId);
    // Delete cascading FK records
    db.prepare('DELETE FROM app_users WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM app_user_roles WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM identity_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notification_configs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  res.json({ message: `User '${user.name}' deleted` });
});

/**
 * POST /api/users/:id/regenerate-key - Generate new API key (admin only)
 */
router.post('/:id/regenerate-key', requireAdmin, auditMiddleware('user-regen-key'), (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('confirm') !== 'true') {
    throw new AppError('This will invalidate the current key. Add ?confirm=true to proceed.', 400, 'CONFIRMATION_REQUIRED');
  }

  const db = getDb();
  const userId = parseInt(req.params.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

  // Block admin key regeneration via API -- use crane regenerate-key on server
  if (user.role === 'admin') {
    throw new AppError('Admin keys cannot be regenerated via API. Run: crane regenerate-key --on the server.', 403, 'ADMIN_KEY_PROTECTED');
  }

  const prefix = user.role === 'admin' ? 'dhk_admin' : 'dhk_user';
  const apiKey = generateApiKey(prefix);
  const keyHash = hashApiKey(apiKey);

  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(keyHash, userId);
  db.prepare('DELETE FROM identity_sessions WHERE user_id = ?').run(userId);

  res.json({
    user: { id: user.id, name: user.name, role: user.role },
    api_key: apiKey,
    warning: 'Save this API key! It will not be shown again.',
  });
});

/**
 * PUT /api/users/:id/password - Set/change password (admin only)
 */
router.put('/:id/password', requireAdmin, auditMiddleware('user-set-password'), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 12) throw new AppError('Password must be at least 12 characters', 400, 'VALIDATION');

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

  const pwHash = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(pwHash, user.id);
  db.prepare('DELETE FROM identity_sessions WHERE user_id = ?').run(user.id);

  res.json({ message: `Password set for ${user.name}` });
});

/**
 * PUT /api/users/:id/profile - Update user profile (admin only)
 */
router.put('/:id/profile', requireAdmin, auditMiddleware('user-update-profile'), (req, res) => {
  const { name, email, username, avatar_url, phone, year_of_birth, preferences } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (email !== undefined) { updates.push('email = ?'); values.push(email); }
  if (username !== undefined) { updates.push('username = ?'); values.push(username); }
  if (avatar_url !== undefined) { updates.push('avatar_url = ?'); values.push(avatar_url); }
  if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
  if (year_of_birth !== undefined) { updates.push('year_of_birth = ?'); values.push(year_of_birth); }
  if (preferences !== undefined) { updates.push('preferences = ?'); values.push(typeof preferences === 'string' ? preferences : JSON.stringify(preferences)); }

  if (updates.length === 0) return res.json({ message: 'No changes' });

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values, user.id);
  const updated = db.prepare('SELECT id, name, email, username, avatar_url, phone, year_of_birth, preferences FROM users WHERE id = ?').get(user.id);
  res.json({ user: updated });
});

/**
 * PUT /api/apps/:slug/roles - Set per-app role for a user (admin only)
 * Body: { user_id: 2, app_role: "admin" | "user" | "none" }
 */
router.put('/:slug/roles', requireAdmin, auditMiddleware('app-set-role'), (req, res) => {
  const { user_id, app_role } = req.body;
  if (!user_id || !app_role) throw new AppError('user_id and app_role required', 400, 'VALIDATION');
  if (!['admin', 'user', 'none'].includes(app_role)) throw new AppError('app_role must be admin, user, or none', 400, 'VALIDATION');

  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(req.params.slug);
  if (!app) throw new AppError('App not found', 404, 'NOT_FOUND');

  db.prepare(`
    INSERT INTO app_user_roles (app_id, user_id, app_role) VALUES (?, ?, ?)
    ON CONFLICT(app_id, user_id) DO UPDATE SET app_role = excluded.app_role
  `).run(app.id, user_id, app_role);

  res.json({ message: `Role '${app_role}' set for user ${user_id} on app ${app.slug}` });
});

/**
 * GET /api/apps/:slug/identity/users - List all users + roles for an app (admin only)
 */
router.get('/:slug/identity/users', requireAdmin, (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(req.params.slug);
  if (!app) throw new AppError('App not found', 404, 'NOT_FOUND');

  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.avatar_url, u.phone, u.year_of_birth,
      COALESCE(aur.app_role, 'none') as app_role
    FROM users u
    LEFT JOIN app_user_roles aur ON u.id = aur.user_id AND aur.app_id = ?
    WHERE u.role != 'admin'
    ORDER BY u.name
  `).all(app.id);

  res.json({ app: app.slug, users });
});

export default router;
