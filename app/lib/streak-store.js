'use strict';

const { createJsonDoc } = require('./storage-doc');
const { todayIso, addDaysIso } = require('./dates');

/** @typedef {{ dates: string[] }} HabitHistory */
/** @typedef {{ habits: Record<string, HabitHistory> }} StreakStore in memory: sorted unique local days */

/**
 * streaks.json — the only copy of habit history (Google Tasks has no per-day log).
 *
 * Schema 1 (on disk): `{ habits: { [habitId]: { months: { 'YYYY-MM': mask } } } }`, where bit
 * (day − 1) of `mask` means «done that day». A daily habit costs ~20 bytes a month instead of
 * ~400 for a list of dates; merging two histories is a bitwise OR.
 * Schema 0 (before versioning): `{ habits: { [habitId]: { dates: ['YYYY-MM-DD', …] } } }`.
 * Decoding accepts both fields at once, so a file touched by an older build loses nothing.
 *
 * Growth limit: months older than HISTORY_MONTHS are dropped on save, and a habit with no
 * days left disappears, so the file is bounded by (habits × 120 months).
 */
const HISTORY_MONTHS = 120;
/** Days per habit sent to the widget (month calendar); the file keeps the full window. */
const UI_HISTORY_DAYS = 800;

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Object keys that would reach the prototype instead of a habit (crafted import files). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** @param {unknown} s @returns {boolean} real calendar day in YYYY-MM-DD form */
function isIsoDay(s) {
  const m = typeof s === 'string' ? ISO_DAY_RE.exec(s) : null;
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(m[1]), month);
}

/** First month kept: HISTORY_MONTHS months back from `today`'s month (inclusive). */
function oldestKeptMonth(today = todayIso()) {
  const [y, m] = today.split('-').map(Number);
  const index = y * 12 + (m - 1) - (HISTORY_MONTHS - 1);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * @param {Record<string, any>} raw file content (schema 0 or 1, without schemaVersion)
 * @returns {StreakStore}
 */
function decodeStore(raw) {
  /** @type {StreakStore} */
  const store = { habits: {} };
  const habits = raw && raw.habits && typeof raw.habits === 'object' ? raw.habits : {};
  for (const [habitId, entry] of Object.entries(habits)) {
    if (!habitId || UNSAFE_KEYS.has(habitId) || !entry || typeof entry !== 'object') continue;
    /** @type {Set<string>} */
    const days = new Set();
    if (entry.months && typeof entry.months === 'object') {
      for (const [key, mask] of Object.entries(entry.months)) {
        const m = MONTH_KEY_RE.exec(key);
        if (!m || !Number.isInteger(mask) || mask <= 0) continue;
        const last = daysInMonth(Number(m[1]), Number(m[2]));
        for (let day = 1; day <= last; day += 1) {
          if (mask & (1 << (day - 1))) days.add(`${key}-${String(day).padStart(2, '0')}`);
        }
      }
    }
    if (Array.isArray(entry.dates)) {
      for (const d of entry.dates) if (isIsoDay(d)) days.add(d);
    }
    store.habits[habitId] = { dates: [...days].sort() };
  }
  return store;
}

/**
 * @param {StreakStore} store
 * @param {string} [today] retention reference day
 * @returns {{ habits: Record<string, { months: Record<string, number> }> }}
 */
function encodeStore(store, today = todayIso()) {
  const oldest = oldestKeptMonth(today);
  /** @type {Record<string, { months: Record<string, number> }>} */
  const habits = {};
  for (const [habitId, entry] of Object.entries((store && store.habits) || {})) {
    /** @type {Record<string, number>} */
    const months = {};
    for (const d of (entry && Array.isArray(entry.dates) ? entry.dates : [])) {
      if (!isIsoDay(d)) continue;
      const key = d.slice(0, 7);
      if (key < oldest) continue;
      months[key] = (months[key] || 0) | (1 << (Number(d.slice(8)) - 1));
    }
    const keys = Object.keys(months).sort();
    if (!keys.length) continue;
    habits[habitId] = { months: Object.fromEntries(keys.map((k) => [k, months[k]])) };
  }
  return { habits };
}

const streaksDoc = createJsonDoc({
  name: 'streaks.json',
  label: 'история привычек',
  version: 1,
  lastGood: true,
  compact: true,
  defaults: () => ({ habits: {} }),
  migrations: {
    1: (legacy) => encodeStore(decodeStore(legacy)),
  },
});

/** @type {StreakStore | null} */
let storeCache = null;

function loadStore() {
  if (storeCache) return storeCache;
  storeCache = decodeStore(streaksDoc.read());
  return storeCache;
}

function saveStore(store) {
  streaksDoc.write(encodeStore(store));
  storeCache = store;
}

/** Forget the in-memory copy (after import / wipe) so the next load reads the file. */
function resetStreakCache() {
  storeCache = null;
}

/**
 * Add every day from `incoming` to the saved history (import / restore). Never removes days.
 * @param {StreakStore} incoming
 * @returns {{ habits: number, daysAdded: number }}
 */
function mergeHistory(incoming) {
  const store = loadStore();
  const normalized = decodeStore(incoming);
  let habits = 0;
  let daysAdded = 0;
  for (const [habitId, entry] of Object.entries(normalized.habits)) {
    const habit = ensureHabit(store, habitId);
    const before = habit.dates.length;
    const merged = new Set(habit.dates);
    for (const d of entry.dates) merged.add(d);
    if (merged.size === before) continue;
    habit.dates = [...merged].sort();
    habits += 1;
    daysAdded += habit.dates.length - before;
  }
  if (daysAdded) saveStore(store);
  return { habits, daysAdded };
}

function ensureHabit(store, habitId) {
  if (!store.habits[habitId]) store.habits[habitId] = { dates: [] };
  if (!Array.isArray(store.habits[habitId].dates)) store.habits[habitId].dates = [];
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
  if (!habit.dates.includes(isoDate)) {
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
    // Recent history for the month calendar (the file keeps up to HISTORY_MONTHS).
    completedDates: habit.dates.slice(-UI_HISTORY_DAYS),
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

module.exports = {
  HISTORY_MONTHS,
  markCompleted,
  unmarkCompleted,
  removeHabit,
  getHabitStats,
  enrichHabits,
  loadStore,
  mergeHistory,
  resetStreakCache,
  decodeStore,
  encodeStore,
  isIsoDay,
  streaksDoc,
};
