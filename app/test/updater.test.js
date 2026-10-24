'use strict';

/**
 * electron/updater.js against stubs of `electron` and `electron-updater` (no network, no
 * Electron binary): what the Settings button reports, and when the automatic checks run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const electronStub = {
  app: { isPackaged: true, getVersion: () => '1.1.0' },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  powerMonitor: new EventEmitter(),
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronStub };

const updaterStub = { autoUpdater: null };
const updaterPath = require.resolve('electron-updater');
require.cache[updaterPath] = { id: updaterPath, filename: updaterPath, loaded: true, exports: updaterStub };

const { checkForAppUpdates, setupAutoUpdater } = require('../electron/updater');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NO_UPDATE = { isUpdateAvailable: false, updateInfo: { version: '1.1.0' } };

/** A stand-in autoUpdater whose checkForUpdates() resolves with `result`. */
function fakeAutoUpdater(result) {
  const u = new EventEmitter();
  u.checks = 0;
  u.checkForUpdates = async () => {
    u.checks += 1;
    return typeof result === 'function' ? result(u.checks) : result;
  };
  u.quitAndInstall = () => {};
  updaterStub.autoUpdater = u;
  return u;
}

test('Settings check: a published version older than ours is not offered as an update', async () => {
  // A draft 1.1.0 installed for testing while the public "latest" is still 1.0.1:
  // electron-updater refuses the downgrade and downloads nothing.
  fakeAutoUpdater({ isUpdateAvailable: false, updateInfo: { version: '1.0.1' } });
  const r = await checkForAppUpdates();
  assert.equal(r.reason, 'uptodate');
  assert.equal(r.version, '1.1.0');
  assert.doesNotMatch(r.message, /Доступна/);
});

test('Settings check: a newer release electron-updater accepted is reported as downloading', async () => {
  fakeAutoUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' }, downloadPromise: Promise.resolve([]) });
  const r = await checkForAppUpdates();
  assert.equal(r.reason, 'available');
  assert.equal(r.version, '1.2.0');
  assert.match(r.message, /Доступна версия 1\.2\.0/);
});

test('Settings check: no answer from the updater (inactive) is not an update either', async () => {
  fakeAutoUpdater(null);
  const r = await checkForAppUpdates();
  assert.equal(r.reason, 'uptodate');
});

/** Fake clock (timers + Date) and a fresh autoUpdater, then setupAutoUpdater() as main.js calls it. */
function startAutoUpdates(t, result) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.mock.method(console, 'warn', () => {});
  electronStub.powerMonitor.removeAllListeners();
  const u = fakeAutoUpdater(result);
  setupAutoUpdater();
  return u;
}

/** Moves the fake clock, then lets the async check (check → download → re-arm) settle. */
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

test('automatic check: 12 s after launch, then again every 6 h (a tray widget runs for weeks)', async (t) => {
  const u = startAutoUpdates(t, NO_UPDATE);
  await advance(t, 11_999);
  assert.equal(u.checks, 0);
  await advance(t, 1);
  assert.equal(u.checks, 1);
  await advance(t, 6 * HOUR - 1);
  assert.equal(u.checks, 1);
  await advance(t, 1);
  assert.equal(u.checks, 2);
  await advance(t, 6 * HOUR);
  assert.equal(u.checks, 3);
});

test('automatic check: a failure (no network yet at login) is retried after 1, 2, 4 … min, at most 1 h apart', async (t) => {
  const u = startAutoUpdates(t, (n) => {
    if (n <= 9) throw new Error('getaddrinfo ENOTFOUND github.com');
    return NO_UPDATE;
  });
  await advance(t, 12_000);
  assert.equal(u.checks, 1);
  const retryMinutes = [1, 2, 4, 8, 16, 32, 60, 60, 60];
  for (const [i, m] of retryMinutes.entries()) {
    await advance(t, m * MIN - 1);
    assert.equal(u.checks, i + 1, `retry ${i + 1} not before ${m} min`);
    await advance(t, 1);
    assert.equal(u.checks, i + 2, `retry ${i + 1} after ${m} min`);
  }
  // Check 10 succeeded: back to the normal 6-hour rhythm.
  await advance(t, 6 * HOUR - 1);
  assert.equal(u.checks, 10);
  await advance(t, 1);
  assert.equal(u.checks, 11);
});

