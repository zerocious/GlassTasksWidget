'use strict';

/** Renderer list behaviour (src/app.js): gestures on rows, row order, row animations. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererFunctions } = require('./helpers/renderer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function swipeHarness() {
  const views = [];
  return loadRendererFunctions(['onSwipeEnd', 'blockRowClick'], {
    swipeArmed: true,
    dndActive: false,
    startX: 259,
    dndClickBlockTimer: null,
    setView: (v) => views.push(v),
    views,
  });
}

test('a swipe across a row blocks the click it ends with, so the row is not toggled', async () => {
  const r = swipeHarness();
  r.onSwipeEnd({ clientX: 179 });
  assert.deepEqual([...r.views], ['habits']);
  // The list click handlers return early while this timer is set (`dndActive || dndClickBlockTimer`).
  assert.ok(r.dndClickBlockTimer, 'the click that follows pointerup is swallowed');
  assert.equal(r.swipeArmed, false);
  await sleep(160);
  assert.equal(r.dndClickBlockTimer, null, 'later clicks work again');
});

test('a short pointer move is a plain click: no view change, the click goes through', () => {
  const r = swipeHarness();
  r.onSwipeEnd({ clientX: 250 });
  assert.deepEqual([...r.views], []);
  assert.equal(r.dndClickBlockTimer, null);
});

test('a swipe that was not armed (started on a button, during a drag) does nothing', () => {
  const r = swipeHarness();
  r.swipeArmed = false;
  r.onSwipeEnd({ clientX: 100 });
  assert.deepEqual([...r.views], []);
  assert.equal(r.dndClickBlockTimer, null);
});

/**
 * Just enough of a <ul> for syncListOrder. Like Chromium, detaching the focused node (a move
 * with insertBefore, or remove) drops focus to <body> and blurs it; moveBefore keeps focus.
 * @param {string[]} ids
 * @param {{ moveBefore?: boolean }} [opts]
 */
function fakeList(ids, opts = {}) {
  const body = { name: 'body' };
  const doc = { activeElement: body, body };
  const moves = [];
  const blurs = [];
  const list = { children: [] };
  const detach = (node) => {
    const i = list.children.indexOf(node);
    if (i >= 0) list.children.splice(i, 1);
    node.parent = null;
  };
  const place = (node, before) => {
    const i = before ? list.children.indexOf(before) : list.children.length;
    assert.ok(i >= 0, 'reference row is in the list');
    list.children.splice(i, 0, node);
    node.parent = list;
  };
  const makeRow = (id) => ({
    dataset: { id },
    isRow: true,
    parent: null,
    get isConnected() {
      return this.parent === list;
    },
    remove() {
      if (doc.activeElement === this) {
        doc.activeElement = body;
        blurs.push(id);
      }
      detach(this);
    },
    focus() {
      doc.activeElement = this;
    },
  });
  list.querySelectorAll = (sel) => {
    assert.equal(sel, 'li.row');
    return list.children.filter((c) => c.isRow);
  };
  list.contains = (node) => node === list || node.parent === list;
  list.insertBefore = (node, before) => {
    moves.push(node.dataset.id);
    if (doc.activeElement === node) {
      doc.activeElement = body;
      blurs.push(node.dataset.id);
    }
    detach(node);
    place(node, before);
  };
  if (opts.moveBefore) {
    list.moveBefore = (node, before) => {
      moves.push(node.dataset.id);
      detach(node);
      place(node, before);
    };
  }
  for (const id of ids) place(makeRow(id), null);
  const row = (id) => list.children.find((c) => c.dataset && c.dataset.id === id);
  const order = () => list.children.map((c) => (c.isRow ? c.dataset.id : `<${c.name}>`));
  return { list, doc, moves, blurs, row, order };
}

function syncHarness(fake) {
  return loadRendererFunctions(['syncListOrder', 'rowsInPlace', 'moveRow'], { document: fake.doc });
}

const items = (ids) => ids.map((id) => ({ id }));

test('syncListOrder leaves rows that are already in order alone (focus and rename input survive)', () => {
  const fake = fakeList(['a', 'b', 'c', 'd']);
  fake.row('b').focus();
  syncHarness(fake).syncListOrder(fake.list, items(['a', 'b', 'c', 'd']));
  assert.deepEqual(fake.moves, []);
  assert.deepEqual(fake.blurs, []);
  assert.equal(fake.doc.activeElement, fake.row('b'));
});

