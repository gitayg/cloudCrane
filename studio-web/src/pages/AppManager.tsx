import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminApi } from '../adminApi'

const PAGE_CSS = `
.app-manager .breadcrumb{font-size:.78rem;color:var(--dim);padding:7px 24px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:5px;margin:-24px -24px 16px;}
.app-manager .breadcrumb a{color:var(--dim);text-decoration:none}
.app-manager .breadcrumb a:hover{color:var(--text)}
.app-manager .breadcrumb-sep{color:var(--dim)}
.app-manager .env-toggle{display:flex;gap:0;margin-bottom:16px}
.app-manager .env-btn{flex:1;padding:8px;text-align:center;cursor:pointer;font-weight:600;font-size:.85rem;border:1px solid var(--border);background:var(--surface)}
.app-manager .env-btn:first-child{border-radius:6px 0 0 6px}
.app-manager .env-btn:last-child{border-radius:0 6px 6px 0}
.app-manager .env-btn.active-prod{background:#22c55e22;border-color:#22c55e44;color:var(--green)}
.app-manager .env-btn.active-sand{background:#f9731622;border-color:#f9731644;color:var(--orange)}
.app-manager .am-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
.app-manager .am-card h3{font-size:.9rem;margin-bottom:8px;color:var(--text)}
.app-manager .am-h2{font-size:1rem;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px;font-weight:500}
.app-manager .deploy-pipeline{display:flex;align-items:stretch;margin:10px 0;border-radius:6px;overflow:hidden;border:1px solid var(--border)}
.app-manager .dp-step{display:flex;align-items:center;gap:5px;padding:6px 10px;flex:1;font-size:.73rem;font-weight:600;color:var(--dim);background:var(--surface2);border-right:1px solid var(--border)}
.app-manager .dp-step:last-child{border-right:none}
.app-manager .dp-step.dp-done{background:#22c55e0d;color:var(--green)}
.app-manager .dp-step.dp-active{background:#3b82f60d;color:var(--accent)}
.app-manager .dp-step.dp-fail{background:#ef44440d;color:var(--red)}
.app-manager .dp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.app-manager .dp-step.dp-active .dp-dot{animation:dp-pulse 1s infinite}
@keyframes dp-pulse{0%,100%{opacity:1}50%{opacity:.2}}
.app-manager .add-row{display:flex;gap:8px;margin-top:8px}
.app-manager .add-row input{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:4px;font-size:.85rem;font-family:'SF Mono',Monaco,monospace}
.app-manager .am-msg{padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:.85rem}
.app-manager .msg-ok{background:#22c55e18;border:1px solid #22c55e44;color:var(--green)}
.app-manager .msg-err{background:#ef444418;border:1px solid #ef444444;color:var(--red)}
.app-manager .timeline{margin-top:0}
.app-manager .tl-item{display:flex}
.app-manager .tl-rail{display:flex;flex-direction:column;align-items:center;width:24px;flex-shrink:0;padding-top:3px}
.app-manager .tl-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.app-manager .tl-dot-green{background:var(--green)}
.app-manager .tl-dot-red{background:var(--red)}
.app-manager .tl-dot-yellow{background:var(--yellow)}
.app-manager .tl-dot-gray{background:var(--dim)}
.app-manager .tl-line{width:2px;flex:1;background:var(--border);margin:4px 0;min-height:14px}
.app-manager .tl-body{flex:1;padding:0 0 14px 10px;min-width:0}
.app-manager .tl-hdr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:3px 7px;border-radius:6px}
.app-manager .tl-hdr:hover{background:#ffffff08}
.app-manager .tl-ver{font-weight:700;font-size:.85rem}
.app-manager .tl-hash{font-family:'SF Mono',Monaco,monospace;font-size:.75rem;color:var(--dim)}
.app-manager .tl-by{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:700;flex-shrink:0;color:#fff}
.app-manager .tl-dur{font-size:.72rem;color:var(--dim);background:#ffffff09;border:1px solid var(--border);border-radius:4px;padding:1px 5px}
.app-manager .tl-time{font-size:.72rem;color:var(--dim);margin-left:auto}
.app-manager .tl-log-btn{font-size:.72rem;padding:2px 7px;background:none;border:1px solid var(--border);color:var(--dim);border-radius:4px;cursor:pointer;font-family:inherit}
.app-manager .tl-log-btn:hover{border-color:var(--accent);color:var(--accent)}
.app-manager .log-drawer{position:fixed;bottom:0;left:0;right:0;height:42vh;background:var(--surface);border-top:2px solid var(--border);display:flex;flex-direction:column;z-index:50;transform:translateY(100%);transition:transform .22s ease}
.app-manager .log-drawer.open{transform:translateY(0)}
.app-manager .log-drawer-hdr{display:flex;align-items:center;gap:6px;padding:7px 14px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.app-manager .log-tab{background:none;border:none;color:var(--dim);font-size:.8rem;cursor:pointer;padding:3px 10px;border-radius:4px;font-family:inherit}
.app-manager .log-tab.active{background:var(--surface2);color:var(--text)}
.app-manager .log-filter-input{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;font-size:.78rem;width:150px;font-family:inherit;outline:none}
.app-manager .log-filter-input::placeholder{color:var(--dim)}
.app-manager .log-lvl-btn{background:none;border:1px solid var(--border);color:var(--dim);font-size:.7rem;padding:2px 7px;border-radius:4px;cursor:pointer;font-family:inherit}
.app-manager .log-lvl-btn.lvl-on-err{border-color:var(--red);color:var(--red);background:#ef444414}
.app-manager .log-lvl-btn.lvl-on-warn{border-color:var(--yellow);color:var(--yellow);background:#eab30814}
.app-manager .log-lvl-btn.lvl-on-info{border-color:var(--accent);color:var(--accent);background:#3b82f614}
.app-manager .log-close{margin-left:auto;background:none;border:none;color:var(--dim);cursor:pointer;font-size:1.1rem;line-height:1;padding:0 4px}
.app-manager .log-content{flex:1;overflow-y:auto;padding:10px 16px;font-family:'SF Mono',Monaco,monospace;font-size:.73rem;line-height:1.6;white-space:pre-wrap;word-break:break-all}
.app-manager .log-err{color:var(--red)}
.app-manager .log-warn{color:var(--yellow)}
.app-manager .log-info{color:var(--accent)}
.app-manager .log-dim-line{display:none!important}
.app-manager .metric-row{display:flex;gap:20px;flex-wrap:wrap}
.app-manager .metric-stat{display:flex;flex-direction:column;gap:1px}
.app-manager .metric-label{font-size:.68rem;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
.app-manager .metric-value{font-weight:600;font-size:.9rem}
.app-manager .metric-bar-wrap{background:var(--surface2);border-radius:3px;height:4px;width:80px;margin-top:3px}
.app-manager .metric-bar{height:4px;border-radius:3px;background:var(--accent);transition:width .4s}
.app-manager .am-mono{font-family:'SF Mono',Monaco,monospace;font-size:.8rem}
.app-manager .am-input{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:6px;font-size:.88rem}
.app-manager .am-input-num{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:.88rem}
.app-manager .update-banner{margin-top:8px;padding:8px 12px;background:rgba(250,204,21,.08);border:1px solid var(--yellow);border-radius:6px;font-size:.85rem;display:flex;align-items:center;justify-content:space-between;gap:8px}
.app-manager .update-banner .ub-text{color:var(--yellow)}
.app-manager .env-redeploy-banner{background:#eab30820;border:1px solid #eab30860;border-radius:8px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.app-manager .env-redeploy-banner span{color:var(--yellow);font-size:.85rem;flex:1}
`

