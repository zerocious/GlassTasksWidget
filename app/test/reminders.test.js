'use strict';

/**
 * Reminder timers and the periodic sweep, with stand-ins for electron, the Google data load and
 * the OS toast. The real reminder-store records what was shown, in a temp data folder, and the
 * clock is mocked so a whole day fits in one test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(rel, exports) {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

/** What powerMonitor.getSystemIdleState reports. */
let idleState = 'active';
stubModule('electron', {
  Notification: { isSupported: () => true },
  powerMonitor: { getSystemIdleState: () => idleState },
});

const { freshDataRoot } = require('./helpers/storage');
const { markNotified } = require('../lib/reminder-store');
const { resolveTaskDueAt } = require('../lib/task-parse');

/** What getWidgetData returns; tests swap it. */
let load = async () => ({ tasks: [], habits: [] });
stubModule('../lib/google-tasks', { getWidgetData: () => load(), resolveTaskDueAt });

/** @type {{ title: string, body: string, ids: string[] }[]} */
const toasts = [];
/** When set, a toast counts as shown only once this resolves (Electron waits up to 1.2 s). */
let toastShown = null;
stubModule('../electron/notifications', {
  windowsToastsGloballyEnabled: () => true,
  // Like the real one: the ids are marked only once the toast is shown.
  showReminderToast: async (title, body, ids) => {
    toasts.push({ title, body, ids });
    if (toastShown) await toastShown;
    markNotified(ids);
    return { shown: true, channel: 'electron' };
  },
});

const reminders = require('../electron/reminders');

