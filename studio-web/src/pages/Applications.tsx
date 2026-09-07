import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { adminApi } from '../adminApi'
import { PresenceAvatars } from '../components/runtime-topbar/PresenceAvatars'
import { JobsButton } from '../components/runtime-topbar/JobsButton'
import { RequestModal } from '../components/runtime-topbar/RequestModal'
import { WhatsNewModal, type WhatsNewChange } from '../components/WhatsNewModal'
import { AppAccessModal } from '../components/AppAccessModal'
import { usePeek, type PeekCtx } from '../hooks/usePeek'
import { Navigate, useLocation } from 'react-router-dom'
import { useMe, isAdmin, canCreateApps } from '../hooks/useMe'
import { BugPanel } from '../components/runtime-topbar/BugPanel'
import { defineCraneAppTopbar } from '../topbar-element/entry'
import { Icon } from '../components/icons'
import '../topbar-element/jsx.d.ts'

defineCraneAppTopbar()

interface App {
  slug: string
  name: string
  description?: string
  category?: string
  visibility?: string
  github_url?: string
  source_type?: string
  has_icon?: boolean
  has_github_token?: boolean
  resource_limits?: { max_ram_mb?: number; max_cpu_percent?: number }
  image_retention?: number
  frame_ancestors?: string | null
  auth_bypass_paths?: string[] | null
  // v2.42.0: layer-4 ingress. 'tcp' means the container's port is published
  // directly on the host at public_port, with Caddy out of the path entirely.
  // v2.45.0 adds 'dual': BOTH planes at once — the HTTP control plane keeps
  // going through Caddy on container port 3000, and a second listener inside
  // the same container (data_plane_port) is published raw at public_port.
  ingress_type?: 'http' | 'tcp' | 'dual'
  public_port?: number | null
  // v2.46.0: the SANDBOX container's own host port. Independent of public_port
  // and opt-in — null means sandbox publishes nothing, as it always did.
  sandbox_public_port?: number | null
  // The CONTAINER side of a dual app's raw publish. Null on every other type —
  // a pure-tcp app publishes the whole container, so it has no second number.
  data_plane_port?: number | null
  // v2.45.3: whether the RUNNING container actually carries the configured
  // publish. null = could not be read, which is NOT the same as "closed".
  publish_applied?: boolean | null
  publish_drift?: { state: string; message: string } | null
  // A port the app was switched away from but whose container has not been
  // recreated yet: AppCrane publishes nothing, the host port is still open.
  // Reported by the API rather than inferred here — the UI can't know what the
  // running container was started with.
  pending_port_release?: number | null
  domain?: string | null
  domain_aliases?: { id: number; domain: string; source: string; created_at: string }[]
  owner?: { id: number; name: string; email: string } | null
  owners?: { id: number; name: string; email: string }[]
  app_role?: 'owner' | 'admin' | 'user' | 'viewer' | 'none'
  production?: { deploy?: { status?: string; version?: string }; health?: { status: string } }
  sandbox?: { deploy?: { status?: string; version?: string }; health?: { status: string } }
}

interface EnvVar {
  key: string
  value: string
}

interface FrameState {
  open: boolean
  url: string
  title: string
  slug?: string
  appName?: string
  env?: 'production' | 'sandbox'
  prodUrl?: string
  sandUrl?: string
  prodVersion?: string
  sandVersion?: string
  hasIcon?: boolean
  hasGithub?: boolean
}

interface PromptModal {
  open: boolean
  key?: string
  prompt?: string
  title?: string
  // v2.7.15: independently-copyable sections (e.g. "Managed Code" vs
  // "Unmanaged (GitHub)") so the user copies just the path they want.
  sections?: { label: string; text: string }[]
}

type SortKey = 'name' | 'visibility' | 'category' | 'ram' | 'cpu' | 'images' | 'storage'

type IngressType = 'http' | 'tcp' | 'dual'

// The band a port AppCrane allocates for you comes from, so an operator's
// firewall rule is one predictable block. An explicitly named port may be
// anything in PUBLIC_PORT_MIN..MAX — clients get configured with a port by hand
// or by MDM, and a number like 8080 is often not the platform's to choose.
// Mirrors server/services/tcpIngress.js; the server is the enforcer either way.
const PUBLIC_PORT_MIN = 1024
const PUBLIC_PORT_MAX = 65535
// The two ranges as copy. Written out rather than interpolated from the numbers
// above: `{MIN}-{MAX}` inside JSX compiles to three separate children, so the
// range an operator greps the shipped dashboard for ("31000-31999") would never
// appear as one string in the bundle at all.
const AUTO_PORT_RANGE = '31000-31999'
const PUBLIC_PORT_RANGE = '1024-65535'
// The container port every app's HTTP control plane listens on — the one Caddy
// proxies to. Refused as a data-plane port, because publishing it raw is
// publishing the control plane.
const CONTROL_PLANE_PORT = 3000
// Same reason as the range strings: this one is a fixed mapping, not a
// per-app value, so it is written out and stays one greppable string in the
// shipped bundle instead of three JSX children.
const CONTROL_PLANE_MAPPING = 'container:3000'

// Both types that put a port on the host. Written as one predicate rather than
// `=== 'tcp'` in a dozen places: every one of those comparisons was a place a
// dual app would have silently read as an ordinary Caddy-fronted app.
const publishesPort = (t?: string): boolean => t === 'tcp' || t === 'dual'

