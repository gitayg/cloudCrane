import { useState, useEffect, useRef, useCallback } from 'react'
import { adminApi } from '../adminApi'

interface App {
  slug: string
  name: string
  description?: string
  visibility?: string
  github_url?: string
  users?: { id: number; name: string }[]
  urls?: { production?: string; sandbox?: string }
  production?: { deploy?: { status?: string; version?: string }; health?: { status: string; config?: { endpoint?: string } } }
  sandbox?: { deploy?: { status?: string; version?: string }; health?: { status: string } }
}

interface User {
  id: number
  name: string
  email: string
}

interface Enhancement {
  id: number
  status: string
  message: string
  app_slug?: string
}

interface ActivityApp {
  name?: string
  slug: string
  counts: number[]
}

interface ServerHealth {
  system: {
    cpu: { percent: number; count: number }
    memory: { percent: number }
    memory_formatted: { used: string; total: string }
    disk: { percent: number }
    disk_formatted: { used: string; total: string }
  }
}

interface AppMetrics {
  metrics: Record<string, Record<string, { cpu: string; memory: number }>>
}

interface UsageSummary {
  total_jobs?: number
  succeeded?: number
  failed?: number
  total_tokens?: number
  total_cost?: number
}

interface EnvVar {
  key: string
  value: string
}

interface EnvPanel {
  env: string
  vars: EnvVar[]
  warnings: string[]
}

interface FrameModal {
  slug: string
  name: string
  url: string
}

interface EnhModal {
  slug: string
  name: string
}

interface PromptModal {
  slug: string
  name: string
}

const TREND_PALETTE = ['#4f9cf9', '#a855f7', '#f97316', '#22c55e', '#eab308', '#e91e63', '#00bcd4', '#ff5722']

function barColor(pct: number): string {
  if (pct > 80) return 'var(--red)'
  if (pct > 60) return 'var(--yellow)'
  return 'var(--green)'
}

function deployBadgeClass(status?: string): string {
  if (!status) return 'badge badge-pending'
  const s = status.toLowerCase()
  if (s === 'live' || s === 'healthy' || s === 'deployed') return 'badge badge-live'
  if (s === 'failed' || s === 'error') return 'badge badge-failed'
  if (s === 'building' || s === 'deploying') return 'badge badge-building'
  return 'badge badge-pending'
}

