import { Router } from 'express';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../db.js';
import { verifyPassword, generateSessionToken, hashApiKey } from '../services/encryption.js';
import { AppError } from '../utils/errors.js';
import log from '../utils/logger.js';

const ICON_DIR = resolve(process.env.DATA_DIR || './data', 'apps');
const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const hasIcon = (slug) => ICON_EXTS.some(ext => existsSync(join(ICON_DIR, slug, `icon.${ext}`)));

const router = Router();

const SESSION_DURATION_HOURS = parseInt(process.env.SESSION_DURATION_HOURS) || 24;

// In-memory rate limiter for login attempts: 5 per minute per IP
const _loginAttempts = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (rec.count >= 5) return false;
  rec.count++;
  return true;
}

/**
 * POST /api/identity/login
 * Login with (email OR username) + password → session token
 * Body: { login: "email or username", password: "xxx", app: "slug" (optional) }
 */
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkLoginRateLimit(ip)) {
    log.warn(`Login rate limit hit from ${ip}`);
    throw new AppError('Too many login attempts. Try again in a minute.', 429, 'RATE_LIMITED');
  }

  const { login, password, app } = req.body || {};

  if (!login || !password) {
    throw new AppError('login (email or username) and password are required', 400, 'VALIDATION');
  }

  const db = getDb();

  // Find user by email or username
  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? OR username = ?'
  ).get(login, login);

  if (!user) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  if (user.active === 0) {
    throw new AppError('Account is deactivated. Contact your administrator.', 403, 'DEACTIVATED');
  }

  if (!user.password_hash) {
    throw new AppError('Password not set for this user. Contact admin.', 401, 'NO_PASSWORD');
  }

  if (!verifyPassword(password, user.password_hash)) {
    log.warn(`Failed login for "${login}" from ${ip}`);
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  // Check app access if app specified
  let appId = null;
  let appRole = null;
  if (app) {
    const appRecord = db.prepare('SELECT * FROM apps WHERE slug = ?').get(app);
    if (appRecord) {
      appId = appRecord.id;
      // Check if user has access
      // Get app-specific role (defaults to 'none' = no access)
      const roleRecord = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(appId, user.id);
      appRole = roleRecord?.app_role || 'none';
    }
  }

  // Create session token
  const token = generateSessionToken();
  const tokenHash = hashApiKey(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO identity_sessions (user_id, token_hash, app_id, expires_at) VALUES (?, ?, ?, ?)'
  ).run(user.id, tokenHash, appId, expiresAt);

  // Update last login
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  log.info(`Identity login: ${user.name} (${login})${app ? ' for app ' + app : ''}`);

  // Get all apps with this user's role, health state, and current version
  const isAdmin = user.role === 'admin';
  const apps = db.prepare(`
    SELECT a.slug, a.name, a.domain, a.description, a.public_access, a.category,
      CASE WHEN a.public_access THEN 'viewer' ELSE COALESCE(aur.app_role, 'none') END as app_role,
      hp.is_down as prod_down, hp.last_status as prod_status,
      hs.is_down as sand_down, hs.last_status as sand_status,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'production' AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as prod_version,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'sandbox'    AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as sand_version
    FROM apps a
    LEFT JOIN app_user_roles aur ON a.id = aur.app_id AND aur.user_id = ?
    LEFT JOIN health_state hp ON a.id = hp.app_id AND hp.env = 'production'
    LEFT JOIN health_state hs ON a.id = hs.app_id AND hs.env = 'sandbox'
    ORDER BY a.name
  `).all(user.id).map(a => ({
    ...a,
    app_role: isAdmin && a.app_role === 'none' ? 'admin' : a.app_role,
    has_icon: hasIcon(a.slug),
  }));

  res.json({
    token,
    expires_at: expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      avatar_url: user.avatar_url,
      phone: user.phone,
      year_of_birth: user.year_of_birth,
    },
    ...(appRole && { app_role: appRole }),
    apps,
  });
});

