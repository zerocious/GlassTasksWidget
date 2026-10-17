'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../lib/config');
const core = require('../lib/storage-core');
const auth = require('../lib/google-auth');
const settings = require('../lib/settings-store');
const streaks = require('../lib/streak-store');
const offline = require('../lib/offline-cache');
const mock = require('../lib/mock-data');
const backup = require('../lib/storage-backup');
const { wipeAllData, assertSafeToEmpty, emptyFolder } = require('../lib/storage-wipe');
const { getStorageReport } = require('../lib/storage-report');
const { createDataHandlers } = require('../electron/data-ipc');
const { fakeSafeStorage, useTempDataRoot, write, exists } = require('./helpers/tmp-data');

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-super-secret-value';

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
});
test.afterEach(() => env.cleanup());

function seedEverything() {
  config.setSafeStorageForTests(fakeSafeStorage);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  auth._test.saveTokens({ refresh_token: '1//0gRefreshTokenValue-abcdefghijklmnop' });
  settings.saveSettings({ theme: 'light' });
  streaks.markCompleted('h1', '2026-03-01');
  offline.saveOfflineCache({ mode: 'google', tasks: [{ id: 't', title: 'private' }], habits: [] });
  offline.flushOfflineCache();
  mock.loadMockStore();
  backup.createBackup({ kind: 'manual' });
  write(env.dir, 'streaks.json.corrupt-1', 'old');
  write(env.dir, 'reminders.json', { date: '2026-03-01', notifiedIds: [] });
}

// ---- item 7: delete all my data ------------------------------------------------------------------------

test('wipe removes every file, forgets keys in memory and revokes the Google grant first', async () => {
  seedEverything();
  const order = [];
  const session = {
    clearStorageData: async () => order.push('storage'),
    clearCache: async () => order.push('cache'),
    clearAuthCache: async () => order.push('auth'),
  };
  const result = await wipeAllData({
    session,
    revoke: async () => {
      // keys must still be there when the grant is revoked
      assert.equal(config.getGoogleClientSecret(), CLIENT_SECRET);
      order.push('revoke');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.equal(result.chromiumCleared, true);
  assert.deepEqual(order, ['revoke', 'storage', 'cache', 'auth']);
  assert.deepEqual(fs.readdirSync(env.dir), [], 'the data folder is empty (backups, .bak, corrupt copies included)');
  config.setSafeStorageForTests(null);
  assert.equal(config.hasGoogleCredentials(), false);
  assert.equal(config.getGoogleClientSecret(), null);
  assert.equal(offline.loadOfflineCache(), null);
  assert.deepEqual(core.memoryOnlySecretFiles(), []);
});

test('after a wipe nothing can write personal data back before the restart', async () => {
  seedEverything();
  await wipeAllData({ revoke: async () => {} });
  settings.saveSettings({ theme: 'dark', size: 'compact' });
  streaks.markCompleted('h1', '2026-04-01');
  offline.saveOfflineCache({ mode: 'google', tasks: [{ id: 't', title: 'private' }], habits: [] });
  offline.flushOfflineCache();
  assert.deepEqual(fs.readdirSync(env.dir), []);
});

test('wipe still works offline: a failing revoke is reported but the data is deleted', async () => {
  seedEverything();
  const result = await wipeAllData({
    revoke: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(result.revoked, false);
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(env.dir), []);
});

test('wipe reports files it could not delete instead of pretending success', async () => {
  seedEverything();
  const orig = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p).endsWith('streaks.json')) throw new Error('EBUSY');
    return orig(p, ...rest);
  };
  try {
    const result = await wipeAllData({ revoke: async () => {} });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ['streaks.json']);
  } finally {
    fs.rmSync = orig;
  }
});

test('wipe leaves the logs folder and a developer .env alone', async () => {
  seedEverything();
  // the logs folder lives beside the data folder in the real layout (userData/logs)
  const logs = path.join(env.base, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'app.log'), 'keep me');
  write(env.dir, '.env', 'GOOGLE_CLIENT_ID=dev\n'); // developer-authored: no app marker
  await wipeAllData({ revoke: async () => {} });
  assert.equal(fs.readFileSync(path.join(logs, 'app.log'), 'utf8'), 'keep me');
});

