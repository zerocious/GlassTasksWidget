'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
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

function loadConfig() {
  const example = path.join(ROOT, 'config.example.json');
  const local = path.join(ROOT, 'config.json');
  const base = readJson(example, {});
  const override = readJson(local, {});
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
    window: {
      ...(base.window || {}),
      ...(override.window || {}),
    },
  };
}

function dataPath(...parts) {
  return path.join(ROOT, 'data', ...parts);
}

function hasGoogleCredentials() {
  loadEnvFile();
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

module.exports = {
  ROOT,
  loadEnvFile,
  readJson,
  writeJson,
  loadConfig,
  dataPath,
  hasGoogleCredentials,
};
