'use strict';

/** Shared setup for storage tests: temp data folder, fake safeStorage, clean module state. */

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../../lib/config');
const { clearStorageIssues } = require('../../lib/storage-events');

/** Reversible stand-in for Electron safeStorage. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (b) => {
    const text = b.toString('utf8');
    assert.ok(text.startsWith('enc:'), 'not produced by fakeSafeStorage');
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};

function tmpDir(prefix = 'gt-storage-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Fresh temp data root + reset of every in-memory cache.
 * @param {{ safeStorage?: object | null }} [opts] default: fake encryption available
 * @returns {string} data root
 */
function freshDataRoot(opts = {}) {
  const root = path.join(tmpDir(), 'data');
  fs.mkdirSync(root, { recursive: true });
  config.setDataRootForTests(root);
  config.setSafeStorageForTests(opts.safeStorage === undefined ? fakeSafeStorage : opts.safeStorage);
  config.freezeWrites(false);
  config.clearMemorySecrets();
  config.resetEnvCache();
  clearStorageIssues();
  require('../../lib/settings-store').resetSettingsCache();
  require('../../lib/streak-store').resetStreakCache();
  require('../../lib/offline-cache').resetOfflineCacheMemory();
  return root;
}

function writeRaw(root, name, value) {
  fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function readRaw(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

module.exports = { fakeSafeStorage, tmpDir, freshDataRoot, writeRaw, readRaw };
