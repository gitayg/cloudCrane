import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { adminApi } from '../adminApi'

const NAV = [
  { id: 'dashboard',    label: 'Dashboard',    href: '/dashboard',    icon: '⊞' },
  { id: 'applications', label: 'Applications', href: '/applications', icon: '▣' },
  { id: 'users',        label: 'Users',         href: '/users-page',   icon: '◉' },
  { id: 'audit',        label: 'Audit Log',     href: '/audit-page',   icon: '≡' },
  { id: 'appstudio',    label: 'AppStudio',     href: '/appstudio',    icon: '✦' },
  { id: 'docs',         label: 'Docs',          href: '/docs',         icon: '📖' },
  { id: 'settings',     label: 'Settings',      href: '/settings',     icon: '⚙' },
]

interface SubItem { id: string; label: string; href: string }

interface Props {
  children: React.ReactNode
  subItems?: SubItem[]
  activeSub?: string
}

export function Layout({ children, subItems, activeSub }: Props) {
  const { key, signOut } = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('cc_sb_col') === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('cc_theme') || 'dark')
  const [userName, setUserName] = useState('')
  const [version, setVersion] = useState('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifItems, setNotifItems] = useState<{ title: string; sub: string; color: string }[]>([])
  const [notifLoaded, setNotifLoaded] = useState(false)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!key) return
    adminApi.get<{ user: { name: string; role: string } }>('/api/auth/me')
      .then(d => setUserName(d.user.name + ' (' + d.user.role + ')'))
      .catch(() => {})
    adminApi.get<{ version: string }>('/api/info')
      .then(d => setVersion('v' + d.version))
      .catch(() => {})
  }, [key])

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

  const openNotif = useCallback(async () => {
    const next = !notifOpen
    setNotifOpen(next)
    if (next && !notifLoaded) {
      setNotifLoaded(true)
      try {
        const data = await adminApi.get<{ apps: any[] }>('/api/apps')
        const items: typeof notifItems = []
        for (const a of data.apps || []) {
          if (a.prod_down) items.push({ title: a.name + ' (prod)', sub: 'Health check failing', color: 'var(--red)' })
          if (a.sand_down) items.push({ title: a.name + ' (sandbox)', sub: 'Health check failing', color: 'var(--orange)' })
        }
        setNotifItems(items)
      } catch {}
    }
  }, [notifOpen, notifLoaded])

  const currentPath = location.pathname
  const activeNav = NAV.find(n => n.href === currentPath)
  const activeNavId = activeNav?.id ?? ''
  const pageTitle = activeNav?.label ?? ''

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
          {!collapsed && version && (
            <span
              className="sidebar-logo-version"
              id="craneVersion"
              title="Click to check for updates"
              onClick={async () => {
                const el = document.getElementById('craneVersion')
                if (!el) return
                el.textContent = 'checking...'
                try {
                  const data = await adminApi.get<any>('/api/version-check')
                  if (data.update_available) {
                    el.textContent = 'v' + data.current + ' → v' + data.latest + ' available!'
                    if (confirm('Update to v' + data.latest + '?')) {
                      el.textContent = 'updating...'
                      await adminApi.post('/api/self-update')
                      setTimeout(() => window.location.reload(), 5000)
                    }
                  } else {
                    el.textContent = 'v' + data.current + ' (latest)'
                    setTimeout(() => { el.textContent = version }, 3000)
                  }
                } catch { el.textContent = 'check failed' }
              }}
            >
              {version}
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="sidebar-nav">
          {NAV.map(p => (
            <div key={p.id}>
              <NavLink
                to={p.href}
                className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
                title={p.label}
              >
                <span className="sidebar-link-icon">{p.icon}</span>
                <span className="sidebar-link-text">{p.label}</span>
              </NavLink>
              {activeNavId === p.id && subItems && subItems.length > 0 && !collapsed && (
                <div className="sidebar-sub-nav">
                  {subItems.map(s => (
                    <a
                      key={s.id}
                      href={s.href}
                      className={'sidebar-sub-link' + (activeSub === s.id ? ' active' : '')}
                    >
                      {s.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="sidebar-footer">
          <div className="sidebar-footer-links">
            <a href="/agent-guide">Agent Guide</a>
          </div>
          <div className="sidebar-footer-row">
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

      {/* Page content */}
      <main className={`admin-content${collapsed ? ' collapsed' : ''}`}>
        <div className="admin-topbar">
          <span className="admin-topbar-title">{pageTitle}</span>
          <div className="admin-topbar-right">
            <div className="notif-wrap" ref={notifRef}>
              <button className="notif-bell-btn" onClick={openNotif} title="Notifications">🔔</button>
              {notifItems.length > 0 && (
                <span className="notif-badge show">{notifItems.length}</span>
              )}
              <div className={`notif-dropdown${notifOpen ? ' open' : ''}`}>
                <div className="notif-dd-hdr">Notifications</div>
                {notifItems.length === 0
                  ? <div className="notif-empty">All systems operational ✓</div>
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
            {userName && <span className="admin-topbar-user">{userName}</span>}
            <button className="admin-topbar-signout" onClick={signOut}>Sign out</button>
          </div>
        </div>
        {children}
      </main>
    </div>
  )
}
