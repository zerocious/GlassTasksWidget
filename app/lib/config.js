'use strict';

const fs = require('fs');
const path = require('path');
const { reportStorageIssue } = require('./storage-events');

const ROOT = path.join(__dirname, '..');

/** @type {ReturnType<typeof buildConfig> | null} */
let configCache = null;

function tryElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return null;
  }
}

/**
 * Writable data root. Packaged: %APPDATA%/glass-tasks-widget/data.
 * Dev: app/data, or <GT_USER_DATA_DIR>/data when an isolated profile is used
 * (main.js points userData there), so a dev run never touches another profile's data.
 */
/** @type {string | null} */
let dataRootOverride = null;

/** Test hook: point every store at a throw-away folder (null = back to the real one). */
function setDataRootForTests(dir) {
  dataRootOverride = dir || null;
}

function getDataRoot() {
  if (dataRootOverride) return dataRootOverride;
  const app = tryElectronApp();
  if (app && (app.isPackaged || process.env.GT_USER_DATA_DIR)) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(ROOT, 'data');
}

const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT'];
const DEFAULT_OAUTH_PORT = 42813;

/**
 * Keys a developer exported in the shell are read once and removed from process.env:
 * child processes (PowerShell toasts get `...process.env`) must never inherit the secret.
 * @type {Record<string, string>}
 */
const envInput = {};
for (const key of GOOGLE_ENV_KEYS) {
  if (typeof process.env[key] === 'string' && process.env[key].trim()) envInput[key] = process.env[key].trim();
  delete process.env[key];
}

/** Marker line in .env files the app itself wrote (pre-encryption versions). */
const APP_ENV_MARKER = 'Saved by the app UI';

/**
 * @param {string} text
 * @returns {Record<string, string>} only GOOGLE_ENV_KEYS
 */
