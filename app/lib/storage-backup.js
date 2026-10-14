'use strict';

/**
 * Backups, export and import.
 *
 * Export / backup JSON (`format` = glass-tasks-export | glass-tasks-backup, schemaVersion 1):
 *   { format, schemaVersion, createdAt, reason?, app: { version },
 *     settings: {…без позиции окна…},
 *     habits: { [habitId]: { title?, dates: ['YYYY-MM-DD', …] } },
 *     logs?: [{ name, modifiedAt, truncated, text }] }   — export only
 * Tokens, the client secret and the offline task cache are never included; the final text is
 * also scrubbed for anything token-shaped and checked against the live secrets before writing.
 *
 * Weekly backups go to data/backups/backup-<YYYYMMDD>-<HHMMSS>-<reason>.json;
 * the newest BACKUP_KEEP per reason are kept.
 */

const fs = require('fs');
const path = require('path');
const { dataPath, writeFileAtomic, readSecretJson, getGoogleClientCredentials } = require('./config');
const { schemaVersionOf } = require('./storage-migrate');
const { loadSettings, saveSettings, DEFAULTS: SETTINGS_DEFAULTS } = require('./settings-store');
const { loadStore, mergeHistory, decodeStore } = require('./streak-store');

const EXPORT_FORMAT = 'glass-tasks-export';
const BACKUP_FORMAT = 'glass-tasks-backup';
const EXPORT_SCHEMA_VERSION = 1;

/** Backups kept per reason. */
const BACKUP_KEEP = { weekly: 8, manual: 8, 'pre-import': 3 };
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_NAME_RE = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(weekly|manual|pre-import)(?:-\d+)?\.json$/;

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_HABITS = 5000;
const HABIT_ID_RE = /^[\x21-\x7E]{1,256}$/;
const MAX_LOG_BYTES = 1024 * 1024;

/** Settings that describe this PC rather than the user's preferences. */
const MACHINE_SETTINGS = new Set(['pos', 'lastHabitsResetDate', 'onboardingSkipped']);

const REDACTED = '[скрыто]';

function appVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return null;
  }
}

