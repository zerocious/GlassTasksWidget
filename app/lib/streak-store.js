'use strict';

const { dataPath } = require('./config');
const { loadDoc, saveDoc } = require('./storage-files');
const { todayIso, addDaysIso } = require('./dates');

/**
 * streaks.json — the habit completion history (the most valuable data the widget owns).
 *
 * On disk (schemaVersion 1) a habit is stored as runs of consecutive days instead of one
 * line per day, so a habit done every day for years is a single entry:
 *   { "schemaVersion": 1, "habits": { "<id>": { "runs": [["2026-01-01", "2026-03-31"]], "archive": { "2019-03": 17 } } } }
 * Day-level history is kept for HISTORY_DAYS; completions older than that are rolled into
 * `archive` (completed days per month) instead of being dropped.
 * Before v1 the file was { habits: { id: { dates: ["YYYY-MM-DD", ...] } } } (no version,
 * silently capped at 800 dates) — migrated below, nothing is lost.
 *
 * @typedef {{ dates: string[], archive: Record<string, number> }} HabitHistory in memory
 * @typedef {{ habits: Record<string, HabitHistory> }} StreakStore
 */

/** Day-level history kept per habit (5 years); older days are summarised in `archive`. */
const HISTORY_DAYS = 1830;
/** Upper bound for a single run when reading a file (guards against a hand-edited huge range). */
const MAX_RUN_DAYS = 40000;
const MAX_HABIT_ID_LENGTH = 200;

/** @type {StreakStore | null} */
let storeCache = null;

function streaksFile() {
  return dataPath('streaks.json');
}

const MS_PER_DAY = 86400000;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Calendar-day number (days since 1970-01-01), independent of time zone and DST. */
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function isoFromDayNumber(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** A real calendar date in YYYY-MM-DD form (years 1970–2200). */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 2200) return false;
  return isoFromDayNumber(dayNumber(value)) === value;
}

/**
 * Habit ids come from Google Tasks (or the demo list): printable ASCII without spaces.
 * Anything else (control characters, prototype-polluting names) is rejected.
 */
function isValidHabitId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_HABIT_ID_LENGTH &&
    /^[\x21-\x7E]+$/.test(id) &&
    id !== '__proto__' &&
    id !== 'constructor' &&
    id !== 'prototype'
  );
}

/** Valid, unique, ascending dates out of arbitrary input. */
function cleanDates(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isIsoDate))].sort();
}

/** Ascending unique dates -> runs of consecutive days. */
function datesToRuns(dates) {
  /** @type {Array<[string, string]>} */
  const runs = [];
  let from = null;
  let prev = null;
  for (const d of dates) {
    if (from === null) {
      from = d;
    } else if (dayNumber(d) !== dayNumber(prev) + 1) {
      runs.push([from, prev]);
      from = d;
    }
    prev = d;
  }
  if (from !== null) runs.push([from, prev]);
  return runs;
}

/** Runs -> ascending unique dates. Malformed runs are skipped. */
function runsToDates(runs) {
  if (!Array.isArray(runs)) return [];
  const out = new Set();
  for (const run of runs) {
    if (!Array.isArray(run) || !isIsoDate(run[0]) || !isIsoDate(run[1])) continue;
    const a = dayNumber(run[0]);
    const b = dayNumber(run[1]);
    if (b < a || b - a >= MAX_RUN_DAYS) continue;
    for (let n = a; n <= b; n += 1) out.add(isoFromDayNumber(n));
  }
  return [...out].sort();
}

function cleanArchive(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [month, count] of Object.entries(raw)) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number.isInteger(count) && count > 0 && count <= 31) {
      out[month] = count;
    }
  }
  return out;
}

/**
 * Move days older than HISTORY_DAYS into the monthly archive.
 * @param {HabitHistory} habit
 * @param {string} [today]
 * @returns {boolean} true when something was moved
 */
function compactHabit(habit, today = todayIso()) {
  const cutoff = isoFromDayNumber(dayNumber(today) - HISTORY_DAYS);
  if (!habit.dates.length || habit.dates[0] >= cutoff) return false;
  const keepFrom = habit.dates.findIndex((d) => d >= cutoff);
  const old = keepFrom < 0 ? habit.dates : habit.dates.slice(0, keepFrom);
  habit.dates = keepFrom < 0 ? [] : habit.dates.slice(keepFrom);
  for (const d of old) {
    const month = d.slice(0, 7);
    habit.archive[month] = (habit.archive[month] || 0) + 1;
  }
  return true;
}

/**
 * v0 -> v1. Input: { habits: { id: { dates } } } (possibly damaged);
 * output: the v1 on-disk shape. Every valid date survives; junk entries are dropped.
 */
