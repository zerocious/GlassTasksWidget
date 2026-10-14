'use strict';

/**
 * Versioned JSON documents under data/: one place for schema migration, the «last good copy»,
 * corrupt-file recovery, optional encryption and debounced writes.
 *
 * On disk: `{ "schemaVersion": N, ...fields }`, or for encrypted documents
 * `{ "format": "glass-tasks/safeStorage@1", "schemaVersion": N, "data": "<base64>" }`
 * whose decrypted text is the same plain document.
 *
 * Failure behaviour (each case is reported through storage-events, so the user sees it):
 * - unparseable file → moved to `<name>.corrupt-<ts>`, then `<name>.bak` is restored if valid,
 *   otherwise defaults are used;
 * - file from an older schema → copied to `<name>.v<old>.bak`, migrated, saved;
 * - file from a newer app version → copied to `<name>.v<new>.bak` before it can be overwritten;
 * - encrypted file while safeStorage is unavailable → left untouched, defaults in memory;
 * - encryption unavailable on save → data kept in memory for the session, never written in clear.
 */

const fs = require('fs');
const path = require('path');
const {
  dataPath,
  writeFileAtomic,
  quarantineCorruptFile,
  canEncrypt,
  encryptText,
  decryptText,
  SECRET_ENVELOPE,
} = require('./config');
const { migrate, schemaVersionOf } = require('./storage-migrate');
const { reportStorageIssue } = require('./storage-events');

/**
 * @typedef {{
 *   name: string,
 *   label: string,
 *   version: number,
 *   defaults: () => Record<string, any>,
 *   migrations?: Record<number, (data: any) => any>,
 *   lastGood?: boolean,
 *   encrypt?: boolean,
 *   compact?: boolean,
 *   backupBeforeMigrate?: boolean,
 *   debounceMs?: number,
 * }} DocSpec
 *   name: file under data/; label: Russian noun for messages («история привычек»);
 *   lastGood: keep `<name>.bak` (copy of the last successful save) and restore from it;
 *   encrypt: safeStorage, memory-only when unavailable; compact: no indentation;
 *   backupBeforeMigrate: default true, except for encrypted docs (a plain copy would leak them).
 */

/** @type {Map<string, ReturnType<typeof createJsonDoc>>} */
const registry = new Map();

const READ_RETRIES = 4;
const READ_RETRY_MS = 60;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a file, riding out short locks (antivirus, indexer, sync tools on Windows).
 * @returns {{ status: 'ok', text: string } | { status: 'missing' } | { status: 'unreadable', error: any }}
 */
function readTextWithRetry(filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { status: 'ok', text: fs.readFileSync(filePath, 'utf8') };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { status: 'missing' };
      if ((error && error.code === 'EISDIR') || attempt >= READ_RETRIES) return { status: 'unreadable', error };
      sleepSync(READ_RETRY_MS * (attempt + 1));
    }
  }
}

/**
 * @param {string} filePath
 * @returns {{ status: 'ok', raw: Record<string, any>, encrypted: boolean }
 *   | { status: 'missing' } | { status: 'locked' }
 *   | { status: 'corrupt', error: any } | { status: 'unreadable', error: any }}
 */