interface MeApp { slug: string; name: string }
interface Me { user: { role: string }; apps: MeApp[] }

interface HealthState { is_down?: boolean; last_status?: number; last_response_ms?: number; last_check_at?: string }
interface HealthConfig { endpoint?: string }
interface HealthResp { state?: HealthState; config?: HealthConfig }

interface Deployment {
  id: string | number
  status: string
  version?: string
  commit_hash?: string
  started_at?: string
  finished_at?: string
  deployed_by_name?: string
  log?: string
}
interface DeploymentsResp { deployments?: Deployment[] }

interface UpdatesResp {
  latest_message?: string
  latest_sha?: string
  production?: { update_available?: boolean }
  sandbox?: { update_available?: boolean }
}

interface EnvVar { key: string; value: string }
interface EnvResp { vars?: EnvVar[]; warnings?: string[] }

interface ProcessInfo {
  status?: string
  cpu?: number
  memory?: number
  uptime?: number
  restarts?: number
}
interface MetricsResp { process?: ProcessInfo }

interface AppData {
  app: {
    slug?: string
    name?: string
    description?: string
    resource_limits?: { max_ram_mb?: number; max_cpu_percent?: number }
  }
}

interface RuntimeLogsResp { logs?: string[] }
interface BuildLogResp { log?: string }

type EnvName = 'production' | 'sandbox'
type LogTab = 'runtime' | 'build'

const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#eab308']

function fmtBytes(b?: number) {
  if (!b) return '0 MB'
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB'
  return (b / 1048576).toFixed(0) + ' MB'
}

function fmtUptime(ms?: number) {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d) return d + 'd ' + (h % 24) + 'h'
  if (h) return h + 'h ' + (m % 60) + 'm'
  if (m) return m + 'm'
  return s + 's'
}

function fmtDur(s?: string, f?: string) {
  if (!s || !f) return ''
  const sec = Math.round((new Date(f).getTime() - new Date(s).getTime()) / 1000)
  if (sec < 60) return sec + 's'
  return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
}

function relTime(iso?: string) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

function initials(name?: string) {
  if (!name) return '?'
  const p = name.trim().split(/\s+/)
  return p.length === 1 ? p[0].slice(0, 2).toUpperCase() : (p[0][0] + p[p.length - 1][0]).toUpperCase()
}

