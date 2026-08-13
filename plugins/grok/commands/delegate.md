---
description: Delegate a task to Grok (question, research, code, review) on the user's Grok subscription
---

Delegate the following to Grok using the `grok_delegate` MCP tool: $ARGUMENTS

Guidelines:
- Grok cannot see this workspace. Put everything it needs into the tool call: relevant file contents, diffs, error output, and constraints go in the `context` parameter; the task itself goes in `task`.
- If the tool responds that Grok is not authenticated, relay the verification URL and code to the user, ask them to approve in a browser, then call `grok_login_complete` and retry the delegation.
- Present Grok's result clearly attributed to Grok, and add your own assessment where you disagree or can verify against the workspace.
