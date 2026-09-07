/**
 * Read-visibility classification for `settings` table keys (v2.38.0).
 *
 * WHY THIS IS AN ALLOWLIST, NOT A DENYLIST:
 * GET /api/settings/:key used to be guarded by a hand-maintained denylist of
 * "sensitive" keys. Every feature that added a new setting had to remember to
 * extend it, and eventually one didn't — `backup_s3_secret_enc` (the encrypted
 * S3 backup secret) and `backup_s3_access_key_id` (an AWS access key ID in
 * cleartext) shipped without being denylisted and were readable by any
 * authenticated caller, including a low-privilege `dhk_user_*` API key.
 *
 * So the default here is ADMIN: a key nobody classified is platform-admin-only.
 * A future feature that forgets this file fails closed (its setting becomes
 * unreadable for non-admins) instead of leaking. Widening a key is a deliberate,
 * reviewable edit to one of the two sets below.
 */

export const PUBLIC = 'public';   // no authentication at all
export const AUTHED = 'authed';   // any authenticated user
export const ADMIN  = 'admin';    // platform_admin only — the default

/**
 * Readable with NO authentication.
 *
 * `auth_sso_only` MUST stay here: the login page fetches it before anyone has
 * credentials, to decide whether to render the password form at all
 * (studio-web/src/components/Login.tsx). Gating it would show the password
 * form on an SSO-only instance, or hang the login screen on its loading state.
 * It leaks only a boolean about the login policy, which the login UI reveals
 * anyway.
 */
const PUBLIC_KEYS = new Set([
  'auth_sso_only',
]);

/**
 * Readable by any authenticated user (including agent `X-API-Key` callers,
 * which authenticate as ordinary users).
 *
 * `branding` is the org's brand-guidelines prose. AI agents read it via
 * GET /api/settings/branding as build context before scaffolding an app
 * (studio-web/src/components/BrandingTab.tsx), so it cannot be admin-gated.
 */
const AUTHED_KEYS = new Set([
  'branding',
  // `catalog_enabled` decides whether the app catalogue appears in the nav.
  // Every logged-in user renders that nav, so every logged-in user must be able
  // to read it; the write side stays platform-admin-only via PUT
  // /api/settings/:key. It leaks one boolean about which pages this instance
  // offers, which the nav reveals anyway.
  'catalog_enabled',
]);

/**
 * Classify a settings key. Unknown keys → ADMIN (fail closed).
 *
 * Deliberately NOT prefix- or pattern-based: a rule like "anything starting
 * with `oidc_` is admin" also implies "anything else is not", which reopens
 * the denylist hole this function exists to close.
 */
export function settingVisibility(key) {
  if (PUBLIC_KEYS.has(key)) return PUBLIC;
  if (AUTHED_KEYS.has(key)) return AUTHED;
  return ADMIN;
}
