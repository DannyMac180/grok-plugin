import { getAccessToken } from './auth.js';

// Maps incoming model ids to Grok subscription models. Claude Code sends
// claude-* ids; Codex profiles may send anything. grok-* ids pass through;
// everything else runs on the one configured default model.
export function mapModel(model, config) {
  const m = String(model || '');
  return m.startsWith('grok-') ? m : config.defaultModel;
}

export async function buildAuthHeaders(config) {
  const token = await getAccessToken(config);
  if (token) {
    return {
      authorization: `Bearer ${token}`,
      // Do NOT send x-xai-token-auth: the upstream parses it as an auth-mode
      // enum, and an unrecognized value voids the entire auth context (401
      // "no auth context") even when the bearer token is valid.
      'x-grok-client-version': config.clientVersion,
      'x-grok-client-mode': config.clientMode,
      _mode: 'oauth'
    };
  }
  if (config.apiKey) {
    return { authorization: `Bearer ${config.apiKey}`, _mode: 'api-key' };
  }
  return null;
}

// Sends an OpenAI Chat Completions request to the Grok upstream and returns
// the raw fetch Response (streaming or not).
export async function chatCompletions(config, payload) {
  const headers = await buildAuthHeaders(config);
  if (!headers) {
    const err = new Error(
      'Not authenticated. Run `grok-bridge login`, or `grok login` with the ' +
        'official Grok CLI, or set XAI_API_KEY for metered API access.'
    );
    err.status = 401;
    throw err;
  }
  const { _mode, ...sendHeaders } = headers;
  const base = _mode === 'oauth' ? config.upstreamBase : config.apiBase;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { ...sendHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res;
}

export async function listModels(config) {
  const headers = await buildAuthHeaders(config);
  if (!headers) return null;
  const { _mode, ...sendHeaders } = headers;
  const base = _mode === 'oauth' ? config.upstreamBase : config.apiBase;
  try {
    const res = await fetch(`${base}/models`, { headers: sendHeaders });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Minimal SSE parser over a fetch body stream. Calls onData for each
// `data:` payload (already JSON-parsed; "[DONE]" is signalled via onDone).
export async function parseSSE(response, onData, onDone) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          onDone?.();
          return;
        }
        try {
          onData(JSON.parse(data));
        } catch {
          // Ignore malformed keep-alives.
        }
      }
    }
  }
  onDone?.();
}
