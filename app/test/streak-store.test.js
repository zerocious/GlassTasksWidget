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
  const encoded = streaks.encodeStore({ habits: { h: { dates } } });
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

test('growth limit: each habit keeps its newest 120 months with marks, whatever the date', () => {
  const months = [];
  for (let i = 0; i < 130; i += 1) {
    const d = new Date(2010, i, 5);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`);
  }
  const encoded = streaks.encodeStore({ habits: { busy: { dates: months }, sparse: { dates: ['1990-01-01', '2000-06-15'] } } });
  assert.equal(streaks.HISTORY_MONTHS, 120);
  const kept = Object.keys(encoded.habits.busy.months);
  assert.equal(kept.length, 120);
  assert.equal(kept[0], months[10].slice(0, 7), 'the 10 oldest months go');
  assert.deepEqual(Object.keys(encoded.habits.sparse.months), ['1990-01', '2000-06'], 'few marks: nothing to trim');
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

test('a change whose save failed is saved by the retry, not reported done from memory only', (t) => {
  const root = freshDataRoot();
  streaks.markCompleted('h', '2026-10-01');
  streaks.markCompleted('gone', '2026-10-01');
  const realOpen = fs.openSync;
  let failures = 0;
  t.mock.method(fs, 'openSync', function (p, ...rest) {
    if (failures > 0 && String(p).startsWith(path.join(root, 'streaks.json'))) {
      failures -= 1;
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    }
    return realOpen.call(this, p, ...rest);
  });
  const onDisk = () => streaks.decodeStore(readRaw(root, 'streaks.json')).habits;

  failures = 1;
  assert.throws(() => streaks.markCompleted('h', '2026-10-02'), /no space/);
  assert.deepEqual(streaks.loadStore().habits.h.dates, ['2026-10-01'], 'the cache still matches the file');
  assert.deepEqual(streaks.markCompleted('h', '2026-10-02').completedDates, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(onDisk().h.dates, ['2026-10-01', '2026-10-02'], 'the retry saved the day');

  failures = 1;
  assert.throws(() => streaks.mergeHistory({ habits: { h: { dates: ['2026-09-30'] } } }), /no space/);
  assert.deepEqual(streaks.mergeHistory({ habits: { h: { dates: ['2026-09-30'] } } }), { habits: 1, daysAdded: 1 });
  assert.ok(onDisk().h.dates.includes('2026-09-30'));

  failures = 1;
  assert.throws(() => streaks.removeHabit('gone'), /no space/);
  streaks.removeHabit('gone');
  assert.equal(onDisk().gone, undefined, 'the retry removed it from the file');
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

test('imports only accept days in the 120-month window up to tomorrow', () => {
  const raw = {
    habits: {
      h: {
        months: { '9999-12': 0x7fffffff, '2026-11': 1, '2026-10': 0x7fffffff, '2010-01': 1 },
        dates: ['2026-10-15', '2026-10-16', '3000-01-01', '2016-10-31'],
      },
    },
  };
  const dates = streaks.decodeStore(raw, { range: streaks.importRange('2026-10-14') }).habits.h.dates;
  assert.ok(dates.every((d) => d >= '2016-11-01' && d <= '2026-10-15'), dates.join(','));
  assert.ok(dates.includes('2026-10-15'), 'tomorrow tolerated (time zones)');
  assert.equal(dates.includes('2026-10-16'), false);
  // The user's own file is never filtered by date.
  assert.ok(streaks.decodeStore(raw).habits.h.dates.includes('9999-12-31'));
});

test('a wrong PC clock never costs history (behind: «future» days kept; ahead: nothing evicted)', (t) => {
  const root = freshDataRoot();
  const real = lastDays(400, '2026-10-14');
  writeRaw(root, 'streaks.json', { schemaVersion: 1, ...streaks.encodeStore({ habits: { h: { dates: real } } }) });

  t.mock.timers.enable({ apis: ['Date'], now: new Date(2021, 0, 10, 12) }); // CMOS reset: 5 years behind
  streaks.resetStreakCache();
  streaks.markCompleted('h');
  t.mock.timers.reset();
  streaks.resetStreakCache();
  let dates = streaks.loadStore().habits.h.dates;
  assert.ok(real.every((d) => dates.includes(d)), 'history survives a clock that is behind');

  t.mock.timers.enable({ apis: ['Date'], now: new Date(2041, 0, 10, 12) }); // 15 years ahead
  streaks.resetStreakCache();
  streaks.markCompleted('h');
  t.mock.timers.reset();
  streaks.resetStreakCache();
  dates = streaks.loadStore().habits.h.dates;
  assert.ok(real.every((d) => dates.includes(d)), 'history survives a clock that is ahead');
});
