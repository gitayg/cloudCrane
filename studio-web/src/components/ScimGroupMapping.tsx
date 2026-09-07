import { useEffect, useState } from 'react'
import { adminApi } from '../adminApi'

/**
 * Group → app access — the half of SCIM group provisioning the IdP may NOT write.
 *
 * The IdP owns membership: who is in "Engineering" is pushed to /api/scim/v2/Groups
 * and AppCrane stores it verbatim. That membership grants nothing on its own. What a
 * group is WORTH is this mapping — group → app + role — and it is deliberately
 * platform-admin-only (PUT /api/auth/scim/groups/:id/apps rejects the SCIM bearer
 * token), so "rename a group in Okta" is not a route to somebody else's production
 * env vars.
 *
 * Everything on this screen is live access. Adding a row gives every current member
 * of that group the chosen role on that app; removing one takes it away from all of
 * them. The server reconciles immediately and reports how many people were affected,
 * which is echoed back in the confirmation line rather than left implicit.
 */

const CSS = `
.sgm-wrap{border-top:1px solid var(--border);margin-top:18px;padding-top:16px}
.sgm-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.sgm-head h4{font-size:.88rem;font-weight:600;margin:0}
.sgm-count{font-size:.74rem;color:var(--dim)}
.sgm-lede{font-size:.82rem;color:var(--dim);line-height:1.55;margin:0 0 12px}
.sgm-lede strong{color:var(--text)}
.sgm-msg{padding:7px 11px;border-radius:6px;font-size:.82rem;margin-bottom:10px}
.sgm-msg-ok{background:#22c55e18;border:1px solid #22c55e44;color:var(--green)}
.sgm-msg-err{background:#ef444418;border:1px solid #ef444444;color:var(--red)}
.sgm-note{font-size:.82rem;color:var(--dim);line-height:1.6}
.sgm-empty{background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:12px 14px;font-size:.82rem;color:var(--dim);line-height:1.6}
.sgm-empty strong{color:var(--text)}
.sgm-empty code{font-family:'SF Mono',Monaco,monospace;font-size:.78rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;word-break:break-all}
.sgm-group{background:var(--surface2);border:1px solid var(--border);border-radius:7px;margin-bottom:10px}
.sgm-group-hdr{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--border)}
.sgm-group-name{font-size:.86rem;font-weight:600}
.sgm-group-meta{font-size:.73rem;color:var(--dim)}
.sgm-group-ext{font-size:.72rem;color:var(--dim);font-family:'SF Mono',Monaco,monospace}
.sgm-group-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.sgm-grant{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sgm-grant-app{font-size:.83rem;min-width:150px}
.sgm-grant-slug{font-size:.72rem;color:var(--dim);font-family:'SF Mono',Monaco,monospace}
.sgm-sentence{font-size:.76rem;color:var(--dim)}
.sgm-add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:9px;border-top:1px dashed var(--border)}
.sgm-none{font-size:.79rem;color:var(--dim)}
.sgm-wrap select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:5px;font-size:.8rem}
`

/** Mirrors the VALID set in scimAdminRouter.put('/groups/:id/apps'). 'none' is
 *  excluded there, so it is not offered here — removing the row is how you say no. */
const ROLES = ['user', 'admin', 'owner'] as const
type GrantRole = typeof ROLES[number]

const ROLE_BLURB: Record<GrantRole, string> = {
  user: 'Can open and use the app.',
  admin: 'Can use the app and manage it — deploy, read env, change settings.',
  owner: 'Full control of the app, including deleting it.',
}

interface GrantedApp {
  app_id: number
  app_role: GrantRole
  slug: string
  name: string
}

interface ScimGroup {
  id: number
  display_name: string
  external_id: string | null
  created_at: string | null
  updated_at: string | null
  member_count: number
  apps: GrantedApp[]
}

interface AppOption {
  slug: string
  name: string
}

interface ScimGroupMappingProps {
  /** SCIM base URL from GET /api/auth/scim/config — shown in the empty state so an
   *  admin whose IdP has pushed nothing yet knows where groups are meant to arrive. */
  baseUrl?: string
}

