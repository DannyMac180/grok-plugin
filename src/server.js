import http from 'node:http';
import { loadConfig } from './config.js';
import { chatCompletions, listModels, mapModel, parseSSE } from './upstream.js';
import {
  anthropicToChat,
  chatToAnthropicResponse,
  makeAnthropicStreamWriter,
  estimateTokens
} from './translate-anthropic.js';
import {
  responsesToChat,
  chatToResponsesResponse,
  makeResponsesStreamWriter
} from './translate-responses.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
}

async function forwardUpstreamError(res, upstream, style) {
  const text = await upstream.text();
  let detail;
  try {
    detail = JSON.parse(text);
  } catch {
    detail = { message: text.slice(0, 1000) };
  }
  const message =
    detail?.error?.message || detail?.message || `Upstream error ${upstream.status}`;
  if (style === 'anthropic') {
    sendJson(res, upstream.status, {
      type: 'error',
      error: { type: 'api_error', message }
    });
  } else {
    sendJson(res, upstream.status, {
      error: { message, type: 'upstream_error', code: String(upstream.status) }
    });
  }
}

async function handleAnthropicMessages(config, body, res) {
  const payload = anthropicToChat(body, config, mapModel);
  const upstream = await chatCompletions(config, payload);
  if (!upstream.ok) return forwardUpstreamError(res, upstream, 'anthropic');

  if (payload.stream) {
    sseHead(res);
    const writer = makeAnthropicStreamWriter(res, body.model);
    await parseSSE(upstream, writer.onChunk, writer.onDone);
  } else {
    const json = await upstream.json();
    sendJson(res, 200, chatToAnthropicResponse(json, body.model));
  }
}

async function handleResponses(config, body, res) {
  const payload = responsesToChat(body, config, mapModel);
  const upstream = await chatCompletions(config, payload);
  if (!upstream.ok) return forwardUpstreamError(res, upstream, 'openai');

  if (payload.stream) {
    sseHead(res);
    const writer = makeResponsesStreamWriter(res, body.model);
    await parseSSE(upstream, writer.onChunk, writer.onDone);
  } else {
    const json = await upstream.json();
    sendJson(res, 200, chatToResponsesResponse(json, body.model));
  }
}

async function handleChatPassthrough(config, body, res) {
  const payload = { ...body, model: mapModel(body.model, config) };
  const upstream = await chatCompletions(config, payload);
  if (!upstream.ok) return forwardUpstreamError(res, upstream, 'openai');
  if (payload.stream) {
    sseHead(res);
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } else {
    sendJson(res, 200, await upstream.json());
  }
}

export function startServer(config = loadConfig()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Normalize the /openai prefix used in Codex provider config.
    const path = url.pathname.replace(/^\/openai/, '');
    try {
      if (req.method === 'GET' && (path === '/healthz' || path === '/')) {
        return sendJson(res, 200, { ok: true, service: 'grok-bridge' });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const models = await listModels(config);
        return sendJson(
          res,
          200,
          models || {
            object: 'list',
            data: [{ id: config.defaultModel, object: 'model', owned_by: 'xai' }]
          }
        );
      }
      if (req.method !== 'POST') {
        return sendJson(res, 404, { error: { message: `No route ${req.method} ${path}` } });
      }
      const body = await readBody(req);
      if (path === '/v1/messages') return await handleAnthropicMessages(config, body, res);
      if (path === '/v1/messages/count_tokens')
        return sendJson(res, 200, { input_tokens: estimateTokens(body) });
      if (path === '/v1/responses') return await handleResponses(config, body, res);
      if (path === '/v1/chat/completions')
        return await handleChatPassthrough(config, body, res);
      return sendJson(res, 404, { error: { message: `No route ${req.method} ${path}` } });
    } catch (err) {
      console.error(`[grok-bridge] ${req.method} ${url.pathname}: ${err.message}`);
      if (res.headersSent) return res.end();
      sendJson(res, err.status || 500, {
        type: 'error',
        error: { type: 'api_error', message: err.message }
      });
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`grok-bridge listening on http://${config.host}:${config.port}`);
    console.log(`  Anthropic endpoint (Claude Code): http://${config.host}:${config.port}/v1/messages`);
    console.log(`  Responses endpoint (Codex):       http://${config.host}:${config.port}/openai/v1/responses`);
    console.log(`  Default model: ${config.defaultModel}`);
  });
  return server;
}