function backupsDir() {
  return dataPath('backups');
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {Date} d local date as YYYYMMDD-HHMMSS */
function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Settings worth carrying to another PC / restoring (no window position). */
function exportableSettings() {
  /** @type {Record<string, any>} */
  const out = { ...loadSettings() };
  for (const key of MACHINE_SETTINGS) delete out[key];
  return out;
}

/**
 * @param {{ format: string, now?: Date, reason?: string,
 *   habitTitles?: Record<string, string> | null, logsDir?: string | null }} opts
 */
function buildSnapshot(opts) {
  const now = opts.now || new Date();
  const store = loadStore();
  /** @type {Record<string, { title?: string, dates: string[] }>} */
  const habits = {};
  for (const [id, entry] of Object.entries(store.habits)) {
    if (!entry.dates.length) continue;
    const title = opts.habitTitles && opts.habitTitles[id];
    habits[id] = { ...(title ? { title: String(title) } : {}), dates: entry.dates.slice() };
  }
  /** @type {Record<string, any>} */
  const snapshot = {
    format: opts.format,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    ...(opts.reason ? { reason: opts.reason } : {}),
    app: { version: appVersion() },
    settings: exportableSettings(),
    habits,
  };
  if (opts.logsDir) snapshot.logs = readLogs(opts.logsDir);
  return snapshot;
}

/**
 * Newest log files first, up to MAX_LOG_BYTES in total (tail of a file when it is larger).
 * @param {string} dir
 */
function readLogs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .map((name) => {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        return st.isFile() ? { name, full, size: st.size, mtime: st.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  let budget = MAX_LOG_BYTES;
  for (const f of files) {
    if (budget <= 0) break;
    const take = Math.min(f.size, budget);
    try {
      const buf = Buffer.alloc(take);
      const fd = fs.openSync(f.full, 'r');
      try {
        fs.readSync(fd, buf, 0, take, f.size - take);
      } finally {
        fs.closeSync(fd);
      }
      out.push({ name: f.name, modifiedAt: new Date(f.mtime).toISOString(), truncated: take < f.size, text: buf.toString('utf8') });
      budget -= take;
    } catch {
      /* locked by the logger — skip */
    }
  }
  return out;
}

/** Live secret values that must never leave the data folder. */
function knownSecrets() {
  /** @type {string[]} */
  const values = [];
  try {
    const tokens = readSecretJson(dataPath('tokens.json'), null);
    for (const key of ['refresh_token', 'access_token', 'id_token']) {
      if (tokens && typeof tokens[key] === 'string') values.push(tokens[key]);
    }
  } catch {
    /* unreadable tokens are not exported either */
  }
  const creds = getGoogleClientCredentials();
  if (creds && creds.clientSecret) values.push(creds.clientSecret);
  return values.filter((v) => v.length >= 8);
}

const SECRET_PATTERNS = [
  // "refresh_token": "…" and friends, in JSON or in a logged object
  /("(?:refresh_token|access_token|id_token|client_secret|clientSecret|code_verifier)"\s*:\s*")[^"]*(")/g,
  /\bya29\.[0-9A-Za-z_-]+/g, // Google access token
  /\b1\/\/[0-9A-Za-z_-]{20,}/g, // Google refresh token
  /\bGOCSPX-[0-9A-Za-z_-]+/g, // OAuth client secret
];

/**
 * Remove anything secret-looking from export text. Throws if a live secret survives.
 * @param {string} text
 * @param {string[]} [secrets]
 */
function redactSecrets(text, secrets = knownSecrets()) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    // Patterns with groups keep the JSON key and quotes; the others are replaced whole.
    out = out.replace(re, (match, pre, post) => (typeof pre === 'string' ? `${pre}${REDACTED}${post}` : REDACTED));
  }
  for (const secret of secrets) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  for (const secret of secrets) {
    if (out.includes(secret)) throw new Error('Экспорт остановлен: в данных найден секрет.');
  }
  return out;
}

/**
 * Write the JSON export (settings, habit history, logs) to a user-chosen file.
 * @param {string} filePath
 * @param {{ habitTitles?: Record<string, string> | null, logsDir?: string | null, now?: Date }} [opts]
 */
function exportJson(filePath, opts = {}) {
  const snapshot = buildSnapshot({ format: EXPORT_FORMAT, ...opts });
  const text = redactSecrets(JSON.stringify(snapshot, null, 2));
  writeFileAtomic(filePath, text);
  return {
    path: filePath,
    habits: Object.keys(snapshot.habits).length,
    logs: snapshot.logs ? snapshot.logs.length : 0,
    bytes: Buffer.byteLength(text),
  };
}

// ── CSV ────────────────────────────────────────────────────────────────────

const CSV_SEPARATOR = ';'; // what Excel expects with Russian regional settings

/** RFC 4180 quoting; a leading = + - @ is neutralised so Excel never runs it as a formula. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\r\n,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {{ tasks?: any[], habits?: any[], tasksListName?: string, habitsListName?: string }} payload
 * @returns {{ text: string, rows: number }}
 */
function tasksToCsv(payload) {
  const header = ['Список', 'Название', 'Заметки', 'Срок', 'Время', 'Выполнено', 'Родительская задача', 'ID'];
  const lines = [header.map(csvCell).join(CSV_SEPARATOR)];
  let rows = 0;
  const lists = [
    [payload.tasksListName || 'Tasks', Array.isArray(payload.tasks) ? payload.tasks : []],
    [payload.habitsListName || 'Habits', Array.isArray(payload.habits) ? payload.habits : []],
  ];
  for (const [listName, items] of lists) {
    const titles = new Map(items.filter((t) => t && t.id).map((t) => [t.id, t.title]));
    for (const t of items) {
      if (!t || !t.id) continue;
      const due = typeof t.due === 'string' ? t.due.slice(0, 10) : '';
      lines.push(
        [
          listName,
          t.title || '',
          t.notes || '',
          due,
          t.dueTime || '',
          t.completed ? 'да' : 'нет',
          t.parent ? titles.get(t.parent) || t.parent : '',
          t.id,
        ]
          .map(csvCell)
          .join(CSV_SEPARATOR)
      );
      rows += 1;
    }
  }
  // BOM: Excel otherwise reads UTF-8 Cyrillic as mojibake.
  return { text: `\uFEFF${lines.join('\r\n')}\r\n`, rows };
}

/**
 * @param {string} filePath
 * @param {object} payload current widget data (tasks / habits as shown)
 */
function exportTasksCsv(filePath, payload) {
  const { text, rows } = tasksToCsv(payload || {});
  writeFileAtomic(filePath, redactSecrets(text));
  return { path: filePath, rows };
}

// ── Import ─────────────────────────────────────────────────────────────────

/**
 * Validate an export / backup file. Throws a Russian message on anything unexpected.
 * @param {string} text
 */
function parseImport(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Файл пустой.');
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new Error('Файл слишком большой для экспорта Glass Tasks.');
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Это не JSON-файл.');
  }
  if (!isPlainObject(doc) || (doc.format !== EXPORT_FORMAT && doc.format !== BACKUP_FORMAT)) {
    throw new Error('Это не экспорт и не резервная копия Glass Tasks.');
  }
  if (schemaVersionOf(doc) > EXPORT_SCHEMA_VERSION) {
    throw new Error('Файл сделан более новой версией Glass Tasks — обновите приложение.');
  }
  if (doc.habits !== undefined && !isPlainObject(doc.habits)) throw new Error('Раздел habits повреждён.');
  if (doc.settings !== undefined && !isPlainObject(doc.settings)) throw new Error('Раздел settings повреждён.');
  const rawHabits = doc.habits || {};
  if (Object.keys(rawHabits).length > MAX_IMPORT_HABITS) throw new Error('В файле слишком много привычек — это не похоже на экспорт Glass Tasks.');
  /** @type {Record<string, any>} */
  const habits = {};
  let offered = 0;
  for (const [id, entry] of Object.entries(rawHabits)) {
    if (!HABIT_ID_RE.test(id)) continue;
    habits[id] = entry;
    if (isPlainObject(entry) && Array.isArray(entry.dates)) offered += entry.dates.length;
  }
  const incoming = decodeStore({ habits });
  const accepted = Object.values(incoming.habits).reduce((n, h) => n + h.dates.length, 0);
  return {
    format: doc.format,
    createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : null,
    incoming,
    settings: doc.settings || null,
    invalidDates: Math.max(0, offered - accepted),
  };
}

/** Known, non machine-specific keys only; values are re-validated by normalizeSettings. */
function importableSettings(settings) {
  /** @type {Record<string, any>} */
  const patch = {};
  if (!settings) return patch;
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (MACHINE_SETTINGS.has(key) || !(key in settings)) continue;
    patch[key] = settings[key];
  }
  return patch;
}

