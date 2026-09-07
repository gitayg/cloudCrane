import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from '../adminApi'
import { useAppTabs } from '../components/AppTabsContext'

// v2.59.x: the app catalogue — 76 curated self-hostable business apps, readable
// by EVERY logged-in user and deployable by whoever holds `platform.create_app`.
//
// The page owns no install endpoint. It posts to the existing POST /api/apps,
// which already carries the permission gate, the audit middleware and the
// validation. A second route into app creation would be a second authorization
// surface to keep in sync with the first.
//
// Everything numeric here is fetched live by the server and cached; nothing is
// committed to the repo, and nothing image-shaped is downloaded by this page or
// by AppCrane until a deploy runs `docker pull` on the host.

// ---------------------------------------------------------------------------
// The API contract (server/routes/catalog.js). Every field is optional on the
// way in: the enrichment cache is allowed to be empty, an entry's `image` is
// allowed to be null, and a figure that upstream would not hand over is
// legitimately absent. Absent renders as a stated fact, never as a spinner
// that never resolves.
// ---------------------------------------------------------------------------

interface CatalogVersion {
  value?: string
  kind?: string                 // 'release' | 'tag'
  published_at?: string | null
}

interface Enrichment {
  stars?: number | null
  pulls?: number | null
  github_version?: CatalogVersion | null
  image_version?: CatalogVersion | null
  image_size?: number | null
  sources?: { github?: string; image?: string }
  fetched_at?: string | null
}

interface InstalledRef {
  slug: string
  name: string
  matched_on?: string           // 'repo' | 'image'
}

interface CatalogEntry {
  name: string
  slug: string
  category?: string
  repo?: string                 // 'owner/name'
  image?: string | null         // MAY be null — the entry is GitHub-only then
  home?: string
  license?: string
  short?: string
  enrichment?: Enrichment | null
  installed?: InstalledRef[]
  is_installed?: boolean
}

interface EnrichmentStatus {
  entries_cached?: number
  entries_with_figures?: number
  fetched_at?: string | null
  last_attempt_at?: string | null
  stale?: boolean
  refreshing?: boolean
  degraded?: boolean
}

interface CatalogResponse {
  catalog?: CatalogEntry[]
  count?: number
  categories?: string[]
  can_create_app?: boolean
  enrichment?: EnrichmentStatus
}

interface GithubVersions {
  source?: string               // 'releases' | 'tags' | 'none'
  releases?: { name: string; published_at?: string | null; prerelease?: boolean }[]
  tags?: { name: string }[]
  available?: boolean
  error?: string | null
}

interface ImageVersions {
  ref?: string | null
  source?: string               // 'dockerhub' | 'no-image' | 'unsupported-registry'
  tags?: { name: string; last_updated?: string | null }[]
  available?: boolean
  error?: string | null
}

interface VersionsResponse {
  slug?: string
  name?: string
  cap?: number
  github?: GithubVersions
  image?: ImageVersions
  fetched_at?: string
  cached?: boolean
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 12345 -> '12.3k'. Null for anything that is not a real number. */
function fmtSize(n: number | null | undefined): string | null {
  // Docker Hub's `full_size` is the COMPRESSED size — the bytes the host pulls,
  // not what the image occupies unpacked. Rendered in decimal MB/GB to match how
  // registries and hosting providers quote transfer.
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + ' GB'
  return Math.round(n / 1e6) + ' MB'
}

function fmtCount(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const trim = (s: string) => s.replace(/\.0$/, '')
  if (n >= 1e9) return trim((n / 1e9).toFixed(1)) + 'B'
  if (n >= 1e6) return trim((n / 1e6).toFixed(1)) + 'M'
  if (n >= 1e3) return trim((n / 1e3).toFixed(1)) + 'k'
  return String(n)
}

/**
 * Why a version is missing, in words. The server reports the reason it failed
 * to learn one; a blank cell would read as "still loading" forever, and "0"
 * would be a lie.
 */
function absenceReason(source: string | undefined, what: 'github' | 'image'): string {
  switch (source) {
    case 'none':
      return what === 'github' ? 'no release or tag published' : 'no tag published'
    case 'no-image':
      return 'no published image'
    case 'unsupported-registry':
      return 'registry does not publish tag metadata'
    case 'invalid-repo':
      return 'repository reference could not be resolved'
    case 'rate-limited':
      return 'upstream is rate-limiting — try later'
    case 'timeout':
    case 'network-error':
      return 'upstream did not answer'
    case 'not-found':
      return 'upstream returned 404'
    case undefined:
      return 'not fetched yet'
    default:
      return `upstream said ${source}`
  }
}

/** 'akaunting/akaunting:1.2' -> 'akaunting/akaunting'. A registry port is not a tag. */
function imageBase(ref: string): string {
  const at = ref.indexOf('@')
  const base = at === -1 ? ref : ref.slice(0, at)
  const colon = base.lastIndexOf(':')
  if (colon === -1) return base
  // 'localhost:5000/odoo' — the ':' belongs to the host, not to a tag.
  if (base.slice(colon + 1).includes('/')) return base
  return base.slice(0, colon)
}

function repoUrl(repo: string | undefined): string | null {
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo.trim())) return null
  return 'https://github.com/' + repo.trim()
}

