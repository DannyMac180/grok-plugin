// Anthropic Messages API <-> OpenAI Chat Completions translation.
// This is what lets Claude Code (which speaks the Anthropic protocol via
// ANTHROPIC_BASE_URL) talk to Grok's OpenAI-compatible endpoint.

import crypto from 'node:crypto';

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function toolResultToString(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p.type === 'text' ? p.text : `[${p.type} omitted]`))
      .join('\n');
  }
  return JSON.stringify(c ?? '');
}

const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn'
};

export function anthropicToChat(body, config, mapModel) {
  const messages = [];

  if (body.system) {
    messages.push({ role: 'system', content: textOfBlocks(body.system) });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    // Split block arrays into the right sequence of OpenAI messages while
    // preserving order: text (+tool_use) in one message, tool_results after.
    let pendingText = [];
    let pendingToolCalls = [];
    const flush = () => {
      if (pendingText.length || pendingToolCalls.length) {
        const m = { role: msg.role, content: pendingText.join('\n') || null };
        if (pendingToolCalls.length) m.tool_calls = pendingToolCalls;
        messages.push(m);
        pendingText = [];
        pendingToolCalls = [];
      }
    };
    for (const block of msg.content || []) {
      if (block.type === 'text') {
        pendingText.push(block.text);
      } else if (block.type === 'image') {
        pendingText.push('[image omitted by grok-bridge]');
      } else if (block.type === 'tool_use') {
        pendingToolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          }
        });
      } else if (block.type === 'tool_result') {
        flush();
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolResultToString(block)
        });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Not representable upstream; drop.
      }
    }
    flush();
  }

  const payload = {
    model: mapModel(body.model, config),
    messages,
    max_tokens: body.max_tokens,
    stream: !!body.stream
  };
  if (body.stream) payload.stream_options = { include_usage: true };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.stop_sequences?.length) payload.stop = body.stop_sequences;

  if (body.tools?.length) {
    payload.tools = body.tools
      .filter((t) => t.input_schema) // skip server tools (web_search etc.)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema
        }
      }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') payload.tool_choice = 'auto';
    else if (tc.type === 'any') payload.tool_choice = 'required';
    else if (tc.type === 'tool')
      payload.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'none') payload.tool_choice = 'none';
  }
  return payload;
}

function parseArgs(argString) {
  try {
    return JSON.parse(argString || '{}');
  } catch {
    return { _raw: argString };
  }
}

export function chatToAnthropicResponse(chatJson, requestedModel) {
  const choice = chatJson.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
      name: tc.function?.name,
      input: parseArgs(tc.function?.arguments)
    });
  }
  return {
    id: chatJson.id || `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: chatJson.usage?.prompt_tokens ?? 0,
      output_tokens: chatJson.usage?.completion_tokens ?? 0
    }
  };
}

// Streams OpenAI chat chunks out as Anthropic SSE events.
export function makeAnthropicStreamWriter(res, requestedModel) {
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let started = false;
  let blockIndex = -1;
  let openBlock = null; // 'text' | 'tool'
  const toolIndexMap = new Map(); // openai tool_call index -> anthropic block index
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  const start = (id) => {
    if (started) return;
    started = true;
    send('message_start', {
      type: 'message_start',
      message: {
        id: id || `msg_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  };

  const closeBlock = () => {
    if (openBlock !== null) {
      send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      openBlock = null;
    }
  };

  return {
    onChunk(chunk) {
      start(chunk.id);
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (delta.content) {
        if (openBlock !== 'text') {
          closeBlock();
          blockIndex++;
          openBlock = 'text';
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content }
        });
      }

      for (const tc of delta.tool_calls || []) {
        const key = tc.index ?? 0;
        if (!toolIndexMap.has(key)) {
          closeBlock();
          blockIndex++;
          openBlock = 'tool';
          toolIndexMap.set(key, blockIndex);
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id || `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
              name: tc.function?.name || '',
              input: {}
            }
          });
        }
        if (tc.function?.arguments) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: toolIndexMap.get(key),
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          });
        }
      }
    },
    onDone() {
      start();
      closeBlock();
      send('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: STOP_REASON_MAP[finishReason] || 'end_turn',
          stop_sequence: null
        },
        usage
      });
      send('message_stop', { type: 'message_stop' });
      res.end();
    }
  };
}

// Rough token estimate for the count_tokens endpoint (Claude Code calls it
// for context accounting; exactness is not required for correct behavior).
export function estimateTokens(body) {
  const text = JSON.stringify(body.messages || []) + JSON.stringify(body.system || '');
  return Math.max(1, Math.round(text.length / 4));
}
