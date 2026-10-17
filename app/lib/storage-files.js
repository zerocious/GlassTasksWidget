'use strict';

/**
 * Document layer over the JSON files in the data folder. Every file the widget owns is a
 * "document": a plain object with a numeric `schemaVersion`. This module gives all of them
 * the same behaviour:
 *
 *  - a file without `schemaVersion` is version 0 (written by an older widget);
 *  - an older file is migrated step by step (`migrations[N]` turns version N-1 into N),
 *    after a copy of the original is saved to `backups/migrations/` (never for secret
 *    documents: a legacy secrets file may be plaintext, and a copy would outlive the encryption);
 *  - a damaged file is moved aside (`*.corrupt-<ts>`) and, when the document keeps a last
 *    good copy (`keepBak`), restored from `<file>.bak`;
 *  - a file written by a NEWER widget is copied to `backups/migrations/` once and then never
 *    rewritten by this older widget (changes to it are not saved);
 *  - a file that exists but cannot be read right now (locked by an antivirus, no access) is
 *    'unreadable': nothing is rebuilt from defaults and saving over it is refused;
 *  - a `schemaVersion` that is not a non-negative integer is treated as damage, not as version 0;
 *  - every notable event is recorded for the diagnostics report (storage-status.js).
 *
 * Secret documents (`secret: true`) go through safeStorage via storage-core.
 */

const fs = require('fs');
const path = require('path');
const core = require('./storage-core');
const { recordStorageEvent } = require('./storage-status');

/** How many pre-migration copies are kept per file. */
const MIGRATION_BACKUPS_KEEP = 3;

/**
 * @typedef {{
 *   name: string,
 *   file: () => string,
 *   version: number,
 *   migrations?: Record<number, (data: any) => any>,
 *   secret?: boolean,
 *   keepBak?: boolean,
 *   pretty?: boolean,
 *   validate?: (data: any) => boolean,
 * }} DocSpec
 * `file` is resolved lazily because the data folder can change (tests, isolated profiles).
 * `migrations[N]` receives a deep copy of the version N-1 document and returns version N.
 * `keepBak` writes `<file>.bak` on every successful save and restores from it.
 *
 * @typedef {{
 *   data: Record<string, any> | null,
 *   status: 'missing' | 'ok' | 'migrated' | 'restored' | 'reset' | 'newer' | 'unreadable',
 *   migratedFrom?: number,
 * }} LoadResult
 */

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Files for which a "newer schema" copy was already made this session. */
const newerHandled = new Set();
/** Files written by a newer widget: this older one reads them but never rewrites them. */
const newerFiles = new Set();
/** Files that exist but could not be read last time; saving over them is refused. */
const unreadableFiles = new Set();
/** Valid `schemaVersion`: a non-negative integer. */
const isValidVersion = (v) => Number.isInteger(v) && v >= 0;

function migrationDir(file) {
  return path.join(path.dirname(file), 'backups', 'migrations');
}

/**
 * Copy `file` into backups/migrations before it is rewritten in another format.
 * @returns {string | null} the copy, or null if it could not be made
 */
function backupBeforeMigration(file, tag) {
  const dir = migrationDir(file);
  const base = path.basename(file);
  const dest = path.join(dir, `${base}.${tag}.${Date.now()}.bak`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, dest);
  } catch (err) {
    console.warn(`[storage] pre-migration copy of ${base} failed:`, err && err.message ? err.message : err);
    return null;
  }
  try {
    const mine = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of mine.slice(MIGRATION_BACKUPS_KEEP)) fs.unlinkSync(path.join(dir, old.n));
  } catch {
    /* pruning is best effort */
  }
  return dest;
}

/** Try `<file>.bak`; on success it also becomes the main file again. */
function restoreFromBak(spec) {
  const file = spec.file();
  const res = core.readJsonStrict(`${file}.bak`);
  if (res.state !== 'ok' || !isPlainObject(res.value)) return null;
  if (spec.validate && !spec.validate(res.value)) return null;
  try {
    core.writeFileAtomic(file, res.text);
  } catch (err) {
    console.warn(`[storage] could not restore ${spec.name} from .bak:`, err && err.message ? err.message : err);
    return null;
  }
  return res.value;
}

/**
 * Move a damaged non-secret document aside and bring back the last good copy if there is one.
 * @param {DocSpec} spec
 * @param {unknown} err why it is considered damaged
 * @returns {Record<string, any> | null} the restored document, or null when the data was reset
 */
function recoverDamaged(spec, err) {
  if (core.quarantineCorruptFile(spec.file(), err)) recordStorageEvent('corrupt-quarantined', spec.name);
  const restored = spec.keepBak ? restoreFromBak(spec) : null;
  if (!restored || (Object.prototype.hasOwnProperty.call(restored, 'schemaVersion') && !isValidVersion(restored.schemaVersion))) {
    recordStorageEvent('corrupt-reset', spec.name);
    return null;
  }
  recordStorageEvent('restored-from-backup', spec.name);
  return restored;
}

/** The file exists but cannot be read now: say so, and make sure nothing overwrites it. */
function markUnreadable(spec, file) {
  if (!unreadableFiles.has(file)) recordStorageEvent('read-failed', spec.name);
  unreadableFiles.add(file);
  return { data: null, status: /** @type {const} */ ('unreadable') };
}

/**
 * Read a document, migrating / recovering as described above.
 * @param {DocSpec} spec
 * @returns {LoadResult}
 */
function loadDoc(spec) {
  const result = loadDocInner(spec);
  if (result.status !== 'unreadable') unreadableFiles.delete(spec.file());
  if (result.status !== 'newer') newerFiles.delete(spec.file());
  return result;
}

