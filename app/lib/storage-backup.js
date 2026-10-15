'use strict';

/**
 * Backups, export and import of the widget's own data.
 *
 * A "bundle" is one JSON document: settings, habit history (and the demo lists when demo mode
 * was used). It NEVER contains tokens or the Google client secret: the bundle is assembled
 * from an explicit list of sources and, as a second line of defence, the finished text is
 * checked against the secrets currently in use before it is written anywhere.
 *
 * Weekly backups are bundles stored in <data>/backups/. Importing merges (habit dates are
 * united, nothing is removed) after taking a `pre-import` backup.
 */

const fs = require('fs');
const path = require('path');
const { dataPath, getGoogleClientSecret } = require('./config');
const { writeFileAtomic } = require('./storage-core');
const { recordStorageEvent } = require('./storage-status');
const { loadSettings, saveSettings } = require('./settings-store');
const streaks = require('./streak-store');
const mockData = require('./mock-data');

const BUNDLE_APP = 'glass-tasks-widget';
const BUNDLE_VERSION = 1;
/** Largest bundle accepted by import (a decade of daily habits is well under 1 MB). */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** Newest backups kept per kind. */
const BACKUP_KEEP = { weekly: 8, manual: 10, 'pre-import': 5 };
const WEEKLY_INTERVAL_DAYS = 7;
/** Settings an import may change. Hotkeys, autostart and window position are machine-specific. */
const IMPORTABLE_SETTINGS = [
  'theme',
  'size',
  'snapToEdge',
  'autoPalette',
  'accentColor',
  'bgOpacity',
  'remindersEnabled',
  'dailyHabitsReset',
  'hideCompleted',
  'simpleAnimations',
];
const LOG_TAIL_BYTES = 100 * 1024;
const LOG_FILES_MAX = 3;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------
// Secret guard
// ---------------------------------------------------------------------------------------

/** Secret values currently in use (client secret, tokens): they must never appear in a bundle. */
function secretNeedles() {
  const needles = [];
  const add = (v) => {
    if (typeof v === 'string' && v.length >= 6) needles.push(v);
  };
  try {
    add(getGoogleClientSecret());
  } catch {
    /* no credentials */
  }
  try {
    const tokens = require('./google-auth').loadSavedTokens();
    if (tokens) {
      add(tokens.refresh_token);
      add(tokens.access_token);
      add(tokens.id_token);
    }
  } catch {
    /* no tokens */
  }
  return needles;
}

/**
 * @param {string} text
 * @param {string[]} [needles]
 * @throws if the text contains a secret that is currently in use
 */
function assertNoSecrets(text, needles = secretNeedles()) {
  for (const needle of needles) {
    if (text.includes(needle)) {
      throw new Error('Экспорт отменён: в данных оказался секрет (токен или ключ Google).');
    }
  }
}

// ---------------------------------------------------------------------------------------
// Logs (optional part of an export)
// ---------------------------------------------------------------------------------------

