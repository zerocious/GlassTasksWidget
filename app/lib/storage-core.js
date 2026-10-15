'use strict';

/**
 * Low-level file primitives for everything the widget keeps on disk: crash-safe writes,
 * JSON reads that never silently overwrite a damaged file, and secrets (OAuth tokens,
 * client secret) protected by Electron safeStorage (DPAPI on Windows).
 *
 * This module knows nothing about *where* data lives (that is lib/config.js) so that every
 * other storage module can build on it without import cycles.
 */

const fs = require('fs');
const path = require('path');
const { recordStorageEvent } = require('./storage-status');

/** How many `<name>.corrupt-<ts>` files are kept per original file. */
const CORRUPT_KEEP = 3;

function isPackaged() {
  try {
    const { app } = require('electron');
    return Boolean(app && app.isPackaged);
  } catch {
    return false; // plain node (tests)
  }
}

/** Newest-first list of `<base>.corrupt-<ts>` files next to `filePath`. */
function listCorruptCopies(filePath) {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.corrupt-`;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ name: n, ts: Number(n.slice(prefix.length)) || 0 }))
    .sort((a, b) => b.ts - a.ts)
    .map((e) => path.join(dir, e.name));
}

/**
 * Move an unparseable JSON file aside so the next save does not silently
 * overwrite whatever the user had (streak history, settings, tokens).
 * Only the newest CORRUPT_KEEP copies of each file are kept.
 * @returns {string | null} where the file went, or null when it could not be moved
 */
function quarantineCorruptFile(filePath, err) {
  const target = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, target);
    console.warn(`[config] corrupt JSON moved to ${target}:`, err && err.message ? err.message : err);
  } catch {
    // Read-only location (e.g. inside app.asar) — nothing to protect there.
    console.warn(`[config] corrupt JSON at ${filePath}:`, err && err.message ? err.message : err);
    return null;
  }
  for (const old of listCorruptCopies(filePath).slice(CORRUPT_KEEP)) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* ignore */
    }
  }
  return target;
}

/**
 * Read and parse a JSON file without side effects.
 * @param {string} filePath
 * @returns {{ state: 'missing' } | { state: 'ok', value: any, text: string } | { state: 'corrupt', error: unknown }}
 */
function readJsonStrict(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { state: 'missing' };
  }
  try {
    return { state: 'ok', value: JSON.parse(text), text };
  } catch (error) {
    return { state: 'corrupt', error };
  }
}

function readJson(filePath, fallback) {
  const res = readJsonStrict(filePath);
  if (res.state === 'ok') return res.value;
  if (res.state === 'corrupt') {
    if (quarantineCorruptFile(filePath, res.error)) {
      recordStorageEvent('corrupt-quarantined', path.basename(filePath));
    }
  }
  return fallback;
}

/**
 * Crash-safe write: temp file in the same directory, then rename over the target.
 * @param {string} filePath
 * @param {string} body
 * @param {fs.WriteFileOptions} [opts]
 */
function writeFileAtomic(filePath, body, opts = 'utf8') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, opts);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows: AV / indexer can briefly lock the target. Fall back to a direct write.
    try {
      fs.writeFileSync(filePath, body, opts);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    if (err && err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') {
      console.warn('[config] atomic rename failed:', err.message || err);
    }
  }
}

function writeJson(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------

const SECRET_ENVELOPE = 'glass-tasks/safeStorage@1';

/** @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorageLike */
/** @type {SafeStorageLike | null | undefined} */
let safeStorageOverride;

function getSafeStorage() {
  if (safeStorageOverride !== undefined) return safeStorageOverride;
  try {
    const { safeStorage } = require('electron');
    return safeStorage && typeof safeStorage.encryptString === 'function' ? safeStorage : null;
  } catch {
    return null;
  }
}

function canEncrypt() {
  const ss = getSafeStorage();
  try {
    return Boolean(ss && ss.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * Developer escape hatch: write secrets as plain JSON when safeStorage is missing
 * (e.g. running from source on Linux without a keyring). Ignored in packaged builds.
 */
function plaintextSecretsAllowed() {
  return !isPackaged() && process.env.GT_ALLOW_PLAINTEXT_SECRETS === '1';
}

/**
 * Secrets that could not be encrypted live here for the session: filePath -> JSON text.
 * They are never written to disk, so quitting the app forgets them (the user signs in again).
 * @type {Map<string, string>}
 */
const secretMemory = new Map();
/** Plaintext secret files already reported this session (one event per file). */
const reportedPlaintext = new Set();

function isEnvelope(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.format === SECRET_ENVELOPE);
}

/** Remove a leftover plaintext secrets file (never an encrypted one: it may decrypt later). */
function removePlaintextSecretFile(filePath) {
  const res = readJsonStrict(filePath);
  if (res.state === 'ok' && !isEnvelope(res.value)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Secrets (tokens, client secret) are encrypted with Electron safeStorage (DPAPI on Windows).
 * Without safeStorage they are NOT written in plain text: they stay in memory for this
 * session and a visible `secrets-memory-only` event is recorded (see GT_ALLOW_PLAINTEXT_SECRETS
 * for the developer opt-out).
 * @returns {{ persisted: boolean, encrypted: boolean }}
 */
function writeSecretJson(filePath, data) {
  const plain = JSON.stringify(data, null, 2);
  if (canEncrypt()) {
    try {
      const enc = getSafeStorage().encryptString(plain).toString('base64');
      writeFileAtomic(filePath, JSON.stringify({ format: SECRET_ENVELOPE, data: enc }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      secretMemory.delete(filePath);
      return { persisted: true, encrypted: true };
    } catch (err) {
      console.warn(`[config] encrypt ${path.basename(filePath)} failed:`, err && err.message ? err.message : err);
      // fall through to the memory-only path: never degrade to plain text on an error
    }
  } else if (plaintextSecretsAllowed()) {
    writeFileAtomic(filePath, plain, { encoding: 'utf8', mode: 0o600 });
    secretMemory.delete(filePath);
    return { persisted: true, encrypted: false };
  }
  const known = secretMemory.has(filePath);
  secretMemory.set(filePath, plain);
  // A stale plaintext copy (older version) would keep an outdated token on disk.
  removePlaintextSecretFile(filePath);
  if (!known) recordStorageEvent('secrets-memory-only', path.basename(filePath));
  return { persisted: false, encrypted: false };
}

/**
 * Read a file written by writeSecretJson. Plain-JSON files from older versions
 * are returned as-is and re-saved encrypted when possible.
 */
function readSecretJson(filePath, fallback) {
  if (secretMemory.has(filePath)) {
    const value = JSON.parse(/** @type {string} */ (secretMemory.get(filePath)));
    // Encryption came back (e.g. keyring unlocked): persist what was held in memory.
    if (canEncrypt()) {
      try {
        writeSecretJson(filePath, value);
      } catch {
        /* keep in memory */
      }
    }
    return value;
  }
  const raw = readJson(filePath, undefined);
  if (raw === undefined) return fallback;
  if (isEnvelope(raw)) {
    if (!canEncrypt()) {
      console.warn(`[config] cannot decrypt ${path.basename(filePath)}: safeStorage unavailable`);
      return fallback;
    }
    try {
      const plain = getSafeStorage().decryptString(Buffer.from(String(raw.data || ''), 'base64'));
      return JSON.parse(plain);
    } catch (err) {
      console.warn(`[config] decrypt ${path.basename(filePath)} failed:`, err && err.message ? err.message : err);
      return fallback;
    }
  }
  if (raw && typeof raw === 'object') {
    if (canEncrypt()) {
      try {
        writeSecretJson(filePath, raw);
      } catch {
        /* keep plaintext; retry next read */
      }
    } else if (!reportedPlaintext.has(filePath)) {
      reportedPlaintext.add(filePath);
      recordStorageEvent('plaintext-secrets', path.basename(filePath));
    }
  }
  return raw;
}

/** Forget a secrets file everywhere: memory copy and file on disk. Throws if the file cannot be removed. */
function deleteSecretJson(filePath) {
  secretMemory.delete(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

/** Names of secrets files that exist only in memory right now. */
function memoryOnlySecretFiles() {
  return [...secretMemory.keys()].map((p) => path.basename(p));
}

/** Test hook: inject a fake safeStorage (null = unavailable, undefined = real). */
function setSafeStorageForTests(impl) {
  safeStorageOverride = impl;
}

/** Test hook: drop in-memory secrets and the "already reported" markers. */
function resetSecretMemoryForTests() {
  secretMemory.clear();
  reportedPlaintext.clear();
}

module.exports = {
  CORRUPT_KEEP,
  SECRET_ENVELOPE,
  isPackaged,
  quarantineCorruptFile,
  listCorruptCopies,
  readJsonStrict,
  readJson,
  writeJson,
  writeFileAtomic,
  readSecretJson,
  writeSecretJson,
  deleteSecretJson,
  memoryOnlySecretFiles,
  canEncrypt,
  plaintextSecretsAllowed,
  setSafeStorageForTests,
  resetSecretMemoryForTests,
};
