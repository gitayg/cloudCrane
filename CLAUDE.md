# AppCrane — Claude Code Notes

## Distribution & updating
AppCrane is **not** published to npm (`package.json` is `private`). It's a self-hosted
app distributed from its GitHub repo — see `repository` in `package.json`
(github.com/gitayg/appCrane). Fresh install: the `install.sh` / `git clone` steps in
README.md. An existing deployment **self-updates from its own git `origin`**: a platform
admin POSTs `/api/self-update`, which runs `git fetch origin` + `git reset --hard
origin/main`, `npm install`, rebuilds the admin SPA, and restarts. So the source of truth
for any deployed box is its `git remote -v` — you don't pull from a separate distribution
channel.

## Releasing: regenerate the MCP connector catalogue
When an `appcrane_*` MCP tool is **added, renamed or removed**, two things must be
regenerated before the release is published:

1. `npm run gen:mcp-snapshot` — in this repo, re-records `server/services/mcpCatalog.snapshot.json`.
2. `npm run gen:catalog && npm run build` — in the **separate `appcrane-mcp` checkout**,
   which reparses this repo's tool definitions into the connector it ships.

Step 2 is the one that gets skipped. The connector ships an **offline** copy of the tool
catalogue so `tools/list` answers with no configuration, and the two repos share no CI —
so nothing failed when it silently fell 22 tools behind the platform (35 advertised
against 57 real). `test/mcp-catalog-sync.test.js` now fails the moment step 1 is missed,
but only the discipline written here catches step 2.

## Data Persistence
If settings or configuration appear wiped, always check `/data` first.
AppCrane stores all persistent state (database, env vars, app configs) under the `DATA_DIR` path (default: `./data`).
Settings that "disappear" are usually still on disk — the process may have restarted pointing at a different working directory or `DATA_DIR` env var.
