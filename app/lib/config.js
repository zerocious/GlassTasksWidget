'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let envLoaded = false;
/** @type {ReturnType<typeof buildConfig> | null} */
let configCache = null;

function tryElectronApp() {
  try {
    // eslint-disable-next-line global-require
    return require('electron').app;
  } catch {
    return null;
  }
}

function isPackaged() {
  const app = tryElectronApp();
  return Boolean(app && app.isPackaged);
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

function loadEnvFromFile(envPath, { force = false } = {}) {
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
  let loaded = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    applyEnvValue(key, value, { force });
    loaded = true;
  }
  return loaded;
}

function loadCredentialsJson(jsonPath, { force = false } = {}) {
  const data = readJson(jsonPath, null);
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

  let found = false;
  for (const p of envCandidatePaths()) {
    if (loadEnvFromFile(p, { force })) {
      found = true;
      break;
    }
  }
  if (!found || !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
    loadCredentialsJson(getCredentialsJsonPath(), { force });
  }
}

/** Force re-read of credentials on next check. */
function resetEnvCache() {
  envLoaded = false;
  for (const key of GOOGLE_ENV_KEYS) {
    delete process.env[key];
  }
}

/**
 * Persist Desktop OAuth client credentials for the widget.
 * Writes %APPDATA%/…/.env (or app/.env in non-Electron) and data/credentials.json.
 * @param {{ clientId: string, clientSecret: string, redirectPort?: number }} input
 */
function saveGoogleCredentials(input) {
  const clientId = String(input?.clientId || '').trim();
  const clientSecret = String(input?.clientSecret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Укажите Client ID и Client Secret');
  }
  let redirectPort = Number(input?.redirectPort);
  if (!Number.isFinite(redirectPort) || redirectPort <= 0) redirectPort = DEFAULT_OAUTH_PORT;
  redirectPort = Math.round(redirectPort);
  if (redirectPort < 1024 || redirectPort > 65535) {
    throw new Error('Порт redirect должен быть в диапазоне 1024–65535');
  }

  const envPath = getCredentialsEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const envBody = [
    '# Glass Tasks Widget — Google OAuth Desktop client',
    `# Saved by the app UI (${new Date().toISOString()})`,
    `GOOGLE_CLIENT_ID=${clientId}`,
    `GOOGLE_CLIENT_SECRET=${clientSecret}`,
    `OAUTH_REDIRECT_PORT=${redirectPort}`,
    '',
  ].join('\n');
  // Restrictive mode where the OS honors it (Unix); Windows ACLs remain user-profile default
  fs.writeFileSync(envPath, envBody, { encoding: 'utf8', mode: 0o600 });

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
    envPath,
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

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write via temp file + rename so a crash / power loss mid-write can't leave a
 * truncated JSON (readJson would then silently fall back to defaults and wipe
 * settings, streak history or tokens).
 */
function writeFileAtomic(filePath, text, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, options);
    // Antivirus / indexer can briefly lock the target on Windows — retry the
    // rename before giving up on atomicity.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        if (attempt >= 4 || !err || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) {
          throw err;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // Rename can fail on Windows if another process holds the target open.
    fs.writeFileSync(filePath, text, options);
  }
}

function writeJson(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Like writeJson, but prefer owner-only file mode for secrets (tokens, credentials). */
function writeSecretJson(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
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
    window: {
      width: 380,
      height: 460,
      alwaysOnTop: true,
      skipTaskbar: true,
    },
    ...base,
    ...override,
    ...packagedOverride,
    window: {
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

function resetConfigCache() {
  configCache = null;
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
  writeSecretJson,
  loadConfig,
  resetConfigCache,
  dataPath,
  getDataRoot,
  isPackaged,
  hasGoogleCredentials,
  getCredentialsEnvPath,
  getCredentialsJsonPath,
  saveGoogleCredentials,
  getGoogleCredentialsStatus,
  DEFAULT_OAUTH_PORT,
};