/**
 * Merge an export / backup into the current data: habit days are united (nothing is removed),
 * settings from the file replace the current ones (except window position).
 * A «pre-import» backup is taken first, so the import can be undone.
 * @param {string} text
 * @param {{ includeSettings?: boolean, applySettings?: (patch: object) => unknown, now?: Date }} [opts]
 */
function importData(text, opts = {}) {
  const parsed = parseImport(text);
  const safety = createBackup({ reason: 'pre-import', now: opts.now, force: true });
  const merged = mergeHistory(parsed.incoming);
  /** @type {string[]} */
  let settingsApplied = [];
  if (opts.includeSettings !== false && parsed.settings) {
    const patch = importableSettings(parsed.settings);
    settingsApplied = Object.keys(patch);
    if (settingsApplied.length) (opts.applySettings || saveSettings)(patch);
  }
  return {
    format: parsed.format,
    createdAt: parsed.createdAt,
    habitsUpdated: merged.habits,
    daysAdded: merged.daysAdded,
    invalidDates: parsed.invalidDates,
    settingsApplied,
    backup: safety ? safety.name : null,
  };
}

// ── Backups ────────────────────────────────────────────────────────────────

/**
 * @returns {Array<{ name: string, path: string, reason: string, createdAt: string, createdAtMs: number, bytes: number }>}
 *   newest first
 */
function listBackups() {
  let names;
  try {
    names = fs.readdirSync(backupsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = BACKUP_NAME_RE.exec(name);
    if (!m) continue;
    const created = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    let bytes;
    try {
      bytes = fs.statSync(path.join(backupsDir(), name)).size;
    } catch {
      continue;
    }
    out.push({
      name,
      path: path.join(backupsDir(), name),
      reason: m[7],
      createdAt: created.toISOString(),
      createdAtMs: created.getTime(),
      bytes,
    });
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.name < b.name ? 1 : -1));
}

function pruneBackups() {
  const seen = /** @type {Record<string, number>} */ ({});
  for (const b of listBackups()) {
    seen[b.reason] = (seen[b.reason] || 0) + 1;
    if (seen[b.reason] > (BACKUP_KEEP[b.reason] || 3)) {
      try {
        fs.unlinkSync(b.path);
      } catch {
        /* next run */
      }
    }
  }
}

/**
 * Snapshot settings + habit history into data/backups.
 * @param {{ reason?: 'weekly' | 'manual' | 'pre-import', now?: Date, force?: boolean }} [opts]
 *   force: write even when there is nothing yet (manual / pre-import).
 * @returns {{ name: string, path: string, bytes: number } | null} null = nothing to back up
 */
function createBackup(opts = {}) {
  const reason = opts.reason || 'manual';
  const now = opts.now || new Date();
  const snapshot = buildSnapshot({ format: BACKUP_FORMAT, now, reason });
  const empty = !Object.keys(snapshot.habits).length && !fs.existsSync(dataPath('settings.json'));
  if (empty && !opts.force) return null;
  const base = `backup-${stamp(now)}-${reason}`;
  let name = `${base}.json`;
  for (let i = 2; fs.existsSync(path.join(backupsDir(), name)); i += 1) name = `${base}-${i}.json`;
  const file = path.join(backupsDir(), name);
  const text = redactSecrets(JSON.stringify(snapshot, null, 2));
  writeFileAtomic(file, text);
  pruneBackups();
  return { name, path: file, bytes: Buffer.byteLength(text) };
}

/**
 * Weekly backup: runs when the newest weekly one is older than 7 days.
 * @param {Date} [now]
 */
function runScheduledBackup(now = new Date()) {
  const latest = listBackups().find((b) => b.reason === 'weekly');
  if (latest && now.getTime() - latest.createdAtMs < BACKUP_INTERVAL_MS && latest.createdAtMs <= now.getTime()) {
    return null;
  }
  return createBackup({ reason: 'weekly', now });
}

module.exports = {
  EXPORT_FORMAT,
  BACKUP_FORMAT,
  BACKUP_KEEP,
  MAX_IMPORT_BYTES,
  backupsDir,
  buildSnapshot,
  exportJson,
  exportTasksCsv,
  tasksToCsv,
  csvCell,
  parseImport,
  importData,
  redactSecrets,
  listBackups,
  createBackup,
  runScheduledBackup,
};
