'use strict';

/** Task notes come from Google (Gmail «Add to Tasks», assigned tasks): parsing must stay linear. */

const test = require('node:test');
const assert = require('node:assert/strict');

const tp = require('../lib/task-parse');

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

const HOSTILE = [
  `время${' '.repeat(8000)}x`,
  `повтор${'\t'.repeat(8000)}x`,
  `в${' '.repeat(8000)}x`,
  `time${' '.repeat(4000)}:${' '.repeat(4000)}x`,
  `a${'\n'.repeat(16000)}b`,
];

test('hostile notes are parsed in linear time', () => {
  for (const notes of HOSTILE) {
    for (const [name, fn] of [
      ['timeFromNotes', () => tp.timeFromNotes(notes)],
      ['parseRecurrence', () => tp.parseRecurrence(notes)],
      ['isManagedNotesLine', () => tp.isManagedNotesLine(notes)],
      ['applyDueTimeToNotes set', () => tp.applyDueTimeToNotes(notes, '10:30')],
      ['applyDueTimeToNotes clear', () => tp.applyDueTimeToNotes(notes, null)],
      ['applyRecurrenceToNotes', () => tp.applyRecurrenceToNotes(notes, 'daily')],
    ]) {
      const { ms } = timed(fn);
      assert.ok(ms < 100, `${name} took ${ms.toFixed(0)} ms on ${JSON.stringify(notes.slice(0, 12))}…`);
    }
  }
});

test('the linear patterns accept exactly what the old ones did', () => {
  assert.equal(tp.timeFromNotes('время 10:30'), '10:30');
  assert.equal(tp.timeFromNotes('time: 9:05'), '09:05');
  assert.equal(tp.timeFromNotes('Время - 09.30'), '09:30');
  assert.equal(tp.timeFromNotes('позвонить в 14:30'), '14:30');
  assert.equal(tp.timeFromNotes('x время-09.30'), '09:30');
  assert.equal(tp.timeFromNotes('время :  7:05'), '07:05');
  assert.equal(tp.parseRecurrence('повтор: ежедневно'), 'daily');
  assert.equal(tp.parseRecurrence('repeat - weekly'), 'weekly');
  assert.equal(tp.parseRecurrence('Повтор будни'), 'weekdays');
  assert.equal(tp.isManagedNotesLine('время: 10:30'), true);
  assert.equal(tp.isManagedNotesLine('время -- 10:30'), false);
  assert.equal(tp.applyDueTimeToNotes('время 09:00\nкупить хлеб\n\n\n', '10:30'), 'время 10:30\nкупить хлеб');
  assert.equal(tp.applyDueTimeToNotes('\n\nв 14:30\nзаметка\n\n', null), 'заметка');
  assert.equal(tp.applyRecurrenceToNotes('повтор: будни\n\nтекст\n\n', null), 'текст');
});
