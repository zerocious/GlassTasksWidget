'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cache = require('../lib/offline-cache');
const { flushAllDocs } = require('../lib/storage-doc');
const { getStorageIssues } = require('../lib/storage-events');
const { freshDataRoot, writeRaw } = require('./helpers/storage');

const payload = (title = 'Позвонить врачу') => ({
  mode: 'google',
  tasksListName: 'Tasks',
  habitsListName: 'Habits',
  tasks: [{ id: 't1', title, notes: 'анализы в 9:00' }],
  habits: [{ id: 'h1', title: 'Бег', streak: 5, week: [true], ring: 14, completedToday: true, completedDates: ['2026-10-01'] }],
});

const fileText = (root) => fs.readFileSync(path.join(root, 'offline-cache.json'), 'utf8');

test('task titles and notes are encrypted on disk and never written on the mutation path', () => {
  const root = freshDataRoot();
  cache.saveOfflineCache(payload());
  assert.equal(fs.existsSync(path.join(root, 'offline-cache.json')), false, 'debounced, not written yet');
  cache.patchOfflineCache('tasks', 't1', { title: 'Позвонить врачу завтра' });
  flushAllDocs();
  const text = fileText(root);
  assert.equal(text.includes('врач'), false);
  assert.equal(JSON.parse(text).format, 'glass-tasks/safeStorage@1');
  assert.equal(JSON.parse(text).schemaVersion, 1);

  cache.resetOfflineCacheMemory();
  const loaded = cache.loadOfflineCache();
  assert.equal(loaded.tasks[0].title, 'Позвонить врачу завтра');
});

test('derived habit stats are not copied into the cache (streaks.json is the source)', () => {
  freshDataRoot();
  cache.saveOfflineCache(payload());
  flushAllDocs();
  cache.resetOfflineCacheMemory();
  const habit = cache.loadOfflineCache().habits[0];
  assert.deepEqual(habit, { id: 'h1', title: 'Бег' });
});

test('legacy plaintext cache is read and immediately re-saved encrypted', () => {
  const root = freshDataRoot();
  writeRaw(root, 'offline-cache.json', { savedAt: 'x', ...payload('Старый кэш') });
  assert.equal(cache.loadOfflineCache().tasks[0].title, 'Старый кэш');
  assert.equal(fileText(root).includes('Старый кэш'), false);
  assert.deepEqual(fs.readdirSync(root), ['offline-cache.json'], 'no plaintext copy left behind');
});

test('without safeStorage the cache stays in memory and nothing personal reaches the disk', () => {
  const root = freshDataRoot({ safeStorage: null });
  cache.saveOfflineCache(payload());
  flushAllDocs();
  assert.equal(fs.existsSync(path.join(root, 'offline-cache.json')), false);
  assert.equal(cache.loadOfflineCache().tasks[0].title, 'Позвонить врачу');
  assert.ok(getStorageIssues().some((i) => i.kind === 'memory-only' && i.file === 'offline-cache.json'));
});

test('clear cancels a pending write (logout must not resurrect the old account)', () => {
  const root = freshDataRoot();
  cache.saveOfflineCache(payload());
  cache.clearOfflineCache();
  flushAllDocs();
  assert.equal(fs.existsSync(path.join(root, 'offline-cache.json')), false);
  assert.equal(cache.loadOfflineCache(), null);
});