function healthDotClass(status?: string): string {
  if (!status) return 'dot dot-gray'
  const s = status.toLowerCase()
  if (s === 'healthy' || s === 'up') return 'dot dot-green'
  if (s === 'down' || s === 'unhealthy') return 'dot dot-red'
  return 'dot dot-gray'
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase()
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function TrendChart({ days, apps }: { days: string[]; apps: ActivityApp[] }) {
  if (!apps.length || !days.length) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--dim)', fontSize: '.85rem' }}>
        No visitor data yet
      </div>
    )
  }

  const PL = 28, PR = 12, PT = 16, PB = 28
  const W = 900, H = 160
  const chartW = W - PL - PR
  const chartH = H - PT - PB

  const allCounts = apps.flatMap(a => a.counts)
  const maxVal = Math.max(...allCounts, 1)

  const xOf = (i: number) => PL + (i / (days.length - 1 || 1)) * chartW
  const yOf = (v: number) => PT + chartH - (v / maxVal) * chartH

  const gridLines = 5
  const gridValues = Array.from({ length: gridLines }, (_, i) => Math.round((maxVal / (gridLines - 1)) * i))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
      {gridValues.map((val, i) => {
        const y = yOf(val)
        return (
          <g key={i}>
            <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="var(--border)" strokeWidth="1" />
            {val > 0 && (
              <text x={PL - 4} y={y + 4} textAnchor="end" fontSize="9" fill="var(--dim)">{val}</text>
            )}
          </g>
        )
      })}

      {days.map((d, i) => (
        <text key={i} x={xOf(i)} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--dim)">
          {formatDate(d)}
        </text>
      ))}

      {apps.map((app, ai) => {
        const color = TREND_PALETTE[ai % TREND_PALETTE.length]
        const pts = app.counts.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ')
        return (
          <g key={app.slug}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
            {app.counts.map((v, i) => (
              <g key={i}>
                <circle cx={xOf(i)} cy={yOf(v)} r="3" fill={color} />
                {v > 0 && (
                  <text x={xOf(i)} y={yOf(v) - 6} textAnchor="middle" fontSize="8" fill={color}>{v}</text>
                )}
              </g>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

function AppIcon({ slug, name, onClick }: { slug: string; name: string; onClick?: () => void }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/apps/${slug}/icon`, { method: 'HEAD' })
      .then(r => {
        if (cancelled || !r.ok) return
        setIconUrl(`/api/apps/${slug}/icon`)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [slug])

  return (
    <div
      style={{
        width: 36, height: 36, borderRadius: 8, overflow: 'hidden',
        background: 'var(--surface2)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative', cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <span style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--dim)' }}>{initials(name)}</span>
      )}
    </div>
  )
}

function EnvVarsPanel({ slug, env, onClose }: { slug: string; env: string; onClose: () => void }) {
  const [vars, setVars] = useState<EnvVar[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    adminApi.get<{ vars: EnvVar[]; warnings?: string[] }>(`/api/apps/${slug}/env/${env}?reveal=true`)
      .then(d => {
        setVars(d.vars ?? [])
        setWarnings(d.warnings ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [slug, env])

  function saveVar(key: string, value: string) {
    adminApi.put(`/api/apps/${slug}/env/${env}`, { vars: { [key]: value } }).catch(() => {})
  }

  async function deleteVar(key: string) {
    if (!confirm(`Delete env var "${key}"?`)) return
    await adminApi.del(`/api/apps/${slug}/env/${env}/${key}`).catch(() => {})
    setVars(v => v.filter(x => x.key !== key))
  }

  async function addVar() {
    const k = newKey.trim()
    const v = newVal.trim()
    if (!k) return
    await adminApi.put(`/api/apps/${slug}/env/${env}`, { vars: { [k]: v } }).catch(() => {})
    setVars(prev => {
      const existing = prev.find(x => x.key === k)
      if (existing) return prev.map(x => x.key === k ? { ...x, value: v } : x)
      return [...prev, { key: k, value: v }]
    })
    setNewKey('')
    setNewVal('')
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface2)', padding: '12px 16px', fontSize: '.82rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '.72rem', letterSpacing: '.5px', color: 'var(--dim)' }}>
          {env.toUpperCase()} ENV VARS
        </span>
        <button className="btn btn-xs" onClick={onClose}>close</button>
      </div>

      {warnings.map((w, i) => (
        <div key={i} style={{ color: 'var(--yellow)', fontSize: '.78rem', marginBottom: 6 }}>{w}</div>
      ))}

      {loading ? (
        <div style={{ color: 'var(--dim)', padding: '8px 0' }}>Loading…</div>
      ) : (
        <table style={{ marginBottom: 10, fontSize: '.8rem' }}>
          <thead>
            <tr>
              <th style={{ width: '35%' }}>Key</th>
              <th>Value</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {vars.map(v => (
              <tr key={v.key}>
                <td style={{ fontFamily: 'monospace' }}>{v.key}</td>
                <td>
                  <input
                    type="text"
                    defaultValue={v.value}
                    style={{ width: '100%', padding: '3px 7px', fontSize: '.8rem' }}
                    onBlur={e => saveVar(v.key, e.target.value)}
                  />
                </td>
                <td>
                  <button className="btn btn-xs btn-red" onClick={() => deleteVar(v.key)}>del</button>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input
                  type="text"
                  placeholder="KEY"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  style={{ width: '100%', padding: '3px 7px', fontSize: '.8rem' }}
                />
              </td>
              <td>
                <input
                  type="text"
                  placeholder="value"
                  value={newVal}
                  onChange={e => setNewVal(e.target.value)}
                  style={{ width: '100%', padding: '3px 7px', fontSize: '.8rem' }}
                  onKeyDown={e => { if (e.key === 'Enter') addVar() }}
                />
              </td>
              <td>
                <button className="btn btn-xs btn-accent" onClick={addVar}>Add</button>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

function MetricsBar({ cpu, memory }: { cpu: string; memory: number }) {
  const cpuNum = parseFloat(cpu) || 0
  const memMb = memory || 0

  return (
    <div className="env-metrics">
      <div className="res-row">
        <span className="res-lbl">CPU</span>
        <div className="res-bar">
          <div className="res-fill" style={{ width: `${Math.min(cpuNum, 100)}%`, background: barColor(cpuNum) }} />
        </div>
        <span className="res-val">{cpu}</span>
      </div>
      <div className="res-row">
        <span className="res-lbl">RAM</span>
        <div className="res-bar">
          <div className="res-fill" style={{ width: `${Math.min((memMb / 512) * 100, 100)}%`, background: 'var(--accent)' }} />
        </div>
        <span className="res-val">{memMb}MB</span>
      </div>
    </div>
  )
}

function AppCard({
  app,
  isErrored,
  metrics,
  onDelete,
  onOpenFrame,
  onOpenPrompt,
}: {
  app: App
  isErrored?: boolean
  metrics: Record<string, Record<string, { cpu: string; memory: number }>>
  onDelete: (slug: string) => void
  onOpenFrame: (slug: string, name: string, url: string) => void
  onOpenPrompt: (slug: string, name: string) => void
}) {
  const [envPanels, setEnvPanels] = useState<Record<string, EnvPanel | null>>({})
  const [visibility, setVisibility] = useState(app.visibility ?? 'private')

  function toggleEnvPanel(env: string) {
    setEnvPanels(prev => {
      const key = `${app.slug}_${env}`
      if (prev[key]) return { ...prev, [key]: null }
      return { ...prev, [key]: { env, vars: [], warnings: [] } }
    })
  }

  function changeVisibility(val: string) {
    setVisibility(val)
    adminApi.put(`/api/apps/${app.slug}`, { visibility: val }).catch(() => {})
  }

  async function handleDelete() {
    if (!confirm(`Delete app "${app.name}"?`)) return
    if (!confirm(`This is permanent. Delete "${app.name}" and all its data?`)) return
    await adminApi.del(`/api/apps/${app.slug}?confirm=true`).catch(() => {})
    onDelete(app.slug)
  }

  const prodStatus = app.production?.deploy?.status
  const sandStatus = app.sandbox?.deploy?.status
  const prodHealth = app.production?.health?.status
  const sandHealth = app.sandbox?.health?.status
  const prodVer = app.production?.deploy?.version
  const sandVer = app.sandbox?.deploy?.version
  const prodUrl = app.urls?.production
  const sandUrl = app.urls?.sandbox

  const prodMetrics = metrics[app.slug]?.['production']
  const sandMetrics = metrics[app.slug]?.['sandbox']

  const prodPanelKey = `${app.slug}_production`
  const sandPanelKey = `${app.slug}_sandbox`

  return (
    <div className={`app-row${isErrored ? ' errored' : ''}`}>
      <div className="row-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AppIcon
            slug={app.slug}
            name={app.name}
            onClick={() => {
              const url = prodUrl || sandUrl
              if (url) onOpenFrame(app.slug, app.name, url)
            }}
          />
          <div>
            <div className="app-name">{app.name}</div>
            {app.description && (
              <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: 2 }}>{app.description}</div>
            )}
            {app.users && app.users.length > 0 && (
              <div className="users-tags" style={{ marginTop: 4 }}>
                {app.users.map(u => (
                  <span key={u.id} className="tag">{u.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            value={visibility}
            onChange={e => changeVisibility(e.target.value)}
            style={{ fontSize: '.75rem', padding: '3px 8px' }}
          >
            <option value="public">public</option>
            <option value="private">private</option>
            <option value="hidden">hidden</option>
          </select>
          <button className="btn btn-sm" onClick={() => onOpenPrompt(app.slug, app.name)}>
            Onboard Prompt
          </button>
          <button className="btn btn-sm btn-red" onClick={handleDelete}>Delete</button>
        </div>
      </div>

      <div className="row-envs">
        <div className="env-half">
          <span className={healthDotClass(prodHealth)} />
          <span className="env-label prod">
            {prodUrl ? <a href={prodUrl} target="_blank" rel="noreferrer">PROD</a> : 'PROD'}
          </span>
          <div className="env-info">
            <span className="ver" id={`ver_${app.slug}_production`}>{prodVer ?? '—'}</span>
            <span>{prodHealth ?? 'unknown'}</span>
            <span className={deployBadgeClass(prodStatus)}>{prodStatus ?? 'idle'}</span>
            <button onClick={() => toggleEnvPanel('production')}>env</button>
            <a href={`/applications#${app.slug}`}>manage</a>
          </div>
          {prodMetrics && (
            <MetricsBar cpu={prodMetrics.cpu} memory={prodMetrics.memory} />
          )}
        </div>

        <div className="env-half">
          <span className={healthDotClass(sandHealth)} />
          <span className="env-label sand">
            {sandUrl ? <a href={sandUrl} target="_blank" rel="noreferrer">SAND</a> : 'SAND'}
          </span>
          <div className="env-info">
            <span className="ver" id={`ver_${app.slug}_sandbox`}>{sandVer ?? '—'}</span>
            <span>{sandHealth ?? 'unknown'}</span>
            <span className={deployBadgeClass(sandStatus)}>{sandStatus ?? 'idle'}</span>
            <button onClick={() => toggleEnvPanel('sandbox')}>env</button>
            <a href={`/applications#${app.slug}`}>manage</a>
          </div>
          {sandMetrics && (
            <MetricsBar cpu={sandMetrics.cpu} memory={sandMetrics.memory} />
          )}
        </div>
      </div>

      {envPanels[prodPanelKey] && (
        <EnvVarsPanel
          slug={app.slug}
          env="production"
          onClose={() => setEnvPanels(prev => ({ ...prev, [prodPanelKey]: null }))}
        />
      )}
      {envPanels[sandPanelKey] && (
        <EnvVarsPanel
          slug={app.slug}
          env="sandbox"
          onClose={() => setEnvPanels(prev => ({ ...prev, [sandPanelKey]: null }))}
        />
      )}
    </div>
  )
}

function FrameOverlay({
  modal,
  onClose,
  onEnhancement,
}: {
  modal: FrameModal
  onClose: () => void
  onEnhancement: (slug: string, name: string) => void
}) {
  return (
    <div className="app-frame-overlay">
      <div className="app-frame-topbar">
        <span style={{ fontWeight: 700 }}>{modal.name}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href={modal.url} target="_blank" rel="noreferrer" className="btn btn-sm">Open in tab</a>
          <button className="btn btn-sm btn-accent" onClick={() => onEnhancement(modal.slug, modal.name)}>
            Request Enhancement
          </button>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <iframe src={modal.url} className="app-frame-iframe" title={modal.name} />
    </div>
  )
}

function EnhancementModal({
  modal,
  onClose,
}: {
  modal: EnhModal
  onClose: () => void
}) {
  const [msg, setMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  async function submit() {
    if (!msg.trim()) return
    setSubmitting(true)
    await adminApi.post('/api/enhancements', { message: msg, app_slug: modal.slug }).catch(() => {})
    setSubmitting(false)
    setDone(true)
    setTimeout(onClose, 1500)
  }

  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-modal" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 12 }}>Request Enhancement — {modal.name}</h3>
        {done ? (
          <div style={{ color: 'var(--green)' }}>Submitted!</div>
        ) : (
          <>
            <textarea
              rows={5}
              style={{ width: '100%', marginBottom: 12 }}
              placeholder="Describe the enhancement you need…"
              value={msg}
              onChange={e => setMsg(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-accent" disabled={submitting} onClick={submit}>
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PromptModal({ modal, onClose }: { modal: PromptModal; onClose: () => void }) {
  const apiKey = localStorage.getItem('cc_api_key') ?? ''
  const promptText = `You are an AI assistant integrated into the ${modal.name} application via AppCrane.

API Key: ${apiKey}

To deploy changes, use the AppCrane deploy API. Submit enhancement requests through the in-app feedback flow. Ensure all changes are tested in sandbox before promoting to production.`

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-modal" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 16 }}>Onboard Prompt — {modal.name}</h3>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginBottom: 6 }}>API Key</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{
              flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 5, padding: '6px 10px', fontSize: '.8rem', wordBreak: 'break-all',
            }}>
              {apiKey || '(no key stored)'}
            </code>
            <button className="btn btn-sm" onClick={() => copy(apiKey)}>Copy</button>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginBottom: 6 }}>Agent Prompt</div>
          <textarea
            readOnly
            rows={8}
            style={{ width: '100%', fontSize: '.78rem', fontFamily: 'monospace' }}
            value={promptText}
          />
          <div style={{ marginTop: 6, textAlign: 'right' }}>
            <button className="btn btn-sm" onClick={() => copy(promptText)}>Copy Prompt</button>
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

const ONBOARD_KEY = 'cc_onboard_dismissed'

export function Dashboard() {
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [apps, setApps] = useState<App[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [enhancements, setEnhancements] = useState<Enhancement[]>([])
  const [activity, setActivity] = useState<{ days: string[]; apps: ActivityApp[] }>({ days: [], apps: [] })
  const [metrics, setMetrics] = useState<Record<string, Record<string, { cpu: string; memory: number }>>>({})
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [onboardDismissed, setOnboardDismissed] = useState(!!localStorage.getItem(ONBOARD_KEY))

  const [frameModal, setFrameModal] = useState<FrameModal | null>(null)
  const [enhModal, setEnhModal] = useState<EnhModal | null>(null)
  const [promptModal, setPromptModal] = useState<PromptModal | null>(null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchMain = useCallback(async () => {
    try {
      const [h, appsRes, usersRes, enhRes, actRes] = await Promise.all([
        adminApi.get<ServerHealth>('/api/server/health'),
        adminApi.get<{ apps: App[] }>('/api/apps'),
        adminApi.get<{ users: User[] }>('/api/users'),
        adminApi.get<{ requests: Enhancement[] }>('/api/enhancements').catch(() => ({ requests: [] })),
        adminApi.get<{ days: string[]; apps: ActivityApp[] }>('/api/dashboard/app-activity').catch(() => ({ days: [], apps: [] })),
      ])
      setHealth(h)
      setApps(appsRes.apps ?? [])
      setUsers(usersRes.users ?? [])
      setEnhancements(enhRes.requests ?? [])
      setActivity(actRes)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSecondary = useCallback(() => {
    adminApi.get<AppMetrics>('/api/server/app-metrics')
      .then(d => setMetrics(d.metrics ?? {}))
      .catch(() => {})

    adminApi.get<UsageSummary>('/api/appstudio/usage/summary')
      .then(d => {
        if (d && (d.total_jobs !== undefined || d.succeeded !== undefined)) {
          setUsageSummary(d)
        }
      })
      .catch(() => {})
  }, [])

  const fetchLiveVersions = useCallback((appList: App[]) => {
    for (const app of appList) {
      for (const env of ['production', 'sandbox'] as const) {
        adminApi.get<{ version?: string }>(`/api/apps/${app.slug}/live-version/${env}`)
          .then(d => {
            if (!d.version) return
            const el = document.getElementById(`ver_${app.slug}_${env}`)
            if (el) {
              el.textContent = d.version
              el.style.color = 'var(--green)'
            }
          })
          .catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    fetchMain().then(() => {
      fetchSecondary()
    })

    intervalRef.current = setInterval(() => {
      fetchMain()
      fetchSecondary()
    }, 30000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchMain, fetchSecondary])

  useEffect(() => {
    if (apps.length > 0) fetchLiveVersions(apps)
  }, [apps, fetchLiveVersions])

  function dismissOnboard() {
    localStorage.setItem(ONBOARD_KEY, '1')
    setOnboardDismissed(true)
  }

  function handleDeleteApp(slug: string) {
    setApps(prev => prev.filter(a => a.slug !== slug))
  }

  if (loading) return <div id="loading">Loading dashboard…</div>
  if (error) return <div className="container" style={{ color: 'var(--red)', paddingTop: 40 }}>{error}</div>

  const s = health?.system
  const allApps = apps
  const prodLive = allApps.filter(a => {
    const st = a.production?.deploy?.status?.toLowerCase()
    return st === 'live' || st === 'deployed' || a.production?.health?.status?.toLowerCase() === 'healthy'
  }).length
  const sandLive = allApps.filter(a => {
    const st = a.sandbox?.deploy?.status?.toLowerCase()
    return st === 'live' || st === 'deployed' || a.sandbox?.health?.status?.toLowerCase() === 'healthy'
  }).length
  const totalUsers = users.length
  const totalEnhReqs = enhancements.length

  const onboardItems = [
    { label: 'AppCrane is running', done: true },
    { label: 'Create your first app', done: apps.length > 0, link: '/applications' },
    { label: 'Invite a team member', done: users.length > 1, link: '/users-page' },
    { label: 'Configure a health check', done: apps.some(a => (a.production?.health as any)?.config?.endpoint), link: '/applications' },
    { label: 'Set environment variables', done: false, hint: 'Open an app row and click "env" to set variables' },
  ]
  const allOnboardDone = onboardItems.every(i => i.done)
  const showOnboard = !onboardDismissed && !allOnboardDone

  const erroredApps = allApps.filter(a => {
    const ps = a.production?.deploy?.status?.toLowerCase()
    const ss = a.sandbox?.deploy?.status?.toLowerCase()
    return ps === 'failed' || ps === 'error' || ss === 'failed' || ss === 'error'
  })

  return (
    <div className="container">
      {showOnboard && (
        <div className="onboard-card">
          <div style={{ flex: 1 }}>
            <div className="onboard-hdr">
              <span className="onboard-title">Get started with AppCrane</span>
              <button className="onboard-dismiss" onClick={dismissOnboard}>×</button>
            </div>
            <div className="onboard-items">
              {onboardItems.map((item, i) => (
                <div key={i} className="onboard-item">
                  <div className={`onboard-check${item.done ? ' done' : ''}`}>
                    {item.done && '✓'}
                  </div>
                  <span className={`onboard-item-text${item.done ? ' done' : ''}`}>
                    {item.link && !item.done ? (
                      <a href={item.link} style={{ color: 'inherit', textDecoration: 'underline' }}>{item.label}</a>
                    ) : item.label}
                    {item.hint && !item.done && (
                      <span style={{ marginLeft: 8, color: 'var(--dim)', fontSize: '.78rem' }}>{item.hint}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <h2>Server</h2>
      <div className="grid">
        {s && (
          <>
            <div className="stat">
              <div className="label">CPU</div>
              <div className="value">{s.cpu.percent}%</div>
              <div className="sub">{s.cpu.count} cores</div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${s.cpu.percent}%`, background: barColor(s.cpu.percent) }} />
              </div>
            </div>
            <div className="stat">
              <div className="label">Memory</div>
              <div className="value">{s.memory_formatted.used}</div>
              <div className="sub">of {s.memory_formatted.total}</div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${s.memory.percent}%`, background: barColor(s.memory.percent) }} />
              </div>
            </div>
            <div className="stat">
              <div className="label">Disk</div>
              <div className="value">{s.disk_formatted.used}</div>
              <div className="sub">of {s.disk_formatted.total}</div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${s.disk.percent}%`, background: barColor(s.disk.percent) }} />
              </div>
            </div>
          </>
        )}
        <div className="stat">
          <div className="label">Production</div>
          <div className="value">{prodLive} live</div>
          <div className="sub">{allApps.length} total apps</div>
        </div>
        <div className="stat">
          <div className="label">Sandbox</div>
          <div className="value">{sandLive} live</div>
          <div className="sub">{allApps.length} total apps</div>
        </div>
        <div className="stat">
          <div className="label">Users</div>
          <div className="value">{totalUsers}</div>
          <div className="sub">registered accounts</div>
        </div>
        <a className="stat" href="/enhancements-page" style={{ cursor: 'pointer' }}>
          <div className="label">Enhancements</div>
          <div className="value">{totalEnhReqs}</div>
          <div className="sub">all time requests</div>
        </a>
      </div>

      {usageSummary && (
        <>
          <h2>App Creation</h2>
          <div className="grid">
            <div className="stat">
              <div className="label">Total Jobs</div>
              <div className="value">{usageSummary.total_jobs ?? 0}</div>
            </div>
            <div className="stat">
              <div className="label">Succeeded</div>
              <div className="value" style={{ color: 'var(--green)' }}>{usageSummary.succeeded ?? 0}</div>
            </div>
            <div className="stat">
              <div className="label">Failed</div>
              <div className="value" style={{ color: 'var(--red)' }}>{usageSummary.failed ?? 0}</div>
            </div>
            <div className="stat">
              <div className="label">Total Tokens</div>
              <div className="value">{(usageSummary.total_tokens ?? 0).toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Total Cost</div>
              <div className="value">${(usageSummary.total_cost ?? 0).toFixed(2)}</div>
            </div>
          </div>
        </>
      )}

      <h2>Visitors — Last 7 Days</h2>
      <div className="trend-box">
        {activity.apps.length > 0 && (
          <div className="trend-legend">
            {activity.apps.map((a, i) => (
              <span key={a.slug} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 2,
                  background: TREND_PALETTE[i % TREND_PALETTE.length], flexShrink: 0,
                }} />
                {a.name ?? a.slug}
              </span>
            ))}
          </div>
        )}
        <TrendChart days={activity.days} apps={activity.apps} />
      </div>

      {erroredApps.length > 0 && (
        <>
          <h2 style={{ color: 'var(--red)' }}>Apps with Issues</h2>
          {erroredApps.map(app => (
            <AppCard
              key={app.slug}
              app={app}
              isErrored
              metrics={metrics}
              onDelete={handleDeleteApp}
              onOpenFrame={(slug, name, url) => setFrameModal({ slug, name, url })}
              onOpenPrompt={(slug, name) => setPromptModal({ slug, name })}
            />
          ))}
        </>
      )}

      <h2>Applications</h2>
      {allApps.length === 0 ? (
        <div style={{ color: 'var(--dim)', padding: '16px 0', fontSize: '.9rem' }}>No apps yet</div>
      ) : (
        allApps.map(app => (
          <AppCard
            key={app.slug}
            app={app}
            metrics={metrics}
            onDelete={handleDeleteApp}
            onOpenFrame={(slug, name, url) => setFrameModal({ slug, name, url })}
            onOpenPrompt={(slug, name) => setPromptModal({ slug, name })}
          />
        ))
      )}

      {frameModal && (
        <FrameOverlay
          modal={frameModal}
          onClose={() => setFrameModal(null)}
          onEnhancement={(slug, name) => {
            setFrameModal(null)
            setEnhModal({ slug, name })
          }}
        />
      )}

      {enhModal && (
        <EnhancementModal modal={enhModal} onClose={() => setEnhModal(null)} />
      )}

      {promptModal && (
        <PromptModal modal={promptModal} onClose={() => setPromptModal(null)} />
      )}
    </div>
  )
}
