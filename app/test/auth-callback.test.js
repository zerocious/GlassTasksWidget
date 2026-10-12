'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.GT_OAUTH_NO_BROWSER = '1';

const auth = require('../lib/google-auth');
const { savedPinnedPort } = require('../lib/config');

const { interactiveLogin } = auth._test;

/** OAuth2 stand-in: no network, no token writes. */
function fakeOAuth(getToken) {
  return {
    generateAuthUrl: (opts) =>
      `https://accounts.example/auth?state=${opts.state}&redirect_uri=${encodeURIComponent(opts.redirect_uri)}`,
    getToken,
    setCredentials() {},
    on() {},
  };
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

/** Start a login and wait until the loopback server is listening. */
async function startLogin(getToken, fixedPort = null) {
  const login = interactiveLogin(fakeOAuth(getToken), fixedPort);
  let settled = null;
  login.then(
    (v) => (settled = { ok: v }),
    (e) => (settled = { err: e })
  );
  for (let i = 0; i < 100 && !auth.getPendingLoginUrl(); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const u = new URL(auth.getPendingLoginUrl());
  const redirect = new URL(u.searchParams.get('redirect_uri'));
  return {
    login,
    base: redirect.origin,
    state: u.searchParams.get('state'),
    port: Number(redirect.port),
    settled: () => settled,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 60));

test('stray requests without our state never end the sign-in', async () => {
  const s = await startLogin(async () => ({ tokens: {} }));
  for (const query of ['', '?error=access_denied', '?error=evil+text&state=wrong', '?code=abc&state=wrong']) {
    const res = await get(`${s.base}/oauth2callback${query}`);
    assert.equal(res.status, 400, query);
  }
  await tick();
  assert.equal(s.settled(), null, 'login must still be waiting');
  assert.ok(auth.cancelLogin());
  await assert.rejects(s.login, (e) => e.code === 'cancelled');
});

test('a real error redirect (right state) is mapped, and raw text is never echoed', async () => {
  const s = await startLogin(async () => ({ tokens: {} }));
  const res = await get(`${s.base}/oauth2callback?error=access_denied&state=${s.state}`);
  assert.equal(res.status, 400);
  await assert.rejects(s.login, (e) => e.code === 'access_denied' && /Test users/.test(e.message) && Boolean(e.actionUrl));

  const t = await startLogin(async () => ({ tokens: {} }));
  await get(`${t.base}/oauth2callback?error=${encodeURIComponent('Аккаунт заблокирован, позвоните 112')}&state=${t.state}`);
  await assert.rejects(t.login, (e) => e.code === 'oauth_error' && !/112/.test(e.message));
});

test('invalid_grant during the code exchange surfaces as an error instead of cancelling silently', async () => {
  const invalidGrant = Object.assign(new Error('invalid_grant'), {
    response: { data: { error: 'invalid_grant', error_description: 'Bad Request' } },
  });
  const s = await startLogin(async () => {
    throw invalidGrant;
  });
  const res = await get(`${s.base}/oauth2callback?code=abc&state=${s.state}`);
  assert.equal(res.status, 500);
  await assert.rejects(s.login, (e) => e.code === 'code_exchange_failed' && /ещё раз/.test(e.message));
});

test('the code exchange sends the redirect_uri that was used in the auth URL', async () => {
  let seen = null;
  const s = await startLogin(async (opts) => {
    seen = opts;
    throw new Error('stop here');
  });
  await get(`${s.base}/oauth2callback?code=abc&state=${s.state}`);
  await assert.rejects(s.login);
  assert.equal(seen.redirect_uri, `${s.base}/oauth2callback`);
  assert.equal(seen.code, 'abc');
  assert.ok(seen.codeVerifier && seen.codeVerifier.length >= 43);
});

test('a busy pinned port falls back to a free one', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  try {
    const s = await startLogin(async () => ({ tokens: {} }), busy);
    assert.notEqual(s.port, busy);
    assert.ok(s.port > 0);
    auth.cancelLogin();
    await assert.rejects(s.login, (e) => e.code === 'cancelled');
  } finally {
    blocker.close();
  }
});

test('classifyExchangeError has no side effects and keeps unknown errors', () => {
  const unknown = new Error('socket hang up');
  assert.equal(auth.classifyExchangeError(unknown), unknown);
  assert.equal(auth.classifyExchangeError({ response: { data: { error: 'invalid_client' } } }).code, 'invalid_client');
});

test('savedPinnedPort treats the old default as automatic unless pinned on purpose', () => {
  assert.equal(savedPinnedPort({ redirectPort: 42813 }), null);
  assert.equal(savedPinnedPort({ redirectPort: 42813, portPinned: true }), 42813);
  assert.equal(savedPinnedPort({ redirectPort: 51000 }), 51000);
  assert.equal(savedPinnedPort({}), null);
  assert.equal(savedPinnedPort(null), null);
  assert.equal(savedPinnedPort({ redirectPort: 'x' }), null);
});