/** Docker Hub is the only registry the manifest names, so it is the only one linked. */
function imageUrl(image: string | null | undefined): string | null {
  if (!image) return null
  const base = imageBase(image.trim())
  if (base.includes('.') || base.split('/').length > 2) return null   // not a plain Hub ref
  const parts = base.split('/')
  if (parts.length === 1) return 'https://hub.docker.com/_/' + parts[0]
  return 'https://hub.docker.com/r/' + parts[0] + '/' + parts[1]
}

/** A slug POST /api/apps will accept: ^[a-z0-9][a-z0-9-]*$ */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+/, '').slice(0, 60)
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
// Mirrors the server's branch check in routes/apps.js — branch flows into a shell.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/

type SortKey = 'name' | 'category' | 'stars' | 'pulls' | 'size'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Catalog() {
  const navigate = useNavigate()
  const { addTab } = useAppTabs()

  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [canCreate, setCanCreate] = useState<boolean | null>(null)
  const [status, setStatus] = useState<EnrichmentStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [installEntry, setInstallEntry] = useState<CatalogEntry | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    adminApi.get<CatalogResponse>('/api/catalog')
      .then(r => {
        setEntries(Array.isArray(r?.catalog) ? r.catalog : [])
        setCategories(Array.isArray(r?.categories) ? r.categories : [])
        setCanCreate(r?.can_create_app === true)
        setStatus(r?.enrichment ?? null)
        setLoadError(null)
      })
      .catch(err => {
        setLoadError(err instanceof Error ? err.message : String(err))
        setEntries(prev => prev ?? [])
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // GET /api/catalog kicks off the enrichment fetch and returns IMMEDIATELY —
  // the figures land a couple of seconds later, in the server's cache, with
  // nothing to tell this page. Without this poll the first visit always renders
  // empty and blames GitHub and Docker Hub for being unreachable when the fetch
  // is in flight and about to succeed; the only cure was for the user to guess
  // and hit Reload.
  //
  // Poll only while a refresh is actually running, and give up after a bounded
  // number of attempts so a permanently degraded upstream cannot leave a tab
  // requesting forever.
  const POLL_MS = 2000
  const POLL_MAX = 15
  useEffect(() => {
    if (!status?.refreshing) return
    let attempts = 0
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled || ++attempts > POLL_MAX) { clearInterval(id); return }
      try {
        const r = await adminApi.get<CatalogResponse>('/api/catalog')
        if (cancelled) return
        if (Array.isArray(r?.catalog)) setEntries(r.catalog)
        setStatus(r?.enrichment ?? null)
        if (!r?.enrichment?.refreshing) clearInterval(id)
      } catch { /* a failed poll is not worth surfacing; the banner already says what is known */ }
    }, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [status?.refreshing])

  // Categories come from the payload, but an entry carrying a category the
  // server did not list still has to be filterable.
  const allCategories = useMemo(() => {
    const set = new Set(categories)
    for (const e of entries || []) if (e.category) set.add(e.category)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [categories, entries])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = (entries || []).filter(e => {
      if (category && e.category !== category) return false
      if (installedOnly && !e.is_installed) return false
      if (!q) return true
      return [e.name, e.short, e.category, e.repo, e.image, e.license]
        .some(v => typeof v === 'string' && v.toLowerCase().includes(q))
    })
    const dir = sortDir === 'asc' ? 1 : -1
    const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : -1)
    return rows.sort((a, b) => {
      switch (sortKey) {
        case 'category':
          return dir * ((a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
        case 'stars':
          return dir * (num(a.enrichment?.stars) - num(b.enrichment?.stars)) || a.name.localeCompare(b.name)
        case 'pulls':
          return dir * (num(a.enrichment?.pulls) - num(b.enrichment?.pulls)) || a.name.localeCompare(b.name)
        case 'size':
          return dir * (num(a.enrichment?.image_size) - num(b.enrichment?.image_size)) || a.name.localeCompare(b.name)
        default:
          return dir * a.name.localeCompare(b.name)
      }
    })
  }, [entries, query, category, installedOnly, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return }
    setSortKey(key)
    // Counts read best largest-first; names read best A→Z.
    setSortDir(key === 'stars' || key === 'pulls' || key === 'size' ? 'desc' : 'asc')
  }

  const openInstalled = (ref: InstalledRef) => {
    addTab({ slug: ref.slug, name: ref.name })
    navigate('/launch/' + ref.slug)
  }

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
  const sortAria = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'

  const th = (key: SortKey, label: string, extra?: React.CSSProperties) => (
    <th
      className="th-sort"
      style={extra}
      tabIndex={0}
      role="columnheader"
      aria-sort={sortAria(key)}
      onClick={() => toggleSort(key)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(key) } }}
      title={`Sort by ${label.toLowerCase()}`}
    >{label}{sortIndicator(key)}</th>
  )

  return (
    <div className="container">
      <h2>App Catalogue</h2>

      <p style={{ margin: '0 0 14px', fontSize: '.85rem', color: 'var(--dim)', maxWidth: 760, lineHeight: 1.5 }}>
        Curated self-hostable business apps you can deploy onto this AppCrane instance. Stars, pull counts
        and versions are fetched live from GitHub and Docker Hub and cached — nothing here is a number
        written into the repo.
      </p>

      {loadError && (
        <div
          role="alert"
          style={{
            border: '1px solid rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)',
            borderRadius: 6, padding: '10px 12px', marginBottom: 12, fontSize: '.82rem',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}
        >
          <span>Could not load the catalogue: {loadError}</span>
          <button className="btn btn-xs" onClick={load}>Retry</button>
        </div>
      )}

      {canCreate === false && (
        <div
          style={{
            border: '1px solid var(--border)', background: 'var(--surface2)',
            borderRadius: 6, padding: '10px 12px', marginBottom: 12, fontSize: '.82rem', lineHeight: 1.5,
          }}
        >
          <strong>Browsing only.</strong> Deploying from the catalogue needs the{' '}
          <code style={{ fontFamily: 'monospace' }}>platform.create_app</code> permission, which your account
          does not hold — so the Deploy buttons are disabled rather than offered and then refused. A platform
          admin can grant it under Settings → Roles, or create the app for you.
        </div>
      )}

      <div className="filter-row">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search name, description, repo, image…"
          aria-label="Search the catalogue"
          style={{ minWidth: 260, flex: '1 1 260px', maxWidth: 420 }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories{allCategories.length ? ` (${allCategories.length})` : ''}</option>
          {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.82rem', color: 'var(--dim)' }}>
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={e => setInstalledOnly(e.target.checked)}
          />
          Installed only
        </label>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Reloading…' : 'Reload'}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--dim)' }}>
          {entries === null
            ? 'Loading catalogue…'
            : `${visible.length} of ${entries.length} app${entries.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {status && (
        <div style={{ fontSize: '.75rem', color: 'var(--dim)', margin: '-4px 0 10px' }}>
          {status.refreshing && !status.fetched_at
            ? 'Fetching live figures…'
            : status.degraded
            ? 'No live figures cached yet — GitHub and Docker Hub are unreachable or rate-limiting. Names, descriptions and deploy paths still work.'
            : status.fetched_at
              ? `Live figures cached ${new Date(status.fetched_at).toLocaleString()}${status.refreshing ? ' · refreshing in the background' : status.stale ? ' · stale, refresh queued' : ''}`
              : status.refreshing
                ? 'Fetching live figures in the background — reload in a moment.'
                : 'Live figures have not been fetched yet.'}
        </div>
      )}

      <div className="apps-table-wrap">
        <table className="apps-table">
          <thead>
            <tr>
              <th style={{ width: 28 }} aria-label="Expand" />
              {th('name', 'Application', { minWidth: 160 })}
              <th style={{ minWidth: 240 }}>What it does</th>
              {th('category', 'Category', { minWidth: 110 })}
              {th('stars', 'Stars', { minWidth: 80 })}
              {th('pulls', 'Pulls', { minWidth: 90 })}
              {th('size', 'Size', { minWidth: 80 })}
              <th style={{ minWidth: 190 }}>Version</th>
              <th style={{ minWidth: 150 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries === null && (
              <tr><td colSpan={9} style={{ color: 'var(--dim)', padding: '18px 8px' }}>Loading catalogue…</td></tr>
            )}
            {entries !== null && visible.length === 0 && (
              <tr>
                <td colSpan={9} style={{ color: 'var(--dim)', padding: '18px 8px' }}>
                  {entries.length === 0
                    ? 'The catalogue is empty — the manifest could not be read on the server.'
                    : 'No app matches this search.'}
                </td>
              </tr>
            )}
            {visible.map(e => (
              <CatalogRow
                key={e.slug}
                entry={e}
                expanded={openSlug === e.slug}
                onToggle={() => setOpenSlug(s => (s === e.slug ? null : e.slug))}
                canCreate={canCreate === true}
                onInstall={() => setInstallEntry(e)}
                onOpen={openInstalled}
              />
            ))}
          </tbody>
        </table>
      </div>


      {installEntry && (
        <InstallDialog
          entry={installEntry}
          onClose={() => setInstallEntry(null)}
          onCreated={() => { setInstallEntry(null); load() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One row (+ its detail row)
// ---------------------------------------------------------------------------

function CatalogRow({ entry, expanded, onToggle, canCreate, onInstall, onOpen }: {
  entry: CatalogEntry
  expanded: boolean
  onToggle: () => void
  canCreate: boolean
  onInstall: () => void
  onOpen: (ref: InstalledRef) => void
}) {
  const en = entry.enrichment || null
  const stars = fmtCount(en?.stars)
  const pulls = fmtCount(en?.pulls)
  const size = fmtSize(en?.image_size)
  const installed = entry.installed || []
  const gh = repoUrl(entry.repo)
  const hub = imageUrl(entry.image)

  return (
    <>
      <tr>
        <td>
          <button
            className="apps-row-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `Hide details for ${entry.name}` : `Show details for ${entry.name}`}
            title={expanded ? 'Hide details' : 'Show details'}
          >{expanded ? '▾' : '▸'}</button>
        </td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* The project's GitHub owner avatar, derived from `repo` — no extra
                data to curate and no per-entry logo URL to rot. It is fetched by
                the VIEWER's browser from github.com; if that outbound call is
                unwanted on a locked-down deployment, drop this img and the row
                still reads fine. A 404 (rare, but orgs get renamed) hides the
                element rather than showing a broken-image glyph. */}
            <img
              src={`https://github.com/${(entry.repo || '').split('/')[0]}.png?size=48`}
              alt=""
              width={22}
              height={22}
              loading="lazy"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
              style={{ borderRadius: 4, flex: 'none', background: 'var(--surface)' }}
            />
            <span style={{ fontWeight: 600 }}>{entry.name}</span>
          </div>
          <div style={{ fontSize: '.7rem', color: 'var(--dim)', fontFamily: 'monospace' }}>{entry.repo || '—'}</div>
        </td>
        <td style={{ color: 'var(--dim)' }}>{entry.short || <span title="No description in the manifest">—</span>}</td>
        <td><span className="tag">{entry.category || 'Uncategorized'}</span></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {stars
            ? <span title={`${en?.stars?.toLocaleString()} GitHub stars`}>★ {stars}</span>
            : <span style={{ color: 'var(--dim)' }} title={absenceReason(en?.sources?.github, 'github')}>—</span>}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {pulls
            ? <span title={`${en?.pulls?.toLocaleString()} Docker Hub pulls — CI runs and layer re-pulls count too, so read it as an order of magnitude`}>⇩ {pulls}</span>
            : <span style={{ color: 'var(--dim)' }} title={absenceReason(en?.sources?.image, 'image')}>—</span>}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {size
            ? <span title={`${en?.image_size?.toLocaleString()} bytes compressed — the download, not the unpacked size on disk`}>{size}</span>
            : <span style={{ color: 'var(--dim)' }} title={absenceReason(en?.sources?.image, 'image')}>—</span>}
        </td>
        <td><VersionCell entry={entry} /></td>
        <td>
          {installed.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              <span className="badge badge-live" title={
                installed.map(i => `${i.name} — matched on ${i.matched_on === 'image' ? 'image' : 'repository'}`).join('\n')
              }>Installed</span>
              {installed.map(i => (
                <button
                  key={i.slug}
                  className="btn btn-xs"
                  onClick={() => onOpen(i)}
                  title={`Open ${i.name} on this instance`}
                >Open {installed.length > 1 ? i.name : ''}</button>
              ))}
            </div>
          ) : (
            <button
              className="btn btn-xs btn-accent"
              onClick={onInstall}
              disabled={!canCreate}
              title={canCreate
                ? `Deploy ${entry.name} onto this instance`
                : 'You do not hold platform.create_app — ask a platform admin'}
            >Deploy…</button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="apps-row-drill">
          {/* The table is wider than the viewport and .apps-table-wrap scrolls
              horizontally, so a colSpan={9} cell is as wide as the TABLE, not the
              screen — its right-hand content ends up off-screen. `position: sticky;
              left: 0` pins the panel to the visible left edge while the table
              scrolls under it, and the width cap stops it stretching to the full
              table width. */}
          <td colSpan={9} style={{ padding: 0 }}>
            <div style={{
              position: 'sticky', left: 0,
              width: 'min(100%, 1040px)',
              padding: '10px 8px 14px',
              display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: '.8rem',
            }}>
              <div style={{ minWidth: 220, flex: '1 1 260px' }}>
                <div className="apps-drill-env-hdr">Project</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    <span style={{ color: 'var(--dim)' }}>Repository: </span>
                    {gh ? <a href={gh} target="_blank" rel="noreferrer noopener">{entry.repo}</a> : (entry.repo || '—')}
                  </div>
                  <div>
                    <span style={{ color: 'var(--dim)' }}>Home: </span>
                    {entry.home
                      ? <a href={entry.home} target="_blank" rel="noreferrer noopener">{entry.home}</a>
                      : '—'}
                  </div>
                  <div>
                    <span style={{ color: 'var(--dim)' }}>Image: </span>
                    {entry.image
                      ? (hub
                          ? <a href={hub} target="_blank" rel="noreferrer noopener" style={{ fontFamily: 'monospace' }}>{entry.image}</a>
                          : <code style={{ fontFamily: 'monospace' }}>{entry.image}</code>)
                      : <span style={{ color: 'var(--dim)' }}>none — this entry deploys from source only</span>}
                  </div>
                </div>
              </div>

              <div style={{ minWidth: 220, flex: '1 1 260px' }}>
                <div className="apps-drill-env-hdr">Licence</div>
                <div style={{ lineHeight: 1.5 }}>
                  <code style={{ fontFamily: 'monospace' }}>{entry.license || 'unknown'}</code>
                  {entry.license === 'NOASSERTION' && (
                    <div style={{ color: 'var(--dim)', marginTop: 4 }}>
                      GitHub could not match this project's licence file to a standard licence. Read the
                      repository yourself before relying on it commercially — the code is not necessarily
                      unlicensed, only unrecognised.
                    </div>
                  )}
                </div>
              </div>

              <div style={{ minWidth: 220, flex: '1 1 260px' }}>
                <div className="apps-drill-env-hdr">Live figures</div>
                <div style={{ lineHeight: 1.6 }}>
                  <div>
                    <span style={{ color: 'var(--dim)' }}>Stars: </span>
                    {typeof en?.stars === 'number'
                      ? en.stars.toLocaleString()
                      : <span style={{ color: 'var(--dim)' }}>{absenceReason(en?.sources?.github, 'github')}</span>}
                  </div>
                  <div>
                    <span style={{ color: 'var(--dim)' }}>Pulls: </span>
                    {typeof en?.pulls === 'number'
                      ? en.pulls.toLocaleString()
                      : <span style={{ color: 'var(--dim)' }}>{absenceReason(en?.sources?.image, 'image')}</span>}
                  </div>
                  <div style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
                    {en?.fetched_at ? `Fetched ${new Date(en.fetched_at).toLocaleString()}` : 'Not fetched yet'}
                  </div>
                </div>
              </div>

              {installed.length > 0 && (
                <div style={{ minWidth: 220, flex: '1 1 260px' }}>
                  <div className="apps-drill-env-hdr">Already on this instance</div>
                  <div style={{ lineHeight: 1.6 }}>
                    {installed.map(i => (
                      <div key={i.slug}>
                        <button className="btn btn-xs" onClick={() => onOpen(i)}>{i.name}</button>
                        <span style={{ color: 'var(--dim)', marginLeft: 6 }}>
                          matched on {i.matched_on === 'image' ? 'the image reference' : 'the repository URL'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Both versions, labelled, because they are different facts. A GitHub release
 * number beside a deploy-from-image button would imply the image delivers it,
 * and it often does not. Seven of the catalogued projects cut no GitHub
 * Release at all — six carry tags instead, one has neither — so "no release"
 * is a real answer that gets written out rather than left blank.
 */
function VersionCell({ entry }: { entry: CatalogEntry }) {
  const en = entry.enrichment || null
  const ghv = en?.github_version
  const imv = en?.image_version
  const line = (label: string, v: CatalogVersion | null | undefined, absence: string, kindHint?: string) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--dim)', fontSize: '.68rem', textTransform: 'uppercase', letterSpacing: '.4px', minWidth: 46 }}>
        {label}
      </span>
      {v?.value ? (
        <span style={{ fontFamily: 'monospace' }} title={
          [v.kind === 'tag' ? 'Git tag — this project cuts no GitHub Release' : kindHint,
           v.published_at ? `Published ${new Date(v.published_at).toLocaleDateString()}` : null]
            .filter(Boolean).join('\n')
        }>
          {v.value}
          {v.kind === 'tag' && label === 'GitHub' && (
            <span style={{ color: 'var(--dim)', fontSize: '.68rem', marginLeft: 4 }}>(tag)</span>
          )}
        </span>
      ) : (
        <span style={{ color: 'var(--dim)', fontSize: '.72rem' }}>{absence}</span>
      )}
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {line('GitHub', ghv, absenceReason(en?.sources?.github, 'github'), 'GitHub Release')}
      {entry.image
        ? line('Image', imv, absenceReason(en?.sources?.image, 'image'), 'Docker Hub tag')
        : line('Image', null, 'no published image', undefined)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Install dialog
// ---------------------------------------------------------------------------

type SourceChoice = 'github' | 'image'
type RoutingChoice = 'appcrane' | 'domain'

function InstallDialog({ entry, onClose, onCreated }: {
  entry: CatalogEntry
  onClose: () => void
  onCreated: () => void
}) {
  // `image: null` is a normal manifest state, not an error: that entry simply
  // has no published image, so the image path is not offered at all rather
  // than rendered as a button that cannot work.
  const hasImage = typeof entry.image === 'string' && entry.image.trim().length > 0
  const base = hasImage ? imageBase((entry.image as string).trim()) : ''

  const [source, setSource] = useState<SourceChoice>(hasImage ? 'image' : 'github')
  const [name, setName] = useState(entry.name)
  const [slug, setSlug] = useState(slugify(entry.slug || entry.name))
  const [ghVersion, setGhVersion] = useState('')            // '' = default branch
  const [imgVersion, setImgVersion] = useState('')          // '' = nothing chosen yet
  const [customTag, setCustomTag] = useState('')
  const [routing, setRouting] = useState<RoutingChoice>('appcrane')
  const [domain, setDomain] = useState('')
  const [authMode, setAuthMode] = useState<'authenticated' | 'headless'>('authenticated')
  const [containerPort, setContainerPort] = useState('')
  const [healthPath, setHealthPath] = useState('')
  const [ack, setAck] = useState(false)

  const [versions, setVersions] = useState<VersionsResponse | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [done, setDone] = useState<{ slug: string; name: string; deploying: boolean } | null>(null)

  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { firstRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    setVersionsLoading(true)
    adminApi.get<VersionsResponse>('/api/catalog/' + encodeURIComponent(entry.slug) + '/versions')
      .then(r => { if (alive) { setVersions(r || null); setVersionsError(null) } })
      .catch(err => { if (alive) setVersionsError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (alive) setVersionsLoading(false) })
    return () => { alive = false }
  }, [entry.slug])

  const ghChoices = useMemo(() => {
    const g = versions?.github
    const rel = (g?.releases || []).map(r => ({ value: r.name, label: r.name + (r.prerelease ? ' (pre-release)' : ''), group: 'Releases' }))
    const tag = (g?.tags || []).map(t => ({ value: t.name, label: t.name, group: 'Tags' }))
    const seen = new Set<string>()
    return [...rel, ...tag].filter(c => (seen.has(c.value) ? false : (seen.add(c.value), true)))
  }, [versions])

  const imgChoices = useMemo(
    () => (versions?.image?.tags || []).map(t => t.name).filter(n => n && n.toLowerCase() !== 'latest'),
    [versions],
  )

  // The server REFUSES an unpinned image_ref (no tag, or ':latest') — a moving
  // tag makes the digest AppCrane records as the release's identity wrong as
  // soon as upstream pushes. So the image path has no "latest" option at all:
  // a concrete tag is required, and if the tag list could not be fetched the
  // operator types one.
  const effectiveTag = (customTag.trim() || imgVersion.trim())
  const imageRef = hasImage && effectiveTag ? `${base}:${effectiveTag}` : ''

  const slugOk = SLUG_RE.test(slug)
  const branchOk = !ghVersion || BRANCH_RE.test(ghVersion)
  const exposed = routing === 'domain' && authMode === 'headless'
  const portOk = !containerPort.trim() || /^[0-9]{1,5}$/.test(containerPort.trim())
  const healthOk = !healthPath.trim() || healthPath.trim().startsWith('/')

  const blockers: string[] = []
  if (!name.trim()) blockers.push('a name')
  if (!slugOk) blockers.push('a slug of lowercase letters, digits and dashes')
  if (!branchOk) blockers.push('a git ref of letters, digits and . _ / -')
  if (source === 'image' && !effectiveTag) blockers.push('an image tag (":latest" is refused — see below)')
  if (source === 'github' && !repoUrl(entry.repo)) blockers.push('a resolvable GitHub repository in the manifest')
  if (routing === 'domain' && !domain.trim()) blockers.push('the custom domain')
  if (!portOk) blockers.push('a container port between 1 and 65535')
  if (!healthOk) blockers.push("a health path starting with '/'")
  if (exposed && !ack) blockers.push('the acknowledgement below')

  async function submit() {
    setSubmitting(true)
    setError(null)
    setWarning(null)
    const body: Record<string, unknown> = { name: name.trim(), slug }
    if (source === 'github') {
      body.source_type = 'github'
      body.github_url = repoUrl(entry.repo)
      if (ghVersion) body.branch = ghVersion
    } else {
      body.source_type = 'image'
      body.image_ref = imageRef
      if (containerPort.trim()) body.container_port = Number(containerPort.trim())
      if (healthPath.trim()) body.health_path = healthPath.trim()
    }
    if (routing === 'domain' && domain.trim()) body.domain = domain.trim()

    try {
      await adminApi.post('/api/apps', body)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
      return
    }

    // auth_mode is NOT a field POST /api/apps accepts — it is settable only on
    // PUT /api/apps/:slug, and only by the app's owner, which the creator
    // becomes. So 'authenticated' needs nothing (it is the default) and
    // 'headless' is a second call. If that call fails the app still exists and
    // is still behind AppCrane sign-in, which is the safe half of the pair —
    // said out loud rather than swallowed.
    if (authMode === 'headless') {
      try {
        await adminApi.put('/api/apps/' + slug, { auth_mode: 'headless' })
      } catch (err) {
        setWarning(
          'The app was created, but setting auth_mode=headless failed: ' +
          (err instanceof Error ? err.message : String(err)) +
          '. It is still behind AppCrane sign-in — change it under Manage if you meant headless.',
        )
      }
    }
    // Creating the app row only registers it — nothing is built or pulled until
    // a deploy runs, and an undeployed app answers "Not deployed" at its URL.
    // The catalogue promises two clicks, so the deploy is part of the second one.
    // A failure here is NOT fatal: the app exists and can be deployed from
    // Manage, so say that rather than implying nothing happened.
    let deploying = false
    try {
      await adminApi.post('/api/apps/' + slug + '/deploy/production', {})
      deploying = true
    } catch (err) {
      setWarning(
        'The app was created, but starting its first deploy failed: ' +
        (err instanceof Error ? err.message : String(err)) +
        '. Open it under Manage and deploy from there.',
      )
    }
    setDone({ slug, name: name.trim(), deploying })
    setSubmitting(false)
  }

  const label: React.CSSProperties = { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--dim)', fontWeight: 600 }
  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Deploy ${entry.name}`}
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(680px, 94vw)', maxHeight: '88vh', background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 16px 48px rgba(0,0,0,.5)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: '.95rem' }}>Deploy · {entry.name}</span>
          <button ref={firstRef} className="btn btn-xs" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, fontSize: '.85rem', overflowY: 'auto' }}>
          {done ? (
            <>
              <div style={{ border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.08)', borderRadius: 6, padding: 12, lineHeight: 1.5 }}>
                <strong>{done.name} created</strong> as <code style={{ fontFamily: 'monospace' }}>{done.slug}</code>.
                {done.deploying
                  ? <> Its first deploy is running now. {source === 'image'
                      ? 'This host is pulling the image, which can take a few minutes on a large one.'
                      : 'This host is cloning and building the repo, which can take a few minutes.'} The URL answers
                      "Not deployed" until it finishes — watch progress under Manage.</>
                  : <> The deploy did not start; open it under Manage and run the first deploy there.</>}
              </div>
              {warning && (
                <div role="alert" style={{ border: '1px solid rgba(249,115,22,.4)', background: 'rgba(249,115,22,.08)', borderRadius: 6, padding: 12, lineHeight: 1.5 }}>
                  {warning}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-accent" onClick={() => navigate('/applications')}>Watch the deploy</button>
                <button className="btn" onClick={onCreated}>Back to the catalogue</button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: 0, color: 'var(--dim)', lineHeight: 1.5 }}>
                {entry.short}
                {entry.license ? <> · Licence <code style={{ fontFamily: 'monospace' }}>{entry.license}</code></> : null}
              </p>

              {/* Source */}
              <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <legend style={label}>Source</legend>

                {/* A segmented switch rather than two radios: this is the first and
                    most consequential choice in the dialog, and it changes every
                    field below it. Radios read as a detail; a switch reads as a
                    fork in the road, which is what it is. */}
                <div role="radiogroup" aria-label="Deploy source" style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  {([
                    ['github', 'GitHub', true],
                    ['image', 'Docker image', hasImage],
                  ] as const).map(([val, text, enabled]) => (
                    <button
                      key={val}
                      type="button"
                      role="radio"
                      aria-checked={source === val}
                      disabled={!enabled}
                      onClick={() => enabled && setSource(val as 'github' | 'image')}
                      title={!enabled ? 'This project publishes no usable image, so only the GitHub path is offered.' : undefined}
                      style={{
                        flex: 1, padding: '9px 12px', border: 0, cursor: enabled ? 'pointer' : 'not-allowed',
                        fontSize: '.85rem', fontWeight: 600,
                        background: source === val ? 'var(--accent)' : 'transparent',
                        color: source === val ? '#fff' : enabled ? 'var(--text)' : 'var(--dim)',
                        opacity: enabled ? 1 : .55,
                      }}
                    >{text}</button>
                  ))}
                </div>

                {/* Why this choice matters. Stated here rather than in a doc page,
                    because it is decided here and almost never revisited. */}
                <div
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '.78rem', color: 'var(--dim)', lineHeight: 1.5 }}
                  title={
                    'GitHub: AppCrane clones the repo and builds it on this host. You can follow the '
                    + "default branch, so the next deploy picks up whatever upstream shipped, and you can read "
                    + 'the exact source that was built.\n\n'
                    + 'Docker image: this host pulls a published image and runs it as-is. Faster, because '
                    + 'nothing is built, and it is the artefact the project itself tested. But the tag must be '
                    + 'pinned: AppCrane refuses ":latest", because a moving tag changes what you are running '
                    + 'without a deploy and without a record.\n\n'
                    + 'Neither option updates on its own. Both change only when a deploy runs.'
                  }
                >
                  <span aria-hidden="true" style={{ fontWeight: 700, color: 'var(--accent)' }}>?</span>
                  <span>
                    {source === 'github'
                      ? <>Clones <code style={{ fontFamily: 'monospace' }}>{entry.repo || '—'}</code> and builds it here.
                          Slower to deploy, but you can follow the default branch and read exactly what was built.</>
                      : <>Runs <code style={{ fontFamily: 'monospace' }}>{base}</code> as published — no build, so it is
                          fast and it is the artefact the project tested. The tag must be pinned.</>}
                    {' '}Neither updates by itself; both change only when a deploy runs.
                  </span>
                </div>

                {!hasImage && (
                  <div style={{ color: 'var(--dim)', fontSize: '.78rem' }}>
                    This project publishes no usable first-party image, so only the GitHub path is offered.
                  </div>
                )}
              </fieldset>

              {/* Identity */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={field}>
                  <label style={label} htmlFor="cat-name">App name</label>
                  <input id="cat-name" type="text" value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div style={field}>
                  <label style={label} htmlFor="cat-slug">Slug</label>
                  <input
                    id="cat-slug"
                    type="text"
                    value={slug}
                    onChange={e => setSlug(e.target.value)}
                    aria-invalid={!slugOk}
                    aria-describedby="cat-slug-help"
                  />
                  <span id="cat-slug-help" style={{ fontSize: '.72rem', color: slugOk ? 'var(--dim)' : 'var(--red)' }}>
                    {slugOk ? 'Served at /' + slug + '/ on this instance.' : 'Lowercase letters, digits and dashes; must start with a letter or digit.'}
                  </span>
                </div>
              </div>

              {/* Version */}
              <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <legend style={label}>Version</legend>
                {versionsLoading && <div style={{ color: 'var(--dim)' }}>Reading published versions…</div>}
                {!versionsLoading && versionsError && (
                  <div style={{ color: 'var(--orange)' }}>
                    Could not read published versions ({versionsError}). You can still type a version below.
                  </div>
                )}

                {source === 'github' ? (
                  <>
                    <div style={field}>
                      <label style={label} htmlFor="cat-ghver">Git ref to deploy</label>
                      <select id="cat-ghver" value={ghVersion} onChange={e => setGhVersion(e.target.value)}>
                        <option value="">latest — the repository's default branch</option>
                        {ghChoices.map(c => (
                          <option key={c.value} value={c.value}>{c.group === 'Tags' ? 'tag · ' : 'release · '}{c.label}</option>
                        ))}
                      </select>
                      {!versionsLoading && ghChoices.length === 0 && (
                        <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
                          {versions?.github?.source === 'none'
                            ? 'This project publishes neither GitHub Releases nor tags — only the default branch can be selected.'
                            : 'No versions could be listed right now; the default branch still deploys.'}
                        </span>
                      )}
                      <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
                        A pinned version is deployed as the git ref (a tag is a valid ref), which is what makes the
                        deploy reproducible. "latest" follows the branch and changes under you.
                      </span>
                      {!branchOk && (
                        <span style={{ fontSize: '.72rem', color: 'var(--red)' }}>
                          A git ref may contain only letters, digits and . _ / -
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={field}>
                      <label style={label} htmlFor="cat-imgver">Image tag</label>
                      <select
                        id="cat-imgver"
                        value={imgVersion}
                        onChange={e => { setImgVersion(e.target.value); setCustomTag('') }}
                      >
                        <option value="">Choose a tag…</option>
                        {imgChoices.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input
                        type="text"
                        value={customTag}
                        onChange={e => { setCustomTag(e.target.value); if (e.target.value) setImgVersion('') }}
                        placeholder="…or type a tag, e.g. 19"
                        aria-label="Type an image tag"
                      />
                      <span style={{ fontSize: '.72rem', color: 'var(--dim)', lineHeight: 1.5 }}>
                        There is deliberately no "latest" here: AppCrane records the digest it resolves as the
                        release's identity, and against a tag the publisher republishes at will that record stops
                        being true. An explicit tag says which release you meant. Deploying pulls{' '}
                        <code style={{ fontFamily: 'monospace' }}>{imageRef || base + ':<tag>'}</code> on this host.
                      </span>
                      {!versionsLoading && imgChoices.length === 0 && (
                        <span style={{ fontSize: '.72rem', color: 'var(--orange)' }}>
                          {versions?.image?.source === 'unsupported-registry'
                            ? 'This image is not on Docker Hub, so its tags cannot be listed — type the tag you want.'
                            : 'No tags could be listed right now (upstream may be rate-limiting) — type the tag you want.'}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                      <div style={field}>
                        <label style={label} htmlFor="cat-port">Container port (optional)</label>
                        <input
                          id="cat-port" type="text" inputMode="numeric" value={containerPort}
                          onChange={e => setContainerPort(e.target.value)} placeholder="e.g. 8069"
                          aria-invalid={!portOk}
                        />
                        <span style={{ fontSize: '.72rem', color: portOk ? 'var(--dim)' : 'var(--red)' }}>
                          {portOk
                            ? 'Blank means 3000, which is what the builds AppCrane makes itself listen on. A third-party image rarely agrees.'
                            : 'Must be a number between 1 and 65535.'}
                        </span>
                      </div>
                      <div style={field}>
                        <label style={label} htmlFor="cat-health">Health path (optional)</label>
                        <input
                          id="cat-health" type="text" value={healthPath}
                          onChange={e => setHealthPath(e.target.value)} placeholder="e.g. /"
                          aria-invalid={!healthOk}
                        />
                        <span style={{ fontSize: '.72rem', color: healthOk ? 'var(--dim)' : 'var(--red)' }}>
                          {healthOk
                            ? 'Blank means /api/health. A stock image usually does not serve that, and the check would report a working app as down.'
                            : "Must start with '/'."}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </fieldset>

              {/* Routing + auth */}
              <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <legend style={label}>Routing and authentication</legend>

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="cat-routing" checked={routing === 'appcrane'} onChange={() => setRouting('appcrane')} />
                  <span>
                    <strong>On this AppCrane instance</strong> — served at{' '}
                    <code style={{ fontFamily: 'monospace' }}>/{slug || '<slug>'}/</code> through Caddy.
                  </span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="cat-routing" checked={routing === 'domain'} onChange={() => setRouting('domain')} />
                  <span><strong>A custom domain</strong> you point at this host.</span>
                </label>
                {routing === 'domain' && (
                  <div style={field}>
                    <label style={label} htmlFor="cat-domain">Domain</label>
                    <input
                      id="cat-domain" type="text" value={domain}
                      onChange={e => setDomain(e.target.value)} placeholder="apps.example.com"
                    />
                    <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
                      One primary domain per app. Its DNS must already resolve to this host.
                    </span>
                  </div>
                )}

                <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="cat-auth" checked={authMode === 'authenticated'} onChange={() => { setAuthMode('authenticated'); setAck(false) }} />
                  <span>
                    <strong>Behind AppCrane sign-in</strong> (default) — Caddy checks an AppCrane session before
                    any request reaches the app, and passes the caller's identity to it.
                  </span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="cat-auth" checked={authMode === 'headless'} onChange={() => setAuthMode('headless')} />
                  <span>
                    <strong>Headless</strong> — AppCrane's authentication is skipped entirely. Right for an app
                    that does its own sign-in; wrong for anything that expects a door in front of it.
                  </span>
                </label>

                {exposed && (
                  <div style={{ border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.09)', borderRadius: 6, padding: 12, lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
                      Headless on a custom domain: anyone who can reach that domain is inside this app.
                    </div>
                    There is no AppCrane sign-in, no identity headers and no per-request audit on this path.
                    Whatever authentication the app ships with is the only thing between it and every client that
                    can resolve the name. Pick this only when you know the app authenticates every request itself.
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
                      <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
                      <span>I understand this app will be reachable without AppCrane authentication.</span>
                    </label>
                  </div>
                )}
                {authMode === 'headless' && routing === 'appcrane' && (
                  <div style={{ color: 'var(--orange)', fontSize: '.78rem', lineHeight: 1.5 }}>
                    Headless also removes the sign-in from <code style={{ fontFamily: 'monospace' }}>/{slug || '<slug>'}/</code> —
                    anyone who can reach this AppCrane host reaches the app without signing in.
                  </div>
                )}
              </fieldset>

              {error && (
                <div role="alert" style={{ border: '1px solid rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)', borderRadius: 6, padding: 10 }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {!done && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
              {blockers.length > 0 ? `Still needs ${blockers[0]}.` : 'Creates the app and starts its first deploy. Pulling the image can take a few minutes.'}
            </span>
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Cancel</button>
            <button
              className="btn btn-sm btn-accent"
              onClick={submit}
              disabled={submitting || blockers.length > 0}
            >{submitting ? 'Deploying…' : 'Deploy'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

