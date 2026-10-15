'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const streaks = require('../lib/streak-store');
const { todayIso, addDaysIso } = require('../lib/dates');
const { freshDataRoot, writeRaw, readRaw } = require('./helpers/storage');

/** n consecutive days ending today */
function lastDays(n, today = todayIso()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDaysIso(today, -i));
  return out;
}

test('streaks.json without schemaVersion (v0 dates lists) migrates losslessly', () => {
  const root = freshDataRoot();
  const legacyDates = lastDays(40);
  writeRaw(root, 'streaks.json', {
    habits: {
      h1: { dates: legacyDates },
      h2: { dates: ['2026-02-30', 'garbage', 42, addDaysIso(todayIso(), -1)] }, // junk is dropped
      h3: { dates: [] },
      broken: null,
    },
  });

  const stats = streaks.getHabitStats('h1');
  assert.equal(stats.streak, 40);
  assert.deepEqual(stats.completedDates, legacyDates);
  assert.deepEqual(streaks.loadStore().habits.h2.dates, [addDaysIso(todayIso(), -1)]);

  const onDisk = readRaw(root, 'streaks.json');
  assert.equal(onDisk.schemaVersion, 1);
  assert.ok(onDisk.habits.h1.months, 'stored as month bitmasks');
  assert.equal(onDisk.habits.h3, undefined, 'empty habits are not stored');
  // Original kept next to it, untouched.
  assert.deepEqual(readRaw(root, 'streaks.json.v0.bak').habits.h1.dates, legacyDates);
  assert.ok(fs.existsSync(path.join(root, 'streaks.json.bak')));

  // A fresh process sees the same history.
  streaks.resetStreakCache();
  assert.deepEqual(streaks.loadStore().habits.h1.dates, legacyDates);
});

test('encode/decode round-trip covers month edges and leap days', () => {
  const dates = ['2024-02-29', '2025-01-01', '2025-01-31', '2025-12-31', '2026-03-15'];
  const encoded = streaks.encodeStore({ habits: { h: { dates } } }, '2026-10-14');
  assert.deepEqual(encoded.habits.h.months['2025-01'], 1 | (1 << 30));
  assert.deepEqual(streaks.decodeStore(encoded).habits.h.dates, dates);
});

test('decode unions months and a dates list (file touched by an older build)', () => {
  const store = streaks.decodeStore({
    habits: { h: { months: { '2026-10': 0b11 }, dates: ['2026-10-02', '2026-10-05'] } },
  });
  assert.deepEqual(store.habits.h.dates, ['2026-10-01', '2026-10-02', '2026-10-05']);
  // Invalid month keys / masks are ignored rather than crashing.
  assert.deepEqual(streaks.decodeStore({ habits: { h: { months: { '2026-13': 1, x: 1, '2026-01': -5 } } } }).habits.h.dates, []);
});

test('growth limit: history older than 10 years is dropped on save', () => {
  const today = '2026-10-14';
  const encoded = streaks.encodeStore(
    { habits: { old: { dates: ['2015-01-01', '2016-10-31'] }, mixed: { dates: ['2016-10-31', '2016-11-01', '2026-10-14'] } } },
    today
  );
  assert.equal(streaks.HISTORY_MONTHS, 120);
  assert.equal(encoded.habits.old, undefined, 'a habit with nothing left in the window disappears');
  assert.deepEqual(Object.keys(encoded.habits.mixed.months), ['2016-11', '2026-10']);
});

test('growth: 10 years of daily habits stay small (vs ~1.5 MB as a dates list)', () => {
  const root = freshDataRoot();
  const habits = {};
  const days = lastDays(3600); // ~10 years, inside the 120-month window
  for (let i = 0; i < 20; i += 1) habits[`habit-${i}`] = { dates: days };
  writeRaw(root, 'streaks.json', { habits });
  const legacyBytes = fs.statSync(path.join(root, 'streaks.json')).size;

  streaks.markCompleted('habit-0'); // load + migrate + save
  const bytes = fs.statSync(path.join(root, 'streaks.json')).size;
  assert.ok(legacyBytes > 1_000_000, `legacy size ${legacyBytes}`);
  assert.ok(bytes < 70_000, `compact size ${bytes}`);
  // The widget still gets the same recent history as before (capped list).
  assert.equal(streaks.getHabitStats('habit-1').completedDates.length, 800);
  assert.equal(streaks.getHabitStats('habit-1').streak, 3600);
});

