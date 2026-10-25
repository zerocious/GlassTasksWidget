'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { todayIso, addDaysIso } = require('../lib/dates');
const tp = require('../lib/task-parse');

const today = todayIso();
const dueOn = (key) => `${key}T00:00:00.000Z`;

test('todayIso / addDaysIso use local calendar days', () => {
  assert.equal(todayIso(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(addDaysIso('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysIso('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysIso('2026-01-01', -1), '2025-12-31');
});

test('timeFromNotes understands the supported phrasings', () => {
  assert.equal(tp.timeFromNotes('14:30'), '14:30');
  assert.equal(tp.timeFromNotes('позвонить в 9:05'), '09:05');
  assert.equal(tp.timeFromNotes('time: 7.45'), '07:45');
  assert.equal(tp.timeFromNotes('время 09.30\nещё текст'), '09:30');
  assert.equal(tp.timeFromNotes('25:00'), null);
  assert.equal(tp.timeFromNotes('без времени'), null);
  assert.equal(tp.timeFromNotes(null), null);
});

test('a clock time mentioned inside text is not the task time', () => {
  assert.equal(tp.timeFromNotes('Офис открыт 9:00-18:00'), null);
  assert.equal(tp.timeFromNotes('Глава 3:16'), null);
  assert.equal(tp.timeFromNotes('лог: 12:30:45 ошибка'), null);
  assert.equal(tp.timeFromNotes('ошибка в 12:30:45'), null);
  assert.equal(tp.timeFromNotes('купить хлеб\r\n  14:30 '), '14:30');
  assert.equal(tp.resolveTaskDueAt({ due: null, notes: 'МФЦ работает с 0:01 до 20:00' }), null);
});

test('clearing the time also removes a time phrase inside the notes', () => {
  const cleared = tp.applyDueTimeToNotes('время 14:30\nПозвонить в 15:00 Ивану\nномер: 123', null);
  assert.equal(cleared, 'Позвонить Ивану\nномер: 123');
  assert.equal(tp.resolveTaskTime({ notes: cleared }), null);
  assert.equal(tp.applyDueTimeToNotes('созвон в 25:00?', null), 'созвон в 25:00?');
});

test('resolveTaskTime ignores Google date-only (UTC midnight) dues', () => {
  assert.equal(tp.resolveTaskTime({ due: dueOn(today), notes: 'в 18:00' }), '18:00');
  const timed = '2026-03-10T15:20:00.000Z';
  const d = new Date(timed);
  assert.equal(tp.resolveTaskTime({ due: timed, notes: '' }), tp.formatHm(d.getHours(), d.getMinutes()));
});

test('applyDueTimeToNotes upserts and clears the managed line', () => {
  const withTime = tp.applyDueTimeToNotes('купить хлеб', '08:15');
  assert.equal(withTime, 'время 08:15\nкупить хлеб');
  assert.equal(tp.applyDueTimeToNotes(withTime, '09:00'), 'время 09:00\nкупить хлеб');
  assert.equal(tp.applyDueTimeToNotes(withTime, null), 'купить хлеб');
  assert.equal(tp.applyDueTimeToNotes('в 10:00\nтекст', null), 'текст');
});

test('normalizeDueTimeInput validates HH:MM', () => {
  assert.equal(tp.normalizeDueTimeInput('7:05'), '07:05');
  assert.equal(tp.normalizeDueTimeInput(''), null);
  assert.throws(() => tp.normalizeDueTimeInput('24:00'), /ЧЧ:ММ/);
  assert.throws(() => tp.normalizeDueTimeInput(930), /Некорректное/);
});

test('recurrence markers round-trip through notes', () => {
  const notes = tp.applyRecurrenceToNotes('время 08:00\nзаметка', 'weekdays');
  assert.equal(tp.parseRecurrence(notes), 'weekdays');
  assert.equal(tp.resolveTaskTime({ notes }), '08:00');
  const cleared = tp.applyRecurrenceToNotes(notes, null);
  assert.equal(tp.parseRecurrence(cleared), null);
  assert.equal(cleared, 'время 08:00\nзаметка');
  assert.equal(tp.normalizeRecurrenceInput('ежедневно'), 'daily');
  assert.equal(tp.normalizeRecurrenceInput('none'), null);
  assert.throws(() => tp.normalizeRecurrenceInput('monthly'), /Повтор/);
});

test('nextOccurrenceDue is always after today', () => {
  const longAgo = dueOn('2020-01-01');
  for (const rule of ['daily', 'weekdays', 'weekly']) {
    const next = tp.nextOccurrenceDue(longAgo, rule);
    assert.ok(tp.dueDateKey(next) > today, `${rule}: ${next}`);
  }
  assert.equal(tp.dueDateKey(tp.nextOccurrenceDue(dueOn(today), 'daily')), addDaysIso(today, 1));
});

test('a weekly task completed late keeps its weekday', () => {
  const next = (lateBy) => tp.dueDateKey(tp.nextOccurrenceDue(dueOn(addDaysIso(today, -lateBy)), 'weekly'));
  assert.equal(next(0), addDaysIso(today, 7));
  assert.equal(next(1), addDaysIso(today, 6));
  assert.equal(next(10), addDaysIso(today, 4));
  assert.equal(next(14), addDaysIso(today, 7));
});

test('weekdays recurrence skips Saturday and Sunday', () => {
  // 2026-10-09 is a Friday.
  assert.equal(tp.advanceDateKey('2026-10-09', 'weekdays'), '2026-10-12');
  assert.equal(tp.advanceDateKey('2026-10-10', 'weekdays'), '2026-10-12');
  assert.equal(tp.advanceDateKey('2026-10-12', 'weekdays'), '2026-10-13');
});

test('dueKindFor classifies by local calendar day', () => {
  assert.equal(tp.dueKindFor(dueOn(addDaysIso(today, -1)), false), 'overdue');
  assert.equal(tp.dueKindFor(dueOn(today), false), 'today');
  assert.equal(tp.dueKindFor(dueOn(addDaysIso(today, 3)), false), 'later');
  assert.equal(tp.dueKindFor(dueOn(today), true), null);
  assert.equal(tp.dueKindFor(null, false), null);
});

test('resolveTaskDueAt combines due day with notes time', () => {
  const at = tp.resolveTaskDueAt({ due: dueOn('2026-11-02'), notes: 'время 14:45' });
  assert.deepEqual(
    [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()],
    [2026, 10, 2, 14, 45]
  );
  assert.equal(tp.resolveTaskDueAt({ due: dueOn('2026-11-02'), notes: '' }), null);
});

test('the notes preview is cut between characters, never inside an emoji', () => {
  const meta = tp.formatMeta({ notes: `${'a'.repeat(36)}😀 конец строки для обрезки` });
  assert.equal(meta, `${'a'.repeat(36)}😀…`);
  assert.equal(tp.formatMeta({ notes: '😀'.repeat(40) }), '😀'.repeat(40));
});

test('formatMeta skips managed lines when previewing notes', () => {
  assert.equal(tp.formatMeta({ notes: 'время 10:00\nповтор: будни\nпервая строка' }), 'первая строка');
  assert.equal(tp.formatMeta({ due: dueOn(today), notes: '' }), 'Сегодня');
});
