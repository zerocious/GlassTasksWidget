'use strict';

const { app, dialog, powerMonitor } = require('electron');

/** @type {boolean} */
let updateCheckInFlight = false;

/** First automatic check, once the widget (and usually the network) has settled after launch. */
const STARTUP_CHECK_DELAY_MS = 12_000;
/** A tray widget runs for weeks without a restart: look for new releases again this often. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A failed check (autostart at login before Wi-Fi/VPN is up) is retried after 1, 2, 4 … min. */
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
/** After sleep: check shortly (the network needs a moment) unless one succeeded recently. */
const WAKE_CHECK_DELAY_MS = 30 * 1000;
const WAKE_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * When the automatic update checks run: after launch, then periodically; a failure is retried
 * with backoff; waking from sleep brings the next check forward. One timer at a time, unref'd.
 * @param {() => Promise<unknown>} check rejects when the check (or its download) failed
 */
function createUpdateScheduler(check) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let failures = 0;
  let lastSuccess = -Infinity;
  let running = false;
  let stopped = false;

  function arm(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function run() {
    timer = null;
    // A check still running re-arms itself when it settles.
    if (stopped || running) return;
    running = true;
    try {
      await check();
      failures = 0;
      lastSuccess = Date.now();
      arm(RECHECK_INTERVAL_MS);
    } catch (err) {
      failures += 1;
      arm(Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS));
      console.warn('[updater] check', err && err.message ? err.message : err);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      arm(STARTUP_CHECK_DELAY_MS);
    },
    /** The computer woke up (a laptop that sleeps instead of shutting down keeps this process). */
    wake() {
      if (stopped || Date.now() - lastSuccess < WAKE_MIN_GAP_MS) return;
      arm(WAKE_CHECK_DELAY_MS);
    },
    /** An update is downloaded and installs on quit; a later check would only ask to restart again. */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

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

  const scheduler = createUpdateScheduler(async () => {
    const result = await autoUpdater.checkForUpdates();
    // Wait for the download too, so a broken download is retried like a failed check.
    if (result && result.downloadPromise) await result.downloadPromise;
  });

  autoUpdater.on('update-downloaded', (info) => {
    scheduler.stop();
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

  powerMonitor.on('resume', () => scheduler.wake());
  scheduler.start();
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