test('mergeHistory only adds days (import of an older export never removes progress)', () => {
  freshDataRoot();
  streaks.markCompleted('h', '2026-10-01');
  streaks.markCompleted('h', '2026-10-03');
  const result = streaks.mergeHistory({ habits: { h: { dates: ['2026-10-02', '2026-10-03'] }, other: { dates: ['2026-09-01'] } } });
  assert.deepEqual(result, { habits: 2, daysAdded: 2 });
  assert.deepEqual(streaks.loadStore().habits.h.dates, ['2026-10-01', '2026-10-02', '2026-10-03']);
  streaks.resetStreakCache();
  assert.deepEqual(streaks.loadStore().habits.other.dates, ['2026-09-01']);
  assert.deepEqual(streaks.mergeHistory({ habits: { h: { dates: ['2026-10-01'] } } }), { habits: 0, daysAdded: 0 });
});

test('mark / unmark / remove still persist through the new format', () => {
  const root = freshDataRoot();
  const today = todayIso();
  assert.equal(streaks.markCompleted('h').completedToday, true);
  streaks.resetStreakCache();
  assert.equal(streaks.getHabitStats('h').completedToday, true);
  streaks.unmarkCompleted('h');
  streaks.resetStreakCache();
  assert.equal(streaks.getHabitStats('h').completedToday, false);
  streaks.markCompleted('gone', today);
  streaks.removeHabit('gone');
  assert.equal(readRaw(root, 'streaks.json').habits.gone, undefined);
});

test('habit ids that name Object.prototype members are stored as plain entries', () => {
  const root = freshDataRoot();
  for (const id of ['toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    streaks.markCompleted(id, '2026-10-01');
  }
  const merged = streaks.mergeHistory({ habits: { isPrototypeOf: { dates: ['2026-10-02'] } } });
  assert.deepEqual(merged, { habits: 1, daysAdded: 1 });
  assert.equal(Object.prototype.toString.dates, undefined, 'built-ins untouched');
  assert.equal(Object.prototype.hasOwnProperty.dates, undefined);
  assert.equal({}.dates, undefined);
  streaks.resetStreakCache();
  const habits = readRaw(root, 'streaks.json').habits;
  assert.deepEqual(Object.keys(habits).sort(), ['__defineGetter__', 'hasOwnProperty', 'isPrototypeOf', 'toString', 'valueOf']);
  assert.equal(streaks.getHabitStats('toString').completedDates.length, 1);
  streaks.removeHabit('valueOf');
  assert.equal(Object.hasOwn(readRaw(root, 'streaks.json').habits, 'valueOf'), false);
});

test('days outside the kept window (older than 120 months, or in the future) are never loaded', () => {
  const today = '2026-10-14';
  const store = streaks.decodeStore(
    {
      habits: {
        h: {
          months: { '9999-12': 0x7fffffff, '2026-11': 1, '2026-10': 0x7fffffff, '2010-01': 1 },
          dates: ['2026-10-15', '2026-10-16', '3000-01-01', '2016-10-31'],
        },
      },
    },
    today
  );
  const dates = store.habits.h.dates;
  assert.ok(dates.every((d) => d >= '2016-11-01' && d <= '2026-10-15'), dates.join(','));
  assert.ok(dates.includes('2026-10-15'), 'tomorrow tolerated (time zones)');
  assert.equal(dates.includes('2026-10-16'), false);
  assert.equal(streaks.encodeStore({ habits: { h: { dates: ['2027-01-01', '2026-10-14'] } } }, today).habits.h.months['2027-01'], undefined);
});
