// End-to-end smoke test: mock Grok upstream + grok-bridge, exercising
// Anthropic /v1/messages (stream + non-stream) and OpenAI /v1/responses (stream).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME so the test never touches a real user's token store.
// (Must happen before the bridge modules are imported below.)
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bridge-test-'));
process.env.USERPROFILE = process.env.HOME;

// Fake auth so the bridge thinks we're logged in.
const dir = path.join(os.homedir(), '.grok-bridge');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'auth.json'),
  JSON.stringify({ access_token: 'test-token', expires_at: Date.now() + 3600e3 })
);

// Mock upstream serving chat completions.
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    console.log('[mock] got model:', payload.model, 'stream:', !!payload.stream, 'msgs:', payload.messages.length);
    if (!payload.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              message: {
                content: 'Hello from mock Grok',
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [
      { id: 'chatcmpl-2', choices: [{ delta: { content: 'Hel' } }] },
      { id: 'chatcmpl-2', choices: [{ delta: { content: 'lo' } }] },
      { id: 'chatcmpl-2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'run', arguments: '{"cmd":' } }] } }] },
      { id: 'chatcmpl-2', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { id: 'chatcmpl-2', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { id: 'chatcmpl-2', choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } }
    ];
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => mock.listen(9917, '127.0.0.1', r));

process.env.GROK_UPSTREAM_BASE = 'http://127.0.0.1:9917/v1';
process.env.GROK_BRIDGE_PORT = '9918';

const { startServer } = await import('../plugins/grok/src/server.js');
const { loadConfig } = await import('../plugins/grok/src/config.js');
const server = startServer(loadConfig());
await new Promise((r) => setTimeout(r, 300));

let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`);
  if (!cond) failures++;
};

// 1. Anthropic non-stream with tools + tool_result round trip
let r = await fetch('http://127.0.0.1:9918/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 100,
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'SF' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sunny' }] }
    ],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }]
  })
});
let j = await r.json();
check('anthropic non-stream status', r.status === 200);
check('anthropic content text', j.content?.[0]?.type === 'text' && j.content[0].text.includes('mock Grok'));
check('anthropic tool_use block', j.content?.[1]?.type === 'tool_use' && j.content[1].input.city === 'SF');
check('anthropic stop_reason', j.stop_reason === 'tool_use');
check('anthropic usage', j.usage.input_tokens === 10 && j.usage.output_tokens === 5);

// 2. Anthropic streaming
r = await fetch('http://127.0.0.1:9918/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] })
});
let text = await r.text();
check('anthropic stream message_start', text.includes('event: message_start'));
check('anthropic stream text deltas', text.includes('"text_delta"') && text.includes('Hel'));
check('anthropic stream tool block', text.includes('"tool_use"') && text.includes('input_json_delta'));
check('anthropic stream stop', text.includes('event: message_stop'));
check('anthropic stream usage', text.includes('"output_tokens":9'));

// 3. count_tokens
r = await fetch('http://127.0.0.1:9918/v1/messages/count_tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello world' }] })
});
j = await r.json();
check('count_tokens', r.status === 200 && j.input_tokens > 0);

// 4. Responses API streaming (Codex path, /openai prefix)
r = await fetch('http://127.0.0.1:9918/openai/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'grok-4.5',
    stream: true,
    instructions: 'Be terse.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', call_id: 'c9', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c9', output: 'a.txt' }
    ],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }]
  })
});
text = await r.text();
check('responses created', text.includes('event: response.created'));
check('responses text delta', text.includes('response.output_text.delta'));
check('responses fn args delta', text.includes('response.function_call_arguments.delta'));
check('responses item done', text.includes('response.output_item.done'));
check('responses completed with output', /response\.completed.*"name":"run".*"arguments":"\{\\"cmd\\":\\"ls\\"\}"/s.test(text) || (text.includes('response.completed') && text.includes('"cmd\\":')));
check('responses usage', text.includes('"input_tokens":7'));

// 5. Chat passthrough
r = await fetch('http://127.0.0.1:9918/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'anything', messages: [{ role: 'user', content: 'hi' }] })
});
j = await r.json();
check('passthrough', r.status === 200 && j.choices[0].message.content.includes('mock Grok'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASSED');
server.close();
mock.close();
process.exit(failures ? 1 : 0);
