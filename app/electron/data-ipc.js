'use strict';

/**
 * IPC for the user's data: storage status, export / import, backups, «delete all my data».
 * Registered from main.js with registerDataIpc(deps). Every channel answers only the widget
 * window; file dialogs and the delete confirmation are shown here, in the main process,
 * so a compromised renderer cannot pick paths or skip the confirmation.
 *
 * Results never throw for expected failures: `{ ok: false, message }` (Electron would
 * flatten a thrown error into a prefixed string), `{ canceled: true }` for a closed dialog.
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, shell, session } = require('electron');
const { getDataRoot } = require('../lib/config');
const { flushAllDocs, migrateAllDocs } = require('../lib/storage-doc');
const { onStorageIssue } = require('../lib/storage-events');
const { getStorageStatus, describeStorageStatus } = require('../lib/storage-status');
const backup = require('../lib/storage-backup');
const { wipeAllData } = require('../lib/storage-wipe');
const { resetStreakCache } = require('../lib/streak-store');
const { getWidgetData, invalidateListCache, invalidatePayloadCache } = require('../lib/google-tasks');
const { revokeAndClearTokens } = require('../lib/google-auth');
const { todayIso } = require('../lib/dates');

const FIRST_BACKUP_DELAY_MS = 60 * 1000;
const BACKUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function errorResult(err) {
  return { ok: false, message: err && err.message ? err.message : String(err) };
}

/**
 * @param {{
 *   getWindow: () => import('electron').BrowserWindow | null,
 *   applySettingsPatch?: (patch: Record<string, unknown>) => unknown,
 * }} deps
 *   applySettingsPatch: main.js's validator + side effects (autostart, hotkeys, size) used for
 *   imported settings and to switch autostart off before a wipe.
 */
function registerDataIpc(deps) {
  // storage-status loaded every store: bring all files to the current schema now.
  migrateAllDocs();

  const win = () => {
    const w = deps.getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  /** @param {string} channel @param {(payload: any) => any} fn */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      const w = win();
      if (!w || event.sender !== w.webContents) throw new Error('Unauthorized');
      try {
        return await fn(payload);
      } catch (err) {
        return errorResult(err);
      }
    });

  /** What the widget currently shows (live, offline cache or demo). */
  async function currentData() {
    try {
      return await getWidgetData();
    } catch {
      return null;
    }
  }

  handle('data:storage-status', () => {
    const status = getStorageStatus();
    return { ...status, lines: describeStorageStatus(status) };
  });

  handle('data:export-json', async () => {
    const picked = await dialog.showSaveDialog(win(), {
      title: 'Экспорт данных Glass Tasks',
      defaultPath: path.join(app.getPath('documents'), `glass-tasks-export-${todayIso()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    const data = await currentData();
    /** @type {Record<string, string>} */
    const habitTitles = {};
    for (const h of (data && data.habits) || []) if (h && h.id && h.title) habitTitles[h.id] = h.title;
    const result = backup.exportJson(picked.filePath, {
      habitTitles,
      logsDir: path.join(app.getPath('userData'), 'logs'),
    });
    return { ok: true, ...result };
  });

  handle('data:export-tasks-csv', async () => {
    const picked = await dialog.showSaveDialog(win(), {
      title: 'Задачи в CSV',
      defaultPath: path.join(app.getPath('documents'), `glass-tasks-${todayIso()}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    const data = await currentData();
    return { ok: true, ...backup.exportTasksCsv(picked.filePath, data || {}) };
  });

  handle('data:import-json', async () => {
    const dir = backup.backupsDir();
    const picked = await dialog.showOpenDialog(win(), {
      title: 'Импорт экспорта или резервной копии Glass Tasks',
      defaultPath: fs.existsSync(dir) ? dir : app.getPath('documents'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const file = picked.filePaths[0];
    if (fs.statSync(file).size > backup.MAX_IMPORT_BYTES) {
      return { ok: false, message: 'Файл слишком большой для экспорта Glass Tasks.' };
    }
    const report = backup.importData(fs.readFileSync(file, 'utf8'), {
      applySettings: deps.applySettingsPatch,
    });
    resetStreakCache();
    invalidatePayloadCache();
    return { ok: true, report };
  });

  handle('data:backup-now', () => {
    const created = backup.createBackup({ reason: 'manual', force: true });
    return { ok: true, backup: created && { name: created.name, bytes: created.bytes } };
  });

  handle('data:list-backups', () =>
    backup.listBackups().map((b) => ({ name: b.name, reason: b.reason, createdAt: b.createdAt, bytes: b.bytes }))
  );

  handle('data:open-folder', async () => {
    const error = await shell.openPath(getDataRoot());
    return error ? { ok: false, message: error } : { ok: true };
  });

  handle('data:wipe-all', async () => {
    const { response } = await dialog.showMessageBox(win(), {
      type: 'warning',
      title: 'Удалить все мои данные',
      message: 'Удалить все данные Glass Tasks на этом компьютере?',
      detail:
        'Будут удалены вход Google и ключи, кэш задач, история привычек, настройки, напоминания, ' +
        'резервные копии и хранилище браузера виджета. Задачи в самом Google Tasks не пострадают.\n\n' +
        'Отменить это нельзя. Если история привычек нужна, сначала сделайте экспорт.\n\n' +
        'После удаления виджет перезапустится.',
      buttons: ['Отмена', 'Удалить всё'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { canceled: true };
    if (deps.applySettingsPatch) {
      try {
        deps.applySettingsPatch({ autostart: false });
      } catch (err) {
        console.warn('[wipe] autostart:', err && err.message ? err.message : err);
      }
    }
    const result = await wipeAllData({
      revoke: revokeAndClearTokens,
      session: session.defaultSession,
      resets: [invalidateListCache, invalidatePayloadCache],
    });
    // Restart from a clean state; writes stay frozen until then.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
    return { ok: result.failed.length === 0, relaunching: true, failed: result.failed };
  });

  // Warnings (restored backup, reset file, secrets in memory only…) go to the widget as they
  // happen; ones from before the window loaded are in data:storage-status → issues.
  onStorageIssue((issue) => {
    if (issue.level === 'info') return;
    const w = win();
    if (w && !w.webContents.isLoadingMainFrame()) w.webContents.send('data:storage-issue', issue);
  });

  const runBackup = () => {
    try {
      backup.runScheduledBackup();
    } catch (err) {
      console.warn('[backup]', err && err.message ? err.message : err);
    }
  };
  const first = setTimeout(runBackup, FIRST_BACKUP_DELAY_MS);
  if (typeof first.unref === 'function') first.unref();
  const every = setInterval(runBackup, BACKUP_CHECK_INTERVAL_MS);
  if (typeof every.unref === 'function') every.unref();

  // Debounced writes (offline cache) must reach the disk before the process exits.
  app.on('before-quit', flushAllDocs);
  app.on('will-quit', flushAllDocs);
}

module.exports = { registerDataIpc };
