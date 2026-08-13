// Read-only diagnostics for `grok-bridge doctor`.
//
// Do NOT import getAccessToken, buildAuthHeaders, or chatCompletions — those
// call refreshTokens -> saveTokens and would mutate ~/.grok-bridge/auth.json.
// Token inspection uses loadStoredTokens() (readJsonSafe only). The
// auth-headers probe rebuilds the exact sendable production header set:
//   Authorization: Bearer <accessToken>
//   x-grok-client-version / x-grok-client-mode   (oauth; matches
//     buildAuthHeaders() after it strips `_mode`)
//   Authorization: Bearer <apiKey>               (metered path)
// Never send x-xai-token-auth (upstream treats it as an auth-mode enum;
// an unknown value voids the whole auth context — HTTP 401 "no auth context").
// Never print token or api-key values. Codex markers are imported from
// install.js so the two files can never drift out of sync.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { CONFIG_DIR, CONFIG_FILE, AUTH_FILE, GROK_CLI_AUTH_FILE, readJsonSafe } from './config.js';
import { loadStoredTokens } from './auth.js';
import { CODEX_CONFIG, MCP_MARKER, PROVIDER_MARKER, CLAUDE_LAUNCHER } from './install.js';

const REACH_MS = 5000;
const AUTH_PROBE_MS = 12000;
const HEALTHZ_MS = 1000;
const PORT_PROBE_MS = 3000;

function home(p) {
  const h = os.homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

function httpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function timedOut(err) {
  // undici sometimes wraps the timeout in err.cause (aborts often surface as
  // a top-level `TypeError: fetch failed` with the real name on err.cause).
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    err.cause?.name === 'TimeoutError' ||
    err.cause?.name === 'AbortError' ||
    err.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
  );
}

// Builds a check result object. `bits` is an array of detail fragments
// joined with `, ` (or a pre-joined string); keeps the six check functions
// from repeating the same four-field object shape.
function result(name, status, bits, hint = null) {
  return { name, status, detail: Array.isArray(bits) ? bits.join(', ') : bits, hint };
}

export function checkConfig(config) {
  const bits = [];
  let status = 'ok';
  let hint = null;
  const fail = (d, h) => {
    bits.push(d);
    status = 'fail';
    hint = hint || h;
  };

  try {
    fs.accessSync(CONFIG_DIR, fs.constants.R_OK);
    bits.push('dir readable');
  } catch {
    if (fs.existsSync(CONFIG_DIR)) fail('dir not readable', 'chmod u+rx ~/.grok-bridge');
    else bits.push('dir absent (defaults)');
  }
  if (fs.existsSync(CONFIG_FILE)) {
    if (readJsonSafe(CONFIG_FILE)) bits.push('config.json ok');
    else fail('config.json invalid', 'fix JSON in ~/.grok-bridge/config.json');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    fail(`port ${config.port} out of range`, 'set GROK_BRIDGE_PORT to an integer 1-65535');
  } else bits.push(`port ${config.port}`);

  const bad = ['upstreamBase', 'apiBase', 'authBase'].filter((k) => !httpUrl(config[k]));
  if (bad.length) {
    fail(
      `bad URLs: ${bad.join(',')}`,
      'fix GROK_UPSTREAM_BASE / GROK_API_BASE / GROK_OAUTH_BASE to absolute http(s) URLs'
    );
  } else bits.push('URLs valid');

  if (!String(config.defaultModel || '').trim()) {
    fail('defaultModel empty', 'set GROK_MODEL or defaultModel in config.json');
  } else bits.push(`model ${config.defaultModel}`);

  return result('config', status, bits, hint);
}

