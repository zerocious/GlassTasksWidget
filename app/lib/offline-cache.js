'use strict';

const { readJson, writeJson, dataPath } = require('./config');
const { reorderByIds } = require('./reorder-by-ids');

/** @type {object | null | undefined} undefined = not loaded yet */
let memoryCache = undefined;

function cacheFile() {
  return dataPath('offline-cache.json');
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
    habits: payload.habits || [],
  };
  memoryCache = slim;
  writeJson(cacheFile(), slim);
}

/**
 * @returns {object | null}
 */
function loadOfflineCache() {
  if (memoryCache !== undefined) return memoryCache;
  const raw = readJson(cacheFile(), null);
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
  const fs = require('fs');
  const file = cacheFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Placeholder without mode:google so loadOfflineCache ignores it.
    writeJson(file, { clearedAt: new Date().toISOString() });
  }
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
  let list = Array.isArray(cached[key]) ? cached[key].slice() : [];
  if (append) {
    list = [append, ...list.filter((item) => item && item.id !== append.id)];
  } else if (patch === null) {
    // Cascade: Google deletes subtasks with their parent.
    list = list.filter(
      (item) => item && item.id !== taskId && item.parent !== taskId
    );
  } else {
    list = list.map((item) =>
      item && item.id === taskId ? { ...item, ...patch } : item
    );
  }
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
  const list = Array.isArray(cached[key]) ? cached[key] : [];
  const next = reorderByIds(list, orderedIds, movedPatch);
  saveOfflineCache({ ...cached, mode: 'google', [key]: next });
}

module.exports = {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
  reorderOfflineCache,
};
