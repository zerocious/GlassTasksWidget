'use strict';

const { createJsonDoc } = require('./storage-doc');
const { applyItemPatch, reorderList } = require('./list-ops');

/**
 * offline-cache.json — last live Google payload: task titles and notes, i.e. personal data.
 * Encrypted with safeStorage like the tokens; without it the cache lives in memory only
 * (no Google sign-in survives a restart then either, so nothing is lost).
 * Writes are debounced: a mutation updates memory and returns, the file follows ~0.4 s later
 * (bursts collapse into one write; electron/data-ipc.js flushes on quit).
 * Schema 1 = the slim payload below (schema 0 had the same fields, unencrypted).
 */
const cacheDoc = createJsonDoc({
  name: 'offline-cache.json',
  label: 'офлайн-кэш задач',
  version: 1,
  encrypt: true,
  compact: true,
  debounceMs: 400,
  defaults: () => ({}),
  migrations: {
    1: (d) => ({ ...d, habits: Array.isArray(d.habits) ? d.habits.map(slimHabit) : d.habits }),
  },
});

/** Per-day stats withHabits() recomputes from streaks.json on every load. */
const DERIVED_HABIT_FIELDS = ['habitId', 'streak', 'week', 'ring', 'completedToday', 'completedDates'];

/** @type {object | null | undefined} undefined = not loaded yet */
let memoryCache = undefined;

function slimHabit(habit) {
  if (!habit || typeof habit !== 'object') return habit;
  const out = { ...habit };
  for (const key of DERIVED_HABIT_FIELDS) delete out[key];
  return out;
}

/**
 * Persist last successful live widget payload (Google mode).
 * @param {object} payload
 */
function saveOfflineCache(payload) {
  if (!payload || payload.mode !== 'google') return;
  const slim = {
    savedAt: new Date().toISOString(),
    mode: 'google',
    tasksListName: payload.tasksListName,
    habitsListName: payload.habitsListName,
    accentColor: payload.accentColor,
    tasksListFound: payload.tasksListFound,
    habitsListFound: payload.habitsListFound,
    tasks: payload.tasks || [],
    // Streak history lives in streaks.json; copying it here doubled the file for nothing.
    habits: (payload.habits || []).map(slimHabit),
  };
  memoryCache = slim;
  cacheDoc.writeSoon(slim);
}

/**
 * @returns {object | null}
 */
function loadOfflineCache() {
  if (memoryCache !== undefined) return memoryCache;
  const raw = cacheDoc.read();
  // Require google mode so a wiped/placeholder file is not treated as a real cache.
  if (
    !raw ||
    raw.mode !== 'google' ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.habits)
  ) {
    memoryCache = null;
    return null;
  }
  memoryCache = raw;
  return raw;
}

function clearOfflineCache() {
  memoryCache = null;
  if (!cacheDoc.remove()) {
    // Locked file: placeholder without mode:google so loadOfflineCache ignores it.
    try {
      cacheDoc.write({ clearedAt: new Date().toISOString() });
    } catch {
      /* reported by the doc */
    }
  }
}

/** Forget the in-memory copy (wipe / tests) without touching the file. */
function resetOfflineCacheMemory() {
  memoryCache = undefined;
}

/**
 * Patch a single item in the offline cache after a successful Google mutation.
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {object | null} patch  null = remove item
 * @param {object | null} [append] new item to prepend
 */
function patchOfflineCache(listKind, taskId, patch, append = null) {
  const cached = loadOfflineCache();
  if (!cached) return;
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const list = applyItemPatch(cached[key], taskId, patch, append);
  saveOfflineCache({ ...cached, mode: 'google', [key]: list });
}

/**
 * Replace list order in offline cache (after Google tasks.move).
 * @param {'tasks' | 'habits'} listKind
 * @param {string[]} orderedIds
 * @param {{ id?: string, position?: string, parent?: string | null } | null} [movedPatch]
 */
function reorderOfflineCache(listKind, orderedIds, movedPatch = null) {
  const cached = loadOfflineCache();
  if (!cached || !Array.isArray(orderedIds) || !orderedIds.length) return;
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const next = reorderList(cached[key], orderedIds, movedPatch);
  saveOfflineCache({ ...cached, mode: 'google', [key]: next });
}

module.exports = {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
  reorderOfflineCache,
  resetOfflineCacheMemory,
  cacheDoc,
};
