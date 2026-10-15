'use strict';

/**
 * Test helper: run storage code against a throw-away data folder (never app/data)
 * with every module-level cache reset.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../../lib/config');
const core = require('../../lib/storage-core');
const status = require('../../lib/storage-status');
const files = require('../../lib/storage-files');
const { resetSettingsCache } = require('../../lib/settings-store');
const { resetStreakCache } = require('../../lib/streak-store');
const { resetOfflineCacheForTests } = require('../../lib/offline-cache');

/** Reversible stand-in for Electron safeStorage. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (b) => {
    const text = b.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not encrypted by fakeSafeStorage');
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};

function resetAll() {
  core.unfreezeWritesForTests();
  config.setSafeStorageForTests(undefined);
  core.forgetSecretMemory();
  status.clearStorageEvents();
  files.resetStorageFilesForTests();
  resetSettingsCache();
  resetStreakCache();
  resetOfflineCacheForTests();
}

/**
 * Point storage at a fresh temp folder for the current test file section.
 * Call inside `beforeEach`; the returned object's `dir` is the data folder.
 * @returns {{ dir: string, base: string, cleanup: () => void }}
 */
function useTempDataRoot() {
  resetAll();
  // <tmp>/gt-xxxx/data mirrors the real layout (<userData>/data) and keeps siblings (logs, exports) apart.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'));
  const dir = path.join(base, 'data');
  fs.mkdirSync(dir);
  config.setDataRootForTests(dir);
  return {
    dir,
    base,
    cleanup() {
      resetAll();
      config.setDataRootForTests(null);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const readJsonFile = (dir, name) => JSON.parse(read(dir, name));
const write = (dir, name, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));
};
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

module.exports = { fakeSafeStorage, useTempDataRoot, resetAll, read, readJsonFile, write, exists };
