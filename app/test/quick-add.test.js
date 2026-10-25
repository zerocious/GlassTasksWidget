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

test('decimals, versions and addresses are not dates', () => {
  for (const s of [
    'Купить 1.5 л молока',
    'Прочитать главу 3.4',
    'Обновить до 10.12.1',
    'Настроить роутер 192.168.1.1',
  ]) {
    assert.deepEqual(p(s), { title: s, dueKey: null, time: null, recurrence: null }, s);
  }
});

test('a date after something that only looks like one is still found', () => {
  assert.deepEqual(p('Оплатить 2.50 и сдать 12.11'), {
    title: 'Оплатить 2.50 и сдать', dueKey: '2026-11-12', time: null, recurrence: null,
  });
});

test('ranges and hyphenated words are left in the title', () => {
  for (const s of [
    'Встреча 10:00-12:00',
    'Встреча 10:00 - 12:00',
    'Отпуск 12.10–15.10',
    'Купить ср-во от комаров',
    'Ошибка в логе 12:30:45',
  ]) {
    assert.deepEqual(p(s), { title: s, dueKey: null, time: null, recurrence: null }, s);
  }
});

test('a score or a chapter:verse is not a clock time', () => {
  for (const s of ['Счёт матча 2:10 записать', 'Записать счет 3:15', 'Прочитать Глава 3:16']) {
    assert.deepEqual(p(s), { title: s, dueKey: null, time: null, recurrence: null }, s);
  }
  assert.equal(p('Матч в 19:00').time, '19:00');
  assert.equal(p('Счёт выставить в 10:30').time, '10:30');
  assert.equal(p('Зарядка 7:00').time, '07:00');
});

test('a range in words («с 9:00 до 18:00») stays in the title', () => {
  for (const s of ['С 9:00 до 18:00 работа', 'Приём с 9:00 по 13:00', 'Отпуск с 12.10 по 15.10', 'Акция от 01.11 до 15.11']) {
    assert.deepEqual(p(s), { title: s, dueKey: null, time: null, recurrence: null }, s);
  }
  assert.deepEqual(p('Работа завтра с 9:00 до 18:00'), {
    title: 'Работа с 9:00 до 18:00', dueKey: '2026-10-08', time: null, recurrence: null,
  });
  assert.equal(p('Сдать до 12.10').dueKey, '2026-10-12');
  assert.equal(p('Купить 2 кг до 5.11').dueKey, '2026-11-05');
});

test('«с 9:00» alone is a start time and leaves no dangling «с»', () => {
  assert.deepEqual(p('Работа с 9:00 завтра'), {
    title: 'Работа', dueKey: '2026-10-08', time: '09:00', recurrence: null,
  });
});
