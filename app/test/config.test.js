'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../lib/config');

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

test.afterEach(() => config.setSafeStorageForTests(undefined));

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
