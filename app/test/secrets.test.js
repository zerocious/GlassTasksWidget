'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../lib/config');
const core = require('../lib/storage-core');
const auth = require('../lib/google-auth');
const { getStorageEvents } = require('../lib/storage-status');
const { fakeSafeStorage, useTempDataRoot, read, write, exists } = require('./helpers/tmp-data');

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
  delete process.env.GT_ALLOW_PLAINTEXT_SECRETS;
});
test.afterEach(() => {
  env.cleanup();
  delete process.env.GT_ALLOW_PLAINTEXT_SECRETS;
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT']) delete process.env[k];
});

const kinds = () => getStorageEvents().map((e) => e.kind);

// ---- item 1: no plaintext fallback ------------------------------------------------------

test('without safeStorage a secret is NOT written to disk but works for the session', () => {
  config.setSafeStorageForTests(null);
  const file = path.join(env.dir, 'tokens.json');
  const res = config.writeSecretJson(file, { refresh_token: 'r-123' });
  assert.deepEqual(res, { persisted: false, encrypted: false });
  assert.equal(exists(env.dir, 'tokens.json'), false);
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'r-123' });
  assert.deepEqual(kinds(), ['secrets-memory-only']);
  assert.deepEqual(core.memoryOnlySecretFiles(), ['tokens.json']);
});

test('memory-only secrets are returned as copies and the warning is raised once per file', () => {
  config.setSafeStorageForTests(null);
  const file = path.join(env.dir, 'tokens.json');
  config.writeSecretJson(file, { a: 1 });
  config.writeSecretJson(file, { a: 2 });
  const got = config.readSecretJson(file, null);
  got.a = 99;
  assert.equal(config.readSecretJson(file, null).a, 2);
  assert.equal(kinds().length, 1);
});

test('memory-only write removes a stale plaintext file left by an older version', () => {
  config.setSafeStorageForTests(null);
  write(env.dir, 'tokens.json', { refresh_token: 'old-plain' });
  config.writeSecretJson(path.join(env.dir, 'tokens.json'), { refresh_token: 'new' });
  assert.equal(exists(env.dir, 'tokens.json'), false);
});

test('memory-only write never deletes an ENCRYPTED file (it may decrypt later)', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const file = path.join(env.dir, 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'r' });
  const onDisk = read(env.dir, 'tokens.json');
  config.setSafeStorageForTests(null);
  config.writeSecretJson(file, { refresh_token: 'r2' });
  assert.equal(read(env.dir, 'tokens.json'), onDisk);
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'r2' });
});

test('secrets held in memory are persisted once encryption becomes available', () => {
  config.setSafeStorageForTests(null);
  const file = path.join(env.dir, 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'r' });
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'r' });
  assert.equal(read(env.dir, 'tokens.json').includes('"r"'), false);
  assert.deepEqual(core.memoryOnlySecretFiles(), []);
});

test('an existing legacy plaintext file stays readable and is flagged in the report', () => {
  config.setSafeStorageForTests(null);
  write(env.dir, 'tokens.json', { refresh_token: 'legacy' });
  assert.deepEqual(config.readSecretJson(path.join(env.dir, 'tokens.json'), null), { refresh_token: 'legacy' });
  assert.deepEqual(kinds(), ['plaintext-secrets']);
});

test('developer opt-in GT_ALLOW_PLAINTEXT_SECRETS=1 writes plain JSON (non-packaged only)', () => {
  config.setSafeStorageForTests(null);
  process.env.GT_ALLOW_PLAINTEXT_SECRETS = '1';
  const file = path.join(env.dir, 'tokens.json');
  assert.deepEqual(config.writeSecretJson(file, { refresh_token: 'dev' }), { persisted: true, encrypted: false });
  assert.deepEqual(JSON.parse(read(env.dir, 'tokens.json')), { refresh_token: 'dev' });
});

