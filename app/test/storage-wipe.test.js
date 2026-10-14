'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../lib/config');
const settingsStore = require('../lib/settings-store');
const streaks = require('../lib/streak-store');
const cache = require('../lib/offline-cache');
const reminders = require('../lib/reminder-store');
const backup = require('../lib/storage-backup');
const { flushAllDocs } = require('../lib/storage-doc');
const { wipeAllData, assertDataRoot } = require('../lib/storage-wipe');
const { getStorageStatus, describeStorageStatus } = require('../lib/storage-status');
const { freshDataRoot } = require('./helpers/storage');

test.afterEach(() => config.freezeWrites(false));

test('«delete all my data» removes every file, secret, cache and backup and clears Chromium storage', async () => {
  const root = freshDataRoot();
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: '1//token' });
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' });
  settingsStore.saveSettings({ theme: 'light' });
  streaks.markCompleted('h', '2026-10-01');
  reminders.markNotified(['t1']);
  backup.createBackup({ reason: 'manual' });
  fs.writeFileSync(path.join(root, 'streaks.json.corrupt-1'), 'x');
  cache.saveOfflineCache({ mode: 'google', tasks: [{ id: 't', title: 'x' }], habits: [] }); // still pending

  const calls = [];
  const result = await wipeAllData({
    revoke: async () => calls.push('revoke'),
    session: {
      clearStorageData: async () => calls.push('storage'),
      clearCache: async () => calls.push('cache'),
    },
    resets: [() => calls.push('reset')],
  });

  assert.deepEqual(calls, ['revoke', 'reset', 'storage', 'cache']);
  assert.equal(result.chromiumCleared, true);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(root), false);

  // Late timers and in-memory copies cannot bring anything back before the restart.
  flushAllDocs();
  settingsStore.saveSettings({ theme: 'dark' });
  assert.equal(fs.existsSync(root), false);
  assert.equal(config.hasGoogleCredentials(), false);
  assert.equal(config.readSecretJson(path.join(root, 'tokens.json'), null), null);
  assert.equal(cache.loadOfflineCache(), null);
});

test('wipe refuses to delete anything that is not a data folder', () => {
  assert.throws(() => assertDataRoot('/'), /Refusing/);
  assert.throws(() => assertDataRoot('/home/user'), /Refusing/);
  assert.equal(assertDataRoot('/tmp/x/data'), path.resolve('/tmp/x/data'));
});

test('wipe touches only the data folder (never the developer .env in the source tree)', async () => {
  const root = freshDataRoot();
  settingsStore.saveSettings({ theme: 'light' });
  const result = await wipeAllData({ freeze: false });
  // Outside Electron the «app-written .env» path is app/.env, which belongs to the developer.
  assert.equal(config.getCredentialsEnvPath(), path.join(config.ROOT, '.env'));
  assert.deepEqual(result.removed, [root]);
  assert.deepEqual(result.failed, []);
});

test('storage status: secrets mode, files, issues — and no secret values', () => {
  const root = freshDataRoot({ safeStorage: null });
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: '1//super-secret-token' });
  settingsStore.saveSettings({ theme: 'light' });
  const status = getStorageStatus();
  assert.equal(status.encryption.available, false);
  assert.equal(status.secrets.tokens, 'memory');
  assert.equal(status.ok, false);
  const settingsFile = status.files.find((f) => f.name === 'settings.json');
  assert.equal(settingsFile.schemaVersion, 1);
  assert.equal(settingsFile.hasLastGood, true);
  assert.equal(JSON.stringify(status).includes('super-secret'), false);
  const text = describeStorageStatus(status).join('\n');
  assert.match(text, /НЕДОСТУПНО/);
  assert.match(text, /tokens\.json \(вход Google\): только в памяти/);
  assert.match(text, /secrets-memory-only|ключи и вход Google сохранены только до закрытия/);
});

test('storage status is ok when everything is encrypted and healthy', () => {
  const root = freshDataRoot();
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: 'r' });
  const status = getStorageStatus();
  assert.equal(status.secrets.tokens, 'encrypted');
  assert.equal(status.ok, true);
});
