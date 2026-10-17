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

/** Every file under dir (recursively) whose text contains `needle`. */
function filesContaining(dir, needle) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...filesContaining(full, needle));
    else if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(full);
  }
  return hits;
}

test('tokens: a legacy unversioned plaintext file is migrated to the encrypted v1 format, leaving no plaintext copy anywhere', () => {
  write(env.dir, 'tokens.json', { refresh_token: 'rt-legacy' });
  write(env.dir, 'credentials.json', { clientId: CLIENT_ID, clientSecret: 'cs-legacy' });
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.deepEqual(auth.loadSavedTokens(), { refresh_token: 'rt-legacy' });
  assert.equal(config.getGoogleClientSecret(), 'cs-legacy');
  assert.deepEqual(filesContaining(env.dir, 'rt-legacy'), [], 'no file may keep the refresh token in plain text');
  assert.deepEqual(filesContaining(env.dir, 'cs-legacy'), [], 'no file may keep the client secret in plain text');
  assert.equal(exists(env.dir, 'backups'), false, 'secret documents are never copied to backups/migrations');
  // and it still loads after the migration
  assert.deepEqual(auth.loadSavedTokens(), { refresh_token: 'rt-legacy' });
});

test('legacy plaintext secrets are NOT deleted by a version bump when encryption is unavailable', () => {
  config.setSafeStorageForTests(null);
  write(env.dir, 'tokens.json', { refresh_token: 'rt-legacy' });
  assert.deepEqual(auth.loadSavedTokens(), { refresh_token: 'rt-legacy' });
  assert.equal(exists(env.dir, 'tokens.json'), true, 'the user stays signed in for this and the next start');
  assert.equal(exists(env.dir, 'backups'), false);
  assert.deepEqual(kinds(), ['plaintext-secrets']);
  // the next real write (token refresh) replaces it with memory-only storage and removes the plaintext
  auth._test.saveTokens({ refresh_token: 'rt-new' });
  assert.equal(exists(env.dir, 'tokens.json'), false);
  assert.equal(auth.loadSavedTokens().refresh_token, 'rt-new');
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

test('encrypted keys that cannot be read yet are retried, but not on every call', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: 'S3' });
  config.resetEnvCache();
  config.setSafeStorageForTests(null); // e.g. keyring not unlocked / app not ready yet
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // many calls in a row read the file once, not once per call
    let reads = 0;
    const origRead = fs.readFileSync;
    fs.readFileSync = function counting(file, ...rest) {
      if (String(file).endsWith('credentials.json')) reads += 1;
      return origRead.call(this, file, ...rest);
    };
    try {
      for (let i = 0; i < 30; i += 1) assert.equal(config.hasGoogleCredentials(), false);
    } finally {
      fs.readFileSync = origRead;
    }
    assert.ok(reads <= 3, `credentials.json was read ${reads} times for 30 calls`);
    // safeStorage comes up, but within the pause the answer is still the cached «no»
    config.setSafeStorageForTests(fakeSafeStorage);
    assert.equal(config.hasGoogleCredentials(), false);
    clock += 6000; // after the pause it looks again
    assert.equal(config.hasGoogleCredentials(), true);
    assert.equal(config.getGoogleClientSecret(), 'S3');
  } finally {
    Date.now = realNow;
  }
});

test('an encrypted file that cannot be decrypted is reported once instead of failing silently', () => {
  const file = path.join(env.dir, 'tokens.json');
  config.setSafeStorageForTests(fakeSafeStorage);
  config.writeSecretJson(file, { refresh_token: 'r' });
  // e.g. the data folder was copied from another Windows account: DPAPI cannot open it
  config.setSafeStorageForTests({
    isEncryptionAvailable: () => true,
    encryptString: fakeSafeStorage.encryptString,
    decryptString: () => {
      throw new Error('The data is invalid');
    },
  });
  assert.equal(config.readSecretJson(file, null), null);
  assert.equal(config.readSecretJson(file, null), null);
  assert.deepEqual(kinds(), ['decrypt-failed']);
  assert.equal(getStorageEvents()[0].file, 'tokens.json');
  assert.equal(exists(env.dir, 'tokens.json'), true, 'the file is left alone');
});

