---
description: Set up grok-bridge so this machine can use a Grok subscription in Claude Code and Codex
---

Help the user set up grok-bridge on this machine:

1. Check whether `grok-bridge` is installed (`command -v grok-bridge`). If not, install it: `npm install -g grok-bridge` (or from this repo: `npm install -g .` at the repo root).
2. Check auth state with `grok-bridge status`. If not logged in, run `grok-bridge login` and show the user the verification URL and code it prints — they must open the link in a browser to approve. If the device flow fails and the official Grok CLI is installed, `grok login` works too (grok-bridge reuses `~/.grok/auth.json`).
3. Ask which integrations they want, then run `grok-bridge install claude` and/or `grok-bridge install codex` and explain what was written.
4. Remind them the bridge must be running (`grok-bridge serve`) whenever they use `grok-claude` or `codex --profile grok`. Suggest running it in the background or under their process manager of choice.
