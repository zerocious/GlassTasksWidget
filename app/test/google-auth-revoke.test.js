'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('../lib/config');
const auth = require('../lib/google-auth');
const { freshDataRoot } = require('./helpers/storage');

const REFRESH = '1//0gLiveRefreshToken_abcdefghijklmnop';

/** Prototype of the transporter googleapis' OAuth2 client really uses. */
function transporterProto() {
  const { google } = require('googleapis');
  return Object.getPrototypeOf(new google.auth.OAuth2().transporter);
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

test('an already invalid token (HTTP 400) counts as revoked', async (t) => {
  signedInProfile();
  t.mock.method(transporterProto(), 'request', async () => {
    const err = new Error('invalid_token');
    err.response = { status: 400, data: { error: 'invalid_token' } };
    throw err;
  });
  assert.equal(await auth.revokeAndClearTokens(), 'revoked');
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

test('nothing to revoke: «none»; encrypted token that cannot be opened: «locked»', async () => {
  const root = freshDataRoot();
  assert.equal(await auth.revokeAndClearTokens(), 'none');
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: REFRESH });
  config.setSafeStorageForTests(null);
  assert.equal(await auth.revokeAndClearTokens(), 'locked');
});
