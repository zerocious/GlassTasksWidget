'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keys exported in the shell are read once at load and removed from the environment.
process.env.GOOGLE_CLIENT_ID = 'env-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
const config = require('../lib/config');
const { getStorageIssues, clearStorageIssues } = require('../lib/storage-events');
const { freshDataRoot } = require('./helpers/storage');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-config-'));
}

/** Reversible stand-in for Electron safeStorage. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (b) => {
    const text = b.toString('utf8');
    assert.ok(text.startsWith('enc:'));
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};

test.afterEach(() => {
  config.setSafeStorageForTests(undefined);
  config.clearMemorySecrets();
});

test('writeJson round-trips and leaves no temp files', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'a.json');
  config.writeJson(file, { a: 1 });
  config.writeJson(file, { a: 2 });
  assert.deepEqual(config.readJson(file, null), { a: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
});

test('readJson returns fallback for a missing file without side effects', () => {
  const dir = tmpDir();
  assert.equal(config.readJson(path.join(dir, 'nope.json'), 'fb'), 'fb');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('readJson moves a corrupt file aside instead of letting it be overwritten', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'streaks.json');
  fs.writeFileSync(file, '{"habits": {"x": {"dates": ["2026-01-0');
  assert.deepEqual(config.readJson(file, { habits: {} }), { habits: {} });
  const names = fs.readdirSync(dir);
  assert.equal(fs.existsSync(file), false);
  assert.equal(names.length, 1);
  assert.match(names[0], /^streaks\.json\.corrupt-\d+$/);
});

test('writeSecretJson encrypts when safeStorage is available', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const file = path.join(tmpDir(), 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'r-123' });
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.equal(onDisk.includes('r-123'), false);
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'r-123' });
});

test('readSecretJson migrates a legacy plaintext file to encrypted', () => {
  const file = path.join(tmpDir(), 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ clientId: 'id', clientSecret: 's3cret' }));
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.deepEqual(config.readSecretJson(file, null), { clientId: 'id', clientSecret: 's3cret' });
  assert.equal(fs.readFileSync(file, 'utf8').includes('s3cret'), false);
  assert.deepEqual(config.readSecretJson(file, null), { clientId: 'id', clientSecret: 's3cret' });
});

test('without safeStorage secrets stay in memory for the session and never hit the disk', () => {
  config.setSafeStorageForTests(null);
  clearStorageIssues();
  const file = path.join(tmpDir(), 'tokens.json');
  assert.equal(config.writeSecretJson(file, { refresh_token: 'r-mem' }), 'memory');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'r-mem' });
  assert.equal(config.describeSecretFile(file), 'memory');
  const issue = getStorageIssues().find((i) => i.kind === 'secrets-memory-only');
  assert.ok(issue, 'the user is told why sign-in will not survive a restart');
  assert.match(issue.message, /до закрытия виджета/);
  config.deleteSecretJson(file);
  assert.equal(config.readSecretJson(file, null), null);
});

test('memory-only secrets move to the encrypted file once safeStorage works', () => {
  config.setSafeStorageForTests(null);
  const file = path.join(tmpDir(), 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'early' });
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.equal(config.writeSecretJson(file, { refresh_token: 'later' }), 'encrypted');
  assert.equal(config.describeSecretFile(file), 'encrypted');
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'later' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1);
});

test('GT_ALLOW_PLAINTEXT_SECRETS=1 (dev) writes an explicit plaintext envelope', () => {
  config.setSafeStorageForTests(null);
  process.env.GT_ALLOW_PLAINTEXT_SECRETS = '1';
  try {
    const file = path.join(tmpDir(), 'tokens.json');
    assert.equal(config.writeSecretJson(file, { refresh_token: 'dev' }), 'plaintext');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.format, 'glass-tasks/plain@1');
    assert.equal(config.describeSecretFile(file), 'plaintext');
    assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'dev' });
  } finally {
    delete process.env.GT_ALLOW_PLAINTEXT_SECRETS;
  }
});

test('a legacy plaintext secret read without safeStorage is reported, not silently trusted', () => {
  config.setSafeStorageForTests(null);
  clearStorageIssues();
  const file = path.join(tmpDir(), 'tokens.json');
  fs.writeFileSync(file, JSON.stringify({ refresh_token: 'old' }));
  assert.deepEqual(config.readSecretJson(file, null), { refresh_token: 'old' });
  assert.equal(config.describeSecretFile(file), 'plaintext');
  assert.ok(getStorageIssues().some((i) => i.kind === 'plaintext-secret'));
});

test('encrypted secrets are not returned when safeStorage becomes unavailable', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const file = path.join(tmpDir(), 'tokens.json');
  config.writeSecretJson(file, { refresh_token: 'r' });
  config.setSafeStorageForTests(null);
  assert.equal(config.readSecretJson(file, null), null);
});

test('saveGoogleCredentials rejects values with whitespace or newlines', () => {
  assert.throws(
    () => config.saveGoogleCredentials({ clientId: 'abc\nEVIL=1', clientSecret: 'x' }),
    /пробелов/
  );
  assert.throws(
    () => config.saveGoogleCredentials({ clientId: 'abc', clientSecret: 'a b' }),
    /пробелов/
  );
});

test('client keys never live in process.env (child processes inherit it)', () => {
  assert.equal(process.env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
  freshDataRoot();
  // Shell keys are still a valid (lowest priority) source.
  assert.deepEqual(config.getGoogleClientCredentials(), {
    clientId: 'env-id.apps.googleusercontent.com',
    clientSecret: 'env-secret',
    redirectPort: null,
  });
  assert.equal(config.getGoogleCredentialsStatus().source, 'environment');
  const saved = config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc' });
  assert.equal(saved.persisted, true);
  assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(config.getGoogleClientCredentials().clientSecret, 'GOCSPX-abc');
  const status = config.getGoogleCredentialsStatus();
  assert.equal(status.source, 'credentials.json');
  assert.equal(JSON.stringify(status).includes('GOCSPX-abc'), false);
});

test('saving with an empty secret keeps the saved one only for the same Client ID', () => {
  freshDataRoot();
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-keep', redirectPort: 51000 });
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: '', redirectPort: '' });
  assert.deepEqual(config.getGoogleClientCredentials(), {
    clientId: '1-a.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-keep',
    redirectPort: null,
  });
  assert.throws(
    () => config.saveGoogleCredentials({ clientId: '2-b.apps.googleusercontent.com', clientSecret: '' }),
    /Client Secret/
  );
  // Reload from disk: the encrypted file is the source of truth.
  config.resetEnvCache();
  assert.equal(config.getGoogleClientCredentials().clientSecret, 'GOCSPX-keep');
});

test('saveGoogleCredentials without safeStorage works for the session and says it is not persisted', () => {
  freshDataRoot({ safeStorage: null });
  const saved = config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-mem' });
  assert.equal(saved.persisted, false);
  assert.equal(fs.existsSync(config.getCredentialsJsonPath()), false);
  assert.equal(config.hasGoogleCredentials(), true);
});

test('writeFileAtomic flushes and renames: content complete, no temp files, mode accepted', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  config.writeFileAtomic(file, '{"a":1}', { mode: 0o600 });
  config.writeFileAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('freezeWrites blocks every write until lifted (used by «delete all my data»)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  config.freezeWrites(true);
  try {
    config.writeFileAtomic(file, '{}');
    assert.equal(fs.existsSync(file), false);
  } finally {
    config.freezeWrites(false);
  }
  config.writeFileAtomic(file, '{}');
  assert.equal(fs.existsSync(file), true);
});

test('keys that cannot be decrypted yet (Windows before «ready») are retried, not cached as missing', () => {
  freshDataRoot();
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-later' });
  config.resetEnvCache();
  config.setSafeStorageForTests(null);
  // Meanwhile the lower-priority source (shell keys of this test file) is used.
  assert.equal(config.getGoogleClientCredentials().clientSecret, 'env-secret');
  assert.equal(config.describeSecretFile(config.getCredentialsJsonPath()), 'locked');
  config.setSafeStorageForTests(fakeSafeStorage);
  assert.equal(config.getGoogleClientCredentials().clientSecret, 'GOCSPX-later', 'picked up without a manual reset');
  assert.equal(config.getGoogleCredentialsStatus().source, 'credentials.json');
});
