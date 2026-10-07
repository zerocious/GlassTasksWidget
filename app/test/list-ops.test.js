'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyItemPatch, reorderList } = require('../lib/list-ops');

const list = () => [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'b1', title: 'B child', parent: 'b' },
  { id: 'c', title: 'C' },
];

test('applyItemPatch merges a patch without mutating the input', () => {
  const input = list();
  const out = applyItemPatch(input, 'b', { title: 'B2' });
  assert.equal(out[1].title, 'B2');
  assert.equal(input[1].title, 'B');
});

test('applyItemPatch(null) removes the item and its subtasks', () => {
  assert.deepEqual(applyItemPatch(list(), 'b', null).map((i) => i.id), ['a', 'c']);
});

test('applyItemPatch with append puts the new item first, replacing same id', () => {
  const out = applyItemPatch(list(), 'c', null, { id: 'c', title: 'C new' });
  assert.deepEqual(out.map((i) => i.id), ['c', 'a', 'b', 'b1']);
  assert.equal(out[0].title, 'C new');
});

test('reorderList follows orderedIds and keeps unlisted items at the end', () => {
  const out = reorderList(list(), ['c', 'a', 'missing', 'c'], { id: 'a', position: '001' });
  assert.deepEqual(out.map((i) => i.id), ['c', 'a', 'b', 'b1']);
  assert.equal(out[1].position, '001');
});

test('both helpers tolerate a missing list', () => {
  assert.deepEqual(applyItemPatch(undefined, 'x', { a: 1 }), []);
  assert.deepEqual(reorderList(undefined, ['x']), []);
});
