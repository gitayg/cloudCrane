# AppCrane Coder — Implementation Spec
> Self-contained briefing for an AppCrane agent. Read top-to-bottom before touching any file.

---

## 1. Concept & Design Decisions

AppCrane Coder is an **interactive, session-based AI coding assistant** built into the AppCrane portal. When a user opens an app they own, they can start a Coder session: AppCrane spins up a Docker container with Claude Code pre-installed, clones the app's git repo onto a new branch, and streams Claude's actions back in real time. The user describes what they want; Claude reads, edits, and tests the code inside the container. When the user is satisfied they press **Ship to Sandbox** — one button that commits everything, pushes the branch, and triggers a sandbox deploy. Promoting to production is always a human action (review the sandbox, then press Promote in the normal deploy flow). No changes ever reach production without explicit human approval.

**Design decisions already locked:**

| Decision | Rationale |
|---|---|
| **One active Coder session per app** | Prevents two sessions diverging on the same repo. Second user trying to start gets an error pointing at the active session. |
| **Claude Code runs inside the existing AppStudio Docker image** (`appcrane-studio:latest`) | Reuses the hardened, non-root container. No new image needed in Stage 1. |
| **Branch-per-session** (`coder/{sessionId}`) | Each session owns one branch from start to Ship. If the user abandons and resumes, they pick up the same branch. |
| **Ship to Sandbox = one button** | Commits all staged changes, pushes branch, calls the existing `deployApp()` sandbox path. No separate PR step in Stage 1. |
| **Promote is human-only** | Coder never touches the production environment. The user uses the normal Promote button in the dashboard after reviewing the sandbox. |
| **No MCP in Stage 1** | Eliminates the tool-use-id race, stale-port, and kill-the-grandchild bugs entirely. Claude runs with `--dangerously-skip-permissions` inside the trusted container (same as AppStudio). MCP permission routing is Stage 3. |
| **Streaming via SSE** | The existing AppStudio log-streaming pattern (SSE + DB-buffered output) is reused. No WebSocket needed. |
| **API key via read-only file mount** | Same security pattern as AppStudio generator.js:291 — never in env. |

---

## 2. Lifecycle

```
User clicks "Start Coder"
        │
        ▼
[POST /api/coder/:slug/session]
  • Check no active session for this app → error if one exists
  • INSERT coder_sessions row (status=starting, branch=coder/{sessionId})
  • git clone app repo onto branch coder/{sessionId}      ← host, not container
  • ensureStudioImage()                                    ← reuse generator.js
  • docker run -d (detached, keep-alive loop)              ← container stays up
  • UPDATE coder_sessions SET status=idle, container_id=…
        │
        ▼
[GET /api/coder/:slug/session/:id/events]  ← SSE stream, opened by browser
  • Replays last 200 buffered log lines from DB
  • From here Claude stdout/stderr append to buffer in real time
        │
User sends a message
        │
        ▼
[POST /api/coder/:slug/session/:id/dispatch]
  • Appends user message to coder_session_messages
  • docker exec claude -p "{prompt}" --output-format stream-json \
      --dangerously-skip-permissions                       ← no MCP in Stage 1
  • Stream lines → StreamJSONParser → SSE push to browser + DB buffer
  • On result event: extract tokens/cost, UPDATE coder_sessions cost cols
        │
        ▼
User presses "Ship to Sandbox"
        │
[POST /api/coder/:slug/session/:id/ship]
  • git add -A && git commit -m "coder: {session summary}"   ← host
  • npm install --package-lock-only if package.json changed  ← host
  • git push origin coder/{sessionId}                        ← host
  • INSERT deployments (env=sandbox, status=pending)
  • deployApp(deployId, app, sandbox, ports, {preExtractedDir: workspace})
  • UPDATE coder_sessions SET status=shipped, shipped_at=now()
        │
        ▼
User reviews sandbox → presses Promote in normal dashboard
  (Coder owns nothing after ship; normal deploy flow takes over)
```

### Idle Eviction

A background check runs every 5 minutes (simple `setInterval` in the server process — no cron):

```
For each coder_sessions WHERE status=idle AND last_activity_at < now()-30min:
  docker stop {container_id}   (SIGTERM → 10s → SIGKILL the container)
  UPDATE coder_sessions SET status=paused
```