test('syncListOrder moves only the toggled row; a row being renamed elsewhere is not touched', () => {
  const fake = fakeList(['a', 'b', 'c', 'd']);
  fake.row('c').focus(); // stands for the rename input inside row c
  syncHarness(fake).syncListOrder(fake.list, items(['b', 'c', 'd', 'a'])); // a was completed
  assert.deepEqual(fake.order(), ['b', 'c', 'd', 'a']);
  assert.deepEqual(fake.moves, ['a']);
  assert.deepEqual(fake.blurs, [], 'no blur, so no half-typed title is saved');
  assert.equal(fake.doc.activeElement, fake.row('c'));
});

test('syncListOrder keeps keyboard focus on a row it has to move', () => {
  const fake = fakeList(['a', 'b', 'c']);
  fake.row('a').focus(); // Space on a focused row: it moves to the done section
  syncHarness(fake).syncListOrder(fake.list, items(['b', 'c', 'a']));
  assert.deepEqual(fake.order(), ['b', 'c', 'a']);
  assert.equal(fake.doc.activeElement, fake.row('a'), 'the next ↑ ↓ / Space still reach the row');
});

test('syncListOrder uses moveBefore when the browser has it', () => {
  const fake = fakeList(['a', 'b', 'c'], { moveBefore: true });
  fake.row('a').focus();
  syncHarness(fake).syncListOrder(fake.list, items(['b', 'c', 'a']));
  assert.deepEqual(fake.order(), ['b', 'c', 'a']);
  assert.deepEqual(fake.blurs, []);
  assert.equal(fake.doc.activeElement, fake.row('a'));
});

test('syncListOrder drops rows of hidden items and keeps rows it has no item for out of the order', () => {
  const fake = fakeList(['a', 'b', 'c']);
  fake.list.children.splice(1, 0, { name: 'sub-edit' }); // the «Новая подзадача…» input row after a
  syncHarness(fake).syncListOrder(fake.list, items(['a', 'c', 'x']));
  assert.deepEqual(fake.order(), ['a', '<sub-edit>', 'c']);
  assert.deepEqual(fake.moves, []);
});

/** A row element for removeRowAnimated / patchTaskRow: classes, listeners, attached or not. */
function fakeRow(id) {
  const classes = new Set(['row']);
  const listeners = new Set();
  return {
    dataset: { id },
    parentNode: { name: 'list' },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    get className() {
      return [...classes].join(' ');
    },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    listeners,
    querySelector: () => null,
    remove() {
      this.parentNode = null;
    },
  };
}

function leaveHarness(extra = {}) {
  return loadRendererFunctions(['removeRowAnimated', 'cancelRowLeave', ...(extra.names || [])], {
    motionQuiet: () => false,
    rowLeaves: new WeakMap(),
    ...extra.globals,
  });
}

test('a row whose leave animation is cancelled stays in the list', async () => {
  const r = leaveHarness();
  const li = fakeRow('a');
  let done = 0;
  r.removeRowAnimated(li, () => (done += 1));
  assert.ok(li.classList.contains('row-leave'));
  r.cancelRowLeave(li);
  await sleep(300);
  assert.ok(li.parentNode, 'not removed by the pending timer');
  assert.equal(done, 0);
  assert.equal(li.listeners.size, 0, 'transitionend listener dropped');
});

test('an uncancelled leave still removes the row once', async () => {
  const r = leaveHarness();
  const li = fakeRow('a');
  let done = 0;
  r.removeRowAnimated(li, () => (done += 1));
  r.removeRowAnimated(li, () => (done += 1)); // the server reply confirms the hide again
  await sleep(300);
  assert.equal(li.parentNode, null);
  assert.equal(done, 1);
});

