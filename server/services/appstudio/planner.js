import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import log from '../../utils/logger.js';
import { ensureCodebaseContext } from './contextBuilder.js';

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const MODEL = process.env.APPSTUDIO_PLANNER_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a senior software engineer planning a surgical change to an existing application.

You will be given:
1. The enhancement request (what the user wants)
2. A pre-analyzed codebase context document (architecture, patterns, key files)
3. Relevant source files from the repo
4. Existing test files in the repo (so you can follow established patterns)
5. Per-app context notes from the operator (if any)
6. Prior conversation (if this is a revision based on feedback)

Your job: produce a precise implementation plan that a code-generation agent will execute.

Output format: a single JSON object inside a \`\`\`json fenced block, followed by a short human-readable summary for the reviewer.

The JSON plan MUST have this shape:
{
  "summary": "<one paragraph: what this change does>",
  "files_to_change": [
    { "path": "relative/path.js", "action": "modify|create|delete", "rationale": "...", "estimated_loc": 20 }
  ],
  "test_files": [
    { "path": "relative/path.test.js", "action": "modify|create", "what": "brief description of what tests to add or update" }
  ],
  "files_to_read": ["paths the code agent should read for full context"],
  "risks": ["anything that could go wrong or needs extra testing"],
  "test_plan": "how to verify the change works after deploy",
  "estimated_code_tokens": 50000
}

Guidelines:
- Be surgical. Change the minimum set of files needed.
- ALWAYS populate test_files. Every code change must include or update tests. If the repo has no existing test infrastructure, create the first test file following the language's standard convention (e.g. *.test.js for Node, *_test.go for Go).
- Follow the existing test framework and style — look at the provided test file samples.
- Never touch database schemas, deploy configs, or .env unless the request explicitly requires it.
- If the request is ambiguous, add entries to a top-level "open_questions" array.
- Respect any constraints in the operator's per-app context notes.
- Estimate tokens conservatively (the budget will be enforced).`;

function grepRelevantFiles(repoDir, fileTree, keywords, maxFiles = 6) {
  const files = new Set();
  const allPaths = fileTree.split('\n').filter(Boolean);

  // Keyword match against file paths first (cheap)
  for (const kw of keywords) {
    if (!kw || kw.length < 3) continue;
    const kwLower = kw.toLowerCase();
    for (const p of allPaths) {
      if (p.toLowerCase().includes(kwLower)) files.add(p);
      if (files.size >= maxFiles) break;
    }
  }

  // grep file contents for remaining slots
  if (files.size < maxFiles) {
    for (const kw of keywords) {
      if (!kw || kw.length < 3) continue;
      try {
        const out = execFileSync('grep', [
          '-rl', '--include=*.js', '--include=*.ts', '--include=*.jsx',
          '--include=*.tsx', '--include=*.json', '--include=*.sql', kw, repoDir,
        ], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
        for (const f of out.trim().split('\n')) {
          if (f && !f.includes('node_modules') && !f.includes('.git/')) {
            files.add(f.startsWith(repoDir) ? f.slice(repoDir.length + 1) : f);
          }
        }
      } catch (_) {}
      if (files.size >= maxFiles) break;
    }
  }

  return [...files].slice(0, maxFiles);
}

function readFileSafe(absPath, maxBytes = 20000) {
  try {
    const c = readFileSync(absPath, 'utf8');
    return c.length > maxBytes ? c.slice(0, maxBytes) + '\n...(truncated)' : c;
  } catch (_) { return '(could not read file)'; }
}

function getTestFiles(fileTree, maxFiles = 4) {
  return fileTree.split('\n').filter(f =>
    f && (
      /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f) ||
      /\/(tests?|__tests__|spec)\//.test(f)
    )
  ).slice(0, maxFiles);
}

function extractKeywords(text) {
  return text.replace(/[^a-zA-Z0-9_\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4).slice(0, 10);
}

function usdCost(usage) {
  const inPrice = parseFloat(process.env.SONNET_INPUT_PRICE_PER_MTOK || '3');
  const outPrice = parseFloat(process.env.SONNET_OUTPUT_PRICE_PER_MTOK || '15');
  const tokensIn = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return (tokensIn / 1_000_000) * inPrice + ((usage.output_tokens || 0) / 1_000_000) * outPrice;
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate.trim()); } catch (_) {}
  const first = candidate.indexOf('{'), last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(candidate.slice(first, last + 1)); } catch (_) {} }
  return null;
}

export async function planEnhancement({ appSlug, request, repoDir, agentContext, priorComments, onChunk, onTokens }) {
  // Step 1: get (or build) the AI-generated codebase context document
  const { contextDoc, fileTree, gitHash, fromCache, builtAt } = await ensureCodebaseContext(appSlug, repoDir);

  // Step 2: grep for files specifically relevant to this enhancement request
  const keywords = extractKeywords(request + ' ' + (priorComments || ''));
  const relevantPaths = grepRelevantFiles(repoDir, fileTree, keywords);
  const fileContents = relevantPaths
    .map(rel => `### ${rel}\n\`\`\`\n${readFileSafe(join(repoDir, rel))}\n\`\`\``) // nosemgrep: path-join-resolve-traversal — rel from git ls-tree/grep
    .join('\n\n');

  const testPaths = getTestFiles(fileTree);
  const testContents = testPaths
    .map(p => `### ${p}\n\`\`\`\n${readFileSafe(join(repoDir, p), 6000)}\n\`\`\``) // nosemgrep: path-join-resolve-traversal — p from git ls-files
    .join('\n\n');

  const contextNote = fromCache
    ? `git ${gitHash?.slice(0, 8)} · cached ${builtAt?.slice(0, 16)} UTC`
    : `git ${gitHash?.slice(0, 8)} · freshly analyzed`;

  const userContent = [
    `## Enhancement request\n\n${request}`,
    priorComments ? `## Prior reviewer feedback\n\n${priorComments}` : '',
    contextDoc
      ? `## Codebase context (${contextNote})\n\n${contextDoc}`
      : `## Repo file tree\n\`\`\`\n${fileTree}\n\`\`\``,
    fileContents ? `## Relevant source files\n\n${fileContents}` : '',
    testContents
      ? `## Existing test files (follow these patterns)\n\n${testContents}`
      : '## Existing test files\n\n(none found — create the first test file)',
    agentContext ? `## Per-app operator notes\n\n${agentContext}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  log.info(`AppStudio plan: ${MODEL}, ${relevantPaths.length} files, context=${fromCache ? 'cached' : 'built'}`);

  let fullText = '';
  let streamInputTokens = 0, streamOutputTokens = 0;
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  for await (const event of stream) {
    if (event.type === 'message_start' && event.message?.usage) {
      streamInputTokens = event.message.usage.input_tokens || 0;
      onTokens?.(streamInputTokens + streamOutputTokens);
    } else if (event.type === 'message_delta' && event.usage) {
      streamOutputTokens = event.usage.output_tokens || 0;
      onTokens?.(streamInputTokens + streamOutputTokens);
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text;
      onChunk?.(fullText);
    }
  }

  const finalMsg = await stream.finalMessage();
  const plan = extractJsonBlock(fullText);
  const summary = fullText.replace(/```json[\s\S]*?```/, '').trim();

  return {
    plan, summary, rawText: fullText,
    tokensIn: finalMsg.usage?.input_tokens || 0,
    tokensOut: finalMsg.usage?.output_tokens || 0,
    costUsd: usdCost(finalMsg.usage || {}),
  };
}
