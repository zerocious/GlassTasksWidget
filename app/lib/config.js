'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./storage-core');
const { loadDoc, saveDoc } = require('./storage-files');
const { readJson } = core;

const ROOT = path.join(__dirname, '..');

let envLoaded = false;
/** @type {ReturnType<typeof buildConfig> | null} */
let configCache = null;

/**
 * Google OAuth client credentials. They live in this module (not in process.env), so child
 * processes the app spawns (PowerShell toasts, updater) never inherit the client secret and
 * nothing can read it via `process.env` / crash dumps of the environment block.
 * @type {{ clientId: string, clientSecret: string, redirectPort: number | null } | null}
 */
let googleCreds = null;
/** @type {string | null} */
let dataRootOverride = null;
/** @type {Record<string, string> | undefined} */
let shellEnvSnapshot;

function tryElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return null;
  }
}

/**
 * Writable data root. Packaged: %APPDATA%/glass-tasks-widget/data.
 * Dev: app/data, or <GT_USER_DATA_DIR>/data when an isolated profile is requested.
 */
function getDataRoot() {
  if (dataRootOverride) return dataRootOverride;
  const app = tryElectronApp();
  if (app && app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  if (process.env.GT_USER_DATA_DIR) {
    return path.join(path.resolve(process.env.GT_USER_DATA_DIR), 'data');
  }
  return path.join(ROOT, 'data');
}

/** Test hook: point all storage at a temp folder (null = default). */
function setDataRootForTests(dir) {
  dataRootOverride = dir ? path.resolve(dir) : null;
  googleCreds = null;
  envLoaded = false;
  shellEnvSnapshot = undefined;
}

const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT'];
const DEFAULT_OAUTH_PORT = 42813;

/** Marker line in .env files the app itself wrote (pre-encryption versions). */
const APP_ENV_MARKER = 'Saved by the app UI';

/** credentials.json: Desktop OAuth client, encrypted by safeStorage. */
const CREDENTIALS_SPEC = {
  name: 'credentials.json',
  file: () => getCredentialsJsonPath(),
  version: 1,
  secret: true,
  // v0 -> v1: the file only gained schemaVersion.
  migrations: { 1: (d) => d },
};

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

/** @returns {Record<string, string> | null} null when the file is missing or has no known keys */
function readEnvFile(envPath) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  const values = parseEnvText(text);
  return Object.keys(values).length > 0 ? values : null;
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
  if (!text.includes(APP_ENV_MARKER) || !core.canEncrypt()) return;
  const values = parseEnvText(text);
  if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) return;
  try {
    if (!loadDoc(CREDENTIALS_SPEC).data) {
      const res = saveDoc(CREDENTIALS_SPEC, {
        clientId: values.GOOGLE_CLIENT_ID,
        clientSecret: values.GOOGLE_CLIENT_SECRET,
        redirectPort: Number(values.OAUTH_REDIRECT_PORT) || null,
        updatedAt: new Date().toISOString(),
      });
      if (!res.persisted) return;
    }
    fs.unlinkSync(envPath);
  } catch (err) {
    console.warn('[config] .env migration failed:', err && err.message ? err.message : err);
  }
}

/**
 * Port the user pinned, or null for «choose a free one». Older versions saved their default
 * 42813 for everybody; without an explicit `portPinned` flag that value is not a choice,
 * and keeping it would leave a well-known port open during every sign-in.
 * @param {Record<string, any>} data parsed credentials.json
 * @returns {number | null}
 */
function savedPinnedPort(data) {
  const port = Math.round(Number(data && (data.redirectPort || data.OAUTH_REDIRECT_PORT)));
  if (!Number.isFinite(port) || port <= 0) return null;
  if (port === DEFAULT_OAUTH_PORT && !data.portPinned) return null;
  return port;
}

/** @returns {{ clientId: string, clientSecret: string, redirectPort: number | null } | null} */
function readStoredCredentials() {
  const { data } = loadDoc(CREDENTIALS_SPEC);
  if (!data) return null;
  const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret.trim() : '';
  if (!clientId || !clientSecret) return null;
  // No saved port = pick a free loopback port per sign-in (Desktop clients accept any).
  return { clientId, clientSecret, redirectPort: savedPinnedPort(data) };
}

/** Preferred writable .env path (packaged/dev Electron: %APPDATA%/glass-tasks-widget/.env). */
function getCredentialsEnvPath() {
  if (dataRootOverride) return path.join(dataRootOverride, '.env');
  const app = tryElectronApp();
  if (app) return path.join(app.getPath('userData'), '.env');
  return path.join(ROOT, '.env');
}

/** Structured credentials mirror under the writable data root. */
function getCredentialsJsonPath() {
  return dataPath('credentials.json');
}

