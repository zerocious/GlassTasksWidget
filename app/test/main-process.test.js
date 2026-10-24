'use strict';

/**
 * electron/main.js started against a recording stand-in for Electron: no binary, window,
 * registry value or global hotkey is touched. Covers what a start does to the Windows login
 * item.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { freshDataRoot, tmpDir, writeRaw, fakeSafeStorage } = require('./helpers/storage');

const APP = path.join(__dirname, '..');
const MAIN = path.join(APP, 'electron', 'main.js');
const AUMID = 'com.glasstasks.widget'; // electron/notifications.js
const INSTALLED_EXE = path.resolve('/apps/Glass Tasks Widget/Glass Tasks Widget.exe');
const DEV_EXE = path.resolve('/repo/app/node_modules/electron/dist/electron.exe');
const ORIGINAL = { execPath: process.execPath, portable: process.env.PORTABLE_EXECUTABLE_FILE };

/** What the running main.js did; replaced on every start. */
let rec = null;

const image = { isEmpty: () => false, resize: () => image };
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

class FakeWindow {
  constructor(opts) {
    this.bounds = { x: opts.x ?? 100, y: opts.y ?? 100, width: opts.width, height: opts.height };
    this.visible = false;
    this.events = new Map();
    this.webContents = {
      setWindowOpenHandler() {},
      on() {},
      once() {},
      send() {},
      isLoadingMainFrame: () => false,
      openDevTools() {},
    };
    rec.windows.push(this);
  }
  static getAllWindows() {
    return rec.windows;
  }
  on(event, fn) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(fn);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  emit(event, ...args) {
    for (const fn of this.events.get(event) || []) fn(...args);
  }
  loadFile() {}
  getBounds() {
    return { ...this.bounds };
  }
  setPosition(x, y) {
    Object.assign(this.bounds, { x, y });
  }
  setSize(width, height) {
    Object.assign(this.bounds, { width, height });
  }
  setMinimumSize() {}
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  focus() {}
  isDestroyed() {
    return false;
  }
}

class FakeTray {
  setToolTip() {}
  setContextMenu() {}
  on() {}
  popUpContextMenu() {}
  destroy() {}
  isDestroyed() {
    return false;
  }
}

const fakeElectron = {
  app: {
    get isPackaged() {
      return rec.isPackaged;
    },
    setAppUserModelId() {},
    setPath() {},
    getPath: () => rec.userData,
    getVersion: () => '0.0.0-test',
    getName: () => 'glass-tasks-widget',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (event, fn) => {
      if (!rec.appEvents.has(event)) rec.appEvents.set(event, []);
      rec.appEvents.get(event).push(fn);
    },
    quit() {},
    relaunch() {},
    exit() {},
    setLoginItemSettings: (settings) => rec.loginWrites.push(settings),
    getLoginItemSettings: (options) => {
      rec.loginReads.push(options);
      return { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: rec.launchItems };
    },
  },
  BrowserWindow: FakeWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate: (template) => template },
  nativeImage: { createFromPath: () => image, createFromDataURL: () => image, createEmpty: () => image },
  Notification: Object.assign(class {}, { isSupported: () => false }),
  ipcMain: {
    handle: (channel, fn) => rec.handlers.set(channel, fn),
    on: (channel, fn) => rec.listeners.set(channel, fn),
  },
  globalShortcut: {
    register: (accel, fn) => {
      rec.registerAttempts.push(accel);
      if (rec.busyKeys.has(accel)) return false;
      rec.shortcuts.set(accel, fn);
      return true;
    },
    unregisterAll: () => rec.shortcuts.clear(),
  },
  screen: { getDisplayMatching: () => display, getDisplayNearestPoint: () => display },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  clipboard: { writeText() {} },
  powerMonitor: { on() {} },
  safeStorage: fakeSafeStorage,
  session: {
    defaultSession: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      clearStorageData: async () => {},
      clearCache: async () => {},
    },
  },
};

function stubModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stubModule('electron', fakeElectron);
// Not under test here; the real ones would show toasts, check for updates or write shortcuts.
stubModule('../electron/notifications', {
  APP_USER_MODEL_ID: AUMID,
  configureNotifications() {},
  windowsToastsGloballyEnabled: () => true,
  ensureWindowsNotificationShortcut() {},
});
stubModule('../electron/reminders', {
  configureReminders() {},
  runReminderCheck: async () => ({}),
  syncRemindersScheduler() {},
  stopRemindersScheduler() {},
  refreshExactReminders() {},
});
stubModule('../electron/updater', { setupAutoUpdater() {}, checkForAppUpdates: async () => ({}) });

const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
test.after(() => Object.assign(console, realConsole));

