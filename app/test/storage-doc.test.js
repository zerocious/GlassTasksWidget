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

test('corrupt file whose restore cannot be saved (disk full): the next start restores again', (t) => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  doc.write({ items: ['good'] });
  writeRaw(root, doc.spec.name, '\u0000\u0000\u0000');
  const diskFull = () => Object.assign(new Error('no space'), { code: 'ENOSPC' });
  const realOpen = fs.openSync;
  const realCopy = fs.copyFileSync;
  const open = t.mock.method(fs, 'openSync', function (p, ...rest) {
    if (String(p).startsWith(doc.file())) throw diskFull();
    return realOpen.call(this, p, ...rest);
  });
  const copy = t.mock.method(fs, 'copyFileSync', function (...args) {
    if (String(args[0]).startsWith(doc.file())) throw diskFull();
    return realCopy.apply(this, args);
  });
  assert.deepEqual(doc.read(), { items: ['good'] }, 'this session works from the last good copy');
  assert.ok(kinds().includes('write-failed'));
  open.mock.restore();
  copy.mock.restore();
  assert.ok(fs.existsSync(doc.file()), 'the damaged file stays until a restore replaces it');
  assert.deepEqual(readRaw(root, `${doc.spec.name}.bak`).items, ['good']);

  // Next start, space freed: still damaged, so restored again instead of «missing → reset».
  assert.deepEqual(doc.read(), { items: ['good'] });
  assert.deepEqual(readRaw(root, doc.spec.name).items, ['good']);
  doc.write({ items: ['good', 'new'] });
  assert.deepEqual(readRaw(root, `${doc.spec.name}.bak`).items, ['good', 'new'], 'history kept by the first save');
});

test('corrupt file whose .bak is locked: not reset, the .bak is retried and never overwritten unread', (t) => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  doc.write({ items: ['good'] });
  writeRaw(root, doc.spec.name, '\u0000\u0000\u0000');
  const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
  const realRead = fs.readFileSync;
  const realCopy = fs.copyFileSync;
  const lockRead = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc.bakFile()) throw busy();
    return realRead.call(this, p, ...rest);
  });
  const lockCopy = t.mock.method(fs, 'copyFileSync', function (...args) {
    if (args[0] === doc.bakFile()) throw busy();
    return realCopy.apply(this, args);
  });
  const view = doc.read();
  assert.deepEqual(view, { items: [] });
  const issue = getStorageIssues().find((i) => i.kind === 'backup-unreadable');
  assert.equal(issue && issue.level, 'error');
  assert.match(issue.message, /перезапустите виджет/);
  assert.equal(kinds().includes('reset-corrupt'), false, 'the user is not told there is no good copy');
  assert.ok(fs.existsSync(doc.file()), 'damaged file kept in place: the next start retries the .bak');
  assert.ok(names(root).some((n) => n.startsWith(`${doc.spec.name}.corrupt-`)), 'and copied aside');
  // A save now would make the next start skip the .bak, which still cannot be copied: refused.
  assert.throws(() => doc.write({ ...view, items: ['today'] }), /still locked/);
  lockRead.mock.restore();
  lockCopy.mock.restore();
  assert.deepEqual(readRaw(root, `${doc.spec.name}.bak`).items, ['good']);

  // Lock gone: the owner saves what it has, and the last good copy is kept first.
  doc.write({ ...view, items: ['today'] });
  const kept = names(root).find((n) => n.startsWith(`${doc.spec.name}.unread-`));
  assert.ok(kept, 'last good copy preserved before its first overwrite');
  assert.deepEqual(readRaw(root, kept).items, ['good']);
  assert.ok(getStorageIssues().some((i) => i.kind === 'unread-preserved' && i.message.includes(kept)));

  // Restart without saving: the .bak is simply restored.
  const doc2 = testDoc({ lastGood: true });
  doc2.write({ items: ['history'] });
  writeRaw(root, doc2.spec.name, '{"items": [');
  const lock2 = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc2.bakFile()) throw busy();
    return realRead.call(this, p, ...rest);
  });
  assert.deepEqual(doc2.read(), { items: [] });
  lock2.mock.restore();
  assert.deepEqual(doc2.read(), { items: ['history'] }, 'next read: restored from the .bak');
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

