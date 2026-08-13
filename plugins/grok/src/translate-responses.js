// OpenAI Responses API <-> Chat Completions translation.
// Codex CLI only speaks the Responses wire protocol (`wire_api = "responses"`),
// while Grok's subscription upstream speaks Chat Completions.

import crypto from 'node:crypto';

const uid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

function contentPartsToString(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')
        return p.text;
      if (p.type === 'input_image') return '[image omitted by grok-bridge]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function responsesToChat(body, config, mapModel) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else {
    for (const item of input || []) {
      const type = item.type || 'message';
      if (type === 'message') {
        messages.push({
          role: item.role || 'user',
          content: contentPartsToString(item.content)
        });
      } else if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id || uid('call'),
              type: 'function',
              function: { name: item.name, arguments: item.arguments || '{}' }
            }
          ]
        });
      } else if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content:
            typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output ?? '')
        });
      }
      // 'reasoning' and other item types have no upstream equivalent; drop.
    }
  }

  const payload = {
    model: mapModel(body.model, config),
    messages,
    stream: !!body.stream
  };
  if (body.stream) payload.stream_options = { include_usage: true };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.max_output_tokens) payload.max_tokens = body.max_output_tokens;
  if (body.parallel_tool_calls !== undefined)
    payload.parallel_tool_calls = body.parallel_tool_calls;

  const fnTools = (body.tools || []).filter((t) => t.type === 'function');
  if (fnTools.length) {
    payload.tools = fnTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    }));
  }
  if (typeof body.tool_choice === 'string') payload.tool_choice = body.tool_choice;
  return payload;
}

function buildOutputItems(msg) {
  const output = [];
  if (msg.content) {
    output.push({
      id: uid('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: msg.content, annotations: [] }]
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      id: uid('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id || uid('call'),
      name: tc.function?.name,
      arguments: tc.function?.arguments || '{}'
    });
  }
  return output;
}

function usageOf(chatJson) {
  return {
    input_tokens: chatJson?.usage?.prompt_tokens ?? 0,
    output_tokens: chatJson?.usage?.completion_tokens ?? 0,
    total_tokens: chatJson?.usage?.total_tokens ?? 0
  };
}

export function chatToResponsesResponse(chatJson, requestedModel) {
  const msg = chatJson.choices?.[0]?.message || {};
  return {
    id: uid('resp'),
    object: 'response',
    status: 'completed',
    model: requestedModel,
    output: buildOutputItems(msg),
    usage: usageOf(chatJson)
  };
}

// Streams chat chunks out as Responses API SSE events.
export function makeResponsesStreamWriter(res, requestedModel) {
  const responseId = uid('resp');
  let seq = 0;
  const send = (event, data) => {
    res.write(
      `event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: seq++ })}\n\n`
    );
  };

  const baseResponse = () => ({
    id: responseId,
    object: 'response',
    model: requestedModel,
    output: [],
    usage: null
  });

  send('response.created', {
    type: 'response.created',
    response: { ...baseResponse(), status: 'in_progress' }
  });

  let outputIndex = -1;
  // current item: { kind: 'text'|'fn', id, text?, name?, args?, callId? }
  let current = null;
  const completedItems = [];
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  const closeCurrent = () => {
    if (!current) return;
    if (current.kind === 'text') {
      const item = {
        id: current.id,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: current.text, annotations: [] }]
      };
      send('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: current.id,
        output_index: outputIndex,
        content_index: 0,
        text: current.text
      });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item
      });
      completedItems.push(item);
    } else {
      const item = {
        id: current.id,
        type: 'function_call',
        status: 'completed',
        call_id: current.callId,
        name: current.name,
        arguments: current.args
      };
      send('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: current.id,
        output_index: outputIndex,
        arguments: current.args
      });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item
      });
      completedItems.push(item);
    }
    current = null;
  };

  return {
    onChunk(chunk) {
      if (chunk.usage) usage = usageOf(chunk);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!current || current.kind !== 'text') {
          closeCurrent();
          outputIndex++;
          current = { kind: 'text', id: uid('msg'), text: '' };
          send('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              id: current.id,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: []
            }
          });
        }
        current.text += delta.content;
        send('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: current.id,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content
        });
      }

      for (const tc of delta.tool_calls || []) {
        const startsNew =
          !current || current.kind !== 'fn' || (tc.id && tc.id !== current.callId);
        if (startsNew) {
          closeCurrent();
          outputIndex++;
          current = {
            kind: 'fn',
            id: uid('fc'),
            callId: tc.id || uid('call'),
            name: tc.function?.name || '',
            args: ''
          };
          send('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              id: current.id,
              type: 'function_call',
              status: 'in_progress',
              call_id: current.callId,
              name: current.name,
              arguments: ''
            }
          });
        }
        if (tc.function?.name && !current.name) current.name = tc.function.name;
        if (tc.function?.arguments) {
          current.args += tc.function.arguments;
          send('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: current.id,
            output_index: outputIndex,
            delta: tc.function.arguments
          });
        }
      }
    },
    onDone() {
      closeCurrent();
      send('response.completed', {
        type: 'response.completed',
        response: {
          ...baseResponse(),
          status: 'completed',
          output: completedItems,
          usage
        }
      });
      res.end();
    }
  };
}