/**
 * GET /api/identity/verify
 * App calls this to verify a session token and get user info + app role
 * Headers: Authorization: Bearer TOKEN
 * Query: ?app=slug (optional, to get role for specific app)
 */
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.replace('Bearer ', '').trim();
  const isApiClient = !!authHeader; // API clients send Authorization header; browsers/Caddy don't

  // Fallback: read cc_token cookie (forwarded by Caddy forward_auth from the browser)
  if (!token) {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/(?:^|;\s*)cc_token=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }

  const craneUrl = process.env.CRANE_DOMAIN
    ? `https://${process.env.CRANE_DOMAIN}`
    : `http://localhost:${process.env.PORT || 5001}`;

  // Reconstruct original URL from Caddy forward_auth headers for post-login redirect
  function originalUrl() {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host']  || process.env.CRANE_DOMAIN || '';
    const uri   = req.headers['x-forwarded-uri']   || '';
    if (!host || !uri) return '';
    return `${proto}://${host}${uri}`;
  }

  function loginRedirect(extra = {}) {
    const orig = originalUrl();
    const p = new URLSearchParams({ ...(orig && { redirect: orig }), ...extra });
    const qs = p.toString() ? '?' + p.toString() : '';
    return res.redirect(302, `${craneUrl}/login${qs}`);
  }

  if (!token) {
    if (!isApiClient) return loginRedirect();
    throw new AppError('Authorization: Bearer TOKEN header required', 401, 'NO_TOKEN');
  }

  const db = getDb();
  const tokenHash = hashApiKey(token);

  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.name, u.email, u.username, u.avatar_url, u.phone, u.year_of_birth, u.role as crane_role
    FROM identity_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ?
  `).get(tokenHash);

  if (!session) {
    if (!isApiClient) return loginRedirect();
    throw new AppError('Invalid or expired token', 401, 'INVALID_TOKEN');
  }

  // Check expiry
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM identity_sessions WHERE token_hash = ?').run(tokenHash);
    if (!isApiClient) return loginRedirect();
    throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
  }

  // Get app role
  const url = new URL(req.url, `http://${req.headers.host}`);
  const appSlug = url.searchParams.get('app');
  let appRole = null;
  let appName = null;

  if (appSlug) {
    const appRecord = db.prepare('SELECT * FROM apps WHERE slug = ?').get(appSlug);
    if (appRecord) {
      appName = appRecord.name;
      if (appRecord.public_access) {
        appRole = 'viewer';
      } else {
        const roleRecord = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(appRecord.id, session.user_id);
        appRole = roleRecord?.app_role || (session.crane_role === 'admin' ? 'admin' : 'none');
      }
    }
  } else if (session.app_id) {
    const appRecord = db.prepare('SELECT * FROM apps WHERE id = ?').get(session.app_id);
    if (appRecord) {
      appName = appRecord.name;
      if (appRecord.public_access) {
        appRole = 'viewer';
      } else {
        const roleRecord = db.prepare('SELECT app_role FROM app_user_roles WHERE app_id = ? AND user_id = ?').get(session.app_id, session.user_id);
        appRole = roleRecord?.app_role || (session.crane_role === 'admin' ? 'admin' : 'none');
      }
    }
  }

  // Deny access if user has no role for the requested app
  if (appRole === 'none') {
    if (!isApiClient) return loginRedirect({ denied: '1', app: appSlug || '', name: appName || '' });
    throw new AppError('You do not have access to this app', 403, 'FORBIDDEN');
  }

  res.json({
    user: {
      id: session.user_id,
      name: session.name,
      email: session.email,
      username: session.username,
      avatar_url: session.avatar_url,
      phone: session.phone,
      year_of_birth: session.year_of_birth,
    },
    ...(appRole && { role: appRole, app: appSlug || appName }),
    expires_at: session.expires_at,
  });
});

