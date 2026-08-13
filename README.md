# grok-plugin

Delegate tasks to **Grok** from inside **Claude Code** and **OpenAI Codex**, on your **Grok subscription** (SuperGrok or X Premium) — no metered xAI API key required.

> **Go deeper:** I write [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=grok-plugin) — deep, evidence-backed writing on AI, cognition, and agentic engineering. The **Agentic Engineering Field Notes** series is where I publish practical advice on the craft of using AI. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=grok-plugin) to get new posts to your inbox.

Your main agent stays whatever it is — Claude in Claude Code, GPT in Codex — and gains Grok as a delegate it can hand work to: questions, research, code to write or analyze, and independent cross-vendor code review. Models from different families have different blind spots; a second opinion from another lineage catches what same-family review misses.

Under the hood this is an MCP server that authenticates against xAI's OAuth device flow and calls Grok on your subscription quota. Login happens **in the chat**: the first time the agent delegates to Grok, it shows you a verification link — approve it in your browser and you're connected. Tokens refresh automatically.

## Install — Claude Code

```
/plugin marketplace add DannyMac180/grok-plugin
/plugin install grok@grok-plugin
```

That's it. Try:

```
/grok:delegate what are the trade-offs between SSE and WebSockets for streaming LLM output?
```

On first use, Grok's login link appears in the chat — open it, approve, done. (Already use the official Grok CLI? Your existing `grok login` session in `~/.grok/auth.json` is reused automatically — no login prompt at all.)

You get:

- **`grok_delegate`** — the agent hands Grok any self-contained task: a question, research, analysis, code to write or debug. Use it directly (`/grok:delegate ...`) or just ask Claude to "delegate this to Grok".
- **`grok_review`** — an independent second-opinion review of a diff or file, plus a **`grok-reviewer` agent** that gathers the diff, gets Grok's review, verifies the findings against the code, and reports what holds up.
- **`/grok:grok-setup`** — guided auth and setup for new machines.

## Install — Codex

Codex has no plugin marketplace, but it speaks MCP. Install the CLI once, register the server:

```bash
npm install -g grok-bridge     # or: git clone https://github.com/DannyMac180/grok-plugin && cd grok-plugin && npm install -g .
grok-bridge install codex      # adds [mcp_servers.grok] to ~/.codex/config.toml (backs up first)
codex
```

Then ask Codex to use `grok_delegate` / `grok_review` the same way. First use shows the same in-chat login link.

## How it works

```
Claude Code ──(bundled plugin MCP server)──┐
                                           ├── grok-bridge ── OAuth (auth.x.ai) ── Grok subscription upstream
Codex ────────([mcp_servers.grok])─────────┘        │
                                            device-code login,
                                            auto token refresh
```

One zero-dependency Node package (`grok-bridge`) provides the MCP server, the OAuth device flow, and — for advanced use — a local translation proxy that can put Grok in the driver's seat (below).

## CLI reference

```
grok-bridge login                    OAuth device-code login (terminal alternative to in-chat login)
grok-bridge mcp                      Run the stdio MCP server (what the plugin/Codex launch)
grok-bridge status                   Show auth + config status
grok-bridge install codex            Register the MCP server with Codex

Advanced (Grok as the main model):
grok-bridge serve [--port N]         Start the local translation proxy (default port 8017)
grok-bridge install claude           Create the grok-claude launcher
grok-bridge install codex-provider   Add a grok model provider/profile to Codex
grok-bridge print codex              Print the Codex config snippets without writing
```

### Configuration

Overridable via environment variables or `~/.grok-bridge/config.json`:

