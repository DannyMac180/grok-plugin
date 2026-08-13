// E2E test of the MCP server: unauthenticated delegate -> in-chat device-flow
// login -> successful delegation, against mock OAuth and Grok upstreams.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mcp-test-'));

let approved = false; // flips after the "user" approves the device login

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/oauth2/device/code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          device_code: 'dev123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.example/activate',
          verification_uri_complete: 'https://auth.example/activate?code=ABCD-1234',
          interval: 0.05,
          expires_in: 300
        })
      );
    } else if (req.url === '/oauth2/token') {
      res.writeHead(approved ? 200 : 400, { 'content-type': 'application/json' });
      res.end(
        approved
          ? JSON.stringify({ access_token: 'tok-live', refresh_token: 'ref', expires_in: 3600 })
          : JSON.stringify({ error: 'authorization_pending' })
      );
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1',
          choices: [{ message: { content: 'Delegated result from mock Grok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4 }
        })
      );
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
});
await new Promise((r) => mock.listen(9927, '127.0.0.1', r));

const child = spawn('node', [path.join(repoRoot, 'plugins', 'grok', 'bin', 'grok-bridge.js'), 'mcp'], {
  env: {
    ...process.env,
    HOME,
    USERPROFILE: HOME,
    GROK_OAUTH_BASE: 'http://127.0.0.1:9927',
    GROK_UPSTREAM_BASE: 'http://127.0.0.1:9927/v1'
  },
  stdio: ['pipe', 'pipe', 'inherit']
});

let nextId = 1;
const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 90_000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const callTool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return { text: r.result.content[0].text, isError: !!r.result.isError };
};

let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`);
  if (!cond) failures++;
};

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' }
});
check('initialize', init.result?.serverInfo?.name === 'grok-bridge');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc('tools/list', {});
const names = list.result.tools.map((t) => t.name);
check(
  'tools/list',
  ['grok_delegate', 'grok_review', 'grok_login', 'grok_login_complete', 'grok_status'].every((n) =>
    names.includes(n)
  )
);

// Unauthenticated delegate -> login instructions with the device-flow URL.
let r = await callTool('grok_delegate', { task: 'say hi' });
check('unauthenticated delegate is error', r.isError);
check('login URL surfaced in chat', r.text.includes('https://auth.example/activate') && r.text.includes('ABCD-1234'));

// Still pending before the user approves.
r = await callTool('grok_login_complete');
check('login pending before approval', r.text.includes('Still waiting'));

// "User" approves in the browser.
approved = true;
r = await callTool('grok_login_complete');
check('login completes after approval', r.text.includes('Logged in'));

// Now delegation works.
r = await callTool('grok_delegate', { task: 'summarize', context: 'some file contents' });
check('delegate returns Grok result', !r.isError && r.text.includes('Delegated result from mock Grok'));

r = await callTool('grok_review', { code: 'diff --git a b', goal: 'check for bugs' });
check('review returns Grok result', !r.isError && r.text.includes('Delegated result from mock Grok'));

r = await callTool('grok_status');
check('status shows authenticated', r.text.includes('Authenticated via grok-bridge'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL MCP TESTS PASSED');
child.kill();
mock.close();
process.exit(failures ? 1 : 0);