/** Local time on a fixed day (no DST change nearby). */
const at = (h, m = 0) => new Date(2026, 2, 10, h, m).getTime();
/** Google's date-only due for that day. */
const DUE_TODAY = '2026-03-10T00:00:00.000Z';
/** Let the async part of a fired timer (data load, toast) finish. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fresh(t, now) {
  reminders.stopRemindersScheduler(); // timers left by an earlier test
  freshDataRoot();
  toasts.length = 0;
  toastShown = null;
  idleState = 'active';
  load = async () => ({ tasks: [], habits: [] });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
}

test('a morning sweep toast does not swallow the timed reminder set later that day', async (t) => {
  fresh(t, at(9));
  const task = { id: 'abc', title: 'Позвонить', due: DUE_TODAY, dueKind: 'today', notes: '', dueTime: null };
  load = async () => ({ tasks: [task], habits: [] });

  const morning = await reminders.runReminderCheck();
  assert.equal(morning.shown, true);
  assert.match(toasts[0].body, /на сегодня: 1/);

  // 09:30: the user gives the task a time (the «Время» panel writes «время 15:00»).
  t.mock.timers.tick(at(9, 30) - at(9));
  task.notes = 'время 15:00';
  task.dueTime = '15:00';
  reminders.scheduleExactReminders({ tasks: [task] });
  t.mock.timers.tick(at(15) - at(9, 30));
  await flush();
  assert.deepEqual(toasts.map((x) => x.body).slice(1), ['Пора: Позвонить (15:00)']);

  // The next sweep does not toast the same 15:00 again as «просрочено».
  t.mock.timers.tick(at(15, 30) - at(15));
  const afternoon = await reminders.runReminderCheck();
  assert.equal(afternoon.shown, false);
  assert.equal(toasts.length, 2);

  // Postponed to 16:00 after its «Пора»: 16:00 gets a toast of its own.
  task.notes = 'время 16:00';
  task.dueTime = '16:00';
  reminders.scheduleExactReminders({ tasks: [task] });
  t.mock.timers.tick(at(16) - at(15, 30));
  await flush();
  assert.deepEqual(toasts.map((x) => x.body).slice(2), ['Пора: Позвонить (16:00)']);
});

test('a timer whose time was changed elsewhere stays quiet and the new time gets the toast', async (t) => {
  fresh(t, at(9));
  const task = { id: 'g1', title: 'Отчёт', due: DUE_TODAY, notes: 'время 15:00', dueTime: '15:00' };
  reminders.scheduleExactReminders({ tasks: [task] });

  // Moved to 17:00 in Google; the timer for 15:00 is still armed here.
  load = async () => ({ tasks: [{ ...task, notes: 'время 17:00', dueTime: '17:00' }], habits: [] });
  t.mock.timers.tick(at(15) - at(9));
  await flush();
  assert.equal(toasts.length, 0, 'no toast for the old time');

  t.mock.timers.tick(at(17) - at(15));
  await flush();
  assert.deepEqual(toasts.map((x) => x.body), ['Пора: Отчёт (17:00)']);
});

test('an undated task is timed by a time that starts a notes line, not one in passing', async (t) => {
  fresh(t, at(9));
  // dueTime is what the widget derives from the notes (the row's time chip).
  const tasks = [
    { id: 'n1', title: 'Итоги', due: null, notes: 'Созвон был в 10:30, итоги ниже', dueTime: '10:30' },
    { id: 'n2', title: 'Прочитать', due: null, notes: 'Иоанн 3:16', dueTime: '03:16' },
    { id: 'n3', title: 'Купить хлеб', due: null, notes: 'время 10:00\nи молоко', dueTime: '10:00' },
    { id: 'n4', title: 'Почта', due: null, notes: 'В 10:15 забрать посылку', dueTime: '10:15' },
    { id: 'n5', title: 'Звонок', due: null, notes: 'Список:\n10:45 позвонить Пете', dueTime: '10:45' },
    // The chip says 10:20 (the first time in the notes): no «Пора» at 10:50 the chip does not show.
    { id: 'n6', title: 'Разбор', due: null, notes: 'Начали в 10:20\n10:50', dueTime: '10:20' },
  ];
  load = async () => ({ tasks, habits: [] });
  reminders.scheduleExactReminders({ tasks });
  t.mock.timers.tick(at(11) - at(9));
  await flush();
  assert.deepEqual(toasts.map((x) => x.body), [
    'Пора: Купить хлеб (10:00)',
    'Пора: Почта (10:15)',
    'Пора: Звонок (10:45)',
  ]);

  // Nor does the sweep list the others as «просрочено».
  const swept = await reminders.runReminderCheck();
  assert.equal(swept.shown, false);
  assert.equal(toasts.length, 3);
});

const dayItems = async () => ({
  tasks: [{ id: 'd1', title: 'Оплатить счёт', due: DUE_TODAY, dueKind: 'today', notes: '', dueTime: null }],
  habits: [{ id: 'h1', title: 'Зарядка', completed: false }],
});

test('on a PC left on overnight the day’s reminders wait until the user sits down', async (t) => {
  fresh(t, at(0, 15));
  load = dayItems;
  idleState = 'locked';
  assert.equal((await reminders.runReminderCheck()).reason, 'away');

  // 07:15: the 45-min tick after 07:00 finds the screen still locked, or nobody touching it.
  t.mock.timers.tick(at(7, 15) - at(0, 15));
  await flush();
  for (const state of ['locked', 'idle']) {
    idleState = state;
    assert.equal((await reminders.runReminderCheck()).reason, 'away', state);
  }
  t.mock.timers.tick(at(8) - at(7, 15));
  await flush();
  assert.equal(toasts.length, 0);

  // 08:00 the user sits down: within a minute the waiting sweep toasts the whole day.
  idleState = 'active';
  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.deepEqual(toasts.map((x) => x.body), ['на сегодня: 1 · привычки: 1. Оплатить счёт, Зарядка']);
});

test('a sweep toasts whoever is at the PC, even at night, and «Проверить» always does', async (t) => {
  fresh(t, at(1));
  load = dayItems;
  assert.equal((await reminders.runReminderCheck()).shown, true);
  idleState = 'idle';
  assert.equal((await reminders.runReminderCheck({ force: true })).shown, true);
  assert.equal(toasts.length, 2);
});

test('when Windows cannot tell whether anyone is there, only the night counts as away', async (t) => {
  fresh(t, at(3));
  load = dayItems;
  idleState = 'unknown';
  assert.equal((await reminders.runReminderCheck()).reason, 'away');
  t.mock.timers.tick(at(9) - at(3)); // the waiting sweep runs once the night is over
  await flush();
  assert.equal(toasts.length, 1);
});

/**
 * After wake the network is slow: an exact timer and a sweep wait on one data load (getWidgetData
 * shares it), and the first toast is still on its way when the second caller looks.
 * @param {'timer-first' | 'sweep-first'} order
 */
async function raceTimerAndSweep(t, order) {
  fresh(t, at(9));
  const task = { id: 'w1', title: 'Встреча', due: DUE_TODAY, notes: 'время 10:00', dueTime: '10:00' };
  reminders.scheduleExactReminders({ tasks: [task] });
  const dataLoad = deferred();
  load = () => dataLoad.promise;
  const shown = deferred();
  toastShown = shown.promise;

  let sweep;
  if (order === 'sweep-first') {
    t.mock.timers.tick(at(9, 59) - at(9));
    sweep = reminders.runReminderCheck();
    t.mock.timers.tick(at(10) - at(9, 59)); // the timer fires while the sweep waits
  } else {
    t.mock.timers.tick(at(10) - at(9)); // the timer fires and waits for the load
    sweep = reminders.runReminderCheck();
  }
  dataLoad.resolve({ tasks: [task], habits: [] });
  await flush(); // both callers have looked; the first toast is not marked as shown yet
  shown.resolve();
  const swept = await sweep;
  await flush();
  assert.deepEqual(toasts.map((x) => x.body), ['Пора: Встреча (10:00)']);
  assert.equal(swept.shown, false);
}

test('an exact timer and a sweep waiting on the same load toast once (timer first)', (t) =>
  raceTimerAndSweep(t, 'timer-first'));

test('an exact timer and a sweep waiting on the same load toast once (sweep first)', (t) =>
  raceTimerAndSweep(t, 'sweep-first'));
