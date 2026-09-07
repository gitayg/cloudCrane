#!/usr/bin/env node
// Regenerates server/services/mcpCatalog.snapshot.json — the committed record of
// the MCP tool surface this release advertises.
//
// Why a snapshot exists at all: the published connector (`appcrane-mcp`, a
// separate checkout) ships an OFFLINE copy of this catalogue so `tools/list`
// works with no configuration. It regenerates by parsing this very file, and
// nothing made anyone re-run it — so it drifted to 35 tools while the platform
// had 57, missing every tool added over months. A stale connector advertises a
// capability set the server does not have, which is worse than advertising none.
//
// The snapshot turns that silent drift into a failing test at the moment a tool
// is added, in CI, in the repo where the change is made.
//
//   npm run gen:mcp-snapshot   # after adding, renaming or removing a tool
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DATA_DIR ||= '/tmp/appcrane-snapshot-gen';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.LOG_LEVEL ||= 'error';

const { initDb } = await import('../server/db.js');
initDb();
const { getToolCatalog } = await import('../server/services/mcpTools.js');

const tools = getToolCatalog()
  .map((t) => ({ name: t.name, requiredRole: t.requiredRole ?? null, readOnly: !!t.readOnly }))
  .sort((a, b) => a.name.localeCompare(b.name));

const out = join(dirname(fileURLToPath(import.meta.url)), '../server/services/mcpCatalog.snapshot.json');
writeFileSync(out, JSON.stringify({ count: tools.length, tools }, null, 2) + '\n');
console.log(`wrote ${tools.length} tools to ${out}`);
