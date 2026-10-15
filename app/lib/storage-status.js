'use strict';

/**
 * Storage health for the diagnostics report and the settings screen. Never contains secrets.
 * lib/diagnostics.js can include `describeStorageStatus(getStorageStatus())` as-is.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  canEncrypt,
  dataPath,
  getDataRoot,
  describeSecretFile,
  getCredentialsJsonPath,
  getGoogleCredentialsStatus,
} = require('./config');
const { listDocs } = require('./storage-doc');
const { getStorageIssues } = require('./storage-events');
const { listBackups } = require('./storage-backup');
// Each store registers its document on load; require them so the list is complete.
require('./settings-store');
require('./streak-store');
require('./reminder-store');
require('./offline-cache');
require('./mock-data');

const LEFTOVER_RE = /\.(corrupt-\d+|v\d+\.bak|unread-\d+\.bak|\d+\.\d+\.tmp)$/;

/**
 * Path without the Windows user name, for reports people paste into issues:
 * a known prefix becomes %APPDATA% / %LOCALAPPDATA% / %USERPROFILE%, anything else
 * (redirected or UNC profiles) is cut down to its last two folders.
 * @param {string} p
 * @param {{ env?: Record<string, string | undefined>, home?: string, pathApi?: typeof path }} [opts]
 */
function displayPath(p, opts = {}) {
  const env = opts.env || process.env;
  const api = opts.pathApi || path;
  const caseless = api === path.win32 || (api === path && process.platform === 'win32');
  const prefixes = [
    [env.APPDATA, '%APPDATA%'],
    [env.LOCALAPPDATA, '%LOCALAPPDATA%'],
    [env.USERPROFILE || (opts.env ? undefined : opts.home || os.homedir()), '%USERPROFILE%'],
  ]
    .filter(([prefix]) => typeof prefix === 'string' && prefix.length > 3)
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  const norm = api.normalize(p);
  for (const [prefix, name] of prefixes) {
    const base = api.normalize(String(prefix)).replace(/[\\/]+$/, '');
    const head = norm.slice(0, base.length);
    const same = caseless ? head.toLowerCase() === base.toLowerCase() : head === base;
    if (same && (norm.length === base.length || norm[base.length] === api.sep)) return name + norm.slice(base.length);
  }
  const parts = norm.split(api.sep).filter(Boolean);
  return ['…', ...parts.slice(-2)].join(api.sep);
}

function safeStorageBackend() {
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'darwin') return 'keychain';
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend();
    }
  } catch {
    /* plain node */
  }
  return null;
}

function getStorageStatus() {
  const encryptionAvailable = canEncrypt();
  const tokens = describeSecretFile(dataPath('tokens.json'));
  const credentials = describeSecretFile(getCredentialsJsonPath());
  let leftovers = [];
  try {
    leftovers = fs.readdirSync(getDataRoot()).filter((n) => LEFTOVER_RE.test(n)).sort();
  } catch {
    /* no data folder yet */
  }
  const backups = listBackups();
  const issues = getStorageIssues();
  const secretsAtRisk = [tokens, credentials].some((s) => s === 'plaintext' || s === 'memory' || s === 'locked');
  return {
    dataRoot: displayPath(getDataRoot()),
    encryption: { available: encryptionAvailable, backend: safeStorageBackend() },
    secrets: { tokens, credentials },
    credentialsSource: getGoogleCredentialsStatus().source,
    files: listDocs().map((d) => d.info()),
    backups: {
      count: backups.length,
      latest: backups.length ? { name: backups[0].name, createdAt: backups[0].createdAt } : null,
    },
    leftovers,
    issues,
    ok: encryptionAvailable && !secretsAtRisk && !issues.some((i) => i.level !== 'info'),
  };
}

const SECRET_TEXT = {
  encrypted: 'зашифрован',
  locked: 'зашифрован, но сейчас не открывается (DPAPI недоступен)',
  plaintext: 'ОТКРЫТЫМ ТЕКСТОМ',
  memory: 'только в памяти до закрытия виджета',
  missing: 'нет',
  unreadable: 'не читается',
};

function kb(bytes) {
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

/**
 * Human-readable lines (Russian) for the diagnostics report.
 * @param {ReturnType<typeof getStorageStatus>} status
 * @returns {string[]}
 */
function describeStorageStatus(status) {
  const lines = [
    `Папка данных: ${status.dataRoot}`,
    `Шифрование safeStorage (${status.encryption.backend || 'нет'}): ${
      status.encryption.available ? 'доступно' : 'НЕДОСТУПНО — вход Google и кэш задач не сохраняются между запусками'
    }`,
    `tokens.json (вход Google): ${SECRET_TEXT[status.secrets.tokens] || status.secrets.tokens}`,
    `credentials.json (ключи Google): ${SECRET_TEXT[status.secrets.credentials] || status.secrets.credentials}${
      status.credentialsSource && status.credentialsSource !== 'credentials.json' ? ` (ключи взяты из ${status.credentialsSource})` : ''
    }`,
  ];
  for (const f of status.files) {
    if (!f.exists && !f.memoryOnly) {
      lines.push(`${f.name}: нет`);
      continue;
    }
    const parts = [];
    if (f.exists) parts.push(kb(f.bytes), `схема ${f.schemaVersion === null ? '?' : f.schemaVersion}`);
    if (f.encrypted) parts.push('зашифрован');
    else if (f.encryptedByDesign && f.exists) parts.push('НЕ зашифрован (старый формат)');
    if (f.memoryOnly) parts.push('только в памяти');
    if (f.lastGood) parts.push(f.hasLastGood ? 'копия .bak есть' : 'копии .bak нет');
    lines.push(`${f.name}: ${parts.join(', ')}`);
  }
  lines.push(
    `Резервные копии: ${status.backups.count}${status.backups.latest ? `, последняя ${status.backups.latest.createdAt}` : ''}`
  );
  if (status.leftovers.length) lines.push(`Карантин и копии миграций: ${status.leftovers.join(', ')}`);
  for (const issue of status.issues) {
    lines.push(`[${issue.level}] ${issue.at} ${issue.file || ''} ${issue.message}`.replace(/\s+/g, ' ').trim());
  }
  return lines;
}

module.exports = { getStorageStatus, describeStorageStatus, displayPath };
