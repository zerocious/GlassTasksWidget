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
const plain = (s) => ({ title: s, dueKey: null, time: null, recurrence: null });

test('«каждый вторник» / «по средам» repeat weekly from that day', () => {
  assert.deepEqual(ps('Уборка каждый вторник'), {
    title: 'Уборка', dueKey: '2026-10-27', time: null, recurrence: 'weekly',
  });
  assert.deepEqual(ps('Йога каждую пятницу 19:00'), {
    title: 'Йога', dueKey: '2026-10-30', time: '19:00', recurrence: 'weekly',
  });
  assert.equal(ps('Уборка каждое воскресенье').dueKey, '2026-10-25');
  assert.deepEqual(p('Полив по средам'), {
    title: 'Полив', dueKey: '2026-10-07', time: null, recurrence: 'weekly',
  });
  assert.deepEqual(ps('Отчёт еженедельно по пятницам'), {
    title: 'Отчёт', dueKey: '2026-10-30', time: null, recurrence: 'weekly',
  });
});

test('weekday words and abbreviations inside ordinary text are not dates', () => {
  assert.deepEqual(ps('Настроить среду разработки'), plain('Настроить среду разработки'));
  assert.deepEqual(ps('Купить лампу 60 Вт'), plain('Купить лампу 60 Вт'));
  assert.deepEqual(ps('Купить ср-во для посуды'), plain('Купить ср-во для посуды'));
  assert.deepEqual(ps('Подать жалобу в ВС'), plain('Подать жалобу в ВС'));
  assert.equal(p('Созвон во вт').dueKey, '2026-10-13');
  assert.equal(p('Созвон В пт').dueKey, '2026-10-09');
  // «пн-пт» is the weekdays repeat.
  assert.deepEqual(ps('Зарядка пн-пт 7:00'), {
    title: 'Зарядка', dueKey: '2026-10-26', time: '07:00', recurrence: 'weekdays',
  });
});

test('title-case and capital weekday abbreviations still give the day', () => {
  assert.deepEqual(ps('Пн созвон'), { title: 'созвон', dueKey: '2026-10-26', time: null, recurrence: null });
  assert.equal(ps('Созвон Пт').dueKey, '2026-10-30');
  assert.deepEqual(ps('Пт: сдать отчёт'), { title: 'сдать отчёт', dueKey: '2026-10-30', time: null, recurrence: null });
  assert.equal(ps('ПТ сдать отчёт').dueKey, '2026-10-30');
  assert.equal(ps('Отчёт ВТ').dueKey, '2026-10-27');
  assert.equal(ps('Уборка Вс').dueKey, '2026-10-25');
  assert.equal(ps('Созвон 18:00 вт').dueKey, '2026-10-27');
  // Watts after a number in any case, the «ВС» / «СБ» acronyms and «пТ» stay in the title.
  assert.deepEqual(ps('Купить лампу 60 вт'), plain('Купить лампу 60 вт'));
  assert.deepEqual(ps('Купить лампу 60 ВТ'), plain('Купить лампу 60 ВТ'));
  assert.deepEqual(ps('Согласовать с СБ'), plain('Согласовать с СБ'));
  assert.deepEqual(ps('Созвон пТ'), plain('Созвон пТ'));
});

test('DD.MM.YY dates take the year', () => {
  assert.deepEqual(ps('Отчёт 01.11.27'), { title: 'Отчёт', dueKey: '2027-11-01', time: null, recurrence: null });
  assert.equal(ps('Сдать отчёт 15.11.26').title, 'Сдать отчёт');
  assert.equal(ps('Сдать 15.10.26').dueKey, '2026-10-15');
  assert.equal(ps('Отчёт 1.5.2027').dueKey, '2027-05-01');
  assert.deepEqual(ps('Сборка 01.11.202'), plain('Сборка 01.11.202'));
});

test('decimal numbers are not dates', () => {
  assert.deepEqual(ps('Купить молоко 2.5%'), plain('Купить молоко 2.5%'));
  assert.deepEqual(ps('Купить молоко 1.5 л'), plain('Купить молоко 1.5 л'));
  assert.deepEqual(ps('Обновить до 2.5'), plain('Обновить до 2.5'));
  assert.deepEqual(ps('Купить 1.10 кг яблок'), plain('Купить 1.10 кг яблок'));
  assert.deepEqual(ps('Скидка 12.10%'), plain('Скидка 12.10%'));
  assert.deepEqual(ps('Купить молоко 1.10 л'), plain('Купить молоко 1.10 л'));
});

test('a date before «м.» / «л.» and a name is still a date', () => {
  assert.deepEqual(ps('Встреча 15.11 м. Пушкинская'), {
    title: 'Встреча м. Пушкинская', dueKey: '2026-11-15', time: null, recurrence: null,
  });
  assert.equal(ps('Встреча 15.11 м Пушкинская').dueKey, '2026-11-15');
  assert.equal(ps('Встреча 30.10 л. Толстого').dueKey, '2026-10-30');
  assert.equal(ps('Встреча 5.11 м. Пушкинская').dueKey, '2026-11-05');
  assert.deepEqual(ps('До 15.11 сдать отчёт'), { title: 'сдать отчёт', dueKey: '2026-11-15', time: null, recurrence: null });
});

test('«в» / «на» before a dotted date leave the title too', () => {
  assert.deepEqual(ps('Встреча в 12.10'), { title: 'Встреча', dueKey: '2027-10-12', time: null, recurrence: null });
  assert.equal(ps('Встреча на 30.10').title, 'Встреча');
  assert.equal(ps('В 30.10 сдать отчёт').dueKey, '2026-10-30');
});

test('«по будням» entered at a weekend starts on Monday', () => {
  assert.deepEqual(ps('Стендап по будням 9:30'), {
    title: 'Стендап', dueKey: '2026-10-26', time: '09:30', recurrence: 'weekdays',
  });
  assert.equal(parseQuickAdd('Стендап по будням', new Date(2026, 9, 25, 10, 0)).dueKey, '2026-10-26');
  assert.equal(ps('Уборка еженедельно').dueKey, '2026-10-24');
  assert.equal(ps('Созвон 9:05').dueKey, '2026-10-24');
});
