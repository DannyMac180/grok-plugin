// Stdio MCP server exposing Grok as a delegate inside Claude Code and Codex.
// Zero-dependency implementation of the MCP stdio transport
// (newline-delimited JSON-RPC 2.0).

import readline from 'node:readline';
import { loadConfig } from './config.js';
import { loadStoredTokens, startDeviceAuth, pollDeviceAuth } from './auth.js';
import { chatCompletions, mapModel, buildAuthHeaders } from './upstream.js';
import { openBrowser } from './browser.js';

const SERVER_INFO = { name: 'grok-bridge', version: '0.4.0' };

const DELEGATE_SYSTEM_PROMPT =
  'You are Grok, acting as a delegate for another AI coding agent. ' +
  'The agent hands you a task — a question, a piece of work, research, a search, ' +
  'code to write or analyze — and you complete it directly and thoroughly. ' +
  'Return the finished work product itself (answer, code, analysis, findings), ' +
  'not a plan or offer to help. Be precise; if the task or provided context is ' +
  'insufficient, state exactly what is missing.';

const REVIEW_SYSTEM_PROMPT =
  'You are Grok, providing an independent second-opinion code review for another ' +
  'AI coding agent. Look for real defects: correctness bugs, edge cases, security ' +
  'issues, and misleading design. Report findings ordered by severity with ' +
  'file/line references where possible. Say clearly if the code looks sound; do ' +
  'not invent findings to seem useful.';

const TOOLS = [
  {
    name: 'grok_delegate',
    description:
      'Delegate any task to Grok (runs on the user\'s Grok subscription): a question, ' +
      'research, analysis, writing or reviewing code, brainstorming — anything expressible ' +
      'in text. Include all needed context in the request; Grok cannot see the workspace. ' +
      'Returns Grok\'s finished work product. If not authenticated, this returns login ' +
      'instructions — relay the verification URL to the user, then call grok_login_complete.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task for Grok, fully self-contained.'
        },
        context: {
          type: 'string',
          description:
            'Optional supporting material: file contents, diffs, error output, prior discussion.'
        },
        model: {
          type: 'string',
          description: 'Optional Grok model id override (e.g. grok-4.6).'
        }
      },
      required: ['task']
    }
  },
  {
    name: 'grok_review',
    description:
      'Ask Grok for an independent cross-vendor review of code or a diff. ' +
      'Returns findings ordered by severity.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code or unified diff to review.'
        },
        goal: {
          type: 'string',
          description: 'What the code is supposed to do, plus any focus areas.'
        },
        model: { type: 'string', description: 'Optional Grok model id override.' }
      },
      required: ['code']
    }
  },
  {
    name: 'grok_login',
    description:
      'Start the Grok OAuth device-code login. Opens the login page in the user\'s ' +
      'browser automatically and returns the verification URL and code — repeat them ' +
      'in your final user-visible message, ask the user to approve, then call ' +
      'grok_login_complete.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'grok_login_complete',
    description:
      'Finish a login started with grok_login: waits (up to ~60s per call) for the user ' +
      'to approve in the browser. Call again if it reports still pending.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'grok_status',
    description: 'Report Grok authentication and configuration status.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const text = (s, isError = false) => ({
  content: [{ type: 'text', text: s }],
  isError
});

// The login link must actually reach the human: auto-open their browser
// (chat clients don't always render tool-call text), and tell the agent to
// repeat the URL + code in its final user-visible message either way.
function loginInstructions(device, preamble = '') {
  const opened = openBrowser(device.verify_url);
  return (
    preamble +
    (opened
      ? 'The login page has been opened in the user\'s browser automatically.\n\n'
      : '') +
    'Login link and code:\n\n' +
    `  ${device.verify_url}\n  code: ${device.user_code}\n\n` +
    'IMPORTANT: repeat this URL and code verbatim in your final user-visible ' +
    'message — text written between tool calls may never be shown to the user. ' +
    'Ask the user to approve the login in their browser, then call ' +
    'grok_login_complete. (Alternative: run `grok-bridge login` or the official ' +
    'Grok CLI\'s `grok login` in a terminal.)'
  );
}

