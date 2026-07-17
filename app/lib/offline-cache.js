'use strict';

const { readJson, writeJson, dataPath } = require('./config');

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
  writeJson(cacheFile(), slim);
}

/**
 * @returns {object | null}
 */
function loadOfflineCache() {
  const raw = readJson(cacheFile(), null);
  if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.habits)) return null;
  return raw;
}

function clearOfflineCache() {
  const fs = require('fs');
  const file = cacheFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    writeJson(file, { tasks: [], habits: [] });
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
    list = list.filter((item) => item && item.id !== taskId);
  } else {
    list = list.map((item) =>
      item && item.id === taskId ? { ...item, ...patch } : item
    );
  }
  saveOfflineCache({ ...cached, mode: 'google', [key]: list });
}

module.exports = {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
};
