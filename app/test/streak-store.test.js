'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const streaks = require('../lib/streak-store');
const { getStorageEvents } = require('../lib/storage-status');
const { todayIso } = require('../lib/dates');
const { useTempDataRoot, read, readJsonFile, write } = require('./helpers/tmp-data');

const { datesToRuns, runsToDates, compactHabit, migrateStreaksToV1 } = streaks._format;

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
});
test.afterEach(() => env.cleanup());

const kinds = () => getStorageEvents().map((e) => e.kind);

/** n consecutive ISO dates ending `endOffset` days before today. */
function daysBack(n, endOffset = 0) {
  const out = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setDate(d.getDate() - endOffset - i);
    out.push(todayIso(d));
  }
  return out;
}

// ---- item 4: schema version + migration of the old format ------------------------------------

test('a legacy streaks.json (no schemaVersion) is migrated losslessly, with a backup of the original', () => {
  const legacy = {
    habits: {
      h1: { dates: ['2026-01-03', '2026-01-01', '2026-01-02', '2026-01-02', '2026-02-10'] },
      h2: { dates: [] },
    },
  };
  write(env.dir, 'streaks.json', legacy);

  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-02-10']);

  const onDisk = readJsonFile(env.dir, 'streaks.json');
  assert.equal(onDisk.schemaVersion, 1);
  assert.deepEqual(onDisk.habits.h1, { runs: [['2026-01-01', '2026-01-03'], ['2026-02-10', '2026-02-10']] });
  assert.equal(onDisk.habits.h2, undefined, 'empty habits are not stored');

  const dir = path.join(env.dir, 'backups', 'migrations');
  const [copy] = fs.readdirSync(dir);
  assert.match(copy, /^streaks\.json\.v0\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, copy), 'utf8')), legacy);
  assert.deepEqual(kinds(), ['migrated']);
});

test('migration keeps more than the old 800-date cap and drops only junk', () => {
  const dates = daysBack(1200, 30);
  // JSON.parse creates a real own "__proto__" key (an object literal would set the prototype)
  const hostile = JSON.parse('{"__proto__": {"dates": ["2026-01-01"]}}');
  write(env.dir, 'streaks.json', {
    habits: {
      long: { dates },
      junk: { dates: ['nope', '2026-13-40', 42, null, '2026-05-05'] },
      bad: 'not an object',
      ...hostile,
    },
  });
  const store = streaks.loadStore();
  assert.equal(store.habits.long.dates.length, 1200);
  assert.deepEqual(store.habits.junk.dates, ['2026-05-05']);
  assert.equal(store.habits.bad, undefined);
  assert.equal(Object.keys(store.habits).sort().join(), 'junk,long');
  assert.equal(({}).polluted, undefined);
});

test('a v0 file with a damaged shape ({ habits: [] }) does not crash', () => {
  write(env.dir, 'streaks.json', { habits: [1, 2] });
  assert.deepEqual(streaks.loadStore(), { habits: {} });
});

test('round trip: marking and unmarking persist through a reload', () => {
  streaks.markCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-02');
  streaks.markCompleted('h1', '2026-03-04');
  streaks.unmarkCompleted('h1', '2026-03-02');
  streaks.resetStreakCache();
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-04']);
  assert.deepEqual(readJsonFile(env.dir, 'streaks.json').habits.h1.runs, [
    ['2026-03-01', '2026-03-01'],
    ['2026-03-04', '2026-03-04'],
  ]);
});

test('markCompleted refuses values the loader would drop (bad date / bad id)', () => {
  streaks.markCompleted('h1', 'yesterday');
  streaks.markCompleted('bad id with spaces', '2026-03-01');
  assert.equal(fs.existsSync(path.join(env.dir, 'streaks.json')), false);
});

test('streak maths are unchanged by the new storage format', () => {
  const dates = daysBack(5);
  for (const d of dates) streaks.markCompleted('h1', d);
  streaks.resetStreakCache();
  const stats = streaks.getHabitStats('h1');
  assert.equal(stats.streak, 5);
  assert.equal(stats.completedToday, true);
  assert.deepEqual(stats.week.slice(-5), [true, true, true, true, true]);
});

