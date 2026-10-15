'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../lib/config');
const settings = require('../lib/settings-store');
const reminders = require('../lib/reminder-store');
const offline = require('../lib/offline-cache');
const mock = require('../lib/mock-data');
const { getStorageEvents } = require('../lib/storage-status');
const { todayIso } = require('../lib/dates');
const { fakeSafeStorage, useTempDataRoot, read, readJsonFile, write, exists } = require('./helpers/tmp-data');

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
});
test.afterEach(() => env.cleanup());

const kinds = () => getStorageEvents().map((e) => e.kind);
const migrationCopies = (prefix) => {
  const dir = path.join(env.dir, 'backups', 'migrations');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(prefix)) : [];
};

// ---- settings.json ---------------------------------------------------------------------------

test('settings: a legacy unversioned file keeps its values, gets schemaVersion and a backup', () => {
  write(env.dir, 'settings.json', { theme: 'light', bgOpacity: 0.5, pos: { x: 10, y: 20 }, remindersEnabled: false });
  const s = settings.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.bgOpacity, 0.5);
  assert.deepEqual(s.pos, { x: 10, y: 20 });
  assert.equal(s.remindersEnabled, false);
  assert.equal(readJsonFile(env.dir, 'settings.json').schemaVersion, 1);
  assert.equal(migrationCopies('settings.json.v0').length, 1);
  assert.deepEqual(kinds(), ['migrated']);
});

test('settings: no file means defaults and nothing is written until something changes', () => {
  assert.equal(settings.loadSettings().theme, 'dark');
  assert.equal(exists(env.dir, 'settings.json'), false);
  settings.saveSettings({ theme: 'light' });
  assert.equal(readJsonFile(env.dir, 'settings.json').schemaVersion, 1);
  assert.equal(read(env.dir, 'settings.json.bak'), read(env.dir, 'settings.json'));
});

test('settings: corrupt file is restored from the last good copy', () => {
  settings.saveSettings({ theme: 'light', size: 'compact' });
  fs.writeFileSync(path.join(env.dir, 'settings.json'), '{"schemaVersion":1,"theme":"li');
  settings.resetSettingsCache();
  const s = settings.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.size, 'compact');
  assert.deepEqual(kinds(), ['corrupt-quarantined', 'restored-from-backup']);
});

test('settings: schemaVersion is bookkeeping and never leaks into the settings object', () => {
  settings.saveSettings({ theme: 'light' });
  settings.resetSettingsCache();
  assert.equal('schemaVersion' in settings.loadSettings(), false);
});

// ---- reminders.json ----------------------------------------------------------------------------

test('reminders: legacy file is migrated, today ids survive, state round-trips', () => {
  write(env.dir, 'reminders.json', { date: todayIso(), notifiedIds: ['a', 'b', 'a'] });
  assert.deepEqual(reminders.loadReminderState().notifiedIds, ['a', 'b']);
  assert.equal(readJsonFile(env.dir, 'reminders.json').schemaVersion, 1);
  reminders.markNotified(['c']);
  assert.deepEqual(reminders.loadReminderState().notifiedIds, ['a', 'b', 'c']);
  assert.equal(reminders.wasNotifiedToday('c'), true);
});

test('reminders: a corrupt file is quarantined and reminders start empty (disposable data, no .bak)', () => {
  write(env.dir, 'reminders.json', '{nope');
  assert.deepEqual(reminders.loadReminderState().notifiedIds, []);
  assert.equal(exists(env.dir, 'reminders.json.bak'), false);
  assert.ok(fs.readdirSync(env.dir).some((n) => n.startsWith('reminders.json.corrupt-')));
});

// ---- offline-cache.json (item 3) ----------------------------------------------------------------

const payload = (extra = {}) => ({
  mode: 'google',
  tasksListName: 'Tasks',
  habitsListName: 'Habits',
  accentColor: '#C4122E',
  tasksListFound: true,
  habitsListFound: true,
  tasks: [{ id: 't1', title: 'Secret meeting with Alice', notes: 'private note', due: null }],
  habits: [{ id: 'h1', title: 'Meditate' }],
  ...extra,
});

test('offline cache: encrypted at rest, versioned, titles and notes not readable on disk', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  offline.saveOfflineCache(payload());
  offline.flushOfflineCache();
  const text = read(env.dir, 'offline-cache.json');
  assert.equal(text.includes('Secret meeting'), false);
  assert.equal(text.includes('private note'), false);
  assert.equal(JSON.parse(text).format, 'glass-tasks/safeStorage@1');
  offline.resetOfflineCacheForTests();
  const loaded = offline.loadOfflineCache();
  assert.equal(loaded.tasks[0].title, 'Secret meeting with Alice');
});

