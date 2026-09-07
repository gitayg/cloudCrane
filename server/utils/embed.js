// Platform-default iframe embedding (v2.25.0).
//
// By default AppCrane lets any host under the platform's OWN registrable domain
// (the eTLD+1 of CRANE_DOMAIN, e.g. app.example.com → example.com) embed apps —
// a same-org trust boundary. It's emitted as a `frame-ancestors` allowlist and
// merged with any per-app `frame_ancestors`. A platform admin can turn it off
// or override the domain in Settings → Security, and a single app can opt out of
// it with the `'none'` sentinel (v2.44.0 — see mergeAncestors).
//
// SECURITY: the wildcard base is derived via the Public Suffix List (`psl`), so
// it is always a real registrable domain and NEVER a bare public suffix — an
// apex CRANE_DOMAIN like `example.com` yields `*.example.com`, not `*.com`, and a
// value psl can't resolve to an eTLD+1 disables the default rather than
// emitting an over-broad allowlist.
import psl from 'psl';

/** Registrable domain (eTLD+1) of CRANE_DOMAIN, or null if it can't be derived. */
export function platformRegistrableDomain() {
  const crane = (process.env.CRANE_DOMAIN || '').trim().toLowerCase();
  if (!crane) return null;
  try {
    const parsed = psl.parse(crane);
    return parsed && parsed.domain ? parsed.domain : null;
  } catch (_) { return null; }
}

/**
 * The platform-default frame-ancestors token string when same-site embedding is
 * enabled, else null. Enabled unless an admin set it 'off'; the domain is the
 * admin override if present, otherwise the derived registrable domain.
 */
export function platformEmbedAncestors(db) {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  if ((get('platform_embed_same_site') ?? 'on') === 'off') return null;
  const override = (get('platform_embed_domain') || '').trim().toLowerCase();
  const domain = override || platformRegistrableDomain();
  if (!domain) return null;
  return `'self' https://*.${domain} https://${domain}`;
}

const tokenize = (s) => (s ? String(s).trim().split(/\s+/).filter(Boolean) : []);

/**
 * Resolve the frame-ancestors policy for one app: the platform default widened
 * by the app's own list, or REPLACED by it when the app opts out.
 *
 * Named mergeAncestors for its original behaviour — a plain union — which is
 * still what happens for every value that does not contain `'none'`.
 *
 * v2.44.0: `'none'` in the app's list is the opt-out sentinel. Until now the
 * platform default (platformEmbedAncestors, on by default, every host under the
 * platform's registrable domain) could only be widened: an app that wanted to be
 * embeddable NOWHERE, or by exactly one origin, had no way to say so — its value
 * was appended to the wildcard, never substituted for it. With the sentinel:
 *
 *   "'none'"                        → 'none'                    (embeddable nowhere)
 *   "'none' https://portal.ex.com"  → https://portal.ex.com     (that origin only)
 *   "https://portal.ex.com"         → default + that origin     (unchanged, union)
 *
 * `'none'` and not a new flag column because the write path already accepts it:
 * apps.js's CSP-source validator lists `'none'` among the legal tokens, so an
 * admin can type it today — and today it buys nothing. CSP3's grammar admits
 * `'none'` only as the SOLE source expression
 * (serialized-source-list = source-expression *(RWS source-expression) / "'none'"),
 * so the string this used to produce — `'self' https://*.ex.com https://ex.com
 * 'none'` — is not a deny: the token is not a valid source expression in that
 * position, and the app stayed embeddable by the whole registrable domain, the
 * opposite of what was asked for. No app can therefore be relying on the old
 * meaning of a value containing `'none'`, because there was no coherent old
 * meaning, and every union that does NOT contain it is untouched. That is what
 * makes the sentinel safe here and what would make quietly re-reading, say, a
 * bare `'self'` as "replace" unsafe: `'self'` has a real meaning under union
 * semantics and apps set it expecting exactly that.
 *
 * The sentinel is dropped from the output, since mixing it with real sources is
 * what made it inert in the first place.
 *
 * Applies to the app's list only (the second argument). The platform default is
 * built by platformEmbedAncestors and never contains `'none'`.
 */
export function mergeAncestors(platformDefault, appPolicy) {
  const isNone = (t) => t.toLowerCase() === "'none'";
  const app = tokenize(appPolicy);
  if (app.some(isNone)) {
    const listed = [...new Set(app.filter(t => !isNone(t)))];
    return listed.length ? listed.join(' ') : "'none'";
  }
  const toks = [...new Set([...tokenize(platformDefault), ...app])];
  return toks.length ? toks.join(' ') : null;
}
