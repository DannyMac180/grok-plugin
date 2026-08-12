# grok-bridge

Use your **Grok subscription** (SuperGrok or X Premium) inside **Claude Code** and **OpenAI Codex** — no metered xAI API key required.

> **Go deeper:** I write [**Attention Heads**](https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=grok-plugin) — deep, evidence-backed writing on AI, cognition, and agentic engineering. The **Agentic Engineering Field Notes** series is where I publish practical advice on the craft of using AI. [Subscribe](https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=grok-plugin) to get new posts to your inbox.

xAI ships a first-class OAuth device-code flow for coding agents (`auth.x.ai`). Neither Claude Code nor Codex lets a plugin swap in a third-party OAuth model provider directly, so grok-bridge does it with a small local proxy:

```
                          ┌──────────────────────────────┐
  Claude Code ───────────▶│           grok-bridge         │
  (Anthropic Messages API)│  ┌────────┐  ┌─────────────┐ │      Grok subscription
                          │  │ OAuth  │  │ protocol    │ │────▶ upstream (OpenAI-
  Codex CLI ─────────────▶│  │ + auto │  │ translation │ │      compatible endpoint)
  (OpenAI Responses API)  │  │refresh │  └─────────────┘ │
                          │  └────────┘                  │
                          └──────────────────────────────┘
```

- **For Claude Code**: exposes an Anthropic-compatible `/v1/messages` endpoint (streaming, tools, tool results) and a `grok-claude` launcher that points `ANTHROPIC_BASE_URL` at it.
- **For Codex**: exposes an OpenAI **Responses API** endpoint (`wire_api = "responses"` — the only protocol modern Codex speaks) and installs a `grok` provider + profile into `~/.codex/config.toml`.
- **Auth**: OAuth 2.0 device-code login against `auth.x.ai`, with automatic token refresh. If you already use the official Grok CLI, grok-bridge reuses your existing `~/.grok/auth.json` — no separate login needed.

A [Claude Code plugin](#claude-code-plugin-optional) is also included for a lighter-weight "ask Grok from inside Claude Code" workflow.

## Install

Requires Node.js ≥ 18.

```bash
git clone https://github.com/DannyMac180/grok-plugin
cd grok-plugin
npm install -g .
```

## Quick start

**1. Log in with your Grok subscription** (pick one):

```bash
grok-bridge login     # OAuth device flow: open the printed URL, enter the code
# — or —
grok login            # official Grok CLI; grok-bridge reuses ~/.grok/auth.json
```

Check it worked:

```bash
grok-bridge status
```

**2. Start the bridge** (leave it running while you work):

```bash
grok-bridge serve
```

**3a. Claude Code:**

```bash
grok-bridge install claude
~/.grok-bridge/bin/grok-claude        # launches Claude Code backed by Grok
```

The installer creates a `grok-claude` launcher that sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and the model env vars, then execs `claude`. Plain `claude` keeps using your Anthropic subscription — nothing global is changed. Add `~/.grok-bridge/bin` to your `PATH` for convenience.

**3b. Codex:**

```bash
grok-bridge install codex             # adds provider + profile to ~/.codex/config.toml (backs up first)
export GROK_BRIDGE_KEY=local          # Codex requires env_key to be set; value is a dummy —
                                      # the real OAuth token lives in the bridge
codex --profile grok
```

## Claude Code plugin (optional)

If you'd rather keep Claude as your main model and just *consult* Grok, install the bundled plugin:

```
/plugin marketplace add DannyMac180/grok-plugin
/plugin install grok@grok-plugin
```

It adds:

- `/grok:ask-grok <question>` — sends a question to Grok through the bridge and relays the answer
- `/grok:grok-setup` — walks you through installing/authenticating grok-bridge on a new machine

## CLI reference

```
grok-bridge login              OAuth device-code login against auth.x.ai
grok-bridge serve [--port N]   Start the local translation proxy (default port 8017)
grok-bridge status             Show auth + config status
grok-bridge install claude     Create the grok-claude launcher
grok-bridge install codex      Add a grok provider/profile to ~/.codex/config.toml
grok-bridge print codex        Print the Codex config snippet without writing it
```

### Endpoints served

| Endpoint | Protocol | Used by |
|---|---|---|
| `POST /v1/messages` (+ `/count_tokens`) | Anthropic Messages | Claude Code |
| `POST /openai/v1/responses` | OpenAI Responses | Codex |
| `POST /v1/chat/completions` | OpenAI Chat Completions | plugin, scripts, anything else |
| `GET /v1/models`, `GET /healthz` | — | tooling |

### Configuration

Everything is overridable via environment variables or `~/.grok-bridge/config.json`:

| Variable | Default | Purpose |
|---|---|---|
| `GROK_BRIDGE_PORT` / `GROK_BRIDGE_HOST` | `8017` / `127.0.0.1` | where the proxy listens |
| `GROK_MODEL` | `grok-4.5` | model used for main requests |
| `GROK_SMALL_MODEL` | `grok-4.5` | model used for small/fast requests |
| `GROK_UPSTREAM_BASE` | `https://cli-chat-proxy.grok.com/v1` | subscription upstream |
| `GROK_OAUTH_BASE` | `https://auth.x.ai` | OAuth server |
| `GROK_OAUTH_CLIENT_ID` | `grok-cli` | OAuth client id |
| `XAI_API_KEY` | — | fallback: use the metered API (`api.x.ai`) instead of OAuth |

Non-`grok-*` model ids (e.g. the `claude-*` ids Claude Code sends) are mapped to `GROK_MODEL`; ids containing `haiku`/`small`/`mini` map to `GROK_SMALL_MODEL`.

## Caveats — read before relying on this

- **Unofficial integration.** The subscription upstream (`cli-chat-proxy.grok.com`) and its headers are used by xAI's own tooling and several community agents, but are not a documented public API. Endpoints, headers, or the OAuth client id can change without notice — every constant here is configurable so fixes don't require a code change. Check xAI's current terms before routing your subscription through third-party tools; the lowest-risk path is authenticating with the official Grok CLI (`grok login`) and letting grok-bridge reuse that session.
- **OAuth constants are best-effort.** If `grok-bridge login` fails against the default endpoints, use `grok login` (recommended) or override `GROK_OAUTH_*`.
- **Protocol translation is lossy at the edges.** Text, streaming, tool calls, and tool results are fully translated (and covered by tests against a mock upstream). Images and Anthropic "thinking" blocks are dropped with placeholders; Codex `reasoning` items are skipped.
- **Rate limits** come out of your Grok subscription quota, shared with your Grok app usage.
- Traffic binds to `127.0.0.1` only. Tokens are stored with `0600` permissions in `~/.grok-bridge/auth.json`.

## Development

```bash
node bin/grok-bridge.js serve       # run from the repo without installing
```

Repo layout:

```
bin/grok-bridge.js           CLI entrypoint
src/config.js                defaults + env/file overrides
src/auth.js                  device-code OAuth, token store, refresh
src/upstream.js              Grok upstream client, model mapping, SSE parser
src/translate-anthropic.js   Anthropic Messages ⇄ Chat Completions
src/translate-responses.js   OpenAI Responses ⇄ Chat Completions
src/server.js                HTTP routing
src/install.js               Claude Code launcher + Codex config installers
claude-plugin/               Claude Code plugin (commands)
```

## License

MIT
