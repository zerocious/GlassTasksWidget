'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let envLoaded = false;
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
 * Writable data root. Dev: app/data. Packaged: %APPDATA%/glass-tasks-widget/data
 */
function getDataRoot() {
  const app = tryElectronApp();
  if (app && app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(ROOT, 'data');
}

const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT'];
const DEFAULT_OAUTH_PORT = 42813;

function applyEnvValue(key, value, { force = false } = {}) {
  if (!force && key in process.env) return;
  process.env[key] = value;
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

function loadEnvFromFile(envPath, { force = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return false;
  }
  const values = parseEnvText(text);
  for (const [key, value] of Object.entries(values)) {
    applyEnvValue(key, value, { force });
  }
  return Object.keys(values).length > 0;
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
        redirectPort: Number(values.OAUTH_REDIRECT_PORT) || DEFAULT_OAUTH_PORT,
        updatedAt: new Date().toISOString(),
      });
    }
    fs.unlinkSync(envPath);
  } catch (err) {
    console.warn('[config] .env migration failed:', err && err.message ? err.message : err);
  }
}

function loadCredentialsJson(jsonPath, { force = false } = {}) {
  const data = readSecretJson(jsonPath, null);
  if (!data || typeof data !== 'object') return false;
  const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret.trim() : '';
  if (!clientId || !clientSecret) return false;
  applyEnvValue('GOOGLE_CLIENT_ID', clientId, { force });
  applyEnvValue('GOOGLE_CLIENT_SECRET', clientSecret, { force });
  const port = Number(data.redirectPort || data.OAUTH_REDIRECT_PORT || DEFAULT_OAUTH_PORT);
  if (Number.isFinite(port) && port > 0) {
    applyEnvValue('OAUTH_REDIRECT_PORT', String(Math.round(port)), { force });
  }
  return true;
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

function loadEnvFile({ force = false } = {}) {
  if (envLoaded && !force) return;
  envLoaded = true;

  migrateAppWrittenEnv();
  // Encrypted credentials saved from the UI win; a developer .env is the fallback.
  if (loadCredentialsJson(getCredentialsJsonPath(), { force })) return;
  for (const p of envCandidatePaths()) {
    if (loadEnvFromFile(p, { force })) break;
  }
}

/** Force re-read of credentials on next check. */
function resetEnvCache() {
  envLoaded = false;
  for (const key of GOOGLE_ENV_KEYS) {
    delete process.env[key];
  }
}

/** Printable ASCII without spaces — what Google issues for client id / secret. */
const CREDENTIAL_RE = /^[\x21-\x7E]{1,512}$/;

/**
 * Persist Desktop OAuth client credentials for the widget
 * to data/credentials.json (encrypted via safeStorage when available).
 * @param {{ clientId: string, clientSecret: string, redirectPort?: number }} input
 */
function saveGoogleCredentials(input) {
  const clientId = String(input?.clientId || '').trim();
  const clientSecret = String(input?.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Укажите Client ID и Client Secret');
  }
  if (!CREDENTIAL_RE.test(clientId) || !CREDENTIAL_RE.test(clientSecret)) {
    throw new Error('Client ID и Client Secret не должны содержать пробелов и переводов строк');
  }
  let redirectPort = Number(input?.redirectPort);
  if (!Number.isFinite(redirectPort) || redirectPort <= 0) redirectPort = DEFAULT_OAUTH_PORT;
  redirectPort = Math.round(redirectPort);
  if (redirectPort < 1024 || redirectPort > 65535) {
    throw new Error('Порт redirect должен быть в диапазоне 1024–65535');
  }

  writeSecretJson(getCredentialsJsonPath(), {
    clientId,
    clientSecret,
    redirectPort,
    updatedAt: new Date().toISOString(),
  });

  resetEnvCache();
  loadEnvFile({ force: true });
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.GOOGLE_CLIENT_SECRET = clientSecret;
  process.env.OAUTH_REDIRECT_PORT = String(redirectPort);

  return {
    configured: true,
    clientId,
    redirectPort,
    jsonPath: getCredentialsJsonPath(),
  };
}

/**
 * @returns {{
 *   configured: boolean,
 *   clientId: string | null,
 *   redirectPort: number,
 *   envPath: string,
 *   jsonPath: string,
 * }}
 */
function getGoogleCredentialsStatus() {
  loadEnvFile();
  const clientId = process.env.GOOGLE_CLIENT_ID || null;
  const configured = Boolean(clientId && process.env.GOOGLE_CLIENT_SECRET);
  let redirectPort = Number(process.env.OAUTH_REDIRECT_PORT || DEFAULT_OAUTH_PORT);
  if (!Number.isFinite(redirectPort) || redirectPort <= 0) redirectPort = DEFAULT_OAUTH_PORT;
  return {
    configured,
    clientId: configured ? clientId : null,
    redirectPort: Math.round(redirectPort),
    envPath: getCredentialsEnvPath(),
    jsonPath: getCredentialsJsonPath(),
  };
}

/**
 * Move an unparseable JSON file aside so the next save does not silently
 * overwrite whatever the user had (streak history, settings, tokens).
 */
function quarantineCorruptFile(filePath, err) {
  const target = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, target);
    console.warn(`[config] corrupt JSON moved to ${target}:`, err && err.message ? err.message : err);
  } catch {
    // Read-only location (e.g. inside app.asar) — nothing to protect there.
    console.warn(`[config] corrupt JSON at ${filePath}:`, err && err.message ? err.message : err);
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
    return JSON.parse(text);
  } catch (err) {
    quarantineCorruptFile(filePath, err);
    return fallback;
  }
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

const SECRET_ENVELOPE = 'glass-tasks/safeStorage@1';
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

/**
 * Secrets (tokens, client secret) are encrypted with Electron safeStorage (DPAPI on Windows).
 * Falls back to plain JSON outside Electron or when encryption is unavailable.
 */
function writeSecretJson(filePath, data) {
  let body = JSON.stringify(data, null, 2);
  if (canEncrypt()) {
    const enc = getSafeStorage().encryptString(body).toString('base64');
    body = JSON.stringify({ format: SECRET_ENVELOPE, data: enc });
  }
  writeFileAtomic(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Read a file written by writeSecretJson. Plain-JSON files from older versions
 * are returned as-is and re-saved encrypted when possible.
 */
function readSecretJson(filePath, fallback) {
  const raw = readJson(filePath, undefined);
  if (raw === undefined) return fallback;
  if (raw && typeof raw === 'object' && raw.format === SECRET_ENVELOPE) {
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
  if (canEncrypt() && raw && typeof raw === 'object') {
    try {
      writeSecretJson(filePath, raw);
    } catch {
      /* keep plaintext; retry next read */
    }
  }
  return raw;
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
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

module.exports = {
  ROOT,
  loadEnvFile,
  resetEnvCache,
  readJson,
  writeJson,
  writeFileAtomic,
  readSecretJson,
  writeSecretJson,
  setSafeStorageForTests,
  loadConfig,
  dataPath,
  getDataRoot,
  hasGoogleCredentials,
  getCredentialsEnvPath,
  getCredentialsJsonPath,
  saveGoogleCredentials,
  getGoogleCredentialsStatus,
  DEFAULT_OAUTH_PORT,
};