/** checkForUpdates() found 1.2.0 and started its download, which then failed. */
function downloadFails(message = 'sha512 checksum mismatch') {
  return {
    isUpdateAvailable: true,
    updateInfo: { version: '1.2.0' },
    downloadPromise: Promise.reject(new Error(message)),
  };
}

test('automatic check: a failed download (the whole installer each time) is retried after 6, 12, then 24 h, not on wake', async (t) => {
  // A release whose .exe fails verification, or a full disk: every attempt downloads ~100 MB and fails again.
  const u = startAutoUpdates(t, () => downloadFails());
  await advance(t, 12_000);
  assert.equal(u.checks, 1);
  await advance(t, MIN);
  assert.equal(u.checks, 1, 'not retried a minute later like a failed check');
  electronStub.powerMonitor.emit('resume');
  await advance(t, MIN);
  assert.equal(u.checks, 1, 'waking from sleep does not download it again sooner');
  await advance(t, 6 * HOUR - 2 * MIN - 1);
  assert.equal(u.checks, 1);
  await advance(t, 1);
  assert.equal(u.checks, 2, 'retried with the 6-hour re-check');
  const retryHours = [12, 24, 24];
  for (const [i, h] of retryHours.entries()) {
    await advance(t, h * HOUR - 1);
    assert.equal(u.checks, i + 2, `retry ${i + 2} not before ${h} h`);
    await advance(t, 1);
    assert.equal(u.checks, i + 3, `retry ${i + 2} after ${h} h`);
  }
});

test('automatic check: download and check failures back off separately; a good check resets both', async (t) => {
  const u = startAutoUpdates(t, (n) => {
    if (n === 1 || n === 3 || n === 5) return downloadFails('socket hang up');
    if (n === 2) throw new Error('getaddrinfo ENOTFOUND github.com');
    return NO_UPDATE; // n === 4: the broken release was taken down
  });
  await advance(t, 12_000);
  assert.equal(u.checks, 1);
  await advance(t, 6 * HOUR);
  assert.equal(u.checks, 2, 'download failed: next check 6 h later');
  await advance(t, MIN);
  assert.equal(u.checks, 3, 'that check failed: retried after a minute');
  await advance(t, 12 * HOUR - 1);
  assert.equal(u.checks, 3, 'second failed download in a row: 12 h');
  await advance(t, 1);
  assert.equal(u.checks, 4);
  await advance(t, 6 * HOUR);
  assert.equal(u.checks, 5, 'nothing to download: the usual 6 h');
  await advance(t, 6 * HOUR - 1);
  assert.equal(u.checks, 5);
  await advance(t, 1);
  assert.equal(u.checks, 6, 'a new failed download starts again at 6 h, not 24 h');
});

test('automatic check: waking from sleep checks 30 s later, unless a check succeeded within the hour', async (t) => {
  const u = startAutoUpdates(t, NO_UPDATE);
  await advance(t, 12_000);
  assert.equal(u.checks, 1);
  await advance(t, 30 * MIN);
  electronStub.powerMonitor.emit('resume');
  await advance(t, MIN);
  assert.equal(u.checks, 1, 'checked half an hour ago: no extra check');
  await advance(t, 2 * HOUR);
  electronStub.powerMonitor.emit('resume');
  await advance(t, 30_000 - 1);
  assert.equal(u.checks, 1);
  await advance(t, 1);
  assert.equal(u.checks, 2, 'checked 30 s after the resume');
  await advance(t, 6 * HOUR);
  assert.equal(u.checks, 3, 'and the 6-hour rhythm continues from there');
});

test('automatic check: stops once an update is downloaded (it installs on quit, no repeated restart prompts)', async (t) => {
  const u = startAutoUpdates(t, { isUpdateAvailable: true, updateInfo: { version: '1.2.0' }, downloadPromise: Promise.resolve([]) });
  let prompts = 0;
  t.mock.method(electronStub.dialog, 'showMessageBox', async () => {
    prompts += 1;
    return { response: 1 };
  });
  await advance(t, 12_000);
  assert.equal(u.checks, 1);
  u.emit('update-downloaded', { version: '1.2.0' });
  await advance(t, 6 * HOUR);
  await advance(t, 6 * HOUR);
  electronStub.powerMonitor.emit('resume');
  await advance(t, MIN);
  assert.equal(u.checks, 1);
  assert.equal(prompts, 1);
});
