'use strict';

const { readJson, writeJson, dataPath } = require('./config');

/** @typedef {{ dates: string[] }} HabitHistory */
/** @typedef {{ habits: Record<string, HabitHistory> }} StreakStore */

/** @type {StreakStore | null} */
let storeCache = null;

function streaksFile() {
  return dataPath('streaks.json');
}

function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return todayIso(dt);
}

function loadStore() {
  if (storeCache) return storeCache;
  /** @type {StreakStore} */
  const store = readJson(streaksFile(), { habits: {} });
  if (!store.habits || typeof store.habits !== 'object') store.habits = {};
  storeCache = store;
  return store;
}

function saveStore(store) {
  storeCache = store;
  writeJson(streaksFile(), store);
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
    // Keep ~2 years of history
    if (habit.dates.length > 800) habit.dates = habit.dates.slice(-800);
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
 * Optimized: iterate backwards through sorted dates array instead of while+Set.
 * @param {string[]} dates sorted ascending unique
 * @param {string} today
 */
function computeStreak(dates, today = todayIso()) {
  if (!dates || dates.length === 0) return 0;
  
  const len = dates.length;
  const lastDate = dates[len - 1];
  
  // Если последняя дата не сегодня и не вчера — стрик прерван
  const yesterday = addDaysIso(today, -1);
  if (lastDate !== today && lastDate !== yesterday) return 0;
  
  let cursor = lastDate;
  let streak = 1;
  
  // Идем назад по массиву, проверяя непрерывность
  for (let i = len - 2; i >= 0; i--) {
    const expectedPrev = addDaysIso(cursor, -1);
    if (dates[i] === expectedPrev) {
      streak++;
      cursor = dates[i];
    } else {
      break;
    }
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
    // Full history for month calendar (capped in markCompleted).
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

module.exports = {
  todayIso,
  markCompleted,
  unmarkCompleted,
  removeHabit,
  getHabitStats,
  enrichHabits,
  loadStore,
};
