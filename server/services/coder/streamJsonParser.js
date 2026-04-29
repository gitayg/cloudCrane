/**
 * Parse a single line of Claude's --output-format stream-json output.
 * Returns a structured event or null for unparseable lines.
 *
 * Event shapes emitted:
 *   { type: 'text',   text }
 *   { type: 'tool',   name, input }
 *   { type: 'result', inputTokens, outputTokens, costUsdCents }
 *   { type: 'system', subtype, data }   — everything else (message_start, etc.)
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (_) {
    return null;
  }

  const evType = obj.type;

  if (evType === 'assistant' && Array.isArray(obj.message?.content)) {
    // stream-json verbose wraps assistant turn in a top-level "assistant" event
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text) {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool', name: block.name, input: block.input };
      }
    }
  }

  if (evType === 'result') {
    const usage = obj.usage || {};
    const inputTok  = usage.input_tokens  || 0;
    const outputTok = usage.output_tokens || 0;
    // Rough cost: sonnet-4.6 pricing (3/15 per million input/output)
    const cents = Math.round(((inputTok * 3 + outputTok * 15) / 1_000_000) * 100);
    return { type: 'result', inputTokens: inputTok, outputTokens: outputTok, costUsdCents: cents };
  }

  // text delta from content_block_delta
  if (evType === 'content_block_delta' && obj.delta?.type === 'text_delta') {
    return { type: 'text', text: obj.delta.text };
  }

  // tool_use from content_block_start
  if (evType === 'content_block_start' && obj.content_block?.type === 'tool_use') {
    return { type: 'tool', name: obj.content_block.name, input: obj.content_block.input || {} };
  }

  return { type: 'system', subtype: evType, data: obj };
}