function avatarColor(name?: string) {
  let h = 0
  const n = name || ''
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) & 0xffffffff
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

interface MsgState { text: string; ok: boolean }

interface HealthCardProps {
  slug: string
  env: EnvName
  reload: number
  onMsg: (m: MsgState) => void
}

function HealthCard({ slug, env, reload, onMsg }: HealthCardProps) {
  const [health, setHealth] = useState<HealthResp | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    adminApi.get<HealthResp>(`/api/apps/${slug}/health/${env}`)
      .then(h => { if (!cancelled) setHealth(h) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [slug, env, reload])

  async function testNow() {
    onMsg({ text: 'Testing health...', ok: true })
    try {
      const data = await adminApi.post<{ healthy?: boolean; status?: number | string; response_ms?: number; error?: string }>(`/api/apps/${slug}/health/${env}/test`)
      if (data.healthy) onMsg({ text: `Healthy: ${data.status} (${data.response_ms}ms)`, ok: true })
      else onMsg({ text: `Failed: ${data.error || data.status}`, ok: false })
      const fresh = await adminApi.get<HealthResp>(`/api/apps/${slug}/health/${env}`)
      setHealth(fresh)
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  let dotColor = 'var(--dim)'
  let statusText = 'Unknown'
  const s = health?.state
  const c = health?.config
  if (s?.is_down) { dotColor = 'var(--red)'; statusText = 'DOWN' }
  else if (s?.last_status === 200) { dotColor = 'var(--green)'; statusText = 'Healthy' }

  let healthText = statusText
  if (s?.last_response_ms) healthText += ` (${s.last_response_ms}ms)`
  if (c?.endpoint) healthText += ` — ${c.endpoint}`
  if (s?.last_check_at) healthText += ` — last: ${s.last_check_at}`

  return (
    <div className="am-card">
      <h3>Health</h3>
      <div>
        {error ? 'Error loading health' : (
          <>
            <span className="dot" style={{ background: dotColor }} />
            {healthText}
          </>
        )}
      </div>
      <button className="btn btn-sm btn-dim" onClick={testNow} style={{ marginTop: 8 }}>Test Now</button>
    </div>
  )
}

interface MetricsCardProps {
  slug: string
  env: EnvName
}

function MetricsCard({ slug, env }: MetricsCardProps) {
  const [metrics, setMetrics] = useState<ProcessInfo | null>(null)
  const [hidden, setHidden] = useState(true)

  const fetchMetrics = useCallback(async () => {
    try {
      const d = await adminApi.get<MetricsResp>(`/api/apps/${slug}/metrics/${env}`)
      const p = d.process || {}
      if (!p || p.status === 'stopped' || p.status === 'unknown' || !p.status) {
        setHidden(true)
        return
      }
      setMetrics(p)
      setHidden(false)
    } catch {
      setHidden(true)
    }
  }, [slug, env])

  useEffect(() => {
    setHidden(true)
    setMetrics(null)
    fetchMetrics()
    const id = setInterval(fetchMetrics, 10000)
    return () => clearInterval(id)
  }, [fetchMetrics])

  if (hidden || !metrics) return null

  const stats = [
    { label: 'CPU', value: (metrics.cpu || 0).toFixed(1) + '%', bar: Math.min(metrics.cpu || 0, 100) as number | null },
    { label: 'Memory', value: fmtBytes(metrics.memory), bar: null as number | null },
    { label: 'Uptime', value: fmtUptime(metrics.uptime), bar: null as number | null },
    { label: 'Restarts', value: String(metrics.restarts || 0), bar: null as number | null },
  ]

  return (
    <div className="am-card">
      <h3 style={{ marginBottom: 10 }}>
        Resources <span style={{ fontSize: '.72rem', fontWeight: 400, color: 'var(--dim)', marginLeft: 6 }}>· {metrics.status || ''}</span>
      </h3>
      <div className="metric-row">
        {stats.map(s => (
          <div className="metric-stat" key={s.label}>
            <div className="metric-label">{s.label}</div>
            <div className="metric-value">{s.value}</div>
            {s.bar !== null && (
              <div className="metric-bar-wrap">
                <div className="metric-bar" style={{ width: s.bar + '%' }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

interface LimitsCardProps {
  slug: string
  reload: number
  onMsg: (m: MsgState) => void
}

function LimitsCard({ slug, reload, onMsg }: LimitsCardProps) {
  const [ram, setRam] = useState(512)
  const [cpu, setCpu] = useState(50)

  useEffect(() => {
    let cancelled = false
    adminApi.get<AppData>(`/api/apps/${slug}`)
      .then(d => {
        if (cancelled) return
        const rl = d.app.resource_limits || {}
        setRam(rl.max_ram_mb || 512)
        setCpu(rl.max_cpu_percent || 50)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [slug, reload])

  async function save() {
    if (ram < 128 || cpu < 5) { onMsg({ text: 'Invalid limits', ok: false }); return }
    try {
      await adminApi.put(`/api/apps/${slug}`, { resource_limits: { max_ram_mb: ram, max_cpu_percent: cpu } })
      onMsg({ text: 'Resource limits saved. Redeploy to apply.', ok: true })
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  return (
    <div className="am-card">
      <h3 style={{ marginBottom: 10 }}>Resource Limits</h3>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: 4 }}>RAM (MB)</label>
          <input
            type="number"
            min={128}
            max={8192}
            step={128}
            value={ram}
            onChange={e => setRam(parseInt(e.target.value, 10) || 0)}
            className="am-input-num"
            style={{ width: 100 }}
          />
        </div>
        <div>
          <label style={{ fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: 4 }}>CPU (%)</label>
          <input
            type="number"
            min={5}
            max={400}
            step={5}
            value={cpu}
            onChange={e => setCpu(parseInt(e.target.value, 10) || 0)}
            className="am-input-num"
            style={{ width: 80 }}
          />
        </div>
        <button className="btn btn-sm" onClick={save}>Save &amp; Redeploy</button>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: 6 }}>Changes take effect on next deploy.</div>
    </div>
  )
}

interface DeployCardProps {
  slug: string
  env: EnvName
  reload: number
  onDeploy: () => void
  onPromote: () => void
  onRollback: () => void
}

function DeployCard({ slug, env, reload, onDeploy, onPromote, onRollback }: DeployCardProps) {
  const [latest, setLatest] = useState<Deployment | null | undefined>(undefined)
  const [updates, setUpdates] = useState<UpdatesResp | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    setLatest(undefined)
    setUpdates(null)
    adminApi.get<DeploymentsResp>(`/api/apps/${slug}/deployments/${env}`)
      .then(d => {
        if (cancelled) return
        setLatest(d.deployments?.[0] ?? null)
      })
      .catch(() => { if (!cancelled) setError(true) })
    adminApi.get<UpdatesResp>(`/api/apps/${slug}/updates`)
      .then(u => { if (!cancelled) setUpdates(u) })
      .catch(() => {})
  }, [slug, env, reload])

  function pipeline(latest: Deployment) {
    if (latest.status !== 'building') return null
    const log = latest.log || ''
    const stepDefs = [
      { label: 'Pull', done: /cloned|pulling|fetched/i.test(log), active: false },
      { label: 'Build', done: /built|build complete/i.test(log), active: /building|docker build/i.test(log) || true },
      { label: 'Health', done: /health.*pass|healthy/i.test(log), active: /health check/i.test(log) },
      { label: 'Live', done: false, active: false },
    ]
    const firstActive = stepDefs.findIndex(s => !s.done)
    stepDefs.forEach((s, i) => { if (i === firstActive) s.active = true })
    return (
      <div className="deploy-pipeline">
        {stepDefs.map(s => (
          <div key={s.label} className={'dp-step' + (s.done ? ' dp-done' : s.active ? ' dp-active' : '')}>
            <div className="dp-dot" />
            {s.label}
          </div>
        ))}
      </div>
    )
  }

  let updMsg = ''
  if (updates && updates[env]?.update_available) {
    let m = updates.latest_message || updates.latest_sha || ''
    if (m.length > 50) m = m.slice(0, 50) + '…'
    updMsg = m
  }

  return (
    <div className="am-card">
      <h3>Deployment</h3>
      <div>
        {error ? 'Error loading deploys' : latest === undefined ? 'Loading...' : !latest ? 'No deployments yet' : (
          <>
            <span className={'badge ' + (latest.status === 'live' ? 'badge-live' : latest.status === 'failed' ? 'badge-failed' : 'badge-building')}>
              {latest.status}
            </span>
            {' v' + (latest.version || '-')}
            {latest.commit_hash && <span className="am-mono"> {latest.commit_hash}</span>}
            {' — ' + (latest.finished_at || latest.started_at || '')}
          </>
        )}
      </div>
      {latest && pipeline(latest)}
      {updMsg && updates && (
        <div className="update-banner">
          <span className="ub-text">⬆ Update available: {updMsg} ({updates.latest_sha})</span>
          <button className="btn btn-sm btn-green" onClick={onDeploy}>Deploy Now</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn btn-sm btn-green" onClick={onDeploy}>Deploy</button>
        <button className="btn btn-sm btn-orange" onClick={onPromote}>Promote Sandbox → Prod</button>
        <button className="btn btn-sm btn-red" onClick={onRollback}>Rollback</button>
      </div>
    </div>
  )
}

interface EnvVarsCardProps {
  slug: string
  env: EnvName
  reload: number
  onMsg: (m: MsgState) => void
  onDeploy: () => void
  onChanged: () => void
}

function EnvVarsCard({ slug, env, reload, onMsg, onDeploy, onChanged }: EnvVarsCardProps) {
  const [data, setData] = useState<EnvResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showBanner, setShowBanner] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const load = useCallback(() => {
    setError(null)
    adminApi.get<EnvResp>(`/api/apps/${slug}/env/${env}?reveal=true`)
      .then(d => setData(d))
      .catch(e => setError((e as Error).message || 'Cannot load env vars'))
  }, [slug, env])

  useEffect(() => {
    setShowBanner(false)
    load()
  }, [load, reload])

  async function addVar() {
    const k = newKey.trim()
    if (!k) return
    try {
      const data = await adminApi.put<{ message?: string }>(`/api/apps/${slug}/env/${env}`, { vars: { [k]: newVal } })
      onMsg({ text: data.message || 'Added', ok: true })
      setNewKey(''); setNewVal('')
      setShowBanner(true)
      onChanged()
      load()
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  async function delVar(k: string) {
    if (!confirm('Delete ' + k + '?')) return
    try {
      await adminApi.del(`/api/apps/${slug}/env/${env}/${k}`)
      onMsg({ text: 'Deleted ' + k, ok: true })
      setShowBanner(true)
      onChanged()
      load()
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  return (
    <>
      <h2 className="am-h2">Environment Variables</h2>
      {showBanner && (
        <div className="env-redeploy-banner">
          <span>⚠ Env var changes won't take effect until the app is redeployed.</span>
          <button className="btn btn-sm" style={{ background: 'var(--yellow)', color: '#000', fontWeight: 700 }} onClick={onDeploy}>Redeploy Now</button>
        </div>
      )}
      <div className="am-card">
        <div>
          {error ? (
            <span style={{ color: 'var(--red)' }}>{error}</span>
          ) : !data ? 'Loading...' : !data.vars?.length ? (
            <span style={{ color: 'var(--dim)' }}>No env vars set</span>
          ) : (
            <>
              <table>
                <thead>
                  <tr><th>Key</th><th>Value</th><th></th></tr>
                </thead>
                <tbody>
                  {data.vars.map(v => (
                    <tr key={v.key}>
                      <td className="am-mono">{v.key}</td>
                      <td className="am-mono">{v.value}</td>
                      <td>
                        <button className="btn btn-sm btn-red" onClick={() => delVar(v.key)}>Del</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.warnings?.map((w, i) => (
                <div key={i} style={{ color: 'var(--yellow)', fontSize: '.8rem', marginTop: 6 }}>⚠ {w}</div>
              ))}
            </>
          )}
        </div>
        <div className="add-row">
          <input type="text" placeholder="KEY" value={newKey} onChange={e => setNewKey(e.target.value)} style={{ flex: 1 }} />
          <input type="text" placeholder="value" value={newVal} onChange={e => setNewVal(e.target.value)} style={{ flex: 2 }} />
          <button className="btn btn-sm" onClick={addVar}>Add</button>
        </div>
      </div>
    </>
  )
}

interface DeployHistoryCardProps {
  slug: string
  env: EnvName
  reload: number
  onOpenLogs: (deployId: string | number) => void
  onOpenRuntime: () => void
}

function DeployHistoryCard({ slug, env, reload, onOpenLogs, onOpenRuntime }: DeployHistoryCardProps) {
  const [deps, setDeps] = useState<Deployment[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    setDeps(null)
    adminApi.get<DeploymentsResp>(`/api/apps/${slug}/deployments/${env}`)
      .then(d => { if (!cancelled) setDeps(d.deployments ?? []) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [slug, env, reload])

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 12px' }}>
        <span style={{ fontSize: '1rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 500 }}>Deploy History</span>
        <button className="btn btn-sm btn-dim" onClick={onOpenRuntime} style={{ fontSize: '.78rem' }}>Live Logs</button>
      </div>
      <div className="am-card">
        {error ? 'Error' : deps === null ? 'Loading...' : !deps.length ? (
          <span style={{ color: 'var(--dim)' }}>No deployments</span>
        ) : (
          <div className="timeline">
            {deps.map((dep, i) => {
              const dotCls = dep.status === 'live' ? 'tl-dot-green' : dep.status === 'failed' ? 'tl-dot-red' : 'tl-dot-yellow'
              const badgeCls = dep.status === 'live' ? 'badge-live' : dep.status === 'failed' ? 'badge-failed' : 'badge-building'
              const dur = fmtDur(dep.started_at, dep.finished_at)
              const rt = relTime(dep.finished_at || dep.started_at)
              return (
                <div className="tl-item" key={String(dep.id) + '_' + i}>
                  <div className="tl-rail">
                    <div className={'tl-dot ' + dotCls} />
                    {i < deps.length - 1 && <div className="tl-line" />}
                  </div>
                  <div className="tl-body">
                    <div className="tl-hdr">
                      <span className="tl-ver">v{dep.version || '-'}</span>
                      <span className={'badge ' + badgeCls}>{dep.status}</span>
                      {dep.commit_hash && <span className="tl-hash">{dep.commit_hash.slice(0, 7)}</span>}
                      {dep.deployed_by_name && (
                        <div className="tl-by" style={{ background: avatarColor(dep.deployed_by_name) }} title={dep.deployed_by_name}>
                          {initials(dep.deployed_by_name)}
                        </div>
                      )}
                      {dur && <span className="tl-dur">{dur}</span>}
                      <span className="tl-time" title={dep.finished_at || dep.started_at || ''}>{rt}</span>
                      <button className="tl-log-btn" onClick={() => onOpenLogs(dep.id)}>Logs ▸</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

interface AppInfoCardProps {
  slug: string
  reload: number
  onMsg: (m: MsgState) => void
  onRenamed: (newSlug: string) => void
}

function AppInfoCard({ slug, reload, onMsg, onRenamed }: AppInfoCardProps) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [slugInput, setSlugInput] = useState('')

  useEffect(() => {
    adminApi.get<AppData>(`/api/apps/${slug}`)
      .then(d => {
        setName(d.app.name || '')
        setDesc(d.app.description || '')
        setSlugInput(d.app.slug || '')
      })
      .catch(() => {})
  }, [slug, reload])

  async function save() {
    if (!name.trim()) { onMsg({ text: 'Name is required', ok: false }); return }
    try {
      await adminApi.put(`/api/apps/${slug}`, { name: name.trim(), description: desc.trim() || null })
      onMsg({ text: 'Saved', ok: true })
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  async function rename() {
    const newSlug = slugInput.trim()
    if (!newSlug) { onMsg({ text: 'Slug is required', ok: false }); return }
    if (newSlug === slug) { onMsg({ text: 'Slug unchanged', ok: false }); return }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(newSlug)) {
      onMsg({ text: 'Slug must be lowercase letters, numbers, and dashes', ok: false }); return
    }
    if (!confirm(`Rename /${slug} → /${newSlug}?\n\nThe old path will redirect to the new one. Both environments will be redeployed.`)) return
    onMsg({ text: 'Renaming...', ok: true })
    try {
      await adminApi.post(`/api/apps/${slug}/rename`, { new_slug: newSlug, redirect: true })
      onMsg({ text: `Renamed to /${newSlug}. Redeploying...`, ok: true })
      onRenamed(newSlug)
    } catch (e) {
      onMsg({ text: (e as Error).message, ok: false })
    }
  }

  return (
    <>
      <h2 className="am-h2">App Info</h2>
      <div className="am-card">
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: 5 }}>Display Name</label>
          <input type="text" className="am-input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: 5 }}>Description</label>
          <textarea
            rows={3}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '7px 10px', borderRadius: 6, width: '100%', fontSize: '.88rem', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>
        <button className="btn btn-sm" onClick={save}>Save</button>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '18px 0' }} />

        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: 5 }}>URL Slug (path)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              maxLength={48}
              value={slugInput}
              onChange={e => setSlugInput(e.target.value)}
              className="am-input"
              style={{ flex: 1, fontFamily: 'monospace' }}
            />
            <button className="btn btn-sm btn-dim" onClick={rename}>Rename</button>
          </div>
          <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: 5 }}>Renames the URL path. Old path redirects to new one. Triggers a redeploy.</div>
        </div>
      </div>
    </>
  )
}

interface LogDrawerProps {
  open: boolean
  slug: string
  env: EnvName
  tab: LogTab
  deployId: string | number | null
  onClose: () => void
  onTabChange: (t: LogTab) => void
}

function LogDrawer({ open, slug, env, tab, deployId, onClose, onTabChange }: LogDrawerProps) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [activeLevels, setActiveLevels] = useState<Set<string>>(new Set())
  const [lineCount, setLineCount] = useState('100')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchRuntime = useCallback(async () => {
    try {
      const d = await adminApi.get<RuntimeLogsResp>(`/api/apps/${slug}/logs/${env}?lines=${lineCount}`)
      setLines(d.logs || [])
      setError(null)
    } catch {
      setError('Error loading logs')
    }
  }, [slug, env, lineCount])

  const fetchBuild = useCallback(async (id: string | number) => {
    try {
      const d = await adminApi.get<BuildLogResp>(`/api/apps/${slug}/deployments/${env}/${id}/log`)
      setLines((d.log || '').split('\n'))
      setError(null)
    } catch {
      setError('Error loading log')
    }
  }, [slug, env])

  useEffect(() => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null }
    if (!open) {
      setLines([])
      return
    }
    setLoading(true)
    setError(null)
    setLines([])
    if (tab === 'runtime') {
      fetchRuntime().finally(() => setLoading(false))
      pollerRef.current = setInterval(fetchRuntime, 4000)
    } else if (tab === 'build' && deployId) {
      fetchBuild(deployId).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
    return () => {
      if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null }
    }
  }, [open, tab, deployId, fetchRuntime, fetchBuild])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [lines])

  function toggleLevel(lvl: string) {
    setActiveLevels(prev => {
      const next = new Set(prev)
      if (next.has(lvl)) next.delete(lvl)
      else next.add(lvl)
      return next
    })
  }

  const lvlClass = (lvl: string, on: boolean) => 'log-lvl-btn' + (on ? ' lvl-on-' + (lvl === 'error' ? 'err' : lvl === 'warn' ? 'warn' : 'info') : '')
  const kw = filter.toLowerCase()
  const anyLvl = activeLevels.size > 0

  return (
    <div className={'log-drawer' + (open ? ' open' : '')}>
      <div className="log-drawer-hdr">
        <div style={{ display: 'flex', gap: 2, marginRight: 6 }}>
          <button className={'log-tab' + (tab === 'runtime' ? ' active' : '')} onClick={() => onTabChange('runtime')}>Runtime Logs</button>
          <button className={'log-tab' + (tab === 'build' ? ' active' : '')} onClick={() => onTabChange('build')}>Build Log</button>
        </div>
        <input
          className="log-filter-input"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {tab === 'runtime' && (
          <select
            value={lineCount}
            onChange={e => setLineCount(e.target.value)}
            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--dim)', padding: '3px 6px', borderRadius: 4, fontSize: '.75rem', fontFamily: 'inherit' }}
          >
            <option value="100">100 lines</option>
            <option value="500">500 lines</option>
            <option value="1000">1000 lines</option>
          </select>
        )}
        <button className={lvlClass('error', activeLevels.has('error'))} onClick={() => toggleLevel('error')} title="Show only errors">Error</button>
        <button className={lvlClass('warn', activeLevels.has('warn'))} onClick={() => toggleLevel('warn')} title="Show only warnings">Warn</button>
        <button className={lvlClass('info', activeLevels.has('info'))} onClick={() => toggleLevel('info')} title="Show only info">Info</button>
        <button className="log-close" onClick={onClose} title="Close">×</button>
      </div>
      <div className="log-content" ref={contentRef}>
        {loading ? 'Loading…' : error ? <span style={{ color: 'var(--red)' }}>{error}</span> : tab === 'build' && !deployId ? (
          <span style={{ color: 'var(--dim)' }}>Click "Logs ▸" on a deploy to view its build log.</span>
        ) : (
          lines.map((line, i) => {
            const lower = (line || '').toLowerCase()
            const isErr = /error|exception|fatal|critical/i.test(line)
            const isWrn = /\bwarn/i.test(line)
            const isInf = /\binfo\b|started|listening|ready/i.test(line)
            const lvl = isErr ? 'error' : isWrn ? 'warn' : isInf ? 'info' : ''
            const cls = isErr ? 'log-err' : isWrn ? 'log-warn' : isInf ? 'log-info' : ''
            const hide = (kw && !lower.includes(kw)) || (anyLvl && lvl && !activeLevels.has(lvl))
            return (
              <div key={i} className={cls + (hide ? ' log-dim-line' : '')}>{line}</div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function AppManager() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlSlug = searchParams.get('slug') || ''

  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState(false)
  const [currentApp, setCurrentApp] = useState<string>('')
  const [currentEnv, setCurrentEnv] = useState<EnvName>('production')
  const [msg, setMsg] = useState<MsgState | null>(null)
  const [reloadCounter, setReloadCounter] = useState(0)

  const [logOpen, setLogOpen] = useState(false)
  const [logTab, setLogTab] = useState<LogTab>('runtime')
  const [logDeployId, setLogDeployId] = useState<string | number | null>(null)

  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showMsg = useCallback((m: MsgState) => {
    setMsg(m)
    if (msgTimer.current) clearTimeout(msgTimer.current)
    msgTimer.current = setTimeout(() => setMsg(null), 5000)
  }, [])

  useEffect(() => {
    return () => {
      if (msgTimer.current) clearTimeout(msgTimer.current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    adminApi.get<Me>('/api/auth/me')
      .then(m => { if (!cancelled) setMe(m) })
      .catch(() => { if (!cancelled) setMeError(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!me) return
    if (urlSlug) {
      setCurrentApp(urlSlug)
      try { localStorage.setItem('cc_current_app', urlSlug) } catch {}
      return
    }
    if (me.apps.length === 0) {
      showMsg({ text: 'No apps assigned to you. Ask an admin to assign you.', ok: false })
      return
    }
    if (me.apps.length === 1) {
      setCurrentApp(me.apps[0].slug)
      try { localStorage.setItem('cc_current_app', me.apps[0].slug) } catch {}
      return
    }
    const stored = (() => { try { return localStorage.getItem('cc_current_app') || '' } catch { return '' } })()
    if (stored && me.apps.find(a => a.slug === stored)) {
      setCurrentApp(stored)
    }
  }, [me, urlSlug, showMsg])

  // Close log drawer when env or app changes
  useEffect(() => {
    setLogOpen(false)
    setLogDeployId(null)
  }, [currentApp, currentEnv])

  const isAdminUser = me?.user.role === 'admin'

  function selectApp(slug: string) {
    setCurrentApp(slug)
    try { localStorage.setItem('cc_current_app', slug) } catch {}
    setSearchParams({ slug })
  }

  async function deploy() {
    if (!currentApp) return
    if (!confirm('Deploy ' + currentApp + ' to ' + currentEnv + '?')) return
    showMsg({ text: 'Deploying...', ok: true })
    try {
      const data = await adminApi.post<{ message?: string }>(`/api/apps/${currentApp}/deploy/${currentEnv}`)
      showMsg({ text: data.message || 'Deploy triggered', ok: true })
      setTimeout(() => setReloadCounter(c => c + 1), 3000)
    } catch (e) {
      showMsg({ text: (e as Error).message, ok: false })
    }
  }

  async function promote() {
    if (!currentApp) return
    if (!confirm('Promote sandbox code to production? (env vars and data stay separate)')) return
    try {
      const data = await adminApi.post<{ message?: string }>(`/api/apps/${currentApp}/promote`)
      showMsg({ text: data.message || 'Promoted', ok: true })
      setTimeout(() => setReloadCounter(c => c + 1), 3000)
    } catch (e) {
      showMsg({ text: (e as Error).message, ok: false })
    }
  }

  async function rollback() {
    if (!currentApp) return
    if (!confirm('Rollback ' + currentApp + ' ' + currentEnv + ' to previous version?')) return
    try {
      const data = await adminApi.post<{ message?: string }>(`/api/apps/${currentApp}/rollback/${currentEnv}`)
      showMsg({ text: data.message || 'Rolled back', ok: true })
      setTimeout(() => setReloadCounter(c => c + 1), 2000)
    } catch (e) {
      showMsg({ text: (e as Error).message, ok: false })
    }
  }

  function handleRenamed(newSlug: string) {
    setCurrentApp(newSlug)
    try { localStorage.setItem('cc_current_app', newSlug) } catch {}
    setSearchParams({ slug: newSlug })
    setTimeout(() => setReloadCounter(c => c + 1), 3000)
  }

  function openLogsForDeploy(id: string | number) {
    setLogDeployId(id)
    setLogTab('build')
    setLogOpen(true)
  }

  function openRuntimeLogs() {
    setLogTab('runtime')
    setLogOpen(true)
  }

  function closeLogDrawer() {
    setLogOpen(false)
  }

  // App selector if multiple apps and no slug picked
  const showSelector = !!me && !urlSlug && !currentApp && me.apps.length > 1
  const showMain = !!currentApp

  return (
    <div className="app-manager">
      <style>{PAGE_CSS}</style>

      {currentApp && (
        <nav className="breadcrumb">
          <a href="/applications">Apps</a>
          <span className="breadcrumb-sep">/</span>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{currentApp}</span>
          <span className="breadcrumb-sep">/</span>
          <span style={{ color: 'var(--text)' }}>{currentEnv === 'production' ? 'Production' : 'Sandbox'}</span>
        </nav>
      )}

      <div className="container">
        {meError && (
          <div className="am-msg msg-err">Unable to load user info. Please log in.</div>
        )}

        {showSelector && (
          <div className="am-card" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
            <h3>Select App</h3>
            <select
              className="am-input"
              style={{ width: '100%', marginTop: 10 }}
              defaultValue=""
              onChange={e => { if (e.target.value) selectApp(e.target.value) }}
            >
              <option value="" disabled>Choose an app…</option>
              {me!.apps.map(a => (
                <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>
              ))}
            </select>
          </div>
        )}

        {msg && (
          <div className={'am-msg ' + (msg.ok ? 'msg-ok' : 'msg-err')}>{msg.text}</div>
        )}

        {showMain && (
          <>
            <div className="env-toggle">
              <div
                className={'env-btn' + (currentEnv === 'production' ? ' active-prod' : '')}
                onClick={() => setCurrentEnv('production')}
              >Production</div>
              <div
                className={'env-btn' + (currentEnv === 'sandbox' ? ' active-sand' : '')}
                onClick={() => setCurrentEnv('sandbox')}
              >Sandbox</div>
            </div>

            <HealthCard slug={currentApp} env={currentEnv} reload={reloadCounter} onMsg={showMsg} />
            <MetricsCard slug={currentApp} env={currentEnv} />
            {isAdminUser && <LimitsCard slug={currentApp} reload={reloadCounter} onMsg={showMsg} />}
            <DeployCard
              slug={currentApp}
              env={currentEnv}
              reload={reloadCounter}
              onDeploy={deploy}
              onPromote={promote}
              onRollback={rollback}
            />
            <EnvVarsCard
              slug={currentApp}
              env={currentEnv}
              reload={reloadCounter}
              onMsg={showMsg}
              onDeploy={deploy}
              onChanged={() => { /* banner shown internally */ }}
            />
            <DeployHistoryCard
              slug={currentApp}
              env={currentEnv}
              reload={reloadCounter}
              onOpenLogs={openLogsForDeploy}
              onOpenRuntime={openRuntimeLogs}
            />
            {isAdminUser && (
              <AppInfoCard
                slug={currentApp}
                reload={reloadCounter}
                onMsg={showMsg}
                onRenamed={handleRenamed}
              />
            )}
          </>
        )}
      </div>

      {showMain && (
        <LogDrawer
          open={logOpen}
          slug={currentApp}
          env={currentEnv}
          tab={logTab}
          deployId={logDeployId}
          onClose={closeLogDrawer}
          onTabChange={setLogTab}
        />
      )}
    </div>
  )
}
