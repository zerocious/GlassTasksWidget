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

stubModule('electron', {
  Notification: { isSupported: () => true },
});

const { freshDataRoot } = require('./helpers/storage');
const { markNotified } = require('../lib/reminder-store');
const { resolveTaskDueAt } = require('../lib/task-parse');

/** What getWidgetData returns; tests swap it. */
let load = async () => ({ tasks: [], habits: [] });
stubModule('../lib/google-tasks', { getWidgetData: () => load(), resolveTaskDueAt });

/** @type {{ title: string, body: string, ids: string[] }[]} */
const toasts = [];
stubModule('../electron/notifications', {
  windowsToastsGloballyEnabled: () => true,
  // Like the real one: the ids are marked only once the toast is shown.
  showReminderToast: async (title, body, ids) => {
    toasts.push({ title, body, ids });
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

function fresh(t, now) {
  reminders.stopRemindersScheduler(); // timers left by an earlier test
  freshDataRoot();
  toasts.length = 0;
  load = async () => ({ tasks: [], habits: [] });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
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
