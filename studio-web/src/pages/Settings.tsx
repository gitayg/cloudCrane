import { useState, useEffect, useRef, type ReactNode } from 'react'
import { adminApi, authHeaders } from '../adminApi'
import { useFlash, FocusInput, FocusTextarea } from '../components/formHelpers'
import { Users } from './Users'
import { AuditLog } from './AuditLog'
import { BrandingTab } from '../components/BrandingTab'
import { Mcp } from './Mcp'
import { SkillsTab } from '../components/SkillsTab'
import { ScimGroupMapping } from '../components/ScimGroupMapping'
import { useMe, isAdmin } from '../hooks/useMe'

function SecurityTab() {
  const [certFile, setCertFile] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [tlsSaved, flashTlsSaved] = useFlash()

  const [tlsCheck, setTlsCheck] = useState<{
    skipped?: boolean; domain?: string; tls_mode?: string;
    hsts_preloaded?: boolean; cert_valid?: boolean;
    warnings?: { level: string; message: string }[]
  } | null>(null)

  const [oidc, setOidc] = useState({
    enabled: false, provider_name: '', discovery_url: '',
    client_id: '', client_secret_set: false, auto_provision: false,
  })
  const [oidcSecret, setOidcSecret] = useState('')
  const [oidcSaved, flashOidcSaved] = useFlash()
  const [oidcTest, setOidcTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const oidcTestTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [saml, setSaml] = useState({
    enabled: false, provider_name: '', idp_sso_url: '',
    idp_cert_set: false, auto_provision: false,
  })
  const [samlCert, setSamlCert] = useState('')
  const [samlSaved, flashSamlSaved] = useFlash()

  const [scim, setScim] = useState({ enabled: false, base_url: '', token_created_at: '' })
  const [scimSaved, flashScimSaved] = useFlash()
  const [scimToken, setScimToken] = useState('')

  // v2.7.0: require-SSO toggle. Disables password sign-in across the
  // instance; the IdP becomes the only browser login path.
  const [ssoOnly, setSsoOnly] = useState(false)
  const [ssoOnlySaved, flashSsoOnlySaved] = useFlash()
  const [ssoOnlyError, setSsoOnlyError] = useState<string | null>(null)

  // v2.25.0: same-site iframe embedding. On by default — any host under the
  // platform's own registrable domain may embed apps.
  const [embed, setEmbed] = useState({ enabled: true, domain_override: '', derived_domain: '', effective: '' })
  const [embedSaved, flashEmbedSaved] = useFlash()
  const [embedError, setEmbedError] = useState<string | null>(null)

  useEffect(() => {
    adminApi.get<{ value?: string }>('/api/settings/tls_cert_file').then(r => { if (r?.value) setCertFile(r.value) }).catch(() => {})
    adminApi.get<{ value?: string }>('/api/settings/tls_key_file').then(r => { if (r?.value) setKeyFile(r.value) }).catch(() => {})
    adminApi.get<typeof tlsCheck>('/api/server/tls-check').then(setTlsCheck).catch(() => {})
    adminApi.get<typeof oidc & { client_secret_set: boolean }>('/api/auth/oidc/admin-config').then(r => {
      if (r) setOidc({ enabled: r.enabled, provider_name: r.provider_name, discovery_url: r.discovery_url, client_id: r.client_id, client_secret_set: r.client_secret_set, auto_provision: r.auto_provision })
    }).catch(() => {})
    adminApi.get<typeof saml>('/api/auth/saml/admin-config').then(r => {
      if (r) setSaml({ enabled: r.enabled, provider_name: r.provider_name, idp_sso_url: r.idp_sso_url, idp_cert_set: r.idp_cert_set, auto_provision: r.auto_provision })
    }).catch(() => {})
    adminApi.get<typeof scim>('/api/auth/scim/config').then(r => { if (r) setScim(r) }).catch(() => {})
    adminApi.get<{ value?: string }>('/api/settings/auth_sso_only').then(r => setSsoOnly(r?.value === 'true')).catch(() => {})
    adminApi.get<typeof embed>('/api/settings/embed/config').then(r => { if (r) setEmbed(r) }).catch(() => {})
  }, [])

  async function saveEmbed(next: { enabled?: boolean; domain_override?: string }) {
    setEmbedError(null)
    try {
      const r = await adminApi.put<{ effective?: string }>('/api/settings/embed/config', next)
      setEmbed(e => ({ ...e, ...next, effective: r?.effective ?? e.effective }))
      flashEmbedSaved()
    } catch (e) {
      setEmbedError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function saveSsoOnly(next: boolean) {
    setSsoOnlyError(null)
    try {
      await adminApi.put('/api/settings/auth_sso_only', { value: next ? 'true' : 'false' })
      setSsoOnly(next)
      flashSsoOnlySaved()
    } catch (e) {
      setSsoOnlyError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function saveTls() {
    await Promise.all([
      adminApi.put('/api/settings/tls_cert_file', { value: certFile }),
      adminApi.put('/api/settings/tls_key_file', { value: keyFile }),
    ]).catch(() => {})
    flashTlsSaved()
    // refresh=1: the TLS settings just changed, so the point of this read is to
    // see the effect. The cache key covers manual-vs-ACME, but re-saving with
    // certs already configured leaves the key identical and would otherwise
    // answer from before the save.
    adminApi.get<typeof tlsCheck>('/api/server/tls-check?refresh=1').then(setTlsCheck).catch(() => {})
  }

  async function testOidc() {
    const r = await adminApi.post<{ ok: boolean; error?: string }>('/api/auth/oidc/test', { discovery_url: oidc.discovery_url }).catch(() => null)
    const ok = r?.ok ?? false
    setOidcTest({ ok, msg: ok ? 'Connection successful' : (r?.error ?? 'Test failed') })
    if (oidcTestTimer.current) clearTimeout(oidcTestTimer.current)
    oidcTestTimer.current = setTimeout(() => setOidcTest(null), 5000)
  }

  async function saveOidc() {
    const body: Record<string, unknown> = {
      enabled: oidc.enabled, provider_name: oidc.provider_name,
      discovery_url: oidc.discovery_url, client_id: oidc.client_id,
      auto_provision: oidc.auto_provision,
    }
    if (oidcSecret) body.client_secret = oidcSecret
    await adminApi.put('/api/auth/oidc/config', body).catch(() => {})
    flashOidcSaved()
    setOidcSecret('')
    adminApi.get<typeof oidc & { client_secret_set: boolean }>('/api/auth/oidc/admin-config').then(r => {
      if (r) setOidc({ enabled: r.enabled, provider_name: r.provider_name, discovery_url: r.discovery_url, client_id: r.client_id, client_secret_set: r.client_secret_set, auto_provision: r.auto_provision })
    }).catch(() => {})
  }

  async function saveSaml() {
    const body: Record<string, unknown> = {
      enabled: saml.enabled, provider_name: saml.provider_name,
      idp_sso_url: saml.idp_sso_url, auto_provision: saml.auto_provision,
    }
    if (samlCert) body.idp_cert = samlCert
    await adminApi.put('/api/auth/saml/config', body).catch(() => {})
    flashSamlSaved()
    setSamlCert('')
    adminApi.get<typeof saml>('/api/auth/saml/admin-config').then(r => { if (r) setSaml(r) }).catch(() => {})
  }

  async function saveScim() {
    await adminApi.put('/api/auth/scim/config', { enabled: scim.enabled }).catch(() => {})
    flashScimSaved()
  }

  async function generateScimToken() {
    if (!confirm('This will invalidate any existing SCIM bearer token. Continue?')) return
    const r = await adminApi.post<{ token?: string }>('/api/auth/scim/token', {}).catch(() => null)
    if (r?.token) {
      setScimToken(r.token)
      adminApi.get<typeof scim>('/api/auth/scim/config').then(r => { if (r) setScim(r) }).catch(() => {})
    }
  }

  const tlsPreBlock = tlsCheck && !tlsCheck.skipped
    ? [
        tlsCheck.domain ? `Domain:         ${tlsCheck.domain}` : null,
        tlsCheck.tls_mode ? `TLS mode:       ${tlsCheck.tls_mode}` : null,
        tlsCheck.hsts_preloaded !== undefined ? `HSTS preloaded: ${tlsCheck.hsts_preloaded ? 'yes' : 'no'}` : null,
        tlsCheck.cert_valid !== undefined ? `Cert valid:     ${tlsCheck.cert_valid ? 'yes' : 'no'}` : null,
      ].filter(Boolean).join('\n')
    : null

  const labelStyle: React.CSSProperties = { fontSize: '.78rem', color: 'var(--dim)', marginBottom: 4, display: 'block' }
  const fieldWrap: React.CSSProperties = { marginBottom: 12 }

  return (
    <>
      <div className="setting-card">
        <h3>Manual TLS Certificate</h3>
        <p>Override Caddy's automatic TLS with a manually managed certificate and private key.</p>
        <div style={fieldWrap}>
          <label style={labelStyle}>Certificate file path</label>
          <FocusInput value={certFile} onChange={e => setCertFile(e.target.value)} placeholder="/etc/ssl/certs/server.crt" />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Private key file path</label>
          <FocusInput value={keyFile} onChange={e => setKeyFile(e.target.value)} placeholder="/etc/ssl/private/server.key" />
        </div>
        <div className="save-row">
          <button className="btn btn-accent" onClick={saveTls}>Save & Reload Caddy</button>
          {tlsSaved && <span className="saved-msg">Saved ✓</span>}
        </div>
      </div>

      <div className="setting-card">
        <h3>TLS Health Check</h3>
        {!tlsCheck && <p style={{ color: 'var(--dim)', fontSize: '.85rem' }}>Loading…</p>}
        {tlsCheck?.skipped && (
          <p style={{ fontSize: '.85rem', color: 'var(--dim)' }}>CRANE_DOMAIN is not set — no domain to check.</p>
        )}
        {tlsCheck && !tlsCheck.skipped && (
          <>
            {tlsPreBlock && (
              <pre style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px', fontSize: '.82rem', marginBottom: 12, overflowX: 'auto' }}>
                {tlsPreBlock}
              </pre>
            )}
            {(!tlsCheck.warnings || tlsCheck.warnings.length === 0) && (
              <p style={{ color: 'var(--green)', fontSize: '.85rem' }}>No issues detected.</p>
            )}
            {tlsCheck.warnings?.map((w, i) => (
              <div key={i} style={{
                background: w.level === 'error' ? 'rgba(239,68,68,.12)' : 'rgba(234,179,8,.12)',
                border: `1px solid ${w.level === 'error' ? 'var(--red)' : 'var(--yellow)'}`,
                borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: '.84rem',
                color: w.level === 'error' ? 'var(--red)' : 'var(--yellow)',
              }}>
                {w.message}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="setting-card">
        <h3>OIDC / SSO</h3>
        <p>Configure OpenID Connect single sign-on for your users.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" id="oidc-enabled" checked={oidc.enabled} onChange={e => setOidc(v => ({ ...v, enabled: e.target.checked }))} />
          <label htmlFor="oidc-enabled" style={{ fontSize: '.85rem' }}>Enable SSO login</label>
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Provider name</label>
          <FocusInput value={oidc.provider_name} onChange={e => setOidc(v => ({ ...v, provider_name: e.target.value }))} placeholder="Okta" />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Discovery URL</label>
          <FocusInput value={oidc.discovery_url} onChange={e => setOidc(v => ({ ...v, discovery_url: e.target.value }))} placeholder="https://example.okta.com/.well-known/openid-configuration" />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Client ID</label>
          <FocusInput value={oidc.client_id} onChange={e => setOidc(v => ({ ...v, client_id: e.target.value }))} />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Client Secret</label>
          <FocusInput
            type="password"
            value={oidcSecret}
            onChange={e => setOidcSecret(e.target.value)}
            placeholder={oidc.client_secret_set ? '••••••••••••' : 'Client secret'}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" id="oidc-provision" checked={oidc.auto_provision} onChange={e => setOidc(v => ({ ...v, auto_provision: e.target.checked }))} />
          <label htmlFor="oidc-provision" style={{ fontSize: '.85rem' }}>Auto-provision new users</label>
        </div>
        <div className="save-row">
          <button className="btn" onClick={testOidc}>Test Connection</button>
          <button className="btn btn-accent" onClick={saveOidc}>Save</button>
          {oidcSaved && <span className="saved-msg">Saved ✓</span>}
          {oidcTest && (
            <span style={{ fontSize: '.82rem', color: oidcTest.ok ? 'var(--green)' : 'var(--red)' }}>
              {oidcTest.ok ? '✓' : '✗'} {oidcTest.msg}
            </span>
          )}
        </div>
      </div>

      <div className="setting-card">
        <h3>SAML 2.0 (Okta)</h3>
        <p>
          Configure SAML single sign-on. SP metadata available at{' '}
          <a href="/api/auth/saml/metadata" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>/api/auth/saml/metadata</a>.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" id="saml-enabled" checked={saml.enabled} onChange={e => setSaml(v => ({ ...v, enabled: e.target.checked }))} />
          <label htmlFor="saml-enabled" style={{ fontSize: '.85rem' }}>Enable SAML login</label>
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Provider name</label>
          <FocusInput value={saml.provider_name} onChange={e => setSaml(v => ({ ...v, provider_name: e.target.value }))} placeholder="Okta" />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>Okta SSO URL</label>
          <FocusInput value={saml.idp_sso_url} onChange={e => setSaml(v => ({ ...v, idp_sso_url: e.target.value }))} placeholder="https://example.okta.com/app/xxx/sso/saml" />
        </div>
        <div style={fieldWrap}>
          <label style={labelStyle}>X.509 Certificate</label>
          <FocusTextarea
            value={samlCert}
            onChange={e => setSamlCert(e.target.value)}
            placeholder={saml.idp_cert_set ? '(certificate already set — paste new one to replace)' : 'Paste IdP X.509 certificate'}
            style={{ minHeight: 120, fontFamily: 'monospace', fontSize: '.8rem' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" id="saml-provision" checked={saml.auto_provision} onChange={e => setSaml(v => ({ ...v, auto_provision: e.target.checked }))} />
          <label htmlFor="saml-provision" style={{ fontSize: '.85rem' }}>Auto-provision new users</label>
        </div>
        <div className="save-row">
          <button className="btn btn-accent" onClick={saveSaml}>Save</button>
          {samlSaved && <span className="saved-msg">Saved ✓</span>}
        </div>
      </div>

      <div className="setting-card">
        <h3>Require SSO</h3>
        <p>
          Disable <strong>interactive password sign-in</strong> for everyone. The SSO button becomes
          the only browser login path; the API-key break-glass paste is hidden too. OIDC or SAML must
          be enabled and configured first.
        </p>
        <p style={{ fontSize: '.8rem', color: 'var(--dim)' }}>
          Scope: this governs <em>browser/password</em> login only. Programmatic <strong>API keys</strong>{' '}
          (<code style={{ fontFamily: 'monospace' }}>dhk_*</code> — CLI, MCP, CI) remain valid machine
          credentials and are <em>not</em> disabled by this toggle; manage them under Users. To fully
          cut off non-SSO access you must also revoke API keys.
        </p>
        {!(oidc.enabled || saml.enabled) && (
          <div style={{
            background: 'rgba(234,179,8,.12)', border: '1px solid var(--yellow)', color: 'var(--yellow)',
            borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: '.84rem',
          }}>
            No SSO provider is enabled yet. Configure OIDC or SAML above before requiring SSO.
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            type="checkbox"
            id="sso-only"
            checked={ssoOnly}
            disabled={!ssoOnly && !(oidc.enabled || saml.enabled)}
            onChange={e => saveSsoOnly(e.target.checked)}
          />
          <label htmlFor="sso-only" style={{ fontSize: '.85rem' }}>Require SSO (disable password sign-in)</label>
          {ssoOnlySaved && <span className="saved-msg">Saved ✓</span>}
        </div>
        {ssoOnlyError && (
          <div style={{ fontSize: '.82rem', color: 'var(--red)' }}>{ssoOnlyError}</div>
        )}
      </div>

      <div className="setting-card">
        <h3>App embedding (iframe)</h3>
        <p>
          Allow other sites to embed your apps in an <code>&lt;iframe&gt;</code>. When on, any host under
          this platform's own registrable domain{' '}
          <strong>{embed.domain_override || embed.derived_domain || 'your domain'}</strong> may embed apps
          (a same-org trust boundary) — the in-iframe SSO login step is made frameable too. Per-app
          <code style={{ fontFamily: 'monospace' }}> frame_ancestors</code> can add specific external
          embedders on top.
        </p>
        <p style={{ fontSize: '.8rem', color: 'var(--dim)' }}>
          Security: this lets any host under your domain frame an app <em>with the user's live session</em>
          {' '}(clickjacking surface = your own subdomains, incl. any vulnerable to subdomain takeover). Turn
          it off to keep apps same-origin-only unless an app opts in explicitly.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <input
            type="checkbox"
            id="embed-same-site"
            checked={embed.enabled}
            onChange={e => saveEmbed({ enabled: e.target.checked })}
          />
          <label htmlFor="embed-same-site" style={{ fontSize: '.85rem' }}>
            Allow embedding from any <strong>{embed.domain_override || embed.derived_domain || 'platform-domain'}</strong> subdomain
          </label>
          {embedSaved && <span className="saved-msg">Saved ✓</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, opacity: embed.enabled ? 1 : 0.5 }}>
          <label htmlFor="embed-domain" style={{ fontSize: '.82rem', color: 'var(--dim)', minWidth: 150 }}>
            Domain override (optional)
          </label>
          <input
            type="text"
            id="embed-domain"
            placeholder={embed.derived_domain || 'example.com'}
            defaultValue={embed.domain_override}
            disabled={!embed.enabled}
            onBlur={e => { const v = e.target.value.trim(); if (v !== embed.domain_override) saveEmbed({ domain_override: v }) }}
            style={{ flex: 1, maxWidth: 280 }}
          />
        </div>
        {embed.effective && (
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', fontFamily: 'monospace', marginTop: 4 }}>
            frame-ancestors {embed.effective}
          </div>
        )}
        {embedError && <div style={{ fontSize: '.82rem', color: 'var(--red)' }}>{embedError}</div>}
      </div>

      <div className="setting-card">
        <h3>SCIM Provisioning</h3>
        <p>Automate user provisioning and de-provisioning via SCIM 2.0.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" id="scim-enabled" checked={scim.enabled} onChange={e => setScim(v => ({ ...v, enabled: e.target.checked }))} />
          <label htmlFor="scim-enabled" style={{ fontSize: '.85rem' }}>Enable SCIM provisioning</label>
        </div>
        {scim.base_url && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>SCIM base URL</label>
            <code style={{
              display: 'block', background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '8px 12px', fontSize: '.82rem', wordBreak: 'break-all',
            }}>{scim.base_url}</code>
          </div>
        )}
        <p style={{ fontSize: '.84rem', color: 'var(--dim)', marginBottom: 12 }}>
          {scim.token_created_at
            ? `Bearer token last generated: ${new Date(scim.token_created_at).toLocaleString()}`
            : 'No bearer token generated yet.'}
        </p>
        {scimToken && (
          <div style={{ marginBottom: 12 }}>
            <code style={{
              display: 'block', background: 'rgba(234,179,8,.1)', border: '1px solid var(--yellow)',
              borderRadius: 6, padding: '10px 14px', fontSize: '.82rem', fontFamily: 'monospace',
              wordBreak: 'break-all', color: 'var(--yellow)', marginBottom: 6,
            }}>{scimToken}</code>
            <span style={{ fontSize: '.8rem', color: 'var(--yellow)' }}>Copy this token now — it will not be shown again.</span>
          </div>
        )}
        <div className="save-row">
          <button className="btn btn-accent" onClick={saveScim}>Save</button>
          <button className="btn" onClick={generateScimToken}>Generate New Token</button>
          {scimSaved && <span className="saved-msg">Saved ✓</span>}
        </div>

        <ScimGroupMapping baseUrl={scim.base_url} />
      </div>
    </>
  )
}

interface PermDef { key: string; label: string; description: string; scope?: 'app' | 'platform' }
type Role = 'user' | 'admin' | 'owner' | 'platform_admin'
type Matrix = Record<string, Record<Role, number>>

function RolesTab() {
  const [permissions, setPermissions] = useState<PermDef[]>([])
  const [matrix, setMatrix] = useState<Matrix>({})
  const [roles, setRoles] = useState<Role[]>(['user', 'admin', 'owner', 'platform_admin'])
  const [busy, setBusy] = useState(false)
  const [saved, flashSaved] = useFlash()
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    adminApi.get<{ permissions: PermDef[]; matrix: Matrix; roles: Role[] }>('/api/settings/role-permissions/catalog')
      .then(r => {
        setPermissions(r.permissions ?? [])
        setMatrix(r.matrix ?? {})
        if (Array.isArray(r.roles) && r.roles.length) setRoles(r.roles)
      })
      .catch(e => setError(e?.message || 'Failed to load matrix'))
  }
  useEffect(() => { load() }, [])

  function toggle(perm: string, role: Role) {
    setMatrix(prev => ({
      ...prev,
      [perm]: { ...prev[perm], [role]: prev[perm]?.[role] ? 0 : 1 },
    }))
  }

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      const r = await adminApi.put<{ matrix: Matrix }>('/api/settings/role-permissions', { matrix })
      if (r?.matrix) setMatrix(r.matrix)
      flashSaved()
    } catch (e) {
      alert('Save failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function resetRow(permKey: string) {
    if (!confirm(`Reset "${permKey}" to defaults?`)) return
    setBusy(true)
    try {
      const r = await adminApi.post<{ matrix: Matrix }>('/api/settings/role-permissions/reset', { permissions: [permKey] })
      if (r?.matrix) setMatrix(r.matrix)
      flashSaved()
    } catch (e) {
      alert('Reset failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function resetAll() {
    if (!confirm('Reset all permissions to seeded defaults? This will overwrite all current settings.')) return
    setBusy(true)
    try {
      const r = await adminApi.post<{ matrix: Matrix }>('/api/settings/role-permissions/reset', {})
      if (r?.matrix) setMatrix(r.matrix)
      flashSaved()
    } catch (e) {
      alert('Reset failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="setting-card" style={{ borderColor: '#ef444444' }}>
        <h3 style={{ color: 'var(--red)' }}>Roles unavailable</h3>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <>
      <div className="setting-card">
        <h3>Per-app role permissions</h3>
        <p>
          High-stakes operations where AppCrane lets you decide who's allowed. Most other authz
          stays hardcoded — these are the cells that genuinely vary across teams.
          AppCrane global admins (<code style={{ fontFamily: 'monospace', background: 'var(--surface2)', padding: '1px 5px', borderRadius: 3, fontSize: '.78rem' }}>users.role = admin</code> or <code style={{ fontFamily: 'monospace', background: 'var(--surface2)', padding: '1px 5px', borderRadius: 3, fontSize: '.78rem' }}>platform_admin</code>)
          always have every permission regardless of this matrix; the table below governs only the
          per-app role tiers. Rows tagged <span style={{ fontSize: '.68rem', letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 3, padding: '0 4px' }}>platform</span> are
          checked against the user's global role instead — there's no app yet — so the per-app OWNER column doesn't apply.
        </p>

        <table style={{ width: '100%', fontSize: '.85rem', marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '6px 8px' }}>Permission</th>
              {roles.map(r => (
                <th key={r} style={{ textAlign: 'center', color: 'var(--dim)', fontWeight: 500, padding: '6px 8px', textTransform: 'uppercase', letterSpacing: '.4px', fontSize: '.72rem' }}>
                  {r}
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {permissions.map(p => (
              <tr key={p.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                  <div style={{ fontWeight: 600 }}>
                    {p.label}
                    {p.scope === 'platform' && (
                      <span style={{ marginLeft: 6, fontSize: '.62rem', letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 3, padding: '0 4px', verticalAlign: 'middle' }}>platform</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--dim)', fontSize: '.78rem', marginTop: 2 }}>{p.description}</div>
                  <div style={{ color: 'var(--dim)', fontFamily: 'monospace', fontSize: '.72rem', marginTop: 4 }}>{p.key}</div>
                </td>
                {roles.map(role => {
                  // Platform-scoped perms have no per-app OWNER concept.
                  const naCell = p.scope === 'platform' && role === 'owner'
                  return (
                    <td key={role} style={{ textAlign: 'center', padding: '10px 8px', verticalAlign: 'top' }}>
                      {naCell ? (
                        <span style={{ color: 'var(--dim)' }} title="Not applicable — platform permission has no per-app owner">—</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={!!(matrix[p.key]?.[role])}
                          onChange={() => toggle(p.key, role)}
                          style={{ width: 18, height: 18, cursor: 'pointer' }}
                        />
                      )}
                    </td>
                  )
                })}
                <td style={{ textAlign: 'right', padding: '10px 8px', verticalAlign: 'top' }}>
                  <button className="btn btn-xs" onClick={() => resetRow(p.key)} disabled={busy}>Reset</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="save-row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          <button className="btn" onClick={resetAll} disabled={busy}>Reset all to defaults</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {saved && <span className="saved-msg">Saved ✓</span>}
            <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </>
  )
}

interface ContainerEntry {
  user_id: number
  started_at: string
  last_active_at: string
  idle_seconds: number
  alive: boolean
}

interface GithubServiceConfig {
  owner: string
  visibility: 'private' | 'internal' | 'public'
  enabled: boolean
  configured: boolean
}

function GithubTab() {
  const [idleTimeout, setIdleTimeout] = useState(600)
  const [maxConcurrent, setMaxConcurrent] = useState(10)
  const [image, setImage] = useState('ghcr.io/github/github-mcp-server:latest')
  const [containers, setContainers] = useState<ContainerEntry[]>([])
  const [saved, flashSaved] = useFlash()
  const [busy, setBusy] = useState(false)

  // Service-account config (v2.3.0+) — single platform PAT that owns the
  // per-app repos when the user opts into "AppCrane manages my code."
  const [svc, setSvc] = useState<GithubServiceConfig>({ owner: '', visibility: 'private', enabled: false, configured: false })
  const [svcToken, setSvcToken] = useState('')
  const [svcSaved, flashSvcSaved] = useFlash()
  const [svcVerify, setSvcVerify] = useState<{ ok: boolean; login?: string; type?: string; scopes?: string | null; can_create_repos?: boolean | null; note?: string | null; error?: string } | null>(null)
  const [svcBusy, setSvcBusy] = useState(false)

  function loadServiceConfig() {
    adminApi.get<GithubServiceConfig>('/api/github-service/config').then(setSvc).catch(() => {})
  }

  async function saveService() {
    if (svcBusy) return
    setSvcBusy(true)
    try {
      const body: Record<string, unknown> = { owner: svc.owner, visibility: svc.visibility, enabled: svc.enabled }
      if (svcToken) body.token = svcToken
      const next = await adminApi.put<GithubServiceConfig>('/api/github-service/config', body)
      if (next) setSvc(next)
      setSvcToken('')
      flashSvcSaved()
    } catch (e) {
      alert('Save failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSvcBusy(false)
    }
  }

  async function clearServiceToken() {
    if (!confirm('Clear the stored service-account token? This will disable the integration.')) return
    setSvcBusy(true)
    try {
      const next = await adminApi.put<GithubServiceConfig>('/api/github-service/config', { token: null })
      if (next) setSvc(next)
      setSvcToken('')
      setSvcVerify(null)
      flashSvcSaved()
    } finally { setSvcBusy(false) }
  }

  async function verifyService() {
    setSvcVerify(null)
    setSvcBusy(true)
    try {
      const r = await adminApi.post<typeof svcVerify>('/api/github-service/verify', {})
      setSvcVerify(r)
    } catch (e) {
      setSvcVerify({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally { setSvcBusy(false) }
  }

  function loadSettings() {
    Promise.all([
      adminApi.get<{ value?: string }>('/api/settings/github_mcp_idle_timeout').catch(() => ({ value: '600' })),
      adminApi.get<{ value?: string }>('/api/settings/github_mcp_max_concurrent').catch(() => ({ value: '10' })),
      adminApi.get<{ value?: string }>('/api/settings/github_mcp_image').catch(() => ({ value: 'ghcr.io/github/github-mcp-server:latest' })),
    ]).then(([t, m, i]) => {
      if (t?.value) setIdleTimeout(Number(t.value))
      if (m?.value) setMaxConcurrent(Number(m.value))
      if (i?.value) setImage(i.value)
    })
  }

  function loadContainers() {
    adminApi.get<{ active: ContainerEntry[] }>('/api/mcp/github/containers')
      .then(r => setContainers(r.active ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    loadSettings()
    loadContainers()
    loadServiceConfig()
    const iv = setInterval(loadContainers, 15000)
    return () => clearInterval(iv)
  }, [])

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await Promise.all([
        adminApi.put('/api/settings/github_mcp_idle_timeout', { value: String(idleTimeout) }),
        adminApi.put('/api/settings/github_mcp_max_concurrent', { value: String(maxConcurrent) }),
        adminApi.put('/api/settings/github_mcp_image', { value: image }),
      ])
      flashSaved()
    } catch (e) {
      alert('Save failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function killContainer(userId: number) {
    if (!confirm(`Force-stop the GitHub MCP container for user ${userId}?\n\nIn-flight tool calls will fail. The user's next call will spawn a new container.`)) return
    await adminApi.post(`/api/mcp/github/containers/${userId}/kill`, {}).catch(() => {})
    loadContainers()
  }

  return (
    <>
      <div className="setting-card">
        <h3>GitHub MCP — Per-user containers</h3>
        <p>
          AppCrane spawns a per-user <code style={{ fontFamily: 'monospace' }}>github-mcp-server</code> Docker container on demand
          when a user passes their PAT via <code style={{ fontFamily: 'monospace' }}>X-Github-Token</code> header in their MCP setup.
          Each container is scoped to that user; <code style={{ fontFamily: 'monospace' }}>github_*</code> tool calls are forwarded
          via stdio. Idle containers are reaped automatically.
        </p>
        <p style={{ color: 'var(--dim)', fontSize: '.8rem', marginTop: -4 }}>
          User setup: <code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>claude mcp add --transport http appcrane &lt;url&gt; --header "X-API-Key: dhk_mcp_…" --header "X-Github-Token: ghp_…"</code>
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px 16px', alignItems: 'center', marginTop: 16, maxWidth: 600 }}>
          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Idle timeout (seconds)</label>
          <FocusInput type="number" min={60} max={86400} value={idleTimeout} onChange={e => setIdleTimeout(Number(e.target.value))} style={{ width: 140 }} />

          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Max concurrent containers</label>
          <FocusInput type="number" min={1} max={100} value={maxConcurrent} onChange={e => setMaxConcurrent(Number(e.target.value))} style={{ width: 140 }} />

          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Container image</label>
          <FocusInput type="text" value={image} onChange={e => setImage(e.target.value)} placeholder="ghcr.io/github/github-mcp-server:latest" />
        </div>

        <div className="save-row" style={{ marginTop: 16 }}>
          <button className="btn btn-accent" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && <span className="saved-msg">Saved ✓</span>}
        </div>
      </div>

      <div className="setting-card">
        <h3>Active containers <span style={{ fontWeight: 400, color: 'var(--dim)', fontSize: '.82rem' }}>({containers.length} / {maxConcurrent})</span></h3>
        <p>Live roster — refreshes every 15 seconds. Force-stop to recover stuck containers (e.g. after a PAT was revoked).</p>
        {containers.length === 0 ? (
          <div style={{ color: 'var(--dim)', fontSize: '.85rem', padding: '8px 0' }}>No containers running.</div>
        ) : (
          <table style={{ width: '100%', fontSize: '.85rem', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '4px 8px' }}>User ID</th>
                <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '4px 8px' }}>Started</th>
                <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '4px 8px' }}>Last active</th>
                <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '4px 8px' }}>Idle</th>
                <th style={{ textAlign: 'left', color: 'var(--dim)', fontWeight: 500, padding: '4px 8px' }}>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {containers.map(c => (
                <tr key={c.user_id}>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{c.user_id}</td>
                  <td style={{ padding: '4px 8px', color: 'var(--dim)' }}>{new Date(c.started_at).toLocaleTimeString()}</td>
                  <td style={{ padding: '4px 8px', color: 'var(--dim)' }}>{new Date(c.last_active_at).toLocaleTimeString()}</td>
                  <td style={{ padding: '4px 8px', color: c.idle_seconds > idleTimeout / 2 ? 'var(--yellow)' : 'var(--dim)' }}>
                    {c.idle_seconds < 60 ? `${c.idle_seconds}s` : `${Math.floor(c.idle_seconds / 60)}m ${c.idle_seconds % 60}s`}
                  </td>
                  <td style={{ padding: '4px 8px', color: c.alive ? 'var(--green)' : 'var(--red)' }}>{c.alive ? 'running' : 'dead'}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    <button className="btn btn-xs btn-red" onClick={() => killContainer(c.user_id)}>Kill</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="setting-card">
        <h3>Service-account — AppCrane-managed repos</h3>
        <p>
          Configure a single GitHub user or org that AppCrane uses to host per-app repositories. End users who don't have
          their own GitHub PAT can opt into "AppCrane manages my code" — AppCrane creates the repo, holds the credential,
          and proxies all reads and writes. The user never sees github.com.
        </p>
        <p style={{ color: 'var(--dim)', fontSize: '.8rem', marginTop: -4 }}>
          The PAT stays encrypted at rest (AES-256-GCM, same envelope as the SSO secrets). It's never returned to the browser.
        </p>
        <div style={{
          marginTop: 12,
          padding: '10px 12px',
          background: 'rgba(245, 158, 11, .08)',
          border: '1px solid rgba(245, 158, 11, .3)',
          borderRadius: 6,
          fontSize: '.82rem', color: 'var(--text)', lineHeight: 1.5,
        }}>
          <strong style={{ color: '#fbbf24' }}>Scope the PAT to just what AppCrane needs.</strong>
          {' '}AppCrane only touches repos it creates. Every managed repo is prefixed
          {' '}<code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>AMC_</code> (AppCrane-Managed-Code) so the
          {' '}PAT can be scoped accordingly:
          <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--dim)' }}>
            <li><strong>Fine-grained PAT (recommended)</strong>: use a <strong>dedicated org/user</strong> as the resource
            {' '}owner and grant <em>"All repositories"</em> — AppCrane creates the <code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>AMC_*</code> repos
            {' '}on demand, so they don't exist yet to be hand-picked. Permissions: Administration <em>R/W</em> (create repos),
            {' '}Contents <em>R/W</em> (push code), Metadata <em>R</em> (auto).</li>
            <li><strong>Classic PAT</strong>: simpler — a token with the <code>repo</code> scope is bounded by what the
            {' '}account owns. Put the service account in its own org/sub-account so that bound is just AppCrane's repos.
            {' '}Weaker isolation than fine-grained.</li>
          </ul>
        </div>

        <div style={{
          marginTop: 10, padding: '10px 12px',
          background: 'var(--surface2, #232323)', border: '1px solid var(--border)',
          borderRadius: 6, fontSize: '.82rem', color: 'var(--text)', lineHeight: 1.55,
        }}>
          <strong>How to create the token</strong>
          <p style={{ margin: '4px 0 6px', color: 'var(--dim)' }}>Sign in to GitHub as the service account (or have an org admin do it), then:</p>
          <div style={{ marginBottom: 8 }}>
            <em style={{ color: 'var(--text)' }}>Fine-grained</em>
            {' '}(<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>github.com/settings/personal-access-tokens/new</a>):
            <ol style={{ margin: '4px 0 0 18px', padding: 0, color: 'var(--dim)' }}>
              <li>Name it (e.g. "AppCrane managed repos"); set an <strong>expiration</strong> and a reminder — an expired PAT silently breaks managed deploys.</li>
              <li><strong>Resource owner</strong> → the org/user that will own the <code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>AMC_*</code> repos.</li>
              <li><strong>Repository access</strong> → <em>All repositories</em>.</li>
              <li><strong>Repository permissions</strong> → Administration: <em>Read and write</em>, Contents: <em>Read and write</em>, Metadata: <em>Read-only</em> (auto).</li>
              <li>Generate, copy the token, paste it below, and Save.</li>
            </ol>
          </div>
          <div>
            <em style={{ color: 'var(--text)' }}>Classic</em>
            {' '}(<a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>github.com/settings/tokens/new</a>):
            check the <code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>repo</code> scope, set an expiration, generate, copy, paste below.
          </div>
          <p style={{ margin: '8px 0 0', color: 'var(--dim)' }}>
            Set the <strong>Owner</strong> field below to that same org/user. Then the New-App flow's "AppCrane manages my code" option creates and deploys repos under it.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px 16px', alignItems: 'center', marginTop: 16, maxWidth: 600 }}>
          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Owner (user or org)</label>
          <FocusInput
            type="text"
            value={svc.owner}
            onChange={e => setSvc(s => ({ ...s, owner: e.target.value }))}
            placeholder="appcrane-bot or my-org"
          />

          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>
            PAT {svc.configured && <span style={{ color: 'var(--green)' }}>· stored</span>}
          </label>
          <FocusInput
            type="password"
            value={svcToken}
            onChange={e => setSvcToken(e.target.value)}
            placeholder={svc.configured ? '•••••••• (leave empty to keep current)' : 'ghp_… or fine-grained token'}
          />

          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Default repo visibility</label>
          <select
            value={svc.visibility}
            onChange={e => setSvc(s => ({ ...s, visibility: e.target.value as GithubServiceConfig['visibility'] }))}
            style={{ width: 200, padding: '6px 8px' }}
          >
            <option value="private">private</option>
            <option value="internal">internal</option>
            <option value="public">public</option>
          </select>

          <label style={{ fontSize: '.85rem', color: 'var(--dim)' }}>Enabled</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={svc.enabled}
              onChange={e => setSvc(s => ({ ...s, enabled: e.target.checked }))}
            />
            <span style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
              When enabled, the "+ New App" wizard offers the managed-repo path.
            </span>
          </label>
        </div>

        <div className="save-row" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-accent" onClick={saveService} disabled={svcBusy}>{svcBusy ? 'Saving…' : 'Save'}</button>
          <button className="btn" onClick={verifyService} disabled={svcBusy || !svc.configured}>
            Verify token
          </button>
          {svc.configured && (
            <button className="btn btn-red" onClick={clearServiceToken} disabled={svcBusy}>
              Clear token
            </button>
          )}
          {svcSaved && <span className="saved-msg">Saved ✓</span>}
        </div>

        {svcVerify && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, background: svcVerify.ok ? 'rgba(46,125,50,.12)' : 'rgba(226,75,74,.12)', fontSize: '.85rem' }}>
            {svcVerify.ok ? (
              <>
                ✓ Authenticated as <code style={{ fontFamily: 'monospace' }}>{svcVerify.login}</code> ({svcVerify.type}).
                {' '}Scopes: <code style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{svcVerify.scopes || '(fine-grained — repo-scoped at token-creation time)'}</code>
                {/* v2.6.11: warn when the token has full classic-PAT `repo` scope.
                    AppCrane only needs Contents + Metadata + Administration on
                    AMC_*-prefixed repos. `repo` is broader than that. */}
                {svcVerify.can_create_repos === true && (
                  <div style={{ marginTop: 6, color: 'var(--green)', fontSize: '.78rem' }}>✓ Can create repositories.</div>
                )}
                {/* v2.10.5: the load-bearing check — a token can authenticate
                    but lack repo-creation permission (422 at create time). */}
                {svcVerify.note && (
                  <div style={{ marginTop: 6, color: svcVerify.can_create_repos === false ? 'var(--red)' : '#fbbf24', fontSize: '.78rem' }}>
                    {svcVerify.can_create_repos === false ? '✗ ' : '⚠ '}{svcVerify.note}
                  </div>
                )}
                {svcVerify.scopes && /\brepo\b/.test(svcVerify.scopes) && (
                  <div style={{ marginTop: 6, color: '#fbbf24', fontSize: '.78rem' }}>
                    ⚠ This is a classic PAT with full <code>repo</code> scope — broader than AppCrane needs.
                    {' '}Switch to a fine-grained PAT scoped to <code>AMC_*</code> repos
                    {' '}(Contents R/W, Metadata R, Administration R/W) when convenient.
                  </div>
                )}
              </>
            ) : <>✗ {svcVerify.error}</>}
          </div>
        )}
      </div>
    </>
  )
}

function MailTab() {
  const [cfg, setCfg] = useState({
    tenant_id: '', client_id: '', from_address: '', from_name: '',
    client_secret_set: false, configured: false,
  })
  const [secret, setSecret] = useState('')
  const [saved, flashSaved] = useFlash()
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)

  function load() {
    adminApi.get<{ mail: typeof cfg }>('/api/settings/mail/config').then(r => { if (r?.mail) setCfg(r.mail) }).catch(() => {})
  }
  useEffect(load, [])

  async function save() {
    const body: Record<string, string> = {
      tenant_id: cfg.tenant_id, client_id: cfg.client_id,
      from_address: cfg.from_address, from_name: cfg.from_name,
    }
    if (secret.trim()) body.client_secret = secret.trim()
    await adminApi.put('/api/settings/mail/config', body).catch(() => {})
    setSecret('')
    flashSaved()
    load()
  }

  async function sendTest() {
    setTest(null)
    try {
      const r = await adminApi.post<{ message?: string }>('/api/settings/mail/test', {})
      setTest({ ok: true, msg: r?.message || 'Test queued.' })
    } catch (e) {
      setTest({ ok: false, msg: e instanceof Error ? e.message : 'Test failed' })
    }
  }

  return (
    <div className="settings-section">
      <h2>Mail</h2>
      <p className="settings-hint">
        Microsoft Graph send-as-mailbox for the app email service. Apps send through AppCrane;
        recipients are limited to registered platform users. The client secret is stored encrypted
        and never shown again.
      </p>

      <label>Sender address (Graph mailbox)</label>
      <FocusInput value={cfg.from_address} onChange={e => setCfg({ ...cfg, from_address: e.target.value })} placeholder="appcrane@example.com" />

      <label>Default display name</label>
      <FocusInput value={cfg.from_name} onChange={e => setCfg({ ...cfg, from_name: e.target.value })} placeholder="AIMI" />

      <label>Azure tenant ID</label>
      <FocusInput value={cfg.tenant_id} onChange={e => setCfg({ ...cfg, tenant_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />

      <label>Client ID (application ID)</label>
      <FocusInput value={cfg.client_id} onChange={e => setCfg({ ...cfg, client_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />

      <label>Client secret {cfg.client_secret_set && <span style={{ color: 'var(--green)' }}>— set ✓ (leave blank to keep)</span>}</label>
      <FocusInput type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={cfg.client_secret_set ? '••••••••' : 'paste the IT-provided secret'} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn" onClick={sendTest} disabled={!cfg.configured}>Send test email to me</button>
        {saved && <span style={{ color: 'var(--green)' }}>Saved</span>}
        <span style={{ color: cfg.configured ? 'var(--green)' : 'var(--dim)' }}>
          {cfg.configured ? '● configured' : '○ not configured'}
        </span>
      </div>
      {test && <p style={{ color: test.ok ? 'var(--green)' : 'var(--red)', marginTop: 8 }}>{test.msg}</p>}
    </div>
  )
}

function BackupTab() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [restoreEnv, setRestoreEnv] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  // v2.21.9: scheduled off-site (S3) backup config.
  type S3Cfg = { enabled?: boolean; bucket?: string; region?: string; prefix?: string; endpoint?: string; access_key_id?: string; has_secret?: boolean; hour?: number; last_run?: string | null; last_error?: string | null }
  const [s3, setS3] = useState<S3Cfg>({})
  const [s3Secret, setS3Secret] = useState('')
  const [s3Busy, setS3Busy] = useState(false)
  useEffect(() => { adminApi.get<S3Cfg>('/api/settings/backup/s3').then(setS3).catch(() => {}) }, [])

  async function saveS3() {
    setS3Busy(true); setMsg(null)
    try {
      const patch: Record<string, unknown> = { enabled: s3.enabled, bucket: s3.bucket, region: s3.region, prefix: s3.prefix, endpoint: s3.endpoint, access_key_id: s3.access_key_id, hour: s3.hour }
      if (s3Secret.trim()) patch.secret_access_key = s3Secret.trim()
      const next = await adminApi.put<S3Cfg>('/api/settings/backup/s3', patch)
      setS3(next); setS3Secret('')
      setMsg({ ok: true, text: 'S3 backup settings saved.' })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
    finally { setS3Busy(false) }
  }
  async function runS3Now() {
    setS3Busy(true); setMsg(null)
    try {
      const r = await adminApi.post<{ ok: boolean; key?: string; size?: number; error?: string }>('/api/settings/backup/s3/run', {})
      if (!r.ok) throw new Error(r.error || 'Backup failed')
      setMsg({ ok: true, text: `Uploaded ${r.key} (${Math.round((r.size || 0) / 1024)} KB).` })
      adminApi.get<S3Cfg>('/api/settings/backup/s3').then(setS3).catch(() => {})
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
    finally { setS3Busy(false) }
  }

  async function download() {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/api/settings/config/export', { headers: authHeaders() })
      if (!r.ok) throw new Error(`Export failed (${r.status})`)
      const blob = await r.blob()
      const cd = r.headers.get('Content-Disposition') || ''
      const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'appcrane-backup.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      setMsg({ ok: true, text: `Downloaded ${name}` })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy(false) }
  }

  async function doImport(file: File) {
    if (!confirm(
      `Import "${file.name}"?\n\nThis REPLACES the current database` +
      (restoreEnv ? ' and .env' : '') + ' with the backup, then restarts the server. ' +
      'The current config is copied to a pre-import-<timestamp> folder first. Continue?'
    )) { if (fileRef.current) fileRef.current.value = ''; return }
    setImporting(true); setMsg(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/settings/config/import?restore_env=${restoreEnv ? '1' : '0'}`, {
        method: 'POST', headers: authHeaders(), body: fd,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error?.message || `Import failed (${r.status})`)
      setMsg({ ok: true, text: (data.message || 'Imported.') + ' Wait ~10s, then refresh.' })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="settings-section">
      <h2>Backup &amp; Restore</h2>
      <p className="settings-hint">
        Package the whole AppCrane setup into one zip: the database (apps, users,
        settings, encrypted env vars, roles), the <code>.env</code> (including the
        <code> ENCRYPTION_KEY</code> needed to decrypt secrets), app icons, and every
        app's persistent <code>/data</code> volume. Use it to back up or to stand the
        platform back up on a fresh host. App <b>code</b> is not included (it redeploys
        from GitHub), nor anything OS-level.
      </p>
      <p className="settings-hint" style={{ color: 'var(--yellow)' }}>
        ⚠ The backup contains the <code>ENCRYPTION_KEY</code> and every encrypted secret. Store it somewhere safe.
      </p>

      <h3>Export</h3>
      <button className="btn" onClick={download} disabled={busy}>
        {busy ? 'Packaging…' : '⬇ Download config backup (.zip)'}
      </button>

      <h3 style={{ marginTop: 20 }}>Import</h3>
      <p className="settings-hint">
        Restores a backup onto this host. <b>Destructive</b> — replaces the live database, then
        restarts. The current config is saved to a <code>pre-import-&lt;timestamp&gt;</code> folder first.
      </p>
      <label style={{ display: 'block', margin: '6px 0' }}>
        <input type="checkbox" checked={restoreEnv} onChange={e => setRestoreEnv(e.target.checked)} />
        {' '}Also restore <code>.env</code> (ENCRYPTION_KEY + platform secrets). Leave on when moving to a fresh host.
      </label>
      <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) doImport(f) }} />
      <button className="btn" style={{ background: 'var(--red)', color: '#fff' }}
        onClick={() => fileRef.current?.click()} disabled={importing}>
        {importing ? 'Importing…' : '⬆ Import backup (replaces config + restarts)'}
      </button>

      <h3 style={{ marginTop: 24 }}>Scheduled off-site backup (S3)</h3>
      <p className="settings-hint">
        Upload the config backup to an S3 bucket (or S3-compatible store like Cloudflare R2) once a night.
        No-op until you enter a bucket and credentials. The IAM key needs <code>s3:PutObject</code> on the bucket.
      </p>
      <label style={{ display: 'block', margin: '6px 0' }}>
        <input type="checkbox" checked={!!s3.enabled} onChange={e => setS3(s => ({ ...s, enabled: e.target.checked }))} />
        {' '}Enable nightly S3 backup
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, maxWidth: 540, alignItems: 'center', margin: '8px 0' }}>
        <label>Bucket</label><input className="editable" value={s3.bucket ?? ''} onChange={e => setS3(s => ({ ...s, bucket: e.target.value }))} placeholder="my-appcrane-backups" />
        <label>Region</label><input className="editable" value={s3.region ?? ''} onChange={e => setS3(s => ({ ...s, region: e.target.value }))} placeholder="us-east-1" />
        <label>Prefix</label><input className="editable" value={s3.prefix ?? ''} onChange={e => setS3(s => ({ ...s, prefix: e.target.value }))} placeholder="(optional) appcrane/" />
        <label>Endpoint</label><input className="editable" value={s3.endpoint ?? ''} onChange={e => setS3(s => ({ ...s, endpoint: e.target.value }))} placeholder="(optional — set for R2/MinIO)" />
        <label>Access key</label><input className="editable" value={s3.access_key_id ?? ''} onChange={e => setS3(s => ({ ...s, access_key_id: e.target.value }))} placeholder="AKIA…" />
        <label>Secret key</label><input className="editable" type="password" value={s3Secret} onChange={e => setS3Secret(e.target.value)} placeholder={s3.has_secret ? '•••• stored — blank keeps current' : 'secret access key'} />
        <label>Hour (0–23)</label><input className="editable" type="number" min={0} max={23} value={s3.hour ?? 3} onChange={e => setS3(s => ({ ...s, hour: Number(e.target.value) }))} style={{ width: 90 }} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={saveS3} disabled={s3Busy}>Save S3 settings</button>
        <button className="btn" onClick={runS3Now} disabled={s3Busy}>{s3Busy ? '…' : 'Back up to S3 now'}</button>
      </div>
      {s3.last_run && <p className="settings-hint" style={{ marginTop: 6 }}>Last off-site backup: {new Date(s3.last_run).toLocaleString()}</p>}
      {s3.last_error && <p style={{ color: 'var(--red)', fontSize: '.8rem' }}>Last error: {s3.last_error}</p>}

      {msg && <p style={{ color: msg.ok ? 'var(--green)' : 'var(--red)', marginTop: 12 }}>{msg.text}</p>}
    </div>
  )
}

type Tab = 'security' | 'users' | 'roles' | 'github' | 'mail' | 'backup' | 'branding' | 'audit' | 'mcp' | 'skills'

const VALID_TABS: Tab[] = ['security', 'users', 'roles', 'github', 'mail', 'backup', 'branding', 'audit', 'mcp', 'skills']

function getTab(): Tab {
  const hash = window.location.hash.replace('#', '') as Tab
  return VALID_TABS.includes(hash) ? hash : 'security'
}

export function Settings() {
  const me = useMe()
  const isPlatformAdmin = me?.user?.role === 'platform_admin'
  const adminLike = isAdmin(me)
  const [tab, setTab] = useState<Tab>(getTab)

  useEffect(() => {
    const handler = () => setTab(getTab())
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  // v2.45.2: mount a tab the first time it is shown, and keep it mounted after.
  //
  // Every panel used to mount on arrival and only be hidden with display:none,
  // so opening Settings fired the fetches for ALL of them — around 25 requests
  // to render one tab, including three separate /api/apps calls and one
  // /api/server/tls-check that reaches out to the internet twice.
  //
  // Switching to plain conditional rendering would have fixed the burst and
  // broken something real: a half-filled form would be thrown away every time
  // the user looked at another tab and came back. Keeping visited tabs mounted
  // preserves that exactly as before — the cost is only paid for tabs actually
  // opened, and only once each.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>([getTab()]))
  useEffect(() => {
    setVisited(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [tab])

  // v2.13.0: MCP moved under Settings, reachable by app-owners too. The other
  // tabs are platform-admin-only — and since every tab mounts (display-toggled),
  // rendering them for a non-platform-admin would fire their admin-only fetches
  // (403 noise). So owners get ONLY the MCP tab here.
  if (me === null) {
    return <div className="container"><p style={{ color: 'var(--dim)' }}>Loading…</p></div>
  }
  if (!isPlatformAdmin) {
    // Owners get MCP only; admins also get Skills — tab-switched. The other
    // platform-admin tabs are not mounted here (they'd fire admin-only fetches).
    const showSkills = tab === 'skills' && adminLike
    return (
      <div className="container">
        {adminLike && <div style={{ display: showSkills ? 'block' : 'none' }}><SkillsTab /></div>}
        <div style={{ display: showSkills ? 'none' : 'block' }}><Mcp /></div>
      </div>
    )
  }

  // Rendered through one helper so a tab added later cannot quietly go back to
  // mounting on arrival — the visited check is not something to remember to
  // repeat by hand ten times.
  const panel = (key: Tab, node: ReactNode) => visited.has(key) && (
    <div style={{ display: tab === key ? 'block' : 'none' }}>{node}</div>
  )

  return (
    <div className="container">
      {panel('mcp', <Mcp />)}
      {panel('skills', <SkillsTab />)}
      {panel('security', <SecurityTab />)}
      {panel('users', <Users />)}
      {panel('roles', <RolesTab />)}
      {panel('github', <GithubTab />)}
      {panel('mail', <MailTab />)}
      {panel('backup', <BackupTab />)}
      {/* v2.6.9: skills tab removed from Settings — now top-level /skills */}
      {panel('branding', <BrandingTab />)}
      {panel('audit', <AuditLog />)}
    </div>
  )
}