function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!GOOGLE_ENV_KEYS.includes(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Google OAuth client the app signs in with. Lives only in this module:
 * the secret is handed out by getGoogleClientCredentials(), never via process.env.
 * @typedef {{ clientId: string, clientSecret: string, redirectPort: number | null,
 *   source: 'credentials.json' | '.env' | 'environment' }} GoogleClientCredentials
 */
/** @type {GoogleClientCredentials | null} */
let googleCredentials = null;
let credentialsLoaded = false;

/** @param {Record<string, string>} values @param {GoogleClientCredentials['source']} source */
function credentialsFromEnvValues(values, source) {
  const clientId = String(values.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(values.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const port = Math.round(Number(values.OAUTH_REDIRECT_PORT));
  return { clientId, clientSecret, redirectPort: Number.isFinite(port) && port > 0 ? port : null, source };
}

/**
 * Older versions wrote the client secret in plain text to %APPDATA%/…/.env.
 * Move it into the encrypted credentials.json and delete that .env.
 * Developer-authored .env files (no marker) are left untouched.
 */
function migrateAppWrittenEnv() {
  const envPath = getCredentialsEnvPath();
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(APP_ENV_MARKER) || !canEncrypt()) return;
  const values = parseEnvText(text);
  if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) return;
  try {
    if (!readSecretJson(getCredentialsJsonPath(), null)) {
      writeSecretJson(getCredentialsJsonPath(), {
        clientId: values.GOOGLE_CLIENT_ID,
        clientSecret: values.GOOGLE_CLIENT_SECRET,
        redirectPort: Number(values.OAUTH_REDIRECT_PORT) || null,
        updatedAt: new Date().toISOString(),
      });
    }
    fs.unlinkSync(envPath);
  } catch (err) {
    console.warn('[config] .env migration failed:', err && err.message ? err.message : err);
  }
}

/**
 * Port saved in credentials.json, or null for «choose a free one».
 * Older versions saved 42813 for everybody, and users with a Web-application client had
 * registered exactly that redirect URI, so a saved port is honoured (a busy one falls back to
 * a free port). Sign-in no longer trusts anything that reaches the port without our state.
 * @param {Record<string, any>} data parsed credentials.json
 * @returns {number | null}
 */
function savedPinnedPort(data) {
  const port = Math.round(Number(data && (data.redirectPort || data.OAUTH_REDIRECT_PORT)));
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** @returns {GoogleClientCredentials | null} */
function credentialsFromJson(data) {
  if (!data || typeof data !== 'object') return null;
  const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret.trim() : '';
  if (!clientId || !clientSecret) return null;
  // No saved port = pick a free loopback port per sign-in (Desktop clients accept any).
  return { clientId, clientSecret, redirectPort: savedPinnedPort(data), source: 'credentials.json' };
}

/** Preferred writable .env path (packaged/dev Electron: %APPDATA%/glass-tasks-widget/.env). */
function getCredentialsEnvPath() {
  const app = tryElectronApp();
  if (app) return path.join(app.getPath('userData'), '.env');
  return path.join(ROOT, '.env');
}

/** Structured credentials mirror under the writable data root. */
function getCredentialsJsonPath() {
  return dataPath('credentials.json');
}

function envCandidatePaths() {
  const candidates = [];
  const app = tryElectronApp();
  if (app) {
    candidates.push(path.join(app.getPath('userData'), '.env'));
    if (app.isPackaged) {
      candidates.push(path.join(path.dirname(process.execPath), '.env'));
    }
  }
  candidates.push(path.join(ROOT, '.env'));
  return candidates;
}

/** @returns {GoogleClientCredentials | null} */
function credentialsFromEnvFiles() {
  for (const p of envCandidatePaths()) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const found = credentialsFromEnvValues(parseEnvText(text), '.env');
    if (found) return found;
  }
  return null;
}

/**
 * Load the OAuth client once: encrypted credentials.json saved from the UI wins,
 * then a developer .env, then keys exported in the shell at startup.
 */
function loadEnvFile({ force = false } = {}) {
  if (credentialsLoaded && !force) return;
  credentialsLoaded = true;
  migrateAppWrittenEnv();
  googleCredentials =
    credentialsFromJson(readSecretJson(getCredentialsJsonPath(), null)) ||
    credentialsFromEnvFiles() ||
    credentialsFromEnvValues(envInput, 'environment');
  // Encrypted keys that safeStorage cannot open yet (Windows before app «ready»):
  // do not remember «no keys» for the whole session, look again next time.
  if (describeSecretFile(getCredentialsJsonPath()) === 'locked') credentialsLoaded = false;
}

/** Force re-read of credentials on next check. */
function resetEnvCache() {
  credentialsLoaded = false;
  googleCredentials = null;
}

/**
 * The only way to get the client secret.
 * @returns {{ clientId: string, clientSecret: string, redirectPort: number | null } | null}
 */
function getGoogleClientCredentials() {
  loadEnvFile();
  if (!googleCredentials) return null;
  const { clientId, clientSecret, redirectPort } = googleCredentials;
  return { clientId, clientSecret, redirectPort };
}

/** Printable ASCII without spaces — what Google issues for client id / secret. */
const CREDENTIAL_RE = /^[\x21-\x7E]{1,512}$/;

const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * Persist Desktop OAuth client credentials for the widget
 * to data/credentials.json (encrypted via safeStorage; memory-only when it is unavailable).
 * An empty secret with the current Client ID keeps the saved secret (settings form re-save).
 * @param {{ clientId: string, clientSecret: string, redirectPort?: number | string | null }} input
 *   redirectPort empty / null = choose a free port at each sign-in.
 */
function saveGoogleCredentials(input) {
  const clientId = String(input?.clientId || '').trim();
  let clientSecret = String(input?.clientSecret || '').trim();
  if (!clientSecret && clientId) {
    const current = getGoogleClientCredentials();
    if (current && current.clientId === clientId) clientSecret = current.clientSecret;
  }
  if (!clientId || !clientSecret) {
    throw new Error('Укажите Client ID и Client Secret');
  }
  if (!CREDENTIAL_RE.test(clientId) || !CREDENTIAL_RE.test(clientSecret)) {
    throw new Error('Client ID и Client Secret не должны содержать пробелов и переводов строк');
  }
  if (!clientId.endsWith(CLIENT_ID_SUFFIX)) {
    throw new Error(`Client ID должен заканчиваться на ${CLIENT_ID_SUFFIX} — похоже, вставлено не то поле.`);
  }
  const rawPort = input?.redirectPort;
  /** @type {number | null} */
  let redirectPort = null;
  if (rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== '' && Number(rawPort) !== 0) {
    redirectPort = Math.round(Number(rawPort));
    if (!Number.isFinite(redirectPort) || redirectPort < 1024 || redirectPort > 65535) {
      throw new Error('Порт redirect должен быть в диапазоне 1024–65535 (или оставьте поле пустым)');
    }
  }

  const stored = writeSecretJson(getCredentialsJsonPath(), {
    clientId,
    clientSecret,
    redirectPort,
    updatedAt: new Date().toISOString(),
  });

  credentialsLoaded = true;
  googleCredentials = { clientId, clientSecret, redirectPort, source: 'credentials.json' };

  return {
    configured: true,
    clientId,
    redirectPort,
    persisted: stored !== 'memory',
    jsonPath: getCredentialsJsonPath(),
  };
}

/**
 * @returns {{
 *   configured: boolean,
 *   clientId: string | null,
 *   redirectPort: number | null,
 *   source: string | null,
 *   envPath: string,
 *   jsonPath: string,
 * }}
 */
function getGoogleCredentialsStatus() {
  loadEnvFile();
  const creds = googleCredentials;
  return {
    configured: Boolean(creds),
    clientId: creds ? creds.clientId : null,
    // null = automatic (a free port is chosen at each sign-in).
    redirectPort: creds ? creds.redirectPort : null,
    source: creds ? creds.source : null,
    envPath: getCredentialsEnvPath(),
    jsonPath: getCredentialsJsonPath(),
  };
}

/**
 * Move an unparseable file aside so the next save does not silently
 * overwrite whatever the user had (streak history, settings, tokens).
 * @returns {string | null} where the file went (null when it could not be moved)
 */
function quarantineCorruptFile(filePath, err) {
  const target = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, target);
    console.warn(`[config] corrupt JSON moved to ${target}:`, err && err.message ? err.message : err);
    return target;
  } catch {
    // Read-only location (e.g. inside app.asar) — nothing to protect there.
    console.warn(`[config] corrupt JSON at ${filePath}:`, err && err.message ? err.message : err);
    return null;
  }
}

