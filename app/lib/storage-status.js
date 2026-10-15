'use strict';

/**
 * In-memory log of things that happened to the user's data files this session:
 * a corrupt file moved aside, a restore from the last good copy, a migration, secrets kept
 * in memory only. Nothing here touches the disk, so it is safe to call from anywhere
 * (including failure paths). The main process forwards new events to the widget and
 * includes the whole list in the diagnostics report.
 *
 * Events never carry file contents, only file names and short Russian user-facing text.
 */

/**
 * @typedef {'info' | 'warn' | 'error'} StorageLevel
 * @typedef {{
 *   id: number,
 *   at: string,
 *   kind: string,
 *   level: StorageLevel,
 *   file: string,
 *   message: string,
 * }} StorageEvent
 */

const MAX_EVENTS = 100;

/** @type {StorageEvent[]} */
const events = [];
/** @type {Set<(event: StorageEvent) => void>} */
const listeners = new Set();
let nextId = 1;

/** kind -> [level, message template]. `{file}` is replaced by the file name. */
const KINDS = {
  'corrupt-quarantined': ['warn', 'Файл «{file}» оказался повреждён и перемещён в сторону (*.corrupt-…).'],
  'restored-from-backup': ['warn', 'Файл «{file}» был повреждён — восстановлена последняя хорошая копия.'],
  'corrupt-reset': ['error', 'Файл «{file}» повреждён, копии нет — данные сброшены. Повреждённый файл сохранён рядом (*.corrupt-…).'],
  migrated: ['info', 'Файл «{file}» обновлён до новой версии формата (копия сохранена в backups/migrations).'],
  'migration-failed': ['error', 'Не удалось обновить формат файла «{file}». Исходный файл сохранён, приложение работает с пустыми данными.'],
  'newer-schema': ['warn', 'Файл «{file}» создан более новой версией приложения. Копия сохранена в backups/migrations.'],
  'write-failed': ['error', 'Не удалось сохранить «{file}». Изменения могут быть потеряны — проверьте свободное место и права на папку данных.'],
  'secrets-memory-only': ['warn', 'Шифрование Windows (safeStorage) недоступно: ключи «{file}» хранятся только в памяти и не сохранятся после выхода.'],
  'plaintext-secrets': ['warn', 'Файл «{file}» лежит на диске открытым текстом (старая версия приложения). Он будет зашифрован, как только станет доступно шифрование.'],
  'backup-created': ['info', 'Создана резервная копия «{file}».'],
  'backup-failed': ['error', 'Не удалось создать резервную копию «{file}».'],
  imported: ['info', 'Данные импортированы из «{file}».'],
  wiped: ['warn', 'Все локальные данные удалены.'],
};

/**
 * @param {string} kind key of KINDS
 * @param {string} [file] file name (never a full path)
 * @param {{ level?: StorageLevel, message?: string }} [override]
 * @returns {StorageEvent}
 */
function recordStorageEvent(kind, file = '', override = {}) {
  const [level, template] = KINDS[kind] || ['info', kind];
  /** @type {StorageEvent} */
  const event = {
    id: nextId++,
    at: new Date().toISOString(),
    kind,
    level: override.level || /** @type {StorageLevel} */ (level),
    file,
    message: override.message || template.replace('{file}', file),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a broken listener must not break storage */
    }
  }
  return event;
}

/** @returns {StorageEvent[]} copy, oldest first */
function getStorageEvents() {
  return events.map((e) => ({ ...e }));
}

/**
 * @param {(event: StorageEvent) => void} fn
 * @returns {() => void} unsubscribe
 */
function onStorageEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test hook. */
function clearStorageEvents() {
  events.length = 0;
}

module.exports = { recordStorageEvent, getStorageEvents, onStorageEvent, clearStorageEvents };
