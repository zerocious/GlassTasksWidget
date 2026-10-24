'use strict';

const { app, dialog } = require('electron');

/** @type {boolean} */
let updateCheckInFlight = false;

/**
 * Auto-update via GitHub Releases (packaged builds only).
 * Unsigned NSIS (`signExecutable: false`) cannot verify publisher —
 * we skip code-signature check so updates still install; SmartScreen may warn.
 */
/**
 * @param {{ onBeforeQuitAndInstall?: () => void }} [opts]
 */
function setupAutoUpdater(opts = {}) {
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[updater] electron-updater missing', err && err.message ? err.message : err);
    return;
  }

  // Project ships unsigned installers — signature verify would always fail.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err && err.message ? err.message : err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const ver = (info && info.version) || '';
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Обновление готово',
        message: ver
          ? `Версия ${ver} скачана. Перезапустить сейчас?`
          : 'Обновление скачано. Перезапустить сейчас?',
        detail:
          'Можно продолжить работу — установка выполнится при следующем выходе из приложения.',
        buttons: ['Перезапустить', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((result) => {
        if (result.response === 0) {
          if (opts.onBeforeQuitAndInstall) opts.onBeforeQuitAndInstall();
          autoUpdater.quitAndInstall(false, true);
        }
      })
      .catch((err) =>
        console.warn('[updater] dialog', err && err.message ? err.message : err)
      );
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) =>
      console.warn('[updater] check', err && err.message ? err.message : err)
    );
  }, 12_000);
}

/**
 * Manual update check from Settings.
 * @returns {Promise<{
 *   ok: boolean,
 *   reason: string,
 *   message: string,
 *   version?: string,
 * }>}
 */
async function checkForAppUpdates() {
  if (!app.isPackaged) {
    return {
      ok: true,
      reason: 'dev',
      message: 'В режиме разработки обновления не проверяются (только сборка).',
    };
  }
  if (updateCheckInFlight) {
    return {
      ok: false,
      reason: 'busy',
      message: 'Проверка обновлений уже выполняется.',
    };
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return {
      ok: false,
      reason: 'missing',
      message: 'Модуль обновлений недоступен в этой сборке.',
    };
  }

  updateCheckInFlight = true;
  try {
    autoUpdater.verifyUpdateCodeSignature = false;
    const result = await autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    const remote = info && info.version;
    const current = app.getVersion();
    // Only electron-updater's verdict means a download has started. A published version that
    // merely differs — older than ours (a draft build installed for testing, a rolled-back
    // release) or outside a staged rollout — is not offered and nothing is downloaded.
    if (result && result.isUpdateAvailable && remote) {
      return {
        ok: true,
        reason: 'available',
        message: `Доступна версия ${remote}. Скачивание началось — предложим перезапуск.`,
        version: remote,
      };
    }
    return {
      ok: true,
      reason: 'uptodate',
      message: `У вас актуальная версия (${current}).`,
      version: current,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[updater] manual', msg);
    return {
      ok: false,
      reason: 'error',
      message:
        'Не удалось проверить обновления. Нужен релиз на GitHub (latest.yml) и доступ в интернет.',
    };
  } finally {
    updateCheckInFlight = false;
  }
}

module.exports = { setupAutoUpdater, checkForAppUpdates };