function migrateStreaksToV1(data) {
  /** @type {Record<string, { runs: Array<[string, string]>, archive?: Record<string, number> }>} */
  const habits = {};
  const old = isPlainObject(data.habits) ? data.habits : {};
  for (const [id, entry] of Object.entries(old)) {
    if (!isValidHabitId(id) || !isPlainObject(entry)) continue;
    const runs = datesToRuns(cleanDates(entry.dates));
    if (runs.length) habits[id] = { runs };
  }
  return { habits };
}

const STREAKS_SPEC = {
  name: 'streaks.json',
  file: streaksFile,
  version: 1,
  keepBak: true,
  migrations: { 1: migrateStreaksToV1 },
};

/**
 * @param {Record<string, any>} doc document as stored on disk
 * @returns {StreakStore}
 */
function fromDisk(doc) {
  /** @type {StreakStore} */
  const store = { habits: {} };
  if (!isPlainObject(doc.habits)) return store;
  for (const [id, entry] of Object.entries(doc.habits)) {
    if (!isValidHabitId(id) || !isPlainObject(entry)) continue;
    const dates = Array.isArray(entry.runs) ? runsToDates(entry.runs) : cleanDates(entry.dates);
    const habit = { dates, archive: cleanArchive(entry.archive) };
    compactHabit(habit);
    store.habits[id] = habit;
  }
  return store;
}

/** @param {StreakStore} store */
function toDisk(store) {
  /** @type {Record<string, any>} */
  const habits = {};
  for (const [id, habit] of Object.entries(store.habits)) {
    const runs = datesToRuns(habit.dates);
    const hasArchive = Object.keys(habit.archive).length > 0;
    if (!runs.length && !hasArchive) continue;
    habits[id] = hasArchive ? { runs, archive: habit.archive } : { runs };
  }
  return { habits };
}

function loadStore() {
  if (storeCache) return storeCache;
  const { data } = loadDoc(STREAKS_SPEC);
  storeCache = data ? fromDisk(data) : { habits: {} };
  return storeCache;
}

function saveStore(store) {
  for (const habit of Object.values(store.habits)) compactHabit(habit);
  saveDoc(STREAKS_SPEC, toDisk(store));
  storeCache = store;
}

/** Forget the in-memory copy so the next load reads the file again. */
function resetStreakCache() {
  storeCache = null;
}

function ensureHabit(store, habitId) {
  if (!store.habits[habitId]) store.habits[habitId] = { dates: [], archive: {} };
  return store.habits[habitId];
}

/**
 * Mark habit completed for a calendar day (local). Idempotent.
 * @param {string} habitId
 * @param {string} [isoDate]
 */
function markCompleted(habitId, isoDate = todayIso()) {
  const store = loadStore();
  const habit = ensureHabit(store, habitId);
  // Never persist something the loader would drop again.
  if (isIsoDate(isoDate) && isValidHabitId(habitId) && !habit.dates.includes(isoDate)) {
    habit.dates.push(isoDate);
    habit.dates.sort();
    saveStore(store);
  }
  return getHabitStats(habitId, store);
}

/**
 * Remove completion for a day (e.g. uncheck).
 * @param {string} habitId
 * @param {string} [isoDate]
 */
function unmarkCompleted(habitId, isoDate = todayIso()) {
  const store = loadStore();
  const habit = ensureHabit(store, habitId);
  habit.dates = habit.dates.filter((d) => d !== isoDate);
  saveStore(store);
  return getHabitStats(habitId, store);
}

/**
 * Consecutive days ending today or yesterday (if today not done yet, streak can still count yesterday).
 * @param {string[]} dates sorted ascending unique
 * @param {string} today
 */
function computeStreak(dates, today = todayIso()) {
  const set = new Set(dates);
  let cursor = set.has(today) ? today : addDaysIso(today, -1);
  if (!set.has(cursor)) return 0;
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDaysIso(cursor, -1);
  }
  return streak;
}

/**
 * Last 7 days rolling ending today (index 6 = today).
 * @param {string[]} dates
 * @param {string} today
 */
function weekStrip(dates, today = todayIso()) {
  const set = new Set(dates);
  /** @type {boolean[]} */
  const pills = [];
  for (let i = 6; i >= 0; i -= 1) {
    pills.push(set.has(addDaysIso(today, -i)));
  }
  return pills;
}

/**
 * Approximate ring progress from week completion (0–100).
 * @param {boolean[]} pills
 */
function ringPercent(pills) {
  const done = pills.filter(Boolean).length;
  return Math.round((done / 7) * 100);
}

