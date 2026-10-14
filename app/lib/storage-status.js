'use strict';

/**
 * Storage health for the diagnostics report and the settings screen. Never contains secrets.
 * lib/diagnostics.js can include `describeStorageStatus(getStorageStatus())` as-is.
 */

const fs = require('fs');
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

const LEFTOVER_RE = /\.(corrupt-\d+|v\d+\.bak|\d+\.\d+\.tmp)$/;

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
    dataRoot: getDataRoot(),
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

module.exports = { getStorageStatus, describeStorageStatus };
