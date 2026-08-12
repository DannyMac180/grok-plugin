import fs from 'node:fs';
import {
  AUTH_FILE,
  GROK_CLI_AUTH_FILE,
  ensureConfigDir,
  readJsonSafe
} from './config.js';

// Normalize the various token file shapes we might encounter
// (our own store, or the official Grok CLI's ~/.grok/auth.json).
function normalizeTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Some CLIs nest tokens under a key.
  const candidate = raw.tokens || raw.credentials || raw.oauth || raw;
  const accessToken =
    candidate.access_token || candidate.accessToken || candidate.token || null;
  if (!accessToken) return null;
  const refreshToken = candidate.refresh_token || candidate.refreshToken || null;
  let expiresAt = candidate.expires_at || candidate.expiresAt || null;
  // Tolerate seconds vs. milliseconds epochs and ISO strings.
  if (typeof expiresAt === 'string') expiresAt = Date.parse(expiresAt) || null;
  if (typeof expiresAt === 'number' && expiresAt < 1e12) expiresAt *= 1000;
  return { accessToken, refreshToken, expiresAt };
}

export function loadStoredTokens() {
  const own = normalizeTokens(readJsonSafe(AUTH_FILE));
  if (own) return { ...own, source: 'grok-bridge' };
  const cli = normalizeTokens(readJsonSafe(GROK_CLI_AUTH_FILE));
  if (cli) return { ...cli, source: 'grok-cli' };
  return null;
}

export function saveTokens(tokenResponse) {
  ensureConfigDir();
  const record = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || null,
    expires_at: tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : null,
    saved_at: new Date().toISOString()
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  return normalizeTokens(record);
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: 'invalid_response', error_description: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

export async function refreshTokens(config, refreshToken) {
  const { status, json } = await postForm(config.authBase + config.tokenPath, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId
  });
  if (status !== 200 || !json.access_token) {
    throw new Error(
      `Token refresh failed (${status}): ${json.error_description || json.error || 'unknown error'}`
    );
  }
  return saveTokens({ refresh_token: refreshToken, ...json });
}

// Returns a valid access token, refreshing if it expires within 5 minutes.
export async function getAccessToken(config) {
  const tokens = loadStoredTokens();
  if (!tokens) return null;
  const expiringSoon =
    tokens.expiresAt && tokens.expiresAt - Date.now() < 5 * 60 * 1000;
  if (expiringSoon && tokens.refreshToken) {
    try {
      const fresh = await refreshTokens(config, tokens.refreshToken);
      return fresh.accessToken;
    } catch (err) {
      console.error(`[grok-bridge] ${err.message}; using existing token`);
    }
  }
  return tokens.accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC 8628 device authorization flow.
export async function deviceLogin(config) {
  const { status, json } = await postForm(
    config.authBase + config.deviceCodePath,
    { client_id: config.clientId, scope: config.scope }
  );
  if (status !== 200 || !json.device_code) {
    throw new Error(
      `Device authorization request failed (${status}): ` +
        `${json.error_description || json.error || 'unknown error'}\n` +
        'If xAI has changed its OAuth endpoints, override them with ' +
        'GROK_OAUTH_BASE / GROK_OAUTH_CLIENT_ID, or log in with the official ' +
        'Grok CLI (`grok login`) — grok-bridge reuses ~/.grok/auth.json automatically.'
    );
  }

  const verifyUrl = json.verification_uri_complete || json.verification_uri;
  console.log('\nTo authorize grok-bridge with your Grok subscription:');
  console.log(`  1. Open:  ${verifyUrl}`);
  if (!json.verification_uri_complete) {
    console.log(`  2. Enter code:  ${json.user_code}`);
  } else {
    console.log(`     (code: ${json.user_code})`);
  }
  console.log('\nWaiting for authorization...');

  let interval = (json.interval || 5) * 1000;
  const deadline = Date.now() + (json.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await postForm(config.authBase + config.tokenPath, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: json.device_code,
      client_id: config.clientId
    });
    if (poll.status === 200 && poll.json.access_token) {
      const saved = saveTokens(poll.json);
      console.log('Logged in. Tokens saved to ~/.grok-bridge/auth.json');
      return saved;
    }
    const err = poll.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(
      `Authorization failed: ${poll.json.error_description || err || `HTTP ${poll.status}`}`
    );
  }
  throw new Error('Device authorization timed out.');
}
