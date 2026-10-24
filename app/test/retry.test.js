'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withRetry, retryingTasksClient } = require('../lib/retry');

const noSleep = async () => {};
const httpError = (status, headers = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });

test('retries 5xx / 429 and then succeeds', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw httpError(calls === 1 ? 503 : 429);
    return 'ok';
  }, { sleep: noSleep });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('does not retry client errors', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw httpError(404);
  }, { sleep: noSleep }), /404/);
  assert.equal(calls, 1);
});

test('gives up after the retry budget', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw httpError(500);
  }, { retries: 2, sleep: noSleep }), /500/);
  assert.equal(calls, 3);
});

test('non-idempotent calls retry only explicit refusals, never lost responses', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  }, { idempotent: false, sleep: noSleep }), /reset/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw httpError(500);
  }, { idempotent: false, sleep: noSleep }), /500/);
  assert.equal(calls, 1);

  calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw httpError(429);
  }, { idempotent: false, sleep: noSleep });
  assert.equal(calls, 2);
});

test('honours Retry-After seconds', async () => {
  const waits = [];
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw httpError(429, { 'retry-after': '2' });
  }, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [2000]);
});

test('retryingTasksClient keeps the real Google client methods (they live on the class prototype)', async (t) => {
  // Regression: wrapping only Object.keys() dropped every method of @googleapis/tasks,
  // so Google mode could neither read nor write anything.
  const { tasks } = require('@googleapis/tasks');
  const client = tasks({ version: 'v1' });
  let calls = 0;
  // Stub the prototype method before wrapping (the wrapper binds what it finds), no network.
  t.mock.method(Object.getPrototypeOf(client.tasks), 'list', async function list() {
    calls += 1;
    if (calls === 1) throw httpError(503);
    assert.equal(this, client.tasks, 'called on the original resource');
    return { data: { items: ['ok'] } };
  });
  const wrapped = retryingTasksClient(client, { sleep: noSleep });
  for (const name of ['list', 'get', 'insert', 'patch', 'delete', 'move']) {
    assert.equal(typeof wrapped.tasks[name], 'function', `tasks.${name}`);
  }
  assert.equal(typeof wrapped.tasklists.list, 'function', 'tasklists.list');
  assert.deepEqual((await wrapped.tasks.list({ tasklist: 'x' })).data.items, ['ok']);
  assert.equal(calls, 2, 'retried once after 503');
});

test('retryingTasksClient wraps every method and keeps `this`', async () => {
  let inserts = 0;
  let lists = 0;
  const client = {
    other: 1,
    tasks: {
      name: 'tasks',
      async list() {
        lists += 1;
        if (lists === 1) throw httpError(502);
        return { data: { items: [this.name] } };
      },
      async insert() {
        inserts += 1;
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      },
    },
    tasklists: { async list() { return { data: { items: [] } }; } },
  };
  const wrapped = retryingTasksClient(client, { sleep: noSleep });
  assert.equal(wrapped.other, 1);
  assert.deepEqual((await wrapped.tasks.list({})).data.items, ['tasks']);
  await assert.rejects(wrapped.tasks.insert({}), /reset/);
  assert.equal(inserts, 1);
});
