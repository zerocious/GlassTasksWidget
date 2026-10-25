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

  await gt.getWidgetData({ force: true });
  await gt.whenIdle(); // the reset runs behind the load
  const data = await gt.getWidgetData();
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

test('a habit checked in Google\'s own app (a hidden item) stays listed and counts as done', async () => {
  signedInWith({
    habits: [
      { id: 'H1', title: 'Зарядка', status: 'completed', completed: new Date().toISOString(), hidden: true },
      { id: 'H2', title: 'Чтение', status: 'needsAction' },
    ],
  });

  const data = await gt.getWidgetData({ force: true });
  const habit = data.habits.find((h) => h.id === 'H1');

  assert.ok(habit, data.habits.map((h) => h.id).join(','));
  assert.equal(habit.completed, true);
  assert.equal(habit.streak, 1);
});

test('a task completed in Google\'s own app shows in the completed section', async () => {
  signedInWith({
    tasks: [
      { id: 'T1', title: 'Открытая', status: 'needsAction', position: '00000000000000000001' },
      { id: 'P1', title: 'С телефона', status: 'completed', completed: new Date().toISOString(), hidden: true, position: '00000000000000000002' },
    ],
  });

  const data = await gt.getWidgetData({ force: true });

  assert.ok(data.tasks.some((t) => t.id === 'P1' && t.completed), data.tasks.map((t) => t.id).join(','));
});

test('open tasks are all listed even behind thousands of old completed ones', async () => {
  const old = Array.from({ length: 2500 }, (_, i) => ({
    id: `old${i}`, title: `Старая ${i}`, status: 'completed', completed: localNoon(-400), position: String(i).padStart(20, '0'),
  }));
  signedInWith({
    tasks: [...old, { id: 'late', title: 'Открытая в конце', status: 'needsAction', position: '9'.repeat(20) }],
  });

  const data = await gt.getWidgetData({ force: true });

  assert.ok(data.tasks.some((t) => t.id === 'late'));
});

test('renaming keeps a long title written in Google (up to Google\'s 1024 characters)', async () => {
  const long = `${'Очень длинное название задачи. '.repeat(10).trim()} конец`;
  signedInWith({ tasks: [{ id: 'T1', title: long, status: 'needsAction' }] });
  await gt.getWidgetData({ force: true });

  await gt.updateItem('tasks', 'T1', { title: `${long}!` });
  await gt.updateItem('tasks', 'T1', { title: 'x'.repeat(1500) });

  assert.ok(long.length > 300);
  assert.equal(server.calls.filter((c) => c.method === 'tasks.patch')[0].params.requestBody.title, `${long}!`);
  assert.equal(serverItem('tasks', 'T1').title.length, 1024);
});

test('a title cut to the limit never ends in half an emoji', async () => {
  signedInWith({ tasks: [{ id: 'T1', title: 'x', status: 'needsAction' }] });
  await gt.getWidgetData({ force: true });

  await gt.updateItem('tasks', 'T1', { title: `${'x'.repeat(1023)}😀` });

  const title = serverItem('tasks', 'T1').title;
  assert.equal(title, 'x'.repeat(1023));
});
