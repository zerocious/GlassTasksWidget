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
const { pathToFileURL } = require('url');
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

const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** The only page allowed to use these channels. */
const WIDGET_PAGE = path.join(__dirname, '..', 'src', 'index.html');
const WIDGET_PAGE_URL = pathToFileURL(WIDGET_PAGE).href;

function errorResult(err) {
  return { ok: false, message: err && err.message ? err.message : String(err) };
}

/**
 * The call must come from the widget window's main frame while it shows the widget page:
 * not from a subframe, another webContents, or a page the window navigated to.
 * @param {{ sender: unknown, senderFrame?: { url: string } | null }} event
 * @param {{ webContents: { mainFrame: { url: string } } } | null} win
 * @param {boolean} [isWindows]
 */
function isTrustedSender(event, win, isWindows = process.platform === 'win32') {
  if (!win || event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== win.webContents.mainFrame) return false;
  return samePageUrl(String(frame.url).split('#')[0], WIDGET_PAGE_URL, isWindows);
}

/**
 * Decode valid %XX runs as UTF-8 and leave anything else as is. Chromium keeps «~ [ ] %»
 * unescaped in file URLs where pathToFileURL escapes them (8.3 names like ADMINI~1,
 * «Programs [x64]»), so both sides are brought to the same form before comparing.
 * @param {string} url
 */
function decodeLoose(url) {
  return url.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}

/**
 * @param {string} a
 * @param {string} b
 * @param {boolean} [isWindows] Windows paths are case-insensitive (drive letter, folders)
 */
function samePageUrl(a, b, isWindows = process.platform === 'win32') {
  const x = decodeLoose(a);
  const y = decodeLoose(b);
  return isWindows ? x.toLowerCase() === y.toLowerCase() : x === y;
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
  // Required here, not at the top: tests load this file without the Electron binary.
  const { app, ipcMain, dialog, shell, session } = require('electron');

  // storage-status loaded every store: bring all files to the current schema now.
  migrateAllDocs();

  const win = () => {
    const w = deps.getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  /** @param {string} channel @param {(payload: any) => any} fn */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event, win())) throw new Error('Unauthorized');
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

  handle('data:export-json', async (payload) => {
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
      includeLogs: Boolean(payload && payload.includeLogs === true),
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
    const text = await backup.readFileCapped(picked.filePaths[0], backup.MAX_IMPORT_BYTES);
    const report = backup.importData(text, {
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
        'резервные копии и хранилище браузера виджета. Задачи в самом Google Tasks не пострадают. ' +
        'Журнал работы (папка logs) не удаляется.\n\n' +
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
    if (result.revoke === 'failed' || result.revoke === 'locked') {
      // The local copy is gone, but Google may still honour the grant (offline, timeout,
      // DPAPI locked): tell the user before the restart, where the renderer cannot.
      const { response: open } = await dialog.showMessageBox(win(), {
        type: 'warning',
        title: 'Доступ Google не отозван',
        message: 'Данные удалены, но отозвать доступ виджета в Google не удалось.',
        detail:
          'Скорее всего, нет сети. Откройте страницу «Сторонние приложения с доступом к аккаунту» ' +
          'и удалите там доступ Glass Tasks вручную, иначе сохранённая где-то копия входа продолжит работать.',
        buttons: ['Открыть страницу Google', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (open === 0) {
        shell.openExternal(GOOGLE_PERMISSIONS_URL).catch(() => {});
      }
    }
    // Restart from a clean state; writes stay frozen until then.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
    return {
      ok: result.failed.length === 0,
      relaunching: true,
      revoke: result.revoke,
      kept: result.kept,
      failed: result.failed,
    };
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

module.exports = { registerDataIpc, isTrustedSender, samePageUrl, WIDGET_PAGE, WIDGET_PAGE_URL };