function envCandidatePaths() {
  if (dataRootOverride) return [getCredentialsEnvPath()]; // tests: never read the developer's .env
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

/**
 * The Google variables a developer exported in the shell. They are read once and removed
 * from process.env right away so they cannot leak into child processes.
 */
function takeShellEnv() {
  if (shellEnvSnapshot === undefined) {
    shellEnvSnapshot = {};
    for (const key of GOOGLE_ENV_KEYS) {
      if (typeof process.env[key] === 'string' && process.env[key]) shellEnvSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  }
  return shellEnvSnapshot;
}

/** Developer fallback: first .env that has Google keys, then variables from the shell. */
function readDevEnvCredentials() {
  let values = null;
  for (const p of envCandidatePaths()) {
    values = readEnvFile(p);
    if (values) break;
  }
  const merged = { ...takeShellEnv(), ...(values || {}) };
  const clientId = (merged.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (merged.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const port = Math.round(Number(merged.OAUTH_REDIRECT_PORT));
  return { clientId, clientSecret, redirectPort: Number.isFinite(port) && port > 0 ? port : null };
}

/**
 * Load the Google client credentials into this module (never into process.env).
 * Encrypted credentials.json saved from the UI wins; a developer .env / shell variables
 * are the fallback.
 */
function loadEnvFile({ force = false } = {}) {
  if (envLoaded && !force) return;
  envLoaded = true;
  takeShellEnv(); // scrub before anything else can spawn a child process
  migrateAppWrittenEnv();
  googleCreds = readStoredCredentials() || readDevEnvCredentials();
  // Encrypted keys exist but cannot be read yet (safeStorage not ready): ask again next time
  // instead of reporting «not configured» for the whole session.
  if (!googleCreds && !core.canEncrypt() && fs.existsSync(getCredentialsJsonPath())) envLoaded = false;
}

/** Force re-read of credentials on next check. */
function resetEnvCache() {
  envLoaded = false;
  googleCreds = null;
}

/**
 * Current Google client credentials, or null when none are configured.
 * @returns {{ clientId: string, clientSecret: string, redirectPort: number | null } | null}
 */
function getGoogleCredentials() {
  loadEnvFile();
  return googleCreds ? { ...googleCreds } : null;
}

/** @returns {string | null} */
function getGoogleClientSecret() {
  loadEnvFile();
  return googleCreds ? googleCreds.clientSecret : null;
}

/** Printable ASCII without spaces — what Google issues for client id / secret. */
const CREDENTIAL_RE = /^[\x21-\x7E]{1,512}$/;

const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * Persist Desktop OAuth client credentials for the widget
 * to data/credentials.json (encrypted via safeStorage; kept in memory only when it is unavailable).
 * @param {{ clientId: string, clientSecret: string, redirectPort?: number | string | null }} input
 *   redirectPort empty / null = choose a free port at each sign-in.
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

  const { persisted } = saveDoc(CREDENTIALS_SPEC, {
    clientId,
    clientSecret,
    redirectPort,
    portPinned: Boolean(redirectPort),
    updatedAt: new Date().toISOString(),
  });

  takeShellEnv();
  googleCreds = { clientId, clientSecret, redirectPort };
  envLoaded = true;

  return {
    configured: true,
    clientId,
    redirectPort,
    jsonPath: getCredentialsJsonPath(),
    /** false = safeStorage is unavailable: the keys are valid for this session only. */
    persisted,
  };
}

/**
 * @returns {{
 *   configured: boolean,
 *   clientId: string | null,
 *   redirectPort: number | null,
 *   envPath: string,
 *   jsonPath: string,
 * }}
 */
function getGoogleCredentialsStatus() {
  loadEnvFile();
  const configured = Boolean(googleCreds);
  return {
    configured,
    clientId: googleCreds ? googleCreds.clientId : null,
    // null = automatic (a free port is chosen at each sign-in).
    redirectPort: googleCreds ? googleCreds.redirectPort : null,
    envPath: getCredentialsEnvPath(),
    jsonPath: getCredentialsJsonPath(),
  };
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
  return Boolean(googleCreds);
}

const {
  readJsonStrict,
  writeJson,
  writeFileAtomic,
  readSecretJson,
  writeSecretJson,
  deleteSecretJson,
  setSafeStorageForTests,
} = core;

module.exports = {
  ROOT,
  loadEnvFile,
  resetEnvCache,
  readJson,
  readJsonStrict,
  writeJson,
  writeFileAtomic,
  readSecretJson,
  writeSecretJson,
  deleteSecretJson,
  setSafeStorageForTests,
  setDataRootForTests,
  savedPinnedPort,
  loadConfig,
  dataPath,
  getDataRoot,
  hasGoogleCredentials,
  getGoogleCredentials,
  getGoogleClientSecret,
  getCredentialsEnvPath,
  getCredentialsJsonPath,
  saveGoogleCredentials,
  getGoogleCredentialsStatus,
  DEFAULT_OAUTH_PORT,
};