function readJson(filePath, fallback) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    // Notepad («UTF-8 with BOM») and PowerShell 5.1 `Set-Content -Encoding UTF8` start the
    // file with a BOM, which JSON.parse rejects: a hand-edited config.json is still valid.
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    quarantineCorruptFile(filePath, err);
    return fallback;
  }
}

/** Set by «delete all my data» until the app restarts: late timers must not recreate files. */
let writesFrozen = false;

/** @param {boolean} [on] */
function freezeWrites(on = true) {
  writesFrozen = Boolean(on);
}

const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 40;
/** Rename errors caused by another program holding the target open. */
const TARGET_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * Crash-safe write: temp file in the same directory, flushed to disk, then renamed over
 * the target. Without the flush a power cut after the rename can leave a zero-filled file.
 * A target that stays held by another program is written in place, flushed the same way.
 * @param {string} filePath
 * @param {string} body
 * @param {{ mode?: number }} [opts]
 */
function writeFileAtomic(filePath, body, opts = {}) {
  if (writesFrozen) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', opts.mode);
  try {
    fs.writeSync(fd, body, null, 'utf8');
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    unlinkQuiet(tmp);
    throw err;
  }
  fs.closeSync(fd);
  // Windows: AV / indexer can briefly hold the target open without delete sharing, which
  // blocks the rename but not a write. Ride out short locks first (≤ 240 ms, like reads).
  let renameError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      renameError = err;
      if (!err || !TARGET_LOCK_CODES.has(err.code) || attempt >= RENAME_RETRIES) break;
      sleepSync(RENAME_RETRY_MS * (attempt + 1));
    }
  }
  if (!renameError || !TARGET_LOCK_CODES.has(renameError.code)) {
    console.warn('[config] atomic rename failed:', renameError && renameError.message ? renameError.message : renameError);
  }
  // Still held: write the target in place, flushed like the temp file. The temp file is the
  // only complete copy while that write runs, so it goes only once the target is on disk.
  let target;
  try {
    target = fs.openSync(filePath, 'w', opts.mode);
  } catch (err) {
    unlinkQuiet(tmp); // the target was not touched
    throw err;
  }
  try {
    fs.writeSync(target, body, null, 'utf8');
    fs.fsyncSync(target);
  } finally {
    fs.closeSync(target);
  }
  unlinkQuiet(tmp);
}

