'use strict';

/**
 * Google mode end to end against an in-memory Tasks API (test/helpers/fake-google.js):
 * caches, edits made on other devices, logout races, day boundaries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { freshGoogle, session, deferred } = require('./helpers/fake-google');
const gt = require('../lib/google-tasks');
const { loadOfflineCache } = require('../lib/offline-cache');
const { getHabitStats } = require('../lib/streak-store');
const { flushAllDocs } = require('../lib/storage-doc');
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

test('the Tasks list adds only recent hidden completions, not the whole hidden history', async () => {
  const { fake } = freshGoogle();
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  // Years of phone completions and «clear completed» (all hidden), well past the page cap.
  const history = Array.from({ length: 2100 }, (_, n) => ({
    id: `old-${n}`,
    title: `Давно ${n}`,
    status: 'completed',
    completed: daysAgo(60),
    hidden: true,
  }));
  fake.setItems('L-tasks', [
    ...history,
    { id: 'T1', title: 'Открытая', notes: 'время 18:00', due: dueOn(todayIso()) },
    { id: 'T2', title: 'Сделана на телефоне вчера', status: 'completed', completed: daysAgo(1), hidden: true },
    { id: 'T3', title: 'Сделана в виджете давно', status: 'completed', completed: daysAgo(60) },
  ]);
  fake.setItems('L-habits', [
    { id: 'H1', title: 'Чтение', status: 'completed', completed: daysAgo(3), hidden: true },
  ]);

  const data = await gt.getWidgetData({ force: true });
  assert.deepEqual(data.tasks.map((t) => t.id).sort(), ['T1', 'T2', 'T3'], 'the open task is not cut off');
  assert.deepEqual(data.habits.map((h) => h.id), ['H1'], 'Habits still list every hidden item');
  const taskCalls = fake.calls.filter((c) => c.method === 'tasks.list' && c.params.tasklist === 'L-tasks');
  assert.ok(taskCalls.length <= 3, `${taskCalls.length} requests for the Tasks list`);
});

test('drag and drop works around items Google keeps hidden (ticked in its own apps)', async () => {
  const { fake } = freshGoogle();
  const now = new Date().toISOString();
  const moves = () => fake.calls.filter((c) => c.method === 'tasks.move').length;
  fake.setItems('L-habits', [
    { id: 'H0', title: 'Зарядка' },
    { id: 'H1', title: 'Чтение', status: 'completed', completed: now, hidden: true },
    { id: 'H2', title: 'Вода' },
    { id: 'H3', title: 'Бег' },
  ]);
  await gt.getWidgetData({ force: true });
  const { habits } = await gt.getWidgetData(); // warm cache, as most drags see it
  assert.equal(habits.find((h) => h.id === 'H1').completed, false, 'open here: no tick in the widget today');

  // H3 dropped right below H1: Google refuses a hidden `previous`, so the widget skips it.
  await gt.moveItem('habits', 'H3', 'H1', ['H0', 'H1', 'H3', 'H2']);
  assert.deepEqual(fake.items('L-habits').map((i) => i.id), ['H0', 'H3', 'H1', 'H2']);

  // H1 itself could only go first at the top level: refused with a reason, nothing sent.
  const before = moves();
  await assert.rejects(
    gt.moveItem('habits', 'H1', 'H2', ['H0', 'H3', 'H2', 'H1']),
    /выполненным в Google Задачах/
  );
  assert.equal(moves(), before);

  // Un-ticked on the phone since the last sync: the widget checks with Google and moves it.
  Object.assign(fake.item('L-habits', 'H1'), { status: 'needsAction', completed: null, hidden: false });
  await gt.moveItem('habits', 'H1', 'H2', ['H0', 'H3', 'H2', 'H1']);
  assert.deepEqual(fake.items('L-habits').map((i) => i.id), ['H0', 'H3', 'H2', 'H1']);
  // ...and the caches know it is visible now: H0 dropped right after it uses it as `previous`.
  await gt.moveItem('habits', 'H0', 'H1', ['H3', 'H2', 'H1', 'H0']);
  assert.deepEqual(fake.items('L-habits').map((i) => i.id), ['H3', 'H2', 'H1', 'H0']);

  // A task done on the phone and re-opened in the widget is visible again in Google: it is a
  // valid `previous` for the next drop.
  fake.setItems('L-tasks', [
    { id: 'T2', title: 'Сделана на телефоне', status: 'completed', completed: now, hidden: true },
    { id: 'T0', title: 'Первая' },
    { id: 'T1', title: 'Вторая' },
  ]);
  await gt.getWidgetData({ force: true });
  await gt.setTaskCompleted('tasks', 'T2', false);
  await gt.moveItem('tasks', 'T1', 'T2', ['T2', 'T1', 'T0']);
  assert.deepEqual(fake.items('L-tasks').map((i) => i.id), ['T2', 'T1', 'T0']);
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

test('a fetch still running at logout does not bring the old account back', async () => {
  const { root, fake } = freshGoogle();
  fake.setItems('L-tasks', [{ id: 'T1', title: 'Задача старого аккаунта' }]);
  const reached = deferred();
  const gate = deferred();
  fake.hooks['tasks.list'] = async () => {
    reached.resolve();
    await gate.promise;
  };

  const inFlight = gt.getWidgetData(); // e.g. a reminder check
  await reached.promise;
  // «Выйти» (electron/main.js): tokens gone, every cache cleared, then a forced reload.
  session.signedIn = false;
  gt.invalidateListCache();
  gt.invalidatePayloadCache();
  gt.clearOfflineCache();
  const afterLogout = gt.getWidgetData({ force: true });
  gate.resolve();

  const [stale, fresh] = await Promise.all([inFlight, afterLogout]);
  assert.equal(fresh.mode, 'needs_auth');
  assert.equal(stale.mode, 'needs_auth', 'the late reply is not served as signed-in data');
  assert.equal(loadOfflineCache(), null);
  flushAllDocs();
  assert.equal(fs.existsSync(path.join(root, 'offline-cache.json')), false);
  assert.equal((await gt.getWidgetData()).mode, 'needs_auth');
});

test('reopening a task cut from the «5 done» keeps it in the cached list (reminders read it)', async () => {
  const { fake } = freshGoogle();
  const now = new Date().toISOString();
  const done = [1, 2, 3, 4, 5].map((n) => ({ id: `D${n}`, title: `Готово ${n}`, status: 'completed', completed: now }));
  fake.setItems('L-tasks', [
    ...done,
    { id: 'X', title: 'Позвонить', notes: 'время 18:00', due: dueOn(todayIso()) },
    { id: 'O', title: 'Другая' },
  ]);
  await gt.getWidgetData({ force: true });
  const lists = () => fake.calls.filter((c) => c.method === 'tasks.list').length;
  const listsBefore = lists();

  await gt.setTaskCompleted('tasks', 'X', true);
  await gt.setTaskCompleted('tasks', 'X', false); // un-checked by mistake

  const data = await gt.getWidgetData(); // warm cache, as refreshExactReminders reads it
  assert.equal(lists(), listsBefore, 'served from the cache');
  const x = data.tasks.find((t) => t.id === 'X');
  assert.ok(x, 'X is listed again');
  assert.equal(x.completed, false);
  assert.equal(x.title, 'Позвонить');
  assert.equal(x.dueTime, '18:00');
  assert.deepEqual(data.tasks.filter((t) => !t.completed).map((t) => t.id), ['X', 'O']);
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