Workspace directory is **not deleted** on eviction. Branch remains on disk.

### Resume Flow

```
User returns to portal, clicks "Resume"
        │
[POST /api/coder/:slug/session/:id/resume]
  • Verify session status=paused, workspace_dir still exists
  • docker run -d (new container, same workspace mount)
  • UPDATE coder_sessions SET status=idle, container_id={new id}
  • Browser opens SSE stream → replays log buffer from DB
  • User dispatches; Claude continues on same branch
```

`--resume` (Claude's own session continuation) is **Stage 2**. In Stage 1 each dispatch is a fresh `claude -p`. The branch and files provide continuity; Claude re-reads them on each run via `--add-dir /workspace`.

---

## 3. What to Lift from AIDE

### Column A — Wholesale (copy as-is, translating Swift → JS idioms)

| AIDE concept | AIDE source file | What to copy |
|---|---|---|
| Route table shape | `Sources/AIDE/Services/APIServer.swift` | Same REST verbs and URL patterns; translate handler bodies to Express middleware |
| DTO shapes | `Sources/AIDE/Models/Message.swift`, `Agent.swift`, `StreamEvent.swift` | JSON field names are the contract; replicate in plain JS objects (no class needed) |
| React web UI | `web/src/` (all files) | Lift wholesale. Only change: point `api.ts` base URL at AppCrane origin instead of localhost AIDE port. Embed as `docs/coder.html` (single-file pattern used everywhere in AppCrane) or serve `web/dist/` as a static subtree under `/coder-ui/`. |
| SSE push pattern | `APIServer.swift` `GET /api/agents/{id}/events` handler | 250ms debounce, push full message array + status object. AppCrane already does this for AppStudio logs — merge the two patterns. |
| Conversation JSONL | `State/ConversationStore.swift` | Append-only JSONL per session. In AppCrane: one file per `coder_sessions.id` under `DATA_DIR/coder-sessions/{id}.jsonl`. Lazy-load last 2000 lines on resume. |

### Column B — Reimplement in AppCrane Stack (Node.js / Express / SQLite)

| AIDE concept | AIDE spec file | AppCrane implementation |
|---|---|---|
| **ClaudeRunner** — spawns subprocess, yields events | `Sources/AIDE/Services/ClaudeRunner.swift` | `server/services/coder/claudeRunner.js`. Use `child_process.spawn('docker', ['exec', containerId, 'claude', ...args])`. Pipe stdout line-by-line through StreamJSONParser. Yield events via async generator or EventEmitter. |
| **StreamJSONParser** — line-buffered JSON decode | `Sources/AIDE/Services/StreamJSONParser.swift` | `server/services/coder/streamJsonParser.js`. Already partially present in AppStudio generator.js (token extraction). Extract into standalone module. Key: keep tool_input as raw object (not stringified) for future MCP. |
| **AgentSession** — in-memory run state | `Sources/AIDE/State/AgentSession.swift` | `server/services/coder/coderSession.js`. In AppCrane: a plain JS Map keyed by sessionId held in the server process. Fields: `{ containerId, workspaceDir, branch, streaming, claudeSessionId, costTokens, costUsdCents }`. Persist to SQLite on every status change. |
| **Session persistence** | `State/AgentStore.swift` + `AppPaths.swift` | `coder_sessions` SQLite table (migration 032). Plus per-session JSONL for message history. SQLite is the authority; JSONL is the scroll buffer. |
| **Orphan recovery on restart** | `AppController.swift` bootstrap | On server start, query `coder_sessions WHERE status IN (starting, idle, active)`. For each, call `docker inspect {container_id}` — if container is gone, set status=paused. Mirrors AppStudio worker.js orphan recovery. |
| **ToolRegistry** | `Sources/AIDE/Services/ToolRegistry.swift` | Not needed in Stage 1 (no MCP). In Stage 3: simple JSON file `DATA_DIR/tools.json` with discovered paths. |
| **onCodingDone git flow** | `server/services/appstudio/worker.js` lines 279-349 | Lift directly. The Ship endpoint does the same `git add -A → commit → push → deployApp()` sequence already implemented. Factor into `server/services/coder/gitOps.js` to share with AppStudio. |

### Column C — Don't Lift

| AIDE component | Reason |
|---|---|
| `KeychainHelper.swift` | macOS Keychain — AppCrane stores secrets in encrypted SQLite column (encryption.js) |
| `NSSound` / `SoundPlayer.swift` | Desktop audio — no equivalent in a web server |
| All SwiftUI views (`Views/*.swift`) | AppCrane frontend is vanilla JS / HTML |
| `MCPServer.swift` + `PermissionRouter.swift` | Stage 1 has no MCP. Stage 3 will reimplement from scratch (see antipatterns below). |
| `MigrationFromV4.swift` | AIDE-specific data migration; irrelevant |
| `FernetHelper.swift` | AppCrane already has `server/services/encryption.js` |
| `ShellRunner.swift` | AppCrane uses `execFileSync` from `child_process` |
| `AgentStore` debounced JSON saves | AppCrane uses SQLite — writes are fast, no debounce needed |
| `ClaudeSettingsFile.swift` | Writes per-project `.claude/settings.local.json` allow-rules — only needed for MCP (Stage 3) |
| ULID generator in `Agent.swift` | Node has `crypto.randomUUID()` |
| `TokenStore` / named token concept | AppCrane has `ANTHROPIC_API_KEY` in env; no multi-token need in Stage 1 |

---

## 4. Antipatterns — Bugs Hit in AIDE v5

Do not repeat these. Each describes what went wrong, why, and what to do instead.

### Bug 1: Prompt-Injection via Natural Language in MCP Input

**What happened:** The `permission_prompt` MCP tool receives `tool_name` and `tool_input` as plain strings rendered into the permission UI. A malicious tool response can craft `tool_input` to look like a pre-approved decision, confusing a regex-based auto-approver into granting access.

**Root cause:** Auto-approval rules matched against stringified tool input using `contains()` — the same text the attacker controls.

**Fix for AppCrane Stage 3:** Auto-approval rules must match only against the _tool name_ (a controlled identifier), never against arbitrary tool input content. Log the full input for audit; never parse it for trust decisions.

---

### Bug 2: MCP Tool-Use-ID Race

**What happened:** Claude emits a `tool_use` block in the streaming assistant message, _then_ calls the MCP `permission_prompt` endpoint milliseconds later. AIDE's PermissionRouter maps the incoming `permission_prompt` back to the correct agent by looking up which session last emitted that `tool_use_id`. But if the streaming event hasn't been processed yet (still in the line buffer), the lookup fails.

**AIDE's workaround:** `PermissionRouter.swift` — a 300ms retry loop (15 × 20ms sleep) before giving up.

**Fix for AppCrane Stage 3:** Process the streaming line that contains the `tool_use_id` _synchronously_ and register it in a `Map<toolUseId, sessionId>` before `await`-ing any I/O. The parser must run on the same event-loop tick as the MCP server handler, so the map is populated before the MCP call arrives. Don't rely on timing.

---

### Bug 3: Eager Seen-Set on Resume

**What happened:** AIDE tracks a "seen" set of message IDs to avoid re-rendering messages on SSE reconnect. The seen-set was populated when messages were _queued to send_, not when they were _acknowledged by the client_. On resume after a crash the seen-set was pre-populated from the in-memory state that no longer matched what the client had actually displayed — causing messages to be silently skipped.

**Fix for AppCrane:** Don't track a server-side seen-set. Instead, on SSE reconnect the client sends `?after={lastMessageId}`. Server replays everything after that ID from the JSONL file. The client is the authority on what it has seen, not the server.

---

### Bug 4: Stale Claude Config Port

**What happened:** AIDE registers its MCP server URL (e.g. `http://127.0.0.1:51423/mcp/sse`) in `~/.claude/settings.json`. On the next app launch, the MCP server binds to a _different_ random port (e.g. 51891). Claude's `--resume` reuses the old session config, which still points at port 51423. Claude tries to connect, gets `ECONNREFUSED`, and either errors or silently runs without permission routing — meaning all tool uses pass through without prompting.

**Fix for AppCrane Stage 3:** Either (a) bind the MCP server to a _fixed well-known port_ (e.g. 19474) configured in the server's `.env`, or (b) always rewrite `~/.claude/settings.json` at server startup before spawning any Claude process, and never use `--resume` when the MCP port has changed.

---

### Bug 5: Killing the Wrapper, Not the Subprocess

**What happened:** When stopping a session, `process.kill()` (or Swift's `process.terminate()`) sends SIGTERM to the _direct child_ — in this case a shell or `docker exec` wrapper — but Claude itself is a grandchild in a different process group. The wrapper dies; Claude keeps running in the background, holding the workspace lock and continuing to consume tokens.

**Fix for AppCrane:** When spawning the claude process (or `docker exec`), capture the container exec process PID and kill the _process group_:

```js
// Node.js — spawn with detached:true gives us a process group leader
const child = spawn('docker', ['exec', containerId, 'claude', ...args], {
  detached: true,
});
// To stop:
process.kill(-child.pid, 'SIGTERM');  // negative PID = kill process group
```

For container-level stop (the safer path in Stage 1): `docker stop {containerId}` sends SIGTERM to PID 1 inside the container, which propagates to all children. Prefer `docker stop` over killing the exec wrapper.

---

## 5. Scope by Stage

### Stage 1 — Interactive Coding in a Container (ship this)

- `coder_sessions` table (migration 032): `id, app_slug, user_id, branch_name, container_id, workspace_dir, status, last_activity_at, claude_session_id, cost_tokens, cost_usd_cents, created_at, shipped_at`
- `coder_session_messages` table: `id, session_id, role (user|assistant|system), content, tokens, created_at`
- `server/services/coder/claudeRunner.js` — spawn `docker exec`, parse stream-json, EventEmitter output
- `server/services/coder/streamJsonParser.js` — extracted from AppStudio generator.js
- `server/services/coder/coderSession.js` — in-memory session map, idle eviction timer
- `server/routes/coder.js` — REST endpoints (see §6)
- Idle eviction: `setInterval` every 5 min, `docker stop` after 30 min inactivity
- Resume: restart container on same workspace + same branch. No `--resume` flag yet.
- Ship to Sandbox: commit + push branch + call existing `deployApp()` sandbox path
- UI: single-file `docs/coder.html` (follows AppCrane convention). Lift React components from AIDE `web/src/` — ChatPanel, api.ts, types.ts — compile to `docs/coder.html` or serve static from `public/coder/`.
- Version bump: `1.19.0` (minor — new feature)
- **Out of scope for Stage 1:** MCP, `--resume`, GitHub PR, multi-user, cost limits UI

### Stage 2 — Session Continuity & Cost Controls

- `--resume {claudeSessionId}` flag passed to claude on each dispatch (persist `claude_session_id` from `systemInit` stream event)
- Per-app cost ceiling configurable by admin (reuse `max_cost_cents` pattern from AppStudio)
- Soft kill when budget exceeded mid-stream (drain current response, then refuse next dispatch)
- Show cost accrual live in UI (token counter, USD estimate)
- Ship creates a real GitHub PR instead of direct sandbox deploy (reuse AppStudio worker.js `openPr` phase)
- Multiple dispatches per session baked into a single squash commit on Ship

### Stage 3+ — MCP, Presence, Multi-App

- MCP permission routing (rebuild from scratch, avoiding all five antipatterns above)
- Presence indicator: who is in a Coder session right now (reuse existing presence tables from AppCrane portal)
- Multi-app context: Coder can read other apps' codebases as reference (read-only mounts)
- Snapshot/rollback: save named checkpoints within a session (git stash + tag)
- Scheduled coding runs: submit a task, Coder works overnight, sends notification on Ship-ready

---

## 6. Concrete Next Steps

1. **Write migration 032** — `server/migrations/032-coder-sessions.sql` — two tables: `coder_sessions` + `coder_session_messages`
2. **Extract StreamJsonParser** — Move token/cost extraction from `server/services/appstudio/generator.js` into `server/services/coder/streamJsonParser.js`. Export `parseLine(line) → StreamEvent|null`.
3. **Write claudeRunner.js** — `server/services/coder/claudeRunner.js`. Takes `{ containerId, workspaceDir, prompt, apiKeyPath }`. Runs `docker exec -i {containerId} node /studio/runner.js`. Emits `data`, `result`, `error`, `exit` events. Uses process group kill on `stop()`.
4. **Write coderSession.js** — `server/services/coder/coderSession.js`. Exports `Map<sessionId, Session>`. Each Session has `{ runner, status, branch, costTokens }`. Registers idle eviction timer on creation. Provides `dispatch()`, `stop()`, `ship()`, `pause()`, `resume()` methods.
5. **Write coder.js route** — `server/routes/coder.js`. Mount at `/api/coder`.
6. **Register route** — Add `app.use('/api/coder', coderRouter)` in `server/index.js`.
7. **Write coder.html** — Lift from AIDE `web/src/`. Adapt `api.ts` for AppCrane auth (Bearer token from localStorage, same as login.html). Add "Ship to Sandbox" button where AIDE has "Stop".
8. **Add static route** — Serve `docs/coder.html` in `server/index.js` at `/coder` (same pattern as `/portal` → `docs/login.html`).
9. **Test idle eviction** — Set eviction threshold to 2 minutes in dev, verify `docker stop` fires and container_id is cleared.
10. **Bump version** — `package.json` → `1.19.0`.

### File-Level Cross-Reference

| Concept | AppCrane file to create/edit | AIDE spec source |
|---|---|---|
| Session table | `server/migrations/032-coder-sessions.sql` | `State/AgentSession.swift` fields |
| Stream parser | `server/services/coder/streamJsonParser.js` | `Services/StreamJSONParser.swift` |
| Claude runner | `server/services/coder/claudeRunner.js` | `Services/ClaudeRunner.swift` |
| Session state | `server/services/coder/coderSession.js` | `State/AgentSession.swift` + `AppController.swift` |
| Git operations | `server/services/coder/gitOps.js` | `server/services/appstudio/worker.js` lines 279–349 |
| REST routes | `server/routes/coder.js` | `Services/APIServer.swift` route table |
| Route mount | `server/index.js` (add one line) | — |
| Frontend UI | `docs/coder.html` | `web/src/App.tsx`, `ChatPanel.tsx`, `api.ts`, `types.ts` |
| Docker image | `server/services/appstudio/generator.js` `ensureStudioImage()` | `ClaudeRunner.swift` `locateClaude()` |
| Orphan recovery | `server/index.js` startup block | `AppController.swift` bootstrap |
| Idle eviction | `server/services/coder/coderSession.js` `setInterval` | — (AppCrane-specific) |
| Ship endpoint | `server/routes/coder.js` + `server/services/coder/gitOps.js` | `worker.js` `handleBuild()` |
| Existing deploy | `server/services/deployer.js` `deployApp()` | — (already exists, call as-is) |
| API key mount | Reuse `server/services/appstudio/generator.js` pattern | `ClaudeRunner.swift` env setup |

---

## 7. Open Questions to Resolve Before Writing Code

1. **Sandbox scoping for the container:** The current AppStudio container has no network access restrictions. Should Coder containers also be network-isolated (block outbound except npm registry + GitHub), or unrestricted? Affects the `docker run` flags.

2. **`--resume` storage granularity:** In Stage 2, `claude_session_id` is stored per `coder_sessions` row. But Claude's session ID changes whenever the model resets context. Should AppCrane treat a context-reset as a new sub-session (append to same `coder_sessions` row with new `claude_session_id`) or fork a new row? Affects resume reliability and cost attribution.

3. **Who can start a Coder session?** Options: (a) any user assigned to the app, (b) app admin only, (c) any user but they only see their own session. Decision affects the auth check in `POST /api/coder/:slug/session` and the "one active session per app" constraint.

4. **Workspace persistence across ship:** After Ship, the workspace dir and branch are still on disk. Should the session be auto-closed (status=shipped, container stopped) or remain open so the user can keep iterating on the same branch? If open, the branch now has a sandbox deploy ahead of it — further dispatches would push additional commits to the same branch.

5. **Eviction vs. pause distinction:** Idle eviction (`status=paused`) currently stops the container but keeps the workspace. Should a _user-initiated_ pause be the same state, or should we add `status=user_paused` to distinguish? Matters for the UI (show "Resume" vs "Restart").

6. **Cost ceiling in Stage 1:** AppStudio has `max_cost_cents` per enhancement. Coder sessions can run much longer. Should Stage 1 have a hard per-session ceiling (e.g. $5 default, configurable) or no limit? If limited: what happens mid-stream when the ceiling is hit — kill immediately or drain the current response?

7. **Log retention:** `coder_session_messages` grows unboundedly for long sessions. Should there be a cap (last N messages kept in DB, older ones only in JSONL)? Or is JSONL the primary store and DB is just the hot tail?
