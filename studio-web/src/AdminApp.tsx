import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthContext, useAuthState } from './hooks/useAuth'
import { useMe, isAdmin } from './hooks/useMe'
import { adminApi } from './adminApi'
import { Layout } from './components/Layout'
import { Login } from './components/Login'
import { Dashboard } from './pages/Dashboard'
import { Applications } from './pages/Applications'
import { Catalog } from './pages/Catalog'
import { AppStudio } from './pages/AppStudio'
import { Settings } from './pages/Settings'
import { Docs } from './pages/Docs'
import { AppManager } from './pages/AppManager'
import { MyRequests } from './pages/MyRequests'
import { PlatformRequestBar } from './components/PlatformRequestBar'
import { AppTabsProvider } from './components/AppTabsContext'
import { PersistentAppTabs } from './components/PersistentAppTabs'
import { isSafeRedirect } from './utils/safeRedirect'

// AppStudio top-level nav was collapsed in v1.27.38: Requests + Builders
// became top-level nav items, Skills + Style Guide (renamed from Branding)
// + Audit Log moved into Settings.
// `#agents` was folded into Users in v2.2.12 — the sub-nav entry was
// orphaned (Settings.tsx's VALID_TABS doesn't list it, so clicks
// silently fell through to Security). Removed from the nav in v2.5.10
// so users don't click a dead link. Old bookmarks still hit Security.
const SETTINGS_SUB = [
  // v2.13.0: MCP moved under Settings; visible to app-owners + platform-admins.
  { id: 'mcp',        label: 'MCP',         href: '#mcp',      ownerOrAdmin: true },
  { id: 'skills',     label: 'Skills',      href: '#skills',   adminOnly: true },
  { id: 'security',   label: 'Security',    href: '#security', platformAdminOnly: true },
  { id: 'users',      label: 'Users',       href: '#users',    platformAdminOnly: true },
  { id: 'roles',      label: 'Roles',       href: '#roles',    platformAdminOnly: true },
  { id: 'github',     label: 'GitHub',      href: '#github',   platformAdminOnly: true },
  { id: 'mail',       label: 'Mail',        href: '#mail',     platformAdminOnly: true },
  { id: 'backup',     label: 'Backup',      href: '#backup',   platformAdminOnly: true },
  { id: 'branding',   label: 'Style Guide', href: '#branding', platformAdminOnly: true },
  { id: 'audit',      label: 'Audit Log',   href: '#audit',    platformAdminOnly: true },
]

