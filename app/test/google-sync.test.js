'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signedInWith, serverItem, server } = require('./helpers/fake-google');
const gt = require('../lib/google-tasks');
const { todayIso } = require('../lib/dates');

/** Noon of the local day `offset` days from today, as Google writes `completed`. */
function localNoon(offset) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 12, 0, 0).toISOString();
}

test('the daily habit reset keeps a habit completed today on another device', async () => {
  signedInWith({
    habits: [
      { id: 'phone', title: 'Зарядка', status: 'completed', completed: new Date().toISOString() },
      { id: 'stale', title: 'Чтение', status: 'completed', completed: localNoon(-1) },
    ],
  });

  const result = await gt.resetCompletedHabitsForNewDay();

  assert.equal(result.reset, true);
  assert.equal(serverItem('habits', 'phone').status, 'completed');
  assert.equal(serverItem('habits', 'stale').status, 'needsAction');
});

test('setting a time keeps notes edited elsewhere since the last sync', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Позвонить', status: 'needsAction', notes: 'номер: 123' }] });
  await gt.getWidgetData({ force: true });
  serverItem('tasks', 'T1').notes = 'номер: 123\nперезвонить после обеда';

  await gt.updateItem('tasks', 'T1', { dueTime: '15:00' });

  assert.equal(serverItem('tasks', 'T1').notes, 'время 15:00\nномер: 123\nперезвонить после обеда');
});

test('setting a repeat keeps notes edited elsewhere since the last sync', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Полить цветы', status: 'needsAction', notes: 'фикус' }] });
  await gt.getWidgetData({ force: true });
  serverItem('tasks', 'T1').notes = 'фикус и кактус';

  await gt.updateItem('tasks', 'T1', { recurrence: 'weekly' });

  assert.equal(serverItem('tasks', 'T1').notes, 'повтор: еженедельно\nфикус и кактус');
});

test('the completed section shows the most recently completed tasks', async () => {
  const pos = (n) => String(n).padStart(20, '0');
  const old = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `old${n}`, title: `Старая ${n}`, status: 'completed', completed: localNoon(-30 + n), position: pos(n),
  }));
  signedInWith({
    tasks: [
      ...old,
      { id: 'just', title: 'Только что', status: 'completed', completed: new Date().toISOString(), position: pos(9) },
      { id: 'open', title: 'Открытая', status: 'needsAction', position: pos(0) },
    ],
  });

  const data = await gt.getWidgetData({ force: true });
  const done = data.tasks.filter((t) => t.completed).map((t) => t.id);

  assert.equal(done.length, 5);
  assert.ok(done.includes('just'), done.join(', '));
  assert.ok(!done.includes('old1') && !done.includes('old2'), done.join(', '));
});

test('a task completed in the widget stays in the completed section, cached and reloaded', async () => {
  const pos = (n) => String(n).padStart(20, '0');
  signedInWith({
    tasks: [
      ...[1, 2, 3, 4, 5].map((n) => ({
        id: `old${n}`, title: `Старая ${n}`, status: 'completed', completed: localNoon(-30 + n), position: pos(n),
      })),
      { id: 'T9', title: 'Последняя', status: 'needsAction', position: pos(9) },
    ],
  });
  await gt.getWidgetData({ force: true });

  await gt.setTaskCompleted('tasks', 'T9', true);
  const cached = await gt.getWidgetData();
  const reloaded = await gt.getWidgetData({ force: true });

  assert.ok(cached.tasks.some((t) => t.id === 'T9' && t.completed), 'from the warm cache');
  assert.ok(reloaded.tasks.some((t) => t.id === 'T9' && t.completed), 'from Google');
});

test('a habit completed today on another device counts as done here', async () => {
  signedInWith({
    habits: [{ id: 'H1', title: 'Зарядка', status: 'completed', completed: new Date().toISOString() }],
  });

  const data = await gt.getWidgetData({ force: true });
  const habit = data.habits.find((h) => h.id === 'H1');

  assert.equal(habit.completed, true);
  assert.equal(habit.streak, 1);
});

test('a habit unchecked on another device today is no longer done here', async () => {
  signedInWith({ habits: [{ id: 'H1', title: 'Зарядка', status: 'needsAction' }] });
  await gt.getWidgetData({ force: true });
  await gt.setTaskCompleted('habits', 'H1', true);
  Object.assign(serverItem('habits', 'H1'), { status: 'needsAction', completed: null });

  const data = await gt.getWidgetData({ force: true });

  assert.equal(data.habits.find((h) => h.id === 'H1').completed, false);
});

test('yesterday\'s completion from another device stays in the history after the reset', async () => {
  const yesterday = localNoon(-1);
  signedInWith({ habits: [{ id: 'H1', title: 'Зарядка', status: 'completed', completed: yesterday }] });

  const data = await gt.getWidgetData({ force: true });
  const habit = data.habits.find((h) => h.id === 'H1');

  assert.equal(serverItem('habits', 'H1').status, 'needsAction');
  assert.equal(habit.completed, false);
  assert.ok(habit.completedDates.includes(todayIso(new Date(yesterday))), habit.completedDates.join(','));
  assert.equal(habit.streak, 1);
});

test('a delete whose response was lost still succeeds', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Удалить меня', status: 'needsAction' }] });
  await gt.getWidgetData({ force: true });
  server.loseResponse = 'tasks.delete';

  const result = await gt.deleteItem('tasks', 'T1');
  const data = await gt.getWidgetData();

  assert.equal(result.ok, true);
  assert.equal(serverItem('tasks', 'T1'), null);
  assert.ok(!data.tasks.some((t) => t.id === 'T1'));
});

test('deleting a task already deleted on another device succeeds', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'Удалить меня', status: 'needsAction' }] });
  await gt.getWidgetData({ force: true });
  server.lists['L-tasks'].length = 0;

  const result = await gt.deleteItem('tasks', 'T1');
  const data = await gt.getWidgetData();

  assert.equal(result.ok, true);
  assert.ok(!data.tasks.some((t) => t.id === 'T1'));
});
