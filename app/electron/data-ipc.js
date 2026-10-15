'use strict';

/**
 * IPC for the user's stored data: status report, backups, export / import, delete-all.
 * Registered with one call from main.js (registerDataIpc). All file dialogs and
 * confirmations are shown from the main process, so the renderer cannot skip them.
 *
 * Channels (all `ipcMain.handle`, only accepted from the widget window). Expected failures
 * resolve with `{ ok: false, error: '<Russian message>' }`; nothing throws except an
 * unauthorized sender.
 *
 *   data:status          -> storage report (see lib/storage-report.js)
 *   data:backups-list    -> [{ name, kind, date, size }]            newest first
 *   data:backup-now      -> { ok, name, size }
 *   data:export-json     ({ includeLogs? }) -> { ok, canceled?, path?, size? }
 *   data:export-csv      -> { ok, canceled?, path?, rows? }
 *   data:import          -> { ok, canceled?, result?, restarting? }
 *   data:restore-backup  ({ name }) -> { ok, canceled?, result?, restarting? }
 *   data:delete-all      -> { ok, canceled?, restarting? }
 *
 * Event pushed to the widget window:
 *   data:event           (storage event: { id, at, kind, level, file, message })
 */

const fs = require('fs');
const path = require('path');
const { getDataRoot } = require('../lib/config');
const { removeStaleTempFiles } = require('../lib/storage-core');
const { onStorageEvent } = require('../lib/storage-status');
const { getStorageReport } = require('../lib/storage-report');
const { flushOfflineCache } = require('../lib/offline-cache');
const backup = require('../lib/storage-backup');
const { wipeAllData } = require('../lib/storage-wipe');

const WEEKLY_CHECK_DELAY_MS = 5000;
const WEEKLY_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

