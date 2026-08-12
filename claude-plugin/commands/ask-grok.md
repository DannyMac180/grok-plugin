---
description: Ask Grok a question through your Grok subscription (via grok-bridge)
---

Ask Grok the following question and relay its answer: $ARGUMENTS

Steps:
1. Check the local grok-bridge proxy is running: `curl -sf http://127.0.0.1:8017/healthz`.
   - If it is not running, tell the user to start it with `grok-bridge serve` (and `grok-bridge login` if they have not authenticated), then stop.
2. Send the question via the OpenAI-compatible passthrough endpoint:
   ```
   curl -sS http://127.0.0.1:8017/v1/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"grok-4.5","messages":[{"role":"user","content":<QUESTION AS JSON STRING>}]}'
   ```
   Build the JSON body carefully (write it to a temp file if quoting gets awkward).
3. Present Grok's answer clearly, attributed to Grok. If the question relates to code in this repository, include relevant file context in the message you send to Grok.
