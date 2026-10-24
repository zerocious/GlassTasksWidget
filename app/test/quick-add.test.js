'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQuickAdd } = require('../lib/quick-add');

// Wednesday, 2026-10-07, 10:00 local.
const NOW = new Date(2026, 9, 7, 10, 0);
const p = (s) => parseQuickAdd(s, NOW);

test('plain titles are untouched', () => {
  assert.deepEqual(p('Купить молоко'), { title: 'Купить молоко', dueKey: null, time: null, recurrence: null });
});

test('relative days and time', () => {
  assert.deepEqual(p('Позвонить маме завтра в 18:30'), {
    title: 'Позвонить маме', dueKey: '2026-10-08', time: '18:30', recurrence: null,
  });
  assert.equal(p('Отчёт послезавтра').dueKey, '2026-10-09');
  assert.equal(p('Сегодня созвон').title, 'созвон');
  assert.equal(p('Отпуск через неделю').dueKey, '2026-10-14');
  assert.equal(p('Анализы через 3 дня').dueKey, '2026-10-10');
});

test('weekdays resolve to the next occurrence, today included', () => {
  assert.equal(p('Отчёт в пятницу').dueKey, '2026-10-09');
  assert.equal(p('Встреча в среду').dueKey, '2026-10-07');
  assert.equal(p('Встреча во вторник').dueKey, '2026-10-13');
  assert.equal(p('Спортзал пн').dueKey, '2026-10-12');
});

test('explicit dates; past day without a year rolls to next year', () => {
  assert.equal(p('Сдать до 12.10').dueKey, '2026-10-12');
  assert.equal(p('Налог 01.03.2027').dueKey, '2027-03-01');
  assert.equal(p('Годовщина 05.10').dueKey, '2027-10-05');
  assert.deepEqual(p('Версия 31.02').dueKey, null);
});

test('time alone or repeat alone means starting today', () => {
  assert.deepEqual(p('Зарядка каждый день 7:00'), {
    title: 'Зарядка', dueKey: '2026-10-07', time: '07:00', recurrence: 'daily',
  });
  assert.equal(p('Стендап по будням').recurrence, 'weekdays');
  assert.equal(p('Уборка еженедельно').recurrence, 'weekly');
  assert.equal(p('Созвон 9:05').dueKey, '2026-10-07');
});

test('words that merely contain a keyword are not parsed', () => {
  assert.deepEqual(p('Завтрак с командой'), { title: 'Завтрак с командой', dueKey: null, time: null, recurrence: null });
  assert.equal(p('Свести вторники').dueKey, null);
});

test('a title made only of keywords is kept as-is', () => {
  assert.deepEqual(p('завтра'), { title: 'завтра', dueKey: null, time: null, recurrence: null });
});

test('invalid clock values are left in the title', () => {
  assert.deepEqual(p('Счёт 25:99'), { title: 'Счёт 25:99', dueKey: null, time: null, recurrence: null });
});

// Saturday, 2026-10-24, 10:00 local.
const SAT = new Date(2026, 9, 24, 10, 0);
const ps = (s) => parseQuickAdd(s, SAT);

test('«по будням» entered at a weekend starts on Monday', () => {
  assert.deepEqual(ps('Стендап по будням 9:30'), {
    title: 'Стендап', dueKey: '2026-10-26', time: '09:30', recurrence: 'weekdays',
  });
  assert.equal(parseQuickAdd('Стендап по будням', new Date(2026, 9, 25, 10, 0)).dueKey, '2026-10-26');
  assert.equal(ps('Уборка еженедельно').dueKey, '2026-10-24');
  assert.equal(ps('Созвон 9:05').dueKey, '2026-10-24');
});