export function ScimGroupMapping({ baseUrl }: ScimGroupMappingProps) {
  const [groups, setGroups] = useState<ScimGroup[] | null>(null)
  const [apps, setApps] = useState<AppOption[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [saving, setSaving] = useState<Record<number, boolean>>({})
  const [draft, setDraft] = useState<Record<number, { slug: string; role: GrantRole }>>({})

  function flash(text: string, ok: boolean) {
    setMsg({ text, ok })
    setTimeout(() => setMsg(m => (m && m.text === text ? null : m)), 6000)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      adminApi.get<{ groups: ScimGroup[] }>('/api/auth/scim/groups'),
      adminApi.get<{ apps: AppOption[] }>('/api/apps').catch(() => ({ apps: [] as AppOption[] })),
    ])
      .then(([g, a]) => {
        if (cancelled) return
        setGroups(g.groups || [])
        setApps(a.apps || [])
      })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message) })
    return () => { cancelled = true }
  }, [])

  /** The one write this screen makes. PUT replaces the whole mapping for a group,
   *  so every edit sends the full intended list — never a delta. */
  async function writeMapping(group: ScimGroup, next: GrantedApp[], describe: (affected: number) => string) {
    setSaving(s => ({ ...s, [group.id]: true }))
    try {
      const r = await adminApi.put<{ apps: { app_id: number; slug: string; app_role: GrantRole }[]; affected_users: number }>(
        `/api/auth/scim/groups/${group.id}/apps`,
        { apps: next.map(a => ({ slug: a.slug, app_role: a.app_role })) },
      )
      // Keyed by slug, not app_id: a row added in this session carries a
      // placeholder id until the server answers with the real one.
      const bySlug = new Map(next.map(a => [a.slug, a]))
      const saved: GrantedApp[] = (r.apps || []).map(a => ({
        app_id: a.app_id,
        slug: a.slug,
        app_role: a.app_role,
        name: bySlug.get(a.slug)?.name ?? a.slug,
      }))
      setGroups(list => (list || []).map(g => (g.id === group.id ? { ...g, apps: saved } : g)))
      flash(describe(r.affected_users ?? 0), true)
    } catch (e) {
      flash((e as Error).message, false)
    } finally {
      setSaving(s => { const c = { ...s }; delete c[group.id]; return c })
    }
  }

  function addGrant(group: ScimGroup) {
    const d = draft[group.id]
    if (!d?.slug) return
    const app = apps.find(a => a.slug === d.slug)
    if (!app) return
    const role = d.role || 'user'
    const next: GrantedApp[] = [...group.apps, { app_id: -1, slug: app.slug, name: app.name, app_role: role }]
    setDraft(p => ({ ...p, [group.id]: { slug: '', role } }))
    writeMapping(group, next, n =>
      `Everyone in "${group.display_name}" now has ${role} on ${app.name}. ${n} ${n === 1 ? 'person has' : 'people have'} access through this group's mappings.`)
  }

  function changeRole(group: ScimGroup, grant: GrantedApp, role: GrantRole) {
    if (role === grant.app_role) return
    const next = group.apps.map(a => (a.app_id === grant.app_id ? { ...a, app_role: role } : a))
    writeMapping(group, next, () =>
      `Everyone in "${group.display_name}" is now ${role} on ${grant.name}.`)
  }

  function removeGrant(group: ScimGroup, grant: GrantedApp) {
    const n = group.member_count
    const who = n === 0
      ? 'The group is empty right now, so nobody loses access today — but anyone the IdP adds later will no longer get it either.'
      : `${n} ${n === 1 ? 'person' : 'people'} in this group will lose ${grant.app_role} access to ${grant.name} immediately.`
    if (!confirm(`Remove ${grant.app_role} on "${grant.name}" from the group "${group.display_name}"?\n\n${who}\n\nThis revokes real access. Members who also have access another way keep that.`)) return
    const next = group.apps.filter(a => a.app_id !== grant.app_id)
    writeMapping(group, next, () =>
      `"${group.display_name}" no longer grants access to ${grant.name}.`)
  }

  const groupsUrl = baseUrl ? baseUrl.replace(/\/$/, '') + '/Groups' : null

  return (
    <div className="sgm-wrap">
      <style>{CSS}</style>

      <div className="sgm-head">
        <h4>Group access</h4>
        {groups !== null && (
          <span className="sgm-count">
            {groups.length === 0 ? 'no groups yet' : `${groups.length} group${groups.length === 1 ? '' : 's'} from your IdP`}
          </span>
        )}
      </div>

      <p className="sgm-lede">
        Groups pushed by your IdP grant nothing on their own. A mapping here is what makes
        membership mean something: <strong>everyone the IdP puts in the group receives that role
        on that app</strong>, and anyone it removes loses it. Only a platform admin can set this —
        your SCIM token cannot.
      </p>

      {msg && <div className={'sgm-msg ' + (msg.ok ? 'sgm-msg-ok' : 'sgm-msg-err')}>{msg.text}</div>}
      {loadError && <div className="sgm-msg sgm-msg-err">Could not load groups: {loadError}</div>}

      {groups === null ? (
        !loadError && <div className="sgm-note">Loading groups…</div>
      ) : groups.length === 0 ? (
        <div className="sgm-empty">
          <strong>Your IdP has not pushed any groups yet.</strong> Nothing is broken — groups appear
          here the first time Okta, Entra ID or another provider provisions one
          {groupsUrl ? <> to <code>{groupsUrl}</code></> : null}. Enable SCIM above, generate a bearer
          token, assign a group to AppCrane in your IdP, then come back and decide what each group
          is allowed to reach.
        </div>
      ) : (
        groups.map(group => {
          const busy = !!saving[group.id]
          const taken = new Set(group.apps.map(a => a.slug))
          const available = apps.filter(a => !taken.has(a.slug))
          const d = draft[group.id] || { slug: '', role: 'user' as GrantRole }
          return (
            <div className="sgm-group" key={group.id}>
              <div className="sgm-group-hdr">
                <span className="sgm-group-name">{group.display_name}</span>
                <span className="sgm-group-meta">
                  {group.member_count} {group.member_count === 1 ? 'member' : 'members'}
                </span>
                {group.external_id && (
                  <span className="sgm-group-ext" title="The IdP's own id for this group">{group.external_id}</span>
                )}
                {busy && <span className="sgm-group-meta">saving…</span>}
              </div>

              <div className="sgm-group-body">
                {group.apps.length === 0 ? (
                  <div className="sgm-none">
                    Grants no access. Members of this group get nothing from it until you add an app below.
                  </div>
                ) : (
                  group.apps.map(grant => (
                    <div className="sgm-grant" key={grant.app_id}>
                      <span className="sgm-grant-app">
                        {grant.name} <span className="sgm-grant-slug">{grant.slug}</span>
                      </span>
                      <select
                        value={grant.app_role}
                        disabled={busy}
                        aria-label={`Role granted on ${grant.name} to members of ${group.display_name}`}
                        title={ROLE_BLURB[grant.app_role]}
                        onChange={e => changeRole(group, grant, e.target.value as GrantRole)}
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <span className="sgm-sentence">
                        all {group.member_count} {group.member_count === 1 ? 'member' : 'members'} get this
                      </span>
                      <button
                        type="button"
                        className="btn btn-xs btn-red"
                        disabled={busy}
                        title={`Revoke ${grant.app_role} on ${grant.name} from everyone in ${group.display_name}`}
                        onClick={() => removeGrant(group, grant)}
                      >remove</button>
                    </div>
                  ))
                )}

                {apps.length === 0 ? (
                  <div className="sgm-none">No applications exist yet, so there is nothing to grant.</div>
                ) : available.length === 0 ? (
                  <div className="sgm-none">This group already maps to every application.</div>
                ) : (
                  <div className="sgm-add">
                    <select
                      value={d.slug}
                      disabled={busy}
                      aria-label={`Application to grant to ${group.display_name}`}
                      onChange={e => setDraft(p => ({ ...p, [group.id]: { ...d, slug: e.target.value } }))}
                    >
                      <option value="">Choose an application…</option>
                      {available.map(a => <option key={a.slug} value={a.slug}>{a.name}</option>)}
                    </select>
                    <select
                      value={d.role}
                      disabled={busy}
                      aria-label={`Role to grant to ${group.display_name}`}
                      title={ROLE_BLURB[d.role]}
                      onChange={e => setDraft(p => ({ ...p, [group.id]: { ...d, role: e.target.value as GrantRole } }))}
                    >
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <button
                      type="button"
                      className="btn btn-xs btn-accent"
                      disabled={busy || !d.slug}
                      onClick={() => addGrant(group)}
                    >Grant access</button>
                    <span className="sgm-sentence">
                      {ROLE_BLURB[d.role]} Applies to all {group.member_count}{' '}
                      {group.member_count === 1 ? 'member' : 'members'} at once.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
