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
} = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const {
  getWidgetData,
  loginGoogle,
  setTaskCompleted,
  createItem,
  invalidateListCache,
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

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;

/** @type {{ toggle: string | null, switchView: string | null, switchFallback: boolean }} */
let hotkeyState = { toggle: null, switchView: null, switchFallback: false };
let moveSettleTimer = null;
let applyingBounds = false;

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
  }, 180);
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

function showWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function hideWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  persistPosition();
  mainWindow.hide();
  if (tray) tray.setContextMenu(buildTrayMenu());
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
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
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
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (tray) tray.setContextMenu(buildTrayMenu());
    showWidget();
  });
  tray.on('right-click', () => {
    if (tray) tray.popUpContextMenu(buildTrayMenu());
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
    hasShadow: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  if (settings.pos) {
    opts.x = settings.pos.x;
    opts.y = settings.pos.y;
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (settings.snapToEdge) snapToNearestEdge();
    mainWindow.show();
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
    }
  });

  mainWindow.on('closed', () => {
    persistPosition();
    mainWindow = null;
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function applySettingsPatch(patch) {
  const allowed = {};
  if (patch.theme === 'light' || patch.theme === 'dark') allowed.theme = patch.theme;
  if (patch.size === 'normal' || patch.size === 'compact') allowed.size = patch.size;
  if (typeof patch.autostart === 'boolean') allowed.autostart = patch.autostart;
  if (typeof patch.snapToEdge === 'boolean') allowed.snapToEdge = patch.snapToEdge;
  if (typeof patch.toggleHotkey === 'string') allowed.toggleHotkey = patch.toggleHotkey;
  if (typeof patch.switchViewHotkey === 'string') allowed.switchViewHotkey = patch.switchViewHotkey;
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

  return settingsForRenderer();
}

function registerIpc() {
  ipcMain.handle('widget:get-data', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return getWidgetData();
  });

  ipcMain.handle('widget:login', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    return loginGoogle();
  });

  ipcMain.handle('widget:logout', async (event) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    clearTokens();
    invalidateListCache();
    clearOfflineCache();
    return getWidgetData();
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
    if (tray) tray.setContextMenu(buildTrayMenu());
  });

  app.whenReady().then(() => {
    const settings = loadSettings();
    applyAutostart(settings.autostart);
    registerIpc();
    createWindow();
    createTray();
    registerHotkeys(settings);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWidget();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    unregisterHotkeys();
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
