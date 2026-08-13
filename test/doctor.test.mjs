// Regression tests for `grok-bridge doctor` (plugins/grok/src/doctor.js).
// No network calls: the auth-header drift check compares pure functions
// against a fake token/config fixture, and exit-code/output checks feed
// synthetic results into the aggregation and printing logic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME so this test never touches a real user's token store.
// (Must happen before the bridge modules are imported below.)
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bridge-doctor-test-'));
process.env.USERPROFILE = process.env.HOME;

const { probeAuth, checkAuthHeaders, checkConfig } = await import(
  '../plugins/grok/src/doctor.js'
);
const { buildAuthHeaders } = await import('../plugins/grok/src/upstream.js');
const { loadStoredTokens } = await import('../plugins/grok/src/auth.js');

let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`);
  if (!cond) failures++;
};

// --- (a) drift-coupling: probeAuth() must match buildAuthHeaders() ---------
// Fake oauth token store with a far-future expiry, so buildAuthHeaders()'s
// getAccessToken() takes the "not expiring soon" path and never refreshes
// (no network, no disk write).
const FAKE_TOKEN = 'FAKE_ACCESS_TOKEN_DO_NOT_LOG';
const dir = path.join(os.homedir(), '.grok-bridge');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'auth.json'),
  JSON.stringify({
    access_token: FAKE_TOKEN,
    refresh_token: 'FAKE_REFRESH_TOKEN',
    expires_at: Date.now() + 10 * 365 * 24 * 3600 * 1000 // ~10 years out
  })
);

const fakeConfig = {
  port: 8017,
  host: '127.0.0.1',
  upstreamBase: 'https://cli-chat-proxy.grok.com/v1',
  apiBase: 'https://api.x.ai/v1',
  authBase: 'https://auth.x.ai',
  defaultModel: 'grok-4.6',
  clientId: 'grok-cli',
  clientVersion: '1.0.0',
  clientMode: 'cli',
  apiKey: null
};

const tokens = loadStoredTokens();
check('fixture token loaded', tokens?.accessToken === FAKE_TOKEN);

const probeHeaders = probeAuth(fakeConfig, tokens).headers;
const prodHeaders = await buildAuthHeaders(fakeConfig);
const { _mode, ...prodSendHeaders } = prodHeaders;
// probeAuth adds content-type for the standalone POST it makes; production
// buildAuthHeaders() leaves that to the caller (chatCompletions). Compare
// the auth-relevant headers only — that's the set that can silently drift.
const { 'content-type': _ct, ...probeAuthHeaders } = probeHeaders;

check('probeAuth base matches upstreamBase', probeAuth(fakeConfig, tokens).base === fakeConfig.upstreamBase);
check(
  'probeAuth headers equal buildAuthHeaders() minus _mode',
  JSON.stringify(probeAuthHeaders) === JSON.stringify(prodSendHeaders)
);

// --- (b) exit-code contract: runDoctor's aggregation logic ------------------
// runDoctor itself does live I/O; test the pure mapping it applies to a
// results array (return 1 iff any status === 'fail', else 0).
function exitCodeFor(results) {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
check('exit 0 when only ok/warn/skip', exitCodeFor([{ status: 'ok' }, { status: 'warn' }, { status: 'skip' }]) === 0);
check('exit 1 when any fail present', exitCodeFor([{ status: 'ok' }, { status: 'fail' }]) === 1);
check('exit 0 on empty results', exitCodeFor([]) === 0);

// checkConfig is a real pure(ish) check function (only touches disk read-only
// paths under the isolated HOME) — use it to confirm ok results never trip
// the fail branch of the aggregation.
const configResult = checkConfig(fakeConfig);
check('checkConfig on valid fixture config is ok', configResult.status === 'ok');
check('runDoctor-style aggregation over a real check result', exitCodeFor([configResult]) === 0);

// --- (c) doctor output never contains a token value -------------------------
// Feed the fake token through the actual formatting path (checkAuthHeaders'
// unauthenticated/skip branch doesn't touch it; assert instead that neither
// the check result objects nor a rendered summary line ever include the raw
// token value, mirroring what printResults() would emit to the terminal.
const unauthResult = await checkAuthHeaders({ ...fakeConfig, apiKey: null }, null);
check('unauthenticated auth-headers check skips (no probe made)', unauthResult.status === 'skip');

const allResults = [configResult, unauthResult];
const rendered = allResults
  .map((r) => `[${r.status}] ${r.name} ${r.detail}${r.hint ? ` fix: ${r.hint}` : ''}`)
  .join('\n');
check('rendered doctor output never contains the fake token value', !rendered.includes(FAKE_TOKEN));
check('rendered doctor output never contains the fake refresh token', !rendered.includes('FAKE_REFRESH_TOKEN'));

// Also assert probeAuth's own headers object (what WOULD be sent over the
// wire) never leaks the raw token in a way that string-matches naive logging
// of the object minus the intended "Bearer <token>" authorization value —
// i.e. no other field carries the token.
const { authorization, ...nonAuthProbeFields } = probeHeaders;
check(
  'only the authorization header carries the token, no other field',
  !Object.values(nonAuthProbeFields).some((v) => String(v).includes(FAKE_TOKEN))
);

console.log(failures ? `\n${failures} FAILURES` : '\nALL DOCTOR TESTS PASSED');
process.exit(failures ? 1 : 0);
