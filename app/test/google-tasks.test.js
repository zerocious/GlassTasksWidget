'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../lib/google-tasks');

const { listAllPages, runMutation } = _test;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('listAllPages follows nextPageToken and forwards params', async () => {
  const calls = [];
  const pages = {
    '': { items: [1, 2], nextPageToken: 'p2' },
    p2: { items: [3], nextPageToken: 'p3' },
    p3: { items: [4] },
  };
  const items = await listAllPages(async (params) => {
    calls.push(params);
    return { data: pages[params.pageToken || ''] };
  }, { tasklist: 'L' });
  assert.deepEqual(items, [1, 2, 3, 4]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.tasklist === 'L' && c.maxResults === 100));
});

test('listAllPages tolerates empty pages and stops at the page ceiling', async () => {
  let n = 0;
  const items = await listAllPages(async () => {
    n += 1;
    return { data: { nextPageToken: 'again' } };
  }, {});
  assert.deepEqual(items, []);
  assert.equal(n, 20);
});

test('runMutation shares a promise for an identical repeated request', async () => {
  let runs = 0;
  const gate = deferred();
  const task = async () => {
    runs += 1;
    await gate.promise;
    return 'ok';
  };
  const a = runMutation('set:tasks:dup:true', 'tasks:dup', task);
  const b = runMutation('set:tasks:dup:true', 'tasks:dup', task);
  assert.equal(a, b);
  gate.resolve();
  assert.equal(await a, 'ok');
  assert.equal(runs, 1);
});

test('runMutation keeps on → off → on in order (no stale dedupe)', async () => {
  const applied = [];
  const gate = deferred();
  const op = (value) => async () => {
    if (value === true && applied.length === 0) await gate.promise;
    applied.push(value);
    return value;
  };
  const p1 = runMutation('set:tasks:t1:true', 'tasks:t1', op(true));
  const p2 = runMutation('set:tasks:t1:false', 'tasks:t1', op(false));
  const p3 = runMutation('set:tasks:t1:true', 'tasks:t1', op(true));
  assert.notEqual(p3, p1);
  gate.resolve();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(applied, [true, false, true]);
});

test('runMutation continues the queue after a failed op', async () => {
  const failed = runMutation('upd:tasks:t2:a', 'tasks:t2', async () => {
    throw new Error('boom');
  });
  const next = runMutation('upd:tasks:t2:b', 'tasks:t2', async () => 'second');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'second');
});

test('runMutation runs different items in parallel', async () => {
  const gate = deferred();
  const slow = runMutation('set:tasks:a:true', 'tasks:a', async () => {
    await gate.promise;
    return 'a';
  });
  const fast = await runMutation('set:tasks:b:true', 'tasks:b', async () => 'b');
  assert.equal(fast, 'b');
  gate.resolve();
  assert.equal(await slow, 'a');
});
