'use strict';

/**
 * Read-only description of how the user's data is stored right now, for the diagnostics
 * report and the settings screen: where it lives, what is encrypted, what is only in memory,
 * schema versions, backups and the storage events of this session.
 *
 * Contains file names, sizes and states only, never file contents or secret values.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const core = require('./storage-core');
const { getStorageEvents } = require('./storage-status');
const { listBackups } = require('./storage-backup');

/** Files that must only ever be on disk encrypted. */
const SECRET_FILES = new Set(['tokens.json', 'credentials.json', 'offline-cache.json']);
const MAX_FILES = 100;

/** Replace the home folder with ~ so a pasted report does not carry the user name. */
function shortenHome(p) {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function describeFile(dir, name) {
  const file = path.join(dir, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  /** @type {'encrypted' | 'plaintext' | 'plain' | 'unreadable'} */
  let protection = 'plain';
  let schemaVersion = null;
  if (stat.size <= 5 * 1024 * 1024 && /\.json$/.test(name)) {
    const res = core.readJsonStrict(file);
    if (res.state === 'ok' && res.value && typeof res.value === 'object') {
      if (res.value.format === core.SECRET_ENVELOPE) protection = 'encrypted';
      else if (SECRET_FILES.has(name)) protection = 'plaintext';
      if (Number.isInteger(res.value.schemaVersion)) schemaVersion = res.value.schemaVersion;
    } else if (res.state === 'corrupt') {
      protection = 'unreadable';
    }
  }
  return { name, size: stat.size, modified: stat.mtime.toISOString(), protection, schemaVersion };
}

/**
 * @returns {{
 *   generatedAt: string,
 *   dataDir: string,
 *   secrets: {
 *     safeStorageAvailable: boolean,
 *     mode: 'encrypted' | 'memory-only' | 'plaintext-dev',
 *     memoryOnly: string[],
 *     plaintextOnDisk: string[],
 *   },
 *   files: Array<ReturnType<typeof describeFile>>,
 *   backups: { count: number, newestWeekly: string | null },
 *   events: ReturnType<typeof getStorageEvents>,
 * }}
 */
function getStorageReport() {
  const dir = config.getDataRoot();
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    /* data folder not created yet */
  }
  const files = names.slice(0, MAX_FILES).map((n) => describeFile(dir, n)).filter(Boolean);
  const safeStorageAvailable = core.canEncrypt();
  const memoryOnly = core.memoryOnlySecretFiles();
  const plaintextOnDisk = files.filter((f) => f.protection === 'plaintext').map((f) => f.name);
  /** @type {'encrypted' | 'memory-only' | 'plaintext-dev'} */
  let mode = 'encrypted';
  if (!safeStorageAvailable) mode = core.plaintextSecretsAllowed() ? 'plaintext-dev' : 'memory-only';
  const backups = listBackups();
  const weekly = backups.find((b) => b.kind === 'weekly');
  return {
    generatedAt: new Date().toISOString(),
    dataDir: shortenHome(dir),
    secrets: { safeStorageAvailable, mode, memoryOnly, plaintextOnDisk },
    files,
    backups: { count: backups.length, newestWeekly: weekly ? weekly.date : null },
    events: getStorageEvents(),
  };
}

module.exports = { getStorageReport };