test('hide completed: a toggle that fails within the animation brings the row back for good', async () => {
  const li = fakeRow('t1');
  const task = { id: 't1', title: 'Купить молоко', completed: true, parent: null };
  const noop = () => {};
  const r = leaveHarness({
    names: ['patchTaskRow'],
    globals: {
      // hideCompleted on: a completed task is not in the visible list
      visibleTasks: () => (task.completed ? [] : [task]),
      rowById: () => (li.parentNode ? li : null),
      listTasks: { querySelector: () => null },
      buildTaskRow: () => assert.fail('the existing row is reused'),
      taskRowClassName: (t) => (t.completed ? 'row done' : 'row'),
      syncTaskFilterUi: noop,
      syncListOrder: noop,
      ensureListEmpty: noop,
      markRowEnter: noop,
      setRowTitle: noop,
      displayMeta: (m) => m || '',
      syncRowA11y: noop,
      syncRowTimeChip: noop,
      syncRowRepeatBadge: noop,
      taskHasNotes: () => false,
      NOTES_IND_SVG: '',
      document: {},
      state: { tasks: [task] },
    },
  });
  r.patchTaskRow(task); // optimistic: completed → the row starts leaving
  assert.ok(li.classList.contains('row-leave'));
  task.completed = false; // setCompleted failed fast: toggleItem reverts and patches again
  r.patchTaskRow(task);
  assert.equal(li.className, 'row');
  await sleep(300);
  assert.ok(li.parentNode, 'the open task is still shown');
});

function revealHarness({ filter = 'all', query = '', tasks = [], habits = [] } = {}) {
  const r = loadRendererFunctions(
    ['revealCreatedItem', 'visibleTasks', 'filterTasksByDue', 'taskMatchesDueFilter', 'filterVisibleItems', 'matchesSearch'],
    {
      settings: { hideCompleted: false },
      searchQuery: query,
      taskDueFilter: filter,
      state: { tasks, habits },
      closed: 0,
    }
  );
  r.closeSearch = () => {
    r.closed += 1;
    r.searchQuery = '';
  };
  r.setTaskDueFilter = (f) => {
    r.taskDueFilter = f;
  };
  return r;
}

test('a task added under the «Сегодня» filter without a date is shown, not silently hidden', () => {
  const item = { id: 'new', title: 'купить молоко', due: null, dueKind: null };
  const r = revealHarness({ filter: 'today', tasks: [item, { id: 't', title: 'x', dueKind: 'today' }] });
  r.revealCreatedItem('tasks', item);
  assert.equal(r.taskDueFilter, 'all');
});

test('a task that matches the active filter and search leaves both alone', () => {
  const item = { id: 'new', title: 'купить молоко', due: '2026-10-24', dueKind: 'today' };
  const r = revealHarness({ filter: 'today', query: 'молоко', tasks: [item] });
  r.revealCreatedItem('tasks', item);
  assert.equal(r.taskDueFilter, 'today');
  assert.equal(r.closed, 0);
});

test('an add that the search does not match closes the search; one it matches keeps it', () => {
  const milk = { id: 'new', title: 'купить молоко', due: null, dueKind: null };
  const r = revealHarness({ query: 'хлеб', tasks: [milk] });
  r.revealCreatedItem('tasks', milk);
  assert.equal(r.closed, 1);
  assert.equal(r.taskDueFilter, 'all');

  const kept = revealHarness({ filter: 'overdue', query: 'молоко', tasks: [milk] });
  kept.revealCreatedItem('tasks', milk);
  assert.equal(kept.closed, 0, 'only the date filter hid it');
  assert.equal(kept.taskDueFilter, 'all');
});

test('a habit added during a search it does not match closes the search', () => {
  const habit = { id: 'h', title: 'Читать', completed: false };
  const r = revealHarness({ query: 'вода', habits: [habit] });
  r.revealCreatedItem('habits', habit);
  assert.equal(r.closed, 1);
});

test('syncListOrder reaches any order with the fewest moves', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let run = 0; run < 200; run += 1) {
    const fake = fakeList(ids);
    const target = ids.filter(() => rand() > 0.15).sort(() => rand() - 0.5);
    syncHarness(fake).syncListOrder(fake.list, items(target));
    assert.deepEqual(fake.order(), target);
    // Rows that keep their relative order (a longest increasing run) never move.
    const pos = target.map((id) => ids.indexOf(id));
    const best = pos.map(() => 1);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < i; j += 1) if (pos[j] < pos[i]) best[i] = Math.max(best[i], best[j] + 1);
    }
    assert.equal(fake.moves.length, target.length - Math.max(0, ...best), `order ${target.join('')}`);
  }
});
