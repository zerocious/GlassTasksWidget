'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Some lib modules `require('electron')` at load time; demo mode never needs the real one.
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {} };

const { freshDataRoot } = require('./helpers/storage');
const { getMockPayload } = require('../lib/mock-data');
const { todayIso, addDaysIso } = require('../lib/dates');
const { resolveTaskTime, resolveTaskDueAt, dueKindFor } = require('../lib/task-parse');

const CONFIG = { tasksListName: 'Tasks', habitsListName: 'Habits', accentColor: '#C4122E' };

test('demo tasks get date-only dues, so their «время» lines set the time', () => {
  freshDataRoot();
  const { tasks } = getMockPayload(CONFIG);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks.filter((x) => x.due)) {
    assert.match(t.due, /T00:00:00\.000Z$/, `${t.id}: no clock time in the due`);
  }
  const t1 = byId.get('mock-t1');
  assert.equal(t1.due, `${todayIso()}T00:00:00.000Z`);
  assert.equal(dueKindFor(t1.due, false), 'today');
  assert.equal(resolveTaskTime(t1), '09:30', 'not a «12:00» chip');
  const at = resolveTaskDueAt(t1);
  assert.deepEqual([at.getHours(), at.getMinutes()], [9, 30]);
  assert.equal(byId.get('mock-t2').due, `${addDaysIso(todayIso(), 2)}T00:00:00.000Z`);
  assert.equal(resolveTaskTime(byId.get('mock-t2')), null, 'date-only task: no time chip');
});
