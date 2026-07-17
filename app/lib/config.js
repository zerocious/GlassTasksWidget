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

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
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
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;

  const candidates = [];
  const app = tryElectronApp();
  if (app) {
    candidates.push(path.join(app.getPath('userData'), '.env'));
    if (app.isPackaged) {
      candidates.push(path.join(path.dirname(process.execPath), '.env'));
    }
  }
  candidates.push(path.join(ROOT, '.env'));

  for (const p of candidates) {
    if (loadEnvFromFile(p)) break;
  }
}

/** Force re-read of .env on next credential check. */
function resetEnvCache() {
  envLoaded = false;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

  return {
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
  loadConfig,
  resetConfigCache,
  dataPath,
  getDataRoot,
  isPackaged,
  hasGoogleCredentials,
};