// Human-readable byte size, e.g. 1536 -> "1.5 KB". Used for the per-app
// persistent-storage (/data) usage shown in the Manage drill-down.
function fmtBytes(n: number): string {
  if (!n || n < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// v2.21.25: click-to-edit table cell. Renders the value as plain text (a
// keyboard-focusable trigger) until clicked/activated, then swaps to an input —
// so the Manage table reads as data, not a wall of form fields. Enter commits,
// Esc reverts, blur commits (only if changed). Disabled cells show text only.
function EditableCell({
  value, onSave, type = 'text', placeholder = '—', disabled = false,
  ariaLabel, title, inputStyle, min, max, display,
}: {
  value: string | number
  onSave: (v: string) => void
  type?: 'text' | 'number'
  placeholder?: string
  disabled?: boolean
  ariaLabel: string
  title?: string
  inputStyle?: CSSProperties
  min?: number
  max?: number
  display?: (v: string | number) => ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const orig = value == null ? '' : String(value)
  if (editing && !disabled) {
    return (
      <input
        className="editable" type={type} autoFocus defaultValue={orig}
        aria-label={ariaLabel} min={min} max={max}
        onBlur={e => {
          setEditing(false)
          if (e.target.value !== orig) { onSave(e.target.value); setSaved(true); window.setTimeout(() => setSaved(false), 1500) }
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { e.currentTarget.value = orig; e.currentTarget.blur() }
        }}
        style={inputStyle}
      />
    )
  }
  const isEmpty = orig === ''
  return (
    <button
      type="button" className="cell-edit-trigger" disabled={disabled}
      aria-label={disabled ? ariaLabel : `${ariaLabel} — click to edit`}
      title={title ?? (disabled ? undefined : 'Click to edit')}
      onClick={() => { if (!disabled) setEditing(true) }}
      style={isEmpty ? { color: 'var(--dim)' } : undefined}
    >
      {isEmpty ? placeholder : (display ? display(value) : orig)}
      {saved && <span aria-label="saved" style={{ color: 'var(--green)', marginLeft: 5, fontWeight: 700 }}>✓</span>}
    </button>
  )
}

// v2.21.25: inline Lucide-style SVG icons (replace the emoji-as-icon action
// buttons — consistent across OSes, crisp, and colorable via currentColor).
function svgIcon(children: ReactNode, size = 14) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      {children}
    </svg>
  )
}
const IconImage = () => svgIcon(<><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>)
const IconUnlock = () => svgIcon(<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>)
const IconGlobe = () => svgIcon(<><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>)
const IconActivity = () => svgIcon(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />)
const IconPlug = () => svgIcon(<><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></>)
const IconTrash = () => svgIcon(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></>)
const IconChevron = ({ open }: { open: boolean }) => svgIcon(open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 18 6-6-6-6" />)

// v2.21.8: tiny multi-line SVG chart for the per-app resource modal.
interface Series { label: string; color: string; points: { x: number; v: number }[] }
function ResourceChart({ title, unit, series }: { title: string; unit: string; series: Series[] }) {
  const W = 520, H = 130, PL = 44, PR = 12, PT = 12, PB = 22
  const cw = W - PL - PR, ch = H - PT - PB
  const xs = series.flatMap(s => s.points.map(p => p.x))
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 1)
  const maxV = Math.max(...series.flatMap(s => s.points.map(p => p.v)), 1)
  const xOf = (x: number) => PL + ((x - minX) / (maxX - minX || 1)) * cw
  const yOf = (v: number) => PT + ch - (v / maxV) * ch
  const has = series.some(s => s.points.length > 1)
  return (
    <div>
      <div style={{ fontSize: '.8rem', fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {has ? (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
          <line x1={PL} y1={PT} x2={PL} y2={PT + ch} stroke="var(--border)" />
          <line x1={PL} y1={PT + ch} x2={W - PR} y2={PT + ch} stroke="var(--border)" />
          <text x={PL - 5} y={PT + 8} textAnchor="end" fontSize="9" fill="var(--dim)">{Math.round(maxV)}{unit}</text>
          <text x={PL - 5} y={PT + ch} textAnchor="end" fontSize="9" fill="var(--dim)">0</text>
          {series.map((s, i) => s.points.length > 1 && (
            <polyline key={i} fill="none" stroke={s.color} strokeWidth="1.5"
              points={s.points.map(p => `${xOf(p.x).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ')} />
          ))}
        </svg>
      ) : (
        <div style={{ fontSize: '.78rem', color: 'var(--dim)', padding: '14px 0' }}>No samples yet — collected every 5 minutes while running.</div>
      )}
      <div style={{ display: 'flex', gap: 14, fontSize: '.72rem', color: 'var(--dim)', marginTop: 2 }}>
        {series.map((s, i) => <span key={i}><span style={{ color: s.color }}>●</span> {s.label}</span>)}
      </div>
    </div>
  )
}

export function Applications() {
  const me = useMe()
  // v2.5.0 role-aware view mode. End users default to launcher (tile
  // grid, no manage chrome). Admins / platform_admins default to manage
  // (the existing table) but can flip to launcher via the toggle. Stored
  // in localStorage so the choice persists across reloads.
  //
  // v2.5.17 fix: useState initializer ran before /api/auth/me resolved,
  // so isAdmin(null) was always false and the default fell to 'launcher'
  // for every user including platform_admin. Now: start `null` until me
  // loads, then resolve to the role-appropriate default. Saved
  // localStorage value still wins. Toggle button stays interactive.
  const adminLike = isAdmin(me)
  // v2.21.5: CPU/memory limits are platform-admin only.
  const isPlatformAdmin = me?.user?.role === 'platform_admin'
  // v2.7.0: "+ Add Application" shows for anyone with the create-apps
  // permission (global admins, or a tier a platform admin granted) — in
  // both the Launcher and Manage views, not just admins in Manage.
  const mayCreateApp = canCreateApps(me)
  // v2.14.1: the sidebar "+ Add Application" button navigates here with
  // { addApp: true } — auto-open the onboarding flow, then clear the state so
  // a refresh doesn't re-trigger it.
  const location = useLocation()
  useEffect(() => {
    if ((location.state as { addApp?: boolean } | null)?.addApp) {
      generateAgentKey()
      window.history.replaceState({}, '')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // v2.13.0: the launcher view was dissolved into the main sidebar nav, so
  // Applications is now just the admin manage table. Non-admins are redirected
  // to /launch (see below).

  const [apps, setApps] = useState<App[]>([])
  const [versions, setVersions] = useState<Record<string, { prod?: string; sand?: string }>>({})
  const [openEvars, setOpenEvars] = useState<Record<string, string | null>>({})
  const [evarData, setEvarData] = useState<Record<string, EnvVar[]>>({})
  const [frame, setFrame] = useState<FrameState>({ open: false, url: '', title: '' })
  const [framePanel, setFramePanel] = useState<'ask' | 'request' | 'bug' | null>(null)
  const [promptModal, setPromptModal] = useState<PromptModal>({ open: false })
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null)
  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedLabel(label)
      setTimeout(() => setCopiedLabel(l => (l === label ? null : l)), 1500)
    }).catch(() => {})
  }
  const [checkUpdateText, setCheckUpdateText] = useState<Record<string, string>>({})
  const [iconUrls, setIconUrls] = useState<Record<string, string>>({})

  // v2.5.21: per-app Users modal — replaces the old wide N×M App Roles
  // matrix that lived under /settings#users. Click "Users" on an app row
  // to open a focused modal that lists every user with a role select for
  // this specific app.
  const [usersModalApp, setUsersModalApp] = useState<App | null>(null)
  // v2.41.0: per-app Access modal — the app's OWN roles plus who holds them.
  // Separate from the Users modal on purpose: Users is where membership and
  // AppCrane's tier are set, Access is where the app's own vocabulary lives.
  const [accessModalApp, setAccessModalApp] = useState<App | null>(null)
  // v2.21.7: auto-deploy (webhook) config modal.
  type HookCfg = { token?: string; auto_deploy_sandbox?: boolean; auto_deploy_prod?: boolean; branch_filter?: string }
  const [hookApp, setHookApp] = useState<App | null>(null)
  const [hookCfg, setHookCfg] = useState<HookCfg | null>(null)
  // v2.21.8: per-app CPU/memory chart modal.
  type MetricRow = { env: string; cpu_percent: number; mem_mb: number; recorded_at: string }
  const [metricsApp, setMetricsApp] = useState<App | null>(null)
  const [metricsRows, setMetricsRows] = useState<MetricRow[] | null>(null)
  // v2.42.0: per-app ingress modal. Read-only for everyone except platform
  // admins — the state has to be visible to whoever runs the app even when
  // they can't change it, because it tells them their app is reachable on a
  // port that AppCrane does not guard.
  const [ingressApp, setIngressApp] = useState<App | null>(null)
  const [ingressDraft, setIngressDraft] = useState<{ type: IngressType; port: string; dataPort: string; sandboxPort: string }>({ type: 'http', port: '', dataPort: '', sandboxPort: '' })
  const [ingressBusy, setIngressBusy] = useState(false)
  // v2.7.24: client-side filter for the per-app Users modal (name / email).
  // Resets to empty on every close so opening another app doesn't carry over.
  const [usersModalFilter, setUsersModalFilter] = useState('')
  type ModalUser = { id: number; name: string; email: string | null; role: string; app_role: 'none' | 'user' | 'admin' | 'owner' }
  const [usersModalData, setUsersModalData] = useState<ModalUser[] | null>(null)
  const [usersModalSaving, setUsersModalSaving] = useState<Record<number, 'saving' | 'saved' | 'error'>>({})
  useEffect(() => {
    if (!usersModalApp) { setUsersModalData(null); return }
    let cancelled = false
    Promise.all([
      adminApi.get<{ users: { id: number; name: string; email: string | null; role: string }[] }>('/api/users'),
      adminApi.get<{ users: { id: number; app_role: ModalUser['app_role'] }[] }>(`/api/apps/${usersModalApp.slug}/identity/users`),
    ])
      .then(([allUsers, appUsers]) => {
        if (cancelled) return
        const roleByUserId = new Map(appUsers.users.map(u => [u.id, u.app_role]))
        const merged: ModalUser[] = (allUsers.users || []).map(u => ({
          id: u.id, name: u.name, email: u.email, role: u.role,
          app_role: roleByUserId.get(u.id) ?? 'none',
        }))
        setUsersModalData(merged)
      })
      .catch(() => { if (!cancelled) setUsersModalData([]) })
    return () => { cancelled = true }
  }, [usersModalApp])

  async function changeUserAppRole(userId: number, newRole: ModalUser['app_role']) {
    if (!usersModalApp) return
    const prev = usersModalData?.find(u => u.id === userId)?.app_role ?? 'none'
    setUsersModalData(d => d ? d.map(u => u.id === userId ? { ...u, app_role: newRole } : u) : d)
    setUsersModalSaving(s => ({ ...s, [userId]: 'saving' }))
    try {
      await adminApi.put(`/api/apps/${usersModalApp.slug}/roles`, { user_id: userId, app_role: newRole })
      setUsersModalSaving(s => ({ ...s, [userId]: 'saved' }))
      setTimeout(() => setUsersModalSaving(s => {
        if (s[userId] !== 'saved') return s
        const c = { ...s }; delete c[userId]; return c
      }), 1800)
    } catch (e) {
      setUsersModalData(d => d ? d.map(u => u.id === userId ? { ...u, app_role: prev } : u) : d)
      setUsersModalSaving(s => ({ ...s, [userId]: 'error' }))
      alert('Save failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // v2.21.7: load the app's webhook/auto-deploy config when the modal opens.
  useEffect(() => {
    if (!hookApp) { setHookCfg(null); return }
    let cancelled = false
    adminApi.get<HookCfg>(`/api/apps/${hookApp.slug}/webhook`)
      .then(c => { if (!cancelled) setHookCfg(c || {}) })
      .catch(() => { if (!cancelled) setHookCfg({}) })
    return () => { cancelled = true }
  }, [hookApp])

  async function saveHook(patch: Partial<HookCfg>) {
    if (!hookApp) return
    setHookCfg(c => ({ ...(c ?? {}), ...patch }))
    await adminApi.put(`/api/apps/${hookApp.slug}/webhook`, patch).catch(() => {})
  }

  // v2.21.8: load the app's CPU/mem samples when the metrics modal opens.
  useEffect(() => {
    if (!metricsApp) { setMetricsRows(null); return }
    let cancelled = false
    adminApi.get<{ metrics: MetricRow[] }>(`/api/apps/${metricsApp.slug}/metrics?hours=24`)
      .then(r => { if (!cancelled) setMetricsRows(r.metrics || []) })
      .catch(() => { if (!cancelled) setMetricsRows([]) })
    return () => { cancelled = true }
  }, [metricsApp])

  // Filter / sort state for the table view (v1.27.41).
  const [filter, setFilter] = useState({ vis: '', name: '', tag: '', ramMin: '', cpuMin: '' })
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })

  // Tag editor: when user picks "+ New tag" in the Tag dropdown, switch
  // that row's tag cell into a free-text input. Map slug -> draft string.
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({})

  // Drill-down state — sandbox + production controls live in an
  // expandable row below each app to keep the table compact (v1.27.47).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Persistent-storage (/data) usage per app, lazily fetched when a row is
  // expanded — computing it walks the volume, so we don't do it for every app
  // on load. slug -> { production, sandbox } bytes | 'loading' | 'error'.
  type StorageUse = { production: number; sandbox: number }
  const [storage, setStorage] = useState<Record<string, StorageUse | 'loading' | 'error'>>({})
  useEffect(() => {
    for (const slug of Object.keys(expanded)) {
      if (!expanded[slug]) continue
      setStorage(prev => {
        if (prev[slug]) return prev  // already loading / loaded
        adminApi.get<{ storage: StorageUse }>(`/api/apps/${slug}/storage`)
          .then(r => setStorage(p => ({ ...p, [slug]: r.storage })))
          .catch(() => setStorage(p => ({ ...p, [slug]: 'error' })))
        return { ...prev, [slug]: 'loading' }
      })
    }
  }, [expanded])

  // Total on-disk footprint per app (releases + /data, both envs) for the
  // sortable Storage column. One bulk call (server walks each app dir), fetched
  // once on mount — null while loading. This is the number that sums to host
  // disk usage, unlike the per-env /data figure shown in the drill-down.
  const [appStorage, setAppStorage] = useState<Record<string, number> | null>(null)
  // True once the first /api/apps load resolves — before that we show skeleton
  // rows instead of a misleading "No apps" empty state.
  const [loaded, setLoaded] = useState(false)
  // Bulk multi-select: slugs currently checked, for bulk visibility/tag/delete.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    adminApi.get<{ apps: { slug: string; total_bytes: number }[] }>('/api/dashboard/app-storage')
      .then(r => setAppStorage(Object.fromEntries(r.apps.map(a => [a.slug, a.total_bytes]))))
      .catch(() => setAppStorage({}))
  }, [])

  const iconInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  async function loadAll() {
    const ar = await adminApi.get<{ apps: App[] }>('/api/apps').catch(() => ({ apps: [] as App[] }))
    // Sort apps alphabetically by name (case-insensitive). The /api/apps
    // endpoint returns insertion order which makes the list hard to scan
    // once you have more than a handful.
    const a = (ar.apps ?? []).slice().sort((x, y) =>
      (x.name || '').toLowerCase().localeCompare((y.name || '').toLowerCase()),
    )
    setApps(a)
    setLoaded(true)
    fetchVersions(a)
    // Prefer the freshly-fetched icon state over what's in `prev` so a
    // newly-uploaded icon (or a deleted one) takes effect immediately.
    // The previous {...iconMap, ...prev} ordering let stale state win.
    // Cache-bust by appending the load timestamp; the icon endpoint
    // ignores query strings.
    const iconMap: Record<string, string> = {}
    const stamp = Date.now()
    for (const app of a) {
      if (app.has_icon) iconMap[app.slug] = `/api/apps/${app.slug}/icon?v=${stamp}`
    }
    setIconUrls(iconMap)
  }

  function fetchVersions(appList: App[]) {
    appList.forEach(app => {
      ['production', 'sandbox'].forEach(env => {
        adminApi
          .get<{ version?: string }>(`/api/apps/${app.slug}/live-version/${env}`)
          .then(r => {
            setVersions(prev => ({
              ...prev,
              [app.slug]: {
                ...prev[app.slug],
                [env === 'production' ? 'prod' : 'sand']: r?.version ?? '—',
              },
            }))
          })
          .catch(() => {})
      })
    })
  }

  useEffect(() => {
    loadAll()
  }, [])

  // MCP recently-active per app (last 5 min). Polls every 30s.
  const [mcpActive, setMcpActive] = useState<Record<string, { last_at: string; calls: number }>>({})
  useEffect(() => {
    let cancelled = false
    function refresh() {
      adminApi.get<{ active: { slug: string; last_at: string; calls: number }[] }>('/api/mcp/recent-activity?minutes=5')
        .then(r => {
          if (cancelled) return
          const m: Record<string, { last_at: string; calls: number }> = {}
          for (const row of r.active ?? []) m[row.slug] = { last_at: row.last_at, calls: row.calls }
          setMcpActive(m)
        })
        .catch(() => {})
    }
    refresh()
    const iv = setInterval(refresh, 30000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])

  async function setVisibility(slug: string, vis: string) {
    await adminApi.put(`/api/apps/${slug}`, { visibility: vis }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug ? { ...a, visibility: vis } : a))
  }

  async function deleteApp(slug: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return
    if (!confirm(`This is irreversible. Really delete "${name}"?`)) return
    await adminApi.del(`/api/apps/${slug}?confirm=true`).catch(() => {})
    loadAll()
  }

  async function restartApp(slug: string, env: string) {
    await adminApi.post(`/api/apps/${slug}/restart/${env}`).catch(() => {})
  }

  async function checkUpdates(slug: string) {
    type UpdatesRes = {
      latest_sha?: string
      latest_message?: string
      production?: { deployed_sha?: string | null; update_available?: boolean }
      sandbox?: { deployed_sha?: string | null; update_available?: boolean }
      error?: { message?: string }
    }
    const r = await adminApi.get<UpdatesRes>(`/api/apps/${slug}/updates`).catch(() => null)
    let text: string
    if (!r) text = 'Error'
    else if (r.error) text = r.error.message || 'Error'
    else if (r.production?.update_available || r.sandbox?.update_available) {
      const envs = [
        r.production?.update_available ? 'prod' : null,
        r.sandbox?.update_available ? 'sand' : null,
      ].filter(Boolean).join(' + ')
      text = `↑ ${envs} → ${r.latest_sha ?? 'new'}`
    } else {
      text = '✓ up to date'
    }
    setCheckUpdateText(prev => ({ ...prev, [slug]: text }))
    setTimeout(() => setCheckUpdateText(prev => ({ ...prev, [slug]: '' })), 5000)
  }

  async function registerGithubHook(slug: string) {
    const r = await adminApi.post<{ message?: string; error?: string }>(`/api/apps/${slug}/webhook/register-github`).catch(() => null)
    alert(r?.message ?? r?.error ?? 'Done')
  }

  async function saveRam(slug: string, raw: string) {
    const ram = raw.trim() ? Number(raw) : null
    if (raw.trim() && (isNaN(ram!) || ram! < 0)) return
    await adminApi.put(`/api/apps/${slug}`, { max_ram_mb: ram }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug
      ? { ...a, resource_limits: { ...(a.resource_limits ?? {}), max_ram_mb: ram ?? undefined } }
      : a))
  }

  async function saveCpu(slug: string, raw: string) {
    const cpu = raw.trim() ? Number(raw) : null
    if (raw.trim() && (isNaN(cpu!) || cpu! < 0)) return
    await adminApi.put(`/api/apps/${slug}`, { max_cpu_percent: cpu }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug
      ? { ...a, resource_limits: { ...(a.resource_limits ?? {}), max_cpu_percent: cpu ?? undefined } }
      : a))
  }

  async function saveImages(slug: string, raw: string) {
    if (!raw.trim()) return
    const n = parseInt(raw, 10)
    if (isNaN(n) || n < 0 || n > 50) return
    await adminApi.put(`/api/apps/${slug}`, { image_retention: n }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug ? { ...a, image_retention: n } : a))
  }

  async function saveCategory(slug: string, cat: string) {
    const value = cat.trim()
    await adminApi.put(`/api/apps/${slug}`, { category: value }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug ? { ...a, category: value || undefined } : a))
  }

  async function saveName(slug: string, name: string) {
    const value = name.trim()
    if (!value) return
    await adminApi.put(`/api/apps/${slug}`, { name: value }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug ? { ...a, name: value } : a))
  }

  async function saveDescription(slug: string, desc: string) {
    await adminApi.put(`/api/apps/${slug}`, { description: desc }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === slug ? { ...a, description: desc } : a))
  }

  async function setFrameAncestors(app: App) {
    const help = "Allowed embedders (CSP frame-ancestors syntax).\n\n" +
      "Examples:\n" +
      "  'self'                              (default — only same origin)\n" +
      "  'self' https://portal.example.com   (also allow one external portal)\n" +
      "  'self' https://*.example.com        (any example.com subdomain)\n\n" +
      "Leave blank to reset to default.";
    const val = prompt(help, app.frame_ancestors ?? '')
    if (val === null) return
    try {
      const r = await adminApi.put<{ app?: App; error?: { message?: string } }>(`/api/apps/${app.slug}`, { frame_ancestors: val.trim() || null })
      if (r?.error) { alert('Failed: ' + (r.error.message || 'unknown')); return }
      const newVal = val.trim() || null
      setApps(prev => prev.map(a => a.slug === app.slug ? { ...a, frame_ancestors: newVal ?? undefined } : a))
    } catch (e) {
      alert('Failed: ' + (e as Error).message)
    }
  }

  async function setCustomDomain(app: App) {
    const help = "Custom domain for this app (served at the root of that domain).\n\n" +
      "e.g. raise.glick.run\n\n" +
      "The app is served there with NO AppCrane SSO and NO topbar - it does its\n" +
      "own auth. Maps to PRODUCTION. Point the domain's DNS at this host; Caddy\n" +
      "auto-provisions HTTPS. The crane.glick.run/" + app.slug + " path stays for ops.\n\n" +
      "If you CHANGE the domain, the old one is kept automatically as a 301\n" +
      "redirect so existing links/bookmarks keep working.\n\n" +
      "Leave blank to remove the custom domain."
    const val = prompt(help, app.domain ?? '')
    if (val === null) { await manageDomainAliases(app); return }
    const next = val.trim() || null
    let updated = app
    if (next !== (app.domain ?? null)) {
      try {
        const r = await adminApi.put<{ app?: App; error?: { message?: string } }>(`/api/apps/${app.slug}`, { domain: next })
        if (r?.error) { alert('Failed: ' + (r.error.message || 'unknown')); return }
        updated = { ...app, domain: next, domain_aliases: r?.app?.domain_aliases ?? app.domain_aliases }
        setApps(prev => prev.map(a => a.slug === app.slug ? updated : a))
      } catch (e) {
        alert('Failed: ' + (e as Error).message); return
      }
    }
    // Offer redirect-alias management (old domains → this app's primary).
    await manageDomainAliases(updated)
  }

  // Old domains that 301-redirect to the app's primary custom domain. Managed
  // via a lightweight prompt loop, matching the prompt-based domain UI above.
  async function manageDomainAliases(app: App) {
    if (!app.domain) return // aliases only redirect to a primary custom domain
    let aliases = app.domain_aliases ?? []
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listStr = aliases.length
        ? aliases.map(a => `  • ${a.domain}${a.source === 'auto' ? '  (auto)' : ''}`).join('\n')
        : '  (none yet)'
      const input = prompt(
        `Redirect aliases for ${app.domain}\nOld domains that 301-redirect here (path preserved):\n\n${listStr}\n\n` +
        `Type a domain to ADD as a redirect, or "-domain" to REMOVE it.\nLeave blank to finish.`,
        ''
      )
      if (input === null) break
      const v = input.trim()
      if (!v) break
      try {
        if (v.startsWith('-')) {
          const dom = v.slice(1).trim().toLowerCase()
          const row = aliases.find(a => a.domain.toLowerCase() === dom)
          if (!row) { alert(`No alias "${dom}" on this app.`); continue }
          await adminApi.del(`/api/apps/${app.slug}/domain-aliases/${row.id}`)
          aliases = aliases.filter(a => a.id !== row.id)
        } else {
          const r = await adminApi.post<{ alias?: { id: number; domain: string; source: string; created_at: string }; error?: { message?: string } }>(
            `/api/apps/${app.slug}/domain-aliases`, { domain: v })
          if (r?.error) { alert('Failed: ' + (r.error.message || 'unknown')); continue }
          if (r?.alias) { const added = r.alias; aliases = [...aliases.filter(a => a.id !== added.id), added] }
        }
      } catch (e) {
        alert('Failed: ' + (e as Error).message)
      }
    }
    setApps(prev => prev.map(a => a.slug === app.slug ? { ...a, domain_aliases: aliases } : a))
  }

  async function setAuthBypassPaths(app: App) {
    const current = (Array.isArray(app.auth_bypass_paths) ? app.auth_bypass_paths : []).join(', ')
    const help = "Path prefixes that bypass SSO on this app (comma- or newline-separated).\n\n" +
      "Each prefix must:\n" +
      "  • start with '/' (e.g. /ws/local-runner)\n" +
      "  • not overlap /api, /admin, /login, /portal, /health, /__crashed\n" +
      "  • not contain '..', '//', or whitespace\n\n" +
      "⚠ Requests under these prefixes reach your app with NO X-AppCrane-* identity\n" +
      "headers. Your app must authenticate them itself (e.g. token in query string).\n" +
      "Caddy suppresses access logging for these paths so query-string tokens don't\n" +
      "sit in log storage.\n\n" +
      "Leave blank to clear all bypass paths."
    const val = prompt(help, current)
    if (val === null) return
    const list = val.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    try {
      const r = await adminApi.put<{ app?: App; error?: { message?: string } }>(`/api/apps/${app.slug}`, { auth_bypass_paths: list })
      if (r?.error) { alert('Failed: ' + (r.error.message || 'unknown')); return }
      setApps(prev => prev.map(a => a.slug === app.slug ? { ...a, auth_bypass_paths: list.length ? list : null } : a))
    } catch (e) {
      alert('Failed: ' + (e as Error).message)
    }
  }

  // v2.42.0: change an app's ingress. Sends only what the admin actually
  // touched: an empty port box on a tcp app means "allocate one for me", which
  // the server answers by keeping any existing allocation or picking the lowest
  // free port — so re-saving never silently moves a port clients are pinned to.
  // v2.45.0: data_plane_port rides along for a dual app. Sent only on 'dual' —
  // the server refuses it on any other type, because a pure-tcp app publishes
  // the whole container and a second number there would be a second way to say
  // the same thing.
  async function saveIngress(app: App, type: IngressType, portRaw: string, dataPortRaw: string, sandboxPortRaw: string) {
    const body: { ingress_type: IngressType; public_port?: number; sandbox_public_port?: number | null; data_plane_port?: number | null } = { ingress_type: type }
    // Leaving 'dual' DROPS the data plane, and the server refuses the flip
    // unless the request says so. That refusal exists because 'tcp' publishes
    // container port 3000: without an explicit null, flipping a dual app to tcp
    // would silently repoint the same host port from the data plane onto the
    // HTTP control plane. Sending it here is what makes the transition
    // reachable from the dashboard at all — the confirm below names the change.
    if (type !== 'dual' && app.data_plane_port != null) body.data_plane_port = null
    if (publishesPort(type) && portRaw.trim()) {
      const n = parseInt(portRaw.trim(), 10)
      if (!Number.isFinite(n) || n < PUBLIC_PORT_MIN || n > PUBLIC_PORT_MAX) {
        alert(`Public port must be a number between ${PUBLIC_PORT_MIN} and ${PUBLIC_PORT_MAX}.`); return
      }
      body.public_port = n
    }
    if (type === 'dual') {
      const raw = dataPortRaw.trim()
      // Not defaulted. The publish has to target SOME container port, and the
      // only other one in the container is the HTTP control plane — guessing
      // would publish that raw, which is the one outcome this whole feature
      // exists to prevent.
      if (!raw) { alert('A dual app needs a data plane port — the container-side port the raw publish targets. AppCrane will not guess one.'); return }
      const n = parseInt(raw, 10)
      if (!Number.isFinite(n) || n < PUBLIC_PORT_MIN || n > PUBLIC_PORT_MAX) {
        alert(`Data plane port must be a number between ${PUBLIC_PORT_MIN} and ${PUBLIC_PORT_MAX}.`); return
      }
      if (n === CONTROL_PLANE_PORT) {
        alert(`Data plane port cannot be ${CONTROL_PLANE_PORT}. That is this container's HTTP control plane — the port Caddy proxies to. Publishing it raw would put the app's ordinary HTTP origin on the host with no TLS, no AppCrane sign-in, no identity headers and no request audit. Give the data plane its own listener on another port inside the container.`); return
      }
      body.data_plane_port = n
    }
    // v2.46.0: the sandbox container's own host port. Sent ONLY when the field
    // changed — omitted means "leave sandbox alone", and an empty box on an app
    // that has one means drop it. A second published port is a second door with
    // no forward_auth, so it must never appear as a side effect of editing
    // something else in this panel.
    const sandboxRaw = sandboxPortRaw.trim()
    const currentSandbox = app.sandbox_public_port ?? null
    if (publishesPort(type)) {
      if (!sandboxRaw && currentSandbox !== null) {
        body.sandbox_public_port = null
      } else if (sandboxRaw) {
        const n = parseInt(sandboxRaw, 10)
        if (!Number.isFinite(n) || n < PUBLIC_PORT_MIN || n > PUBLIC_PORT_MAX) {
          alert(`Sandbox port must be a number between ${PUBLIC_PORT_MIN} and ${PUBLIC_PORT_MAX}.`); return
        }
        if (n !== currentSandbox) body.sandbox_public_port = n
      }
    } else if (currentSandbox !== null) {
      body.sandbox_public_port = null
    }
    setIngressBusy(true)
    try {
      const r = await adminApi.put<{ app?: App; error?: { message?: string } }>(`/api/apps/${app.slug}`, body)
      if (r?.error) { alert('Failed: ' + (r.error.message || 'unknown')); return }
      const next = {
        ingress_type: r?.app?.ingress_type ?? type,
        public_port: r?.app?.public_port ?? null,
        data_plane_port: r?.app?.data_plane_port ?? null,
        sandbox_public_port: r?.app?.sandbox_public_port ?? null,
        pending_port_release: r?.app?.pending_port_release ?? null,
      }
      setApps(prev => prev.map(a => a.slug === app.slug ? { ...a, ...next } : a))
      setIngressApp(prev => prev && prev.slug === app.slug ? { ...prev, ...next } : prev)
      setIngressDraft({
        type: next.ingress_type,
        port: next.public_port ? String(next.public_port) : '',
        dataPort: next.data_plane_port ? String(next.data_plane_port) : '',
        sandboxPort: next.sandbox_public_port ? String(next.sandbox_public_port) : '',
      })
    } catch (e) {
      alert('Failed: ' + (e as Error).message)
    } finally {
      setIngressBusy(false)
    }
  }

  function openIngress(app: App) {
    setIngressDraft({
      type: publishesPort(app.ingress_type) ? app.ingress_type as IngressType : 'http',
      port: app.public_port ? String(app.public_port) : '',
      dataPort: app.data_plane_port ? String(app.data_plane_port) : '',
      sandboxPort: app.sandbox_public_port ? String(app.sandbox_public_port) : '',
    })
    setIngressApp(app)
  }

  // v2.6.0: showAppToken removed — it minted a `user_<random>` deployment
  // key for an X-Deployment-Key REST flow that duplicates MCP. Agents
  // authenticate to AppCrane via MCP only; per-app access is governed
  // by app_user_roles, not by paste-keys.
  // (The corresponding POST /api/apps/:slug/deployment-key endpoint was
  // removed server-side in this same commit. Existing keys keep working
  // until v3.0.)

  async function generateAgentKey() {
    const ts = Date.now()
    let failReason = ''
    // v2.7.4: ALWAYS issue a personal MCP key for the logged-in user — admins
    // included. Previously admins got a throwaway role:admin onboarding-agent
    // identity, and since every create path makes the CALLING identity the
    // app owner, that agent (not the human who clicked) ended up owning the
    // app. The human's own personal key — scope-restricted to apps they own —
    // then couldn't see it. A personal dhk_mcp_* key is equally restricted to
    // /api/mcp (auth.js KEY_SCOPE_RESTRICTED) but ties creation/ownership to
    // the human, so they own what they onboard. No admin-only endpoint, works
    // for admins and create_app-granted users alike.
    const k = await adminApi.post<{ api_key?: string }>('/api/me/mcp-keys', {
      label: `onboarding-${ts}`,
    }).catch((e: unknown) => { failReason = e instanceof Error ? e.message : String(e); return null })
    const key = k?.api_key ?? ''
    if (!key) {
      alert('Failed to issue an MCP key for onboarding' + (failReason ? `: ${failReason}` : '. Check the server logs.'))
      return
    }
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-appcrane-host'
    const host = typeof window !== 'undefined' ? window.location.host : 'your-appcrane-host'
    const brief = `You are AppCrane's app-onboarding agent. Your job: take this conversation
from "user wants something deployed" to "a working sandbox URL on
${host}", end-to-end, in one session.

YOU HAVE TWO TOOL FAMILIES on the same MCP connection:
  - appcrane_*  — AppCrane lifecycle ops (create_app, deploy, get_logs, env, …)
  - github_*    — GitHub passthrough (read/write files, open PRs, list
                  branches, create repos). The user's PAT was wired into
                  your MCP config via the X-Github-Token header, so github_*
                  calls authenticate automatically — you do NOT pass a token
                  argument to them.

Use github_* for ALL code-level GitHub work. Do NOT shell out to \`gh\` or
\`git\` CLI. Do NOT clone to local disk. Everything happens through MCP tools.

INPUTS YOU NEED FROM THE USER (ask in your first turn, all at once):
  1. Starting point — one of:
       (a) An idea, no code yet              → scaffold from scratch
       (b) Local code, no GitHub repo        → create repo, push existing code
       (c) Existing GitHub repo URL          → skip scaffolding, just register
       (d) "I don't have / want a GitHub"    → AppCrane manages the code:
           call appcrane_create_managed_app — AppCrane provisions a private
           repo on its service account, stores the credential, and you push
           scaffolding through github_* tools as usual. The user never sees
           github.com. Requires platform_admin to have configured the
           service-account in Settings → GitHub. If \`appcrane_create_managed_app\`
           returns "service-account is disabled / no token", fall back to
           paths (a)-(c) and ask the user for a PAT.
  2. The PAT they configured in their \`claude mcp add\` command. You need it
     once to pass as \`github_token\` to appcrane_create_app (AppCrane stores
     it encrypted on the app record so it can clone for future deploys).
     Path (d) does not require a PAT — managed apps use the service-account
     credential server-side. Don't echo it back.
  3. Any env vars / secrets (usually none).
  4. Display name (you'll propose; user confirms).

KEY APPCRANE TOOLS:
  appcrane_create_app(name, slug, github_url, github_token, branch?, …)
  appcrane_create_managed_app(name, slug, branch?, description?)  — path (d)
  appcrane_set_env(slug, env, key, value)
  appcrane_deploy(slug, env)                       — env="sandbox"
  appcrane_get_logs(slug, env, lines?, search?)

KEY GITHUB TOOLS (call tools/list to see exact names on your connection —
they may be prefixed \`github_\` or \`mcp__github__\` depending on server
version):
  create_repository                                — paths (a), (b)
  create_or_update_file / push_files               — scaffold or edit
  get_file_contents                                — read existing repo
  create_pull_request                              — for path (c) fixes
  list_branches, list_commits, …

ORDER, BY PATH:

  Path (a) — fresh idea:
    1. Pick slug (lowercase-hyphen, ≤20 chars). Pick stack (default: Vite +
       React + TS SPA; Express + Vite SPA single Node process if backend is
       needed). Propose; wait for ✅.
    2. github_create_repository (private: true).
    3. Push scaffolded files via github_push_files: package.json,
       deployhub.json (version 0.1.0, build, start, be.health "/api/health",
       port hint), source files, AND an /api/health route that returns
       JSON: {status: "ok", version: "<value from package.json>"}.
       AppCrane's deploy validator REJECTS apps whose health endpoint
       does not return both \`status\` and \`version\` fields — this is
       enforced server-side; skipping it means the deploy fails.
    4. appcrane_create_app({ name, slug, github_url, github_token, branch: "main" })
    5. appcrane_set_env (only if user has secrets)
    6. appcrane_deploy(slug, "sandbox")
    7. appcrane_get_logs — confirm health green. If red, read logs, fix via
       github_create_or_update_file, redeploy.

  Path (b) — local code, no repo:
    As (a), but step 3 = read user's local code, audit for missing pieces
    (deployhub.json, /api/health endpoint returning {status, version},
    start script), add via github_push_files. Don't modify files the
    user wrote without asking.

  Path (c) — repo already on GitHub:
    1. github_get_file_contents to verify deployhub.json exists AND the
       app exposes /api/health returning {status, version}. If missing,
       github_create_pull_request adding them; ask user to merge.
       Without a valid health endpoint the deploy will be rejected.
    2. appcrane_create_app
    3-5 as above (set_env, deploy, get_logs).

  Path (d) — AppCrane-managed code (no user PAT needed):
    1. Pick slug + stack as in (a). Propose; wait for ✅.
    2. appcrane_create_managed_app({ name, slug, branch: "main", description })
       — AppCrane creates the private repo on its service account; the
       returned repo.html_url is the github_url and the repo is auto-init'd
       with a README on the default branch.
    3. Push scaffolding via github_push_files to the returned full_name —
       the SAME files as path (a) step 3 (package.json, deployhub.json,
       sources, /api/health route returning {status, version}).
    4. appcrane_set_env (only if user has secrets)
    5. appcrane_deploy(slug, "sandbox")
    6. appcrane_get_logs — confirm health green; iterate via
       github_create_or_update_file + redeploy if red.

    The end user never sees github.com. They get a sandbox URL.

APP TILE ICON (optional, recommended):
  Commit \`public/icon.png\` (256×256 PNG preferred; SVG / WEBP / JPEG / GIF also accepted)
  in the repo. AppCrane picks it up on every deploy and uses it as the tile icon
  on the Dashboard, the Launcher cards, the Manage table, and the frame topbar.
  When the user has no design ready, propose a minimal monochrome SVG with their
  app name's initials or a single thematic glyph — committing one is part of a
  clean onboarding, not an afterthought.

  For mid-flight icon swaps without a redeploy: call appcrane_set_app_icon
  with the slug, format ("png"/"svg"/etc.), and base64-encoded image bytes.

CONSTRAINTS — common pitfalls that fail deploys:
  - Sandbox only. Never deploy to production.
  - Vite: \`base: process.env.APP_BASE_PATH || './'\`. Never '/'. AppCrane does
    NOT inject APP_BASE_PATH at build time.
  - If you write a custom Dockerfile:
      • EXPOSE must match the port in deployhub.json (default 3000).
      • Do NOT declare VOLUME /data — AppCrane mounts it at runtime.
      • Do NOT set ENV DATA_DIR — AppCrane injects it.
      • Must end with USER <non-root>.
  - App must read PORT from process.env (\`process.env.PORT || 3000\`).
  - On failure, surface the error and ask before retrying. No silent loops.
  - End with the sandbox URL + one line of "what's deployed".`
    // v2.5.23: the full onboarding playbook now lives server-side at
    // server/services/guides/onboarding.md and is fetched by agents via
    // the appcrane_get_guide('onboarding') MCP tool. This modal no longer
    // pastes a 4 KB brief into the user's chat — they just run the
    // setup command, open Claude Code, and ask. The agent pulls the
    // latest playbook itself. Single source of truth on the server.
    void brief // kept above for reference; the modal now hands off to MCP

    // Managed Code — AppCrane hosts the repo; no GitHub account or PAT needed.
    const managedPrompt = `MANAGED CODE - AppCrane hosts the repo for you (no GitHub account or token).
Requires a platform admin to have configured the service-account in Settings > GitHub.

STEP 1 - Wire AppCrane MCP into your local Claude Code (run once in any terminal):

  claude mcp add --transport http appcrane ${origin}/api/mcp \\
    --header "X-API-Key: ${key}"

STEP 2 - In any terminal run \`claude\`, then paste:

  Onboard a new managed AppCrane app for me. I don't have a GitHub account,
  so use path (d). Call appcrane_get_guide topic="onboarding" first to pull
  the latest playbook, then walk me through it. Pick a small Vite + React +
  TS stack, ask me a name + what it does, and ship it to sandbox.

The agent calls appcrane_create_managed_app - AppCrane's service account creates a
private repo (AMC_<your_slug>), holds the credential, and pushes scaffolding for you.
You end with a sandbox URL and never touch github.com.`

    // Unmanaged (GitHub) — bring your own repo + PAT.
    const githubPrompt = `UNMANAGED (GITHUB) - you bring your own GitHub repo + Personal Access Token.

STEP 1 - Generate a GitHub PAT at https://github.com/settings/tokens.
  Classic: scope \`repo\`. Fine-grained (recommended): Contents R/W, Metadata R,
  Administration W. The PAT stays only in your local ~/.claude.json - never
  stored on the AppCrane server, only passed as a header at request time.

STEP 2 - Wire AppCrane MCP into your local Claude Code. Replace <YOUR_GITHUB_PAT>,
then run once in any terminal:

  claude mcp add --transport http appcrane ${origin}/api/mcp \\
    --header "X-API-Key: ${key}" \\
    --header "X-Github-Token: <YOUR_GITHUB_PAT>"

The X-Github-Token header enables AppCrane's GitHub passthrough - the agent gets
github_* tools (read/push files, open PRs, create repos) on the same connection.

STEP 3 - In any terminal run \`claude\`, then paste:

  Onboard a new app on AppCrane. Start by calling appcrane_get_guide with
  topic="onboarding" to fetch the latest playbook. Then ask me the inputs the
  guide lists, and walk through paths (a)/(b)/(c) accordingly.`

    setPromptModal({
      open: true,
      title: 'Add Application',
      key,
      sections: [
        { label: 'Managed Code', text: managedPrompt },
        { label: 'Unmanaged (GitHub)', text: githubPrompt },
      ],
    })
  }

  function toggleEvars(slug: string, env: string) {
    const ekey = `${slug}:${env}`
    if (openEvars[slug] === env) {
      setOpenEvars(prev => ({ ...prev, [slug]: null }))
      return
    }
    setOpenEvars(prev => ({ ...prev, [slug]: env }))
    adminApi
      .get<Record<string, string> | EnvVar[]>(`/api/apps/${slug}/env/${env}?reveal=true`)
      .then(r => {
        let vars: EnvVar[]
        if (Array.isArray(r)) {
          vars = r
        } else {
          vars = Object.entries(r as Record<string, string>).map(([key, value]) => ({ key, value }))
        }
        setEvarData(prev => ({ ...prev, [ekey]: vars }))
      })
      .catch(() => {})
  }

  function updateEnvVar(slug: string, env: string, idx: number, field: 'key' | 'value', val: string) {
    const ekey = `${slug}:${env}`
    setEvarData(prev => {
      const arr = [...(prev[ekey] ?? [])]
      arr[idx] = { ...arr[idx], [field]: val }
      return { ...prev, [ekey]: arr }
    })
  }

  async function saveEnvVar(slug: string, env: string, idx: number) {
    const ekey = `${slug}:${env}`
    const row = evarData[ekey]?.[idx]
    if (!row) return
    await adminApi.put(`/api/apps/${slug}/env/${env}`, { [row.key]: row.value }).catch(() => {})
  }

  async function deleteEnvVar(slug: string, env: string, idx: number) {
    const ekey = `${slug}:${env}`
    const row = evarData[ekey]?.[idx]
    if (!row) return
    await adminApi.del(`/api/apps/${slug}/env/${env}/${row.key}`).catch(() => {})
    setEvarData(prev => {
      const arr = [...(prev[ekey] ?? [])]
      arr.splice(idx, 1)
      return { ...prev, [ekey]: arr }
    })
  }

  async function addEnvVar(slug: string, env: string) {
    const ekey = `${slug}:${env}`
    setEvarData(prev => ({
      ...prev,
      [ekey]: [...(prev[ekey] ?? []), { key: '', value: '' }],
    }))
  }

  function openAppFrame(app: App, env: 'production' | 'sandbox') {
    const prodUrl = `/${app.slug}`
    const sandUrl = `/${app.slug}-sandbox`
    setFrame({
      open:        true,
      url:         env === 'production' ? prodUrl : sandUrl,
      title:       `${app.name} (${env === 'production' ? 'prod' : 'sandbox'})`,
      slug:        app.slug,
      appName:     app.name,
      env,
      prodUrl,
      sandUrl,
      prodVersion: app.production?.deploy?.version || '',
      sandVersion: app.sandbox?.deploy?.version    || '',
      hasIcon:     iconUrls[app.slug] != null,
      hasGithub:   !!app.github_url,
    })
  }

  async function uploadIcon(slug: string, file: File) {
    const fd = new FormData()
    fd.append('icon', file)
    await fetch(`/api/apps/${slug}/icon`, {
      method: 'POST',
      headers: adminApi.authHeaders(),
      body: fd,
    })
    setIconUrls(prev => ({ ...prev, [slug]: URL.createObjectURL(file) }))
  }

  /**
   * Health-state badge class + tooltip. Distinguishes three cases that
   * pre-v2.2.11 all looked the same (gray dot, "—" version):
   *
   *   never deployed       → gray dot, "Not deployed yet"
   *   deployed, no health  → yellow dot, "Health endpoint not responding —
   *                           the app is running but /api/health didn't
   *                           return JSON with {status, version}. Check
   *                           deploy logs."
   *   deployed, healthy    → green dot
   *   deployed, down       → red dot
   */
  function healthState(app: App, env: 'production' | 'sandbox') {
    const h = app[env]?.health?.status
    const ver = versions[app.slug]?.[env === 'production' ? 'prod' : 'sand']
    if (h === 'healthy') return { className: 'dot dot-green', title: 'Healthy' }
    if (h === 'down')    return { className: 'dot dot-red',   title: 'Down — last health check failed' }
    if (!ver) return { className: 'dot dot-gray', title: 'Not deployed yet' }
    return {
      className: 'dot dot-yellow',
      title: 'Health endpoint not responding — app is running but /api/health did not return JSON with {status, version}. Check deploy logs.',
    }
  }

  function visBadgeClass(vis?: string) {
    if (vis === 'public') return 'vis-badge vis-public'
    if (vis === 'private') return 'vis-badge vis-private'
    return 'vis-badge vis-hidden'
  }

  // Distinct, sorted list of every category currently in use — feeds the
  // Tag dropdowns in the table (filter row + per-row editor).
  const allTags = Array.from(
    new Set(apps.map(a => (a.category || '').trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  const visOf = (a: App) => a.visibility || 'hidden'
  const ramOf = (a: App) => a.resource_limits?.max_ram_mb ?? -1
  const cpuOf = (a: App) => a.resource_limits?.max_cpu_percent ?? -1
  const imgOf = (a: App) => a.image_retention ?? -1

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }
  function sortArrow(key: SortKey) {
    if (sort.key !== key) return ''
    return sort.dir === 'asc' ? ' ↑' : ' ↓'
  }
  // Keyboard-accessible sortable header: real button semantics + aria-sort so
  // screen readers announce the sort state and Enter/Space toggle it.
  function sortTh(key: SortKey, label: string, hideable = false) {
    const dir: 'ascending' | 'descending' | 'none' =
      sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
    return (
      <th
        className={`th-sort${hideable ? ' apps-col-hideable' : ''}`}
        role="button" tabIndex={0} aria-sort={dir}
        onClick={() => toggleSort(key)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(key) } }}
      >{label}{sortArrow(key)}</th>
    )
  }
  const filtersActive = !!(filter.vis || filter.tag || filter.name || filter.ramMin || filter.cpuMin)
  function clearFilters() { setFilter({ vis: '', name: '', tag: '', ramMin: '', cpuMin: '' }) }

  const filtered = apps.filter(a => {
    // v2.21.5: Manage is scoped to apps you actually own/admin. Global admins
    // (admin / platform_admin) still see every app; owners/app-admins see only
    // theirs, not the whole catalogue.
    if (!adminLike && a.app_role !== 'owner' && a.app_role !== 'admin') return false
    if (filter.vis  && visOf(a) !== filter.vis) return false
    if (filter.tag  && (a.category || '') !== filter.tag) return false
    if (filter.name && !(a.name || '').toLowerCase().includes(filter.name.toLowerCase())) return false
    if (filter.ramMin && ramOf(a) < Number(filter.ramMin)) return false
    if (filter.cpuMin && cpuOf(a) < Number(filter.cpuMin)) return false
    return true
  })
  const sorted = [...filtered].sort((x, y) => {
    let cmp = 0
    switch (sort.key) {
      case 'name':       cmp = (x.name || '').toLowerCase().localeCompare((y.name || '').toLowerCase()); break
      case 'visibility': cmp = visOf(x).localeCompare(visOf(y)); break
      case 'category':   cmp = (x.category || '').localeCompare(y.category || ''); break
      case 'ram':        cmp = ramOf(x) - ramOf(y); break
      case 'cpu':        cmp = cpuOf(x) - cpuOf(y); break
      case 'images':     cmp = imgOf(x) - imgOf(y); break
      case 'storage':    cmp = (appStorage?.[x.slug] ?? -1) - (appStorage?.[y.slug] ?? -1); break
    }
    return sort.dir === 'asc' ? cmp : -cmp
  })

  // Bulk multi-select over the currently-visible (filtered+sorted) rows.
  const visibleSlugs = sorted.map(a => a.slug)
  const allVisibleSelected = visibleSlugs.length > 0 && visibleSlugs.every(s => selected.has(s))
  const someSelected = selected.size > 0
  function toggleSelect(slug: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n })
  }
  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visibleSlugs))
  }
  async function bulkSetVisibility(vis: string) {
    for (const s of Array.from(selected)) await setVisibility(s, vis)
  }
  async function bulkSetTag(cat: string) {
    for (const s of Array.from(selected)) await saveCategory(s, cat)
  }
  async function bulkDelete() {
    const slugs = Array.from(selected)
    if (!confirm(`Delete ${slugs.length} app${slugs.length === 1 ? '' : 's'}? This is irreversible.`)) return
    for (const s of slugs) await adminApi.del(`/api/apps/${s}?confirm=true`).catch(() => {})
    setSelected(new Set())
    loadAll()
  }

  // v2.7.2: the "+ Add Application" key/instructions modal, shared by both
  // views. It used to live only in the Manage-view return, so a non-admin in
  // the Launcher clicked the button, generateAgentKey issued a key and called
  // setPromptModal({ open: true }) — but nothing rendered it. "Nothing
  // happens." Define it once and render in both returns.
  const promptModalEl = promptModal.open && (
    <div className="prompt-overlay" onClick={() => setPromptModal({ open: false })}>
      <div className="prompt-modal" onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 16 }}>{promptModal.title ?? 'API Key'}</div>
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 14px', fontFamily: 'monospace', fontSize: '.85rem', wordBreak: 'break-all', marginBottom: 12, cursor: 'text', userSelect: 'all' }}>
          {promptModal.key}
        </div>
        <button
          className="btn btn-xs"
          style={{ marginBottom: 16 }}
          onClick={() => copyText(promptModal.key ?? '', 'key')}
        >
          {copiedLabel === 'key' ? 'Copied ✓' : 'Copy key'}
        </button>
        {promptModal.sections && promptModal.sections.map(section => (
          <div key={section.label} style={{ marginBottom: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: '.9rem' }}>{section.label}</div>
              <button
                className="btn btn-xs btn-accent"
                onClick={() => copyText(section.text, section.label)}
              >
                {copiedLabel === section.label ? 'Copied ✓' : `Copy ${section.label}`}
              </button>
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 14px', fontSize: '.8rem', color: 'var(--dim)', maxHeight: 240, overflowY: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
              {section.text}
            </div>
          </div>
        ))}
        {promptModal.prompt && (
          <>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 14px', fontSize: '.82rem', color: 'var(--dim)', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', marginBottom: 12 }}>
              {promptModal.prompt}
            </div>
            <button
              className="btn btn-xs"
              style={{ marginBottom: 16 }}
              onClick={() => copyText(promptModal.prompt ?? '', 'instructions')}
            >
              {copiedLabel === 'instructions' ? 'Copied ✓' : 'Copy instructions'}
            </button>
          </>
        )}
        <div style={{ fontSize: '.78rem', color: 'var(--red)', marginBottom: 16 }}>
          The API key will not be shown again.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setPromptModal({ open: false })}>Close</button>
        </div>
      </div>
    </div>
  )

  // v2.13.0: launcher dissolved into the main sidebar nav. Non-admins have no
  // manage table — their apps live in the nav and open at /launch — so send
  // them there. Admins fall through to the manage table below.
  if (me !== null && !adminLike && !mayCreateApp) {
    return <Navigate to="/launch" replace />
  }

  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Manage</h2>
        {mayCreateApp && (
          <button className="btn btn-accent" onClick={generateAgentKey}>+ Add Application</button>
        )}
        <input
          type="text"
          autoFocus
          autoComplete="off"
          placeholder="Search applications by name…"
          value={filter.name}
          onChange={e => setFilter(f => ({ ...f, name: e.target.value }))}
          style={{
            marginLeft: 'auto',
            minWidth: 280,
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: 7,
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: '.9rem',
            outline: 'none',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: '.8rem', color: 'var(--dim)' }}>
        <span aria-live="polite">
          {loaded ? (filtersActive ? `Showing ${sorted.length} of ${apps.length} apps` : `${apps.length} app${apps.length === 1 ? '' : 's'}`) : 'Loading…'}
        </span>
        {filtersActive && (
          <button className="btn btn-xs" onClick={clearFilters} title="Clear all active filters">Clear filters ✕</button>
        )}
      </div>

      {someSelected && (
        <div className="apps-bulk-bar" role="region" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <select aria-label="Set visibility for selected apps" value=""
            onChange={e => { if (e.target.value) { bulkSetVisibility(e.target.value); e.currentTarget.value = '' } }}>
            <option value="">Set visibility…</option>
            <option value="hidden">hidden</option>
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <select aria-label="Set tag for selected apps" value=""
            onChange={e => { if (e.target.value) { bulkSetTag(e.target.value === '__none__' ? '' : e.target.value); e.currentTarget.value = '' } }}>
            <option value="">Set tag…</option>
            <option value="__none__">— (clear tag)</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn btn-xs btn-red" onClick={bulkDelete}>Delete selected</button>
          <button className="btn btn-xs" onClick={() => setSelected(new Set())} style={{ marginLeft: 'auto' }}>Clear selection</button>
        </div>
      )}

      <div className="apps-table-wrap">
        <table className="apps-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all visible apps"
                  checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = someSelected && !allVisibleSelected }}
                  onChange={toggleSelectAll}
                />
              </th>
              <th></th>
              {sortTh('name', 'Name')}
              <th className="apps-col-hideable">Description</th>
              {sortTh('visibility', 'Visibility', true)}
              {sortTh('category', 'Tag', true)}
              {sortTh('ram', 'RAM (MB)', true)}
              {sortTh('cpu', 'CPU (%)', true)}
              {sortTh('images', 'Images', true)}
              {sortTh('storage', 'Storage')}
              <th>Sandbox</th>
              <th>Production</th>
            </tr>
            <tr className="apps-filter-row">
              <th></th>
              <th></th>
              <th>
                <input
                  className="apps-filter-input"
                  type="text" placeholder="filter name…" aria-label="Filter by app name"
                  value={filter.name} onChange={e => setFilter(f => ({ ...f, name: e.target.value }))}
                />
              </th>
              <th className="apps-col-hideable"></th>
              <th className="apps-col-hideable">
                <select
                  className="apps-filter-input" aria-label="Filter by visibility"
                  value={filter.vis} onChange={e => setFilter(f => ({ ...f, vis: e.target.value }))}
                >
                  <option value="">all</option>
                  <option value="hidden">hidden</option>
                  <option value="private">private</option>
                  <option value="public">public</option>
                </select>
              </th>
              <th className="apps-col-hideable">
                <select
                  className="apps-filter-input" aria-label="Filter by tag"
                  value={filter.tag} onChange={e => setFilter(f => ({ ...f, tag: e.target.value }))}
                >
                  <option value="">all</option>
                  {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </th>
              <th className="apps-col-hideable">
                <input
                  className="apps-filter-input" aria-label="Filter by minimum RAM (MB)"
                  type="number" min={0} placeholder="≥"
                  value={filter.ramMin} onChange={e => setFilter(f => ({ ...f, ramMin: e.target.value }))}
                />
              </th>
              <th className="apps-col-hideable">
                <input
                  className="apps-filter-input" aria-label="Filter by minimum CPU (%)"
                  type="number" min={0} placeholder="≥"
                  value={filter.cpuMin} onChange={e => setFilter(f => ({ ...f, cpuMin: e.target.value }))}
                />
              </th>
              <th className="apps-col-hideable"></th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: 6 }).map((_, i) => (
              <tr key={`skel-${i}`} aria-hidden="true">
                <td colSpan={12}>
                  <span className="apps-skel" style={{ width: `${70 - i * 6}%` }} />
                </td>
              </tr>
            ))}
            {sorted.map(app => {
              const activeEnv = openEvars[app.slug]
              const ramVal = app.resource_limits?.max_ram_mb ?? ''
              const cpuVal = app.resource_limits?.max_cpu_percent ?? ''
              const imgVal = app.image_retention ?? ''
              const tagDraftVal = tagDraft[app.slug]
              const isExpanded = !!expanded[app.slug]
              return (
                <>
                  <tr key={app.slug} className={selected.has(app.slug) ? 'apps-row-selected' : undefined}>
                    <td style={{ width: 44 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${app.name}`}
                          checked={selected.has(app.slug)}
                          onChange={() => toggleSelect(app.slug)}
                        />
                        <button
                          type="button"
                          className="apps-row-toggle btn-icon"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? `Hide details for ${app.name}` : `Show details & actions for ${app.name}`}
                          onClick={() => setExpanded(p => ({ ...p, [app.slug]: !p[app.slug] }))}
                          title={isExpanded ? 'Hide details & actions' : 'Show environments, storage & actions'}
                        ><IconChevron open={isExpanded} /></button>
                      </div>
                    </td>
                    <td>
                      <div
                        className="app-icon-wrap"
                        onClick={() => iconInputRefs.current[app.slug]?.click()}
                        title="Click to upload icon"
                        style={{ width: 28, height: 28 }}
                      >
                        {iconUrls[app.slug]
                          ? <img src={iconUrls[app.slug]} className="app-icon-img" alt="" />
                          : <span className="app-icon-ph">{app.name.charAt(0).toUpperCase()}</span>
                        }
                        <input
                          type="file" accept="image/*"
                          style={{ display: 'none' }}
                          ref={el => { iconInputRefs.current[app.slug] = el }}
                          onChange={e => {
                            const f = e.target.files?.[0]
                            if (f) uploadIcon(app.slug, f)
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <EditableCell
                          value={app.name}
                          ariaLabel={`App name for ${app.name}`}
                          onSave={v => saveName(app.slug, v)}
                          inputStyle={{ minWidth: 130, flex: 1 }}
                        />
                        {mcpActive[app.slug] && (
                          <span
                            title={`MCP active — ${mcpActive[app.slug].calls} call(s) in last 5min, latest ${new Date(mcpActive[app.slug].last_at).toLocaleTimeString()}`}
                            style={{
                              fontSize: '.65rem', fontWeight: 600, letterSpacing: '.3px',
                              padding: '2px 6px', borderRadius: 3,
                              color: 'var(--accent)', background: 'rgba(59,130,246,.12)',
                              border: '1px solid rgba(59,130,246,.3)',
                              whiteSpace: 'nowrap',
                            }}
                          >MCP ●</span>
                        )}
                        {/* Both publishing types get the same red badge: what it
                            reports is "there is a host port here that AppCrane
                            does not guard", and that is equally true of a dual
                            app. The label names which type so the reader knows
                            whether the app ALSO has a Caddy-fronted plane. */}
                        {publishesPort(app.ingress_type) && (
                          <button
                            className="badge"
                            onClick={() => openIngress(app)}
                            title={app.ingress_type === 'dual'
                              ? `Dual ingress. Data plane: host port ${app.public_port ?? '(not allocated)'} → container port ${app.data_plane_port ?? '(not set)'}, published raw — no AppCrane sign-in, no identity headers, no request audit, no TLS from AppCrane; the app authenticates every connection on it itself. Control plane: ordinary HTTP on container port ${CONTROL_PLANE_PORT}, still served through Caddy with SSO, TLS, identity headers and logging intact.`
                              : `Raw TCP ingress on host port ${app.public_port ?? '(not allocated)'} — this port does NOT go through AppCrane. No sign-in, no identity headers, no request audit, no TLS from AppCrane. The app authenticates every connection itself.`}
                            style={{
                              fontSize: '.65rem', fontWeight: 700, letterSpacing: '.3px',
                              padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                              color: 'var(--red, #ef4444)', background: 'rgba(239,68,68,.12)',
                              border: '1px solid rgba(239,68,68,.35)',
                              whiteSpace: 'nowrap', fontFamily: 'monospace',
                            }}
                          >{app.ingress_type === 'dual'
                            ? `DUAL :${app.public_port ?? '—'}→${app.data_plane_port ?? '—'} ⚠`
                            : `TCP :${app.public_port ?? '—'} ⚠`}</button>
                        )}
                        {/* Switched back to http, container not recreated yet: the
                            port is still open, so the row must still say so. An app
                            that looked identical to any other http app here is how
                            "the exposure is closed" gets reported while it isn't. */}
                        {!publishesPort(app.ingress_type) && !!app.pending_port_release && (
                          <button
                            className="badge"
                            onClick={() => openIngress(app)}
                            title={`Port ${app.pending_port_release} is still open. Ingress was switched back to http, but the publish is a docker run flag — the container that is running still binds 0.0.0.0:${app.pending_port_release} with no AppCrane authentication in front of it. Redeploy or restart this app to close it. AppCrane keeps the port reserved to this app until then, so no other app can be given it.`}
                            style={{
                              fontSize: '.65rem', fontWeight: 700, letterSpacing: '.3px',
                              padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
                              color: 'var(--amber, #f59e0b)', background: 'rgba(245,158,11,.12)',
                              border: '1px solid rgba(245,158,11,.35)',
                              whiteSpace: 'nowrap', fontFamily: 'monospace',
                            }}
                          >:{app.pending_port_release} still open ⚠</button>
                        )}
                      </div>
                    </td>
                    <td className="apps-col-hideable">
                      <EditableCell
                        value={app.description ?? ''}
                        ariaLabel={`Description for ${app.name}`}
                        placeholder="—"
                        onSave={v => saveDescription(app.slug, v)}
                        inputStyle={{ minWidth: 180 }}
                      />
                    </td>
                    <td className="apps-col-hideable">
                      <select
                        value={app.visibility ?? 'hidden'}
                        onChange={e => setVisibility(app.slug, e.target.value)}
                        className={visBadgeClass(app.visibility)}
                        aria-label={`Visibility for ${app.name}`}
                        style={{ fontSize: '.75rem' }}
                      >
                        <option value="hidden">hidden</option>
                        <option value="private">private</option>
                        <option value="public">public</option>
                      </select>
                    </td>
                    <td className="apps-col-hideable">
                      {tagDraftVal !== undefined ? (
                        <input
                          className="editable" autoFocus defaultValue={tagDraftVal}
                          placeholder="new tag…" aria-label={`New tag for ${app.name}`}
                          onBlur={e => {
                            saveCategory(app.slug, e.target.value)
                            setTagDraft(d => { const n = { ...d }; delete n[app.slug]; return n })
                          }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          style={{ minWidth: 100 }}
                        />
                      ) : (
                        <select
                          value={app.category ?? ''}
                          aria-label={`Tag for ${app.name}`}
                          onChange={e => {
                            const v = e.target.value
                            if (v === '__new__') setTagDraft(d => ({ ...d, [app.slug]: '' }))
                            else saveCategory(app.slug, v)
                          }}
                          style={{ fontSize: '.78rem' }}
                        >
                          <option value="">—</option>
                          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
                          <option value="__new__">+ New tag…</option>
                        </select>
                      )}
                    </td>
                    <td className="apps-col-hideable">
                      <EditableCell
                        value={ramVal} type="number" min={0}
                        ariaLabel={`RAM cap in MB for ${app.name}`}
                        disabled={!isPlatformAdmin}
                        title={isPlatformAdmin ? undefined : 'Only platform admins can change CPU/memory limits'}
                        onSave={v => saveRam(app.slug, v)}
                        inputStyle={{ width: 70 }}
                      />
                    </td>
                    <td className="apps-col-hideable">
                      <EditableCell
                        value={cpuVal} type="number" min={0}
                        ariaLabel={`CPU cap in percent for ${app.name}`}
                        disabled={!isPlatformAdmin}
                        title={isPlatformAdmin ? undefined : 'Only platform admins can change CPU/memory limits'}
                        onSave={v => saveCpu(app.slug, v)}
                        inputStyle={{ width: 60 }}
                      />
                    </td>
                    <td className="apps-col-hideable">
                      <EditableCell
                        value={imgVal} type="number" min={0} max={50}
                        ariaLabel={`Image retention count for ${app.name}`}
                        onSave={v => saveImages(app.slug, v)}
                        inputStyle={{ width: 60 }}
                      />
                    </td>
                    <td>
                      <span
                        style={{ fontSize: '.78rem', color: 'var(--dim)', whiteSpace: 'nowrap' }}
                        title="Total on-disk footprint: release checkouts + persistent /data, across sandbox + production"
                      >
                        {appStorage == null ? '…' : appStorage[app.slug] != null ? fmtBytes(appStorage[app.slug]) : '—'}
                      </span>
                    </td>
                    {(['sandbox', 'production'] as const).map(env => {
                      // v2.5.5: live-fetch reads the running app's /api/health
                      // body.version. Most user apps don't expose that field,
                      // so the cell was permanently '—'. Fall back to the
                      // last live deployment's version (captured at deploy
                      // time from the manifest) when the live read is missing.
                      const liveVer = versions[app.slug]?.[env === 'production' ? 'prod' : 'sand']
                      const deployVer = app[env]?.deploy?.version
                      const ver = (liveVer && liveVer !== '—') ? liveVer : (deployVer || null)
                      const isDown = app[env]?.health?.status === 'down'
                      return (
                        <td key={env}>
                          <span className="apps-status-env" title={env === 'production' ? 'Production' : 'Sandbox'}>
                            {(() => { const s = healthState(app, env); return <span className={s.className} title={s.title} /> })()}
                            <span className="apps-status-ver">{ver ?? '—'}</span>
                            {isDown ? (
                              <span className="env-link env-link-disabled" title={`${env} is down — open disabled`} aria-disabled="true">↗</span>
                            ) : (
                              <a
                                className="env-link"
                                href="#"
                                onClick={e => { e.preventDefault(); openAppFrame(app, env) }}
                                title={`Open ${env}`}
                              >↗</a>
                            )}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                  {isExpanded && (
                  <tr key={`${app.slug}-actions`} className="apps-row-actions">
                    <td colSpan={12} style={{ borderTop: 'none', paddingTop: 0, paddingBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', paddingLeft: 8, alignItems: 'center' }}>
                        {(app.owners?.length ? app.owners : app.owner ? [app.owner] : []).length > 0 ? (
                          <span
                            className="badge"
                            title={(app.owners?.length ? app.owners : [app.owner!])
                              .map(o => `${o.name}${o.email ? ` (${o.email})` : ''}`).join('\n')}
                            style={{ background: 'var(--surface2)', color: 'var(--dim)', fontSize: '.7rem', fontWeight: 500 }}
                          >
                            👤 {(app.owners?.length ? app.owners : [app.owner!]).map(o => o.name).join(', ')}
                          </span>
                        ) : (
                          <span
                            className="badge"
                            title="No owner assigned. Set one from /users by promoting an assigned user to owner."
                            style={{ background: 'rgba(245,158,11,.15)', color: 'var(--yellow, #f59e0b)', fontSize: '.7rem', fontWeight: 600 }}
                          >
                            ⚠ No owner
                          </span>
                        )}
                        <a className="btn btn-xs" href={`/app?slug=${app.slug}`}>manage</a>
                        <button
                          className="btn btn-xs"
                          onClick={() => setUsersModalApp(app)}
                          title="Manage which users have access to this app and at what role"
                        >Users</button>
                        <button
                          className="btn btn-xs"
                          onClick={() => setAccessModalApp(app)}
                          title="Roles this app defines for itself, and who holds them"
                        >Access</button>
                        <button
                          className="btn btn-xs btn-icon"
                          onClick={() => setFrameAncestors(app)}
                          aria-label={`Allowed embedders for ${app.name}`}
                          style={app.frame_ancestors ? { color: 'var(--accent)' } : undefined}
                          title={app.frame_ancestors ? `Embedders: ${app.frame_ancestors}` : 'Allowed embedders (default: same origin only)'}
                        ><IconImage /></button>
                        {(() => {
                          const abp = Array.isArray(app.auth_bypass_paths) ? app.auth_bypass_paths : []
                          return (
                            <button
                              className="btn btn-xs btn-icon"
                              onClick={() => setAuthBypassPaths(app)}
                              aria-label={`Auth-bypass paths for ${app.name}`}
                              style={abp.length ? { color: 'var(--accent)' } : undefined}
                              title={abp.length
                                ? `Auth-bypass paths: ${abp.join(', ')}`
                                : 'Path prefixes that bypass SSO on this app (advanced — apps must self-authenticate)'}
                            ><IconUnlock /></button>
                          )
                        })()}
                        <button
                          className="btn btn-xs btn-icon"
                          onClick={() => openIngress(app)}
                          aria-label={`Ingress for ${app.name}`}
                          style={app.publish_drift && app.publish_applied === false
                            // A configured publish that is NOT live outranks the
                            // red "this app is exposed" colour: red says a port
                            // is open, and here the point is that it is not.
                            ? { color: 'var(--amber, #f59e0b)' }
                            : publishesPort(app.ingress_type)
                            ? { color: 'var(--red, #ef4444)' }
                            : app.pending_port_release ? { color: 'var(--amber, #f59e0b)' } : undefined}
                          title={app.publish_drift && app.publish_applied === false
                            ? `Ingress: ${app.publish_drift.message}`
                            : app.ingress_type === 'dual'
                            ? `Ingress: dual — HTTP control plane through Caddy (SSO, TLS, identity headers, logging), plus a raw data plane on host port ${app.public_port ?? '(not allocated)'} → container port ${app.data_plane_port ?? '(not set)'} that is not behind AppCrane auth`
                            : app.ingress_type === 'tcp'
                            ? `Ingress: raw TCP on host port ${app.public_port ?? '(not allocated)'} — not behind AppCrane auth`
                            : app.pending_port_release
                              ? `Ingress: HTTP through Caddy, but port ${app.pending_port_release} is still open — the running container was started with it and keeps binding it until the app is redeployed or restarted.`
                              : 'Ingress — HTTP through Caddy (default). Platform admins can publish a raw port instead.'}
                        ><IconPlug /></button>
                        <button
                          className="btn btn-xs btn-icon"
                          onClick={() => setCustomDomain(app)}
                          aria-label={`Custom domain for ${app.name}`}
                          style={app.domain ? { color: 'var(--accent)' } : undefined}
                          title={app.domain
                            ? `Custom domain: ${app.domain} (served at root, no SSO/topbar)`
                            : 'Custom domain — serve this app on its own domain, bypassing AppCrane auth'}
                        ><IconGlobe /></button>
                        {(app.source_type === 'github' || app.source_type === 'managed' || app.github_url) && (
                          <>
                            {app.github_url && (
                              <a className="btn btn-xs" href={app.github_url} target="_blank" rel="noreferrer" title={app.github_url}>gh ↗</a>
                            )}
                            <button
                              className="btn btn-xs"
                              onClick={() => checkUpdates(app.slug)}
                              title="Check GitHub for new commits since last deploy"
                            >{checkUpdateText[app.slug] || '↑ updates'}</button>
                            <button
                              className="btn btn-xs"
                              onClick={() => setHookApp(app)}
                              title="Auto-deploy on git push (webhook)"
                            >auto-deploy</button>
                          </>
                        )}
                        <button className="btn btn-xs btn-icon" onClick={() => setMetricsApp(app)} aria-label={`Resource metrics for ${app.name}`} title="CPU / memory over time"><IconActivity /></button>
                        <button className="btn btn-xs btn-red btn-icon" onClick={() => deleteApp(app.slug, app.name)} aria-label={`Delete ${app.name}`} title={`Delete ${app.name}`}><IconTrash /></button>
                      </div>
                    </td>
                  </tr>
                  )}
                  {isExpanded && (
                    <tr key={`${app.slug}-envs`} className="apps-row-drill">
                      <td colSpan={12}>
                        <div className="apps-drill-envs">
                          {(['sandbox', 'production'] as const).map(env => {
                            const liveVer = versions[app.slug]?.[env === 'production' ? 'prod' : 'sand']
                            const deployVer = app[env]?.deploy?.version
                            const ver = (liveVer && liveVer !== '—') ? liveVer : (deployVer || null)
                            const isProd = env === 'production'
                            const isDown = app[env]?.health?.status === 'down'
                            return (
                              <div key={env} className={`apps-drill-env apps-drill-env-${env}`}>
                                <div className="apps-drill-env-hdr">
                                  {isProd ? 'Production' : 'Sandbox'}
                                </div>
                                <div className="apps-drill-env-body">
                                  {(() => { const s = healthState(app, env); return <span className={s.className} title={s.title} /> })()}
                                  <span style={{ fontFamily: 'monospace', fontSize: '.74rem', color: 'var(--dim)' }}>{ver ?? '—'}</span>
                                  {isDown ? (
                                    <span className="env-link env-link-disabled" title={`${env} is down — open disabled`} aria-disabled="true">↗ open</span>
                                  ) : (
                                    <a className="env-link" href="#" onClick={e => { e.preventDefault(); openAppFrame(app, env) }}>↗ open</a>
                                  )}
                                  <button className="btn btn-xs" onClick={() => toggleEvars(app.slug, env)}>env vars</button>
                                  <button className="btn btn-xs" onClick={() => restartApp(app.slug, env)}>↺ restart</button>
                                  {(() => {
                                    const st = storage[app.slug]
                                    const label = st === 'loading' || st === undefined ? '…'
                                      : st === 'error' ? 'n/a'
                                      : fmtBytes(st[env])
                                    return (
                                      <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--dim)', whiteSpace: 'nowrap' }}
                                        title="Persistent storage used by this environment's /data volume">
                                        💾 {label}
                                      </span>
                                    )
                                  })()}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                  {isExpanded && activeEnv && (
                    <tr key={`${app.slug}-evars`}>
                      <td colSpan={12} className="evars-panel">
                        <div style={{ fontWeight: 600, fontSize: '.78rem', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--dim)' }}>
                          {activeEnv === 'production' ? 'Production' : 'Sandbox'} Env Vars · {app.name}
                        </div>
                        {(evarData[`${app.slug}:${activeEnv}`] ?? []).map((row, idx) => (
                          <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                            <input
                              style={{ flex: 1, padding: '4px 8px', fontSize: '.8rem' }}
                              value={row.key}
                              onChange={e => updateEnvVar(app.slug, activeEnv, idx, 'key', e.target.value)}
                              onBlur={() => saveEnvVar(app.slug, activeEnv, idx)}
                              placeholder="KEY"
                            />
                            <input
                              style={{ flex: 2, padding: '4px 8px', fontSize: '.8rem', fontFamily: 'monospace' }}
                              value={row.value}
                              onChange={e => updateEnvVar(app.slug, activeEnv, idx, 'value', e.target.value)}
                              onBlur={() => saveEnvVar(app.slug, activeEnv, idx)}
                              placeholder="value"
                            />
                            <button className="btn btn-xs btn-red" onClick={() => deleteEnvVar(app.slug, activeEnv, idx)}>✕</button>
                          </div>
                        ))}
                        <button className="btn btn-xs" style={{ marginTop: 4 }} onClick={() => addEnvVar(app.slug, activeEnv)}>+ Add var</button>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
            {loaded && sorted.length === 0 && (
              <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--dim)', padding: 24 }}>
                {filtersActive ? (
                  <>No apps match the current filters. <button className="btn btn-xs" onClick={clearFilters} style={{ marginLeft: 6 }}>Clear filters</button></>
                ) : 'No applications yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {frame.open && (
        <FrameOverlay
          frame={frame}
          framePanel={framePanel}
          setFrame={setFrame}
          setFramePanel={setFramePanel}
        />
      )}

      {promptModalEl}

      {/* v2.5.21: per-app Users modal — opened from "Users" button on
          each Manage row. Lists every user with a role select for THIS
          app. Replaces the wide N×M App Roles matrix that used to live
          on /settings#users. */}
      {metricsApp && (() => {
        const rows = metricsRows ?? []
        const toX = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime()
        const mk = (env: string, field: 'cpu_percent' | 'mem_mb') =>
          rows.filter(r => r.env === env).map(r => ({ x: toX(r.recorded_at), v: r[field] }))
        const cpu: Series[] = [
          { label: 'production', color: '#22c55e', points: mk('production', 'cpu_percent') },
          { label: 'sandbox', color: '#f5a623', points: mk('sandbox', 'cpu_percent') },
        ]
        const mem: Series[] = [
          { label: 'production', color: '#22c55e', points: mk('production', 'mem_mb') },
          { label: 'sandbox', color: '#f5a623', points: mk('sandbox', 'mem_mb') },
        ]
        return (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setMetricsApp(null)}
          >
            <div
              style={{ width: 'min(600px, 92vw)', background: 'var(--surface, #1a1a1a)', color: 'var(--text)', border: '1px solid var(--border, #333)', borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              onClick={e => e.stopPropagation()}
              role="dialog"
              aria-label={`Resource usage for ${metricsApp.name}`}
            >
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border, #333)', background: 'var(--surface2, #232323)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600, fontSize: '.95rem' }}>Resource usage · {metricsApp.name}</span>
                <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>last 24h</span>
                <button className="btn btn-xs" style={{ marginLeft: 'auto' }} onClick={() => setMetricsApp(null)}>Close</button>
              </div>
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
                {metricsRows === null
                  ? <div style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading…</div>
                  : <>
                      <ResourceChart title="CPU" unit="%" series={cpu} />
                      <ResourceChart title="Memory" unit="MB" series={mem} />
                    </>}
              </div>
            </div>
          </div>
        )
      })()}

      {/* v2.42.0: ingress modal. A tcp app is published straight onto the host,
          so this dialog's job is less "edit a field" than "tell whoever opens it
          that the app has a second door AppCrane does not guard". The warning is
          shown to readers as well as editors; only platform admins get controls. */}
      {ingressApp && (() => {
        const app = ingressApp
        const curType: IngressType = publishesPort(app.ingress_type) ? app.ingress_type as IngressType : 'http'
        const isTcp = curType === 'tcp'
        const isDual = curType === 'dual'
        // Everything the red exposure block says is true of both publishing
        // types — a host port with nothing of Caddy's in front of it.
        const published = publishesPort(curType)
        // What the raw publish targets INSIDE the container. A pure-tcp app has
        // one listener and the whole of it is published, so that is the control
        // plane's own port; a dual app names a second one.
        const containerPort = isDual ? app.data_plane_port : CONTROL_PLANE_PORT
        const dirty = ingressDraft.type !== curType
          || (publishesPort(ingressDraft.type) && ingressDraft.port.trim() !== String(app.public_port ?? ''))
          || (ingressDraft.type === 'dual' && ingressDraft.dataPort.trim() !== String(app.data_plane_port ?? ''))
          || (publishesPort(ingressDraft.type)
              && ingressDraft.sandboxPort.trim() !== String(app.sandbox_public_port ?? ''))
        return (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setIngressApp(null)}
          >
            <div
              style={{ width: 'min(600px, 92vw)', maxHeight: '85vh', background: 'var(--surface, #1a1a1a)', color: 'var(--text)', border: '1px solid var(--border, #333)', borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              onClick={e => e.stopPropagation()}
              role="dialog"
              aria-label={`Ingress for ${app.name}`}
            >
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border, #333)', background: 'var(--surface2, #232323)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600, fontSize: '.95rem' }}>Ingress · {app.name}</span>
                <button className="btn btn-xs" style={{ marginLeft: 'auto' }} onClick={() => setIngressApp(null)}>Close</button>
              </div>
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, fontSize: '.85rem', overflowY: 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--dim)' }}>Current</span>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{curType}</span>
                  {curType === 'http' && <span style={{ color: 'var(--dim)', fontSize: '.78rem' }}>HTTP through Caddy — SSO, TLS, identity headers, request logging all apply.</span>}
                  {isDual && <span style={{ color: 'var(--dim)', fontSize: '.78rem' }}>Two planes at once — an HTTP control plane through Caddy, and a raw data plane published on the host.</span>}
                </div>

                {/* The point of the dual type is that the two planes have
                    DIFFERENT security properties, and a single badge or enum
                    can't say that. Showing them side by side is the only way a
                    reader learns which half of their app is defended. */}
                {isDual && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div style={{ border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.07)', borderRadius: 6, padding: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: '.78rem', letterSpacing: '.3px', color: 'var(--green, #22c55e)', marginBottom: 6 }}>CONTROL PLANE · defended</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '.78rem', marginBottom: 6 }}>{CONTROL_PLANE_MAPPING} → Caddy</div>
                      <p style={{ margin: 0, color: 'var(--dim)', fontSize: '.75rem' }}>
                        Ordinary HTTP at this app's AppCrane URL. TLS, AppCrane SSO, <code style={{ fontFamily: 'monospace' }}>X-AppCrane-*</code> identity
                        headers, security headers and access logs all apply, exactly as on an <code style={{ fontFamily: 'monospace' }}>http</code> app.
                        This is also the plane the health check probes.
                      </p>
                    </div>
                    <div style={{ border: '1px solid rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)', borderRadius: 6, padding: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: '.78rem', letterSpacing: '.3px', color: 'var(--red, #ef4444)', marginBottom: 6 }}>DATA PLANE · undefended</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '.78rem', marginBottom: 6 }}>
                        0.0.0.0:{app.public_port ?? '—'} → container:{app.data_plane_port ?? '—'}
                      </div>
                      <p style={{ margin: 0, color: 'var(--dim)', fontSize: '.75rem' }}>
                        A direct Docker publish. Caddy is not in this path, so none of the above applies to it — see below.
                        Clients reach it at the host address and this port; nothing about the AppCrane URL is involved.
                      </p>
                    </div>
                  </div>
                )}

                {published && (
                  <div style={{ border: '1px solid rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '1.5rem', fontWeight: 700, color: 'var(--red, #ef4444)' }}>
                        {app.public_port ? `:${app.public_port}` : 'no port allocated'}
                      </span>
                      {app.public_port && (
                        <span style={{ color: 'var(--dim)', fontSize: '.78rem', fontFamily: 'monospace' }}>
                          0.0.0.0:{app.public_port} → container:{containerPort ?? '—'}
                        </span>
                      )}
                    </div>
                    <p style={{ margin: 0 }}>
                      <strong>This port is a second door, and AppCrane does not guard it.</strong> Traffic to it never
                      touches Caddy, so there is <strong>no AppCrane sign-in</strong>, no <code style={{ fontFamily: 'monospace' }}>X-AppCrane-*</code> identity
                      headers, no per-request audit, no rate limiting, no security headers and no TLS from AppCrane.
                      Every access control AppCrane has assumes Caddy is the only way in. <strong>The app authenticates
                      every connection itself</strong> — if its own auth has a gap, anyone who can reach this host is inside it.
                      {isDual && <> This is true of the <strong>data plane only</strong>. The control plane above is
                      untouched and still fully behind Caddy — but the two are the same process in the same container,
                      so a flaw reachable through this port is reachable in the code that serves the defended plane too.</>}
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      This host sits behind SDP, so the port is not on the internet — the population that can reach it
                      is everyone SDP admits, plus any compromised device inside that perimeter. For a forward / CONNECT
                      proxy that means an unaudited egress path out of the perimeter, used by whoever finds it.
                      {isTcp
                        ? <> The app's 407 Proxy-Authenticate path is the critical path here — not the ingress.</>
                        : <> Whatever this app's data-plane protocol uses to authenticate is the critical path here — not the ingress,
                          and not the sign-in on the control plane, which this port does not go through.</>}
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      The app can still authenticate against AppCrane: <code style={{ fontFamily: 'monospace' }}>/api/me</code> with
                      the user's bearer token, or <code style={{ fontFamily: 'monospace' }}>/api/service</code> with its
                      own <code style={{ fontFamily: 'monospace' }}>APPCRANE_SERVICE_TOKEN</code> over the docker bridge.
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      AppCrane <strong>publishes</strong> the port; reaching it from outside this host is governed by SDP
                      and the host's own filtering. Do not read that as two independent keys — see the Linux caveat below,
                      which is why a published port is not as contained as it looks.
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      <strong>Linux caveat:</strong> a Docker-published port is a DNAT rule evaluated in{' '}
                      <code style={{ fontFamily: 'monospace' }}>FORWARD</code> and never traverses{' '}
                      <code style={{ fontFamily: 'monospace' }}>INPUT</code>, so a plain{' '}
                      <code style={{ fontFamily: 'monospace' }}>ufw deny</code> does <strong>not</strong> block it.
                      Filter in the <code style={{ fontFamily: 'monospace' }}>DOCKER-USER</code> chain, or in a cloud
                      security group upstream of this host.
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      {isDual ? (
                        <>
                          The publish covers the <strong>whole listener on container port {app.data_plane_port ?? '—'}</strong>, not just the
                          protocol you had in mind for it. Anything that listener answers is reachable here. Port{' '}
                          <code style={{ fontFamily: 'monospace' }}>{CONTROL_PLANE_PORT}</code> is <strong>not</strong> published — that is
                          the whole reason a data plane port exists, and why AppCrane refuses to set it to{' '}
                          <code style={{ fontFamily: 'monospace' }}>{CONTROL_PLANE_PORT}</code>: doing so would put the app's ordinary
                          HTTP origin, health route and any admin or metrics route on the host with none of Caddy's controls in front.
                        </>
                      ) : (
                        <>
                          The publish covers the <strong>whole container port</strong>, not just the app's raw protocol —
                          every HTTP route it serves on port 3000, including <code style={{ fontFamily: 'monospace' }}>/api/health</code>{' '}
                          and any admin or metrics route it assumed was behind AppCrane SSO, answers here too.
                        </>
                      )}
                    </p>
                  </div>
                )}

                {/* The one state where "Current: http" is not the whole truth.
                    Shown to readers, not only to the admin who flipped it: the
                    person who has to act on it is whoever next looks at this app. */}
                {!published && !!app.pending_port_release && (
                  <div style={{ border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.08)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--amber, #f59e0b)' }}>
                      port {app.pending_port_release} is still open
                    </div>
                    <p style={{ margin: 0 }}>
                      Ingress is <code style={{ fontFamily: 'monospace' }}>http</code> again, so AppCrane publishes
                      nothing for this app — but the publish is a <code style={{ fontFamily: 'monospace' }}>docker run</code>{' '}
                      flag, and the container that is <strong>running right now</strong> was started with it. It keeps
                      binding <code style={{ fontFamily: 'monospace' }}>0.0.0.0:{app.pending_port_release}</code>, with no
                      AppCrane sign-in in front of it, until the container is <strong>recreated</strong>.
                    </p>
                    <p style={{ margin: 0, color: 'var(--dim)' }}>
                      <strong>Deploy this app, or press ↺ restart, to actually close the port.</strong> Until then
                      AppCrane keeps {app.pending_port_release} reserved to this app — no other app can be given a port
                      something is still bound to — and hands it back to the pool the moment the container returns
                      without it. The exposure is not revoked before that.
                    </p>
                  </div>
                )}

                {isPlatformAdmin ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border, #333)', paddingTop: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      Ingress type
                      <select
                        value={ingressDraft.type}
                        aria-label={`Ingress type for ${app.name}`}
                        onChange={e => setIngressDraft(d => ({ ...d, type: e.target.value as IngressType }))}
                        style={{ fontSize: '.8rem' }}
                      >
                        <option value="http">http — through Caddy (default)</option>
                        <option value="tcp">tcp — published on the host, unguarded</option>
                        <option value="dual">dual — Caddy for HTTP, plus an unguarded published port</option>
                      </select>
                    </label>
                    {publishesPort(ingressDraft.type) && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        Public host port
                        <input
                          className="editable" type="number" min={PUBLIC_PORT_MIN} max={PUBLIC_PORT_MAX}
                          aria-label={`Public host port for ${app.name}`}
                          value={ingressDraft.port}
                          placeholder="auto"
                          onChange={e => setIngressDraft(d => ({ ...d, port: e.target.value }))}
                          style={{ width: 110, fontFamily: 'monospace' }}
                        />
                        <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
                          Leave blank to keep the current port, or to have one allocated from {AUTO_PORT_RANGE}.
                          Name one yourself and it may be anything in {PUBLIC_PORT_RANGE} — when a fleet of
                          clients is already configured for a port, that number is not AppCrane's to change. A port outside
                          the {AUTO_PORT_RANGE} block needs a firewall rule of its own.
                        </span>
                      </label>
                    )}
                    {/* The container-side half. Only 'dual' has two planes to
                        tell apart: a pure-tcp app publishes its one listener,
                        so a second number there would just be another way to
                        name the same port. */}
                    {ingressDraft.type === 'dual' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        Data plane port <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>(inside the container)</span>
                        <input
                          className="editable" type="number" min={PUBLIC_PORT_MIN} max={PUBLIC_PORT_MAX}
                          aria-label={`Data plane container port for ${app.name}`}
                          value={ingressDraft.dataPort}
                          placeholder="required"
                          onChange={e => setIngressDraft(d => ({ ...d, dataPort: e.target.value }))}
                          style={{ width: 110, fontFamily: 'monospace' }}
                        />
                        <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
                          The port your app's raw listener binds INSIDE the container — required, and it cannot
                          be {CONTROL_PLANE_PORT}. Port {CONTROL_PLANE_PORT} is the HTTP control plane Caddy proxies to;
                          publishing it raw would hand out the app's ordinary HTTP origin with no TLS, no sign-in, no
                          identity headers and no audit. Two apps may use the same container-side port — only the host
                          port has to be unique.
                        </span>
                      </label>
                    )}
                    {/* v2.46.0: the SANDBOX container's own host port. Optional
                        and independent — leave it blank and sandbox publishes
                        nothing, exactly as it always did. It exists so a raw
                        data plane can be exercised before it goes live, which
                        was impossible when the publish was production-only. */}
                    {publishesPort(ingressDraft.type) && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        Sandbox host port <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>(optional)</span>
                        <input
                          className="editable" type="number" min={PUBLIC_PORT_MIN} max={PUBLIC_PORT_MAX}
                          aria-label={`Sandbox public port for ${app.name}`}
                          value={ingressDraft.sandboxPort}
                          placeholder="none"
                          onChange={e => setIngressDraft(d => ({ ...d, sandboxPort: e.target.value }))}
                          style={{ width: 110, fontFamily: 'monospace' }}
                        />
                        <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
                          Publishes the SANDBOX container on its own host port, so the raw plane can be tried
                          before it is promoted. Must differ from every port any app holds in either
                          environment. Leave blank and sandbox publishes nothing. This is a SECOND door with no
                          sign-in, no TLS from AppCrane and no audit — on the container running your least
                          reviewed code.
                        </span>
                      </label>
                    )}
                    {ingressDraft.type === 'tcp' && !isTcp && (
                      <p style={{ margin: 0, color: 'var(--red, #ef4444)', fontSize: '.8rem' }}>
                        Switching to tcp opens a host port for this app. It will be reachable with no AppCrane
                        authentication — the app must authenticate every connection itself. The port is a{' '}
                        <code style={{ fontFamily: 'monospace' }}>docker run</code> flag, so it appears when the
                        container is next recreated: a deploy, or the ↺ restart button.
                      </p>
                    )}
                    {ingressDraft.type === 'dual' && !isDual && (
                      <p style={{ margin: 0, color: 'var(--red, #ef4444)', fontSize: '.8rem' }}>
                        Switching to dual opens a host port for this app, in ADDITION to the HTTP it already serves
                        through Caddy. The published port is reachable with no AppCrane authentication — the app must
                        authenticate every connection on it itself. The HTTP control plane on container port{' '}
                        {CONTROL_PLANE_PORT} is unaffected: it keeps its TLS, sign-in, identity headers and logging, and
                        it stays the plane the health check probes, because a bare connection to the data port would look
                        healthy even with the control plane wedged. The port is a{' '}
                        <code style={{ fontFamily: 'monospace' }}>docker run</code> flag, so it appears when the
                        container is next recreated: a deploy, or the ↺ restart button.
                      </p>
                    )}
                    {ingressDraft.type === 'http' && published && (
                      <p style={{ margin: 0, color: 'var(--red, #ef4444)', fontSize: '.8rem' }}>
                        This does <strong>not</strong> close port {app.public_port}. It stops AppCrane publishing it —
                        the running container keeps binding it until the container is <strong>recreated</strong>
                        {' '}(deploy, or the ↺ restart button), because the publish is a{' '}
                        <code style={{ fontFamily: 'monospace' }}>docker run</code> flag. Until you do that the port
                        stays reachable and unauthenticated, so AppCrane keeps it <strong>reserved to this app</strong>:
                        no other app can be given a number something is still bound to, and it returns to the pool
                        automatically once the container comes back without it. <strong>Redeploy or restart this app
                        to actually close the port.</strong>
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-xs"
                        disabled={!dirty || ingressBusy}
                        onClick={() => {
                          if (ingressDraft.type === 'tcp' && isDual
                            && !confirm(`Move "${app.name}" from dual to plain TCP?\n\nThis DROPS the data plane (container port ${app.data_plane_port}). Host port ${app.public_port ?? '(auto)'} will then reach container port ${CONTROL_PLANE_PORT} — the HTTP control plane — directly, with no TLS from AppCrane, no sign-in, no identity headers and no request audit. Clients stay pointed at the same port; what answers them changes.`)) return
                          if (ingressDraft.type === 'tcp' && !isTcp && !isDual
                            && !confirm(`Publish "${app.name}" on a raw TCP port?\n\nThe port is NOT behind AppCrane authentication. The app owns authn entirely.`)) return
                          if (ingressDraft.type === 'dual' && !isDual
                            && !confirm(`Publish a raw data plane for "${app.name}"?\n\nHost port ${ingressDraft.port.trim() || '(auto)'} will reach container port ${ingressDraft.dataPort.trim() || '(unset)'} directly. That port is NOT behind AppCrane authentication — the app owns authn on it entirely. The HTTP control plane on container port ${CONTROL_PLANE_PORT} stays behind Caddy, unchanged.`)) return
                          saveIngress(app, ingressDraft.type, ingressDraft.port, ingressDraft.dataPort, ingressDraft.sandboxPort)
                        }}
                      >{ingressBusy ? 'Saving…' : 'Save'}</button>
                    </div>
                  </div>
                ) : (
                  <p style={{ margin: 0, color: 'var(--dim)', fontSize: '.8rem', borderTop: '1px solid var(--border, #333)', paddingTop: 14 }}>
                    Only a platform admin can change ingress. Opening a host port bypasses every control AppCrane
                    has, so it is not a self-service setting — ask a platform admin.
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {hookApp && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setHookApp(null)}
        >
          <div
            style={{ width: 'min(560px, 92vw)', background: 'var(--surface, #1a1a1a)', color: 'var(--text)', border: '1px solid var(--border, #333)', borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-label={`Auto-deploy for ${hookApp.name}`}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border, #333)', background: 'var(--surface2, #232323)', fontWeight: 600, fontSize: '.95rem' }}>
              Auto-deploy · {hookApp.name}
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, fontSize: '.85rem' }}>
              <p style={{ margin: 0, color: 'var(--dim)' }}>
                Deploy automatically when GitHub pushes to the tracked branch. AppCrane verifies the webhook signature — enable it below, then register the hook on GitHub (or paste the URL into the repo's webhook settings).
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={!!hookCfg?.auto_deploy_sandbox} onChange={e => saveHook({ auto_deploy_sandbox: e.target.checked })} />
                Auto-deploy <strong>sandbox</strong> on push
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={!!hookCfg?.auto_deploy_prod} onChange={e => saveHook({ auto_deploy_prod: e.target.checked })} />
                Auto-deploy <strong>production</strong> on push <span style={{ color: 'var(--red)', fontSize: '.75rem' }}>(use with care)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Branch
                <input className="editable" style={{ width: 140 }} defaultValue={hookCfg?.branch_filter ?? ''} placeholder="main"
                  onBlur={e => saveHook({ branch_filter: e.target.value.trim() || 'main' })} />
              </label>
              <div>
                <div style={{ color: 'var(--dim)', fontSize: '.75rem', marginBottom: 4 }}>Webhook URL (GitHub payload URL):</div>
                <input className="editable" readOnly style={{ width: '100%', fontFamily: 'monospace', fontSize: '.75rem' }}
                  value={hookCfg?.token ? `${window.location.origin}/api/webhooks/${hookCfg.token}` : 'register to generate…'}
                  onFocus={e => e.currentTarget.select()} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-xs" onClick={async () => {
                  await registerGithubHook(hookApp.slug)
                  const c = await adminApi.get<HookCfg>(`/api/apps/${hookApp.slug}/webhook`).catch(() => null)
                  if (c) setHookCfg(c)
                }}>Register on GitHub</button>
                <button className="btn btn-xs" onClick={() => setHookApp(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {usersModalApp && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10500,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => { setUsersModalApp(null); setUsersModalFilter('') }}
        >
          <div
            style={{
              width: 'min(640px, 92vw)', maxHeight: '80vh',
              background: 'var(--surface, #1a1a1a)', color: 'var(--text)',
              border: '1px solid var(--border, #333)', borderRadius: 8,
              boxShadow: '0 16px 48px rgba(0,0,0,.5)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-label={`Users for ${usersModalApp.name}`}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 16px',
              borderBottom: '1px solid var(--border, #333)',
              background: 'var(--surface2, #232323)',
            }}>
              <span style={{ fontWeight: 600, fontSize: '.95rem' }}>
                Users · {usersModalApp.name}
              </span>
              <span style={{ fontSize: '.74rem', color: 'var(--dim)', fontFamily: 'monospace' }}>
                {usersModalApp.slug}
              </span>
              <button
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none',
                  color: 'var(--dim)', fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer',
                }}
                onClick={() => { setUsersModalApp(null); setUsersModalFilter('') }}
                aria-label="Close"
              >×</button>
            </div>

            {/* v2.7.24: search box. Lives outside the scroll region so it
                stays pinned while the list scrolls. autoFocus = the input is
                ready as soon as the modal opens. */}
            <div style={{ padding: '10px 16px 6px', borderBottom: '1px solid var(--border-faint, #2a2a2a)' }}>
              <input
                type="text"
                placeholder="Search by name or email…"
                value={usersModalFilter}
                onChange={e => setUsersModalFilter(e.target.value)}
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '6px 10px', fontSize: '.85rem',
                  background: 'var(--surface2, #232323)',
                  border: '1px solid var(--border, #333)',
                  borderRadius: 6, color: 'var(--text)',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ overflowY: 'auto', padding: '8px 16px', flex: 1 }}>
              {usersModalData === null ? (
                <div style={{ color: 'var(--dim)', padding: 16 }}>Loading…</div>
              ) : usersModalData.length === 0 ? (
                <div style={{ color: 'var(--dim)', padding: 16 }}>No users registered.</div>
              ) : (() => {
                const q = usersModalFilter.trim().toLowerCase()
                const filtered = q
                  ? usersModalData.filter(u =>
                      (u.name || '').toLowerCase().includes(q) ||
                      (u.email || '').toLowerCase().includes(q))
                  : usersModalData
                if (filtered.length === 0) {
                  return <div style={{ color: 'var(--dim)', padding: 16 }}>No users match &quot;{usersModalFilter}&quot;.</div>
                }
                return (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
                      <th style={{ textAlign: 'left',  padding: '8px 4px', fontSize: '.78rem', color: 'var(--dim)', fontWeight: 500 }}>User</th>
                      <th style={{ textAlign: 'right', padding: '8px 4px', fontSize: '.78rem', color: 'var(--dim)', fontWeight: 500 }}>Role on this app</th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(u => {
                      const status = usersModalSaving[u.id]
                      const isPlatformAdmin = u.role === 'platform_admin'
                      const value = isPlatformAdmin ? 'owner' : u.app_role
                      return (
                        <tr key={u.id} style={{ borderBottom: '1px solid var(--border-faint, #2a2a2a)' }}>
                          <td style={{ padding: '8px 4px', fontSize: '.88rem' }}>
                            <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                              {u.name}
                              {isPlatformAdmin && (
                                <span style={{
                                  fontSize: '.66rem', padding: '1px 6px', borderRadius: 3,
                                  background: 'rgba(245, 158, 11, .2)', color: '#fbbf24',
                                  border: '1px solid rgba(245, 158, 11, .4)',
                                }}>platform_admin</span>
                              )}
                            </div>
                            {u.email && (
                              <div style={{ fontSize: '.74rem', color: 'var(--dim)' }}>{u.email}</div>
                            )}
                          </td>
                          <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                            <select
                              value={value}
                              disabled={isPlatformAdmin || status === 'saving'}
                              title={isPlatformAdmin
                                ? 'Platform admin has owner-equivalent access to every app. Demote their global role first.'
                                : undefined}
                              onChange={e => changeUserAppRole(u.id, e.target.value as ModalUser['app_role'])}
                              style={{ minWidth: 110 }}
                            >
                              <option value="none">none</option>
                              <option value="user">user</option>
                              <option value="admin">admin</option>
                              <option value="owner">owner</option>
                            </select>
                          </td>
                          <td style={{ padding: '8px 0', textAlign: 'center', width: 28 }}>
                            {!isPlatformAdmin && status === 'saving' && <span style={{ color: 'var(--dim)' }}>…</span>}
                            {!isPlatformAdmin && status === 'saved'  && <span style={{ color: 'var(--green)' }}>✓</span>}
                            {!isPlatformAdmin && status === 'error'  && <span style={{ color: 'var(--red)' }}>✗</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                )
              })()}
            </div>

            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border, #333)',
              background: 'var(--surface2, #232323)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: '.74rem', color: 'var(--dim)' }}>
                Changes save automatically.
              </span>
              <button className="btn btn-accent" onClick={() => setUsersModalApp(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {accessModalApp && (
        <AppAccessModal
          slug={accessModalApp.slug}
          name={accessModalApp.name}
          onClose={() => setAccessModalApp(null)}
        />
      )}
    </div>
  )
}

interface FrameOverlayProps {
  frame: FrameState
  framePanel: 'ask' | 'request' | 'bug' | null
  setFrame: React.Dispatch<React.SetStateAction<FrameState>>
  setFramePanel: React.Dispatch<React.SetStateAction<'ask' | 'request' | 'bug' | null>>
}

function FrameOverlay({ frame, framePanel, setFrame, setFramePanel }: FrameOverlayProps) {
  const topbarRef = useRef<HTMLElement>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [folded, setFolded] = useState(false)
  // v2.3.2: point-and-click Request flow — picker activates on button
  // click, then the captured ctx drives a floating modal instead of a
  // side drawer. The drawer-based Request panel is kept for portal embed
  // compatibility (CranePanels.tsx) but no longer mounted from here.
  const peek = usePeek(iframeRef)
  const [requestCtx, setRequestCtx] = useState<PeekCtx | null>(null)
  useEffect(() => {
    if (peek.ctx) {
      setRequestCtx(peek.ctx)
      peek.clear()
    }
  }, [peek.ctx]) // eslint-disable-line react-hooks/exhaustive-deps

  // v2.3.4 What's New — when this frame opens for an app, ask the server
  // if there are deployments the user hasn't acknowledged yet. Shows a
  // dialog when the live version differs from the user's last_seen. The
  // server silently records first-time visits (no dialog) so users don't
  // get a wall of historic changes for an app that's been live for months.
  const [whatsNew, setWhatsNew] = useState<{ currentVersion: string | null; changes: WhatsNewChange[] } | null>(null)
  useEffect(() => {
    if (!frame.slug) return
    let cancelled = false
    adminApi
      .get<{ current_version: string | null; changes: WhatsNewChange[]; first_time: boolean }>(
        `/api/apps/${encodeURIComponent(frame.slug)}/whats-new`,
      )
      .then(r => {
        if (cancelled || !r) return
        if (!r.first_time && r.changes && r.changes.length > 0) {
          setWhatsNew({ currentVersion: r.current_version, changes: r.changes })
        }
      })
      .catch(() => { /* silent — this is a nice-to-have, not a blocker */ })
    return () => { cancelled = true }
  }, [frame.slug])

  // v2.7.5: keep the topbar version pill live AND correct for the env being
  // viewed. The frame was opened with a static deploy-record snapshot
  // (app.<env>.deploy.version) captured once at open time — so it never
  // changed when toggling Production/Sandbox, and showed a stale/empty value
  // when the production deploy record lagged the live container. Fetch the
  // live version and write it into the matching attribute.
  //
  // v2.31.2: probe BOTH envs, not only the active one. The topbar shows the
  // production and sandbox pills together, so refreshing just the active env
  // left the other pill on the stale deploy record until you clicked its tab —
  // and then the number changed in front of you, which reads as the UI
  // contradicting itself rather than catching up.
  useEffect(() => {
    if (!frame.slug) return
    const slug = frame.slug
    let cancelled = false

    const probe = (env: 'production' | 'sandbox') =>
      adminApi
        .get<{ version?: string }>(`/api/apps/${encodeURIComponent(slug)}/live-version/${env}`)
        .then(r => {
          // No version = that env isn't deployed or isn't answering. Leave the
          // recorded value rather than blanking a pill that was readable.
          if (cancelled || !r?.version) return
          const field = env === 'sandbox' ? 'sandVersion' : 'prodVersion'
          setFrame(f => (f.slug === slug && f.open ? { ...f, [field]: r.version } : f))
        })
        .catch(() => {})

    probe('production')
    probe('sandbox')
    return () => { cancelled = true }
  }, [frame.slug, frame.env, setFrame])
  // Per-panel last-used width, persisted across open/close so closing
  // and reopening Request keeps the user's chosen width.
  const [widths, setWidths] = useState<Record<'ask' | 'request' | 'bug', number>>({
    ask: 380, request: 420, bug: 460,
  })
  const dragRef = useRef<{ startX: number; startW: number; key: 'ask' | 'request' | 'bug' } | null>(null)
  const onResizerDown = (e: React.MouseEvent) => {
    if (!framePanel) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: widths[framePanel], key: framePanel }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const delta = d.startX - ev.clientX
      const next = Math.max(280, Math.min(900, d.startW + delta))
      setWidths(w => ({ ...w, [d.key]: next }))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // The Custom Element fires CustomEvents (not React synthetic events) so
  // we wire a per-mount listener block. Re-binds when callbacks change.
  useEffect(() => {
    const el = topbarRef.current
    if (!el) return

    const onBack    = () => setFrame({ open: false, url: '', title: '' })
    const onRefresh = () => {
      // v2.6.10: cache-bust on refresh. Setting an iframe's src to the
      // same URL it already has can be served from the browser disk
      // cache — the user clicks Refresh, the iframe unmounts and
      // remounts at /myapp, but the HTML response is cached so the new
      // asset hashes (and therefore the new version) never load.
      // Appending a fresh `_ts=…` query param forces a real network
      // fetch on every refresh; the app's server ignores unknown query
      // params and the SPA bundle picks up its current content-hashed
      // assets via the freshly fetched HTML.
      const cur = frame.url
      if (!cur) return
      const stripped = cur.replace(/([?&])_ts=\d+&?/, '$1').replace(/[?&]$/, '')
      const sep = stripped.includes('?') ? '&' : '?'
      const next = `${stripped}${sep}_ts=${Date.now()}`
      setFrame(f => ({ ...f, url: '' }))
      setTimeout(() => setFrame(f => ({ ...f, url: next })), 0)
    }
    const onEnv = (e: Event) => {
      const env = (e as CustomEvent<{ env: 'production' | 'sandbox' }>).detail.env
      setFrame(f => ({
        ...f,
        env,
        url:   env === 'sandbox' ? f.sandUrl! : f.prodUrl!,
        title: `${f.appName} (${env === 'sandbox' ? 'sandbox' : 'prod'})`,
      }))
    }
    const onFold = (e: Event) => {
      const next = (e as CustomEvent<{ folded: boolean }>).detail.folded
      setFolded(next)
    }

    el.addEventListener('crane-back',        onBack)
    el.addEventListener('crane-refresh',     onRefresh)
    el.addEventListener('crane-env-change',  onEnv)
    el.addEventListener('crane-fold-toggle', onFold)
    return () => {
      el.removeEventListener('crane-back',        onBack)
      el.removeEventListener('crane-refresh',     onRefresh)
      el.removeEventListener('crane-env-change',  onEnv)
      el.removeEventListener('crane-fold-toggle', onFold)
    }
  }, [frame.url, frame.appName, setFrame])

  // Shrink the iframe to leave room for the active drawer instead of
  // letting the drawer overlap the app. Width is user-resizable via the
  // .frame-dock-resizer; persisted per panel in `widths` state.
  const dockWidth = framePanel ? widths[framePanel] : 0
  return (
    <div
      className="app-frame-overlay"
      style={{ ['--frame-dock-width' as string]: `${dockWidth}px` } as React.CSSProperties}
    >
      <crane-app-topbar
        ref={topbarRef}
        app-name={frame.appName ?? frame.title ?? ''}
        app-icon-url={frame.hasIcon && frame.slug ? `/api/apps/${frame.slug}/icon` : ''}
        app-slug={frame.slug ?? ''}
        prod-version={frame.prodVersion ?? ''}
        sand-version={frame.sandVersion ?? ''}
        prod-url={frame.prodUrl ?? ''}
        sand-url={frame.sandUrl ?? ''}
        env={frame.env ?? 'production'}
        current-url={frame.url}
        {...(folded ? { folded: '' } : {})}
      >
        <span slot="actions" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <PresenceAvatars slug={frame.slug ?? null} />
          {frame.hasGithub && (
            <>
              {/* v2.7.25: 📋 Jobs button. The component existed since the
                  AppStudio request flow shipped, multiple panels' copy points
                  users at the "📋 Jobs panel" to track progress — but the
                  button was never actually slotted into the topbar. Reporter
                  bug #158 ("Jobs panel button does nothing") was real: it did
                  nothing because it wasn't there. Gated on frame.hasGithub
                  (same as Request/Bug) — Jobs only exist for github apps. */}
              <JobsButton slug={frame.slug ?? null} />
              <button
                type="button"
                className={'crane-topbar-btn' + (peek.active || requestCtx ? ' active' : '')}
                onClick={() => {
                  // v2.3.2 flow: click → immediately enter pick mode → on
                  // capture, the useEffect above opens the floating modal
                  // anchored to the picked element. No drawer.
                  if (requestCtx) { setRequestCtx(null); return }
                  if (peek.active) { peek.stop(); return }
                  peek.start()
                }}
                title={peek.active
                  ? 'Click an element in the app, then describe the change. Esc to cancel.'
                  : 'Point at an element to request an enhancement'}
              ><Icon.Lightbulb size={14} /> {peek.active ? 'Pick…' : 'Request'}</button>
              <button
                type="button"
                className={'crane-topbar-btn' + (framePanel === 'bug' ? ' active' : '')}
                onClick={() => setFramePanel(p => p === 'bug' ? null : 'bug')}
                title="Report a bug"
              ><Icon.Bug size={14} /> Bug</button>
            </>
          )}
        </span>
      </crane-app-topbar>

      {frame.url && <iframe ref={iframeRef} className="app-frame-iframe" src={frame.url} title={frame.title} />}
      {framePanel && (
        <div
          className="frame-dock-resizer"
          style={{ right: dockWidth }}
          onMouseDown={onResizerDown}
          title="Drag to resize panel"
        />
      )}
      {requestCtx && (
        <RequestModal
          slug={frame.slug ?? null}
          appName={frame.appName ?? frame.title ?? ''}
          peekCtx={requestCtx}
          onClose={() => setRequestCtx(null)}
        />
      )}
      {whatsNew && frame.slug && (
        <WhatsNewModal
          slug={frame.slug}
          appName={frame.appName ?? frame.title ?? frame.slug}
          currentVersion={whatsNew.currentVersion}
          changes={whatsNew.changes}
          onClose={() => setWhatsNew(null)}
        />
      )}
      <BugPanel
        slug={frame.slug ?? null}
        appName={frame.appName ?? frame.title ?? ''}
        open={framePanel === 'bug'}
        onClose={() => setFramePanel(null)}
        width={widths.bug}
      />
    </div>
  )
}
