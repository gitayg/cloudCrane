import { useEffect, useState } from 'react'
import { adminApi } from '../adminApi'
import { useMe } from '../hooks/useMe'

type Failing = {
  name: string
  since: string | null
  error: string | null
  fix: string | null
  /** Optional deep link to the page that fixes this credential. Added after the
   *  banner shipped, so it may be absent on an older server — never assume it. */
  href?: string | null
}

/* The shared --ring token (accent at 35% alpha) is tuned for the neutral
 * surfaces it normally sits on; measured against this banner's red wash it
 * comes out at 1.59:1, under the 3:1 a focus indicator needs to be seen at
 * all. Full-opacity accent measures 4.5:1 (dark) / 4.0:1 (light) here. */
const CSS = `
.cred-alert-fix{color:var(--accent,#3b82f6);text-decoration:underline;text-underline-offset:2px}
.cred-alert-fix:hover{filter:brightness(1.15)}
.cred-alert-fix:focus-visible{outline:none;border-radius:3px;box-shadow:0 0 0 2px var(--accent,#3b82f6)}
`

/**
 * Only http(s) and same-origin paths become links. The href arrives from the
 * API as a string, and a `javascript:` value would turn this always-mounted
 * banner into a one-click script sink for any admin who reads their own alert.
 */
function linkableHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string' || href === '') return null
  if (href.startsWith('/') && !href.startsWith('//')) return href
  try {
    const u = new URL(href)
    return u.protocol === 'https:' || u.protocol === 'http:' ? href : null
  } catch {
    return null
  }
}

/**
 * v2.25.3: platform-admin-only banner surfacing a failing integration
 * credential (Graph mail secret, GitHub service-account PAT). Closes the gap
 * where a dead mail token can't email its own alert — the admin sees it in the
 * UI regardless. Backed by GET /api/credentials/health (platform_admin gated).
 */
export function CredentialAlertBanner() {
  const me = useMe()
  const isPlatformAdmin = me?.user?.role === 'platform_admin'
  const [failing, setFailing] = useState<Failing[]>([])

  useEffect(() => {
    if (!isPlatformAdmin) return
    let cancelled = false
    const load = () => adminApi.get<{ ok: boolean; failing: Failing[] }>('/api/credentials/health')
      .then(r => { if (!cancelled) setFailing(Array.isArray(r?.failing) ? r.failing : []) })
      .catch(() => { /* transient — keep last state */ })
    load()
    const t = setInterval(load, 5 * 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [isPlatformAdmin])

  if (!isPlatformAdmin || failing.length === 0) return null

  return (
    <div className="cred-alert-banner" role="alert">
      <style>{CSS}</style>
      <span className="cred-alert-ico" aria-hidden>⚠</span>
      <div className="cred-alert-body">
        <strong>Platform credential {failing.length > 1 ? 'issues' : 'issue'}.</strong>{' '}
        {failing.map((f, i) => {
          const href = linkableHref(f.href)
          // The breadcrumb is the link text when both are present; with a usable
          // href but no breadcrumb the reader still needs somewhere to click.
          const label = f.fix || (href ? 'Settings' : null)
          return (
            <span key={f.name}>
              {i > 0 && ' · '}
              <b>{f.name}</b> is failing{f.error ? ` — ${f.error}` : ''}
              {label && (
                <>
                  {' (fix in '}
                  {href
                    ? <a className="cred-alert-fix" href={href}>{label}</a>
                    : label}
                  {')'}
                </>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