/** @param {DocSpec} spec @returns {LoadResult} */
function loadDocInner(spec) {
  const file = spec.file();
  let raw;
  let status = /** @type {LoadResult['status']} */ ('ok');

  if (spec.secret) {
    try {
      raw = core.readSecretJson(file, undefined);
    } catch (err) {
      if (err && err.code === 'EUNREADABLE') return markUnreadable(spec, file);
      throw err;
    }
    if (raw === undefined) return { data: null, status: 'missing' };
    if (!isPlainObject(raw)) return { data: null, status: 'reset' };
    if (Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') && !isValidVersion(raw.schemaVersion)) {
      return { data: null, status: 'reset' };
    }
  } else {
    const res = core.readJsonStrict(file);
    if (res.state === 'missing') return { data: null, status: 'missing' };
    if (res.state === 'unreadable') return markUnreadable(spec, file);
    let damage = null;
    if (res.state === 'corrupt') damage = res.error;
    else if (!isPlainObject(res.value)) damage = new Error('unexpected JSON shape');
    else if (Object.prototype.hasOwnProperty.call(res.value, 'schemaVersion') && !isValidVersion(res.value.schemaVersion)) {
      // «1», 1.5, null...: not something this app wrote, so do not guess its format.
      damage = new Error('invalid schemaVersion');
    } else if (spec.validate && !spec.validate(res.value)) damage = new Error('failed validation');
    if (damage) {
      const restored = recoverDamaged(spec, damage);
      if (!restored) return { data: null, status: 'reset' };
      raw = restored;
      status = 'restored';
    } else {
      raw = res.value;
    }
  }

  const version = isValidVersion(raw.schemaVersion) ? raw.schemaVersion : 0;

  if (version > spec.version) {
    newerFiles.add(file);
    if (!newerHandled.has(file)) {
      newerHandled.add(file);
      // Secret documents get no copies: a legacy file may be plaintext and a copy would outlive encryption.
      if (!spec.secret) backupBeforeMigration(file, `newer-v${version}`);
      recordStorageEvent('newer-schema', spec.name);
    }
    return { data: raw, status: 'newer' };
  }

  if (version < spec.version) {
    // Never copy a secrets file (see above); it can always be recreated by signing in again.
    if (!spec.secret && fs.existsSync(file)) backupBeforeMigration(file, `v${version}`);
    let data = structuredClone(raw);
    try {
      for (let v = version + 1; v <= spec.version; v += 1) {
        const step = spec.migrations && spec.migrations[v];
        if (step) data = step(data);
      }
    } catch (err) {
      console.warn(`[storage] migration of ${spec.name} failed:`, err && err.message ? err.message : err);
      if (!spec.secret) core.quarantineCorruptFile(file, err);
      recordStorageEvent('migration-failed', spec.name);
      return { data: null, status: 'reset' };
    }
    data.schemaVersion = spec.version;
    // Without safeStorage a secrets file cannot be rewritten (it would only go to memory and the
    // old file would be deleted): leave it as it is and use the migrated data for this session.
    if (spec.secret && !core.canEncrypt() && !core.plaintextSecretsAllowed()) {
      return { data, status: 'migrated', migratedFrom: version };
    }
    try {
      saveDoc(spec, data);
    } catch {
      /* saveDoc already recorded write-failed; the migrated data is still usable in memory */
    }
    recordStorageEvent('migrated', spec.name);
    return { data, status: 'migrated', migratedFrom: version };
  }

  return { data: raw, status };
}

/**
 * Write a document at the current schema version.
 * Throws when the disk write fails (after recording a `write-failed` event).
 * @param {DocSpec} spec
 * @param {Record<string, any>} data
 * @returns {{ persisted: boolean }}
 */
function saveDoc(spec, data) {
  const file = spec.file();
  if (newerFiles.has(file)) {
    // Written by a newer widget: rewriting it would drop fields this version does not know.
    return { persisted: false };
  }
  if (unreadableFiles.has(file)) {
    throw new Error(`Файл «${spec.name}» сейчас недоступен для чтения: сохранение отменено, чтобы не затереть данные.`);
  }
  /** @type {Record<string, any>} */
  const out = { schemaVersion: spec.version };
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'schemaVersion') out[k] = v;
  }
  try {
    if (spec.secret) {
      const res = core.writeSecretJson(file, out);
      return { persisted: res.persisted };
    }
    const body = spec.pretty === false ? JSON.stringify(out) : JSON.stringify(out, null, 2);
    core.writeFileAtomic(file, body);
    if (spec.keepBak) {
      try {
        core.writeFileAtomic(`${file}.bak`, body);
      } catch (err) {
        console.warn(`[storage] could not refresh ${spec.name}.bak:`, err && err.message ? err.message : err);
      }
    }
    return { persisted: true };
  } catch (err) {
    recordStorageEvent('write-failed', spec.name);
    throw err;
  }
}

/** Remove a document and its last good copy. Never throws. */
function deleteDoc(spec) {
  const file = spec.file();
  try {
    if (spec.secret) core.deleteSecretJson(file);
    else fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(`${file}.bak`);
  } catch {
    /* none */
  }
}

/** Test hook. */
function resetStorageFilesForTests() {
  newerHandled.clear();
  newerFiles.clear();
  unreadableFiles.clear();
}

module.exports = {
  MIGRATION_BACKUPS_KEEP,
  loadDoc,
  saveDoc,
  deleteDoc,
  backupBeforeMigration,
  resetStorageFilesForTests,
};
