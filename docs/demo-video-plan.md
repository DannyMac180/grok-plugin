# grok-plugin demo video plan

One video, two cuts: a ~75s cut for X and a ~2.5min master embedded in the Substack post.

## The story (one sentence)

Claude Code and Codex both hire Grok as a delegate — a Claude Code agent team builds a change with Grok-powered subagents, then Codex asks Grok to review the very change that team made. Cross-vendor, on your Grok subscription, no API key.

Why this narrative works: it demos both clients in one continuous storyline instead of two disconnected clips, and the handoff moment ("now let's have the *other* CLI check their work") is the hook. Keep that framing — it's stronger than "here's feature A, here's feature B."

## Two refinements to the original idea

1. **Keep the agent team small: 2–3 subagents, not a fleet.** Subagent fan-out is slow and visually noisy on screen. Three parallel agents each calling `grok_delegate` reads as "team" on camera; five reads as scrolling soup. Record the whole thing in real time and speed-ramp it in the edit — never cut it out entirely, the parallel tool-call spam *is* the visual.
2. **Deliberately capture the first-use login as its own beat.** "No metered API key — approve a link in chat and you're connected" is the differentiator vs. every other MCP bridge. De-auth before recording (move `~/.grok-bridge/auth.json` and `~/.grok/auth.json` aside) so the verification link appears on camera. Blur/crop the device code in the edit.

## Demo task (what the agents actually build)

Pick something small, real, and legible in one screen. Two good options:

- **Meta option (recommended):** improve grok-plugin with grok-plugin. E.g. "add a `grok-bridge doctor` command that checks auth, config, and upstream reachability" — three subagents: one designs the checks (delegating research to Grok), one implements, one runs the `grok-reviewer` agent on the diff. The self-referential angle writes the X post for you.
- **Neutral option:** a tiny standalone repo (a CLI utility, a small web endpoint) if you'd rather not show plugin internals.

Either way: the change must produce a clean `git diff` under ~150 lines, because that diff is the baton passed to Codex.

## Pre-recording checklist

- [ ] Fresh terminal profile: large font (16–18pt), high-contrast theme, window sized 16:9-friendly (e.g. 1920×1080 recording, terminal near-fullscreen). Hide OS clutter (menu bar, notifications on Do Not Disturb).
- [ ] Clean shell history and prompt (short `$PS1`, no company/hostname leakage).
- [ ] `grok-plugin` installable from the public repo — verify `/plugin marketplace add DannyMac180/grok-plugin` works cold.
- [ ] De-auth Grok (`mv ~/.grok-bridge/auth.json{,.bak}; mv ~/.grok/auth.json{,.bak}`) so the login beat happens live. Have the browser pre-logged-in to your X account so approval is one click.
- [ ] Demo repo at a clean starting commit; the branch for the change pre-decided.
- [ ] Codex installed with plugin support; rehearse `codex plugin marketplace add DannyMac180/grok-plugin --ref main` once, then remove it so install is fresh on camera.
- [ ] Dry-run the whole flow once off-camera. Note where the slow parts are — those are your speed-ramp targets.
- [ ] Record at native resolution, 60fps if the recorder allows (smoother speed-ramps), system audio off, no mic needed if you're doing captions-only (recommended for X autoplay).

## Shot list / script

Record everything in real time as continuous takes per scene; all pacing happens in the edit.

### Scene 0 — Cold open (edit-only, ~6s)
Title card over a dark frame or a freeze of the terminal:
"Claude Code and Codex just hired the same contractor."
Then beat: "grok-plugin — delegate to Grok from either CLI, on your Grok subscription."

### Scene 1 — Install in Claude Code (~10s on screen)
```
/plugin marketplace add DannyMac180/grok-plugin
/plugin install grok@grok-plugin
```
Two commands, done. Caption: "Install: two commands. No API key."

### Scene 2 — First delegation + in-chat login (~15s)
Prompt Claude with the kickoff task (see Scene 3) or a quick warm-up `/grok:delegate` — the point is that the first `grok_delegate` call triggers the login. Capture: tool call fires → verification URL + code appear in chat → quick cut to browser → one-click approve → back to terminal → `grok_login_complete` succeeds → delegation proceeds.
Caption: "First use: Grok's login link appears in the chat. Approve it. Connected."

### Scene 3 — The agent team (~25–30s after speed-ramp; raw take will be minutes)
Single prompt to Claude Code, shown on screen long enough to read, e.g.:

> Spin up a team of three subagents to add a `grok-bridge doctor` command: one researches the design by delegating to Grok, one implements it, one gets a grok-reviewer second opinion on the diff. Run them in parallel where possible.