function isoDay(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * @typedef {{
 *   app: any,
 *   dialog: any,
 *   ipcMain?: any,
 *   session?: any,
 *   isFromWidget: (event: any) => boolean,
 *   getMainWindow: () => any,
 *   getWidgetData?: () => Promise<any>,
 *   relaunch?: () => void,
 *   now?: () => Date,
 * }} DataIpcDeps
 */

/**
 * The handlers, separated from ipcMain so they can be tested with fakes.
 * @param {DataIpcDeps} deps
 * @returns {Record<string, (event: any, payload?: any) => Promise<any>>}
 */
function createDataHandlers(deps) {
  const { app, dialog, isFromWidget, getMainWindow } = deps;
  const now = deps.now || (() => new Date());
  const relaunch =
    deps.relaunch ||
    (() => {
      app.relaunch();
      app.exit(0);
    });
  const getWidgetData = deps.getWidgetData || (() => require('../lib/google-tasks').getWidgetData());
  const parent = () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : undefined;
  };
  const appVersion = () => {
    try {
      return app.getVersion();
    } catch {
      return undefined;
    }
  };

  // One data operation at a time: a double click must not run two imports or wipes.
  let busy = false;
  const guarded = (fn) => async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    if (busy) return { ok: false, error: 'Другая операция с данными ещё выполняется.' };
    busy = true;
    try {
      return await fn(payload || {});
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    } finally {
      busy = false;
    }
  };

  const saveDialog = (title, defaultName, extension, name) =>
    dialog.showSaveDialog(parent(), {
      title,
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name, extensions: [extension] }],
    });

  /** Pick a file, validate it and (after confirmation) merge it. */
  async function importText(text, sourceName) {
    const parsed = backup.parseBundle(text);
    const s = parsed.summary;
    const lines = [
      s.exportedAt ? `Файл создан: ${s.exportedAt.slice(0, 10)}${s.appVersion ? ` (версия ${s.appVersion})` : ''}` : null,
      s.habits ? `Привычек с историей: ${s.habits}, отметок: ${s.dates}` : null,
      s.demoTasks || s.demoHabits ? `Демо-списки: задач ${s.demoTasks}, привычек ${s.demoHabits}` : null,
      s.hasSettings ? 'Настройки внешнего вида и напоминаний' : null,
      '',
      'Данные будут ОБЪЕДИНЕНЫ с текущими: отметки привычек добавятся, ничего не удалится.',
      'Перед импортом создаётся резервная копия.',
      s.hasSettings ? 'Для применения настроек виджет перезапустится.' : null,
    ].filter((l) => l !== null);
    const answer = await dialog.showMessageBox(parent(), {
      type: 'question',
      title: 'Импорт данных',
      message: `Импортировать данные из «${sourceName}»?`,
      detail: lines.join('\n'),
      buttons: ['Импортировать', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return { ok: true, canceled: true };
    const result = backup.applyBundle(parsed, { appVersion: appVersion(), sourceName });
    const restarting = result.settingsApplied;
    if (restarting) setTimeout(relaunch, 300);
    return { ok: true, result, restarting };
  }

  return {
    'data:status': async (event) => {
      if (!isFromWidget(event)) throw new Error('Unauthorized');
      return getStorageReport();
    },

    'data:backups-list': async (event) => {
      if (!isFromWidget(event)) throw new Error('Unauthorized');
      return backup.listBackups();
    },

    'data:backup-now': guarded(async () => {
      const { name, size } = backup.createBackup({ kind: 'manual', now: now(), appVersion: appVersion() });
      return { ok: true, name, size };
    }),

    'data:export-json': guarded(async (payload) => {
      const picked = await saveDialog(
        'Экспорт данных',
        `glass-tasks-export-${isoDay(now())}.json`,
        'json',
        'JSON'
      );
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      const logsDir = payload.includeLogs === true ? path.join(app.getPath('userData'), 'logs') : null;
      const text = backup.serializeBundle(
        backup.buildBundle({ kind: 'export', now: now(), appVersion: appVersion(), logsDir })
      );
      fs.writeFileSync(picked.filePath, text, 'utf8');
      return { ok: true, path: picked.filePath, size: Buffer.byteLength(text, 'utf8') };
    }),

    'data:export-csv': guarded(async () => {
      const picked = await saveDialog('Экспорт задач в CSV', `glass-tasks-${isoDay(now())}.csv`, 'csv', 'CSV');
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      const data = await getWidgetData();
      const csv = backup.tasksToCsv(data);
      fs.writeFileSync(picked.filePath, csv, 'utf8');
      const rows = (data.tasks || []).length + (data.habits || []).length;
      return { ok: true, path: picked.filePath, rows };
    }),

    'data:import': guarded(async () => {
      const picked = await dialog.showOpenDialog(parent(), {
        title: 'Импорт данных',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
      const file = picked.filePaths[0];
      if (fs.statSync(file).size > backup.MAX_IMPORT_BYTES) throw new Error('Файл слишком большой для импорта.');
      return importText(fs.readFileSync(file, 'utf8'), path.basename(file));
    }),

    'data:restore-backup': guarded(async (payload) => {
      const name = typeof payload.name === 'string' ? payload.name : '';
      return importText(backup.readBackupText(name), name);
    }),

    'data:delete-all': guarded(async () => {
      const answer = await dialog.showMessageBox(parent(), {
        type: 'warning',
        title: 'Удалить все мои данные',
        message: 'Удалить все данные виджета с этого компьютера?',
        detail: [
          'Будет удалено безвозвратно:',
          '• вход в Google (доступ отзывается у Google) и ключи Client ID / Secret;',
          '• история привычек и стрики, настройки, напоминания, офлайн-кэш;',
          '• резервные копии в папке данных и демо-списки;',
          '• данные окна виджета (кэш Chromium).',
          '',
          'Задачи в вашем аккаунте Google не затрагиваются. Экспортированные вами файлы остаются. Виджет перезапустится.',
        ].join('\n'),
        buttons: ['Удалить всё', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) return { ok: true, canceled: true };
      const result = await wipeAllData({ session: deps.session || null });
      try {
        // The login item lives in the registry, outside the data folder.
        app.setLoginItemSettings({ openAtLogin: false });
      } catch {
        /* not supported on this platform */
      }
      setTimeout(relaunch, 300);
      return { ok: result.ok, restarting: true, failed: result.failed };
    }),
  };
}

/**
 * Register the channels and the storage housekeeping that belongs to this module:
 * pending cache write on quit, stale temp files, weekly backup, `data:event` push.
 * @param {Partial<DataIpcDeps>} deps  only `isFromWidget` and `getMainWindow` are required
 */
function registerDataIpc(deps) {
  let electron = {};
  try {
    electron = require('electron');
  } catch {
    /* plain node (tests): everything must come from deps */
  }
  const full = /** @type {DataIpcDeps} */ ({
    app: electron.app,
    dialog: electron.dialog,
    ipcMain: electron.ipcMain,
    session: electron.session && electron.app ? electron.session.defaultSession : null,
    ...deps,
  });

  for (const [channel, handler] of Object.entries(createDataHandlers(full))) {
    full.ipcMain.handle(channel, handler);
  }

  // Storage events (corrupt file restored, secrets memory-only, ...) go to the widget.
  onStorageEvent((event) => {
    const win = full.getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('data:event', event);
    }
  });

  // The offline cache is written debounced: flush it before the process goes away.
  full.app.on('before-quit', flushOfflineCache);
  full.app.on('will-quit', flushOfflineCache);

  try {
    removeStaleTempFiles(getDataRoot());
  } catch (err) {
    console.warn('[data] temp cleanup failed:', errorMessage(err));
  }

  const weekly = () => {
    try {
      backup.ensureWeeklyBackup({ appVersion: full.app.getVersion() });
    } catch (err) {
      console.warn('[data] weekly backup check failed:', errorMessage(err));
    }
  };
  const first = setTimeout(weekly, WEEKLY_CHECK_DELAY_MS);
  const timer = setInterval(weekly, WEEKLY_CHECK_INTERVAL_MS);
  first.unref();
  timer.unref();
  full.app.on('will-quit', () => {
    clearTimeout(first);
    clearInterval(timer);
  });
}

module.exports = { registerDataIpc, createDataHandlers };