const DOCS_SUB = [
  { id: 'connect',  label: 'Connect',        href: '#connect' },
  { id: 'mcp',      label: 'MCP Tools',      href: '#mcp' },
  { id: 'email',    label: 'App Email',      href: '#email' },
  { id: 'rest',     label: 'REST API',       href: '#rest' },
  { id: 'manifest', label: 'deployhub.json', href: '#manifest' },
  { id: 'cli',      label: 'Operator CLI',   href: '#cli' },
]
// v2.6.9: `skills` moved to top-level /skills (visible to all admins,
// not just platform_admin). Old /settings#skills bookmarks fall
// through to Security via the valid-hash check below.

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.replace('#', ''))
  useEffect(() => {
    const fn = () => setHash(window.location.hash.replace('#', ''))
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return hash
}

function SettingsRoute() {
  const hash = useHash()
  const valid = ['mcp', 'skills', 'security', 'users', 'roles', 'github', 'mail', 'backup', 'branding', 'audit']
  const activeSub = valid.includes(hash) ? hash : 'security'
  return (
    <Layout subItems={SETTINGS_SUB} activeSub={activeSub}>
      <Settings />
    </Layout>
  )
}

function DocsRoute() {
  const hash = useHash()
  const valid = ['connect', 'mcp', 'email', 'rest', 'manifest', 'cli']
  const activeSub = valid.includes(hash) ? hash : 'connect'
  return (
    <Layout subItems={DOCS_SUB} activeSub={activeSub}>
      <Docs />
    </Layout>
  )
}

// v2.16.0: the Requests page is role-scoped. Platform/global admins and app
// owners get the triage view (all requests / their apps' requests, via
// /api/enhancements + /owned); everyone else gets their own requests
// (MyRequests → /api/enhancements/my) with delete. One nav item, one route.
function RequestsRoute() {
  const me = useMe()
  const adminLike = isAdmin(me)
  const [isOwner, setIsOwner] = useState<boolean | null>(null)
  useEffect(() => {
    if (me === null) return           // role not resolved yet
    if (adminLike) { setIsOwner(true); return }
    adminApi.get<{ apps: { app_role?: string }[] }>('/api/apps')
      .then(r => setIsOwner((r.apps || []).some(a => a.app_role === 'owner')))
      .catch(() => setIsOwner(false))
  }, [me, adminLike])
  const resolving = me === null || isOwner === null
  const triage = adminLike || isOwner === true
  return (
    <Layout>
      {resolving ? null : (
        <>
          <PlatformRequestBar />
          {triage ? <AppStudio tab="requests" /> : <MyRequests />}
        </>
      )}
    </Layout>
  )
}

export function AdminApp() {
  const auth = useAuthState()

  // v2.7.8: re-establish the httpOnly cc_token cookie that Caddy's
  // forward_auth reads. The cookie is now httpOnly, so the SPA can't write
  // it directly anymore — instead we POST the surviving localStorage session
  // token to /api/identity/refresh-cookie, which validates it and sets the
  // cookie server-side. Covers pre-httpOnly sessions and any cookie loss.
  // Runs once per mount; harmless no-op (re-sets the same cookie) otherwise.
  useEffect(() => {
    try {
      const lsToken = localStorage.getItem('cc_identity_token')
      if (lsToken && lsToken.length > 10) {
        fetch('/api/identity/refresh-cookie', {
          method: 'POST',
          headers: { Authorization: `Bearer ${lsToken}` },
        }).catch(() => {})
      }
    } catch (_) { /* SSR / non-browser — fine */ }
  }, [])

  // v2.5.14: when an already-authed user lands at <landing>?redirect=/foo
  // (the case where /login was redirected here from forward_auth + the user
  // already had a valid token), forward them to the original target instead
  // of leaving them stranded on the landing page. Skip if the redirect points
  // back at a landing route to avoid a fresh loop.
  // v2.33.0: `launch` joins the list — sign-in now lands there, so
  // `?redirect=/launch` would otherwise trigger a pointless extra navigation
  // back to the page already being rendered.
  if (auth.isAuthed && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    const redirect = params.get('redirect')
    // v2.35.0: isSafeRedirect, not startsWith('/') — `//attacker.com` starts
    // with a slash and is an absolute cross-origin URL. See safeRedirect.ts.
    if (isSafeRedirect(redirect) &&
        !/^\/(login|applications|launch)(\/|\?|$)/.test(redirect as string)) {
      // Same Referer concern as Login.tsx: a same-origin hop sends the full
      // URL, and the deep-link target may be a tenant app served at /<slug>.
      if (params.has('oidc_token')) {
        const clean = new URL(window.location.href)
        clean.searchParams.delete('oidc_token')
        window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash)
      }
      window.location.replace(redirect as string)
      return null
    }
  }

  if (!auth.isAuthed) {
    return (
      <AuthContext.Provider value={auth}>
        <Login />
      </AuthContext.Provider>
    )
  }

  return (
    <AuthContext.Provider value={auth}>
      <AppTabsProvider>
      <BrowserRouter>
        <Routes>
          {/* v2.21.16: land on the app picker (/launch shows "Select an app")
              instead of the Dashboard, so the first screen is choosing an app. */}
          <Route path="/" element={<Navigate to="/launch" replace />} />
          <Route path="/dashboard" element={<Layout><Dashboard /></Layout>} />
          <Route path="/applications" element={<Layout><Applications /></Layout>} />
          {/* The app catalogue. requireAuth on the server, no admin gate here:
              every logged-in user browses it, and only the deploy button is
              conditioned on `platform.create_app` (reported by the payload). */}
          <Route path="/catalog"     element={<Layout><Catalog /></Layout>} />
          {/* Routes moved to Settings sub-tabs in v1.27.x — keep redirects
              so old bookmarks still work. */}
          <Route path="/users-page"  element={<Navigate to="/settings#users" replace />} />
          <Route path="/audit-page"  element={<Navigate to="/settings#audit" replace />} />
          {/* AppStudio collapsed: Requests is top-level. Builders removed
              v1.27.89 — internal builders moved to local Claude Code via MCP. */}
          {/* v2.16.0: one role-scoped Requests page (admin=all, owner=their
              apps, user=own). Old /my-requests link folds back into it. */}
          <Route path="/requests"    element={<RequestsRoute />} />
          <Route path="/my-requests" element={<Navigate to="/requests" replace />} />
          <Route path="/builders"    element={<Navigate to="/requests" replace />} />
          <Route path="/appstudio"   element={<Navigate to="/requests" replace />} />
          {/* v2.13.0: MCP moved under Settings. Old links redirect. */}
          <Route path="/mcp"         element={<Navigate to="/settings#mcp" replace />} />
          {/* v2.13.0: launcher merged into the main nav. Apps open inline here. */}
          {/* v2.15.0: the launch view is the persistent tab host (below), which
              overlays the content area. These routes just render the chrome. */}
          <Route path="/launch"        element={<Layout>{null}</Layout>} />
          <Route path="/launch/:slug"  element={<Layout>{null}</Layout>} />
          {/* v2.6.9: Skills promoted out of /settings to a top-level
              admin-readable page. SkillsTab is self-contained — same
              component the old /settings#skills mounted. */}
          {/* v2.14.3: Skills moved under Settings. Old links redirect. */}
          <Route path="/skills"      element={<Navigate to="/settings#skills" replace />} />
          {/* Legacy /settings#skills bookmark → top-level /skills */}
          <Route path="/settings"    element={<SettingsRoute />} />
          <Route path="/docs"        element={<DocsRoute />} />
          <Route path="/app"         element={<Layout><AppManager /></Layout>} />
          <Route path="*"            element={<Navigate to="/launch" replace />} />
        </Routes>
        <PersistentAppTabs />
      </BrowserRouter>
      </AppTabsProvider>
    </AuthContext.Provider>
  )
}
