'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuitGate } = require('../lib/quit-gate');

function fakeQuitEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('the first quit waits for the flush, then quits for real', async () => {
  const flush = deferred();
  let quits = 0;
  const gate = createQuitGate({ flush: () => flush.promise, quit: () => { quits += 1; }, timeoutMs: 1000 });

  const first = fakeQuitEvent();
  gate.onBeforeQuit(first);
  assert.equal(first.prevented, true);
  assert.equal(quits, 0);

  flush.resolve();
  await gate.idle();
  assert.equal(quits, 1);

  const second = fakeQuitEvent();
  gate.onBeforeQuit(second);
  assert.equal(second.prevented, false);
});

test('quit requests during the flush do not start another one', async () => {
  const flush = deferred();
  let flushes = 0;
  let quits = 0;
  const gate = createQuitGate({
    flush: () => { flushes += 1; return flush.promise; },
    quit: () => { quits += 1; },
    timeoutMs: 1000,
  });

  gate.onBeforeQuit(fakeQuitEvent());
  const again = fakeQuitEvent();
  gate.onBeforeQuit(again);
  assert.equal(again.prevented, true);

  flush.resolve();
  await gate.idle();
  assert.equal(flushes, 1);
  assert.equal(quits, 1);
});

test('a flush that hangs or fails does not keep the app from quitting', async () => {
  let quits = 0;
  const hung = createQuitGate({ flush: () => new Promise(() => {}), quit: () => { quits += 1; }, timeoutMs: 30 });
  hung.onBeforeQuit(fakeQuitEvent());
  await hung.idle();
  assert.equal(quits, 1);

  const failing = createQuitGate({ flush: async () => { throw new Error('boom'); }, quit: () => { quits += 1; }, timeoutMs: 1000 });
  failing.onBeforeQuit(fakeQuitEvent());
  await failing.idle();
  assert.equal(quits, 2);
});