test('offline cache: saving does not block on disk, writes are coalesced and flushed on demand', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  const writes = [];
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).includes('offline-cache.json')) writes.push(String(file));
    return origWrite.call(this, file, ...rest);
  };
  try {
    for (let i = 0; i < 50; i += 1) offline.saveOfflineCache(payload({ tasks: [{ id: `t${i}`, title: `Task ${i}` }] }));
    assert.equal(writes.length, 0, 'mutations only touch memory');
    assert.equal(exists(env.dir, 'offline-cache.json'), false);
    offline.flushOfflineCache();
    assert.equal(writes.length, 1, 'one coalesced write');
    offline.flushOfflineCache();
    assert.equal(writes.length, 1, 'flush with nothing pending is a no-op');
  } finally {
    fs.writeFileSync = origWrite;
  }
  offline.resetOfflineCacheForTests();
  assert.equal(offline.loadOfflineCache().tasks[0].id, 't49');
});

test('offline cache: the debounce timer writes by itself', async () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  offline.saveOfflineCache(payload());
  assert.equal(exists(env.dir, 'offline-cache.json'), false);
  await new Promise((r) => setTimeout(r, offline.WRITE_DELAY_MS + 300));
  assert.equal(exists(env.dir, 'offline-cache.json'), true);
});

test('offline cache: patches go through memory and survive a flush', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  offline.saveOfflineCache(payload());
  offline.patchOfflineCache('tasks', 't1', { title: 'Renamed' });
  offline.flushOfflineCache();
  offline.resetOfflineCacheForTests();
  assert.equal(offline.loadOfflineCache().tasks[0].title, 'Renamed');
});

test('offline cache: without safeStorage nothing personal is written, the cache lives in memory', () => {
  config.setSafeStorageForTests(null);
  offline.saveOfflineCache(payload());
  offline.flushOfflineCache();
  assert.equal(exists(env.dir, 'offline-cache.json'), false);
  assert.equal(offline.loadOfflineCache().tasks[0].id, 't1');
  assert.equal(kinds().includes('secrets-memory-only'), false, 'a cache is not a secret: no alarming warning');
});

test('offline cache: a legacy plaintext file is read once and re-saved encrypted', () => {
  write(env.dir, 'offline-cache.json', { ...payload(), savedAt: '2026-01-01T00:00:00.000Z' });
  config.setSafeStorageForTests(fakeSafeStorage);
  const loaded = offline.loadOfflineCache();
  assert.equal(loaded.tasks[0].title, 'Secret meeting with Alice');
  assert.equal(read(env.dir, 'offline-cache.json').includes('Secret meeting'), false);
  assert.ok(migrationCopies('offline-cache.json.v0').length >= 1);
});

test('offline cache: clearing cancels a pending write and removes the file', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  offline.saveOfflineCache(payload());
  offline.flushOfflineCache();
  offline.saveOfflineCache(payload({ tasks: [] }));
  offline.clearOfflineCache();
  offline.flushOfflineCache();
  assert.equal(exists(env.dir, 'offline-cache.json'), false);
  assert.equal(offline.loadOfflineCache(), null);
});

test('offline cache: a placeholder or foreign file is not treated as a cache', () => {
  config.setSafeStorageForTests(fakeSafeStorage);
  write(env.dir, 'offline-cache.json', { clearedAt: 'x' });
  assert.equal(offline.loadOfflineCache(), null);
});

// ---- mock-items.json -------------------------------------------------------------------------------

test('mock: first run seeds the demo lists; a legacy file is migrated with its items intact', () => {
  write(env.dir, 'mock-items.json', {
    tasks: [{ id: 'mock-x', title: 'My demo task', notes: '', parent: null, due: null, status: 'needsAction', completed: false }],
    habits: [],
  });
  const store = mock.loadMockStore();
  assert.equal(store.tasks[0].title, 'My demo task');
  assert.equal(readJsonFile(env.dir, 'mock-items.json').schemaVersion, 1);
  assert.equal(migrationCopies('mock-items.json.v0').length, 1);
});

test('mock: corrupt demo file is restored from its last good copy', () => {
  const first = mock.loadMockStore();
  mock.addMockItem('tasks', 'Remember me');
  fs.writeFileSync(path.join(env.dir, 'mock-items.json'), '{"tasks": [');
  const restored = mock.loadMockStore();
  assert.equal(restored.tasks[0].title, 'Remember me');
  assert.ok(restored.tasks.length > first.tasks.length - 1);
});

test('mock: merge adds only unknown, well-formed items', () => {
  mock.loadMockStore();
  const res = mock.mergeMockStore({
    tasks: [
      { id: 'mock-t1', title: 'already there under another title' },
      { id: 'new-1', title: 'Brand new', notes: 'n', status: 'completed', evil: '<script>' },
      { id: '', title: 'no id' },
      'junk',
    ],
    habits: [{ id: 'new-h', title: 'New habit' }],
  });
  assert.deepEqual(res, { tasksAdded: 1, habitsAdded: 1, rejected: 2 });
  const added = mock.loadMockStore().tasks.find((t) => t.id === 'new-1');
  assert.equal(added.completed, true);
  assert.equal('evil' in added, false);
  assert.equal(mock.loadMockStore().tasks.find((t) => t.id === 'mock-t1').title, 'Review project proposal');
});
