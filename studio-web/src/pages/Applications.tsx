import { useState, useEffect, useRef } from 'react'
import { adminApi } from '../adminApi'

interface App {
  slug: string
  name: string
  description?: string
  category?: string
  visibility?: string
  github_url?: string
  source_type?: string
  resource_limits?: { max_ram_mb?: number; max_cpu_percent?: number }
  image_retention?: number
  production?: { deploy?: { status?: string; version?: string }; health?: { status: string } }
  sandbox?: { deploy?: { status?: string; version?: string }; health?: { status: string } }
}

interface User {
  id: number
  name: string
  email: string
  assigned_apps?: number
  role: string
  created_at: string
}

interface EnvVar {
  key: string
  value: string
}

interface AnalysisEnvVar {
  key: string
  required: boolean
  example?: string
  description?: string
}

interface Analysis {
  name: string
  slug: string
  description?: string
  framework?: string
  language?: string
  env_vars?: AnalysisEnvVar[]
  notes?: string
  github_url?: string
  branch?: string
}

interface FrameState {
  open: boolean
  url: string
  title: string
}

interface PromptModal {
  open: boolean
  key?: string
  prompt?: string
}

type WizardStep = 'input' | 'analyzing' | 'review'

export function Applications() {
  const [apps, setApps] = useState<App[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [versions, setVersions] = useState<Record<string, { prod?: string; sand?: string }>>({})
  const [openEvars, setOpenEvars] = useState<Record<string, string | null>>({})
  const [evarData, setEvarData] = useState<Record<string, EnvVar[]>>({})
  const [frame, setFrame] = useState<FrameState>({ open: false, url: '', title: '' })
  const [promptModal, setPromptModal] = useState<PromptModal>({ open: false })
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>('input')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [wizardEnvValues, setWizardEnvValues] = useState<Record<string, string>>({})
  const [checkUpdateText, setCheckUpdateText] = useState<Record<string, string>>({})
  const [iconUrls, setIconUrls] = useState<Record<string, string>>({})

  const ghUrlRef = useRef<HTMLInputElement>(null)
  const branchRef = useRef<HTMLInputElement>(null)
  const patRef = useRef<HTMLInputElement>(null)
  const azNameRef = useRef<HTMLInputElement>(null)
  const azSlugRef = useRef<HTMLInputElement>(null)
  const azDescRef = useRef<HTMLInputElement>(null)

  const iconInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  async function loadAll() {
    const [ar, ur] = await Promise.all([
      adminApi.get<{ apps: App[] }>('/api/apps').catch(() => ({ apps: [] as App[] })),
      adminApi.get<{ users: User[] }>('/api/users').catch(() => ({ users: [] as User[] })),
    ])
    const a = ar.apps ?? []
    const u = ur.users ?? []
    setApps(a)
    setUsers(u)
    fetchVersions(a)
    fetchIcons(a)
  }

  function fetchIcons(appList: App[]) {
    appList.forEach(app => {
      fetch(`/api/apps/${app.slug}/icon`)
        .then(r => r.ok ? r.blob() : null)
        .then(b => {
          if (!b) return
          setIconUrls(prev => ({ ...prev, [app.slug]: URL.createObjectURL(b) }))
        })
        .catch(() => {})
    })
  }

  function fetchVersions(appList: App[]) {
    appList.forEach(app => {
      ['production', 'sandbox'].forEach(env => {
        adminApi
          .get<{ version?: string }>(`/api/apps/${app.slug}/version/${env}`)
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
    const r = await adminApi.get<{ message?: string; status?: string; current?: string; latest?: string }>(`/api/apps/${slug}/updates`).catch(() => null)
    const text = r
      ? (r.message ?? (r.status === 'up-to-date' ? 'Up to date' : `${r.current} → ${r.latest}`))
      : 'Error'
    setCheckUpdateText(prev => ({ ...prev, [slug]: text }))
    setTimeout(() => setCheckUpdateText(prev => ({ ...prev, [slug]: '' })), 5000)
  }

  async function registerGithubHook(slug: string) {
    const r = await adminApi.post<{ message?: string; error?: string }>(`/api/apps/${slug}/webhook/register-github`).catch(() => null)
    alert(r?.message ?? r?.error ?? 'Done')
  }

  async function editResources(app: App) {
    const ram = prompt('Max RAM (MB):', String(app.resource_limits?.max_ram_mb ?? ''))
    if (ram === null) return
    const cpu = prompt('Max CPU (%):', String(app.resource_limits?.max_cpu_percent ?? ''))
    if (cpu === null) return
    await adminApi.put(`/api/apps/${app.slug}`, {
      max_ram_mb: ram ? Number(ram) : undefined,
      max_cpu_percent: cpu ? Number(cpu) : undefined,
    }).catch(() => {})
    loadAll()
  }

  async function editRetention(app: App) {
    const val = prompt('Image retention count (0-50):', String(app.image_retention ?? ''))
    if (val === null) return
    const n = parseInt(val, 10)
    if (isNaN(n) || n < 0 || n > 50) return
    await adminApi.put(`/api/apps/${app.slug}`, { image_retention: n }).catch(() => {})
    loadAll()
  }

  async function setCategory(app: App) {
    const cat = prompt('Category:', app.category ?? '')
    if (cat === null) return
    await adminApi.put(`/api/apps/${app.slug}`, { category: cat }).catch(() => {})
    setApps(prev => prev.map(a => a.slug === app.slug ? { ...a, category: cat || undefined } : a))
  }

  async function showAppToken(slug: string) {
    const r = await adminApi.post<{ key?: string; deployment_key?: string }>(`/api/apps/${slug}/deployment-key`).catch(() => null)
    const key = r?.key ?? r?.deployment_key ?? ''
    setPromptModal({
      open: true,
      key,
      prompt: `Use this deployment key to authenticate API calls for app "${slug}".\n\nSet the header:\n  X-Deployment-Key: ${key}\n\nKeep it secret — it grants deploy access to this app.`,
    })
  }

  async function generateAgentKey() {
    const ts = Date.now()
    const name = `agent-${ts}`
    const email = `agent-${ts}@appcrane`
    const r = await adminApi.post<{ key?: string; api_key?: string; user?: { id: number } }>('/api/users', {
      name,
      email,
      role: 'user',
    }).catch(() => null)
    const key = r?.key ?? r?.api_key ?? ''
    setPromptModal({
      open: true,
      key,
      prompt: `Agent user created: ${name}\nEmail: ${email}\n\nAdd this API key to your agent's environment:\n  APPCRANE_API_KEY=${key}\n\nThis key grants user-level access. The API key will not be shown again.`,
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

  function openFrame(url: string, title: string) {
    setFrame({ open: true, url, title })
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

  async function analyzeRepo() {
    const github_url = ghUrlRef.current?.value.trim()
    if (!github_url) return
    const branch = branchRef.current?.value.trim() || 'main'
    const github_token = patRef.current?.value.trim() || undefined
    setWizardStep('analyzing')
    const r = await adminApi
      .post<{ analysis: Analysis }>('/api/apps/analyze', { github_url, branch, github_token })
      .catch(() => null)
    if (!r?.analysis) {
      setWizardStep('input')
      alert('Analysis failed')
      return
    }
    setAnalysis(r.analysis)
    const vals: Record<string, string> = {}
    for (const ev of r.analysis.env_vars ?? []) {
      vals[ev.key] = ev.example ?? ''
    }
    setWizardEnvValues(vals)
    setWizardStep('review')
  }

  async function createApp() {
    if (!analysis) return
    const name = azNameRef.current?.value.trim() || analysis.name
    const slug = azSlugRef.current?.value.trim() || analysis.slug
    const description = azDescRef.current?.value.trim() || analysis.description
    await adminApi.post('/api/apps', {
      name,
      slug,
      description,
      github_url: analysis.github_url,
      branch: analysis.branch,
      source_type: 'github',
    }).catch(() => {})
    for (const env of ['production', 'sandbox']) {
      const body: Record<string, string> = {}
      for (const [k, v] of Object.entries(wizardEnvValues)) {
        if (v) body[k] = v
      }
      if (Object.keys(body).length) {
        await adminApi.put(`/api/apps/${slug}/env/${env}`, body).catch(() => {})
      }
    }
    setWizardOpen(false)
    setWizardStep('input')
    setAnalysis(null)
    loadAll()
  }

  async function deleteUser(id: number) {
    if (!confirm('Delete this user?')) return
    await adminApi.del(`/api/users/${id}`).catch(() => {})
    setUsers(prev => prev.filter(u => u.id !== id))
  }

  const unusedKeys = users.filter(u => !u.assigned_apps && u.role !== 'admin')

  function healthDot(app: App, env: 'production' | 'sandbox') {
    const h = app[env]?.health?.status
    if (!h || h === 'unknown') return 'dot dot-gray'
    if (h === 'healthy') return 'dot dot-green'
    return 'dot dot-red'
  }

  function visBadgeClass(vis?: string) {
    if (vis === 'public') return 'vis-badge vis-public'
    if (vis === 'private') return 'vis-badge vis-private'
    return 'vis-badge vis-hidden'
  }

  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Applications</h2>
        <button className="btn btn-accent" onClick={() => { setWizardOpen(true); setWizardStep('input'); setAnalysis(null) }}>
          + Add from GitHub
        </button>
        <button className="btn" onClick={generateAgentKey}>+ New App Agent</button>
      </div>

      <div id="appsBody">
        {apps.map(app => {
          const activeEnv = openEvars[app.slug]
          return (
            <div key={app.slug} className="app-card">
              <div className="card-hdr">
                <div className="card-meta">
                  <div
                    className="app-icon-wrap"
                    onClick={() => iconInputRefs.current[app.slug]?.click()}
                    title="Click to upload icon"
                  >
                    {iconUrls[app.slug]
                      ? <img src={iconUrls[app.slug]} className="app-icon-img" alt="" />
                      : <span className="app-icon-ph">{app.name.charAt(0).toUpperCase()}</span>
                    }
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      ref={el => { iconInputRefs.current[app.slug] = el }}
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (f) uploadIcon(app.slug, f)
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="card-name-row">
                      <span>{app.name}</span>
                      <span className={visBadgeClass(app.visibility)}>{app.visibility ?? 'hidden'}</span>
                      {app.category && <span className="cat-badge">{app.category}</span>}
                    </div>
                    {app.description && <div className="card-desc">{app.description}</div>}
                    {app.resource_limits && (
                      <div className="card-res">
                        {app.resource_limits.max_ram_mb != null && `RAM: ${app.resource_limits.max_ram_mb}MB`}
                        {app.resource_limits.max_ram_mb != null && app.resource_limits.max_cpu_percent != null && '  '}
                        {app.resource_limits.max_cpu_percent != null && `CPU: ${app.resource_limits.max_cpu_percent}%`}
                      </div>
                    )}
                  </div>
                </div>
                <div className="card-hdr-actions">
                  <select
                    value={app.visibility ?? 'hidden'}
                    onChange={e => setVisibility(app.slug, e.target.value)}
                    style={{ fontSize: '.75rem', padding: '3px 6px' }}
                  >
                    <option value="hidden">hidden</option>
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                  <a className="btn btn-xs" href={`/app?slug=${app.slug}`} target="_blank" rel="noreferrer">manage</a>
                  <button className="btn btn-xs" onClick={() => showAppToken(app.slug)}>onboard</button>
                  <button className="btn btn-xs" onClick={() => setCategory(app)}>tag</button>
                  <button className="btn btn-xs" onClick={() => editResources(app)}>⚙ limits</button>
                  <button className="btn btn-xs" onClick={() => editRetention(app)}>🗂 images</button>
                  <button className="btn btn-xs btn-red" onClick={() => deleteApp(app.slug, app.name)}>delete</button>
                </div>
              </div>

              <div className="card-envs">
                {(['production', 'sandbox'] as const).map(env => {
                  const isProd = env === 'production'
                  const ver = versions[app.slug]?.[isProd ? 'prod' : 'sand']
                  const envPath = isProd ? `/${app.slug}` : `/${app.slug}-sandbox`
                  return (
                    <div key={env} className={`card-env${isProd ? ' prod' : ' sand'}`}>
                      <div className={`env-heading${isProd ? ' prod-heading' : ' sand-heading'}`}>
                        {isProd ? 'Production' : 'Sandbox'}
                      </div>
                      <div className="env-status-row">
                        <span className={healthDot(app, env)} />
                        <span className="env-ver" id={`ver_${app.slug}_${env}`}>{ver ?? '…'}</span>
                        <a
                          className="env-link"
                          href="#"
                          onClick={e => { e.preventDefault(); openFrame(envPath, `${app.name} (${isProd ? 'prod' : 'sandbox'})`) }}
                        >
                          ↗ open
                        </a>
                      </div>
                      <div className="env-act-row">
                        <button
                          className="btn btn-xs"
                          onClick={() => toggleEvars(app.slug, env)}
                        >
                          env vars
                        </button>
                        <button className="btn btn-xs" onClick={() => restartApp(app.slug, env)}>↺ restart</button>
                      </div>
                    </div>
                  )
                })}
              </div>

              {activeEnv && (
                <div className="evars-panel" id={`evars_${app.slug}`}>
                  <div style={{ fontWeight: 600, fontSize: '.78rem', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--dim)' }}>
                    {activeEnv === 'production' ? 'Production' : 'Sandbox'} Env Vars
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
                </div>
              )}

              {(app.source_type === 'github' || app.github_url) && (
                <div className="card-footer">
                  {app.github_url && (
                    <a className="btn btn-xs" href={app.github_url} target="_blank" rel="noreferrer">GitHub ↗</a>
                  )}
                  <button
                    className="btn btn-xs"
                    onClick={() => checkUpdates(app.slug)}
                  >
                    {checkUpdateText[app.slug] || '↑ check updates'}
                  </button>
                  <button className="btn btn-xs" onClick={() => registerGithubHook(app.slug)}>gh hook</button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <h2>Unused Keys</h2>
      {unusedKeys.length === 0 ? (
        <p style={{ color: 'var(--dim)', fontSize: '.85rem' }}>No unused keys.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Created</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {unusedKeys.map(u => (
              <tr key={u.id}>
                <td style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>{u.id}</td>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td style={{ color: 'var(--dim)', fontSize: '.8rem' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-xs btn-red" onClick={() => deleteUser(u.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {frame.open && (
        <div className="app-frame-overlay">
          <div className="app-frame-topbar">
            <span style={{ fontWeight: 600 }}>{frame.title}</span>
            <button className="btn btn-xs" onClick={() => setFrame({ open: false, url: '', title: '' })}>✕ Close</button>
          </div>
          <iframe className="app-frame-iframe" src={frame.url} title={frame.title} />
        </div>
      )}

      <div className={`az-overlay${wizardOpen ? ' open' : ''}`}>
        <div className="az-modal">
          {wizardStep === 'input' && (
            <>
              <div className="az-title" style={{ fontWeight: 700, fontSize: '1.05rem' }}>Add from GitHub</div>
              <div className="az-field">
                <label className="az-label">GitHub URL</label>
                <input ref={ghUrlRef} className="az-input" placeholder="https://github.com/owner/repo" />
              </div>
              <div className="az-field">
                <label className="az-label">Branch</label>
                <input ref={branchRef} className="az-input" placeholder="main" defaultValue="main" />
              </div>
              <div className="az-field">
                <label className="az-label">Personal Access Token (optional)</label>
                <input ref={patRef} className="az-input" type="password" placeholder="ghp_..." />
              </div>
              <div className="az-actions">
                <button className="btn" onClick={() => setWizardOpen(false)}>Cancel</button>
                <button className="btn btn-accent" onClick={analyzeRepo}>Analyze with AI →</button>
              </div>
            </>
          )}

          {wizardStep === 'analyzing' && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ marginBottom: 14 }}>
                <span className="az-spinner" />
                <span style={{ color: 'var(--dim)' }}>Cloning and analyzing repository…</span>
              </div>
            </div>
          )}

          {wizardStep === 'review' && analysis && (
            <>
              <div className="az-title" style={{ fontWeight: 700, fontSize: '1.05rem' }}>Review & Create</div>
              {(analysis.framework || analysis.language) && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {analysis.framework && <span className="az-badge" style={{ background: 'var(--accent)', color: '#fff', padding: '2px 10px', borderRadius: 5, fontSize: '.8rem', fontWeight: 600 }}>{analysis.framework}</span>}
                  {analysis.language && <span style={{ background: 'var(--surface2)', border: '1px solid var(--border)', padding: '2px 10px', borderRadius: 5, fontSize: '.8rem', color: 'var(--dim)' }}>{analysis.language}</span>}
                </div>
              )}
              <div className="az-field">
                <label className="az-label">Name</label>
                <input ref={azNameRef} className="az-input" defaultValue={analysis.name} />
              </div>
              <div className="az-field">
                <label className="az-label">Slug</label>
                <input ref={azSlugRef} className="az-input" defaultValue={analysis.slug} />
              </div>
              <div className="az-field">
                <label className="az-label">Description</label>
                <input ref={azDescRef} className="az-input" defaultValue={analysis.description ?? ''} />
              </div>
              {(analysis.env_vars ?? []).length > 0 && (
                <div className="az-section">
                  <div style={{ fontWeight: 600, fontSize: '.82rem', marginBottom: 8, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Environment Variables</div>
                  {(analysis.env_vars ?? []).map(ev => (
                    <div key={ev.key} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '.82rem', fontWeight: 600 }}>{ev.key}</span>
                        <span className={ev.required ? 'az-req' : 'az-opt'} style={{
                          fontSize: '.68rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                          background: ev.required ? '#ef444422' : '#22c55e22',
                          color: ev.required ? 'var(--red)' : 'var(--green)',
                        }}>
                          {ev.required ? 'required' : 'optional'}
                        </span>
                      </div>
                      {ev.description && <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: 4 }}>{ev.description}</div>}
                      <input
                        className="az-input"
                        placeholder={ev.example ?? ''}
                        value={wizardEnvValues[ev.key] ?? ''}
                        onChange={e => setWizardEnvValues(prev => ({ ...prev, [ev.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              )}
              {analysis.notes && (
                <div className="az-notes">{analysis.notes}</div>
              )}
              <div className="az-actions">
                <button className="btn" onClick={() => { setWizardStep('input'); setAnalysis(null) }}>Back</button>
                <button className="btn" onClick={() => setWizardOpen(false)}>Cancel</button>
                <button className="btn btn-accent" onClick={createApp}>Create App</button>
              </div>
            </>
          )}
        </div>
      </div>

      {promptModal.open && (
        <div className="prompt-overlay" onClick={() => setPromptModal({ open: false })}>
          <div className="prompt-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 16 }}>API Key</div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 14px', fontFamily: 'monospace', fontSize: '.85rem', wordBreak: 'break-all', marginBottom: 12, cursor: 'text', userSelect: 'all' }}>
              {promptModal.key}
            </div>
            <button
              className="btn btn-xs"
              style={{ marginBottom: 16 }}
              onClick={() => navigator.clipboard.writeText(promptModal.key ?? '')}
            >
              Copy key
            </button>
            {promptModal.prompt && (
              <>
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 14px', fontSize: '.82rem', color: 'var(--dim)', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                  {promptModal.prompt}
                </div>
                <button
                  className="btn btn-xs"
                  style={{ marginBottom: 16 }}
                  onClick={() => navigator.clipboard.writeText(promptModal.prompt ?? '')}
                >
                  Copy instructions
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
      )}
    </div>
  )
}
