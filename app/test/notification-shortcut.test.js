'use strict';

/**
 * The Start Menu link the widget writes for Windows toasts, with a stand-in for electron:
 * every folder is a temp one and shell.writeShortcutLink only records the call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('./helpers/storage');

const root = tmpDir('gt-shortcut-');
const dirs = { appData: path.join(root, 'appdata'), desktop: path.join(root, 'desktop') };
/** @type {{ lnk: string, op: string }[]} */
const writes = [];
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: (name) => dirs[name], isPackaged: true },
    shell: {
      writeShortcutLink: (lnk, op) => {
        writes.push({ lnk, op });
        return true;
      },
      readShortcutLink: () => ({ target: process.execPath }),
    },
    nativeImage: {},
    Notification: {},
  },
};

const { ensureWindowsNotificationShortcut } = require('../electron/notifications');

const PROGRAMS = ['Microsoft', 'Windows', 'Start Menu', 'Programs'];
const userLnk = path.join(dirs.appData, ...PROGRAMS, 'Glass Tasks Widget.lnk');
const programData = path.join(root, 'programdata');
const allUsersLnk = path.join(programData, ...PROGRAMS, 'Glass Tasks Widget.lnk');

const savedEnv = { ProgramData: process.env.ProgramData, GT_SKIP_SHORTCUTS: process.env.GT_SKIP_SHORTCUTS };
test.beforeEach(() => {
  writes.length = 0;
  process.env.ProgramData = programData;
  delete process.env.GT_SKIP_SHORTCUTS;
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const windowsOnly = process.platform !== 'win32' && 'the shortcut step runs on Windows only';

test('a per-user install gets its Start Menu link', { skip: windowsOnly }, () => {
  ensureWindowsNotificationShortcut({ force: true });
  assert.deepEqual(writes, [{ lnk: userLnk, op: 'create' }]);
});

test('a per-machine install adds no per-user link that its uninstaller would leave behind', { skip: windowsOnly }, () => {
  fs.mkdirSync(path.dirname(allUsersLnk), { recursive: true });
  fs.writeFileSync(allUsersLnk, '');
  try {
    ensureWindowsNotificationShortcut({ force: true });
    assert.deepEqual(writes, []);
  } finally {
    fs.rmSync(allUsersLnk);
  }
});