/** Token-shaped strings that are replaced entirely. */
const TOKEN_SHAPES = [
  /ya29\.[\w-]+/g, // Google access tokens
  /1\/\/[\w-]{20,}/g, // Google refresh tokens
  /GOCSPX-[\w-]+/g, // Google client secrets
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // JWT (id_token)
];
/** `key: value` shapes where only the value is replaced (group 1 is kept). */
const TOKEN_FIELDS = [
  /(Bearer\s+)[\w.~+/=-]{12,}/gi,
  /((?:access_token|refresh_token|id_token|client_secret|code|authorization)["'\s:=]+)[\w.~+/=-]{8,}/gi,
];

/** Strip anything token-like (and the exact secrets in use) from log text. */
function redactSecrets(text, needles = secretNeedles()) {
  let out = text;
  for (const needle of needles) out = out.split(needle).join('[redacted]');
  for (const re of TOKEN_FIELDS) out = out.replace(re, '$1[redacted]');
  for (const re of TOKEN_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

/**
 * Tail of the newest *.log files, redacted. Read-only: the log folder belongs to the logger.
 * @param {string} logsDir
 * @returns {Array<{ name: string, tail: string }>}
 */
function collectLogTails(logsDir) {
  let names;
  try {
    names = fs.readdirSync(logsDir).filter((n) => /\.log$/i.test(n));
  } catch {
    return [];
  }
  const needles = secretNeedles();
  return names
    .map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LOG_FILES_MAX)
    .map(({ name }) => {
      const file = path.join(logsDir, name);
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return { name, tail: redactSecrets(buf.toString('utf8'), needles) };
      } finally {
        fs.closeSync(fd);
      }
    });
}

// ---------------------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------------------

/**
 * @param {{ kind?: 'export' | 'backup', appVersion?: string, now?: Date, logsDir?: string | null }} [opts]
 */
function buildBundle(opts = {}) {
  const now = opts.now || new Date();
  /** @type {Record<string, any>} */
  const bundle = {
    app: BUNDLE_APP,
    kind: opts.kind || 'export',
    schemaVersion: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    appVersion: opts.appVersion || null,
    settings: { ...loadSettings() },
    streaks: streaks.exportHistory(),
  };
  // Reading the demo lists would create them for a Google user, so only export an existing file.
  if (fs.existsSync(mockData.MOCK_SPEC.file())) bundle.demo = mockData.exportMockStore();
  if (opts.logsDir) bundle.logs = collectLogTails(opts.logsDir);
  return bundle;
}

/** @returns {string} the bundle as text, after the secret check */
function serializeBundle(bundle) {
  const text = JSON.stringify(bundle, null, 2);
  assertNoSecrets(text);
  return text;
}

/** Quick summary of a bundle for confirmation dialogs. */
function summarizeBundle(bundle) {
  const { habits } = streaks.parseHistory(bundle.streaks);
  let dates = 0;
  for (const h of Object.values(habits)) dates += h.dates.length;
  return {
    kind: bundle.kind,
    exportedAt: bundle.exportedAt,
    appVersion: bundle.appVersion || null,
    hasSettings: isPlainObject(bundle.settings),
    habits: Object.keys(habits).length,
    dates,
    demoTasks: bundle.demo && Array.isArray(bundle.demo.tasks) ? bundle.demo.tasks.length : 0,
    demoHabits: bundle.demo && Array.isArray(bundle.demo.habits) ? bundle.demo.habits.length : 0,
  };
}

/**
 * Validate the text of an exported file.
 * @param {string} text
 * @returns {{ bundle: Record<string, any>, summary: ReturnType<typeof summarizeBundle> }}
 * @throws Error with a Russian message
 */
function parseBundle(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Файл пустой.');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('Файл слишком большой для импорта.');
  let bundle;
  try {
    bundle = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Файл не является корректным JSON.');
  }
  if (!isPlainObject(bundle) || bundle.app !== BUNDLE_APP) {
    throw new Error('Это не файл экспорта Glass Tasks Widget.');
  }
  if (!Number.isInteger(bundle.schemaVersion) || bundle.schemaVersion < 1) {
    throw new Error('В файле нет номера версии формата.');
  }
  if (bundle.schemaVersion > BUNDLE_VERSION) {
    throw new Error('Файл создан более новой версией приложения. Обновите виджет и повторите импорт.');
  }
  const summary = summarizeBundle(bundle);
  if (!summary.hasSettings && !summary.habits && !summary.demoTasks && !summary.demoHabits) {
    throw new Error('В файле нет данных, которые можно импортировать.');
  }
  return { bundle, summary };
}

// ---------------------------------------------------------------------------------------
// Backup files
// ---------------------------------------------------------------------------------------

function backupDir() {
  return dataPath('backups');
}

const BACKUP_NAME_RE = /^(weekly|manual|pre-import)-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.json$/;

function localDate(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function localTime(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * @returns {Array<{ name: string, kind: 'weekly' | 'manual' | 'pre-import', date: string, size: number }>}
 *   newest first
 */
function listBackups() {
  let names;
  try {
    names = fs.readdirSync(backupDir());
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = BACKUP_NAME_RE.exec(name);
      if (!m) return null;
      let size;
      try {
        size = fs.statSync(path.join(backupDir(), name)).size;
      } catch {
        return null;
      }
      return { name, kind: /** @type {'weekly' | 'manual' | 'pre-import'} */ (m[1]), date: m[2], sort: `${m[2]}${m[3] || ''}`, size };
    })
    .filter(Boolean)
    .sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0))
    .map(({ name, kind, date, size }) => ({ name, kind, date, size }));
}

function pruneBackups(kind) {
  const mine = listBackups().filter((b) => b.kind === kind);
  for (const old of mine.slice(BACKUP_KEEP[kind])) {
    try {
      fs.unlinkSync(path.join(backupDir(), old.name));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Write a backup bundle into <data>/backups. Throws when it cannot be written.
 * @param {{ kind?: 'weekly' | 'manual' | 'pre-import', now?: Date, appVersion?: string }} [opts]
 */
function createBackup(opts = {}) {
  const kind = opts.kind || 'manual';
  const now = opts.now || new Date();
  const name = kind === 'weekly' ? `weekly-${localDate(now)}.json` : `${kind}-${localDate(now)}-${localTime(now)}.json`;
  try {
    const text = serializeBundle(buildBundle({ kind: 'backup', now, appVersion: opts.appVersion }));
    writeFileAtomic(path.join(backupDir(), name), text);
  } catch (err) {
    recordStorageEvent('backup-failed', name);
    throw err;
  }
  pruneBackups(kind);
  recordStorageEvent('backup-created', name);
  return { name, size: fs.statSync(path.join(backupDir(), name)).size };
}

function daysBetween(fromIso, to) {
  const [y, m, d] = fromIso.split('-').map(Number);
  return Math.floor((to.getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
}

/** True when there is anything worth backing up (so a fresh install does not create empty backups). */
function hasBackupWorthyData() {
  return (
    fs.existsSync(dataPath('streaks.json')) ||
    fs.existsSync(dataPath('settings.json')) ||
    fs.existsSync(mockData.MOCK_SPEC.file())
  );
}

/**
 * Create a weekly backup when the newest one is older than a week. Never throws:
 * called at startup, a failed backup must not stop the widget (the failure is recorded).
 * @param {{ now?: Date, appVersion?: string }} [opts]
 * @returns {{ created: boolean, name?: string, reason?: string }}
 */
function ensureWeeklyBackup(opts = {}) {
  const now = opts.now || new Date();
  const newest = listBackups().find((b) => b.kind === 'weekly');
  if (newest && daysBetween(newest.date, now) < WEEKLY_INTERVAL_DAYS) {
    return { created: false, reason: 'recent' };
  }
  if (!hasBackupWorthyData()) return { created: false, reason: 'no-data' };
  try {
    const { name } = createBackup({ kind: 'weekly', now, appVersion: opts.appVersion });
    return { created: true, name };
  } catch (err) {
    console.warn('[backup] weekly backup failed:', err && err.message ? err.message : err);
    return { created: false, reason: 'failed' };
  }
}

/**
 * Text of a backup made by this app.
 * @param {string} name file name from listBackups()
 */
function readBackupText(name) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) throw new Error('Неизвестная резервная копия.');
  try {
    return fs.readFileSync(path.join(backupDir(), name), 'utf8');
  } catch {
    throw new Error('Резервная копия не найдена.');
  }
}

// ---------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------

/**
 * Apply a validated bundle to the local data by merging. A `pre-import` backup is taken first;
 * if that fails nothing is changed.
 * @param {{ bundle: Record<string, any> }} parsed result of parseBundle()
 * @param {{ settings?: boolean, streaks?: boolean, demo?: boolean, appVersion?: string, sourceName?: string }} [opts]
 */
function applyBundle(parsed, opts = {}) {
  const { bundle } = parsed;
  const want = { settings: opts.settings !== false, streaks: opts.streaks !== false, demo: opts.demo !== false };
  const backup = createBackup({ kind: 'pre-import', appVersion: opts.appVersion });

  const result = {
    backup: backup.name,
    settingsApplied: false,
    streaks: { habitsAdded: 0, habitsUpdated: 0, datesAdded: 0, rejected: 0 },
    demo: { tasksAdded: 0, habitsAdded: 0, rejected: 0 },
  };

  if (want.settings && isPlainObject(bundle.settings)) {
    /** @type {Record<string, unknown>} */
    const patch = {};
    for (const key of IMPORTABLE_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(bundle.settings, key)) patch[key] = bundle.settings[key];
    }
    if (Object.keys(patch).length) {
      saveSettings(patch);
      result.settingsApplied = true;
    }
  }
  if (want.streaks && bundle.streaks) result.streaks = streaks.mergeHistory(bundle.streaks);
  if (want.demo && bundle.demo) result.demo = mockData.mergeMockStore(bundle.demo);

  recordStorageEvent('imported', opts.sourceName || 'файл');
  return result;
}

// ---------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------

const CSV_COLUMNS = ['list', 'title', 'status', 'due', 'notes', 'id', 'parent_id'];

/**
 * One CSV cell. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR at the
 * start) get a leading apostrophe, so opening the file in Excel cannot execute task text.
 */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Tasks (and habits) of a widget payload as CSV (UTF-8 with BOM, CRLF, opens in Excel).
 * @param {{ tasks?: any[], habits?: any[] }} payload
 */
function tasksToCsv(payload) {
  const rows = [CSV_COLUMNS];
  const add = (list, items) => {
    for (const t of Array.isArray(items) ? items : []) {
      if (!t || typeof t !== 'object') continue;
      rows.push([list, t.title, t.completed ? 'completed' : 'needsAction', t.due, t.notes, t.id, t.parent]);
    }
  };
  add('tasks', payload && payload.tasks);
  add('habits', payload && payload.habits);
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  BUNDLE_APP,
  BUNDLE_VERSION,
  BACKUP_KEEP,
  MAX_IMPORT_BYTES,
  IMPORTABLE_SETTINGS,
  assertNoSecrets,
  redactSecrets,
  collectLogTails,
  buildBundle,
  serializeBundle,
  summarizeBundle,
  parseBundle,
  backupDir,
  listBackups,
  createBackup,
  ensureWeeklyBackup,
  readBackupText,
  applyBundle,
  tasksToCsv,
};
