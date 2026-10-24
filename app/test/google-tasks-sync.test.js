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
const { todayIso, addDaysIso } = require('../lib/dates');
const { nextOccurrenceDue, applyDueTimeToNotes, applyRecurrenceToNotes } = require('../lib/task-parse');

const dueOn = (key) => `${key}T00:00:00.000Z`;
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

test("habits and tasks completed in Google's own apps (hidden) still reach the widget", async () => {
  const { fake } = freshGoogle();
  const now = new Date().toISOString();
  fake.setItems('L-habits', [{ id: 'H1', title: 'Чтение', status: 'completed', completed: now, hidden: true }]);
  fake.setItems('L-tasks', [
    { id: 'T1', title: 'Открытая' },
    { id: 'T2', title: 'Сделана на телефоне', status: 'completed', completed: now, hidden: true },
  ]);

  const data = await gt.getWidgetData({ force: true });
  assert.deepEqual(data.habits.map((h) => h.id), ['H1']);
  assert.ok(data.tasks.some((t) => t.id === 'T2' && t.completed), 'listed in the done section');
});

test('setting a time or a repeat keeps notes edited on the phone after the last sync', async () => {
  const { fake } = freshGoogle();
  fake.setItems('L-tasks', [{ id: 'T1', title: 'Магазин', notes: 'купить молоко' }]);
  await gt.getWidgetData({ force: true });

  fake.item('L-tasks', 'T1').notes = 'купить молоко и хлеб';
  const timed = await gt.updateItem('tasks', 'T1', { dueTime: '09:00' });
  assert.equal(fake.item('L-tasks', 'T1').notes, 'время 09:00\nкупить молоко и хлеб');
  assert.equal(timed.item.dueTime, '09:00');

  fake.item('L-tasks', 'T1').notes += '\nи яйца';
  await gt.updateItem('tasks', 'T1', { recurrence: 'daily' });
  assert.equal(
    fake.item('L-tasks', 'T1').notes,
    applyRecurrenceToNotes(applyDueTimeToNotes('купить молоко и хлеб\nи яйца', '09:00'), 'daily')
  );
});

test('completing a recurring task uses the date and the rule Google has now', async () => {
  const { fake } = freshGoogle();
  const today = todayIso();
  const repeat = applyRecurrenceToNotes('', 'daily');
  fake.setItems('L-tasks', [
    { id: 'R1', title: 'Полить цветы', notes: repeat, due: dueOn(today) },
    { id: 'R2', title: 'Отчёт', notes: repeat, due: dueOn(today) },
  ]);
  await gt.getWidgetData({ force: true });

  const moved = dueOn(addDaysIso(today, 5));
  fake.item('L-tasks', 'R1').due = moved; // moved on the phone
  fake.item('L-tasks', 'R2').notes = ''; // repeat removed on the phone

  const r1 = await gt.setTaskCompleted('tasks', 'R1', true);
  assert.equal(r1.rescheduled, true);
  assert.equal(fake.item('L-tasks', 'R1').due, nextOccurrenceDue(moved, 'daily'));

  const r2 = await gt.setTaskCompleted('tasks', 'R2', true);
  assert.equal(r2.rescheduled, false);
  assert.equal(fake.item('L-tasks', 'R2').status, 'completed');
  assert.equal(fake.item('L-tasks', 'R2').due, dueOn(today));
});

test('a time line never cuts the end off long notes', async () => {
  const { fake } = freshGoogle();
  const widgetMax = `${'а'.repeat(7995)}КОНЕЦ`; // 8000: the most the notes editor accepts
  const googleMax = 'б'.repeat(8190);
  fake.setItems('L-tasks', [
    { id: 'T1', title: 'Длинная', notes: widgetMax },
    { id: 'T2', title: 'С телефона', notes: googleMax },
  ]);
  await gt.getWidgetData({ force: true });

  await gt.updateItem('tasks', 'T1', { dueTime: '10:00' });
  assert.equal(fake.item('L-tasks', 'T1').notes, `время 10:00\n${widgetMax}`);

  await assert.rejects(gt.updateItem('tasks', 'T2', { dueTime: '10:00' }), /слишком длинные/);
  assert.equal(fake.item('L-tasks', 'T2').notes, googleMax, 'nothing was written');
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
