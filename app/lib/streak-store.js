'use strict';

const { readJson, writeJson, dataPath } = require('./config');

/** @typedef {{ dates: string[] }} HabitHistory */
/** @typedef {{ habits: Record<string, HabitHistory> }} StreakStore */

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
  /** @type {StreakStore} */
  const store = readJson(streaksFile(), { habits: {} });
  if (!store.habits || typeof store.habits !== 'object') store.habits = {};
  return store;
}

function saveStore(store) {
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
 * Last 7 days Mon→Sun or rolling last 7 including today?
 * Demo uses a week strip of 7 pills — we use rolling last 7 days ending today (index 6 = today).
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

module.exports = {
  todayIso,
  markCompleted,
  unmarkCompleted,
  getHabitStats,
  enrichHabits,
  loadStore,
};