test('wipe removes the plaintext .env that older versions wrote (marker present)', async () => {
  const envPath = config.getCredentialsEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, '# Saved by the app UI\nGOOGLE_CLIENT_SECRET=x\n');
  await wipeAllData({ revoke: async () => {} });
  assert.equal(fs.existsSync(envPath), false);
});

test('emptyFolder refuses roots, the home folder and shallow paths', () => {
  const home = os.homedir();
  for (const bad of ['', path.parse(process.cwd()).root, home, path.join(path.parse(home).root, 'x'), path.join(path.parse(home).root, 'a', 'b')]) {
    assert.throws(() => assertSafeToEmpty(bad), /Refusing/, `should refuse "${bad}"`);
    assert.throws(() => emptyFolder(bad), /Refusing/);
  }
  assert.doesNotThrow(() => assertSafeToEmpty(env.dir));
});

// ---- item 1: the report ---------------------------------------------------------------------------------------

test('report: reflects encryption state, flags plaintext secrets, never prints contents', () => {
  seedEverything();
  let report = getStorageReport();
  assert.equal(report.secrets.mode, 'encrypted');
  const byName = Object.fromEntries(report.files.map((f) => [f.name, f]));
  assert.equal(byName['tokens.json'].protection, 'encrypted');
  assert.equal(byName['credentials.json'].protection, 'encrypted');
  assert.equal(byName['offline-cache.json'].protection, 'encrypted');
  assert.equal(byName['streaks.json'].schemaVersion, 1);
  assert.equal(byName['settings.json'].schemaVersion, 1);
  assert.equal(report.backups.count, 1);
  const text = JSON.stringify(report);
  assert.equal(text.includes(CLIENT_SECRET) || text.includes('private') || text.includes('1//0g'), false);

  config.setSafeStorageForTests(null);
  write(env.dir, 'tokens.json', { refresh_token: 'legacy-plain' });
  report = getStorageReport();
  assert.equal(report.secrets.mode, 'memory-only');
  assert.deepEqual(report.secrets.plaintextOnDisk, ['tokens.json']);
  assert.equal(JSON.stringify(report).includes('legacy-plain'), false);
});

test('report: memory-only secrets are listed', () => {
  config.setSafeStorageForTests(null);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const report = getStorageReport();
  assert.deepEqual(report.secrets.memoryOnly, ['credentials.json']);
  assert.ok(report.events.some((e) => e.kind === 'secrets-memory-only'));
});

test('stale temp files from a crashed write are removed, fresh ones are kept', () => {
  write(env.dir, 'streaks.json.1.2.tmp', 'x');
  write(env.dir, 'settings.json.3.4.tmp', 'y');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(path.join(env.dir, 'streaks.json.1.2.tmp'), old, old);
  assert.deepEqual(core.removeStaleTempFiles(env.dir), ['streaks.json.1.2.tmp']);
  assert.equal(exists(env.dir, 'settings.json.3.4.tmp'), true);
});

// ---- IPC handlers (Electron replaced by fakes) -----------------------------------------------------------------

function fakeIpc(extra = {}) {
  const calls = { relaunch: 0, loginItem: [], messageBoxes: [], saveDialogs: [] };
  const queue = { message: [], save: [], open: [] };
  const deps = {
    app: {
      getPath: (name) => (name === 'userData' ? env.dir : os.tmpdir()),
      getVersion: () => '1.0.0',
      setLoginItemSettings: (o) => calls.loginItem.push(o),
    },
    dialog: {
      showMessageBox: async (_w, opts) => {
        calls.messageBoxes.push(opts);
        return { response: queue.message.shift() };
      },
      showSaveDialog: async (_w, opts) => {
        calls.saveDialogs.push(opts);
        return queue.save.shift();
      },
      showOpenDialog: async () => queue.open.shift(),
    },
    session: { clearStorageData: async () => {}, clearCache: async () => {} },
    isFromWidget: (e) => Boolean(e && e.ok),
    getMainWindow: () => null,
    getWidgetData: async () => ({ tasks: [{ id: 't1', title: 'Buy milk', completed: false }], habits: [{ id: 'h1', title: 'Run', completed: true }] }),
    relaunch: () => {
      calls.relaunch += 1;
    },
    ...extra,
  };
  return { handlers: createDataHandlers(deps), calls, queue };
}
const OK = { ok: true };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('ipc: every channel rejects senders other than the widget window', async () => {
  const { handlers } = fakeIpc();
  for (const [channel, handler] of Object.entries(handlers)) {
    await assert.rejects(() => handler({ ok: false }, {}), /Unauthorized/, channel);
  }
});