test('an encryption error never degrades to plain text', () => {
  config.setSafeStorageForTests({
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error('DPAPI failed');
    },
    decryptString: () => '',
  });
  const file = path.join(env.dir, 'tokens.json');
  assert.equal(config.writeSecretJson(file, { refresh_token: 'r' }).persisted, false);
  assert.equal(exists(env.dir, 'tokens.json'), false);
});

test('tokens: saved versioned and encrypted, schemaVersion hidden from the OAuth client', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  auth._test.saveTokens({ refresh_token: 'rt-secret', access_token: 'at' });
  const onDisk = read(env.dir, 'tokens.json');
  assert.equal(onDisk.includes('rt-secret'), false);
  assert.deepEqual(auth.loadSavedTokens(), { refresh_token: 'rt-secret', access_token: 'at' });
});

test('tokens: a legacy unversioned plaintext file is migrated to the encrypted v1 format', () => {
  write(env.dir, 'tokens.json', { refresh_token: 'rt-legacy' });
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.deepEqual(auth.loadSavedTokens(), { refresh_token: 'rt-legacy' });
  assert.equal(read(env.dir, 'tokens.json').includes('rt-legacy'), false);
  assert.ok(fs.readdirSync(path.join(env.dir, 'backups', 'migrations')).length >= 1);
});

test('clearTokens forgets memory-only tokens too', () => {
  config.setSafeStorageForTests(null);
  auth._test.saveTokens({ refresh_token: 'r' });
  assert.equal(auth.loadSavedTokens().refresh_token, 'r');
  auth.clearTokens();
  assert.equal(auth.loadSavedTokens(), null);
});

// ---- item 2: client secret is not in process.env ------------------------------------------

test('saved client secret is served by a function and never put into process.env', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const res = config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-top-secret' });
  assert.equal(res.persisted, true);
  assert.equal(config.getGoogleClientSecret(), 'GOCSPX-top-secret');
  assert.deepEqual(config.getGoogleCredentials(), { clientId: CLIENT_ID, clientSecret: 'GOCSPX-top-secret', redirectPort: null });
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT']) {
    assert.equal(process.env[key], undefined, `${key} leaked into process.env`);
  }
  assert.equal(Object.values(process.env).some((v) => String(v).includes('GOCSPX-top-secret')), false);
  assert.equal(read(env.dir, 'credentials.json').includes('GOCSPX-top-secret'), false);
});

test('credentials survive a restart (reload from the encrypted file) without touching process.env', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: 'S3', redirectPort: 45000 });
  config.resetEnvCache(); // forget the in-memory copy, like a fresh process
  assert.equal(config.hasGoogleCredentials(), true);
  assert.equal(config.getGoogleClientSecret(), 'S3');
  assert.equal(config.getGoogleCredentialsStatus().redirectPort, 45000);
  assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
});

test('without safeStorage the credentials work this session but are reported as not persisted', () => {
  config.setSafeStorageForTests(null);
  const res = config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: 'S3' });
  assert.equal(res.persisted, false);
  assert.equal(config.hasGoogleCredentials(), true);
  assert.equal(exists(env.dir, 'credentials.json'), false);
  assert.ok(kinds().includes('secrets-memory-only'));
});

test('a secret exported in the shell is taken over once and removed from process.env', () => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'shell-secret';
  config.setDataRootForTests(env.dir); // fresh module state, as at startup
  assert.equal(config.getGoogleClientSecret(), 'shell-secret');
  assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(process.env.GOOGLE_CLIENT_ID, undefined);
});

test('stored credentials win over shell variables', () => {
  process.env.GOOGLE_CLIENT_ID = 'shell.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'shell-secret';
  config.setDataRootForTests(env.dir);
  config.setSafeStorageForTests(fakeSafeStorage);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: 'stored-secret' });
  config.resetEnvCache();
  assert.equal(config.getGoogleClientSecret(), 'stored-secret');
});

test('google-auth builds the OAuth client from the module, and fails clearly without credentials', () => {
  assert.equal(config.hasGoogleCredentials(), false);
  assert.equal(auth.hasGoogleCredentials(), false);
});