test('settings.json edited by hand and saved with a UTF-8 BOM is read, not replaced by the .bak', () => {
  const root = freshDataRoot();
  settingsStore.saveSettings({ theme: 'light' }); // settings.json.bak: light, completed tasks shown
  const edited = { schemaVersion: 1, theme: 'light', hideCompleted: true };
  fs.writeFileSync(path.join(root, 'settings.json'), `\uFEFF${JSON.stringify(edited)}`, 'utf8');
  settingsStore.resetSettingsCache();
  assert.equal(settingsStore.loadSettings().hideCompleted, true, 'the hand edit is used');
  assert.equal(names(root).some((n) => n.includes('.corrupt-')), false);
  assert.equal(kinds().includes('restored-from-backup'), false);
  assert.equal(settingsStore.settingsDoc.info().schemaVersion, 1);
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

test('a file that stays locked is retried once, then read without blocking waits', (t) => {
  const root = freshDataRoot();
  const doc = testDoc();
  writeRaw(root, doc.spec.name, { schemaVersion: 2, items: ['x'] });
  const realRead = fs.readFileSync;
  let attempts = 0;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc.file()) {
      attempts += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }
    return realRead.call(this, p, ...rest);
  });
  let started = process.hrtime.bigint();
  doc.read();
  const firstMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(firstMs < 400, `first read blocked ${firstMs} ms`);
  const firstAttempts = attempts;
  started = process.hrtime.bigint();
  doc.read();
  doc.read();
  const laterMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(laterMs < 30, `later reads blocked ${laterMs} ms`);
  assert.equal(attempts, firstAttempts + 2, 'one attempt per later read');
});

test('encrypted doc: unread and corrupt copies of a plaintext legacy file are stored encrypted', (t) => {
  const root = freshDataRoot();
  const doc = testDoc({ encrypt: true });
  writeRaw(root, doc.spec.name, { list: ['Личная заметка'] }); // legacy plaintext, readable later
  const realRead = fs.readFileSync;
  const lock = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc.file()) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  doc.read();
  lock.mock.restore();
  doc.write({ items: ['new'] });
  const plainLeft = () =>
    names(root).filter((n) => fs.statSync(path.join(root, n)).isFile() && fs.readFileSync(path.join(root, n), 'utf8').includes('Личная'));
  assert.deepEqual(plainLeft(), [], 'no plaintext copy of the unread file');
  assert.ok(names(root).some((n) => n.includes('.unread-')));

  const doc2 = testDoc({ encrypt: true });
  writeRaw(root, doc2.spec.name, '{"list": ["Личная задача", '); // corrupt plaintext
  assert.deepEqual(doc2.read(), { items: [] });
  assert.deepEqual(plainLeft(), [], 'no plaintext quarantine copy');
  const quarantined = names(root).find((n) => n.startsWith(`${doc2.spec.name}.corrupt-`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, quarantined), 'utf8')).format, 'glass-tasks/safeStorage@1');
});

test('startup removes temp files left by a crash mid-write (they may hold old plaintext)', () => {
  const root = freshDataRoot();
  const stale = path.join(root, 'tokens.json.4242.1700000000000.tmp');
  const fresh = path.join(root, 'settings.json.4243.1700000000001.tmp');
  fs.writeFileSync(stale, '{"refresh_token":"1//old"}');
  fs.writeFileSync(fresh, '{}');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stale, hourAgo, hourAgo);
  require('../lib/storage-doc').migrateAllDocs();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'a write in progress is not touched');
});

test('a locked .bak gets retries too when the main file is locked at startup', (t) => {
  const root = freshDataRoot();
  const doc = testDoc({ lastGood: true });
  doc.write({ items: ['mine'] });
  const realRead = fs.readFileSync;
  let bakFailures = 2; // locked a little longer than one attempt
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === doc.file()) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    if (p === doc.bakFile() && bakFailures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  assert.deepEqual(doc.read(), { items: ['mine'] }, 'last good copy used, not defaults');
  assert.ok(fs.existsSync(path.join(root, doc.spec.name)));
});

test('lock lifted: a doc read before every write drops the guard, a cached one keeps it', (t) => {
  const root = freshDataRoot();
  const fresh = testDoc({ rereadsEveryTime: true });
  const cached = testDoc();
  for (const doc of [fresh, cached]) writeRaw(root, doc.spec.name, { schemaVersion: 2, items: ['real'] });
  const realRead = fs.readFileSync;
  const lock = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === fresh.file() || p === cached.file()) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  // A caching owner (settings, streaks) gets defaults here and keeps them in memory.
  const cachedView = cached.read();
  fresh.read();
  lock.mock.restore();
  assert.deepEqual(fresh.read(), { items: ['real'] });
  assert.deepEqual(cached.read(), { items: ['real'] }, 'e.g. migrateAllDocs re-reading later');

  fresh.write({ items: ['next'] });
  assert.equal(names(root).some((n) => n.startsWith(`${fresh.spec.name}.unread-`)), false, 'no spurious copy');

  cached.write(cachedView); // the owner saves what it has: the defaults
  const copy = names(root).find((n) => n.startsWith(`${cached.spec.name}.unread-`));
  assert.ok(copy, 'real content preserved before the defaults overwrite it');
  assert.deepEqual(readRaw(root, copy).items, ['real']);
});

