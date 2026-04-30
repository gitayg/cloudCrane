import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Agent, AppCraneApp, Message, SessionStatus } from '../types'

interface Props {
  agent: Agent
  app: AppCraneApp
  onSessionUpdate: (updated: Agent) => void
}

export function ChatPanel({ agent, app, onSessionUpdate }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [status, setStatus] = useState<SessionStatus>({
    isStreaming: false, queuedTasks: [], hasUncommittedChanges: false,
    uncommittedCount: 0, lastError: null,
  })
  const [input, setInput] = useState('')
  const [shipping, setShipping] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [shipMsg, setShipMsg] = useState('')
  const [shipError, setShipError] = useState<string | null>(null)
  const [gitFiles, setGitFiles] = useState<string[] | null>(null)
  const [gitDiff, setGitDiff] = useState<string | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.messages(agent.id).then(setMessages).catch(console.error)
    const sessionStatus = agent.sessionStatus || 'idle'
    const es = api.events(agent.id, setMessages, setStatus)
    const reconnect = () => {
      if (!['shipped', 'error'].includes(sessionStatus)) {
        const es2 = api.events(agent.id, setMessages, setStatus)
        es2.onerror = reconnect
      }
    }
    es.onerror = reconnect
    return () => es.close()
  }, [agent.id, agent.sessionStatus])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  const send = () => {
    const text = input.trim()
    if (!text) return
    api.dispatch(agent.id, text).catch(console.error)
    setInput('')
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const ship = async () => {
    setShipping(true)
    setShipError(null)
    try {
      const result = await api.shipSandbox(agent.id, shipMsg || undefined)
      onSessionUpdate(agent)
      setShipMsg('')
      alert(result.message)
    } catch (e) {
      setShipError(String(e))
    } finally {
      setShipping(false)
    }
  }

  const promote = async () => {
    if (!confirm('Deploy to production?')) return
    setPromoting(true)
    try {
      const result = await api.promoteProd(agent.id)
      alert(result.message)
    } catch (e) {
      alert(String(e))
    } finally {
      setPromoting(false)
    }
  }

  const resume = async () => {
    setResuming(true)
    try {
      const updated = await api.resume(agent.id)
      onSessionUpdate(updated)
    } catch (e) {
      alert(String(e))
    } finally {
      setResuming(false)
    }
  }

  const toggleGitPanel = async () => {
    if (gitFiles !== null) {
      setGitFiles(null)
      setGitDiff(null)
      setShowDiff(false)
      return
    }
    setGitLoading(true)
    try {
      const [s, d] = await Promise.all([api.gitStatus(agent.id), api.gitDiff(agent.id)])
      setGitFiles(s.uncommitted)
      setGitDiff(d || null)
    } catch (_) {
      setGitFiles([])
    } finally {
      setGitLoading(false)
    }
  }

  const sessionStatus = agent.sessionStatus || 'idle'
  const canSend = (sessionStatus === 'idle' || sessionStatus === 'active') && !status.isStreaming
  const canShip = (sessionStatus === 'idle' || sessionStatus === 'paused') && !status.isStreaming
  const isShipped = sessionStatus === 'shipped'

  return (
    <main className="chat">
      <header>
        <span className="name">{app.name}</span>
        {agent.branchName && <span className="branch">{agent.branchName}</span>}
        <span className={`status-pill ${status.isStreaming ? 'streaming' : sessionStatus}`}>
          {status.isStreaming ? '● streaming' : sessionStatus}
        </span>
        <div className="header-actions">
          {sessionStatus === 'paused' && (
            <button onClick={resume} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}
          {isShipped && (
            <button className="primary" onClick={promote} disabled={promoting}>
              {promoting ? 'Deploying…' : 'Promote to Prod'}
            </button>
          )}
        </div>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.map((m) => <Bubble key={m.id} m={m} />)}
        {messages.length === 0 && (
          <div className="empty"><div>No messages yet — send a task below</div></div>
        )}
      </div>

      {status.lastError && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--danger)', background: 'rgba(239,68,68,0.08)', borderTop: '1px solid var(--border)' }}>
          Error: {status.lastError}
        </div>
      )}

      <div className="composer">
        <textarea
          value={input}
          placeholder="Send a task… (↩ send · Shift↩ newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={!canSend}
        />
        <div className="row">
          {status.isStreaming
            ? <button className="danger" onClick={() => api.stop(agent.id)}>Stop</button>
            : <button className="primary" disabled={!input.trim() || !canSend} onClick={send}>Send</button>}
          <span className="spacer" />
          {status.hasUncommittedChanges && (
            <span
              className="git-hint"
              style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
              onClick={toggleGitPanel}
              title="Click to view changed files"
            >
              {gitLoading ? '…' : '●'} {status.uncommittedCount} uncommitted
            </span>
          )}
        </div>
        {gitFiles !== null && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--dim)', fontWeight: 600 }}>Changed files</span>
              <span className="spacer" />
              {gitDiff && (
                <button
                  style={{ fontSize: 10, padding: '2px 6px' }}
                  onClick={() => setShowDiff(v => !v)}
                >
                  {showDiff ? 'Hide diff' : 'Show diff'}
                </button>
              )}
              <button
                style={{ fontSize: 10, padding: '2px 6px' }}
                onClick={() => { setGitFiles(null); setGitDiff(null); setShowDiff(false) }}
              >
                ✕
              </button>
            </div>
            {gitFiles.length === 0
              ? <div style={{ fontSize: 11, color: 'var(--dim)' }}>No uncommitted changes</div>
              : gitFiles.map(f => (
                  <div key={f} style={{ fontSize: 11, fontFamily: 'monospace', padding: '1px 0', color: 'var(--fg)' }}>
                    {f}
                  </div>
                ))
            }
            {showDiff && gitDiff && (
              <pre style={{
                marginTop: 8, fontSize: 10, lineHeight: 1.5, overflowX: 'auto',
                background: 'var(--surface)', padding: 8, borderRadius: 4,
                maxHeight: 300, whiteSpace: 'pre', color: 'var(--fg)',
              }}>
                {gitDiff}
              </pre>
            )}
          </div>
        )}
        {canShip && (
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 0 }}>
            <input
              value={shipMsg}
              placeholder="Commit message (optional)"
              onChange={(e) => setShipMsg(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="ship" disabled={shipping} onClick={ship}>
              {shipping ? 'Shipping…' : 'Ship to Sandbox'}
            </button>
          </div>
        )}
        {shipError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{shipError}</div>}
      </div>
    </main>
  )
}

function Bubble({ m }: { m: Message }) {
  const cls = ['bubble', m.role].join(' ')
  return (
    <div className={cls}>
      {m.text}
      {m.role === 'agent' && (m.duration_ms || m.cost_usd) && (
        <div className="meta">
          {m.duration_ms ? `${(m.duration_ms / 1000).toFixed(1)}s · ` : ''}
          {m.tokens ? `${m.tokens} tok · ` : ''}
          {m.cost_usd ? `$${m.cost_usd.toFixed(4)}` : ''}
        </div>
      )}
    </div>
  )
}
