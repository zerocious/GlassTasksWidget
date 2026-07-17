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
} = require('electron');
const fs = require('fs');
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
  invalidateListCache,
  invalidatePayloadCache,
  clearOfflineCache,
} = require('../lib/google-tasks');
const { clearTokens } = require('../lib/google-auth');
const {
  loadSettings,
  saveSettings,
  getSizePreset,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
} = require('../lib/settings-store');
const { sampleWallpaperPalette } = require('../lib/wallpaper-palette');
const { loadReminderState, markNotified } = require('../lib/reminder-store');

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

/** @type {ReturnType<typeof setInterval> | null} */
let reminderInterval = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reminderStartupTimer = null;
let reminderCheckInFlight = false;

const REMINDER_INTERVAL_MS = 45 * 60 * 1000;
const REMINDER_STARTUP_DELAY_MS = 40 * 1000;

// Minimal 16×16 accent PNG (glass-tasks red square with check hint)
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBgYGBgYQgP+MDAwMjIyMjP8ZGRkZ/jMwMDD8Z2Bg+M/AwPCfkZGR4T8DAwPDf0YGBoZRq2E0GhgYGBgYGBgYQAD+MzIwMDAyMjL+Z2RkZPjPwMDA8J+BgeE/IyMjw38GBgaG/4wMDAyjVjNoNDAwMAAAHw4JAfkYZqkAAAAASUVORK5CYII=';

function isFromWidget(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return event.sender === mainWindow.webContents;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function applyAutostart(enabled) {
  const openAtLogin = Boolean(enabled);
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin });
  } else {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      args: [path.resolve(__dirname, '..')],
    });
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

