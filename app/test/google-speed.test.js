'use strict';

/**
 * How many Google round trips a load waits for (one round = calls in flight together), and that
 * the shortcuts behind it still give the right data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { signedInWith, serverItem, server, startRounds } = require('./helpers/fake-google');
const gt = require('../lib/google-tasks');
const { flushAllDocs } = require('../lib/storage-doc');
const { resetOfflineCacheMemory } = require('../lib/offline-cache');

const pos = (n) => String(n).padStart(20, '0');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test('the first load of the day waits for two rounds, the habit reset runs behind it', async () => {
  signedInWith({
    tasks: [{ id: 'T1', title: 'Открытая', status: 'needsAction', position: pos(1) }],
    habits: Array.from({ length: 8 }, (_, i) => ({
      id: `H${i}`, title: `Привычка ${i}`, status: 'completed', completed: daysAgo(1), position: pos(i),
    })),
  });

  const data = await gt.getWidgetData({ force: true });
  const rounds = server.maxDepth;
  await gt.whenIdle();

  assert.ok(data.tasks.some((t) => t.id === 'T1'));
  assert.ok(rounds <= 2, `waited for ${rounds} rounds`);
  for (let i = 0; i < 8; i += 1) assert.equal(serverItem('habits', `H${i}`).status, 'needsAction');
});

test('a refresh that re-reads the list names still takes one round', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Открытая', status: 'needsAction', position: pos(1) }] });
  await gt.getWidgetData({ force: true });
  serverItem('tasks', 'T1').title = 'Изменено на телефоне';
  startRounds();

  const data = await gt.getWidgetData({ force: true, lists: true });

  assert.equal(data.tasks.find((t) => t.id === 'T1').title, 'Изменено на телефоне');
  assert.equal(server.maxDepth, 1);
});

test('a list replaced in Google (same name, new id) is picked up on refresh', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Старый список', status: 'needsAction', position: pos(1) }] });
  await gt.getWidgetData({ force: true });
  // The «Tasks» list was deleted and created again: same title, another id.
  server.listIds.tasks = 'L-tasks-2';
  server.lists['L-tasks-2'] = [{ id: 'N1', title: 'Новый список', status: 'needsAction', position: pos(1) }];
  delete server.lists['L-tasks'];

  const data = await gt.getWidgetData({ force: true, lists: true });

  assert.deepEqual(data.tasks.map((t) => t.id), ['N1']);
});

test('list ids remembered from the last run save the list-of-lists round', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Открытая', status: 'needsAction', position: pos(1) }] });
  await gt.getWidgetData({ force: true });
  flushAllDocs();
  // A new run: nothing in memory, the offline cache on disk.
  gt.invalidateListCache();
  gt.invalidatePayloadCache();
  resetOfflineCacheMemory();
  startRounds();

  const data = await gt.getWidgetData({ force: true });

  assert.ok(data.tasks.some((t) => t.id === 'T1'));
  assert.equal(server.maxDepth, 1);
});

test('the most recent completed tasks need no extra round', async () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    id: `R${i}`, title: `Неделя ${i}`, status: 'completed', completed: daysAgo(1 + i), position: pos(10 + i),
  }));
  const older = Array.from({ length: 150 }, (_, i) => ({
    id: `M${i}`, title: `Раньше ${i}`, status: 'completed', completed: daysAgo(9 + (i % 20)), position: pos(30 + i),
  }));
  signedInWith({ tasks: [...older, ...recent, { id: 'T1', title: 'Открытая', status: 'needsAction', position: pos(1) }] });

  const data = await gt.getWidgetData({ force: true });

  assert.deepEqual(data.tasks.filter((t) => t.completed).map((t) => t.id).sort(), ['R0', 'R1', 'R2', 'R3', 'R4']);
  assert.ok(server.maxDepth <= 2, `waited for ${server.maxDepth} rounds`);
});

test('a quiet week widens the completed window so older ones still show', async () => {
  signedInWith({
    tasks: [
      { id: 'W1', title: 'Вчера', status: 'completed', completed: daysAgo(1), position: pos(1) },
      { id: 'M1', title: 'Три недели назад', status: 'completed', completed: daysAgo(20), position: pos(2) },
    ],
  });

  const data = await gt.getWidgetData({ force: true });

  assert.deepEqual(data.tasks.filter((t) => t.completed).map((t) => t.id).sort(), ['M1', 'W1']);
});

test('the last run\'s tasks are available at start without a single Google call', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Из прошлого запуска', status: 'needsAction', position: pos(1) }] });
  await gt.getWidgetData({ force: true });
  flushAllDocs();
  gt.invalidateListCache();
  gt.invalidatePayloadCache();
  resetOfflineCacheMemory();
  server.calls = [];

  const quick = gt.getQuickWidgetData();

  assert.equal(server.calls.length, 0);
  assert.equal(quick.stale, true);
  assert.equal(quick.offline, false);
  assert.ok(!quick.warning);
  assert.ok(quick.tasks.some((t) => t.id === 'T1'));
});

test('nothing is shown from the cache when no one is signed in', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Чужое', status: 'needsAction', position: pos(1) }] });
  await gt.getWidgetData({ force: true });
  gt.invalidatePayloadCache();
  require('../lib/google-auth').clearTokens();

  assert.equal(gt.getQuickWidgetData(), null);
});