export function checkToken(config, tokens) {
  if (!tokens || !tokens.accessToken) {
    if (config.apiKey) return result('token', 'ok', 'XAI_API_KEY (metered API)');
    return result(
      'token',
      'fail',
      'no stored tokens and no XAI_API_KEY',
      'grok-bridge login  (or grok login / set XAI_API_KEY)'
    );
  }
  const store = home(tokens.source === 'grok-cli' ? GROK_CLI_AUTH_FILE : AUTH_FILE);
  const bits = [store];
  let status = 'ok';
  let hint = null;
  const warn = (d, h) => {
    bits.push(d);
    if (status === 'ok') status = 'warn';
    hint = hint || h;
  };

  // Production getAccessToken() (auth.js) refreshes an expired token whenever
  // a refreshToken + clientId are available. An expired-but-refreshable token
  // is a working install, not a broken one — only report 'fail' when there is
  // no refresh path.
  const cid = tokens.clientId || config.clientId;
  const refreshViable = Boolean(tokens.refreshToken && cid);
  const expired = Boolean(tokens.expiresAt && tokens.expiresAt <= Date.now());

  if (!tokens.expiresAt) warn('expiry unknown', 'grok-bridge login  (store has no expiresAt)');
  else if (expired) {
    if (refreshViable) {
      warn(
        'expired (refresh viable; doctor does not refresh)',
        'a real request will auto-refresh it; run `grok-bridge login` to force it now'
      );
    } else {
      bits.push('EXPIRED');
      status = 'fail';
      hint = 'grok-bridge login  (token expired; no refresh token/clientId to refresh with)';
    }
  } else if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    warn('expiring soon', 'token expires within 5m; doctor will not refresh');
  } else bits.push('unexpired');

  if (!tokens.refreshToken) {
    warn('no refresh token', 'grok-bridge login  (no refresh token; re-login required at expiry)');
  } else if (!cid) {
    warn('refresh token present, no clientId', 'set GROK_OAUTH_CLIENT_ID (needed to refresh)');
  } else if (!expired) {
    // Already noted inline above for the expired case; avoid repeating it.
    bits.push('refresh viable');
  }

  return result('token', status, bits, hint);
}

export async function checkUpstream(config, tokens) {
  // Probe the base the auth path will actually use: oauth tokens go to
  // upstreamBase, an API key (with no stored tokens) goes to apiBase.
  const oauth = Boolean(tokens?.accessToken) || !config.apiKey;
  const url = oauth ? config.upstreamBase : config.apiBase;
  const envVar = oauth ? 'GROK_UPSTREAM_BASE' : 'GROK_API_BASE';
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(REACH_MS) });
    return result('upstream', 'ok', `GET ${url}  HTTP ${res.status} (reachable)`);
  } catch (err) {
    const why = timedOut(err) ? `timed out after ${REACH_MS}ms` : err.cause?.message || err.message;
    return result('upstream', 'fail', `GET ${url}  ${why}`, `check network / DNS / ${envVar}`);
  }
}

// Rebuilds the exact production header set (see file header) from the
// already-loaded config/tokens, without going through buildAuthHeaders() so
// the doctor never triggers a token refresh (a disk write). Exported so the
// test suite can assert this stays aligned with buildAuthHeaders()'s real
// output (minus `_mode`; content-type is added by callers like
// chatCompletions, not by buildAuthHeaders itself, so it's excluded from the
// comparison) — drift here would mean the probe passes/fails on headers the
// server doesn't actually send.
export function probeAuth(config, tokens) {
  if (tokens?.accessToken) {
    return {
      base: config.upstreamBase,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'x-grok-client-version': config.clientVersion,
        'x-grok-client-mode': config.clientMode,
        'content-type': 'application/json'
      }
    };
  }
  if (config.apiKey) {
    return {
      base: config.apiBase,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }
    };
  }
  return null;
}

