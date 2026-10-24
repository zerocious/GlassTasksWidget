'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  globalShortcut,
  screen,
  Tray,
  Menu,
  nativeImage,
  Notification,
  dialog,
  clipboard,
  powerMonitor,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadConfig, getGoogleCredentialsStatus, saveGoogleCredentials } = require('../lib/config');
const {
  getWidgetData,
  loginGoogle,
  setTaskCompleted,
  createItem,
  updateItem,
  deleteItem,
  moveItem,
  invalidateListCache,
  invalidatePayloadCache,
  clearOfflineCache,
  resetCompletedHabitsForNewDay,
} = require('../lib/google-tasks');
const {
  revokeAndClearTokens,
  resetAuthClient,
  cancelLogin,
  reopenLoginInBrowser,
  getPendingLoginUrl,
  loadSavedTokens,
  clientChangeDropsGrant,
} = require('../lib/google-auth');
const { parseClientSecretJson, MAX_FILE_BYTES } = require('../lib/client-secret-file');
const { createLogger, captureConsole } = require('../lib/logger');
const { formatDiagnostics } = require('../lib/diagnostics');
const {
  loadSettings,
  saveSettings,
  getSizePreset,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
} = require('../lib/settings-store');
const { loginItem, loginItemRegistered, startupWritesLoginItem } = require('../lib/autostart-policy');
const { sampleWallpaperPalette } = require('../lib/wallpaper-palette');
const {
  APP_USER_MODEL_ID,
  configureNotifications,
  windowsToastsGloballyEnabled,
  ensureWindowsNotificationShortcut,
} = require('./notifications');
const {
  configureReminders,
  runReminderCheck,
  syncRemindersScheduler,
  stopRemindersScheduler,
  refreshExactReminders,
} = require('./reminders');
const { setupAutoUpdater, checkForAppUpdates } = require('./updater');
const { createWakeDetector } = require('./power');

function credentialsPayload() {
  const status = getGoogleCredentialsStatus();
  const settings = loadSettings();
  return {
    configured: status.configured,
    needsOnboarding: !status.configured && !settings.onboardingSkipped,
    clientId: status.clientId,
    redirectPort: status.redirectPort,
  };
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;

/** @type {{ toggle: string | null, switchView: string | null, switchFallback: boolean }} */
let hotkeyState = { toggle: null, switchView: null, switchFallback: false };
let moveSettleTimer = null;
let applyingBounds = false;
/** @type {boolean | null} */
let trayMenuVisible = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let habitsRolloverTimer = null;

// Windows toasts require a matching AppUserModelID before ready (and a Start Menu .lnk).
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Dev only: separate profile (tokens, settings, single-instance lock) from an installed widget.
if (!app.isPackaged && process.env.GT_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GT_USER_DATA_DIR));
}

// File log next to the profile: without it a user's «it doesn't work» can't be investigated.
// (console.* is mirrored, secrets are redacted; see lib/logger.js.)
const logger = createLogger({ dir: path.join(app.getPath('userData'), 'logs') });
captureConsole(logger);
console.log(`[app] start v${app.getVersion()} ${app.isPackaged ? 'packaged' : 'dev'} electron ${process.versions.electron}`);

// The main process must not die (or pop Electron's raw error box) on a stray exception:
// log it and keep the widget alive. Repeated crashes are visible in the log.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// Nothing in this app needs camera, microphone, geolocation, notifications from web content,
// or embedded webviews: deny every permission and block <webview> outright.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
app.whenReady().then(() => {
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
});
app.on('child-process-gone', (_event, details) => {
  console.error('[child-process-gone]', details.type, details.reason, details.exitCode);
});

// Minimal 16×16 accent PNG (glass-tasks red square with check hint)
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBgYGBgYQgP+MDAwMjIyMjP8ZGRkZ/jMwMDD8Z2Bg+M/AwPCfkZGR4T8DAwPDf0YGBoZRq2E0GhgYGBgYGBgYQAD+MzIwMDAyMjL+Z2RkZPjPwMDA8J+BgeE/IyMjw38GBgaG/4wMDAyjVjNoNDAwMAAAHw4JAfkYZqkAAAAASUVORK5CYII=';

/** Hosts the renderer may open in the system browser. */
const EXTERNAL_URL_HOSTS = new Set([
  'console.cloud.google.com',
  'developers.google.com',
  'myaccount.google.com',
  'github.com',
]);

function isAllowedExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_URL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function isFromWidget(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return event.sender === mainWindow.webContents;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** This copy's login item: own name for dev runs, the portable exe for portable builds. */
function currentLoginItem() {
  return loginItem({
    aumid: APP_USER_MODEL_ID,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appRoot: path.resolve(__dirname, '..'),
    portableExe: process.env.PORTABLE_EXECUTABLE_FILE,
    tmpDir: os.tmpdir(),
  });
}

/** The settings toggle (and «delete all my data»): write or remove this copy's login item. */
function applyAutostart(enabled) {
  const item = currentLoginItem();
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), name: item.name, ...item.options });
}

/**
 * At start: restore a missing entry while autostart is on, and touch nothing else
 * (see startupWritesLoginItem in lib/autostart-policy.js).
 */
function syncAutostartAtStartup(enabled) {
  const item = currentLoginItem();
  try {
    const registered = loginItemRegistered(item.name, app.getLoginItemSettings(item.options));
    if (startupWritesLoginItem({ wanted: Boolean(enabled), registered, exe: item.exe, tmpDir: os.tmpdir() })) {
      applyAutostart(true);
    }
  } catch (err) {
    console.warn('[autostart]', err && err.message ? err.message : err);
  }
}

function persistPosition() {
  if (!mainWindow || mainWindow.isDestroyed() || applyingBounds) return;
  const b = mainWindow.getBounds();
  saveSettings({ pos: { x: b.x, y: b.y } });
}

function scheduleMoveSettled() {
  if (moveSettleTimer) clearTimeout(moveSettleTimer);
  moveSettleTimer = setTimeout(() => {
    moveSettleTimer = null;
    if (applyingBounds) return;
    if (loadSettings().snapToEdge) snapToNearestEdge();
    else persistPosition();
  }, 320);
}

function snapToNearestEdge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const settings = loadSettings();
  if (!settings.snapToEdge) return;

  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const margin = 8;

  const maxX = wa.x + wa.width - bounds.width - margin;
  const minX = wa.x + margin;
  const minY = wa.y + margin;
  const maxY = wa.y + wa.height - bounds.height - margin;

  const distLeft = Math.abs(bounds.x - minX);
  const distRight = Math.abs(bounds.x - maxX);
  const distTop = Math.abs(bounds.y - minY);

  let x = bounds.x;
  let y = bounds.y;
  const nearest = Math.min(distLeft, distRight, distTop);
  if (nearest === distLeft) x = minX;
  else if (nearest === distRight) x = maxX;
  else y = minY;

  x = Math.round(clamp(x, minX, maxX));
  y = Math.round(clamp(y, minY, maxY));

  if (x !== bounds.x || y !== bounds.y) {
    applyingBounds = true;
    mainWindow.setPosition(x, y);
    applyingBounds = false;
  }
  saveSettings({ pos: { x, y } });
}

function applyWindowSize(size) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const preset = getSizePreset(size);
  const current = mainWindow.getBounds();
  applyingBounds = true;
  mainWindow.setMinimumSize(preset.minWidth, preset.minHeight);
  mainWindow.setSize(preset.width, preset.height, false);
  mainWindow.setPosition(current.x, current.y);
  applyingBounds = false;
  if (loadSettings().snapToEdge) snapToNearestEdge();
  else persistPosition();
}

function isWidgetVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function syncTrayMenu(force) {
  if (!tray) return;
  const visible = isWidgetVisible();
  if (!force && trayMenuVisible === visible) return;
  trayMenuVisible = visible;
  tray.setContextMenu(buildTrayMenu());
}

function showWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  syncTrayMenu();
}

function hideWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  persistPosition();
  mainWindow.hide();
  syncTrayMenu();
}

function sendToRenderer(channel) {
  showWidget();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const fire = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel);
  };
  if (wc.isLoadingMainFrame()) {
    wc.once('did-finish-load', fire);
  } else {
    fire();
  }
}

function toggleVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideWidget();
  else showWidget();
}

function notifySwitchView() {
  sendToRenderer('widget:switch-view');
}

function notifyFocusAdd() {
  sendToRenderer('widget:focus-add');
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyState = { toggle: null, switchView: null, switchFallback: false };
}

