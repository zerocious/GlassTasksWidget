'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { markNotified } = require('../lib/reminder-store');

/** Toasts the scheduler asked for; like the real one, a shown toast marks its ids notified. */
const toasts = [];

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stubModule('electron', { Notification: { isSupported: () => true } });
stubModule(path.join(__dirname, '..', 'electron', 'notifications.js'), {
  windowsToastsGloballyEnabled: () => true,
  showReminderToast: async (title, body, ids) => {
    toasts.push({ title, body, ids });
    markNotified(ids);
    return { shown: true, channel: 'electron' };
  },
});

const { freshDataRoot } = require('./helpers/storage');
const { todayIso } = require('../lib/dates');
const gt = require('../lib/google-tasks');
const reminders = require('../electron/reminders');

const HOUR = 60 * 60 * 1000;

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a task moved to a later time the same day is reminded again', async (t) => {
  freshDataRoot();
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start.getTime() });
  t.after(() => reminders.stopRemindersScheduler());

  const { item } = await gt.createItem('tasks', 'Позвонить в банк');
  await gt.updateItem('tasks', item.id, { due: todayIso(), dueTime: '11:00' });
  const ours = () => toasts.filter((x) => x.body.includes('Позвонить в банк'));

  reminders.scheduleExactReminders(await gt.getWidgetData({ force: true }));
  t.mock.timers.tick(HOUR);
  await settle();
  assert.equal(ours().length, 1);

  await gt.updateItem('tasks', item.id, { dueTime: '13:00' });
  reminders.scheduleExactReminders(await gt.getWidgetData({ force: true }));
  t.mock.timers.tick(2 * HOUR);
  await settle();
  assert.equal(ours().length, 2);
});

test('the periodic check does not repeat a task its exact reminder already announced', async (t) => {
  freshDataRoot();
  toasts.length = 0;
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start.getTime() });
  t.after(() => reminders.stopRemindersScheduler());

  const { item } = await gt.createItem('tasks', 'Забрать посылку');
  await gt.updateItem('tasks', item.id, { due: todayIso(), dueTime: '11:00' });
  reminders.scheduleExactReminders(await gt.getWidgetData({ force: true }));
  t.mock.timers.tick(HOUR);
  await settle();

  t.mock.timers.tick(45 * 60 * 1000);
  await reminders.runReminderCheck();
  await settle();
  assert.equal(toasts.filter((x) => x.body.includes('Забрать посылку')).length, 1);
});
