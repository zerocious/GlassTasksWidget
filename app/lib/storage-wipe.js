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

/** Data files the app writes; anything else in the folder is left alone. */
const OWN_FILES = new Set([
  'settings.json',
  'streaks.json',
  'reminders.json',
  'offline-cache.json',
  'mock-items.json',
  'tokens.json',
  'credentials.json',
]);
/**
 * Copies the storage layer makes next to a file, possibly chained: last good / migration /
 * unread copy, then a quarantine stamp, then a temp suffix (e.g. settings.json.bak.corrupt-1,
 * streaks.json.bak.123.456.tmp).
 */
const OWN_SUFFIX_RE = /^(?:\.bak|\.v\d+\.bak|\.unread-\d+\.bak)?(?:\.corrupt-\d+)?(?:\.\d+\.\d+\.tmp)?$/;
const BACKUP_FILE_RE = /^backup-\d{8}-\d{6}-(?:weekly|manual|pre-import)(?:-\d+)?\.json(?:\.\d+\.\d+\.tmp)?$/;

function isOwnDataFile(name) {
  for (const base of new Set([...OWN_FILES, ...listDocs().map((d) => d.spec.name)])) {
    if (name.startsWith(base) && OWN_SUFFIX_RE.test(name.slice(base.length))) return true;
  }
  return false;
}

/**
 * Refuse anything that is not our own `…/data` folder, and never follow a symlink or
 * junction out of it.
 */
function assertDataRoot(root) {
  const resolved = path.resolve(root);
  if (path.basename(resolved) !== 'data' || path.dirname(resolved) === resolved) {
    throw new Error(`Refusing to delete unexpected data folder: ${resolved}`);
  }
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    /* nothing there yet */
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw new Error(`Refusing to delete through a link: ${resolved}`);
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
 *   revoke: sign out at Google first (best effort; its string result is reported as `revoke`);
 *   session: Electron session to clear; resets: extra in-memory caches to drop;
 *   freeze: block all writes until restart (default).
 * @returns {Promise<{ removed: string[], kept: string[], failed: Array<{ path: string, error: string }>,
 *   chromiumCleared: boolean, revoke: string }>}
 *   kept: entries in the data folder that the app did not create (left untouched).
 */
async function wipeAllData(opts = {}) {
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {Array<{ path: string, error: string }>} */
  const failed = [];
  const root = assertDataRoot(getDataRoot());

  let revoke = 'none';
  if (opts.revoke) {
    try {
      const result = await opts.revoke();
      if (typeof result === 'string') revoke = result;
    } catch (err) {
      revoke = 'failed';
      console.warn('[wipe] revoke failed:', err && err.code ? err.code : 'error');
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

  // Antivirus / indexers lock files for a moment on Windows: retry like rmSync did.
  const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
  const withRetry = async (fn) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        if (!err || !RETRY_CODES.has(err.code) || attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  };
  const unlink = async (full, label) => {
    try {
      await withRetry(() => fs.unlinkSync(full));
      removed.push(label);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      // A secret that cannot be deleted is at least emptied. Written directly: writes through
      // the storage layer are frozen by now.
      if (/^(?:tokens|credentials)\.json$/.test(path.basename(full))) {
        try {
          fs.writeFileSync(full, '{}');
        } catch {
          /* reported below */
        }
      }
      failed.push({ path: label, error: (err && err.code) || String(err) });
    }
  };
  const rmdir = async (dir, label) => {
    try {
      await withRetry(() => fs.rmdirSync(dir));
      removed.push(label);
    } catch {
      /* foreign files remain: the folder stays */
    }
  };
  let entries = [];
  let rootExists = true;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    rootExists = false;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && isOwnDataFile(entry.name)) {
      await unlink(full, entry.name);
    } else if (entry.isDirectory() && entry.name === 'backups') {
      let backups = [];
      try {
        backups = fs.readdirSync(full, { withFileTypes: true });
      } catch (err) {
        // Keep going: the .env and Chromium steps below must still run.
        failed.push({ path: 'backups', error: (err && err.code) || String(err) });
      }
      for (const b of backups) {
        if (b.isFile() && BACKUP_FILE_RE.test(b.name)) await unlink(path.join(full, b.name), `backups/${b.name}`);
        else kept.push(`backups/${b.name}`);
      }
      await rmdir(full, 'backups');
    } else {
      kept.push(entry.name);
    }
  }
  if (rootExists) await rmdir(root, root);

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
  return { removed, kept, failed, chromiumCleared, revoke };
}

module.exports = { wipeAllData, assertDataRoot, isOwnDataFile };
