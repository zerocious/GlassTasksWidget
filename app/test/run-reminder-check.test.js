'use strict';

/**
 * scripts/run-reminder-check.js (a dev tool run with `npx electron`) with a stand-in for electron:
 * every folder is a temp one and shell.writeShortcutLink only records the call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { freshDataRoot, tmpDir } = require('./helpers/storage');

const root = tmpDir('gt-check-script-');
const dirs = { appData: path.join(root, 'appdata'), desktop: path.join(root, 'desktop') };
/** @type {{ lnk: string, op: string }[]} */
const writes = [];
/** @type {number[]} */
const exits = [];
const INSTALLED = path.join(root, 'Programs', 'Glass Tasks Widget', 'Glass Tasks Widget.exe');
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false, // `npx electron scripts/...` runs the dev electron.exe
      setAppUserModelId: () => {},
      whenReady: () => Promise.resolve(),
      getPath: (name) => dirs[name],
      exit: (code) => exits.push(code),
    },
    shell: {
      writeShortcutLink: (lnk, op) => {
        writes.push({ lnk, op });
        return true;
      },
      readShortcutLink: () => ({ target: INSTALLED }),
    },
    Notification: { isSupported: () => true },
    nativeImage: {},
    powerMonitor: {},
  },
};

test('the reminder check script leaves the installed widget\'s Start Menu link alone', async () => {
  const userLnk = path.join(dirs.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Glass Tasks Widget.lnk');
  fs.mkdirSync(path.dirname(userLnk), { recursive: true });
  fs.writeFileSync(userLnk, ''); // the installed widget's link
  fs.mkdirSync(path.dirname(INSTALLED), { recursive: true });
  fs.writeFileSync(INSTALLED, '');
  const savedProgramData = process.env.ProgramData;
  process.env.ProgramData = path.join(root, 'programdata');
  delete process.env.GT_SKIP_SHORTCUTS;

  freshDataRoot();
  // Reminders off: the script stops (exit 3) right after the shortcut step, before any toast.
  require('../lib/settings-store').saveSettings({ remindersEnabled: false });
  try {
    require('../scripts/run-reminder-check');
    for (let i = 0; i < 200 && !exits.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(exits, [3]);
    assert.deepEqual(writes, []);
  } finally {
    if (savedProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = savedProgramData;
  }
});