test('an encrypted file with safeStorage unavailable is reported once', () => {
  const file = path.join(env.dir, 'offline-cache.json');
  config.setSafeStorageForTests(fakeSafeStorage);
  config.writeSecretJson(file, { a: 1 });
  config.setSafeStorageForTests(null);
  assert.equal(config.readSecretJson(file, null), null);
  assert.equal(config.readSecretJson(file, null), null);
  assert.deepEqual(kinds(), ['secrets-unavailable']);
});

test('a failing disk write is not mistaken for missing encryption: it throws and leaves the old file alone', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  // the parent of the target is a regular file, so the write must fail
  write(env.dir, 'blocker', 'x');
  const file = path.join(env.dir, 'blocker', 'tokens.json');
  assert.throws(() => config.writeSecretJson(file, { refresh_token: 'r' }));
  assert.deepEqual(core.memoryOnlySecretFiles(), []);
  assert.deepEqual(kinds(), [], 'no misleading «safeStorage unavailable» event');
});

test('a legacy plaintext file is not deleted when the encrypted write fails', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  write(env.dir, 'tokens.json', { refresh_token: 'legacy' });
  const orig = fs.writeFileSync;
  fs.writeFileSync = function failing(file, ...rest) {
    if (String(file).includes('tokens.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return orig.call(this, file, ...rest);
  };
  try {
    assert.throws(() => config.writeSecretJson(path.join(env.dir, 'tokens.json'), { refresh_token: 'new' }), /ENOSPC/);
  } finally {
    fs.writeFileSync = orig;
  }
  assert.equal(JSON.parse(read(env.dir, 'tokens.json')).refresh_token, 'legacy');
});

test('while writes are frozen (after delete-all) secrets stay in memory and nothing is touched on disk', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const file = path.join(env.dir, 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'before' });
  const onDisk = read(env.dir, 'tokens.json');
  core.freezeWrites();
  assert.deepEqual(config.writeSecretJson(file, { refresh_token: 'after' }), { persisted: false, encrypted: false });
  assert.equal(read(env.dir, 'tokens.json'), onDisk);
  assert.equal(config.readSecretJson(file, null).refresh_token, 'after');
});

test('a damaged secrets file is deleted, not kept as a *.corrupt copy with partial tokens', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  write(env.dir, 'tokens.json', '{"refresh_token": "partial-secret-val');
  assert.equal(config.readSecretJson(path.join(env.dir, 'tokens.json'), null), null);
  assert.deepEqual(fs.readdirSync(env.dir), []);
  assert.deepEqual(kinds(), ['corrupt-reset']);
});

test('a secrets file that is locked right now is reported as unreadable, never as «no tokens»', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  auth._test.saveTokens({ refresh_token: 'keep-me' });
  const orig = fs.readFileSync;
  fs.readFileSync = function locked(file, ...rest) {
    if (String(file).endsWith('tokens.json')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return orig.call(this, file, ...rest);
  };
  try {
    assert.equal(auth.loadSavedTokens(), null);
    // the OAuth client's «tokens» event must not overwrite the real file with a refresh-token-less merge
    assert.throws(() => auth._test.saveTokens({ access_token: 'a' }), /недоступен для чтения/);
    assert.deepEqual(kinds(), ['read-failed']);
  } finally {
    fs.readFileSync = orig;
  }
  assert.equal(auth.loadSavedTokens().refresh_token, 'keep-me', 'the file is intact and readable again');
  assert.doesNotThrow(() => auth._test.saveTokens({ refresh_token: 'keep-me', access_token: 'a' }));
});