/** Accelerator shape only (e.g. "Control+Alt+W"); Electron still decides if it is registrable. */
function isValidAccelerator(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(value) && value.length <= 64;
}

/** globalShortcut.register throws on malformed accelerators — never let that abort startup. */
function safeRegisterShortcut(accel, handler) {
  try {
    return globalShortcut.register(accel, handler);
  } catch (err) {
    console.warn('Hotkey rejected:', accel, err && err.message ? err.message : err);
    return false;
  }
}

function registerHotkeys(settings) {
  unregisterHotkeys();

  const toggleAccel = settings.toggleHotkey || DEFAULT_TOGGLE_HOTKEY;
  const switchAccel = settings.switchViewHotkey || DEFAULT_SWITCH_HOTKEY;

  const toggleOk = safeRegisterShortcut(toggleAccel, () => toggleVisibility());
  hotkeyState.toggle = toggleOk ? toggleAccel : null;
  if (!toggleOk) console.warn('Hotkey not registered (toggle):', toggleAccel);

  let switchOk = safeRegisterShortcut(switchAccel, () => notifySwitchView());
  hotkeyState.switchView = switchOk ? switchAccel : null;
  hotkeyState.switchFallback = false;

  if (!switchOk) {
    const fallback = 'Control+Shift+Tab';
    switchOk = safeRegisterShortcut(fallback, () => notifySwitchView());
    if (switchOk) {
      hotkeyState.switchView = fallback;
      hotkeyState.switchFallback = true;
      console.warn(`${switchAccel} unavailable; using ${fallback}`);
    } else {
      console.warn('Hotkey not registered (switch view):', switchAccel);
    }
  }

  return {
    toggleHotkey: hotkeyState.toggle || toggleAccel,
    switchViewHotkey: hotkeyState.switchView || switchAccel,
    switchViewFallback: hotkeyState.switchFallback,
    toggleRegistered: Boolean(hotkeyState.toggle),
    switchRegistered: Boolean(hotkeyState.switchView),
  };
}

function settingsForRenderer() {
  const s = loadSettings();
  return {
    ...s,
    notificationsSupported: Notification.isSupported(),
    windowsToastsEnabled: windowsToastsGloballyEnabled(),
    hotkeys: {
      toggleHotkey: hotkeyState.toggle || s.toggleHotkey,
      switchViewHotkey: hotkeyState.switchView || s.switchViewHotkey,
      switchViewFallback: hotkeyState.switchFallback,
      toggleRegistered: Boolean(hotkeyState.toggle),
      switchRegistered: Boolean(hotkeyState.switchView),
    },
  };
}

