'use strict';

/**
 * «Удалить все мои данные»: sign-in, Google keys, task cache, habit history, settings,
 * reminders, backups and Chromium storage. Logs (userData/logs) belong to the logger
 * and are not touched here.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  getDataRoot,
  getCredentialsEnvPath,
  freezeWrites,
  clearMemorySecrets,
  resetEnvCache,
} = require('./config');
const { listDocs } = require('./storage-doc');
const { clearStorageIssues } = require('./storage-events');
const { resetSettingsCache } = require('./settings-store');
const { resetStreakCache } = require('./streak-store');
const { resetOfflineCacheMemory } = require('./offline-cache');

/** Refuse to recursively delete anything that is not our own `…/data` folder. */
function assertDataRoot(root) {
  const resolved = path.resolve(root);
  if (path.basename(resolved) !== 'data' || path.dirname(resolved) === resolved) {
    throw new Error(`Refusing to delete unexpected data folder: ${resolved}`);
  }
  return resolved;
}

/**
 * @param {{
 *   revoke?: () => Promise<unknown>,
 *   session?: { clearStorageData: () => Promise<void>, clearCache: () => Promise<void> } | null,
 *   resets?: Array<() => unknown>,
 *   freeze?: boolean,
 * }} [opts]
 *   revoke: sign out at Google first (best effort); session: Electron session to clear;
 *   resets: extra in-memory caches to drop; freeze: block all writes until restart (default).
 * @returns {Promise<{ removed: string[], failed: Array<{ path: string, error: string }>, chromiumCleared: boolean }>}
 */
async function wipeAllData(opts = {}) {
  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{ path: string, error: string }>} */
  const failed = [];

  if (opts.revoke) {
    try {
      await opts.revoke();
    } catch (err) {
      console.warn('[wipe] revoke failed:', err && err.message ? err.message : err);
    }
  }

  // Cancel debounced writes first, then block new ones: a late timer must not recreate files.
  for (const doc of listDocs()) doc.remove();
  if (opts.freeze !== false) freezeWrites(true);
  clearMemorySecrets();
  resetEnvCache();
  resetSettingsCache();
  resetStreakCache();
  resetOfflineCacheMemory();
  for (const fn of opts.resets || []) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }

  const root = assertDataRoot(getDataRoot());
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    removed.push(root);
  } catch (err) {
    failed.push({ path: root, error: err && err.code ? err.code : String(err) });
  }

  // Keys an older version wrote to userData/.env. Never the developer's app/.env.
  const envPath = getCredentialsEnvPath();
  if (path.resolve(envPath) !== path.resolve(ROOT, '.env')) {
    try {
      fs.unlinkSync(envPath);
      removed.push(envPath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') failed.push({ path: envPath, error: err.code || String(err) });
    }
  }

  let chromiumCleared = false;
  if (opts.session) {
    try {
      await opts.session.clearStorageData();
      await opts.session.clearCache();
      chromiumCleared = true;
    } catch (err) {
      failed.push({ path: 'session', error: err && err.message ? err.message : String(err) });
    }
  }

  clearStorageIssues();
  return { removed, failed, chromiumCleared };
}

module.exports = { wipeAllData, assertDataRoot };