test('ipc: delete-all asks first; cancelling deletes nothing', async () => {
  seedEverything();
  const { handlers, queue, calls } = fakeIpc();
  queue.message.push(1); // «Отмена»
  assert.deepEqual(await handlers['data:delete-all'](OK), { ok: true, canceled: true });
  assert.equal(calls.messageBoxes[0].type, 'warning');
  assert.equal(calls.messageBoxes[0].defaultId, 1, 'the safe button is the default');
  assert.equal(exists(env.dir, 'streaks.json'), true);
  await wait(400);
  assert.equal(calls.relaunch, 0);
});

test('ipc: confirmed delete-all wipes, turns autostart off and restarts the widget', async () => {
  seedEverything();
  const { handlers, queue, calls } = fakeIpc();
  queue.message.push(0);
  const res = await handlers['data:delete-all'](OK);
  assert.equal(res.ok, true);
  assert.equal(res.restarting, true);
  assert.deepEqual(fs.readdirSync(env.dir), []);
  assert.deepEqual(calls.loginItem, [{ openAtLogin: false }]);
  await wait(400);
  assert.equal(calls.relaunch, 1);
});

test('ipc: export-json writes a bundle without secrets to the chosen file', async () => {
  seedEverything();
  const { handlers, queue } = fakeIpc();
  const out = path.join(env.base, 'export.json');
  queue.save.push({ canceled: false, filePath: out });
  try {
    const res = await handlers['data:export-json'](OK, { includeLogs: false });
    assert.equal(res.ok, true);
    const text = fs.readFileSync(out, 'utf8');
    assert.equal(text.includes(CLIENT_SECRET) || text.includes('1//0g'), false);
    assert.equal(backup.parseBundle(text).summary.habits, 1);
    queue.save.push({ canceled: true });
    assert.deepEqual(await handlers['data:export-json'](OK, {}), { ok: true, canceled: true });
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('ipc: export-csv writes the current tasks', async () => {
  const { handlers, queue } = fakeIpc();
  const out = path.join(env.base, 'tasks.csv');
  queue.save.push({ canceled: false, filePath: out });
  try {
    const res = await handlers['data:export-csv'](OK);
    assert.deepEqual({ ok: res.ok, rows: res.rows }, { ok: true, rows: 2 });
    const csv = fs.readFileSync(out, 'utf8');
    assert.ok(csv.includes('tasks,Buy milk,needsAction,,,t1,'));
    assert.ok(csv.includes('habits,Run,completed,,,h1,'));
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('ipc: import validates the file, asks for confirmation and merges', async () => {
  streaks.markCompleted('h1', '2026-03-01');
  const text = backup.serializeBundle(backup.buildBundle());
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-imp-'));
  const file = path.join(holder, 'import.json');
  fs.writeFileSync(file, text);
  env.cleanup();
  env = useTempDataRoot();
  streaks.markCompleted('h1', '2026-03-09');
  const { handlers, queue, calls } = fakeIpc();
  try {
    // 1) the user declines
    queue.open.push({ canceled: false, filePaths: [file] });
    queue.message.push(1);
    assert.deepEqual(await handlers['data:import'](OK), { ok: true, canceled: true });
    assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-09']);
    // 2) the user confirms
    queue.open.push({ canceled: false, filePaths: [file] });
    queue.message.push(0);
    const res = await handlers['data:import'](OK);
    assert.equal(res.ok, true);
    assert.equal(res.result.streaks.datesAdded, 1);
    assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-09']);
    assert.match(calls.messageBoxes[0].detail, /ОБЪЕДИНЕНЫ/);
    assert.equal(res.restarting, true, 'settings were part of the file');
    // 3) not one of our files
    fs.writeFileSync(file, '{"hello": 1}');
    queue.open.push({ canceled: false, filePaths: [file] });
    const bad = await handlers['data:import'](OK);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /не файл экспорта/);
    await wait(400);
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
});

test('ipc: restore-backup only accepts backup names and merges after confirmation', async () => {
  streaks.markCompleted('h1', '2026-03-01');
  const { name } = backup.createBackup({ kind: 'manual' });
  streaks.unmarkCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-05');
  const { handlers, queue } = fakeIpc();
  const evil = await handlers['data:restore-backup'](OK, { name: '../streaks.json' });
  assert.equal(evil.ok, false);
  queue.message.push(0);
  const res = await handlers['data:restore-backup'](OK, { name });
  assert.equal(res.ok, true);
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-05']);
  await wait(400);
});

test('ipc: backup-now and backups-list', async () => {
  streaks.markCompleted('h1', '2026-03-01');
  const { handlers } = fakeIpc();
  const made = await handlers['data:backup-now'](OK);
  assert.equal(made.ok, true);
  const list = await handlers['data:backups-list'](OK);
  assert.deepEqual(list.map((b) => b.name), [made.name]);
});

test('ipc: operations do not overlap', async () => {
  seedEverything();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { handlers, queue } = fakeIpc();
  queue.message.push(gate.then(() => 1));
  const first = handlers['data:delete-all'](OK);
  const second = await handlers['data:backup-now'](OK);
  assert.equal(second.ok, false);
  assert.match(second.error, /ещё выполняется/);
  release();
  await first;
});

test('ipc: status returns the storage report', async () => {
  const { handlers } = fakeIpc();
  const report = await handlers['data:status'](OK);
  assert.equal(typeof report.dataDir, 'string');
  assert.ok(Array.isArray(report.events));
});

test('registerDataIpc wires channels, event push, quit flush and housekeeping', async () => {
  const { registerDataIpc } = require('../electron/data-ipc');
  const { recordStorageEvent } = require('../lib/storage-status');
  const handled = [];
  const listeners = {};
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, p) => sent.push([c, p]) } };
  write(env.dir, 'streaks.json.9.9.tmp', 'stale');
  fs.utimesSync(path.join(env.dir, 'streaks.json.9.9.tmp'), new Date(0), new Date(0));
  config.setSafeStorageForTests(fakeSafeStorage);
  registerDataIpc({
    ipcMain: { handle: (channel) => handled.push(channel) },
    app: {
      on: (event, fn) => (listeners[event] = [...(listeners[event] || []), fn]),
      getVersion: () => '1.0.0',
      getPath: () => env.dir,
    },
    dialog: {},
    session: null,
    isFromWidget: () => true,
    getMainWindow: () => win,
  });
  assert.deepEqual(handled.sort(), [
    'data:backup-now',
    'data:backups-list',
    'data:delete-all',
    'data:export-csv',
    'data:export-json',
    'data:import',
    'data:restore-backup',
    'data:status',
  ]);
  assert.equal(exists(env.dir, 'streaks.json.9.9.tmp'), false, 'stale temp file removed at startup');
  recordStorageEvent('restored-from-backup', 'streaks.json');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'data:event');
  assert.equal(sent[0][1].kind, 'restored-from-backup');

  // the pending cache write is flushed when the app quits
  offline.saveOfflineCache({ mode: 'google', tasks: [{ id: 't', title: 'x' }], habits: [] });
  assert.equal(exists(env.dir, 'offline-cache.json'), false);
  for (const fn of listeners['before-quit']) fn();
  assert.equal(exists(env.dir, 'offline-cache.json'), true);
});

test('ipc: the default relaunch quits normally (before-quit hooks run) instead of exiting hard', async () => {
  const calls = [];
  const { handlers, queue } = fakeIpc({
    relaunch: undefined,
    app: {
      getPath: () => env.dir,
      getVersion: () => '1.0.0',
      setLoginItemSettings: () => {},
      relaunch: () => calls.push('relaunch'),
      quit: () => calls.push('quit'),
      exit: () => calls.push('exit'),
    },
  });
  streaks.markCompleted('h1', '2026-03-01');
  const text = backup.serializeBundle(backup.buildBundle());
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-imp-'));
  const file = path.join(holder, 'import.json');
  fs.writeFileSync(file, text);
  try {
    queue.open.push({ canceled: false, filePaths: [file] });
    queue.message.push(0);
    const res = await handlers['data:import'](OK);
    assert.equal(res.restarting, true);
    await wait(400);
    assert.deepEqual(calls, ['relaunch', 'quit']);
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
});
