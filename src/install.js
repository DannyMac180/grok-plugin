import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, ensureConfigDir } from './config.js';

const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const MARKER = '# --- added by grok-bridge ---';

export function codexSnippet(config) {
  return `${MARKER}
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

export function installCodex(config) {
  const snippet = codexSnippet(config);
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  const existing = fs.existsSync(CODEX_CONFIG)
    ? fs.readFileSync(CODEX_CONFIG, 'utf8')
    : '';
  if (existing.includes(MARKER)) {
    console.log('Codex config already contains a grok-bridge provider block; leaving it as-is.');
  } else {
    if (existing) {
      fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + '.bak');
      console.log(`Backed up existing config to ${CODEX_CONFIG}.bak`);
    }
    fs.writeFileSync(CODEX_CONFIG, existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n' + snippet);
    console.log(`Added [model_providers.grok] + [profiles.grok] to ${CODEX_CONFIG}`);
  }
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
export ANTHROPIC_SMALL_FAST_MODEL="${config.smallModel}"
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