function registerHotkeys(settings) {
  unregisterHotkeys();

  const toggleAccel = settings.toggleHotkey || DEFAULT_TOGGLE_HOTKEY;
  const switchAccel = settings.switchViewHotkey || DEFAULT_SWITCH_HOTKEY;

  const toggleOk = globalShortcut.register(toggleAccel, () => toggleVisibility());
  hotkeyState.toggle = toggleOk ? toggleAccel : null;
  if (!toggleOk) console.warn('Hotkey not registered (toggle):', toggleAccel);

  let switchOk = globalShortcut.register(switchAccel, () => notifySwitchView());
  hotkeyState.switchView = switchOk ? switchAccel : null;
  hotkeyState.switchFallback = false;

  if (!switchOk) {
    const fallback = 'Control+Shift+Tab';
    switchOk = globalShortcut.register(fallback, () => notifySwitchView());
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
      backgroundThrottling: true,
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
 * Collect actionable open items for toast reminders.
 * @param {any} data
 * @returns {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string }[]}
 */
function collectReminderCandidates(data) {
  /** @type {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string }[]} */
  const out = [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  for (const t of tasks) {
    if (!t || t.completed || !t.id) continue;
    if (t.dueKind !== 'today' && t.dueKind !== 'overdue') continue;
    out.push({
      id: `task:${t.id}`,
      kind: 'task',
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueKind: t.dueKind,
    });
  }
  const habits = Array.isArray(data?.habits) ? data.habits : [];
  for (const h of habits) {
    if (!h || h.completed || !h.id) continue;
    out.push({
      id: `habit:${h.id}`,
      kind: 'habit',
      title: String(h.title || 'Привычка').trim() || 'Привычка',
    });
  }
  return out;
}

/**
 * Build Russian title/body for a reminder toast.
 * @param {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string }[]} items
 */
function formatReminderToast(items) {
  const overdue = items.filter((i) => i.dueKind === 'overdue');
  const today = items.filter((i) => i.dueKind === 'today');
  const habits = items.filter((i) => i.kind === 'habit');
  const parts = [];
  if (overdue.length) parts.push(`просрочено: ${overdue.length}`);
  if (today.length) parts.push(`на сегодня: ${today.length}`);
  if (habits.length) parts.push(`привычки: ${habits.length}`);

  const title =
    overdue.length && !today.length && !habits.length
      ? 'Просроченные задачи'
      : habits.length && !overdue.length && !today.length
        ? 'Привычки на сегодня'
        : 'Напоминание Glass Tasks';

  const names = items
    .slice(0, 3)
    .map((i) => i.title)
    .join(', ');
  const more = items.length > 3 ? ` и ещё ${items.length - 3}` : '';
  const body = parts.length
    ? `${parts.join(' · ')}. ${names}${more}`
    : `${names}${more}`;

  return { title, body };
}

function stopRemindersScheduler() {
  if (reminderStartupTimer) {
    clearTimeout(reminderStartupTimer);
    reminderStartupTimer = null;
  }
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

async function runReminderCheck() {
  if (reminderCheckInFlight || isQuitting) return;
  const settings = loadSettings();
  if (!settings.remindersEnabled) return;
  if (!Notification.isSupported()) return;

  reminderCheckInFlight = true;
  try {
    const data = await getWidgetData();
    const candidates = collectReminderCandidates(data);
    const state = loadReminderState();
    const notified = new Set(state.notifiedIds);
    const fresh = candidates.filter((c) => !notified.has(c.id));
    if (!fresh.length) return;

    const { title, body } = formatReminderToast(fresh);
    const n = new Notification({
      title,
      body,
      silent: false,
    });
    n.on('click', () => {
      showWidget();
      syncTrayMenu();
    });
    n.show();
    markNotified(fresh.map((c) => c.id));
  } catch (err) {
    console.warn('[reminders]', err && err.message ? err.message : err);
  } finally {
    reminderCheckInFlight = false;
  }
}

/**
 * @param {boolean} enabled
 * @param {{ immediate?: boolean }} [opts]
 */
function syncRemindersScheduler(enabled, opts = {}) {
  stopRemindersScheduler();
  if (!enabled) return;

  const delay = opts.immediate ? 2500 : REMINDER_STARTUP_DELAY_MS;
  reminderStartupTimer = setTimeout(() => {
    reminderStartupTimer = null;
    runReminderCheck();
  }, delay);

  reminderInterval = setInterval(() => {
    runReminderCheck();
  }, REMINDER_INTERVAL_MS);
  if (typeof reminderInterval.unref === 'function') reminderInterval.unref();
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
  if (typeof patch.toggleHotkey === 'string') allowed.toggleHotkey = patch.toggleHotkey;
  if (typeof patch.switchViewHotkey === 'string') allowed.switchViewHotkey = patch.switchViewHotkey;
  if (typeof patch.onboardingSkipped === 'boolean') allowed.onboardingSkipped = patch.onboardingSkipped;
  if (patch.pos && typeof patch.pos.x === 'number' && typeof patch.pos.y === 'number') {
    allowed.pos = { x: patch.pos.x, y: patch.pos.y };
  }

  const prev = loadSettings();
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
    return {
      settings: settingsForRenderer(),
      data,
      credentials: credentialsPayload(),
    };
  });

  ipcMain.handle('widget:get-data', async (event, opts) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const data = await getWidgetData(opts && typeof opts === 'object' ? opts : undefined);
    return applyAutoPaletteToData(data);
  });

  ipcMain.handle('widget:credentials-status', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return credentialsPayload();
  });

  ipcMain.handle('widget:save-credentials', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    if (!payload || typeof payload !== 'object') throw new Error('Invalid credentials');
    const existing = getGoogleCredentialsStatus();
    const clientId = String(payload.clientId || '').trim();
    let clientSecret = String(payload.clientSecret || '').trim();
    if (!clientSecret && existing.configured && process.env.GOOGLE_CLIENT_SECRET) {
      clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    }
    saveGoogleCredentials({
      clientId,
      clientSecret,
      redirectPort: payload.redirectPort,
    });
    saveSettings({ onboardingSkipped: false });
    invalidateListCache();
    invalidatePayloadCache();
    const data = applyAutoPaletteToData(await getWidgetData({ force: true }));
    return {
      credentials: credentialsPayload(),
      settings: settingsForRenderer(),
      data,
    };
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

  ipcMain.handle('widget:login', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const creds = getGoogleCredentialsStatus();
    if (!creds.configured) {
      throw new Error('Сначала сохраните Google Client ID и Secret');
    }
    return loginGoogle();
  });

  ipcMain.handle('widget:logout', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    clearTokens();
    invalidateListCache();
    invalidatePayloadCache();
    clearOfflineCache();
    return applyAutoPaletteToData(await getWidgetData({ force: true }));
  });

  ipcMain.handle('widget:set-completed', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId, completed } = payload || {};
    return setTaskCompleted(listKind, taskId, Boolean(completed));
  });

  ipcMain.handle('widget:create-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, title } = payload || {};
    return createItem(listKind, title);
  });

  ipcMain.handle('widget:update-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId, title } = payload || {};
    return updateItem(listKind, taskId, title);
  });

  ipcMain.handle('widget:delete-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, taskId } = payload || {};
    return deleteItem(listKind, taskId);
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

  ipcMain.on('widget:minimize', (event) => {
    if (!isFromWidget(event)) return;
    hideWidget();
  });

  ipcMain.on('widget:close', (event) => {
    if (!isFromWidget(event)) return;
    hideWidget();
  });

  ipcMain.on('widget:open-external', (event, url) => {
    if (!isFromWidget(event)) return;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
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

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.glasstasks.widget');
    }
    const settings = loadSettings();
    applyAutostart(settings.autostart);
    registerIpc();
    createWindow();
    createTray();
    registerHotkeys(settings);
    syncRemindersScheduler(settings.remindersEnabled !== false);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWidget();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopRemindersScheduler();
  });

  app.on('will-quit', () => {
    unregisterHotkeys();
    stopRemindersScheduler();
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