function getHabitStats(habitId, store = loadStore()) {
  const habit = ensureHabit(store, habitId);
  const today = todayIso();
  const pills = weekStrip(habit.dates, today);
  return {
    habitId,
    streak: computeStreak(habit.dates, today),
    week: pills,
    ring: ringPercent(pills),
    completedToday: habit.dates.includes(today),
    // Day-level history for the month calendar (HISTORY_DAYS; older days live in `archive`).
    completedDates: habit.dates.slice(),
  };
}

/**
 * Enrich habit task items with local streak stats.
 * @param {Array<{ id: string }>} habits
 */
function enrichHabits(habits) {
  const store = loadStore();
  return habits.map((h) => {
    const stats = getHabitStats(h.id, store);
    return { ...h, ...stats };
  });
}

/**
 * Drop local streak history when a habit is deleted.
 * @param {string} habitId
 */
function removeHabit(habitId) {
  if (!habitId) return;
  const store = loadStore();
  if (!store.habits[habitId]) return;
  delete store.habits[habitId];
  saveStore(store);
}

/**
 * Whole history in a plain, version-independent shape for export / backup.
 * @returns {{ habits: Record<string, { dates: string[], archive?: Record<string, number> }> }}
 */
function exportHistory() {
  const store = loadStore();
  /** @type {Record<string, { dates: string[], archive?: Record<string, number> }>} */
  const habits = {};
  for (const [id, habit] of Object.entries(store.habits)) {
    const hasArchive = Object.keys(habit.archive).length > 0;
    if (!habit.dates.length && !hasArchive) continue;
    habits[id] = hasArchive
      ? { dates: habit.dates.slice(), archive: { ...habit.archive } }
      : { dates: habit.dates.slice() };
  }
  return { habits };
}

/**
 * Validate an exported history without applying it.
 * @param {unknown} raw `{ habits: { id: { dates | runs, archive? } } }`
 * @returns {{ habits: Record<string, HabitHistory>, rejected: number }}
 */
function parseHistory(raw) {
  /** @type {Record<string, HabitHistory>} */
  const habits = {};
  let rejected = 0;
  const src = isPlainObject(raw) && isPlainObject(raw.habits) ? raw.habits : {};
  for (const [id, entry] of Object.entries(src)) {
    if (!isValidHabitId(id) || !isPlainObject(entry)) {
      rejected += 1;
      continue;
    }
    const dates = Array.isArray(entry.runs) ? runsToDates(entry.runs) : cleanDates(entry.dates);
    const archive = cleanArchive(entry.archive);
    if (dates.length || Object.keys(archive).length) habits[id] = { dates, archive };
  }
  return { habits, rejected };
}

/**
 * Merge imported history into the local one: completion days are united (never removed),
 * archived month counts take the larger value (importing the same file twice changes nothing).
 * @param {unknown} raw see parseHistory
 * @returns {{ habitsAdded: number, habitsUpdated: number, datesAdded: number, rejected: number }}
 */
function mergeHistory(raw) {
  const { habits: incoming, rejected } = parseHistory(raw);
  const store = loadStore();
  let habitsAdded = 0;
  let habitsUpdated = 0;
  let datesAdded = 0;
  let changed = false;
  for (const [id, inc] of Object.entries(incoming)) {
    const existed = Boolean(store.habits[id]) && (store.habits[id].dates.length > 0 || Object.keys(store.habits[id].archive).length > 0);
    const habit = ensureHabit(store, id);
    const before = habit.dates.length;
    const beforeArchive = JSON.stringify(habit.archive);
    habit.dates = [...new Set([...habit.dates, ...inc.dates])].sort();
    for (const [month, count] of Object.entries(inc.archive)) {
      if (!habit.archive[month] || habit.archive[month] < count) habit.archive[month] = count;
    }
    const added = habit.dates.length - before;
    if (added > 0 || JSON.stringify(habit.archive) !== beforeArchive) {
      changed = true;
      datesAdded += added;
      if (existed) habitsUpdated += 1;
      else habitsAdded += 1;
    }
  }
  if (changed) saveStore(store);
  return { habitsAdded, habitsUpdated, datesAdded, rejected };
}

module.exports = {
  STREAKS_SPEC,
  HISTORY_DAYS,
  markCompleted,
  unmarkCompleted,
  removeHabit,
  getHabitStats,
  enrichHabits,
  loadStore,
  resetStreakCache,
  exportHistory,
  parseHistory,
  mergeHistory,
  /** Pure helpers, exposed for tests. */
  _format: { datesToRuns, runsToDates, compactHabit, migrateStreaksToV1, isIsoDate, isValidHabitId },
};