export function startMcpServer(config = loadConfig()) {
  let pendingDevice = null;

  async function ensureAuthOrInstructions() {
    const headers = await buildAuthHeaders(config).catch(() => null);
    if (headers) return null;
    // Not authenticated: kick off the device flow so the agent can present
    // the URL conversationally.
    try {
      pendingDevice = await startDeviceAuth(config);
      return text(
        loginInstructions(
          pendingDevice,
          'Grok is not authenticated yet. To connect the user\'s Grok subscription ' +
            '(SuperGrok or X Premium), the user must approve a device login.\n\n'
        ),
        true
      );
    } catch (err) {
      return text(
        `Grok is not authenticated and the device-flow login could not be started: ${err.message}`,
        true
      );
    }
  }

  async function callGrok(system, userContent, modelOverride) {
    const authProblem = await ensureAuthOrInstructions();
    if (authProblem) return authProblem;
    const payload = {
      model: modelOverride?.startsWith?.('grok-')
        ? modelOverride
        : mapModel(modelOverride, config),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ],
      stream: false
    };
    const res = await chatCompletions(config, payload);
    if (!res.ok) {
      const body = await res.text();
      return text(`Grok upstream error ${res.status}: ${body.slice(0, 800)}`, true);
    }
    const json = await res.json();
    const answer = json.choices?.[0]?.message?.content || '(empty response)';
    return text(answer);
  }

  const handlers = {
    async grok_delegate(args) {
      let content = args.task;
      if (args.context) content += `\n\n--- Context ---\n${args.context}`;
      return callGrok(DELEGATE_SYSTEM_PROMPT, content, args.model);
    },

    async grok_review(args) {
      let content = '';
      if (args.goal) content += `Goal / focus areas:\n${args.goal}\n\n`;
      content += `Code to review:\n\n${args.code}`;
      return callGrok(REVIEW_SYSTEM_PROMPT, content, args.model);
    },

    async grok_login() {
      pendingDevice = await startDeviceAuth(config);
      return text(loginInstructions(pendingDevice));
    },

    async grok_login_complete() {
      if (!pendingDevice) {
        return text('No login in progress — call grok_login first.', true);
      }
      const tokens = await pollDeviceAuth(config, pendingDevice, 60_000);
      if (!tokens) {
        return text(
          'Still waiting for the user to approve the login in their browser. ' +
            'Call grok_login_complete again once they have.'
        );
      }
      pendingDevice = null;
      return text('Logged in. Grok is ready — the user\'s subscription is connected.');
    },

    async grok_status() {
      const tokens = loadStoredTokens();
      const lines = [];
      if (tokens) {
        const exp = tokens.expiresAt
          ? new Date(tokens.expiresAt).toISOString()
          : 'unknown';
        lines.push(`Authenticated via ${tokens.source} (token expires ${exp}).`);
      } else if (config.apiKey) {
        lines.push('Using XAI_API_KEY (metered API, not subscription).');
      } else {
        lines.push('Not authenticated. Use grok_login, or run `grok-bridge login`.');
      }
      lines.push(`Default model: ${config.defaultModel}`);
      lines.push(`Upstream: ${config.upstreamBase}`);
      return text(lines.join('\n'));
    }
  };

  function handleRequest(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const handler = handlers[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        return handler(args).catch((err) => text(`Error: ${err.message}`, true));
      }
      default:
        if (msg.method?.startsWith('notifications/')) return undefined;
        throw Object.assign(new Error(`Method not found: ${msg.method}`), {
          code: -32601
        });
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore garbage
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await handleRequest(msg);
      if (!isNotification) write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    } catch (err) {
      if (!isNotification) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: err.code || -32603, message: err.message }
        });
      }
    }
  });

  rl.on('close', () => process.exit(0));
  console.error('[grok-bridge] MCP server ready (stdio)');
}
