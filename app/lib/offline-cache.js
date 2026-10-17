'use strict';

const fs = require('fs');
const { dataPath } = require('./config');
const { canEncrypt, plaintextSecretsAllowed } = require('./storage-core');
const { loadDoc, saveDoc, deleteDoc } = require('./storage-files');
const { applyItemPatch, reorderList } = require('./list-ops');

/**
 * offline-cache.json holds the last Google payload: task titles, notes and due dates, i.e.
 * personal data. It is therefore encrypted with safeStorage like the tokens; without
 * safeStorage it is kept in memory only (it is a copy of what Google has, so nothing is lost).
 *
 * Writes are debounced: a mutation only updates the in-memory copy and schedules one disk
 * write, so encryption and I/O never sit on the interactive path. The pending write is
 * flushed on quit (flushOfflineCache) and at process exit.
 */
const OFFLINE_SPEC = {
  name: 'offline-cache.json',
  file: cacheFile,
  version: 1,
  secret: true,
  pretty: false,
  // v0 -> v1: the file only gained schemaVersion.
  migrations: { 1: (d) => d },
};

/** Max age of an unsaved change. Short enough to lose little on a crash, long enough to coalesce bursts. */
const WRITE_DELAY_MS = 1500;

/** @type {object | null | undefined} undefined = not loaded yet */
let memoryCache = undefined;
let dirty = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let writeTimer = null;
let exitHookInstalled = false;

function cacheFile() {
  return dataPath('offline-cache.json');
}

function canPersist() {
  return canEncrypt() || plaintextSecretsAllowed();
}

/** Write the pending cache now (no-op when nothing changed). Never throws. */
function flushOfflineCache() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  if (!memoryCache || !canPersist()) return;
  try {
    saveDoc(OFFLINE_SPEC, memoryCache);
  } catch (err) {
    console.warn('[offline-cache] write failed:', err && err.message ? err.message : err);
  }
}

function scheduleWrite() {
  dirty = true;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', flushOfflineCache);
  }
  if (writeTimer) return;
  writeTimer = setTimeout(flushOfflineCache, WRITE_DELAY_MS);
  if (typeof writeTimer.unref === 'function') writeTimer.unref();
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
  scheduleWrite();
}

/**
 * @returns {object | null}
 */
function loadOfflineCache() {
  if (memoryCache !== undefined) return memoryCache;
  const { data: raw, status } = loadDoc(OFFLINE_SPEC);
  // Require google mode so a wiped/placeholder file is not treated as a real cache.
  if (
    !raw ||
    raw.mode !== 'google' ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.habits)
  ) {
    if (status !== 'unreadable') memoryCache = null; // retry later if the file was only locked
    return null;
  }
  memoryCache = raw;
  return raw;
}

function clearOfflineCache() {
  memoryCache = null;
  dirty = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  deleteDoc(OFFLINE_SPEC);
  if (fs.existsSync(cacheFile())) {
    try {
      // Could not delete: overwrite with a placeholder so loadOfflineCache ignores it.
      saveDoc(OFFLINE_SPEC, { clearedAt: new Date().toISOString() });
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Test hook: forget the in-memory copy and any pending write (does not touch the file). */
function resetOfflineCacheForTests() {
  memoryCache = undefined;
  dirty = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
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
  OFFLINE_SPEC,
  WRITE_DELAY_MS,
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  flushOfflineCache,
  resetOfflineCacheForTests,
  patchOfflineCache,
  reorderOfflineCache,
};
