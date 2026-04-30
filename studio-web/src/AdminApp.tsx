import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthContext, useAuthState } from './hooks/useAuth'
import { Layout } from './components/Layout'
import { Login } from './components/Login'
import { Dashboard } from './pages/Dashboard'
import { Applications } from './pages/Applications'
import { Users } from './pages/Users'
import { AuditLog } from './pages/AuditLog'
import { AppStudio } from './pages/AppStudio'
import { Settings } from './pages/Settings'
import { Docs } from './pages/Docs'

const STUDIO_SUB = [
  { id: 'requests', label: 'Requests', href: '#requests' },
  { id: 'library',  label: 'Library',  href: '#library' },
  { id: 'studio',   label: 'Studio',   href: '#studio' },
]

const SETTINGS_SUB = [
  { id: 'branding',  label: 'Branding',  href: '#branding' },
  { id: 'security',  label: 'Security',  href: '#security' },
  { id: 'appstudio', label: 'AppStudio', href: '#appstudio' },
]

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.replace('#', ''))
  useEffect(() => {
    const fn = () => setHash(window.location.hash.replace('#', ''))
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return hash
}

function AppStudioRoute() {
  const hash = useHash()
  const activeSub = ['requests', 'library', 'studio'].includes(hash) ? hash : 'requests'
  return (
    <Layout subItems={STUDIO_SUB} activeSub={activeSub}>
      <AppStudio />
    </Layout>
  )
}

function SettingsRoute() {
  const hash = useHash()
  const activeSub = ['branding', 'security', 'appstudio'].includes(hash) ? hash : 'appstudio'
  return (
    <Layout subItems={SETTINGS_SUB} activeSub={activeSub}>
      <Settings />
    </Layout>
  )
}

export function AdminApp() {
  const auth = useAuthState()

  if (!auth.isAuthed) {
    return (
      <AuthContext.Provider value={auth}>
        <Login />
      </AuthContext.Provider>
    )
  }

  return (
    <AuthContext.Provider value={auth}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Layout><Dashboard /></Layout>} />
          <Route path="/applications" element={<Layout><Applications /></Layout>} />
          <Route path="/users-page" element={<Layout><Users /></Layout>} />
          <Route path="/audit-page" element={<Layout><AuditLog /></Layout>} />
          <Route path="/appstudio" element={<AppStudioRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="/docs" element={<Layout><Docs /></Layout>} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  )
}