function parseDocFile(filePath) {
  const read = readTextWithRetry(filePath);
  if (read.status !== 'ok') return read;
  let raw;
  try {
    raw = JSON.parse(read.text);
  } catch (error) {
    return { status: 'corrupt', error };
  }
  if (!isPlainObject(raw)) return { status: 'corrupt', error: new Error('not a JSON object') };
  if (raw.format !== SECRET_ENVELOPE) return { status: 'ok', raw, encrypted: false };
  if (!canEncrypt()) return { status: 'locked' };
  try {
    const inner = JSON.parse(decryptText(raw.data));
    if (!isPlainObject(inner)) throw new Error('not a JSON object');
    return { status: 'ok', raw: inner, encrypted: true };
  } catch (error) {
    // Wrong key (profile copied from another PC / user) or damaged ciphertext.
    return { status: 'corrupt', error };
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** @param {DocSpec} spec */
function createJsonDoc(spec) {
  const backupBeforeMigrate =
    spec.backupBeforeMigrate !== undefined ? spec.backupBeforeMigrate : !spec.encrypt;
  /** @type {Record<string, any> | undefined} session-only copy when encryption is unavailable */
  let memory;
  /** @type {Record<string, any> | undefined} data waiting for a debounced write */
  let pending;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** The file could not be read this session: its content was never loaded, so never overwrite it blindly. */
  let unreadOnDisk = false;

  const file = () => dataPath(spec.name);
  const bakFile = () => `${file()}.bak`;

  /** Copy `src` to `<name>.<suffix>` once (an existing copy is the older, more valuable one). */
  function copyAside(src, suffix) {
    const target = `${file()}.${suffix}`;
    if (statSafe(target)) return target;
    try {
      fs.copyFileSync(src, target);
      return target;
    } catch (err) {
      console.warn(`[storage] could not copy ${spec.name} to ${target}:`, err && err.message ? err.message : err);
      return null;
    }
  }

  /**
   * Migrate parsed content and persist the result when it changed.
   * @param {{ raw: Record<string, any>, encrypted: boolean }} parsed
   * @param {string} src file the content came from
   * @param {boolean} restoring main file is gone (quarantined) and must be written back
   */
  function accept(parsed, src, restoring) {
    const m = migrate(parsed.raw, spec);
    if (m.newer) {
      const copy = copyAside(src, `v${m.from}.bak`);
      reportStorageIssue({
        kind: 'newer-version',
        file: spec.name,
        message: `${capitalize(spec.label)}: файл создан более новой версией Glass Tasks (схема ${m.from}, эта версия знает ${spec.version}). ${
          copy ? `Копия сохранена как ${path.basename(copy)}.` : 'Сделать копию не удалось.'
        } Обновите приложение, чтобы не потерять новые данные.`,
      });
      if (restoring) safeWrite(m.data);
      return m.data;
    }
    const needsEncryption = Boolean(spec.encrypt && !parsed.encrypted && canEncrypt());
    if (m.changed || restoring || needsEncryption) {
      if (m.changed && backupBeforeMigrate) copyAside(src, `v${m.from}.bak`);
      safeWrite(m.data);
      if (m.changed) {
        reportStorageIssue({
          kind: 'migrated',
          file: spec.name,
          level: 'info',
          message: `${capitalize(spec.label)}: формат обновлён (схема ${m.from} → ${m.to}).`,
        });
      }
    }
    return m.data;
  }

  /** @returns {Record<string, any>} document without `schemaVersion` */
  function read() {
    if (pending !== undefined) return clone(pending);
    if (memory !== undefined) return clone(memory);
    const main = parseDocFile(file());
    if (main.status === 'ok') return accept(main, file(), false);
    if (main.status === 'missing') return spec.defaults();
    if (main.status === 'locked') {
      reportStorageIssue({
        kind: 'locked',
        file: spec.name,
        message: `${capitalize(spec.label)}: файл зашифрован, а шифрование Windows сейчас недоступно. Файл не тронут, до перезапуска используются пустые данные.`,
      });
      return spec.defaults();
    }
    if (main.status === 'unreadable') {
      // Locked by another program: leave it alone, fall back to the last good copy if any.
      unreadOnDisk = true;
      const bak = spec.lastGood ? parseDocFile(bakFile()) : null;
      reportStorageIssue({
        kind: 'unreadable',
        file: spec.name,
        level: 'error',
        message: `${capitalize(spec.label)}: файл не открывается (${main.error && main.error.code ? main.error.code : 'ошибка чтения'}). ${
          bak && bak.status === 'ok' ? 'Используется последняя хорошая копия.' : 'Используются данные по умолчанию.'
        } Закройте программы, которые могут держать файл, и перезапустите виджет.`,
      });
      return bak && bak.status === 'ok' ? migrate(bak.raw, spec).data : spec.defaults();
    }
    // Corrupt: quarantine, then try the last good copy.
    const movedTo = quarantineCorruptFile(file(), main.error);
    if (spec.lastGood) {
      const bak = parseDocFile(bakFile());
      if (bak.status === 'ok') {
        const data = accept(bak, bakFile(), true);
        reportStorageIssue({
          kind: 'restored-from-backup',
          file: spec.name,
          repeat: true,
          message: `${capitalize(spec.label)}: файл был повреждён и восстановлен из последней хорошей копии.${
            movedTo ? ` Повреждённый файл: ${path.basename(movedTo)}.` : ''
          }`,
        });
        return data;
      }
      if (bak.status === 'corrupt') quarantineCorruptFile(bakFile(), bak.error);
    }
    reportStorageIssue({
      kind: 'reset-corrupt',
      file: spec.name,
      level: 'error',
      repeat: true,
      message: `${capitalize(spec.label)}: файл повреждён${spec.lastGood ? ', хорошей копии нет' : ''}, начато с чистого листа.${
        movedTo ? ` Старый файл сохранён как ${path.basename(movedTo)}.` : ''
      }`,
    });
    return spec.defaults();
  }

  /**
   * Save now (atomic, flushed). Throws when the disk write fails (and reports it).
   * @returns {'disk' | 'memory'}
   */
  function write(data) {
    cancelPending();
    /** @type {Record<string, any>} */
    const payload = { schemaVersion: spec.version };
    Object.assign(payload, data);
    payload.schemaVersion = spec.version;
    let body = JSON.stringify(payload, null, spec.compact ? undefined : 2);
    if (spec.encrypt) {
      if (!canEncrypt()) {
        memory = clone(data);
        reportStorageIssue({
          kind: 'memory-only',
          file: spec.name,
          message: `${capitalize(spec.label)}: шифрование Windows недоступно, данные хранятся только до закрытия виджета (на диск открытым текстом не пишутся).`,
        });
        return 'memory';
      }
      body = JSON.stringify({ format: SECRET_ENVELOPE, schemaVersion: spec.version, data: encryptText(body) });
    }
    memory = undefined;
    try {
      if (unreadOnDisk) preserveUnreadFile();
      writeFileAtomic(file(), body);
    } catch (err) {
      reportStorageIssue({
        kind: 'write-failed',
        file: spec.name,
        level: 'error',
        message: `${capitalize(spec.label)}: не удалось сохранить (${err && err.code ? err.code : 'ошибка записи'}). Проверьте свободное место и права на папку данных.`,
        detail: err && err.message ? err.message : String(err),
      });
      throw err;
    }
    if (spec.lastGood) {
      try {
        writeFileAtomic(bakFile(), body);
      } catch (err) {
        console.warn(`[storage] ${spec.name}.bak not written:`, err && err.message ? err.message : err);
      }
    }
    return 'disk';
  }

  /**
   * Before the first overwrite of a file this session never managed to read, keep its bytes
   * as `<name>.unread-<ts>.bak`; while it is still locked, refuse to write at all.
   */
  function preserveUnreadFile() {
    if (!statSafe(file())) {
      unreadOnDisk = false;
      return;
    }
    const copy = copyAside(file(), `unread-${Date.now()}.bak`);
    if (!copy) {
      const err = new Error(`${spec.name} is still locked; not overwriting unread data`);
      /** @type {any} */ (err).code = 'EBUSY';
      throw err;
    }
    unreadOnDisk = false;
    reportStorageIssue({
      kind: 'unread-preserved',
      file: spec.name,
      repeat: true,
      message: `${capitalize(spec.label)}: файл, который не удалось прочитать при запуске, сохранён как ${path.basename(copy)} перед перезаписью. Его можно вернуть через импорт или вручную.`,
    });
  }

  function safeWrite(data) {
    try {
      write(data);
    } catch {
      /* reported by write(); the data is still returned to the caller */
    }
  }

  /** Coalesce bursts (e.g. several mutations in a row) into one write off the caller's path. */
  function writeSoon(data) {
    pending = data;
    if (!timer) {
      timer = setTimeout(flush, spec.debounceMs !== undefined ? spec.debounceMs : 400);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending === undefined) return;
    const data = pending;
    pending = undefined;
    safeWrite(data);
  }

  function cancelPending() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = undefined;
  }

  /** Delete the file and its last good copy; drops pending and session-only data. */
  function remove() {
    cancelPending();
    memory = undefined;
    let ok = true;
    for (const p of [file(), bakFile()]) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') ok = false;
      }
    }
    return ok;
  }

  /** Status for diagnostics; never decrypts. */
  function info() {
    const st = statSafe(file());
    let schemaVersion = null;
    let encrypted = false;
    if (st) {
      try {
        const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
        encrypted = Boolean(raw && raw.format === SECRET_ENVELOPE);
        schemaVersion = schemaVersionOf(raw);
      } catch {
        schemaVersion = null;
      }
    }
    return {
      name: spec.name,
      exists: Boolean(st),
      bytes: st ? st.size : 0,
      schemaVersion,
      currentVersion: spec.version,
      encrypted,
      encryptedByDesign: Boolean(spec.encrypt),
      memoryOnly: memory !== undefined,
      lastGood: Boolean(spec.lastGood),
      hasLastGood: Boolean(statSafe(bakFile())),
      pendingWrite: pending !== undefined,
    };
  }

  const doc = { spec, file, bakFile, read, write, writeSoon, flush, remove, info };
  registry.set(spec.name, doc);
  return doc;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Write every debounced document now (app quit). */
function flushAllDocs() {
  for (const doc of registry.values()) doc.flush();
}

function listDocs() {
  return [...registry.values()];
}

/**
 * Read every registered document once, so old files are migrated (and backed up) at startup
 * instead of whenever a feature first touches them. Call after the stores are loaded.
 */
function migrateAllDocs() {
  for (const doc of registry.values()) {
    try {
      doc.read();
    } catch (err) {
      console.warn(`[storage] ${doc.spec.name}:`, err && err.message ? err.message : err);
    }
  }
}

module.exports = {
  createJsonDoc,
  flushAllDocs,
  listDocs,
  migrateAllDocs,
  parseDocFile,
  readTextWithRetry,
};
