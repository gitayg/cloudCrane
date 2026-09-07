/**
 * Same-origin redirect validation (v2.35.0).
 *
 * A credentialed WAS scan of app.example.com proved an open redirect: requesting
 * `/login?redirect=//attacker.com` landed the browser on `https://attacker.com/`.
 * Three separate call sites guarded with `redirect.startsWith('/')`, which is
 * NOT a same-origin test —
 *
 *   "//attacker.com".startsWith("/")   === true
 *
 * because `//host` is a protocol-relative URL: an absolute, cross-origin
 * address that merely begins with a slash. `/\attacker.com` is treated the same
 * way by several browsers, and a backslash survives some normalizers that strip
 * a second slash.
 *
 * The value of an open redirect to an attacker is that the link they send is
 * genuinely on your domain — the victim inspects `app.example.com/login?...`,
 * sees the real host, and is then bounced somewhere else. It is a phishing
 * amplifier, which is why it stays worth fixing even though nothing is
 * "breached" by the redirect itself. CWE-601.
 *
 * Rule: accept only a single leading slash, then a character that cannot begin
 * an authority. Anything else — absolute URLs, protocol-relative, backslash
 * variants, `javascript:` — is refused and the caller falls back.
 */

export function isSafeRedirect(value: string | null | undefined): boolean {
  if (!value) return false
  // Must start with exactly one '/'. Reject '//host', '/\host', and any scheme.
  if (!value.startsWith('/')) return false
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return false
  // Control characters (including encoded newlines that survive decoding) can
  // split a Location header or confuse a URL parser — refuse outright.
  if (/[\x00-\x1f\x7f]/.test(value)) return false
  return true
}

/**
 * The redirect target if it is safe, otherwise `fallback`. Use this rather than
 * hand-rolling the check — the whole finding was three copies of a check that
 * looked correct in isolation.
 */
export function safeRedirectTarget(
  value: string | null | undefined,
  fallback = '/launch',
): string {
  return isSafeRedirect(value) ? (value as string) : fallback
}
