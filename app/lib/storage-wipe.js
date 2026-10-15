'use strict';

/**
 * «Delete all my data»: tokens (revoked at Google first), client keys, caches, habit history,
 * settings, reminders, backups, the demo lists, the legacy app-written .env and the
 * Chromium storage of the widget window.
 *
 * Deliberately NOT touched: the logs folder (owned by the logger), exports the user saved
 * elsewhere, and the application files themselves.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const core = require('./storage-core');
const { clearOfflineCache } = require('./offline-cache');
const { resetSettingsCache } = require('./settings-store');
const { resetStreakCache } = require('./streak-store');
const { recordStorageEvent } = require('./storage-status');

/** Marker the old plaintext .env writer left in the files it created. */
const APP_ENV_MARKER = 'Saved by the app UI';

/**
 * Refuse to empty anything that does not look like an app data folder
 * (a filesystem root, the home directory, or a path with fewer than three segments).
 */
function assertSafeToEmpty(dir) {
  const resolved = path.resolve(String(dir || ''));
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const unsafe =
    !dir ||
    resolved === parsed.root ||
    resolved === path.resolve(os.homedir()) ||
    segments.length < 3;
  if (unsafe) throw new Error(`Refusing to delete data in "${resolved}"`);
  return resolved;
}

/**
 * Delete everything inside `dir` (the folder itself stays).
 * @returns {{ deleted: string[], failed: string[] }}
 */
function emptyFolder(dir) {
  const root = assertSafeToEmpty(dir);
  const deleted = [];
  const failed = [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return { deleted, failed };
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      deleted.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { deleted, failed };
}

/** Remove a plaintext .env the old app version wrote (never a developer's own .env). */
function removeAppWrittenEnv() {
  const envPath = config.getCredentialsEnvPath();
  try {
    if (fs.readFileSync(envPath, 'utf8').includes(APP_ENV_MARKER)) {
      fs.unlinkSync(envPath);
      return true;
    }
  } catch {
    /* no such file */
  }
  return false;
}

/**
 * @param {{
 *   session?: { clearStorageData(): Promise<void>, clearCache(): Promise<void>, clearAuthCache?: () => Promise<void> } | null,
 *   revoke?: () => Promise<void>,
 * }} [deps]
 *   `session`: Electron session whose storage is cleared (cookies, localStorage, IndexedDB, cache).
 *   `revoke`: revoke the Google grant and drop tokens; defaults to google-auth's revokeAndClearTokens.
 * @returns {Promise<{ ok: boolean, deleted: string[], failed: string[], revoked: boolean, chromiumCleared: boolean }>}
 */
async function wipeAllData(deps = {}) {
  // 1. Tell Google to forget the grant while we still have the client keys (best effort, offline is fine).
  let revoked = false;
  try {
    const revoke = deps.revoke || require('./google-auth').revokeAndClearTokens;
    await revoke();
    revoked = true;
  } catch (err) {
    console.warn('[wipe] revoke failed:', err && err.message ? err.message : err);
  }

  // 2. Stop anything that could write the files back, then empty the in-memory copies.
  core.freezeWrites();
  clearOfflineCache();
  resetSettingsCache();
  resetStreakCache();
  config.resetEnvCache();
  core.forgetSecretMemory();

  // 3. Delete the data folder contents and the legacy .env.
  const { deleted, failed } = emptyFolder(config.getDataRoot());
  removeAppWrittenEnv();

  // 4. Chromium storage of the widget window.
  let chromiumCleared = false;
  if (deps.session) {
    try {
      await deps.session.clearStorageData();
      await deps.session.clearCache();
      if (typeof deps.session.clearAuthCache === 'function') await deps.session.clearAuthCache();
      chromiumCleared = true;
    } catch (err) {
      console.warn('[wipe] Chromium storage not cleared:', err && err.message ? err.message : err);
    }
  }

  recordStorageEvent('wiped');
  return { ok: failed.length === 0, deleted, failed, revoked, chromiumCleared };
}

module.exports = { wipeAllData, emptyFolder, assertSafeToEmpty, removeAppWrittenEnv };