/**
 * POST /api/identity/logout
 * Invalidate session token
 * Headers: Authorization: Bearer TOKEN
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.json({ message: 'No token provided' });
  }

  const db = getDb();
  const tokenHash = hashApiKey(token);
  db.prepare('DELETE FROM identity_sessions WHERE token_hash = ?').run(tokenHash);

  res.json({ message: 'Logged out' });
});

/**
 * GET /api/identity/me
 * Get current user profile from session token
 * Headers: Authorization: Bearer TOKEN
 */
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) throw new AppError('Authorization: Bearer TOKEN header required', 401, 'NO_TOKEN');

  const db = getDb();
  const tokenHash = hashApiKey(token);

  const session = db.prepare(`
    SELECT u.* FROM identity_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenHash);

  if (!session) throw new AppError('Invalid or expired token', 401, 'INVALID_TOKEN');

  // Get all apps with roles, health state, and current version
  const isAdmin = session.role === 'admin';
  const apps = db.prepare(`
    SELECT a.slug, a.name, a.domain, a.description, a.public_access, a.category,
      CASE WHEN a.public_access THEN 'viewer' ELSE COALESCE(aur.app_role, 'none') END as role,
      hp.is_down as prod_down, hp.last_status as prod_status,
      hs.is_down as sand_down, hs.last_status as sand_status,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'production' AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as prod_version,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'sandbox'    AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as sand_version
    FROM apps a
    LEFT JOIN app_user_roles aur ON a.id = aur.app_id AND aur.user_id = ?
    LEFT JOIN health_state hp ON a.id = hp.app_id AND hp.env = 'production'
    LEFT JOIN health_state hs ON a.id = hs.app_id AND hs.env = 'sandbox'
    ORDER BY a.name
  `).all(session.id).map(a => ({
    ...a,
    role: isAdmin && a.role === 'none' ? 'admin' : a.role,
    has_icon: hasIcon(a.slug),
  }));

  res.json({
    user: {
      id: session.id,
      name: session.name,
      email: session.email,
      username: session.username,
      avatar_url: session.avatar_url,
      phone: session.phone,
      year_of_birth: session.year_of_birth,
    },
    apps,
  });
});

/**
 * GET /api/identity/preview-as/:userId
 * Admin-only: returns the portal view (apps + roles) as a specific user would see it.
 * Headers: Authorization: Bearer <admin-session-token>
 */
router.get('/preview-as/:userId', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) throw new AppError('Authorization: Bearer TOKEN header required', 401, 'NO_TOKEN');

  const db = getDb();
  const tokenHash = hashApiKey(token);

  const session = db.prepare(`
    SELECT u.role FROM identity_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(tokenHash);

  if (!session) throw new AppError('Invalid or expired token', 401, 'INVALID_TOKEN');
  if (session.role !== 'admin') throw new AppError('Admin only', 403, 'FORBIDDEN');

  const targetId = Number(req.params.userId);
  const target = db.prepare('SELECT id, name, email, username, avatar_url, role FROM users WHERE id = ?').get(targetId);
  if (!target) throw new AppError('User not found', 404, 'NOT_FOUND');

  const apps = db.prepare(`
    SELECT a.slug, a.name, a.domain, a.description, a.public_access, a.category,
      CASE WHEN a.public_access THEN 'viewer' ELSE COALESCE(aur.app_role, 'none') END as app_role,
      hp.is_down as prod_down, hp.last_status as prod_status,
      hs.is_down as sand_down, hs.last_status as sand_status,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'production' AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as prod_version,
      (SELECT version FROM deployments WHERE app_id = a.id AND env = 'sandbox'    AND status = 'live' ORDER BY finished_at DESC LIMIT 1) as sand_version
    FROM apps a
    LEFT JOIN app_user_roles aur ON a.id = aur.app_id AND aur.user_id = ?
    LEFT JOIN health_state hp ON a.id = hp.app_id AND hp.env = 'production'
    LEFT JOIN health_state hs ON a.id = hs.app_id AND hs.env = 'sandbox'
    ORDER BY a.name
  `).all(targetId).map(a => ({
    ...a,
    app_role: a.app_role,
    has_icon: hasIcon(a.slug),
  }));

  res.json({ user: target, apps });
});

export default router;
