'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// power.js has no Electron dependency, but main-process modules share this folder.
const { createWakeDetector } = require('../electron/power');

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('normal one-minute ticks never count as a wake', () => {
  const c = clock();
  const wakes = [];
  const d = createWakeDetector({ onWake: (r) => wakes.push(r), now: c.now });
  for (let i = 0; i < 30; i += 1) {
    c.advance(60_000);
    assert.equal(d.tick(), false);
  }
  assert.deepEqual(wakes, []);
});

test('a long gap between ticks (sleep) fires once, then ticking is quiet again', () => {
  const c = clock();
  const wakes = [];
  const d = createWakeDetector({ onWake: (r) => wakes.push(r), now: c.now });
  c.advance(60_000);
  d.tick();
  c.advance(45 * 60_000);
  assert.equal(d.tick(), true);
  assert.match(wakes[0], /^clock-jump \+2700s$/);
  c.advance(60_000);
  assert.equal(d.tick(), false);
  assert.equal(wakes.length, 1);
});

test('the clock set back (DST / manual) also counts', () => {
  const c = clock();
  const wakes = [];
  const d = createWakeDetector({ onWake: (r) => wakes.push(r), now: c.now });
  c.advance(-3600_000);
  assert.equal(d.tick(), true);
  assert.match(wakes[0], /^clock-back/);
});

test('an OS resume event and the drift check right after it fire only once', () => {
  const c = clock();
  const wakes = [];
  const d = createWakeDetector({ onWake: (r) => wakes.push(r), now: c.now });
  c.advance(20 * 60_000);
  assert.equal(d.notify('resume'), true);
  c.advance(3_000);
  assert.equal(d.tick(), false, 'drift check after the event is a duplicate');
  assert.equal(d.notify('resume'), false, 'a repeated event within the debounce window is ignored');
  assert.deepEqual(wakes, ['resume']);
  c.advance(60_000);
  assert.equal(d.notify('resume'), true, 'a later resume is a new wake');
});
