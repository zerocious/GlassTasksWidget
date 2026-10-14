'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { migrate, schemaVersionOf } = require('../lib/storage-migrate');
const { createJsonDoc, flushAllDocs } = require('../lib/storage-doc');
const { getStorageIssues } = require('../lib/storage-events');
const settingsStore = require('../lib/settings-store');
const reminderStore = require('../lib/reminder-store');
const { freshDataRoot, writeRaw, readRaw } = require('./helpers/storage');

const names = (root) => fs.readdirSync(root).sort();
const kinds = () => getStorageIssues().map((i) => i.kind);

test('migrate() runs each step from the file version up, and never downgrades', () => {
  const spec = {
    version: 3,
    migrations: {
      2: (d) => ({ ...d, b: (d.a || 0) + 1 }),
      3: (d) => ({ ...d, c: d.b * 10 }),
    },
  };
  assert.deepEqual(migrate({ a: 1 }, spec), { data: { a: 1, b: 2, c: 20 }, from: 0, to: 3, changed: true, newer: false });
  assert.deepEqual(migrate({ schemaVersion: 2, b: 5 }, spec).data, { b: 5, c: 50 });
  assert.equal(migrate({ schemaVersion: 3, x: 1 }, spec).changed, false);
  const newer = migrate({ schemaVersion: 9, future: true }, spec);
  assert.equal(newer.newer, true);
  assert.deepEqual(newer.data, { future: true });
  assert.equal(schemaVersionOf({ schemaVersion: '2' }), 0);
  assert.equal(schemaVersionOf({ schemaVersion: -1 }), 0);
});

/** @param {Partial<import('../lib/storage-doc').DocSpec>} [extra] */
function testDoc(extra = {}) {
  return createJsonDoc({
    name: `doc-${Math.random().toString(36).slice(2)}.json`,
    label: 'тестовый файл',
    version: 2,
    defaults: () => ({ items: [] }),
    migrations: { 1: (d) => ({ items: d.list || [] }), 2: (d) => ({ ...d, items: d.items.map(String) }) },
    ...extra,
  });
}

test('files are written with schemaVersion, read back without it', () => {
  const root = freshDataRoot();
  const doc = testDoc();
  doc.write({ items: ['a'] });
  assert.deepEqual(readRaw(root, doc.spec.name), { schemaVersion: 2, items: ['a'] });
  assert.deepEqual(doc.read(), { items: ['a'] });
  // A stray schemaVersion in the data cannot override the real one.
  doc.write({ items: [], schemaVersion: 99 });
  assert.equal(readRaw(root, doc.spec.name).schemaVersion, 2);
});

test('an old file is copied to <name>.v0.bak, migrated and saved once', () => {
  const root = freshDataRoot();
  const doc = testDoc();
  writeRaw(root, doc.spec.name, { list: [1, 2] });
  assert.deepEqual(doc.read(), { items: ['1', '2'] });
  assert.deepEqual(readRaw(root, `${doc.spec.name}.v0.bak`), { list: [1, 2] });
  assert.deepEqual(readRaw(root, doc.spec.name), { schemaVersion: 2, items: ['1', '2'] });
  assert.ok(kinds().includes('migrated'));
  // Second read: nothing left to migrate, the pre-migration copy is kept as is.
  doc.read();
  assert.deepEqual(readRaw(root, `${doc.spec.name}.v0.bak`), { list: [1, 2] });
});

test('a file from a newer version is copied aside before anything can overwrite it', () => {
  const root = freshDataRoot();
  const doc = testDoc();
  writeRaw(root, doc.spec.name, { schemaVersion: 7, items: ['x'], futureField: 1 });
  assert.deepEqual(doc.read(), { items: ['x'], futureField: 1 });
  assert.deepEqual(readRaw(root, `${doc.spec.name}.v7.bak`).futureField, 1);
  const issue = getStorageIssues().find((i) => i.kind === 'newer-version');
  assert.match(issue.message, /более новой версией/);
});

test('corrupt file: quarantined, restored from the last good copy, user is told', () => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  doc.write({ items: ['good'] });
  assert.deepEqual(readRaw(root, `${doc.spec.name}.bak`).items, ['good']);
  // Power cut / disk error: zero bytes or garbage.
  writeRaw(root, doc.spec.name, '\u0000\u0000\u0000');
  assert.deepEqual(doc.read(), { items: ['good'] });
  assert.deepEqual(readRaw(root, doc.spec.name).items, ['good'], 'main file rewritten from .bak');
  assert.ok(names(root).some((n) => n.startsWith(`${doc.spec.name}.corrupt-`)));
  const issue = getStorageIssues().find((i) => i.kind === 'restored-from-backup');
  assert.match(issue.message, /восстановлен из последней хорошей копии/);
});

