import { useState, useEffect, useCallback, useRef } from 'react'
import type { ReactElement } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { adminApi } from '../adminApi'
import { Icon } from './icons'
import { WhatsNewModal, type WhatsNewChange } from './WhatsNewModal'
import { useAppTabs } from './AppTabsContext'
import { CredentialAlertBanner } from './CredentialAlertBanner'

interface NavItem { id: string; label: string; href: string; icon: ReactElement; external?: boolean; platformAdminOnly?: boolean; adminOnly?: boolean; ownerOrAdmin?: boolean }
interface NavApp {
  slug: string; name: string; category?: string; has_icon?: boolean
  description?: string
  owner?: { name: string; email?: string } | null
  owners?: { name: string; email?: string }[]
  app_role?: 'admin' | 'owner' | 'user' | 'viewer' | 'none'
  visibility?: string
  production?: { health?: { status: string }; deploy?: AppDeploy | null }
  sandbox?:    { health?: { status: string }; deploy?: AppDeploy | null }
}
interface AppDeploy { version?: string; finished_at?: string; status?: string }
// v2.21.0: most-recent deploy across prod/sandbox, for the sidebar tooltip.
function lastUpdateLine(a: NavApp): string | null {
  const cand = [a.production?.deploy, a.sandbox?.deploy]
    .filter((d): d is AppDeploy => !!d?.finished_at)
    .sort((x, y) => (y.finished_at! > x.finished_at! ? 1 : -1))
  const d = cand[0]
  if (!d) return null
  const when = new Date(d.finished_at!.includes('T') ? d.finished_at! : d.finished_at!.replace(' ', 'T') + 'Z')
  const date = isNaN(when.getTime())
    ? d.finished_at!
    : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `Updated ${date}${d.version ? ' · v' + d.version : ''}`
}
// v2.21.0: list every owner (falls back to the single `owner` for older data).
function ownersOf(a: NavApp): { name: string; email?: string }[] {
  return (a.owners?.length ? a.owners : a.owner ? [a.owner] : []).filter(o => o?.name)
}
function ownerNamesOf(a: NavApp): string[] {
  return ownersOf(a).map(o => o.name)
}
function ownerLine(a: NavApp): string | null {
  const names = ownerNamesOf(a)
  if (!names.length) return null
  return `${names.length > 1 ? 'Owners' : 'Owner'}: ${names.join(', ')}`
}
function appDotClass(a: NavApp): string {
  const prodOk = a.production?.health?.status === 'healthy'
  const sandOk = a.sandbox?.health?.status === 'healthy'
  if (prodOk) return 'launcher-dot launcher-dot-green'
  if (sandOk) return 'launcher-dot launcher-dot-amber'
  return 'launcher-dot launcher-dot-red'
}
function appInitials(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() || '').join('') || name[0].toUpperCase()
}
// v2.6.5: Settings is `platformAdminOnly`. Tier-2 admins still need
// access to user management / audit log etc. at the API level — they
// just shouldn't see the Settings entry in the sidebar.
// v2.6.9: Skills is `adminOnly` (admin OR platform_admin) and lives at
// the top level — was buried under /settings#skills, which non-platform
// admins couldn't reach after v2.6.5. Promoting because skill bundles
// are an admin-day-to-day workflow (assign skills to apps, refresh
// content) and don't belong behind a platform-level gate. DELETE-skill
// is still platform_admin-only (server-side gate), enforced both in
// the SkillsTab UI and on the API.
// Lucide "store" (MIT), inlined to match the shared 24x24 / 2px-stroke geometry
// of components/icons.tsx. The catalogue is a shelf of apps you can take one
// from, and none of the existing glyphs says that: Grid is the launcher and
// Layers is Manage, both of which sit beside it in the rail.
const StoreIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       style={{ display: 'inline-block', verticalAlign: 'middle' }} aria-hidden="true">
    <path d="m2 7 1.5-3.5A1 1 0 0 1 4.4 3h15.2a1 1 0 0 1 .9.5L22 7" />
    <path d="M2 7h20v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" />
    <path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8" />
    <path d="M10 21v-5h4v5" />
  </svg>
)