function buildTrayMenu() {
  const visible = isWidgetVisible();
  return Menu.buildFromTemplate([
    {
      label: visible ? 'Скрыть виджет' : 'Показать виджет',
      click: () => toggleVisibility(),
    },
    {
      label: 'Tasks ↔ Habits',
      click: () => notifySwitchView(),
    },
    {
      label: 'Добавить…',
      click: () => notifyFocusAdd(),
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTrayIcon() {
  const fileIcon = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(fileIcon)) {
    const fromFile = nativeImage.createFromPath(fileIcon);
    if (!fromFile.isEmpty()) return fromFile.resize({ width: 16, height: 16 });
  }
  const fromData = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_PNG_BASE64}`);
  return fromData.isEmpty() ? nativeImage.createEmpty() : fromData;
}

function createTray() {
  if (tray) return;
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Glass Tasks Widget');
  syncTrayMenu(true);
  tray.on('click', () => {
    showWidget();
  });
  tray.on('right-click', () => {
    syncTrayMenu(true);
    if (tray) tray.popUpContextMenu();
  });
}

function clampPosToDisplays(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const wa = display.workArea;
  const margin = 8;
  const maxX = wa.x + wa.width - width - margin;
  const minX = wa.x + margin;
  const minY = wa.y + margin;
  const maxY = wa.y + wa.height - height - margin;
  return {
    x: Math.round(clamp(x, minX, Math.max(minX, maxX))),
    y: Math.round(clamp(y, minY, Math.max(minY, maxY))),
  };
}

const RENDERER_RESTARTS = [];
const MAX_RESTARTS_PER_MINUTE = 3;
const HANG_RELOAD_MS = 10 * 1000;

/**
 * Reload the widget page when its renderer crashes or hangs. State lives in the main process
 * and on disk, so a reload loses nothing. After repeated crashes stop and tell the user.
 * @param {BrowserWindow} win
 */
function watchRendererHealth(win) {
  const wc = win.webContents;
  /** @type {NodeJS.Timeout | null} */
  let hangTimer = null;

  const reloadAfterCrash = (reason) => {
    const now = Date.now();
    while (RENDERER_RESTARTS.length && now - RENDERER_RESTARTS[0] > 60 * 1000) RENDERER_RESTARTS.shift();
    RENDERER_RESTARTS.push(now);
    if (RENDERER_RESTARTS.length > MAX_RESTARTS_PER_MINUTE) {
      console.error('[renderer] too many restarts, giving up:', reason);
      dialog
        .showMessageBox({
          type: 'error',
          title: 'Glass Tasks Widget',
          message: 'Окно виджета постоянно падает.',
          detail: 'Подробности в журнале: Настройки → «Папка логов». Перезапустите приложение.',
          buttons: ['Открыть папку логов', 'Закрыть'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((r) => {
          if (r.response === 0) shell.openPath(logger.dir);
        })
        .catch(() => {});
      return;
    }
    setTimeout(() => {
      if (!win.isDestroyed()) wc.reload();
    }, 500);
  };

  wc.on('render-process-gone', (_e, details) => {
    console.error('[renderer] gone:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit' && !isQuitting) reloadAfterCrash(details.reason);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) console.error('[renderer] load failed:', code, desc);
  });
  wc.on('unresponsive', () => {
    console.warn('[renderer] unresponsive');
    if (hangTimer) clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (win.isDestroyed() || isQuitting) return;
      console.error('[renderer] still hung after 10 s, restarting it');
      wc.forcefullyCrashRenderer();
    }, HANG_RELOAD_MS);
  });
  wc.on('responsive', () => {
    if (hangTimer) {
      clearTimeout(hangTimer);
      hangTimer = null;
      console.log('[renderer] responsive again');
    }
  });
  win.on('closed', () => {
    if (hangTimer) clearTimeout(hangTimer);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return;

  const config = loadConfig();
  const winCfg = config.window || {};
  const settings = loadSettings();
  const preset = getSizePreset(settings.size);

  const opts = {
    width: preset.width,
    height: preset.height,
    minWidth: preset.minWidth,
    minHeight: preset.minHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: winCfg.alwaysOnTop !== false,
    skipTaskbar: winCfg.skipTaskbar !== false,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  if (settings.pos) {
    const safe = clampPosToDisplays(
      settings.pos.x,
      settings.pos.y,
      preset.width,
      preset.height
    );
    opts.x = safe.x;
    opts.y = safe.y;
  }

  mainWindow = new BrowserWindow(opts);
  const indexHtml = path.join(__dirname, '..', 'src', 'index.html');
  mainWindow.loadFile(indexHtml);

  // Harden: local widget only — block popups / unexpected navigations
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedPageUrl = pathToFileURL(indexHtml).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedPageUrl && !url.startsWith(`${allowedPageUrl}#`)) {
      event.preventDefault();
    }
  });

  watchRendererHealth(mainWindow);

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (settings.snapToEdge) snapToNearestEdge();
    mainWindow.show();
    syncTrayMenu();
  });

  mainWindow.on('moved', () => {
    if (applyingBounds) return;
    scheduleMoveSettled();
  });

  mainWindow.on('resized', () => {
    if (applyingBounds) return;
    scheduleMoveSettled();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideWidget();
      return;
    }
    // Quit path: save bounds before the window is destroyed
    persistPosition();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    trayMenuVisible = null;
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Visible in-widget toast (fallback / secondary cue).
 * @param {string} title
 * @param {string} body
 * @param {{ focus?: boolean }} [opts]
 */
function pushInAppReminder(title, body, opts = {}) {
  try {
    if (opts.focus !== false) showWidget();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('widget:in-app-reminder', {
      title: String(title || 'Напоминание'),
      body: String(body || ''),
    });
  } catch (err) {
    console.warn('[reminders] in-app', err && err.message ? err.message : err);
  }
}

function msUntilNextLocalMidnight() {
  const now = new Date();
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    8,
    0
  );
  return Math.max(1000, next.getTime() - now.getTime());
}

