#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { deviceLogin, loadStoredTokens } from '../src/auth.js';
import { startServer } from '../src/server.js';
import {
  installCodex,
  installCodexProvider,
  installClaude,
  codexMcpSnippet,
  codexProviderSnippet
} from '../src/install.js';
import { buildAuthHeaders } from '../src/upstream.js';

const HELP = `grok-bridge — use your Grok (SuperGrok / X Premium) subscription in Claude Code and Codex

Usage:
  grok-bridge login                    OAuth device-code login against auth.x.ai
  grok-bridge mcp                      Run the stdio MCP server (grok_delegate & co.)
  grok-bridge status                   Show auth + config status
  grok-bridge install codex            Add the Grok MCP server to ~/.codex/config.toml

Advanced (Grok as the main model):
  grok-bridge serve [--port N]         Start the local translation proxy
  grok-bridge install claude           Create the grok-claude launcher for Claude Code
  grok-bridge install codex-provider   Add a grok model provider/profile to Codex
  grok-bridge print codex              Print the Codex config snippets without writing

Environment overrides:
  GROK_BRIDGE_PORT, GROK_BRIDGE_HOST, GROK_MODEL,
  GROK_UPSTREAM_BASE, GROK_OAUTH_BASE, GROK_OAUTH_CLIENT_ID, GROK_OAUTH_SCOPE,
  GROK_BRIDGE_NO_BROWSER=1 (don't auto-open the login page in a browser),
  XAI_API_KEY (fallback: metered API instead of subscription OAuth)
`;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const portFlag = process.argv.indexOf('--port');
  if (portFlag !== -1) process.env.GROK_BRIDGE_PORT = process.argv[portFlag + 1];
  const config = loadConfig();

  switch (cmd) {
    case 'login':
      await deviceLogin(config);
      break;

    case 'serve':
      startServer(config);
      break;

    case 'mcp': {
      const { startMcpServer } = await import('../src/mcp.js');
      startMcpServer(config);
      break;
    }

    case 'status': {
      const tokens = loadStoredTokens();
      if (tokens) {
        const exp = tokens.expiresAt
          ? new Date(tokens.expiresAt).toISOString()
          : 'unknown';
        console.log(`Auth: logged in via ${tokens.source} (token expires ${exp})`);
      } else if (config.apiKey) {
        console.log('Auth: using XAI_API_KEY (metered API, not subscription)');
      } else {
        console.log('Auth: not logged in. Run `grok-bridge login` or `grok login`.');
      }
      console.log(`Proxy:    http://${config.host}:${config.port}`);
      console.log(`Upstream: ${config.upstreamBase}`);
      console.log(`Model:    ${config.defaultModel}`);
      try {
        const headers = await buildAuthHeaders(config);
        console.log(`Mode:     ${headers ? headers._mode : 'unauthenticated'}`);
      } catch {
        // status stays best-effort
      }
      break;
    }

    case 'install':
      if (arg === 'codex') installCodex(config);
      else if (arg === 'codex-provider') installCodexProvider(config);
      else if (arg === 'claude' || arg === 'claude-code') installClaude(config);
      else {
        console.error('Usage: grok-bridge install <codex|codex-provider|claude>');
        process.exit(1);
      }
      break;

    case 'print':
      if (arg === 'codex')
        console.log(codexMcpSnippet() + '\n' + codexProviderSnippet(config));
      else {
        console.error('Usage: grok-bridge print codex');
        process.exit(1);
      }
      break;

    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