test('corrupt file and corrupt .bak: both quarantined, defaults, reported as error', () => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  writeRaw(root, doc.spec.name, '{"items": [');
  writeRaw(root, `${doc.spec.name}.bak`, '[]');
  assert.deepEqual(doc.read(), { items: [] });
  assert.equal(names(root).filter((n) => n.includes('.corrupt-')).length, 2);
  const issue = getStorageIssues().find((i) => i.kind === 'reset-corrupt');
  assert.equal(issue.level, 'error');
});

test('a missing file means defaults, even when a .bak exists (deleting the file resets it)', () => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  doc.write({ items: ['x'] });
  fs.unlinkSync(path.join(root, doc.spec.name));
  assert.deepEqual(doc.read(), { items: [] });
});

test('encrypted doc: ciphertext on disk; memory-only without safeStorage; locked file left alone', () => {
  const root = freshDataRoot();
  const doc = testDoc({ encrypt: true });
  doc.write({ items: ['secret title'] });
  const raw = fs.readFileSync(path.join(root, doc.spec.name), 'utf8');
  assert.equal(raw.includes('secret title'), false);
  assert.equal(JSON.parse(raw).schemaVersion, 2);
  assert.deepEqual(doc.read(), { items: ['secret title'] });

  freshDataRoot({ safeStorage: null });
  const memDoc = testDoc({ encrypt: true });
  assert.equal(memDoc.write({ items: ['x'] }), 'memory');
  assert.equal(fs.existsSync(memDoc.file()), false);
  assert.deepEqual(memDoc.read(), { items: ['x'] });
  assert.equal(memDoc.info().memoryOnly, true);

  // Encrypted on a previous run, safeStorage missing now: never overwritten or quarantined.
  const root2 = freshDataRoot();
  const lockedDoc = testDoc({ encrypt: true });
  lockedDoc.write({ items: ['keep me'] });
  const before = fs.readFileSync(lockedDoc.file(), 'utf8');
  require('../lib/config').setSafeStorageForTests(null);
  assert.deepEqual(lockedDoc.read(), { items: [] });
  assert.equal(fs.readFileSync(lockedDoc.file(), 'utf8'), before);
  assert.equal(names(root2).length, 1);
  assert.ok(kinds().includes('locked'));
});

test('encrypted doc never gets a plaintext pre-migration copy', () => {
  const root = freshDataRoot();
  const doc = testDoc({ encrypt: true });
  writeRaw(root, doc.spec.name, { list: ['private'] });
  assert.deepEqual(doc.read(), { items: ['private'] });
  assert.deepEqual(names(root), [doc.spec.name]);
  assert.equal(fs.readFileSync(doc.file(), 'utf8').includes('private'), false);
});

test('writeSoon coalesces bursts into one write; flush writes immediately', () => {
  const root = freshDataRoot();
  const doc = testDoc({ debounceMs: 60_000 });
  doc.writeSoon({ items: ['1'] });
  doc.writeSoon({ items: ['2'] });
  assert.equal(fs.existsSync(path.join(root, doc.spec.name)), false, 'nothing on the caller path');
  assert.deepEqual(doc.read(), { items: ['2'] }, 'reads see pending data');
  flushAllDocs();
  assert.deepEqual(readRaw(root, doc.spec.name).items, ['2']);
  assert.equal(doc.info().pendingWrite, false);
});

test('a failed write throws and is reported to the user', () => {
  const root = freshDataRoot();
  const doc = testDoc();
  fs.mkdirSync(path.join(root, doc.spec.name)); // a folder where the file should be
  assert.throws(() => doc.write({ items: [] }));
  assert.ok(getStorageIssues().some((i) => i.kind === 'write-failed' && i.level === 'error'));
});

test('settings.json: legacy file without version migrates and keeps every value', () => {
  const root = freshDataRoot();
  writeRaw(root, 'settings.json', { theme: 'light', size: 'compact', autostart: true, pos: { x: 10, y: 20 }, bgOpacity: 0.5 });
  const s = settingsStore.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.size, 'compact');
  assert.equal(s.autostart, true);
  assert.deepEqual(s.pos, { x: 10, y: 20 });
  assert.equal(s.bgOpacity, 0.5);
  assert.equal(readRaw(root, 'settings.json').schemaVersion, 1);
  assert.ok(fs.existsSync(path.join(root, 'settings.json.v0.bak')));
  assert.ok(fs.existsSync(path.join(root, 'settings.json.bak')), 'last good copy written with the migration');
});

test('settings.json: corrupt file is restored from settings.json.bak', () => {
  const root = freshDataRoot();
  settingsStore.saveSettings({ theme: 'light', hideCompleted: true });
  writeRaw(root, 'settings.json', '{"theme": "li');
  settingsStore.resetSettingsCache();
  const s = settingsStore.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.hideCompleted, true);
});

