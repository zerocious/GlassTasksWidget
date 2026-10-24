'use strict';

/**
 * Google mode end to end against an in-memory Tasks API (test/helpers/fake-google.js):
 * caches, edits made on other devices, logout races, day boundaries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshGoogle } = require('./helpers/fake-google');
const gt = require('../lib/google-tasks');
const { getHabitStats } = require('../lib/streak-store');

const childrenOf = (fake, parent) =>
  fake.items('L-tasks').filter((i) => i.parent === parent).map((i) => i.id);

test('a subtask dragged right after it was created keeps its parent', async () => {
  const { fake } = freshGoogle();
  fake.setItems('L-tasks', [
    { id: 'P', title: 'Проект' },
    { id: 'C1', title: 'Шаг 1', parent: 'P' },
  ]);
  await gt.getWidgetData({ force: true });
  const lists = () => fake.calls.filter((c) => c.method === 'tasks.list').length;
  const listsBefore = lists();

  const { item } = await gt.createItem('tasks', 'Шаг 2', { parentId: 'P' });
  assert.deepEqual(childrenOf(fake, 'P'), [item.id, 'C1'], 'Google puts a new subtask first');

  // The user drags it below its sibling before any refresh.
  await gt.moveItem('tasks', item.id, 'C1', ['P', 'C1', item.id]);
  assert.equal(fake.item('L-tasks', item.id).parent, 'P');
  assert.deepEqual(childrenOf(fake, 'P'), ['C1', item.id]);

  const cached = (await gt.getWidgetData()).tasks.map((t) => t.id);
  assert.equal(lists(), listsBefore, 'no refetch in between');
  assert.deepEqual(cached, ['P', 'C1', item.id], 'the cache holds the subtask, nested');
});

test('moving a subtask the caches do not know asks Google for its parent', async () => {
  const { fake } = freshGoogle();
  fake.setItems('L-tasks', [
    { id: 'P', title: 'Проект' },
    { id: 'C1', title: 'Шаг 1', parent: 'P' },
  ]);
  await gt.getWidgetData({ force: true });
  fake.addItem('L-tasks', { id: 'S', title: 'С телефона', parent: 'P' }, 'P');

  await gt.moveItem('tasks', 'S', 'C1', ['P', 'C1', 'S']);
  assert.equal(fake.item('L-tasks', 'S').parent, 'P');
  assert.deepEqual(childrenOf(fake, 'P'), ['C1', 'S']);
});

test('a late habits reset leaves habits already ticked today alone', async () => {
  const { fake } = freshGoogle({ habitsResetDone: false });
  const yesterdayNoon = new Date();
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  yesterdayNoon.setHours(12, 0, 0, 0);
  fake.setItems('L-habits', [
    { id: 'H1', title: 'Бег', status: 'completed', completed: yesterdayNoon.toISOString() },
    { id: 'H2', title: 'Чтение' },
    { id: 'H3', title: 'Вода', status: 'completed' },
  ]);

  // The midnight reset failed (no network) and waits for its retry; meanwhile the user ticks H2.
  await gt.setTaskCompleted('habits', 'H2', true);
  const result = await gt.resetCompletedHabitsForNewDay();

  assert.equal(result.reset, true);
  assert.equal(fake.item('L-habits', 'H1').status, 'needsAction', "yesterday's tick is cleared");
  assert.equal(fake.item('L-habits', 'H3').status, 'needsAction', 'no completion time: cleared as before');
  assert.equal(fake.item('L-habits', 'H2').status, 'completed', "today's tick stays in Google");
});

test('a habit ticked just before midnight counts for that day when Google answers after it', async (t) => {
  const { fake } = freshGoogle();
  fake.setItems('L-habits', [{ id: 'H1', title: 'Медитация' }]);
  const clickAt = new Date(2026, 9, 24, 23, 59, 59).getTime();
  const afterMidnight = new Date(2026, 9, 25, 0, 0, 1).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: clickAt });
  fake.hooks['tasks.patch'] = async () => {
    t.mock.timers.setTime(afterMidnight);
  };

  const result = await gt.setTaskCompleted('habits', 'H1', true);
  assert.deepEqual(getHabitStats('H1').completedDates, ['2026-10-24']);
  assert.equal(result.stats.completedToday, false, 'it is the next day now');
  assert.equal(fake.item('L-habits', 'H1').completed, new Date(clickAt).toISOString());
});
