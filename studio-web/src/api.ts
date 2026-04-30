import type { Agent, AppCraneApp, Message, SessionStatus, ShipResult } from './types'

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('cc_identity_token') || ''
  if (token) return { Authorization: `Bearer ${token}` }
  const apiKey = localStorage.getItem('cc_api_key') || ''
  if (apiKey) return { 'X-API-Key': apiKey }
  return {}
}

function sseUrl(id: string): string {
  const token = localStorage.getItem('cc_identity_token') || ''
  const apiKey = localStorage.getItem('cc_api_key') || ''
  const base = `/api/agents/${id}/events`
  if (token) return `${base}?token=${encodeURIComponent(token)}`
  if (apiKey) return `${base}?api_key=${encodeURIComponent(apiKey)}`
  return base
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  if (r.status === 204) return undefined as T
  return r.json() as Promise<T>
}

export const api = {
  // Apps list (primary sidebar source)
  listApps:      () => j<AppCraneApp[]>('/api/agents/apps'),

  // Session (agent) operations
  getAgent:      (id: string) => j<Agent>(`/api/agents/${id}`),
  createSession: (appSlug: string) =>
                   j<Agent>('/api/agents', { method: 'POST', body: JSON.stringify({ name: appSlug }) }),
  deleteAgent:   (id: string) => j<void>(`/api/agents/${id}`, { method: 'DELETE' }),

  messages:      (id: string) => j<Message[]>(`/api/agents/${id}/messages`),
  dispatch:      (id: string, text: string) =>
                   j<{ queued: boolean }>(`/api/agents/${id}/dispatch`,
                     { method: 'POST', body: JSON.stringify({ text }) }),
  stop:          (id: string) => j<void>(`/api/agents/${id}/stop`, { method: 'POST' }),
  resume:        (id: string) => j<Agent>(`/api/agents/${id}/resume`, { method: 'POST' }),

  shipSandbox:   (id: string, message?: string) =>
                   j<ShipResult>(`/api/agents/${id}/ship-sandbox`,
                     { method: 'POST', body: JSON.stringify({ message }) }),
  promoteProd:   (id: string) =>
                   j<{ message: string; deploy_id: number }>(`/api/agents/${id}/promote-prod`,
                     { method: 'POST' }),

  gitStatus: (id: string) =>
    j<{ uncommitted: string[]; branch: string; ahead: number; behind: number }>(`/api/agents/${id}/git/status`),

  gitDiff: (id: string) =>
    fetch(`/api/agents/${id}/git/diff`, { headers: authHeaders() }).then(r => r.text()),

  events: (
    id: string,
    onMessages: (msgs: Message[]) => void,
    onStatus: (s: SessionStatus) => void,
  ): EventSource => {
    const es = new EventSource(sseUrl(id))
    es.addEventListener('messages', (e) => onMessages(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('status',   (e) => onStatus(JSON.parse((e as MessageEvent).data)))
    return es
  },
}