// ---- item 5: last good copy --------------------------------------------------------------

test('every successful save refreshes streaks.json.bak', () => {
  streaks.markCompleted('h1', '2026-03-01');
  assert.equal(read(env.dir, 'streaks.json.bak'), read(env.dir, 'streaks.json'));
  streaks.markCompleted('h1', '2026-03-02');
  assert.deepEqual(readJsonFile(env.dir, 'streaks.json.bak').habits.h1.runs, [['2026-03-01', '2026-03-02']]);
});

test('a corrupt streaks.json is restored from the last good copy and the damaged one is kept', () => {
  streaks.markCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-02');
  fs.writeFileSync(path.join(env.dir, 'streaks.json'), '{"schemaVersion":1,"habits":{"h1":{"ru');
  streaks.resetStreakCache();
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-02']);
  assert.ok(fs.readdirSync(env.dir).some((n) => /^streaks\.json\.corrupt-\d+$/.test(n)));
  assert.deepEqual(kinds(), ['corrupt-quarantined', 'restored-from-backup']);
  // the restored file is valid on disk again
  assert.deepEqual(readJsonFile(env.dir, 'streaks.json').habits.h1.runs, [['2026-03-01', '2026-03-02']]);
});

test('a legacy (v0) .bak is migrated when the main file is damaged', () => {
  write(env.dir, 'streaks.json', '{broken');
  write(env.dir, 'streaks.json.bak', { habits: { h1: { dates: ['2026-04-01'] } } });
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-04-01']);
  assert.equal(readJsonFile(env.dir, 'streaks.json').schemaVersion, 1);
});

// ---- item 8: growth policy -----------------------------------------------------------------

test('runs: consecutive days collapse to one entry and expand back exactly', () => {
  const dates = ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-03'];
  const runs = datesToRuns(dates);
  assert.deepEqual(runs, [['2026-02-27', '2026-03-01'], ['2026-03-03', '2026-03-03']]);
  assert.deepEqual(runsToDates(runs), dates);
  // leap day and year boundary
  assert.deepEqual(datesToRuns(['2024-02-28', '2024-02-29', '2024-03-01']), [['2024-02-28', '2024-03-01']]);
  assert.deepEqual(datesToRuns(['2025-12-31', '2026-01-01']), [['2025-12-31', '2026-01-01']]);
});

test('runsToDates skips malformed or absurd runs instead of exploding', () => {
  assert.deepEqual(runsToDates([['2026-01-05', '2026-01-01'], ['x', 'y'], null, ['1970-01-01', '2200-01-01']]), []);
  assert.deepEqual(runsToDates('nope'), []);
});

test('a habit done every day for 3 years is stored as one run, not a thousand lines', () => {
  const dates = daysBack(1095);
  write(env.dir, 'streaks.json', { habits: { h1: { dates } } });
  streaks.loadStore();
  const text = read(env.dir, 'streaks.json');
  assert.ok(text.length < 400, `file is ${text.length} bytes`);
  assert.equal(streaks.getHabitStats('h1').completedDates.length, 1095);
});

test('history older than HISTORY_DAYS is archived by month, never silently dropped', () => {
  const today = '2026-06-15';
  const habit = {
    dates: ['2019-03-01', '2019-03-02', '2019-04-10', '2026-06-01', '2026-06-15'],
    archive: { '2019-03': 1 },
  };
  assert.equal(compactHabit(habit, today), true);
  assert.deepEqual(habit.dates, ['2026-06-01', '2026-06-15']);
  assert.deepEqual(habit.archive, { '2019-03': 3, '2019-04': 1 });
  assert.equal(compactHabit(habit, today), false, 'idempotent');
});

