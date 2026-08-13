import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, ensureConfigDir } from './config.js';

const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const MCP_MARKER = '# --- grok-bridge mcp (primary) ---';
const PROVIDER_MARKER = '# --- grok-bridge provider (advanced) ---';

export function codexMcpSnippet() {
  return `${MCP_MARKER}
[mcp_servers.grok]
command = "grok-bridge"
args = ["mcp"]
`;
}

export function codexProviderSnippet(config) {
  return `${PROVIDER_MARKER}
[model_providers.grok]
name = "Grok (subscription via grok-bridge)"
base_url = "http://${config.host}:${config.port}/openai/v1"
env_key = "GROK_BRIDGE_KEY"
wire_api = "responses"

[profiles.grok]
model_provider = "grok"
model = "${config.defaultModel}"
`;
}

function appendToCodexConfig(snippet, marker, label) {
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  const existing = fs.existsSync(CODEX_CONFIG)
    ? fs.readFileSync(CODEX_CONFIG, 'utf8')
    : '';
  if (existing.includes(marker)) {
    console.log(`Codex config already contains the ${label} block; leaving it as-is.`);
    return;
  }
  if (existing) {
    fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + '.bak');
    console.log(`Backed up existing config to ${CODEX_CONFIG}.bak`);
  }
  fs.writeFileSync(
    CODEX_CONFIG,
    existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n' + snippet
  );
  console.log(`Added ${label} to ${CODEX_CONFIG}`);
}

// Primary path: register the Grok MCP server with Codex so the agent can
// delegate to Grok (grok_delegate, grok_review, in-chat login).
export function installCodex() {
  appendToCodexConfig(codexMcpSnippet(), MCP_MARKER, '[mcp_servers.grok]');
  console.log(`
Next steps:
  1. Start Codex normally: codex
  2. Ask it to delegate something to Grok, e.g. "use grok_delegate to ..."
     On first use it will show a login link for your Grok subscription
     (or run \`grok-bridge login\` in a terminal ahead of time).

Note: this requires grok-bridge on your PATH (npm install -g grok-bridge).
`);
}

// Advanced path: Grok as the model driving Codex, via the translation proxy.
export function installCodexProvider(config) {
  appendToCodexConfig(
    codexProviderSnippet(config),
    PROVIDER_MARKER,
    '[model_providers.grok] + [profiles.grok]'
  );
  console.log(`
Next steps:
  1. Start the bridge:        grok-bridge serve
  2. Set the dummy key:       export GROK_BRIDGE_KEY=local
     (Codex requires env_key to be set; the bridge itself holds the real OAuth token.)
  3. Run Codex on Grok:       codex --profile grok
`);
}

export function installClaude(config) {
  ensureConfigDir();
  const binDir = path.join(CONFIG_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'grok-claude');
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
# Launch Claude Code against the local grok-bridge proxy (Grok subscription).
export ANTHROPIC_BASE_URL="http://${config.host}:${config.port}"
export ANTHROPIC_AUTH_TOKEN="grok-bridge-local"
export ANTHROPIC_MODEL="${config.defaultModel}"
export ANTHROPIC_SMALL_FAST_MODEL="${config.defaultModel}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec claude "$@"
`,
    { mode: 0o755 }
  );
  console.log(`Created launcher: ${wrapper}

Next steps:
  1. Start the bridge:   grok-bridge serve
  2. Launch Claude Code on Grok:
       ${wrapper}
     or add ${binDir} to your PATH and run: grok-claude

To use your normal Claude subscription again, just run plain \`claude\`.
`);
}
