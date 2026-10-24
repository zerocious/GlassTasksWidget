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