// NOTE: this check spends one real completion (max_tokens: 1) of your
// subscription/API quota per doctor run — it's the only way to verify the
// header shape is actually accepted by the upstream, not just well-formed.
export async function checkAuthHeaders(config, tokens) {
  const probe = probeAuth(config, tokens);
  if (!probe) return result('auth-headers', 'skip', 'skipped (not authenticated)', 'grok-bridge login');
  if (tokens?.accessToken && tokens.expiresAt && tokens.expiresAt <= Date.now()) {
    // checkToken already flagged this (fail if unrecoverable, warn if
    // refresh-viable) — probing a known-dead token proves nothing but still
    // spends a quota completion, so skip regardless of which it was.
    const cid = tokens.clientId || config.clientId;
    const refreshViable = Boolean(tokens.refreshToken && cid);
    return result(
      'auth-headers',
      'skip',
      `skipped (token expired${refreshViable ? '; refresh viable, doctor does not refresh' : ''}; probe would spend quota on a known 401)`,
      refreshViable ? 'a real request will auto-refresh it; run `grok-bridge login` to force it now' : 'grok-bridge login'
    );
  }

  const url = `${String(probe.base).replace(/\/$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: probe.headers,
      body: JSON.stringify({
        model: config.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
        stream: false
      }),
      signal: AbortSignal.timeout(AUTH_PROBE_MS)
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return result('auth-headers', 'ok', `POST /chat/completions accepted (HTTP ${res.status})`);
    if (res.status === 401 && /no auth context|x_xai_token_auth/i.test(text)) {
      return result(
        'auth-headers',
        'fail',
        'header-level rejection (HTTP 401, reason=no auth context)',
        'upstream rejected the header shape; ensure x-xai-token-auth is never sent and probeAuth() matches buildAuthHeaders()'
      );
    }
    if (res.status === 401 || res.status === 403) {
      return result(
        'auth-headers',
        'fail',
        `credential rejected (HTTP ${res.status}); token present but upstream denied it`,
        'grok-bridge login'
      );
    }
    return result(
      'auth-headers',
      'warn',
      `headers accepted, upstream HTTP ${res.status}`,
      'check GROK_MODEL / upstream payload; auth itself was not rejected'
    );
  } catch (err) {
    const why = timedOut(err) ? `timed out after ${AUTH_PROBE_MS}ms` : err.cause?.message || err.message;
    return result(
      'auth-headers',
      'fail',
      `POST /chat/completions  ${why}`,
      'check network; auth probe could not complete'
    );
  }
}

export function checkInstall() {
  let toml = '';
  try {
    toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
  } catch {
    /* absent */
  }
  const mcp = toml.includes(MCP_MARKER);
  const provider = toml.includes(PROVIDER_MARKER);
  const claude = fs.existsSync(CLAUDE_LAUNCHER);
  const bits = [
    mcp ? 'Codex MCP present' : 'Codex MCP missing',
    provider ? 'Codex provider present' : 'Codex provider missing',
    claude ? 'Claude launcher present' : 'Claude launcher missing'
  ];
  const fixes = [];
  if (!mcp) fixes.push('grok-bridge install codex');
  if (!claude) fixes.push('grok-bridge install claude');
  return result('install', mcp && claude ? 'ok' : 'warn', bits, fixes.join(' ; ') || null);
}

function probeListen(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    // Keep the handle referenced until the probe resolves — an early unref()
    // let the process exit mid-DNS-lookup for a bad GROK_BRIDGE_HOST.
    // A bad GROK_BRIDGE_HOST hostname can stall in DNS; never hang the doctor.
    const timer = setTimeout(() => {
      srv.close();
      resolve('timed out');
    }, PORT_PROBE_MS);
    timer.unref();
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    srv.once('error', (err) => done(err.code || 'error'));
    try {
      srv.listen(port, host, () => srv.close(() => done('free')));
    } catch (err) {
      // net throws SYNCHRONOUSLY for some bad inputs (e.g. NaN/out-of-range
      // ports -> ERR_SOCKET_BAD_PORT) instead of emitting 'error'.
      clearTimeout(timer);
      resolve(err.code || err.message || 'error');
    }
  });
}

export async function checkPort(config) {
  const { host, port } = config;
  const listen = await probeListen(host, port);
  if (listen === 'free') return result('port', 'ok', `${port} free`);
  if (listen !== 'EADDRINUSE') {
    return result('port', 'fail', `${port} listen error ${listen}`, 'check GROK_BRIDGE_HOST / GROK_BRIDGE_PORT');
  }
  const busyFail = (detail) =>
    result('port', 'fail', detail, 'stop the other listener or set GROK_BRIDGE_PORT to a free port');
  const hostUrl = host.includes(':') ? `[${host}]` : host; // IPv6 literal
  try {
    const res = await fetch(`http://${hostUrl}:${port}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTHZ_MS)
    });
    const json = await res.json().catch(() => null);
    if (json && json.ok === true && json.service === 'grok-bridge') {
      return result('port', 'ok', `${port} occupied by grok-bridge (GET /healthz ok)`);
    }
    return busyFail(`${port} occupied by another process (GET /healthz HTTP ${res.status})`);
  } catch {
    return busyFail(`${port} occupied (not grok-bridge; /healthz not reachable)`);
  }
}

const GLYPH = { ok: 'ok  ', fail: 'fail', warn: 'warn', skip: 'skip' };

function printResults(results) {
  console.log('grok-bridge doctor\n');
  for (const r of results) {
    console.log(`[${GLYPH[r.status]}] ${r.name.padEnd(12)} ${r.detail}`);
    if (r.hint && r.status !== 'ok') console.log(`${' '.repeat(20)}fix: ${r.hint}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `\n${results.length} checks: ${n('ok')} ok, ${n('warn')} warn, ${n('fail')} fail, ${n('skip')} skip`
  );
}

export async function runDoctor(config) {
  try {
    const tokens = loadStoredTokens();
    const results = [
      checkConfig(config),
      checkToken(config, tokens),
      await checkUpstream(config, tokens),
      await checkAuthHeaders(config, tokens),
      checkInstall(),
      await checkPort(config)
    ];
    printResults(results);
    return results.some((r) => r.status === 'fail') ? 1 : 0;
  } catch (err) {
    console.error(`doctor aborted: ${err.message}`);
    return 2;
  }
}
