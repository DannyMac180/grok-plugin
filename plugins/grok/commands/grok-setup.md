---
description: Connect the user's Grok subscription (login) and optionally set up Codex or advanced mode
---

Help the user set up Grok access:

1. Call the `grok_status` MCP tool. If already authenticated, say so and stop unless they want more.
2. If not authenticated, call `grok_login`, show the user the verification URL and code, and ask them to approve in a browser. Then call `grok_login_complete` (repeat if still pending) and confirm success. If the device flow errors and the official Grok CLI is installed, `grok login` in a terminal also works — the plugin reuses `~/.grok/auth.json`.
3. If the user also wants Grok in **Codex**: the marketplace install is `codex plugin marketplace add DannyMac180/grok-plugin --ref main` then `codex plugin add grok@grok-plugin`. (Fallback for Codex versions without plugin support: install the CLI globally — `npm install -g grok-bridge` — then `grok-bridge install codex` registers the MCP server in `~/.codex/config.toml`.)
4. If they want Grok as the **main model** driving Claude Code or Codex (advanced), point them at the "Advanced: Grok as the main model" section of this plugin's README — that path uses the `grok-bridge serve` proxy.
