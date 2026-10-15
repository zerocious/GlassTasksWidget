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
  assert.ok(result.removed.includes(root));
  assert.equal(result.removed.some((p) => path.isAbsolute(p) && p !== root), false, 'nothing outside the data folder');
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

test('storage status never prints the absolute profile path (Windows user name)', () => {
  const { displayPath } = require('../lib/storage-status');
  const env = { APPDATA: 'C:\\Users\\ivan.petrov\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\ivan.petrov' };
  const win = require('path').win32;
  assert.equal(
    displayPath('C:\\Users\\ivan.petrov\\AppData\\Roaming\\glass-tasks-widget\\data', { env, pathApi: win }),
    '%APPDATA%\\glass-tasks-widget\\data'
  );
  assert.equal(displayPath('c:\\users\\IVAN.PETROV\\proj\\data', { env, pathApi: win }), '%USERPROFILE%\\proj\\data');
  const unc = displayPath('\\\\fs01\\Redirected$\\ivan.petrov\\AppData\\Roaming\\glass-tasks-widget\\data', { env: {}, pathApi: win });
  assert.equal(unc, '…\\glass-tasks-widget\\data');
  const status = getStorageStatus();
  assert.equal(status.dataRoot.includes(require('os').tmpdir()), false);
  assert.match(describeStorageStatus(status)[0], /^Папка данных: (…|%)/);
});

test('wipe deletes only files the app owns; foreign files in a shared «data» folder stay', async () => {
  const root = freshDataRoot();
  settingsStore.saveSettings({ theme: 'light' });
  streaks.markCompleted('h', '2026-10-01');
  backup.createBackup({ reason: 'manual' });
  for (const name of ['streaks.json.corrupt-123', 'settings.json.v0.bak', 'offline-cache.json.unread-5.bak', 'tokens.json.77.1700000000000.tmp']) {
    fs.writeFileSync(path.join(root, name), 'x');
  }
  fs.writeFileSync(path.join(root, 'thesis.docx'), 'not ours');
  fs.mkdirSync(path.join(root, 'photos'));
  fs.writeFileSync(path.join(root, 'photos', 'a.jpg'), 'not ours');
  fs.writeFileSync(path.join(root, 'backups', 'my-notes.txt'), 'not ours');

  const result = await wipeAllData({ freeze: false });
  assert.deepEqual(fs.readdirSync(root).sort(), ['backups', 'photos', 'thesis.docx']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups')), ['my-notes.txt']);
  assert.deepEqual(result.kept.sort(), ['backups/my-notes.txt', 'photos', 'thesis.docx']);
  assert.deepEqual(result.failed, []);
});

test('wipe refuses a data folder that is a symlink / junction', async (t) => {
  const real = path.join(require('./helpers/storage').tmpDir(), 'elsewhere');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'settings.json'), '{}');
  const link = path.join(require('./helpers/storage').tmpDir(), 'data');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  config.setDataRootForTests(link);
  await assert.rejects(wipeAllData({ freeze: false }), /Refusing/);
  assert.ok(fs.existsSync(path.join(real, 'settings.json')));
});

test('wipe reports whether the Google grant was revoked', async () => {
  freshDataRoot();
  assert.equal((await wipeAllData({ freeze: false, revoke: async () => 'failed' })).revoke, 'failed');
  freshDataRoot();
  assert.equal((await wipeAllData({ freeze: false, revoke: async () => 'revoked' })).revoke, 'revoked');
  freshDataRoot();
  assert.equal((await wipeAllData({ freeze: false })).revoke, 'none');
});

test('wipe also removes the storage layer\'s chained copies (bak.corrupt, bak.tmp, …)', async () => {
  const root = freshDataRoot();
  const chained = [
    'settings.json.bak.corrupt-17',
    'streaks.json.bak.123.1700000000000.tmp',
    'offline-cache.json.v0.bak.12.1700000000000.tmp',
    'offline-cache.json.unread-5.bak.1.2.tmp',
    'streaks.json.corrupt-9.3.4.tmp',
  ];
  for (const name of chained) fs.writeFileSync(path.join(root, name), 'x');
  fs.writeFileSync(path.join(root, 'settings.json.backup-mine'), 'not ours');
  const result = await wipeAllData({ freeze: false });
  assert.deepEqual(fs.readdirSync(root), ['settings.json.backup-mine']);
  assert.deepEqual(result.kept, ['settings.json.backup-mine']);
});

test('wipe retries files locked for a moment and survives an unreadable backups folder', async (t) => {
  const root = freshDataRoot();
  settingsStore.saveSettings({ theme: 'light' });
  fs.mkdirSync(path.join(root, 'backups'));
  const target = path.join(root, 'settings.json');
  const realUnlink = fs.unlinkSync;
  const realReaddir = fs.readdirSync;
  let busy = 2;
  t.mock.method(fs, 'unlinkSync', function (p, ...rest) {
    if (p === target && busy-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realUnlink.call(this, p, ...rest);
  });
  t.mock.method(fs, 'readdirSync', function (p, ...rest) {
    if (p === path.join(root, 'backups')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realReaddir.call(this, p, ...rest);
  });
  const calls = [];
  const result = await wipeAllData({
    freeze: false,
    session: { clearStorageData: async () => calls.push('storage'), clearCache: async () => calls.push('cache') },
  });
  assert.equal(fs.existsSync(target), false, 'deleted on a retry');
  assert.deepEqual(result.failed, [{ path: 'backups', error: 'EACCES' }]);
  assert.deepEqual(calls, ['storage', 'cache'], 'later steps still ran');
});