test('reminders.json: legacy file migrates; today state survives', () => {
  const root = freshDataRoot();
  const { todayIso } = require('../lib/dates');
  writeRaw(root, 'reminders.json', { date: todayIso(), notifiedIds: ['a', 'a', 'b'] });
  assert.deepEqual(reminderStore.loadReminderState().notifiedIds, ['a', 'b']);
  assert.equal(readRaw(root, 'reminders.json').schemaVersion, 1);
  reminderStore.markNotified(['c']);
  assert.deepEqual(readRaw(root, 'reminders.json').notifiedIds, ['a', 'b', 'c']);
});

test('demo mode works on an empty profile and stores versioned mock-items.json', () => {
  const root = freshDataRoot();
  const { getMockPayload } = require('../lib/mock-data');
  const payload = getMockPayload({ tasksListName: 'Tasks', habitsListName: 'Habits', accentColor: '#C4122E' });
  assert.ok(payload.tasks.length > 0);
  assert.ok(payload.habits.some((h) => h.streak > 0), 'demo streaks were seeded');
  assert.equal(readRaw(root, 'mock-items.json').schemaVersion, 1);
});

test('a whole pre-versioning profile is brought to schema 1 at startup, data intact', () => {
  const root = freshDataRoot();
  const { todayIso } = require('../lib/dates');
  const legacy = {
    'settings.json': { theme: 'light', pos: { x: 1, y: 2 } },
    'streaks.json': { habits: { h: { dates: ['2026-10-01', '2026-10-02'] } } },
    'reminders.json': { date: todayIso(), notifiedIds: ['t'] },
    'mock-items.json': { tasks: [{ id: 'm1', title: 'Demo' }], habits: [] },
    'offline-cache.json': {
      mode: 'google',
      tasks: [{ id: 't', title: 'Личное' }],
      habits: [{ id: 'h', title: 'Бег', completedDates: ['2026-10-01'], streak: 2 }],
    },
  };
  for (const [name, value] of Object.entries(legacy)) writeRaw(root, name, value);
  require('../lib/storage-status'); // loads every store, as data-ipc does
  require('../lib/storage-doc').migrateAllDocs();

  for (const name of ['settings.json', 'streaks.json', 'reminders.json', 'mock-items.json']) {
    assert.equal(readRaw(root, name).schemaVersion, 1, name);
    assert.deepEqual(readRaw(root, `${name}.v0.bak`), legacy[name], `${name} pre-migration copy`);
  }
  const cacheText = fs.readFileSync(path.join(root, 'offline-cache.json'), 'utf8');
  assert.equal(JSON.parse(cacheText).schemaVersion, 1);
  assert.equal(cacheText.includes('Личное'), false, 'cache encrypted by the migration');
  assert.equal(fs.existsSync(path.join(root, 'offline-cache.json.v0.bak')), false, 'no plaintext copy of personal data');
  const cache = require('../lib/offline-cache');
  cache.resetOfflineCacheMemory();
  assert.deepEqual(cache.loadOfflineCache().habits, [{ id: 'h', title: 'Бег' }]);
  assert.deepEqual(settingsStore.loadSettings().pos, { x: 1, y: 2 });
  assert.deepEqual(require('../lib/streak-store').loadStore().habits.h.dates, ['2026-10-01', '2026-10-02']);
});

test('a file that could not be read is copied aside before its first overwrite', (t) => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  writeRaw(root, doc.spec.name, { schemaVersion: 2, items: ['precious'] });
  const realRead = fs.readFileSync;
  const locked = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc.file()) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  assert.deepEqual(doc.read(), { items: [] }, 'no .bak yet: defaults, file untouched');
  assert.ok(getStorageIssues().some((i) => i.kind === 'unreadable' && i.level === 'error'));
  locked.mock.restore();

  doc.write({ items: ['new'] });
  const copy = names(root).find((n) => n.startsWith(`${doc.spec.name}.unread-`));
  assert.ok(copy, 'unread content preserved');
  assert.deepEqual(readRaw(root, copy).items, ['precious']);
  assert.deepEqual(readRaw(root, doc.spec.name).items, ['new']);
  // Only the first overwrite needs the copy.
  doc.write({ items: ['newer'] });
  assert.equal(names(root).filter((n) => n.includes('.unread-')).length, 1);
});

test('a file still locked at save time is not overwritten', () => {
  const root = freshDataRoot();
  const doc = testDoc();
  fs.mkdirSync(path.join(root, doc.spec.name)); // EISDIR: unreadable, and cannot be copied
  assert.deepEqual(doc.read(), { items: [] });
  assert.throws(() => doc.write({ items: ['x'] }), /still locked/);
  assert.ok(fs.statSync(path.join(root, doc.spec.name)).isDirectory());
});