function stopHabitsDayRollover() {
  if (habitsRolloverTimer) {
    clearTimeout(habitsRolloverTimer);
    habitsRolloverTimer = null;
  }
}

/**
 * At local midnight (+ a few seconds): reset Google/mock habit completed flags.
 */
function scheduleHabitsDayRollover() {
  stopHabitsDayRollover();
  habitsRolloverTimer = setTimeout(() => {
    habitsRolloverTimer = null;
    resetCompletedHabitsForNewDay()
      .then((result) => {
        if (result && result.reset) {
          invalidatePayloadCache();
          refreshExactReminders();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('widget:habits-reset');
          }
        }
      })
      .catch((err) =>
        console.warn('[habits-reset]', err && err.message ? err.message : err)
      )
      .finally(() => scheduleHabitsDayRollover());
  }, msUntilNextLocalMidnight());
  if (typeof habitsRolloverTimer.unref === 'function') habitsRolloverTimer.unref();
}

const WAKE_SETTLE_MS = 5 * 1000;
const WAKE_TICK_MS = 60 * 1000;
/** @type {ReturnType<typeof setTimeout> | null} */
let wakeTimer = null;

/**
 * After sleep or a clock change the long setTimeout timers (exact reminders, midnight habit
 * reset) are measured against a clock that may not have advanced, so re-arm them from the real
 * time, apply a day change that happened meanwhile, and toast reminders that came due.
 * Waits a few seconds first: the network is usually not back yet when the system resumes.
 * @param {string} reason
 */
function handleSystemWake(reason) {
  console.log('[power] wake:', reason);
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    if (isQuitting) return;
    scheduleHabitsDayRollover();
    resetCompletedHabitsForNewDay()
      .then((result) => {
        if (result && result.reset) {
          invalidatePayloadCache();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('widget:habits-reset');
        }
      })
      .catch((err) => console.warn('[power] habits reset', err && err.message ? err.message : err))
      .finally(() => {
        refreshExactReminders();
        if (loadSettings().remindersEnabled !== false) {
          runReminderCheck().catch((err) => console.warn('[power] reminders', err && err.message ? err.message : err));
        }
      });
  }, WAKE_SETTLE_MS);
  if (typeof wakeTimer.unref === 'function') wakeTimer.unref();
}

