'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { freshDataRoot, writeRaw } = require('./helpers/storage');
const gt = require('../lib/google-tasks');

test('editing notes in demo mode updates the row subtitle', async () => {
  freshDataRoot();
  gt.invalidatePayloadCache();
  const { item } = await gt.createItem('tasks', 'Магазин');

  const result = await gt.updateItem('tasks', item.id, { notes: 'Купить молоко и хлеб' });
  const data = await gt.getWidgetData({ force: true });

  assert.equal(result.item.meta, 'Купить молоко и хлеб');
  assert.equal(data.tasks.find((t) => t.id === item.id).meta, 'Купить молоко и хлеб');
});

test('demo tasks take their clock time from the notes, like Google date-only dues', async () => {
  freshDataRoot();
  gt.invalidatePayloadCache();
  const data = await gt.getWidgetData({ force: true });
  const review = data.tasks.find((t) => t.title === 'Review project proposal');

  assert.equal(review.dueTime, '09:30');
  assert.equal(review.dueKind, 'today');
});

test('a demo file from an older version with local-noon dues shows no fake 12:00', async () => {
  const root = freshDataRoot();
  gt.invalidatePayloadCache();
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  writeRaw(root, 'mock-items.json', {
    tasks: [{ id: 'old-1', title: 'Старая демо-задача', notes: '', parent: null, due: noon.toISOString(), status: 'needsAction', completed: false }],
    habits: [],
  });

  const data = await gt.getWidgetData({ force: true });
  const task = data.tasks.find((t) => t.id === 'old-1');

  assert.equal(task.dueTime, null);
  assert.equal(task.dueKind, 'today');
});