const NAV: NavItem[] = [
  // v2.34.0: Launch leads the nav — it's the post-login landing page (v2.33.0)
  // and the app picker, so it should be reachable by name rather than only by
  // clicking an individual app or knowing that "/" happens to go there.
  // NavLink matches descendants, so it stays highlighted on /launch/<slug>.
  { id: 'launch',       label: 'Launch',       href: '/launch',       icon: <Icon.Grid /> },
  { id: 'dashboard',    label: 'Dashboard',    href: '/dashboard',    icon: <Icon.Dashboard /> },
  { id: 'applications', label: 'Manage',       href: '/applications', icon: <Icon.Layers /> },
  { id: 'requests',     label: 'Requests',     href: '/requests',     icon: <Icon.Lightbulb /> },
  // v2.59.x: the app catalogue. Deliberately ungated — every logged-in user
  // may browse it; only the per-row Deploy button is conditioned on
  // `platform.create_app`, which the page learns from GET /api/catalog.
  { id: 'catalog',      label: 'Catalogue',    href: '/catalog',      icon: <StoreIcon /> },
  { id: 'docs',         label: 'Docs',         href: '/docs',         icon: <Icon.Book /> },
  { id: 'settings',     label: 'Settings',     href: '/settings',     icon: <Icon.Settings /> },
]

interface SubItem { id: string; label: string; href: string; platformAdminOnly?: boolean; ownerOrAdmin?: boolean; adminOnly?: boolean }

interface Props {
  children: React.ReactNode
  subItems?: SubItem[]
  activeSub?: string
}

