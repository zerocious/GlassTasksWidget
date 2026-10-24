'use strict';

/** Renderer data refresh (src/app.js): background sync. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererFunctions } = require('./helpers/renderer');

/** Payload as the server builds it on 24 Oct; `day` 25 is the same data recomputed after midnight. */
function payload(day) {
  const overdue = day === 25;
  return {
    mode: 'google',
    offline: false,
    tasksListFound: true,
    habitsListFound: false,
    tasks: [
      {
        id: 't1',
        title: 'Купить молоко',
        notes: '',
        due: '2026-10-24T00:00:00.000Z',
        completed: false,
        parent: null,
        position: '001',
        dueKind: overdue ? 'overdue' : 'today',
        meta: overdue ? 'Просрочено · 24 окт.' : 'Сегодня',
        dueTime: null,
        recurrence: null,
      },
      {
        id: 't2',
        title: 'Позвонить',
        notes: '',
        due: '2026-10-25T00:00:00.000Z',
        completed: false,
        parent: null,
        position: '002',
        dueKind: overdue ? 'today' : null,
        meta: overdue ? 'Сегодня' : '25 окт.',
        dueTime: null,
        recurrence: null,
      },
    ],
    habits: [],
  };
}

function syncHarness(current, next) {
  const renders = [];
  const r = loadRendererFunctions(['backgroundSync', 'dataSignature'], {
    state: current,
    lastLoadAt: 0,
    configAccent: '#C4122E',
    canBackgroundSync: () => true,
    carryPendingItems: () => {},
    renderAll: () => renders.push(r.state),
    window: { widgetApi: { getData: async () => next } },
  });
  return { r, renders };
}

test('background sync re-renders after midnight when only «Сегодня» / «Просрочено» changed', async () => {
  const { r, renders } = syncHarness(payload(24), payload(25));
  await r.backgroundSync();
  assert.equal(renders.length, 1, 'the stale day is replaced');
  assert.equal(r.state.tasks[0].dueKind, 'overdue');
  assert.equal(r.state.tasks[1].meta, 'Сегодня');
});

test('background sync still skips re-rendering when nothing visible changed', async () => {
  const { r, renders } = syncHarness(payload(24), payload(24));
  await r.backgroundSync();
  assert.equal(renders.length, 0);
});

test('dataSignature covers the per-day fields of tasks and habits', () => {
  const { dataSignature } = loadRendererFunctions(['dataSignature']);
  const habit = (week) => ({
    mode: 'google',
    tasks: [],
    habits: [{ id: 'h1', title: 'Вода', completed: false, streak: 3, meta: 'Ежедневно', week }],
  });
  assert.notEqual(
    dataSignature(habit([true, true, true, false, false, false, false])),
    dataSignature(habit([true, true, false, false, false, false, false])),
    'the week strip shifts by a day'
  );
  const time = (dueTime) => ({ mode: 'google', tasks: [{ id: 't', title: 'x', dueTime }], habits: [] });
  assert.notEqual(dataSignature(time('09:30')), dataSignature(time(null)));
  const lists = (found) => ({ mode: 'google', habitsListFound: found, tasks: [], habits: [] });
  assert.notEqual(dataSignature(lists(true)), dataSignature(lists(false)), 'the «нет списка» banner');
});
