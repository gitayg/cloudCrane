import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Pins the MCP tool surface against server/services/mcpCatalog.snapshot.json.
//
// The drift this file exists to catch lives BETWEEN two repos, which is exactly
// why no single-repo test ever caught it. The published connector
// (`appcrane-mcp`) ships an OFFLINE copy of this catalogue so `tools/list`
// answers with no configuration, and it builds that copy by parsing
// server/services/mcpTools.js out of a sibling checkout. Nothing ever forced
// anyone to re-run that parse, so the connector sat at 35 tools while the
// platform had 57 — missing appcrane_deploy_artifact, appcrane_rename_app,
// appcrane_stage_chunk/assemble, appcrane_scan_report, appcrane_platform_policy
// and the whole backup/ingress/app-roles set. An agent reading the connector's
// catalogue simply could not see half the platform, and nothing anywhere went
// red about it.
//
// The snapshot is the in-repo half of the handshake: adding, renaming or
// removing a tool — or changing what it costs to call one — turns red HERE, in
// the repo where the change is made, at the moment it is made. Regenerating it
// is the prompt to go regenerate the connector too.
//
// This asserts metadata (name / requiredRole / readOnly), not descriptions or
// input schemas: those churn on every wording tweak, and a snapshot that cries
// wolf gets regenerated without being read.

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'crane-mcpsnap-'));
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { initDb } = await import('../server/db.js');
initDb();
const { getToolCatalog } = await import('../server/services/mcpTools.js');

const SNAPSHOT_PATH = new URL('../server/services/mcpCatalog.snapshot.json', import.meta.url);
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

// Both fixes, always, in every failure message: regenerating only the snapshot
// makes this test green while leaving the connector exactly as stale as it was
// — the precise failure mode that produced the 35-vs-57 gap.
const FIX = [
  'To fix, run BOTH:',
  '  1. npm run gen:mcp-snapshot            (here — re-records the tool surface)',
  '  2. npm run gen:catalog && npm run build (in the appcrane-mcp checkout — reparses this repo)',
  'Step 2 is not optional: the published connector ships its own offline copy of this',
  'catalogue, and skipping it is how the connector drifted to 35 tools against 57.',
].join('\n');

/** The same projection the generator writes, so a diff here is a real diff. */
const project = (t) => ({
  name: t.name,
  requiredRole: t.requiredRole ?? null,
  readOnly: !!t.readOnly,
});

const live = getToolCatalog().map(project);
const liveByName = new Map(live.map((t) => [t.name, t]));
const snapByName = new Map(snapshot.tools.map((t) => [t.name, t]));

test('the snapshot fixture is itself well formed', () => {
  // A snapshot that is empty, duplicated or missing its count would make every
  // comparison below pass vacuously.
  assert.ok(Array.isArray(snapshot.tools) && snapshot.tools.length > 0,
    'mcpCatalog.snapshot.json has no tools array — regenerate it');
  assert.equal(snapByName.size, snapshot.tools.length, 'the snapshot lists a tool name twice');
  assert.equal(typeof snapshot.count, 'number');
  assert.equal(snapshot.count, snapshot.tools.length,
    `the snapshot's recorded count (${snapshot.count}) disagrees with its own tools array ` +
    `(${snapshot.tools.length}); it was hand-edited rather than regenerated.\n${FIX}`);
  assert.ok(live.length > 0, 'getToolCatalog() returned nothing — the registry failed to load');
});

test('no tool has been added without regenerating the snapshot', () => {
  // The direction that actually bit: tools accumulate in mcpTools.js and the
  // connector never learns about them.
  const added = live.filter((t) => !snapByName.has(t.name)).map((t) => t.name);
  assert.deepEqual(added, [],
    `${added.length} MCP tool(s) exist on the platform but are missing from the snapshot, ` +
    `so the published connector will not advertise them:\n  ${added.join('\n  ')}\n${FIX}`);
});

test('no tool has been removed or renamed without regenerating the snapshot', () => {
  // The mirror direction. A connector advertising a tool the server dropped is
  // worse than one advertising too few: the agent calls it and gets an error it
  // cannot act on.
  const missing = snapshot.tools.filter((t) => !liveByName.has(t.name)).map((t) => t.name);
  assert.deepEqual(missing, [],
    `${missing.length} tool(s) are in the snapshot but no longer on the platform ` +
    `(removed or renamed):\n  ${missing.join('\n  ')}\n${FIX}`);
});

test('every tool keeps its recorded requiredRole and readOnly', () => {
  // Name-set equality is not enough. requiredRole decides who may call a tool
  // and readOnly decides whether a read-only MCP key may — a connector shipping
  // the old value mis-describes the platform's authorization to every agent
  // that reads it.
  const drifted = [];
  for (const [name, want] of snapByName) {
    const got = liveByName.get(name);
    if (!got) continue; // already reported by the removal test
    if (got.requiredRole !== (want.requiredRole ?? null)) {
      drifted.push(`${name}: requiredRole ${JSON.stringify(want.requiredRole)} -> ${JSON.stringify(got.requiredRole)}`);
    }
    if (got.readOnly !== !!want.readOnly) {
      drifted.push(`${name}: readOnly ${!!want.readOnly} -> ${got.readOnly}`);
    }
  }
  assert.deepEqual(drifted, [],
    `${drifted.length} tool(s) changed their access metadata without the snapshot being ` +
    `regenerated:\n  ${drifted.join('\n  ')}\n${FIX}`);
});

test('the recorded tool count matches the live catalogue', () => {
  // Redundant with the two name tests when both pass, but it is the number a
  // human compares against the connector ("35 vs 57"), so it gets asserted and
  // printed on its own.
  assert.equal(live.length, snapshot.count,
    `the platform exposes ${live.length} MCP tools; the snapshot records ${snapshot.count}.\n${FIX}`);
});
