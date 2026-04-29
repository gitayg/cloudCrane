import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import log from '../../utils/logger.js';
import { getOrBuildCache } from './codebaseCache.js';

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
2. The current repo tree
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

function getTestFiles(fileTree, maxFiles = 6) {
  return fileTree.split('\n').filter(f =>
    f && (
      /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f) ||
      /\/(tests?|__tests__|spec)\//.test(f)
    )
  ).slice(0, maxFiles);
}

function grepRelevantFiles(repoDir, filesMap, keywords, maxFiles = 8) {
  const files = new Set();
  const cachedPaths = Object.keys(filesMap);

  // Search cached content first (fast, no disk I/O)
  for (const kw of keywords) {
    if (!kw || kw.length < 3) continue;
    const kwLower = kw.toLowerCase();
    for (const p of cachedPaths) {
      if ((filesMap[p] || '').toLowerCase().includes(kwLower)) files.add(p);
      if (files.size >= maxFiles) break;
    }
    if (files.size >= maxFiles) break;
  }

  // Fall back to grep for files not in cache
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
            // Store relative path
            const rel = f.startsWith(repoDir) ? f.slice(repoDir.length + 1) : f;
            files.add(rel);
          }
        }
      } catch (_) {}
      if (files.size >= maxFiles) break;
    }
  }

  return [...files].slice(0, maxFiles);
}

function readFileSafe(absPath, cachedContent, maxBytes = 20000) {
  const content = cachedContent ?? (() => {
    try { return readFileSync(absPath, 'utf8'); } catch (_) { return '(could not read file)'; }
  })();
  return content.length > maxBytes ? content.slice(0, maxBytes) + '\n... (truncated)' : content;
}

function extractKeywords(text) {
  return text
    .replace(/[^a-zA-Z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .slice(0, 10);
}

function usdCost(usage) {
  const inPrice = parseFloat(process.env.SONNET_INPUT_PRICE_PER_MTOK || '3');
  const outPrice = parseFloat(process.env.SONNET_OUTPUT_PRICE_PER_MTOK || '15');
  const tokensIn = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const tokensOut = usage.output_tokens || 0;
  return (tokensIn / 1_000_000) * inPrice + (tokensOut / 1_000_000) * outPrice;
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate.trim()); } catch (_) {}
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

export async function planEnhancement({ appSlug, request, repoDir, agentContext, priorComments, onChunk, onTokens }) {
  const { fileTree, filesMap, gitHash, fromCache, builtAt } = getOrBuildCache(appSlug, repoDir);

  const keywords = extractKeywords(request + ' ' + (priorComments || ''));
  const relevantRelPaths = grepRelevantFiles(repoDir, filesMap, keywords);
  const fileContents = relevantRelPaths
    .map(rel => `### ${rel}\n\`\`\`\n${readFileSafe(join(repoDir, rel), filesMap[rel])}\n\`\`\``)
    .join('\n\n');

  const testPaths = getTestFiles(fileTree);
  const testContents = testPaths
    .map(p => `### ${p}\n\`\`\`\n${readFileSafe(join(repoDir, p), filesMap[p], 6000)}\n\`\`\``)
    .join('\n\n');

  const cacheNote = fromCache
    ? `Context snapshot: git ${gitHash?.slice(0, 8)} (cached ${builtAt?.slice(0, 16)} UTC — no changes since)`
    : `Context snapshot: git ${gitHash?.slice(0, 8)} (freshly indexed)`;

  const userContent = [
    `## Enhancement request\n\n${request}`,
    priorComments ? `## Prior reviewer feedback\n\n${priorComments}` : '',
    `## Repo tree\n\`\`\`\n${fileTree || '(could not read repo tree)'}\n\`\`\``,
    fileContents ? `## Relevant source files\n\n${fileContents}` : '',
    testContents
      ? `## Existing test files (follow these patterns)\n\n${testContents}`
      : '## Existing test files\n\n(none found — create the first test file)',
    agentContext ? `## Per-app context (from operator)\n\n${agentContext}` : '',
    `## Codebase context metadata\n\n${cacheNote}`,
  ].filter(Boolean).join('\n\n---\n\n');

  log.info(`AppStudio plan: ${MODEL}, ${relevantRelPaths.length} files, cache=${fromCache ? 'HIT' : 'MISS'}`);

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
    plan,
    summary,
    rawText: fullText,
    tokensIn: finalMsg.usage?.input_tokens || 0,
    tokensOut: finalMsg.usage?.output_tokens || 0,
    costUsd: usdCost(finalMsg.usage || {}),
  };
}