function watchSystemWake() {
  const detector = createWakeDetector({ onWake: handleSystemWake });
  powerMonitor.on('resume', () => detector.notify('resume'));
  const heartbeat = setInterval(() => detector.tick(WAKE_TICK_MS), WAKE_TICK_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

function applySettingsPatch(patch) {
  const allowed = {};
  if (patch.theme === 'light' || patch.theme === 'dark') allowed.theme = patch.theme;
  if (patch.size === 'normal' || patch.size === 'compact') allowed.size = patch.size;
  if (typeof patch.autostart === 'boolean') allowed.autostart = patch.autostart;
  if (typeof patch.snapToEdge === 'boolean') allowed.snapToEdge = patch.snapToEdge;
  if (typeof patch.autoPalette === 'boolean') allowed.autoPalette = patch.autoPalette;
  if (patch.accentColor === null) allowed.accentColor = null;
  else if (typeof patch.accentColor === 'string') allowed.accentColor = patch.accentColor;
  if (typeof patch.bgOpacity === 'number' && Number.isFinite(patch.bgOpacity)) {
    allowed.bgOpacity = patch.bgOpacity;
  }
  if (typeof patch.remindersEnabled === 'boolean') {
    allowed.remindersEnabled = patch.remindersEnabled;
  }
  if (typeof patch.dailyHabitsReset === 'boolean') {
    allowed.dailyHabitsReset = patch.dailyHabitsReset;
  }
  if (typeof patch.hideCompleted === 'boolean') {
    allowed.hideCompleted = patch.hideCompleted;
  }
  if (typeof patch.simpleAnimations === 'boolean') {
    allowed.simpleAnimations = patch.simpleAnimations;
  }
  if (isValidAccelerator(patch.toggleHotkey)) allowed.toggleHotkey = patch.toggleHotkey;
  if (isValidAccelerator(patch.switchViewHotkey)) allowed.switchViewHotkey = patch.switchViewHotkey;
  if (typeof patch.onboardingSkipped === 'boolean') allowed.onboardingSkipped = patch.onboardingSkipped;
  if (patch.pos && typeof patch.pos.x === 'number' && typeof patch.pos.y === 'number') {
    allowed.pos = { x: patch.pos.x, y: patch.pos.y };
  }

  const prev = loadSettings();
  // Only clear the day stamp when the user turns the toggle back ON.
  if (
    allowed.dailyHabitsReset === true &&
    prev.dailyHabitsReset === false
  ) {
    allowed.lastHabitsResetDate = null;
  }
  const next = saveSettings(allowed);

  if (typeof allowed.autostart === 'boolean' && allowed.autostart !== prev.autostart) {
    applyAutostart(next.autostart);
  }
  if (allowed.size && allowed.size !== prev.size) {
    applyWindowSize(next.size);
  }
  if (typeof allowed.snapToEdge === 'boolean' && allowed.snapToEdge && !prev.snapToEdge) {
    snapToNearestEdge();
  }
  if (
    (allowed.toggleHotkey && allowed.toggleHotkey !== prev.toggleHotkey) ||
    (allowed.switchViewHotkey && allowed.switchViewHotkey !== prev.switchViewHotkey)
  ) {
    registerHotkeys(next);
  }
  if (
    typeof allowed.remindersEnabled === 'boolean' &&
    allowed.remindersEnabled !== prev.remindersEnabled
  ) {
    syncRemindersScheduler(next.remindersEnabled, { immediate: next.remindersEnabled });
  }
  if (
    typeof allowed.dailyHabitsReset === 'boolean' &&
    allowed.dailyHabitsReset !== prev.dailyHabitsReset &&
    next.dailyHabitsReset
  ) {
    resetCompletedHabitsForNewDay()
      .then((result) => {
        if (result && result.reset) refreshExactReminders();
      })
      .catch((err) =>
        console.warn('[habits-reset]', err && err.message ? err.message : err)
      );
  }

  return settingsForRenderer();
}

/**
 * Sample wallpaper and optionally persist accent when autoPalette is on.
 * @returns {{ accent: string, path?: string }}
 */
function sampleAndPersistPalette() {
  const result = sampleWallpaperPalette();
  const settings = loadSettings();
  if (settings.autoPalette) {
    saveSettings({ accentColor: result.accent });
  }
  return { accent: result.accent, path: result.path };
}

/**
 * Apply auto-palette accent onto widget data payload when enabled.
 * Uses persisted accent when present — avoids resampling wallpaper on every IPC.
 * @param {any} data
 * @returns {any}
 */
function applyAutoPaletteToData(data) {
  const settings = loadSettings();
  const config = loadConfig();
  const defaultAccent = config.accentColor || '#C4122E';
  if (!data || typeof data !== 'object') return data;
  const base = { ...data, defaultAccent };
  if (!settings.autoPalette) return base;
  if (settings.accentColor) {
    return { ...base, accentColor: settings.accentColor };
  }
  try {
    const { accent } = sampleAndPersistPalette();
    return { ...base, accentColor: accent };
  } catch (err) {
    console.warn('[palette]', err.message || err);
    return base;
  }
}

function registerIpc() {
  ipcMain.handle('widget:bootstrap', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const data = applyAutoPaletteToData(await getWidgetData());
    refreshExactReminders(data);
    return {
      settings: settingsForRenderer(),
      data,
      credentials: credentialsPayload(),
    };
  });

  ipcMain.handle('widget:get-data', async (event, opts) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const data = await getWidgetData(opts && typeof opts === 'object' ? opts : undefined);
    refreshExactReminders(data);
    return applyAutoPaletteToData(data);
  });

  ipcMain.handle('widget:credentials-status', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return credentialsPayload();
  });

  /**
   * Save OAuth client keys and reload. A different Client ID invalidates the saved
   * refresh token (it belongs to the old client), so the user signs in again — as does
   * a grant saved while no client is configured, whose client is unknown.
   */
  async function storeCredentials({ clientId, clientSecret, redirectPort }) {
    const existing = getGoogleCredentialsStatus();
    const clientChanged = clientChangeDropsGrant(existing.clientId, clientId);
    // Validation happens inside save (it throws), so nothing is cleared for rejected input.
    saveGoogleCredentials({ clientId, clientSecret, redirectPort });
    if (clientChanged) {
      // Same cleanup as «Выйти»: revoke the old grant (best effort), forget the previous
      // account's tasks so they can't reappear as «offline» data for the next sign-in.
      await revokeAndClearTokens();
      clearOfflineCache();
    } else {
      resetAuthClient();
    }
    saveSettings({ onboardingSkipped: false });
    invalidateListCache();
    invalidatePayloadCache();
    const data = applyAutoPaletteToData(await getWidgetData({ force: true }));
    return {
      credentials: credentialsPayload(),
      settings: settingsForRenderer(),
      data,
    };
  }

  ipcMain.handle('widget:save-credentials', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    if (!payload || typeof payload !== 'object') throw new Error('Invalid credentials');
    const clientId = String(payload.clientId || '').trim();
    // An empty secret with the current Client ID keeps the saved one (lib/config.js).
    const clientSecret = String(payload.clientSecret || '').trim();
    return storeCredentials({ clientId, clientSecret, redirectPort: payload.redirectPort });
  });

  // client_secret.json: dropped / pasted text, or picked via a file dialog when no text is given.
  ipcMain.handle('widget:import-client-json', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    let text = payload && typeof payload.text === 'string' ? payload.text : null;
    if (text === null) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Файл client_secret.json из Google Cloud',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const file = picked.filePaths[0];
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        throw new Error('Это не похоже на client_secret.json: файл слишком большой.');
      }
      text = fs.readFileSync(file, 'utf8');
    }
    const { clientId, clientSecret } = parseClientSecretJson(text);
    return storeCredentials({ clientId, clientSecret, redirectPort: null });
  });

  ipcMain.handle('widget:skip-credentials', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    saveSettings({ onboardingSkipped: true });
    const data = applyAutoPaletteToData(await getWidgetData({ force: true }));
    return {
      credentials: credentialsPayload(),
      settings: settingsForRenderer(),
      data,
    };
  });

  ipcMain.handle('widget:sample-wallpaper-palette', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return sampleAndPersistPalette();
  });

  // Resolves with {ok:false, code} instead of throwing so the renderer keeps the error code
  // (Electron flattens thrown errors to a prefixed message string).
  ipcMain.handle('widget:login', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const creds = getGoogleCredentialsStatus();
    if (!creds.configured) {
      return { ok: false, code: 'no_credentials', message: 'Сначала загрузите client_secret.json или введите ключи Google.' };
    }
    try {
      const data = applyAutoPaletteToData(
        await loginGoogle({
          onSignedIn: () => {
            if (!event.sender.isDestroyed()) event.sender.send('widget:login-phase', 'loading');
          },
        })
      );
      refreshExactReminders(data);
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || null,
        message: err && err.message ? err.message : String(err),
        actionUrl: (err && err.actionUrl) || null,
        actionLabel: (err && err.actionLabel) || null,
      };
    }
  });

  ipcMain.handle('widget:login-reopen', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return reopenLoginInBrowser();
  });

  ipcMain.handle('widget:login-copy', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const url = getPendingLoginUrl();
    if (!url) return false;
    clipboard.writeText(url);
    return true;
  });

  ipcMain.handle('widget:login-cancel', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return cancelLogin();
  });

  ipcMain.handle('widget:logout', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    await revokeAndClearTokens();
    invalidateListCache();
    invalidatePayloadCache();
    clearOfflineCache();
    return applyAutoPaletteToData(await getWidgetData({ force: true }));
  });

  ipcMain.handle('widget:set-completed', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId, completed } = payload || {};
    const result = await setTaskCompleted(listKind, taskId, Boolean(completed));
    refreshExactReminders();
    return result;
  });

  ipcMain.handle('widget:create-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, title, parentId, parse } = payload || {};
    const result = await createItem(listKind, title, {
      ...(parentId ? { parentId } : {}),
      parse: parse === true,
    });
    refreshExactReminders();
    return result;
  });

  ipcMain.handle('widget:update-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId, patch, title, notes } = payload || {};
    const update =
      patch !== undefined
        ? patch
        : typeof notes === 'string' || typeof title === 'string'
          ? {
              ...(typeof title === 'string' ? { title } : {}),
              ...(typeof notes === 'string' ? { notes } : {}),
            }
          : title;
    const result = await updateItem(listKind, taskId, update);
    refreshExactReminders();
    return result;
  });

  ipcMain.handle('widget:delete-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId } = payload || {};
    const result = await deleteItem(listKind, taskId);
    refreshExactReminders();
    return result;
  });

  ipcMain.handle('widget:move-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId, previousId, orderedIds } = payload || {};
    return moveItem(listKind, taskId, previousId || null, orderedIds || []);
  });

  ipcMain.handle('widget:get-settings', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return settingsForRenderer();
  });

  ipcMain.handle('widget:set-settings', async (event, patch) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings');
    return applySettingsPatch(patch);
  });

  ipcMain.handle('widget:check-reminders', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    ensureWindowsNotificationShortcut({ force: true });
    return runReminderCheck({ force: true });
  });

  ipcMain.handle('widget:check-updates', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return checkForAppUpdates();
  });

  ipcMain.on('widget:minimize', (event) => {
    if (!isFromWidget(event)) return;
    hideWidget();
  });

  ipcMain.on('widget:close', (event) => {
    if (!isFromWidget(event)) return;
    hideWidget();
  });

  ipcMain.handle('widget:diagnostics-copy', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const status = getGoogleCredentialsStatus();
    const report = formatDiagnostics(
      {
        app: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged },
        versions: process.versions,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        auth: {
          credentialsConfigured: status.configured,
          signedIn: Boolean(loadSavedTokens() && loadSavedTokens().refresh_token),
          clientId: status.clientId,
          pinnedPort: status.redirectPort,
        },
        settings: loadSettings(),
        hotkeys: settingsForRenderer().hotkeys,
        dataDir: path.join(app.getPath('userData'), 'data'),
      },
      logger.tail(200)
    );
    clipboard.writeText(report);
    return { ok: true, lines: report.split('\n').length };
  });

  ipcMain.handle('widget:open-logs', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    fs.mkdirSync(logger.dir, { recursive: true });
    const err = await shell.openPath(logger.dir);
    return { ok: !err, error: err || null };
  });

  // Renderer errors (window.onerror / unhandled rejections); capped so a loop can't flood the disk.
  let rendererLogWindowStart = 0;
  let rendererLogCount = 0;
  ipcMain.on('widget:log', (event, payload) => {
    if (!isFromWidget(event) || !payload || typeof payload !== 'object') return;
    const now = Date.now();
    if (now - rendererLogWindowStart > 60 * 1000) {
      rendererLogWindowStart = now;
      rendererLogCount = 0;
    }
    if (++rendererLogCount > 30) return;
    const clip = (v) => String(v == null ? '' : v).slice(0, 600);
    console.error('[renderer-error]', clip(payload.message), clip(payload.source), clip(payload.stack));
  });

  ipcMain.on('widget:open-external', (event, url) => {
    if (!isFromWidget(event)) return;
    if (!isAllowedExternalUrl(url)) {
      console.warn('[open-external] blocked:', typeof url === 'string' ? url.slice(0, 200) : url);
      return;
    }
    shell.openExternal(url).catch((err) =>
      console.warn('[open-external]', err && err.message ? err.message : err)
    );
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWidget();
    syncTrayMenu();
  });

  configureNotifications({
    getTray: () => tray,
    pushInApp: pushInAppReminder,
    onClick: () => {
      if (isQuitting) return;
      showWidget();
      syncTrayMenu();
    },
  });
  configureReminders({ isQuitting: () => isQuitting });

  app.whenReady().then(() => {
    ensureWindowsNotificationShortcut();
    const settings = loadSettings();
    syncAutostartAtStartup(settings.autostart);
    registerIpc();
    require('./data-ipc').registerDataIpc({ getWindow: () => mainWindow, applySettingsPatch });
    createWindow();
    createTray();
    registerHotkeys(settings);
    syncRemindersScheduler(settings.remindersEnabled !== false);
    scheduleHabitsDayRollover();
    watchSystemWake();
    setupAutoUpdater({ onBeforeQuitAndInstall: () => { isQuitting = true; } });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWidget();
    });
  }).catch((err) => {
    console.error('[startup]', err);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopRemindersScheduler();
    stopHabitsDayRollover();
  });

  app.on('will-quit', () => {
    unregisterHotkeys();
    stopRemindersScheduler();
    stopHabitsDayRollover();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on('window-all-closed', () => {
    // Keep running in tray on Windows/Linux
    if (process.platform === 'darwin' && !tray) app.quit();
  });
}