| Variable | Default | Purpose |
|---|---|---|
| `GROK_MODEL` | `grok-4.5` | model used for delegated tasks / main requests |
| `GROK_SMALL_MODEL` | `grok-4.5` | model used for small/fast requests (proxy mode) |
| `GROK_UPSTREAM_BASE` | `https://cli-chat-proxy.grok.com/v1` | subscription upstream |
| `GROK_OAUTH_BASE` | `https://auth.x.ai` | OAuth server |
| `GROK_OAUTH_CLIENT_ID` | `grok-cli` | OAuth client id |
| `GROK_BRIDGE_PORT` / `GROK_BRIDGE_HOST` | `8017` / `127.0.0.1` | proxy listen address (proxy mode) |
| `XAI_API_KEY` | — | fallback: metered API (`api.x.ai`) instead of subscription OAuth |

## Advanced: Grok as the main model

The plugin keeps Claude/GPT as the driver and Grok as a consultant. If you want **Grok itself driving** Claude Code or Codex — every request in the session running on your Grok subscription — grok-bridge includes a local translation proxy:

- It exposes an **Anthropic Messages** endpoint (streaming, tools, tool results, token counting) so Claude Code can run against it via `ANTHROPIC_BASE_URL`, and an **OpenAI Responses** endpoint (`wire_api = "responses"`) for Codex custom providers. Non-`grok-*` model ids are mapped to `GROK_MODEL`.

**Claude Code on Grok:**

```bash
grok-bridge serve                      # leave running
grok-bridge install claude             # creates the launcher
~/.grok-bridge/bin/grok-claude         # Claude Code, backed by Grok
```

Plain `claude` keeps using your Anthropic subscription — nothing global changes.

**Codex on Grok:**

```bash
grok-bridge serve                      # leave running
grok-bridge install codex-provider     # adds [model_providers.grok] + [profiles.grok]
export GROK_BRIDGE_KEY=local           # dummy; Codex requires env_key, the bridge holds the real token
codex --profile grok
```

## Caveats — read before relying on this

- **Unofficial integration.** The subscription upstream (`cli-chat-proxy.grok.com`) and its headers are used by xAI's own tooling and several community agents, but are not a documented public API. Endpoints, headers, or the OAuth client id can change without notice — every constant here is configurable so fixes don't require a code change. Check xAI's current terms before routing your subscription through third-party tools; the lowest-risk path is authenticating with the official Grok CLI (`grok login`) and letting grok-bridge reuse that session.
- **OAuth constants are best-effort.** If the device-flow login fails against the default endpoints, use `grok login` (recommended) or override `GROK_OAUTH_*`.
- **Grok can't see your workspace.** Delegation is text-in, text-out — the agent must include relevant files/diffs in the tool call (the bundled commands and agent handle this). In proxy mode, protocol translation is lossy at the edges: images and Anthropic "thinking" blocks are dropped with placeholders; Codex `reasoning` items are skipped.
- **Rate limits** come out of your Grok subscription quota, shared with your Grok app usage.
- The proxy binds to `127.0.0.1` only. Tokens are stored with `0600` permissions in `~/.grok-bridge/auth.json`.

## Development

```bash
npm test                            # both suites: proxy translation + MCP e2e (mock upstreams)
node bin/grok-bridge.js mcp         # run the MCP server from the repo
node bin/grok-bridge.js serve       # run the proxy from the repo
```

Repo layout:

```
.claude-plugin/                Claude Code plugin + marketplace manifests
commands/                      /grok:delegate, /grok:grok-setup
agents/                        grok-reviewer agent
bin/grok-bridge.js             CLI entrypoint
src/mcp.js                     MCP server (grok_delegate, grok_review, in-chat login)
src/auth.js                    device-code OAuth, token store, refresh
src/upstream.js                Grok upstream client, model mapping, SSE parser
src/config.js                  defaults + env/file overrides
src/server.js                  HTTP proxy routing (advanced mode)
src/translate-anthropic.js     Anthropic Messages ⇄ Chat Completions
src/translate-responses.js     OpenAI Responses ⇄ Chat Completions
src/install.js                 Codex MCP/provider installers, grok-claude launcher
test/                          smoke tests for both modes
```

## License

MIT
