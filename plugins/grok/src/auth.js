import fs from 'node:fs';
import { openBrowser } from './browser.js';
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
  let candidate = raw.tokens || raw.credentials || raw.oauth || raw;
  let accessToken =
    candidate.access_token || candidate.accessToken || candidate.token || null;
  if (!accessToken) {
    // Official Grok CLI keys entries by "<issuer>::<uuid>" and stores the
    // access token under `key` (plus refresh_token / expires_at / oidc_client_id).
    const entry = Object.values(raw).find(
      (v) =>
        v &&
        typeof v === 'object' &&
        typeof v.key === 'string' &&
        (v.refresh_token || v.expires_at)
    );
    if (!entry) return null;
    candidate = entry;
    accessToken = entry.key;
  }
  const refreshToken = candidate.refresh_token || candidate.refreshToken || null;
  let expiresAt = candidate.expires_at || candidate.expiresAt || null;
  // Tolerate seconds vs. milliseconds epochs and ISO strings.
  if (typeof expiresAt === 'string') expiresAt = Date.parse(expiresAt) || null;
  if (typeof expiresAt === 'number' && expiresAt < 1e12) expiresAt *= 1000;
  const clientId = candidate.oidc_client_id || null;
  return { accessToken, refreshToken, expiresAt, clientId };
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
      const refreshConfig = tokens.clientId
        ? { ...config, clientId: tokens.clientId }
        : config;
      const fresh = await refreshTokens(refreshConfig, tokens.refreshToken);
      return fresh.accessToken;
    } catch (err) {
      console.error(`[grok-bridge] ${err.message}; using existing token`);
    }
  }
  return tokens.accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC 8628 step 1: request a device code. Returns the authorization payload
// (device_code, user_code, verification_uri[_complete], interval, expires_in).
export async function startDeviceAuth(config) {
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
  return {
    ...json,
    verify_url: json.verification_uri_complete || json.verification_uri,
    started_at: Date.now()
  };
}

// RFC 8628 step 2: poll the token endpoint until approved, denied, or
// timeoutMs elapses. Returns saved tokens on success, null if still pending
// at the timeout, and throws on a terminal error.
export async function pollDeviceAuth(config, device, timeoutMs = Infinity) {
  let interval = (device.interval || 5) * 1000;
  const expiry = device.started_at + (device.expires_in || 900) * 1000;
  const deadline = Math.min(expiry, Date.now() + timeoutMs);
  while (Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    const poll = await postForm(config.authBase + config.tokenPath, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: config.clientId
    });
    if (poll.status === 200 && poll.json.access_token) {
      return saveTokens(poll.json);
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
  if (Date.now() >= expiry) throw new Error('Device authorization timed out.');
  return null;
}

// Interactive CLI login: start the flow, print instructions, block until done.
export async function deviceLogin(config) {
  const device = await startDeviceAuth(config);
  console.log('\nTo authorize grok-bridge with your Grok subscription:');
  console.log(`  1. Open:  ${device.verify_url}`);
  if (!device.verification_uri_complete) {
    console.log(`  2. Enter code:  ${device.user_code}`);
  } else {
    console.log(`     (code: ${device.user_code})`);
  }
  if (openBrowser(device.verify_url)) {
    console.log('\nOpened the login page in your browser.');
  }
  console.log('\nWaiting for authorization...');
  const saved = await pollDeviceAuth(config, device);
  console.log('Logged in. Tokens saved to ~/.grok-bridge/auth.json');
  return saved;
}