test('a file locked only during the startup probe (migrateAllDocs) leaves no guard, copy or warning', (t) => {
  const root = freshDataRoot();
  const streaks = require('../lib/streak-store');
  writeRaw(root, 'streaks.json', { schemaVersion: 1, ...streaks.encodeStore({ habits: { h: { dates: ['2026-10-01'] } } }) });
  const realRead = fs.readFileSync;
  const lock = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).startsWith(path.join(root, 'streaks.json'))) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  require('../lib/storage-doc').migrateAllDocs(); // at startup it runs before the streak store loads
  lock.mock.restore();
  assert.deepEqual(streaks.loadStore().habits.h.dates, ['2026-10-01'], 'the owner reads the real history');
  streaks.markCompleted('h', '2026-10-02');
  assert.equal(names(root).some((n) => n.includes('.unread-')), false, 'no spurious copy to «restore manually»');
  assert.equal(kinds().includes('unreadable'), false, 'no «defaults are used» warning');
  assert.deepEqual(streaks.decodeStore(readRaw(root, 'streaks.json')).habits.h.dates, ['2026-10-01', '2026-10-02']);

  // Damaged file and a .bak locked only during the probe: the owner's read restores it.
  streaks.resetStreakCache();
  writeRaw(root, 'streaks.json', '{"habits": {');
  const lockBak = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === streaks.streaksDoc.bakFile()) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRead.call(this, p, ...rest);
  });
  require('../lib/storage-doc').migrateAllDocs();
  lockBak.mock.restore();
  assert.equal(kinds().includes('backup-unreadable'), false);
  assert.deepEqual(streaks.loadStore().habits.h.dates, ['2026-10-01', '2026-10-02']);
  assert.equal(names(root).filter((n) => n.includes('.corrupt-')).length, 1);
});

test('encrypted doc copies: an existing envelope (any key order) is not wrapped twice; encryption errors never escape read()', () => {
  const root = freshDataRoot();
  const doc = testDoc({ encrypt: true });
  doc.write({ items: ['a'] });
  const env = JSON.parse(fs.readFileSync(doc.file(), 'utf8'));
  // A newer app version wrote the envelope with another key order and a higher schema.
  fs.writeFileSync(doc.file(), JSON.stringify({ data: env.data, schemaVersion: 2, format: env.format }, null, 2));
  const inner = JSON.parse(Buffer.from(Buffer.from(env.data, 'base64').toString('utf8').slice(4), 'base64').toString('utf8'));
  inner.schemaVersion = 9;
  fs.writeFileSync(
    doc.file(),
    JSON.stringify({ data: `${Buffer.from(`enc:${Buffer.from(JSON.stringify(inner)).toString('base64')}`).toString('base64')}`, format: env.format })
  );
  doc.read();
  const copy = names(root).find((n) => n.includes('.v9.bak'));
  const copied = JSON.parse(fs.readFileSync(path.join(root, copy), 'utf8'));
  assert.equal(copied.format, env.format);
  assert.equal(copied.schemaVersion, undefined, 'kept as written, not re-wrapped');

  const doc2 = testDoc({ encrypt: true });
  writeRaw(root, doc2.spec.name, '{"broken": ');
  require('../lib/config').setSafeStorageForTests({
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error('DPAPI failure');
    },
    decryptString: () => '',
  });
  assert.doesNotThrow(() => doc2.read());
});

test('startup removes quarantined secret copies left by older versions (possibly plaintext)', () => {
  const root = freshDataRoot();
  for (const name of ['tokens.json.corrupt-1700000000000', 'credentials.json.corrupt-1700000000001']) {
    fs.writeFileSync(path.join(root, name), '{"refresh_token": "1//0gCutOff');
  }
  fs.writeFileSync(path.join(root, 'streaks.json.corrupt-1700000000002'), 'kept: may hold history');
  require('../lib/storage-doc').migrateAllDocs();
  assert.deepEqual(names(root).filter((n) => n.includes('.corrupt-')), ['streaks.json.corrupt-1700000000002']);
});