function writeJson(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

const SECRET_ENVELOPE = 'glass-tasks/safeStorage@1';
/** Deliberately unencrypted secret (dev opt-in only, GT_ALLOW_PLAINTEXT_SECRETS=1). */
const PLAIN_ENVELOPE = 'glass-tasks/plain@1';
/** Schema of the secret payloads (tokens.json, credentials.json); 0 = legacy plain object. */
const SECRET_SCHEMA_VERSION = 1;

/** @type {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } | null | undefined} */
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

/** @param {string} text @returns {string} base64 ciphertext (throws when safeStorage is unavailable) */
function encryptText(text) {
  return getSafeStorage().encryptString(text).toString('base64');
}

/** @param {string} base64 @returns {string} */
function decryptText(base64) {
  return getSafeStorage().decryptString(Buffer.from(String(base64 || ''), 'base64'));
}

/** Dev escape hatch: let secrets hit the disk unencrypted when safeStorage is missing. */
function plaintextSecretsAllowed() {
  const app = tryElectronApp();
  return process.env.GT_ALLOW_PLAINTEXT_SECRETS === '1' && !(app && app.isPackaged);
}

/**
 * Secrets that could not be encrypted: kept for this session only, never written in clear.
 * @type {Map<string, string>} filePath → JSON text
 */
const memorySecrets = new Map();

/**
 * Secrets (tokens, client secret) are encrypted with Electron safeStorage (DPAPI on Windows).
 * Without safeStorage they stay in memory for this session (the user signs in again after a
 * restart) and the problem is reported, instead of landing on disk in plain text.
 * @returns {'encrypted' | 'plaintext' | 'memory'} where the data ended up
 */
function writeSecretJson(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  if (canEncrypt()) {
    const body = JSON.stringify({ format: SECRET_ENVELOPE, schemaVersion: SECRET_SCHEMA_VERSION, data: encryptText(json) });
    writeFileAtomic(filePath, body, { mode: 0o600 });
    memorySecrets.delete(filePath);
    return 'encrypted';
  }
  if (plaintextSecretsAllowed()) {
    const body = JSON.stringify({ format: PLAIN_ENVELOPE, schemaVersion: SECRET_SCHEMA_VERSION, data }, null, 2);
    writeFileAtomic(filePath, body, { mode: 0o600 });
    memorySecrets.delete(filePath);
    return 'plaintext';
  }
  const firstTime = !memorySecrets.has(filePath);
  memorySecrets.set(filePath, json);
  if (firstTime) {
    reportStorageIssue({
      kind: 'secrets-memory-only',
      file: path.basename(filePath),
      message:
        'Шифрование Windows (DPAPI) недоступно: ключи и вход Google сохранены только до закрытия виджета. После перезапуска войдите снова.',
    });
  }
  return 'memory';
}

/**
 * Read a file written by writeSecretJson. Plain-JSON files from older versions
 * are returned as-is and re-saved encrypted when possible.
 */
function readSecretJson(filePath, fallback) {
  if (memorySecrets.has(filePath)) return JSON.parse(/** @type {string} */ (memorySecrets.get(filePath)));
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Unlike other files, no .corrupt copy: a cut-off legacy plaintext secret would stay in
    // clear forever, and a broken token or key is useless anyway (sign in / import again).
    deleteSecretJson(filePath);
    reportStorageIssue({
      kind: 'secret-corrupt',
      file: path.basename(filePath),
      repeat: true,
      message: `${path.basename(filePath)} был повреждён и удалён. ${
        path.basename(filePath) === 'tokens.json' ? 'Войдите в Google снова.' : 'Загрузите ключи Google снова.'
      }`,
    });
    return fallback;
  }
  if (raw && typeof raw === 'object' && raw.format === SECRET_ENVELOPE) {
    if (!canEncrypt()) {
      reportStorageIssue({
        kind: 'locked',
        file: path.basename(filePath),
        message: `${path.basename(filePath)} зашифрован, а шифрование Windows сейчас недоступно: файл не тронут, вход Google и ключи недоступны до его восстановления.`,
      });
      return fallback;
    }
    try {
      return JSON.parse(decryptText(raw.data));
    } catch (err) {
      console.warn(`[config] decrypt ${path.basename(filePath)} failed:`, err && err.message ? err.message : err);
      return fallback;
    }
  }
  const plain = raw && typeof raw === 'object' && raw.format === PLAIN_ENVELOPE ? raw.data : raw;
  if (!plain || typeof plain !== 'object') return fallback;
  if (canEncrypt()) {
    try {
      writeSecretJson(filePath, plain);
    } catch {
      /* keep plaintext; retry next read */
    }
  } else if (!plaintextSecretsAllowed()) {
    reportStorageIssue({
      kind: 'plaintext-secret',
      file: path.basename(filePath),
      message: `${path.basename(filePath)} лежит на диске незашифрованным (сохранён старой версией), а шифрование сейчас недоступно. Файл будет зашифрован, как только DPAPI заработает.`,
    });
  }
  return plain;
}

