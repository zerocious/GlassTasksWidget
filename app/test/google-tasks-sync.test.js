'use strict';

/**
 * Google mode end to end against an in-memory Tasks API (test/helpers/fake-google.js):
 * caches, edits made on other devices, logout races, day boundaries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshGoogle } = require('./helpers/fake-google');
const gt = require('../lib/google-tasks');

const childrenOf = (fake, parent) =>
  fake.items('L-tasks').filter((i) => i.parent === parent).map((i) => i.id);

test('a subtask dragged right after it was created keeps its parent', async () => {
  const { fake } = freshGoogle();
  fake.setItems('L-tasks', [
    { id: 'P', title: 'Проект' },
    { id: 'C1', title: 'Шаг 1', parent: 'P' },
  ]);
  await gt.getWidgetData({ force: true });
  const lists = () => fake.calls.filter((c) => c.method === 'tasks.list').length;
  const listsBefore = lists();

  const { item } = await gt.createItem('tasks', 'Шаг 2', { parentId: 'P' });
  assert.deepEqual(childrenOf(fake, 'P'), [item.id, 'C1'], 'Google puts a new subtask first');

  // The user drags it below its sibling before any refresh.
  await gt.moveItem('tasks', item.id, 'C1', ['P', 'C1', item.id]);
  assert.equal(fake.item('L-tasks', item.id).parent, 'P');
  assert.deepEqual(childrenOf(fake, 'P'), ['C1', item.id]);

  const cached = (await gt.getWidgetData()).tasks.map((t) => t.id);
  assert.equal(lists(), listsBefore, 'no refetch in between');
  assert.deepEqual(cached, ['P', 'C1', item.id], 'the cache holds the subtask, nested');
});

test('moving a subtask the caches do not know asks Google for its parent', async () => {
  const { fake } = freshGoogle();
  fake.setItems('L-tasks', [
    { id: 'P', title: 'Проект' },
    { id: 'C1', title: 'Шаг 1', parent: 'P' },
  ]);
  await gt.getWidgetData({ force: true });
  fake.addItem('L-tasks', { id: 'S', title: 'С телефона', parent: 'P' }, 'P');

  await gt.moveItem('tasks', 'S', 'C1', ['P', 'C1', 'S']);
  assert.equal(fake.item('L-tasks', 'S').parent, 'P');
  assert.deepEqual(childrenOf(fake, 'P'), ['C1', 'S']);
});