function restoreProcess() {
  process.execPath = ORIGINAL.execPath;
  if (ORIGINAL.portable === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
  else process.env.PORTABLE_EXECUTABLE_FILE = ORIGINAL.portable;
}

/**
 * Start a fresh copy of main.js and let its whenReady() run.
 * @param {import('node:test').TestContext} t
 * @param {{ isPackaged?: boolean, execPath?: string, portableExe?: string, settings?: object,
 *   prepare?: (root: string) => void, launchItems?: object[], busyKeys?: string[] }} opts
 */
async function startMain(t, opts = {}) {
  const root = freshDataRoot();
  if (opts.settings) writeRaw(root, 'settings.json', { schemaVersion: 1, ...opts.settings });
  if (opts.prepare) opts.prepare(root);
  rec = {
    isPackaged: opts.isPackaged !== false,
    userData: tmpDir('gt-main-userdata-'),
    launchItems: opts.launchItems || [],
    busyKeys: new Set(opts.busyKeys || []),
    appEvents: new Map(),
    handlers: new Map(),
    listeners: new Map(),
    windows: [],
    shortcuts: new Map(),
    registerAttempts: [],
    loginWrites: [],
    loginReads: [],
    warnings: [],
    errors: [],
  };
  process.execPath = opts.execPath || (rec.isPackaged ? INSTALLED_EXE : DEV_EXE);
  if (opts.portableExe) process.env.PORTABLE_EXECUTABLE_FILE = opts.portableExe;
  else delete process.env.PORTABLE_EXECUTABLE_FILE;
  const current = rec;
  t.after(() => {
    for (const fn of current.appEvents.get('will-quit') || []) fn();
    restoreProcess();
  });

  // main.js mirrors the console into its log; keep the test output quiet and readable.
  console.log = () => {};
  console.info = () => {};
  console.warn = (...args) => current.warnings.push(args.map(String).join(' '));
  console.error = (...args) => current.errors.push(args.map(String).join(' '));
  const listeners = {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection'),
  };
  delete require.cache[MAIN];
  require(MAIN);
  // main.js keeps the real app alive on any exception; a test must still fail on one.
  for (const [event, before] of Object.entries(listeners)) {
    for (const fn of process.listeners(event)) if (!before.includes(fn)) process.removeListener(event, fn);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(current.errors, [], 'the start logged no errors');
  assert.equal(current.windows.length, 1, 'the widget window was created');
  const win = current.windows[0];
  const ipc = (channel, payload) => current.handlers.get(channel)({ sender: win.webContents }, payload);
  const send = (channel) => current.listeners.get(channel)({ sender: win.webContents });
  return { win, ipc, send, root };
}

// --- Login item (HKCU\…\Run) -------------------------------------------------------------------

test('a start on a fresh profile leaves the login item alone (smoke test, second copy)', async (t) => {
  // The bug: autostart is off on a fresh profile, and the start removed the installed widget's entry.
  await startMain(t, { isPackaged: true });
  assert.deepEqual(rec.loginWrites, []);
});

test('a dev run on a fresh profile leaves the login item alone', async (t) => {
  await startMain(t, { isPackaged: false });
  assert.deepEqual(rec.loginWrites, []);
});

test('a dev run uses a login item of its own, never the installed widget’s', async (t) => {
  // The bug: with autostart on, `npm start` repointed the installed widget's entry at electron.exe.
  const { ipc } = await startMain(t, { isPackaged: false, settings: { autostart: true } });
  const own = { name: `${AUMID}.dev`, path: DEV_EXE, args: [APP] };
  assert.deepEqual(rec.loginWrites, [{ openAtLogin: true, ...own }]);
  await ipc('widget:set-settings', { autostart: false });
  assert.deepEqual(rec.loginWrites.at(-1), { openAtLogin: false, ...own });
});

test('a start keeps an entry that already starts this exe («Disabled» in Task Manager stays)', async (t) => {
  // The bug: every start rewrote the entry, and Electron's default `enabled: true` re-enabled it.
  await startMain(t, {
    settings: { autostart: true },
    launchItems: [{ name: AUMID, path: INSTALLED_EXE, args: [], scope: 'user', enabled: false }],
  });
  assert.deepEqual(rec.loginWrites, []);
});

test('a start restores a missing entry when autostart is on', async (t) => {
  await startMain(t, { settings: { autostart: true } });
  assert.deepEqual(rec.loginWrites, [{ openAtLogin: true, name: AUMID }]);
});

test('a copy running from the temp folder never writes the login item at start', async (t) => {
  const smokeExe = path.join(os.tmpdir(), 'gt-smoke-AbC123', 'pack', 'win-unpacked', 'Glass Tasks Widget.exe');
  await startMain(t, { execPath: smokeExe, settings: { autostart: true } });
  assert.deepEqual(rec.loginWrites, []);
});

test('portable build: autostart points at the portable exe, not at its copy unpacked into %TEMP%', async (t) => {
  // The bug: the Run entry named the temp copy, which the portable launcher deletes on exit.
  const portableExe = path.resolve('/Users/me/Downloads/Glass-Tasks-Widget-Portable-1.1.0.exe');
  const { ipc } = await startMain(t, {
    execPath: path.join(os.tmpdir(), '2Ab3Cd4Ef', 'Glass Tasks Widget.exe'),
    portableExe,
  });
  assert.deepEqual(rec.loginWrites, []);
  await ipc('widget:set-settings', { autostart: true });
  assert.deepEqual(rec.loginWrites, [{ openAtLogin: true, name: AUMID, path: `"${portableExe}"`, args: [] }]);
});
