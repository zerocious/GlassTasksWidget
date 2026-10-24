'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('../lib/config');
const auth = require('../lib/google-auth');
const { freshDataRoot } = require('./helpers/storage');

const REFRESH = '1//0gLiveRefreshToken_abcdefghijklmnop';

/** Prototype of the transporter the Google client's OAuth2 really uses. */
function transporterProto() {
  const { auth: googleAuth } = require('@googleapis/tasks');
  return Object.getPrototypeOf(new googleAuth.OAuth2().transporter);
}

function signedInProfile() {
  const root = freshDataRoot();
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' });
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: REFRESH, access_token: 'ya29.short' });
  return root;
}

test('logout revokes with the token in the POST body, never in the URL', async (t) => {
  signedInProfile();
  /** @type {any[]} */
  const calls = [];
  t.mock.method(transporterProto(), 'request', async (opts) => {
    calls.push(opts);
    return { status: 200, data: {} };
  });
  assert.equal(await auth.revokeAndClearTokens(), 'revoked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(String(calls[0].url).includes(REFRESH), false);
  assert.equal(calls[0].data, `token=${encodeURIComponent(REFRESH)}`);
  assert.equal(auth.loadSavedTokens(), null, 'local token removed');
});

test('a failed revoke never logs the token and reports «failed»', async (t) => {
  signedInProfile();
  // node-fetch / gaxios put the request URL into the message of network errors.
  t.mock.method(transporterProto(), 'request', async () => {
    const err = new Error(`request to https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(REFRESH)} failed, reason: getaddrinfo ENOTFOUND`);
    err.code = 'ENOTFOUND';
    throw err;
  });
  /** @type {string[]} */
  const logged = [];
  t.mock.method(console, 'warn', (...args) => logged.push(args.map(String).join(' ')));
  t.mock.method(console, 'error', (...args) => logged.push(args.map(String).join(' ')));
  assert.equal(await auth.revokeAndClearTokens(), 'failed');
  const text = logged.join('\n');
  assert.match(text, /revoke failed/);
  assert.equal(text.includes(REFRESH), false);
  assert.equal(text.includes(encodeURIComponent(REFRESH)), false);
  assert.equal(text.includes('0gLiveRefreshToken'), false);
  assert.equal(auth.loadSavedTokens(), null, 'still signed out locally');
});

test('only Google\'s «invalid_token» 400 counts as revoked; other 400s and 5xx are failures', async (t) => {
  const reply = { status: 400, data: { error: 'invalid_token' } };
  t.mock.method(transporterProto(), 'request', async () => {
    const err = new Error('request failed');
    err.response = reply;
    throw err;
  });
  signedInProfile();
  assert.equal(await auth.revokeAndClearTokens(), 'revoked', 'already revoked at Google');
  for (const [status, data] of [[400, ''], [400, { error: 'invalid_request' }], [503, {}], [407, {}]]) {
    reply.status = status;
    reply.data = data;
    signedInProfile();
    assert.equal(await auth.revokeAndClearTokens(), 'failed', `HTTP ${status} ${JSON.stringify(data)}`);
  }
});

test('a revoke that never answers gives up after ~5.5 s («failed») and clears the timer', async (t) => {
  signedInProfile();
  t.mock.method(transporterProto(), 'request', () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = auth.revokeAndClearTokens();
  t.mock.timers.tick(5600);
  assert.equal(await pending, 'failed');
  assert.equal(auth.loadSavedTokens(), null);
});

test('revoke works without saved client keys (the endpoint needs only the token)', async (t) => {
  const root = freshDataRoot();
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: REFRESH });
  let called = 0;
  t.mock.method(transporterProto(), 'request', async () => {
    called += 1;
    return { status: 200 };
  });
  assert.equal(config.hasGoogleCredentials(), false);
  assert.equal(await auth.revokeAndClearTokens(), 'revoked');
  assert.equal(called, 1);
});

test('nothing to revoke: «none»; a token file that cannot be read: «locked»', async () => {
  const root = freshDataRoot();
  assert.equal(await auth.revokeAndClearTokens(), 'none');
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: REFRESH });
  config.setSafeStorageForTests(null);
  assert.equal(await auth.revokeAndClearTokens(), 'locked', 'safeStorage unavailable');

  freshDataRoot();
  config.writeSecretJson(config.dataPath('tokens.json'), { refresh_token: REFRESH });
  // Profile moved to another PC / user: safeStorage works but this ciphertext is not ours.
  config.setSafeStorageForTests({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    },
  });
  assert.equal(await auth.revokeAndClearTokens(), 'locked', 'decrypt failure');
});
