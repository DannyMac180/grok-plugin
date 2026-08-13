---
name: grok-delegation
description: Delegate tasks to Grok (questions, research, code, analysis) or get an independent cross-vendor code review from Grok, on the user's Grok subscription. Use when the user asks to consult Grok, delegate work to Grok, or wants a second opinion from a non-OpenAI/non-Anthropic model.
---

# Delegating to Grok

Grok is available as a delegate through the `grok_delegate` and `grok_review` MCP tools, running on the user's Grok subscription (SuperGrok / X Premium).

## Delegation (`grok_delegate`)

- Grok cannot see the workspace. Make every task **self-contained**: put the task itself in `task`, and relevant file contents, diffs, error output, and constraints in `context`.
- Grok returns a finished work product (answer, code, analysis, findings) as text. Present it clearly attributed to Grok, and add your own assessment where you disagree or can verify against the workspace.

## Cross-vendor review (`grok_review`)

- Pass the code or unified diff in `code` and the intent plus focus areas in `goal`.
- Verify Grok's findings against the actual code before repeating them — check line references and claimed behavior, and drop anything that doesn't hold up. Report confirmed findings ordered by severity, findings you rejected and why, and Grok's overall verdict.

## First-use login

If either tool reports Grok is not authenticated, it returns a verification URL and code:

1. Show the user the URL and code and ask them to approve in a browser.
2. Call `grok_login_complete` (repeat if it reports still pending).
3. Retry the original delegation.

`grok_status` reports auth and configuration state. Terminal alternatives: `grok-bridge login`, or the official Grok CLI's `grok login` (its session is reused automatically).