export function Layout({ children, subItems, activeSub }: Props) {
  const { isAuthed, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { addTab } = useAppTabs()
  // v2.14.1: whether the user can create apps — gates the sidebar "+ Add
  // Application" button (mirrors canCreateApps: admins or a granted tier).
  const [canCreate, setCanCreate] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('cc_sb_col') === '1')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = parseInt(localStorage.getItem('cc_sb_w') || '', 10)
    return v >= 180 && v <= 460 ? v : 220
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('cc_theme') || 'dark')
  const [userName, setUserName] = useState('')
  // v2.5.9: AppCrane version + update info is platform_admin-only. We
  // capture role here from /api/auth/me and gate every version-related
  // render on it; non-platform-admins never see the pill or the badge.
  const [userRole, setUserRole] = useState<string>('')
  const isPlatformAdmin = userRole === 'platform_admin'
  const [version, setVersion] = useState('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifItems, setNotifItems] = useState<{ title: string; sub: string; color: string }[]>([])
  const [notifLoaded, setNotifLoaded] = useState(false)
  const [openRequests, setOpenRequests] = useState(0)
  // v2.13.0: AppCrane's own What's New, shown to platform admins post-login
  // when the running version is newer than what they last saw.
  const [platformWN, setPlatformWN] = useState<{ currentVersion: string | null; changes: WhatsNewChange[]; seenUrl?: string; primaryLabel?: string; onPrimary?: () => void } | null>(null)
  // v2.13.0: app list merged into the main nav. Accessible apps grouped by
  // category; the whole section and each category collapse (persisted).
  const [navApps, setNavApps] = useState<NavApp[]>([])
  const [appsOpen, setAppsOpen] = useState(() => localStorage.getItem('cc_nav_apps_open') !== '0')
  const [closedCats, setClosedCats] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('cc_nav_closed_cats') || '[]') as string[]) } catch { return new Set() }
  })
  const toggleAppsOpen = () => setAppsOpen(o => { const n = !o; try { localStorage.setItem('cc_nav_apps_open', n ? '1' : '0') } catch (_) {} ; return n })
  const toggleCat = (cat: string) => setClosedCats(prev => {
    const next = new Set(prev)
    if (next.has(cat)) next.delete(cat); else next.add(cat)
    try { localStorage.setItem('cc_nav_closed_cats', JSON.stringify([...next])) } catch (_) {}
    return next
  })
  // v2.5.6: AppCrane self-update auto-check. Today the version pill in the
  // sidebar only learns about updates on click — that's why people miss
  // them. We hit /api/version-check on mount + every 30 min so the pill
  // can render "↑ v2.5.7 available" without user action. Click still does
  // the self-update flow (uses updateInfo state, not DOM manipulation).
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string | null; update_available: boolean } | null>(null)
  const [updating, setUpdating] = useState(false)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!isAuthed) return
    adminApi.get<{ user: { name: string; email?: string; role: string; can_create_apps?: boolean } }>('/api/auth/me')
      .then(d => {
        // v2.7.16: show "email (humanized role)" in the topbar, e.g.
        // "maintainer@example.com (platform admin)". Falls back to name if
        // the user has no email; omits the parens when role is empty.
        const role = d.user.role || ''
        const roleLabel = role.replace(/_/g, ' ')
        const who = d.user.email || d.user.name || ''
        setUserName(who ? (roleLabel ? `${who} (${roleLabel})` : who) : '')
        setUserRole(role)
        setCanCreate(role === 'admin' || role === 'platform_admin' || d.user.can_create_apps === true)
      })
      .catch(() => {})
    // Version display is platform-admin only (gated by isPlatformAdmin
    // on render below). The /api/info call still happens here for
    // backward compat — the response only renders when the role is
    // resolved. We deliberately skip /api/version-check fallback for
    // non-platform-admins because the endpoint now enforces the same.
    adminApi.get<{ version?: string }>('/api/info')
      .then(d => { if (d?.version) setVersion('v' + d.version) })
      .catch(() => {})
  }, [isAuthed])

  // v2.5.6: auto-check for AppCrane self-updates so the sidebar pill
  // can light up without the user clicking. Runs on mount and every 30
  // min; the server caches the GitHub call for 5 min so this is cheap.
  // v2.5.9: gated on isPlatformAdmin — regular admins don't see version
  // info or update offers; the endpoint enforces the same role server-side.
  useEffect(() => {
    if (!isAuthed || !isPlatformAdmin) return
    let cancelled = false
    const check = async () => {
      try {
        const data = await adminApi.get<{ current: string; latest: string | null; update_available: boolean }>('/api/version-check')
        if (!cancelled) setUpdateInfo(data)
      } catch (_) { /* keep last good state */ }
    }
    check()
    const t = setInterval(check, 30 * 60 * 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [isAuthed, isPlatformAdmin])

  async function runSelfUpdate(skipConfirm = false) {
    if (!updateInfo?.update_available || updating) return
    if (!skipConfirm && !confirm(`Update AppCrane from v${updateInfo.current} to v${updateInfo.latest}?\n\nThe server will rebuild the SPA and restart. Active deploys are checked first; the update aborts if any are in flight.`)) return
    setUpdating(true)
    try {
      await adminApi.post('/api/self-update', {})
      // Self-update kicks off async; the server restarts a few seconds
      // later. Reload to pick up the new bundle.
      setTimeout(() => window.location.reload(), 5000)
    } catch (err) {
      alert('Self-update failed: ' + (err instanceof Error ? err.message : String(err)))
      setUpdating(false)
    }
  }

  // Open-requests counter for the Requests nav badge. v2.16.0: the Requests
  // page is now role-scoped (platform admin → all, app owner → their apps,
  // plain user → their own), so the badge queries the matching endpoint:
  //   admin  → /api/enhancements  (fallback /owned)
  //   owner  → /api/enhancements/owned
  //   user   → /api/enhancements/my
  useEffect(() => {
    if (!isAuthed) return
    const TERM = new Set(['done', 'merged', 'closed', 'failed', 'cancelled'])
    const adminLikeNow = userRole === 'admin' || userRole === 'platform_admin'
    const ownerNow = navApps.some(a => a.app_role === 'owner')
    const endpoint = adminLikeNow ? '/api/enhancements'
      : ownerNow ? '/api/enhancements/owned'
      : '/api/enhancements/my'
    const countOpen = (requests?: { status?: string }[]) =>
      (requests || []).filter(r => !TERM.has((r.status || '').toLowerCase())).length
    const fetchCount = () =>
      adminApi.get<{ requests: { status?: string }[] }>(endpoint)
        .catch(() => adminLikeNow
          ? adminApi.get<{ requests: { status?: string }[] }>('/api/enhancements/owned').catch(() => ({ requests: [] }))
          : { requests: [] })
        .then(({ requests }) => setOpenRequests(countOpen(requests)))
    fetchCount()
    const t = setInterval(fetchCount, 15000)
    return () => clearInterval(t)
  }, [isAuthed, userRole, navApps])


  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (notifOpen && notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [notifOpen])

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('cc_sb_col', next ? '1' : '')
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('cc_theme', next)
  }

  // v2.21.0: owner-scoped notifications — surface, for apps you OWN only,
  // (1) failing health checks and (3) open requests awaiting you. The old
  // build read a.prod_down/sand_down, which /api/apps never returns, so it
  // was always empty; this reads the real nested health status.
  const loadNotifs = useCallback(async () => {
    try {
      const [appsRes, reqRes] = await Promise.all([
        adminApi.get<{ apps: any[] }>('/api/apps'),
        adminApi.get<{ requests: any[] }>('/api/enhancements/owned').catch(() => ({ requests: [] })),
      ])
      const owned = (appsRes.apps || []).filter(a => a.app_role === 'owner')
      const ownedSlugs = new Set(owned.map(a => a.slug))
      const items: typeof notifItems = []
      for (const a of owned) {
        if (a.production?.health?.status === 'down') items.push({ title: `${a.name} (prod)`, sub: 'Health check failing', color: 'var(--red)' })
        if (a.sandbox?.health?.status === 'down')    items.push({ title: `${a.name} (sandbox)`, sub: 'Health check failing', color: 'var(--orange, #f5a623)' })
      }
      const openByApp = new Map<string, number>()
      for (const r of (reqRes.requests || [])) {
        if (!ownedSlugs.has(r.app_slug)) continue
        if (String(r.status || '').toLowerCase() === 'done' || r.validated_at) continue
        openByApp.set(r.app_slug, (openByApp.get(r.app_slug) || 0) + 1)
      }
      for (const [slug, n] of openByApp) {
        const a = owned.find(x => x.slug === slug)
        items.push({ title: a?.name || slug, sub: `${n} request${n === 1 ? '' : 's'} awaiting you`, color: 'var(--accent)' })
      }
      setNotifItems(items)
      setNotifLoaded(true)
    } catch { /* transient — keep last known */ }
  }, [])

  // Load once the owned-app list is known, so the badge is accurate without
  // needing to open the panel first.
  useEffect(() => {
    if (navApps.some(a => a.app_role === 'owner')) loadNotifs()
  }, [navApps, loadNotifs])

  const openNotif = useCallback(() => {
    setNotifOpen(o => !o)
    if (!notifLoaded) loadNotifs()
  }, [notifLoaded, loadNotifs])

  // v2.13.0: load the accessible app list for the nav "Apps" section.
  useEffect(() => {
    adminApi.get<{ apps: NavApp[] }>('/api/apps')
      // v2.21.30: keep hidden apps in the list; appGroups filters them out for
      // non-platform-admins at render time (which re-runs once the role loads,
      // avoiding a fetch-vs-role race). Platform admins see hidden apps + a badge.
      .then(r => setNavApps((r?.apps || []).filter(a => a.app_role !== 'none')))
      .catch(() => setNavApps([]))
  }, [])

  // v2.13.0: post-login AppCrane What's New for platform admins. Checked once
  // per browser session; the server records "seen" on dismiss so it won't
  // re-fire until the next AppCrane update.
  useEffect(() => {
    if (userRole !== 'platform_admin') return
    if (sessionStorage.getItem('cc_platform_wn') === '1') return
    sessionStorage.setItem('cc_platform_wn', '1')
    adminApi.get<{ current_version: string | null; changes: WhatsNewChange[] }>('/api/whats-new/platform')
      .then(r => { if (r?.changes?.length) setPlatformWN({ currentVersion: r.current_version, changes: r.changes, seenUrl: '/api/whats-new/platform/seen' }) })
      .catch(() => {})
  }, [userRole])

  // v2.15.0 / v2.21.0: drive the sidebar width (and the persistent app-tabs
  // overlay offset) from the user-set width. --sidebar-w feeds the sidebar +
  // content margin; --content-left tracks the *effective* left edge (56px
  // while collapsed) so the app-tabs overlay stays aligned.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--sidebar-w', sidebarWidth + 'px')
    root.setProperty('--content-left', (collapsed ? 56 : sidebarWidth) + 'px')
  }, [collapsed, sidebarWidth])

  // Drag-to-resize the sidebar. Persists the final width on mouse-up.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    let latest = startW
    document.body.classList.add('resizing-sidebar')
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(460, Math.max(180, startW + (ev.clientX - startX)))
      setSidebarWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-sidebar')
      try { localStorage.setItem('cc_sb_w', String(latest)) } catch (_) { /* private mode */ }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  // v2.13.0: clicking the "update available" pill previews the new version's
  // What's New (current → latest) with an "Upgrade now" action — the same
  // dialog as the post-login one, just forward-looking.
  async function openUpgradeWhatsNew() {
    if (!updateInfo?.update_available || !updateInfo.latest || updating) return
    let changes: WhatsNewChange[] = []
    try {
      const r = await adminApi.get<{ changes: WhatsNewChange[] }>(
        `/api/whats-new/platform?from=${encodeURIComponent(updateInfo.current)}&to=${encodeURIComponent(updateInfo.latest)}`
      )
      changes = r?.changes || []
    } catch { /* still show the dialog so the user can upgrade */ }
    if (changes.length === 0) {
      changes = [{ version: updateInfo.latest, commit_hash: null, commit_message: 'A new version of AppCrane is available.', finished_at: null }]
    }
    setPlatformWN({
      currentVersion: updateInfo.latest,
      changes,
      primaryLabel: 'Upgrade now',
      onPrimary: () => runSelfUpdate(true),
    })
  }

  // Group nav apps by category; Uncategorized last.
  const appGroups: [string, NavApp[]][] = (() => {
    const m = new Map<string, NavApp[]>()
    for (const a of navApps) {
      // Hidden apps show in the sidebar only for platform admins (with a badge).
      if (a.visibility === 'hidden' && !isPlatformAdmin) continue
      const cat = (a.category || '').trim() || 'Uncategorized'
      if (!m.has(cat)) m.set(cat, [])
      m.get(cat)!.push(a)
    }
    return [...m.entries()].sort(([a], [b]) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b))
  })()

  const adminLike = userRole === 'admin' || userRole === 'platform_admin'
  const isOwner = navApps.some(a => a.app_role === 'owner')
  const managesApp = navApps.some(a => a.app_role === 'owner' || a.app_role === 'admin')
  const currentPath = location.pathname
  const activeNav = NAV.find(n => n.href === currentPath)
  const activeNavId = activeNav?.id ?? ''

  // v2.14.3: split the nav — primary items (+ the Apps list) at the top, the
  // admin/config items pinned to the bottom of the rail.
  const BOTTOM_NAV = new Set(['applications', 'docs', 'settings'])
  const gatedNav = NAV.filter(p => {
    if (p.platformAdminOnly && userRole !== 'platform_admin') return false
    if (p.adminOnly && !adminLike) return false
    if (p.ownerOrAdmin && !adminLike && !isOwner) return false
    if (p.id === 'settings' && !adminLike && !isOwner) return false
    // v2.21.5: Manage is for app owners/admins (and it now lists only their
    // apps). Plain users without any owned/admin app don't get a Manage entry.
    if (p.id === 'applications' && !adminLike && !managesApp) return false
    // v2.16.0: Requests is everyone's home for their own requests, so it's
    // always shown (plain users see + delete their own submissions there).
    return true
  })
  const renderNavItem = (p: NavItem) => (
    <div key={p.id}>
      {p.external ? (
        <a href={p.href} className={'sidebar-link' + (location.pathname === p.href ? ' active' : '')} title={p.label}>
          <span className="sidebar-link-icon">{p.icon}</span>
          <span className="sidebar-link-text">{p.label}</span>
        </a>
      ) : (
        <NavLink
          to={p.href}
          className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
          title={p.id === 'requests' && openRequests > 0 ? `${p.label} — ${openRequests} open` : p.label}
        >
          <span className="sidebar-link-icon">{p.icon}</span>
          <span className="sidebar-link-text">{p.label}</span>
          {p.id === 'requests' && openRequests > 0 && <span className="sidebar-link-badge">{openRequests}</span>}
        </NavLink>
      )}
      {activeNavId === p.id && subItems && subItems.length > 0 && !collapsed && (
        <div className="sidebar-sub-nav">
          {subItems.filter(s => {
            if (s.platformAdminOnly && userRole !== 'platform_admin') return false
            if (s.ownerOrAdmin && !adminLike && !isOwner) return false
            if (s.adminOnly && !adminLike) return false
            return true
          }).map(s => (
            <a key={s.id} href={s.href} className={'sidebar-sub-link' + (activeSub === s.id ? ' active' : '')}>{s.label}</a>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="admin-layout">
      {/* Mobile topbar */}
      <div className="mobile-topbar">
        <a href="/dashboard" style={{ fontWeight: 700, fontSize: '1.05rem', textDecoration: 'none', color: 'var(--text)' }}>
          App<span style={{ color: 'var(--accent)' }}>Crane</span>
        </a>
        <button className="hamburger" onClick={() => setMobileOpen(o => !o)} aria-label="Menu">&#9776;</button>
      </div>

      {/* Overlay */}
      {mobileOpen && <div className="sidebar-overlay open" onClick={() => setMobileOpen(false)} />}

      {/* Sidebar */}
      <aside className={`admin-sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' open' : ''}`} id="mainSidebar">
        {/* Logo + version */}
        <div className="sidebar-logo-section">
          <a href="/dashboard" className="sidebar-logo">
            App<span>Crane</span>
          </a>
          {/* v2.14.1: the version + update pill lives in the sidebar (moved
              from the topbar). Platform-admin only; hidden in the icon rail. */}
          {isPlatformAdmin && (version || updateInfo?.current) && !collapsed && (
            <div className="sidebar-version">
              {updateInfo?.update_available ? (
                <span
                  className="topbar-version-pill topbar-version-pill-update"
                  title={`See what's new and update AppCrane v${updateInfo.current} → v${updateInfo.latest}`}
                  onClick={openUpgradeWhatsNew}
                >
                  {updating
                    ? '⏳ updating…'
                    : <>↑ AppCrane v{updateInfo.latest}<span className="topbar-version-pill-current"> (now v{updateInfo.current})</span></>}
                </span>
              ) : (
                <span
                  className="topbar-version-pill"
                  title="Click to re-check for AppCrane updates"
                  onClick={async () => {
                    try {
                      const data = await adminApi.get<{ current: string; latest: string | null; update_available: boolean }>('/api/version-check?force=1')
                      setUpdateInfo(data)
                      if (!data.update_available) {
                        alert(`AppCrane v${data.current} — already up to date${data.latest ? ` (latest is v${data.latest})` : ''}.`)
                      }
                    } catch { /* silent */ }
                  }}
                >
                  AppCrane {updateInfo?.current ? `v${updateInfo.current}` : version}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Nav. Role-gating:
            - platformAdminOnly entries (Settings) hidden unless the
              caller is platform_admin (v2.6.5 tightened from v2.6.4
              which let admin see it too — tier-2 admins shouldn't
              normally need it)
            - Requests hidden when the user has zero open requests AND
              isn't admin/platform_admin (no use for the page either way) */}
        {canCreate && (
          <button
            type="button"
            className="sidebar-add-app btn btn-accent"
            onClick={() => navigate('/applications', { state: { addApp: true } })}
            title="Add Application"
          >{collapsed ? '+' : '+ Add Application'}</button>
        )}
        <nav className="sidebar-nav">
          {gatedNav.filter(p => !BOTTOM_NAV.has(p.id)).map(renderNavItem)}

          {/* v2.13.0: merged launcher — accessible apps live in the main nav,
              grouped by category. Section + each category collapse. Apps open
              inline at /launch/:slug. Hidden in the icon-rail (collapsed) mode. */}
          {!collapsed && navApps.length > 0 && (
            <div className="sidebar-apps">
              <button className="sidebar-apps-toggle" onClick={toggleAppsOpen} title="Apps">
                <span className="sidebar-apps-label">Apps</span>
                <span className="sidebar-apps-chev">{appsOpen ? '▾' : '▸'}</span>
              </button>
              {appsOpen && appGroups.map(([cat, list]) => {
                const closed = closedCats.has(cat)
                return (
                  <div key={cat} className="sidebar-apps-group">
                    <button className="sidebar-apps-cat" onClick={() => toggleCat(cat)}>
                      <span className="sidebar-apps-chev">{closed ? '▸' : '▾'}</span>
                      <span className="sidebar-apps-cat-name">{cat}</span>
                      <span className="sidebar-apps-count">{list.length}</span>
                    </button>
                    {!closed && list.map(a => (
                      <div
                        key={a.slug}
                        role="button"
                        tabIndex={0}
                        className={'sidebar-app-link' + (location.pathname === `/launch/${a.slug}` ? ' active' : '')}
                        onClick={() => { addTab({ slug: a.slug, name: a.name, hasIcon: a.has_icon }); navigate(`/launch/${a.slug}`) }}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addTab({ slug: a.slug, name: a.name, hasIcon: a.has_icon }); navigate(`/launch/${a.slug}`) } }}
                        title={[a.name, a.description, ownerLine(a), lastUpdateLine(a)].filter(Boolean).join('\n')}
                      >
                        <span className="sidebar-app-ico">
                          {a.has_icon
                            ? <img src={`/api/apps/${a.slug}/icon`} alt="" />
                            : <span>{appInitials(a.name)}</span>}
                          <span className={appDotClass(a)} />
                        </span>
                        <span className="sidebar-app-text">
                          <span className="sidebar-app-name">
                            {a.name}
                            {a.visibility === 'hidden' && (
                              <span className="sidebar-app-hidden" aria-label="Hidden app" title="Hidden — visible to platform admins only">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                                  <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                                  <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                                  <line x1="2" x2="22" y1="2" y2="22" />
                                </svg>
                              </span>
                            )}
                          </span>
                          {ownersOf(a).length > 0 && (
                            <span className="sidebar-app-owner">
                              by {ownersOf(a).map((o, i) => (
                                <span key={i}>
                                  {i > 0 && ', '}
                                  {o.email
                                    ? <a
                                        href={`mailto:${o.email}`}
                                        onClick={e => e.stopPropagation()}
                                        title={`Email ${o.name}`}
                                      >{o.name}</a>
                                    : o.name}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* v2.21.15: collapsed icon-rail — apps stay reachable as icons when
              the sidebar is minimized (flattened across categories). */}
          {collapsed && navApps.length > 0 && (
            <div className="sidebar-apps-rail">
              {appGroups.flatMap(([, list]) => list).map(a => (
                <div
                  key={a.slug}
                  role="button"
                  tabIndex={0}
                  className={'sidebar-app-rail-link' + (location.pathname === `/launch/${a.slug}` ? ' active' : '')}
                  onClick={() => { addTab({ slug: a.slug, name: a.name, hasIcon: a.has_icon }); navigate(`/launch/${a.slug}`) }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addTab({ slug: a.slug, name: a.name, hasIcon: a.has_icon }); navigate(`/launch/${a.slug}`) } }}
                  title={a.name}
                >
                  <span className="sidebar-app-ico">
                    {a.has_icon
                      ? <img src={`/api/apps/${a.slug}/icon`} alt="" />
                      : <span>{appInitials(a.name)}</span>}
                    <span className={appDotClass(a)} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </nav>

        {/* v2.14.3: admin/config items (Manage, Docs, Settings) pinned to the
            bottom of the rail, above the footer. */}
        <nav className="sidebar-nav sidebar-nav-bottom">
          {gatedNav.filter(p => BOTTOM_NAV.has(p.id)).map(renderNavItem)}
        </nav>

        {/* Footer — user + sign out (moved here from the topbar in v2.14.3). */}
        <div className="sidebar-footer">
          {!collapsed && userName && <div className="sidebar-user" title={userName}>{userName}</div>}
          <div className="sidebar-footer-row">
            {/* v2.21.0: notifications live here now (moved from the topbar),
                owner-scoped — only shown to owners, only about their apps. */}
            {isOwner && (
              <div className="notif-wrap" ref={notifRef}>
                <button className="notif-bell-btn" onClick={openNotif} title="Notifications" aria-label="Notifications">🔔</button>
                {notifItems.length > 0 && (
                  <span className="notif-badge show">{notifItems.length}</span>
                )}
                <div className={`notif-dropdown${notifOpen ? ' open' : ''}`}>
                  <div className="notif-dd-hdr">Notifications</div>
                  {notifItems.length === 0
                    ? <div className="notif-empty">You're all caught up.</div>
                    : notifItems.map((n, i) => (
                      <div key={i} className="notif-row">
                        <div className="notif-row-dot" style={{ background: n.color }} />
                        <div>
                          <div className="notif-row-title">{n.title}</div>
                          <div className="notif-row-sub">{n.sub}</div>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}
            <button className="sidebar-signout" onClick={signOut} title="Sign out">
              {collapsed ? '⎋' : 'Sign out'}
            </button>
            <button className="theme-btn" onClick={toggleTheme} title="Toggle theme">
              {theme === 'dark' ? '☀' : '🌙'}
            </button>
            <button
              className="sidebar-collapse-btn"
              onClick={toggleCollapse}
              style={{ marginLeft: 'auto' }}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▸' : '◄'}{!collapsed && <span> Collapse</span>}
            </button>
          </div>
        </div>
      </aside>

      {/* v2.21.0: drag handle to resize the sidebar (hidden in the icon rail). */}
      {!collapsed && (
        <div
          className="sidebar-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
        />
      )}

      {/* Page content */}
      <main className={`admin-content${collapsed ? ' collapsed' : ''}`}>
        <CredentialAlertBanner />
        {children}
      </main>
      {platformWN && (
        <WhatsNewModal
          appName="AppCrane"
          currentVersion={platformWN.currentVersion}
          changes={platformWN.changes}
          seenUrl={platformWN.seenUrl}
          primaryLabel={platformWN.primaryLabel}
          onPrimary={platformWN.onPrimary}
          onClose={() => setPlatformWN(null)}
        />
      )}
    </div>
  )
}
