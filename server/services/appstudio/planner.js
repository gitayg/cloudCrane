import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import log from '../../utils/logger.js';

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
4. Per-app context notes from the operator (if any)
5. Prior conversation (if this is a revision based on feedback)

Your job: produce a precise implementation plan that a code-generation agent will execute.

Output format: a single JSON object inside a \`\`\`json fenced block, followed by a short human-readable summary for the reviewer.

The JSON plan MUST have this shape:
{
  "summary": "<one paragraph: what this change does>",
  "files_to_change": [
    { "path": "relative/path.js", "action": "modify|create|delete", "rationale": "...", "estimated_loc": 20 }
  ],
  "files_to_read": ["paths the code agent should read for full context"],
  "risks": ["anything that could go wrong or needs extra testing"],
  "test_plan": "how to verify the change works after deploy",
  "estimated_code_tokens": 50000
}

Guidelines:
- Be surgical. Change the minimum set of files needed.
- Never touch database schemas, deploy configs, or .env unless the request explicitly requires it.
- If the request is ambiguous, add entries to a top-level "open_questions" array.
- Respect any constraints in the operator's per-app context notes.
- Estimate tokens conservatively (the budget will be enforced).`;

function getRepoTree(repoDir) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
  } catch (_) {
    return '(could not read repo tree)';
  }
}

function grepRelevantFiles(repoDir, keywords, maxFiles = 8) {
  const files = new Set();
  for (const kw of keywords) {
    if (!kw || kw.length < 3) continue;
    try {
      const out = execFileSync('grep', ['-rl', '--include=*.js', '--include=*.ts', '--include=*.jsx', '--include=*.tsx', '--include=*.json', '--include=*.sql', kw, repoDir], {
        encoding: 'utf8', timeout: 10000, stdio: 'pipe',
      });
      for (const f of out.trim().split('\n')) {
        if (f && !f.includes('node_modules') && !f.includes('.git/')) files.add(f);
      }
    } catch (_) {}
    if (files.size >= maxFiles) break;
  }
  return [...files].slice(0, maxFiles);
}

function readFileSafe(path, maxBytes = 20000) {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length > maxBytes ? content.slice(0, maxBytes) + '\n... (truncated)' : content;
  } catch (_) {
    return '(could not read file)';
  }
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

export async function planEnhancement({ request, repoDir, agentContext, priorComments }) {
  const repoTree = getRepoTree(repoDir);
  const keywords = extractKeywords(request + ' ' + (priorComments || ''));
  const relevantPaths = grepRelevantFiles(repoDir, keywords);
  const fileContents = relevantPaths
    .map(p => `### ${p}\n\`\`\`\n${readFileSafe(p)}\n\`\`\``)
    .join('\n\n');

  const userContent = [
    `## Enhancement request\n\n${request}`,
    priorComments ? `## Prior reviewer feedback\n\n${priorComments}` : '',
    `## Repo tree\n\`\`\`\n${repoTree}\n\`\`\``,
    fileContents ? `## Relevant source files\n\n${fileContents}` : '',
    agentContext ? `## Per-app context (from operator)\n\n${agentContext}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  log.info(`AppStudio plan: ${MODEL}, ${relevantPaths.length} files in context`);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const plan = extractJsonBlock(text);
  const summary = text.replace(/```json[\s\S]*?```/, '').trim();

  return {
    plan,
    summary,
    rawText: text,
    tokensIn: response.usage?.input_tokens || 0,
    tokensOut: response.usage?.output_tokens || 0,
    costUsd: usdCost(response.usage || {}),
  };
}