Capture: subagents spawning, parallel `grok_delegate` / `grok_review` tool calls streaming. This is the centerpiece — speed-ramp 4–8x with 2–3 slow-downs on the juiciest frames (a `grok_delegate` call with visible `task`/`context`, the grok-reviewer verifying a finding).
Caption during the fast section: "3 Claude subagents, each delegating to Grok in parallel."

### Scene 4 — The result (~10s)
`git diff --stat` then a brief scroll of the interesting hunk. Commit it.
Caption: "Shipped by the team. Now — second opinion from the other side of the fence."

### Scene 5 — Codex takes the review (~20s)
New terminal (visually distinct — different theme tint helps the "different CLI" read):
```
codex plugin marketplace add DannyMac180/grok-plugin --ref main
codex plugin add grok@grok-plugin
codex
```
Then: "Use grok_review to review the diff on this branch — the intent was X." Capture Codex calling `grok_review`, findings coming back, Codex verifying them against the code.
Caption: "Same plugin, zero reconfiguration. Codex asks Grok to review what Claude's team built."

### Scene 6 — Findings + close (~12s)
Linger on Grok's verdict / confirmed findings for a readable beat.
End card: repo URL `github.com/DannyMac180/grok-plugin`, install one-liners for both CLIs, "Runs on SuperGrok / X Premium. MIT."

## Edit plan (for the videoedit tool)

Master timeline (~2:30):

| Segment | Source | Treatment |
|---|---|---|
| Cold open | title card | 6s, hard cut in |
| Install (CC) | Scene 1 raw | jump-cut dead air between the two commands; caption lower-third |
| Login | Scene 2 raw | real-time (this beat should feel instant, don't rush it artificially); **blur the device code**; punch-in zoom on the verification URL line |
| Agent team | Scene 3 raw | speed-ramp 4–8x; 2–3 slow-to-1x moments with punch-in zooms on tool calls; subtle timer overlay optional ("elapsed 4:32 → shown in 25s") |
| Diff | Scene 4 raw | 1x, punch-in on the diffstat |
| Codex review | Scene 5 raw | jump-cut install; 1x for the grok_review call and findings |
| Close | end card | 6–8s hold |

Global treatments:
- **Captions on everything** — assume muted autoplay on X. Short lines, lower third, high contrast.
- **Punch-in zooms** (~120–140%) on every moment where the viewer must read one specific line: the login URL, a `grok_delegate` payload, the review verdict.
- **Speed changes should be visible, not hidden** — the audience should *feel* "this ran for minutes, compressed for you."
- Music optional; if used, something low-key and duck it to nothing during the two slow-down moments.
- Redaction pass last: device code, any tokens, email, hostname in prompt.

X cut (~75s): Cold open (4s) → Install (6s) → Login (10s) → Agent team ramped harder (25s) → one diff beat (5s) → Codex grok_review (18s) → end card (7s). Drop Scene 4's scroll; keep only the diffstat flash.

Substack: embed the master; the post can breathe and explain what the X cut only gestures at.

## Draft copy

### X post (attach the 75s cut)

> claude code and codex just hired the same contractor
>
> built grok-plugin: an MCP bridge that gives both CLIs grok as a delegate — questions, research, code, and cross-vendor code review. runs on your grok subscription, no API key
>
> here's a claude agent team building a feature with grok's help, then codex asking grok to review their work
>
> github.com/DannyMac180/grok-plugin

### Substack blurb (opening, adjust to taste)

> Every model family has blind spots, and they're family traits. Claude reviewing Claude's code, or GPT reviewing GPT's, is a sibling checking a sibling's homework.
>
> So I built grok-plugin: an MCP bridge that lets Claude Code and Codex both delegate to Grok — on your Grok subscription, no metered API key. The login happens in the chat. In the video below, a team of Claude subagents builds a feature with Grok's help, and then Codex — a different vendor entirely — hands the diff to Grok for an independent review.
>
> Three model families in one workflow, each doing what it's positioned to do.

## Fallbacks

- If the live login flakes on camera, use `grok-bridge login` in a separate take and splice it — the terminal device-flow is the same story, slightly less magic.
- If the agent team take goes sideways, the meta task has a cheap retry: reset the branch, re-prompt. Record 2–3 takes of Scene 3 regardless; pick the one with the cleanest parallel tool-call visuals.
- If Codex plugin install misbehaves, the manual fallback (`grok-bridge install codex`) still demos fine — one extra command, same review beat.
