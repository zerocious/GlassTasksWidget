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
/** What each link opens; a link not listed opens this exe. */
const targets = new Map();
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
      readShortcutLink: (lnk) => ({ target: targets.get(lnk) || process.execPath }),
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
  targets.clear();
  process.env.ProgramData = programData;
  delete process.env.GT_SKIP_SHORTCUTS;
});

/** An empty file stands in for a .lnk; the stub's `targets` says what it opens. */
function placeLink(lnk, target) {
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, '');
  if (target) targets.set(lnk, target);
}
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
  placeLink(allUsersLnk);
  try {
    ensureWindowsNotificationShortcut({ force: true });
    assert.deepEqual(writes, []);
  } finally {
    fs.rmSync(allUsersLnk);
  }
});

test('a per-machine install removes the per-user link an earlier version added for it', { skip: windowsOnly }, () => {
  placeLink(allUsersLnk);
  placeLink(userLnk);
  try {
    ensureWindowsNotificationShortcut({ force: true });
    assert.deepEqual(writes, []);
    assert.equal(fs.existsSync(userLnk), false);
  } finally {
    fs.rmSync(allUsersLnk);
    fs.rmSync(userLnk, { force: true });
  }
});

test('next to a per-machine install, a per-user link that is not its duplicate stays', { skip: windowsOnly }, () => {
  const other = path.join(root, 'other', 'Glass Tasks Widget.exe');
  placeLink(other);
  const cases = [
    // A second copy installed per-user: the all-users link opens the other one.
    { allUsers: other, user: process.execPath },
    // The per-user link opens another copy that still exists.
    { allUsers: process.execPath, user: other },
  ];
  try {
    for (const c of cases) {
      placeLink(allUsersLnk, c.allUsers);
      placeLink(userLnk, c.user);
      ensureWindowsNotificationShortcut({ force: true });
      assert.equal(fs.existsSync(userLnk), true, JSON.stringify(c));
      assert.ok(writes.every((w) => w.lnk !== userLnk || w.op === 'update'), JSON.stringify(writes));
      writes.length = 0;
    }
    // GT_SKIP_SHORTCUTS: nothing is touched, not even a duplicate.
    placeLink(allUsersLnk, process.execPath);
    placeLink(userLnk, process.execPath);
    process.env.GT_SKIP_SHORTCUTS = '1';
    ensureWindowsNotificationShortcut({ force: true });
    assert.equal(fs.existsSync(userLnk), true);
  } finally {
    fs.rmSync(allUsersLnk, { force: true });
    fs.rmSync(userLnk, { force: true });
  }
});