/** Forget a secret everywhere: memory and disk. Never throws. */
function deleteSecretJson(filePath) {
  memorySecrets.delete(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    // Locked file: overwrite the content so the secret is gone even if the name stays.
    try {
      writeFileAtomic(filePath, '{}', { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * How a secret file is stored right now, without decrypting it.
 * @returns {'encrypted' | 'locked' | 'plaintext' | 'memory' | 'missing' | 'unreadable'}
 *   locked = encrypted, but safeStorage cannot open it at the moment.
 */
function describeSecretFile(filePath) {
  if (memorySecrets.has(filePath)) return 'memory';
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (raw && raw.format === SECRET_ENVELOPE) return canEncrypt() ? 'encrypted' : 'locked';
  if (raw && typeof raw === 'object' && Object.keys(raw).length === 0) return 'missing';
  return 'plaintext';
}

/** Drop session-only secrets (wipe / tests). */
function clearMemorySecrets() {
  memorySecrets.clear();
}

/** Test hook: inject a fake safeStorage (null = unavailable, undefined = real). */
function setSafeStorageForTests(impl) {
  safeStorageOverride = impl;
}

function buildConfig() {
  const example = path.join(ROOT, 'config.example.json');
  const local = path.join(ROOT, 'config.json');
  const base = readJson(example, {});
  const override = readJson(local, {});

  // Packaged: allow user override next to exe or in userData
  let packagedOverride = {};
  const app = tryElectronApp();
  if (app && app.isPackaged) {
    packagedOverride = {
      ...readJson(path.join(app.getPath('userData'), 'config.json'), {}),
      ...readJson(path.join(path.dirname(process.execPath), 'config.json'), {}),
    };
  }

  const merged = {
    tasksListName: 'Tasks',
    habitsListName: 'Habits',
    accentColor: '#C4122E',
    ...base,
    ...override,
    ...packagedOverride,
    window: {
      width: 380,
      height: 460,
      alwaysOnTop: true,
      skipTaskbar: true,
      ...(base.window || {}),
      ...(override.window || {}),
      ...(packagedOverride.window || {}),
    },
  };
  // Reject non-hex accents from config overrides (CSS injection via renderer setProperty)
  const accent = typeof merged.accentColor === 'string' ? merged.accentColor.trim() : '';
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) {
    merged.accentColor = '#C4122E';
  }
  return merged;
}

function loadConfig() {
  if (!configCache) configCache = buildConfig();
  return configCache;
}

function dataPath(...parts) {
  return path.join(getDataRoot(), ...parts);
}

function hasGoogleCredentials() {
  loadEnvFile();
  return Boolean(googleCredentials);
}

module.exports = {
  ROOT,
  loadEnvFile,
  resetEnvCache,
  readJson,
  writeJson,
  writeFileAtomic,
  freezeWrites,
  quarantineCorruptFile,
  readSecretJson,
  writeSecretJson,
  deleteSecretJson,
  describeSecretFile,
  clearMemorySecrets,
  canEncrypt,
  encryptText,
  decryptText,
  SECRET_ENVELOPE,
  setSafeStorageForTests,
  setDataRootForTests,
  savedPinnedPort,
  loadConfig,
  dataPath,
  getDataRoot,
  hasGoogleCredentials,
  getGoogleClientCredentials,
  getCredentialsEnvPath,
  getCredentialsJsonPath,
  saveGoogleCredentials,
  getGoogleCredentialsStatus,
  DEFAULT_OAUTH_PORT,
};
