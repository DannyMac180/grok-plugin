import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.grok-bridge');
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const GROK_CLI_AUTH_FILE = path.join(os.homedir(), '.grok', 'auth.json');

const DEFAULTS = {
  // Local proxy
  port: 8017,
  host: '127.0.0.1',

  // Upstream: xAI subscription proxy (OpenAI Chat Completions compatible).
  // Falls back to the metered API if you use an XAI_API_KEY instead of OAuth.
  upstreamBase: 'https://cli-chat-proxy.grok.com/v1',
  apiBase: 'https://api.x.ai/v1',

  // Model routing: anything that isn't a grok-* model id is mapped to defaultModel.
  defaultModel: 'grok-4.5',
  smallModel: 'grok-4.5',

  // OAuth (RFC 8628 device flow). These constants may need updating if xAI
  // changes them — every one is overridable via env or ~/.grok-bridge/config.json.
  authBase: 'https://auth.x.ai',
  deviceCodePath: '/oauth2/device/code',
  tokenPath: '/oauth2/token',
  clientId: 'grok-cli',
  scope: 'openid profile offline_access',

  // Headers the subscription proxy expects.
  clientVersion: '1.0.0',
  clientMode: 'cli'
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const fileCfg = readJsonSafe(CONFIG_FILE) || {};
  const env = process.env;
  return {
    ...DEFAULTS,
    ...fileCfg,
    port: Number(env.GROK_BRIDGE_PORT || fileCfg.port || DEFAULTS.port),
    host: env.GROK_BRIDGE_HOST || fileCfg.host || DEFAULTS.host,
    upstreamBase: env.GROK_UPSTREAM_BASE || fileCfg.upstreamBase || DEFAULTS.upstreamBase,
    apiBase: env.GROK_API_BASE || fileCfg.apiBase || DEFAULTS.apiBase,
    defaultModel: env.GROK_MODEL || fileCfg.defaultModel || DEFAULTS.defaultModel,
    smallModel: env.GROK_SMALL_MODEL || fileCfg.smallModel || DEFAULTS.smallModel,
    authBase: env.GROK_OAUTH_BASE || fileCfg.authBase || DEFAULTS.authBase,
    clientId: env.GROK_OAUTH_CLIENT_ID || fileCfg.clientId || DEFAULTS.clientId,
    scope: env.GROK_OAUTH_SCOPE || fileCfg.scope || DEFAULTS.scope,
    apiKey: env.XAI_API_KEY || fileCfg.apiKey || null
  };
}

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export { readJsonSafe };
