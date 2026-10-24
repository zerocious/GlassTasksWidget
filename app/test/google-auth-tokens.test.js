'use strict';

/** The saved Google session: refresh after an API 401, saving refreshed tokens, client changes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('../lib/config');
const auth = require('../lib/google-auth');
const { freshDataRoot, fakeSafeStorage, writeRaw } = require('./helpers/storage');

const REFRESH = '1//0gLiveRefreshToken_abcdefghijklmnop';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';

/** Prototype of the transporter the Google client's OAuth2 really uses. */
function transporterProto() {
  const { auth: googleAuth } = require('@googleapis/tasks');
  return Object.getPrototypeOf(new googleAuth.OAuth2().transporter);
}

/** Error shaped like gaxios' for an HTTP reply. */
function httpError(status, data) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, config: {}, headers: {} };
  return err;
}

/** Signed-in profile whose saved access token still looks valid for `expiresInMs`. */
function signedInProfile(expiresInMs) {
  const root = freshDataRoot();
  auth.resetAuthClient();
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' });
  config.writeSecretJson(path.join(root, 'tokens.json'), {
    refresh_token: REFRESH,
    access_token: 'ya29.old',
    expiry_date: Date.now() + expiresInMs,
  });
  return root;
}

/**
 * Fake Google: the token endpoint answers `refresh()`, the Tasks API accepts only `ya29.new`.
 * @param {import('node:test').TestContext} t
 * @param {() => any} refresh
 */
function fakeGoogle(t, refresh) {
  const calls = { token: 0, api: 0 };
  t.mock.method(transporterProto(), 'request', async (opts) => {
    if (String(opts.url) === TOKEN_URL) {
      calls.token += 1;
      return { status: 200, data: refresh() };
    }
    calls.api += 1;
    const authz = opts.headers && typeof opts.headers.get === 'function' ? opts.headers.get('authorization') : '';
    if (authz !== 'Bearer ya29.new') {
      throw httpError(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    }
    return { status: 200, data: { items: [] } };
  });
  return calls;
}

test('an API 401 refreshes the access token once even though the saved expiry is still ahead', async (t) => {
  signedInProfile(50 * 60 * 1000);
  const calls = fakeGoogle(t, () => ({ access_token: 'ya29.new', expires_in: 3600 }));
  const client = await auth.getAuthorizedClient();
  const res = await client.request({ url: API_URL });
  assert.deepEqual(res.data, { items: [] });
  assert.deepEqual(calls, { token: 1, api: 2 });
  assert.equal(auth.loadSavedTokens().access_token, 'ya29.new', 'refreshed token saved');
  assert.equal(auth.loadSavedTokens().refresh_token, REFRESH);
});

test('an API 401 with a revoked grant ends in invalid_grant (sign in again), not «offline»', async (t) => {
  signedInProfile(50 * 60 * 1000);
  const calls = fakeGoogle(t, () => {
    throw httpError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  });
  const client = await auth.getAuthorizedClient();
  const err = await client.request({ url: API_URL }).then(
    () => assert.fail('request should fail'),
    (e) => e
  );
  assert.equal(calls.token, 1);
  assert.equal(auth.isInvalidGrantError(err), true);
  assert.equal(auth.normalizeGoogleAuthError(err).code, 'invalid_grant');
  assert.equal(auth.loadSavedTokens(), null, 'dead grant cleared');
});

test('a refreshed token that cannot be saved still serves this session', async (t) => {
  signedInProfile(-60 * 1000); // access token already expired: the next request refreshes
  // Disk full / file locked / DPAPI failing: every write of tokens.json throws.
  config.setSafeStorageForTests({
    ...fakeSafeStorage,
    encryptString: () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    },
  });
  const calls = fakeGoogle(t, () => ({ access_token: 'ya29.new', expires_in: 3600 }));
  /** @type {string[]} */
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args.map(String).join(' ')));
  const client = await auth.getAuthorizedClient();
  assert.deepEqual((await client.request({ url: API_URL })).data, { items: [] });
  assert.deepEqual((await client.request({ url: API_URL })).data, { items: [] });
  assert.deepEqual(calls, { token: 1, api: 2 }, 'refreshed once, the new token is kept in memory');
  const text = warned.join('\n');
  assert.match(text, /ENOSPC/);
  assert.equal(text.includes('ya29.new'), false, 'no token in the log');
  assert.equal(text.includes(REFRESH), false, 'no token in the log');
});

test('saving keys drops the saved grant when the client changes or the old client is unknown', () => {
  const A = '1-a.apps.googleusercontent.com';
  const B = '2-b.apps.googleusercontent.com';
  const root = signedInProfile(50 * 60 * 1000);
  assert.equal(auth.clientChangeDropsGrant(A, A), false, 'same client: keep the sign-in');
  assert.equal(auth.clientChangeDropsGrant(A, B), true, 'other client');

  // credentials.json got corrupt and was deleted on read; tokens.json (client A) survived.
  writeRaw(root, 'credentials.json', '{"format":"glass-tas');
  config.resetEnvCache();
  const existing = config.getGoogleCredentialsStatus();
  assert.equal(existing.clientId, null);
  assert.equal(auth.loadSavedTokens().refresh_token, REFRESH);
  assert.equal(auth.clientChangeDropsGrant(existing.clientId, B), true, 'grant of an unknown client');

  freshDataRoot();
  assert.equal(auth.clientChangeDropsGrant(null, B), false, 'nothing saved: nothing to drop');
});