test('the cutoff is exactly HISTORY_DAYS back: the boundary day stays', () => {
  const today = '2026-06-15';
  const cutoff = new Date(Date.UTC(2026, 5, 15) - streaks.HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const before = new Date(Date.UTC(2026, 5, 15) - (streaks.HISTORY_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  const habit = { dates: [before, cutoff], archive: {} };
  compactHabit(habit, today);
  assert.deepEqual(habit.dates, [cutoff]);
  assert.equal(habit.archive[before.slice(0, 7)], 1);
});

test('the file stays small and bounded over a simulated decade of alternating-day completions', () => {
  // worst case for run-length storage: every other day for 10 years
  const dates = [];
  const start = Date.UTC(2016, 0, 1);
  for (let i = 0; i < 3650; i += 2) dates.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
  write(env.dir, 'streaks.json', { habits: { h1: { dates } } });
  const store = streaks.loadStore();
  assert.ok(store.habits.h1.dates.every((d) => d >= '2021'), 'old days are summarised');
  const archived = Object.values(store.habits.h1.archive).reduce((a, b) => a + b, 0);
  assert.equal(archived + store.habits.h1.dates.length, dates.length, 'every completion is accounted for');
  assert.ok(store.habits.h1.dates.length <= streaks.HISTORY_DAYS / 2 + 1);
  // saving after load keeps the archive and a second reload is stable
  streaks.markCompleted('h1', todayIso());
  streaks.resetStreakCache();
  const again = streaks.loadStore();
  assert.deepEqual(again.habits.h1.archive, store.habits.h1.archive);
});

// ---- export / merge (used by item 6) ----------------------------------------------------------

test('mergeHistory unites dates, keeps local ones, and is idempotent', () => {
  streaks.markCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-02');
  const incoming = { habits: { h1: { dates: ['2026-03-02', '2026-03-05'] }, h2: { dates: ['2026-01-01'] } } };
  const first = streaks.mergeHistory(incoming);
  assert.deepEqual(first, { habitsAdded: 1, habitsUpdated: 1, datesAdded: 2, rejected: 0 });
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-02', '2026-03-05']);
  const second = streaks.mergeHistory(incoming);
  assert.deepEqual(second, { habitsAdded: 0, habitsUpdated: 0, datesAdded: 0, rejected: 0 });
  streaks.resetStreakCache();
  assert.deepEqual(streaks.getHabitStats('h2').completedDates, ['2026-01-01']);
});

test('mergeHistory validates input: bad ids, bad dates and wrong shapes are rejected', () => {
  const res = streaks.mergeHistory(
    JSON.parse(
      '{"habits":{"ok":{"dates":["2026-03-01","garbage",7]},"__proto__":{"dates":["2026-03-01"]},"a b":{"dates":["2026-03-01"]},"str":"x"}}'
    )
  );
  assert.equal(res.habitsAdded, 1);
  assert.equal(res.rejected, 3);
  assert.deepEqual(streaks.getHabitStats('ok').completedDates, ['2026-03-01']);
  assert.deepEqual(streaks.mergeHistory(null), { habitsAdded: 0, habitsUpdated: 0, datesAdded: 0, rejected: 0 });
  assert.deepEqual(streaks.mergeHistory({ habits: 'x' }), { habitsAdded: 0, habitsUpdated: 0, datesAdded: 0, rejected: 0 });
});

test('archive counts merge by maximum so importing the same backup twice never inflates them', () => {
  streaks.mergeHistory({ habits: { h1: { dates: [], archive: { '2019-03': 10 } } } });
  streaks.mergeHistory({ habits: { h1: { dates: [], archive: { '2019-03': 10 } } } });
  streaks.mergeHistory({ habits: { h1: { dates: [], archive: { '2019-03': 4, '2019-04': 2 } } } });
  assert.deepEqual(streaks.exportHistory().habits.h1.archive, { '2019-03': 10, '2019-04': 2 });
});

test('exportHistory is plain dates (no run encoding) and skips empty habits', () => {
  streaks.markCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-02');
  streaks.getHabitStats('empty'); // creates an in-memory entry only
  assert.deepEqual(streaks.exportHistory(), { habits: { h1: { dates: ['2026-03-01', '2026-03-02'] } } });
});

test('migrateStreaksToV1 is a pure function', () => {
  const input = { habits: { h1: { dates: ['2026-01-02', '2026-01-01'] } } };
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(migrateStreaksToV1(input), { habits: { h1: { runs: [['2026-01-01', '2026-01-02']] } } });
  assert.deepEqual(input, copy);
});
