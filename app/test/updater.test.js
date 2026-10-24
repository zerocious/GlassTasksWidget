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

const { checkForAppUpdates } = require('../electron/updater');

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
