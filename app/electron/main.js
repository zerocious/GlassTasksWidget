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
} = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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
  resolveTaskDueAt,
  resetCompletedHabitsForNewDay,
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
const {
  loadReminderState,
  markNotified,
  wasNotifiedToday,
  clearNotifiedToday,
} = require('../lib/reminder-store');
const {
  normalizeSitesList,
  normalizeTime,
  normalizeMode,
  applyWorkHoursState,
  startWorkHoursScheduler,
  stopWorkHoursScheduler,
  cleanupWorkHoursOnQuit,
  getWorkHoursStatus,
} = require('../lib/work-hours-blocker');

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
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const exactReminderTimers = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let habitsRolloverTimer = null;
/** @type {boolean} */
let updateCheckInFlight = false;

const APP_USER_MODEL_ID = 'com.glasstasks.widget';
const REMINDER_INTERVAL_MS = 45 * 60 * 1000;
/** First check soon after launch so toasts are easy to verify; then every 45 min. */
const REMINDER_STARTUP_DELAY_MS = 8 * 1000;
/** Only schedule one-shot timers for due times within this horizon. */
const EXACT_REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;

// Windows toasts require a matching AppUserModelID before ready (and a Start Menu .lnk).
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

/**
 * HKCU PushNotifications\ToastEnabled — master switch in
 * Settings → System → Notifications. 0 blocks all Electron toasts.
 * @returns {boolean}
 */
function windowsToastsGloballyEnabled() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications" /v ToastEnabled',
      { encoding: 'utf8', windowsHide: true }
    );
    const m = out.match(/ToastEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
    if (!m) return true;
    return parseInt(m[1], 16) !== 0;
  } catch {
    return true;
  }
}

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
    workHoursSitesJson: JSON.stringify(s.workHoursSites || []),
    workHoursStatus: getWorkHoursStatus(),
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
 * Ensure Start Menu + Desktop shortcuts carry AppUserModelID matching
 * app.setAppUserModelId — required for Windows Action Center toasts.
 * Always rewrite both so pack scripts / stale .lnk files cannot strip AUMID.
 */
function ensureWindowsNotificationShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const startMenuDir = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    );
    fs.mkdirSync(startMenuDir, { recursive: true });

    const appRoot = path.resolve(__dirname, '..');
    const target = process.execPath;
    const cwd = app.isPackaged ? path.dirname(process.execPath) : appRoot;
    const args = app.isPackaged ? '' : `"${appRoot}"`;

    /** @type {Electron.ShortcutDetails} */
    const details = {
      target,
      cwd,
      args,
      appUserModelId: APP_USER_MODEL_ID,
      description: 'Glass Tasks Widget',
      icon: process.execPath,
      iconIndex: 0,
    };

    const startMenuLnk = path.join(startMenuDir, 'Glass Tasks Widget.lnk');
    const desktopLnk = path.join(app.getPath('desktop'), 'Glass Tasks Widget.lnk');
    for (const lnk of [startMenuLnk, desktopLnk]) {
      const op = fs.existsSync(lnk) ? 'update' : 'create';
      const ok = shell.writeShortcutLink(lnk, op, details);
      if (!ok) console.warn('[reminders] shortcut write failed', lnk);
    }
  } catch (err) {
    console.warn('[reminders] shortcut', err && err.message ? err.message : err);
  }
}

/**
 * Collect actionable open items for the periodic sweep toast.
 * Timed tasks still in the future are skipped (exact timers handle them).
 * Timed tasks whose time already passed (today / overdue / notes+today) stay as safety net.
 * @param {any} data
 * @returns {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]}
 */
function collectReminderCandidates(data) {
  /** @type {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]} */
  const out = [];
  const now = Date.now();
  const today = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  for (const t of tasks) {
    if (!t || t.completed || !t.id) continue;
    const dueAt = resolveTaskDueAt(t);
    if (dueAt) {
      if (dueAt.getTime() > now) continue; // exact timer pending
      // Past timed: only if due calendar day is today or earlier (notes-only → today).
      const y = dueAt.getFullYear();
      const m = String(dueAt.getMonth() + 1).padStart(2, '0');
      const day = String(dueAt.getDate()).padStart(2, '0');
      const dueDay = `${y}-${m}-${day}`;
      if (dueDay > today) continue;
      out.push({
        id: `task:${t.id}`,
        kind: 'task',
        title: String(t.title || 'Задача').trim() || 'Задача',
        dueKind: 'overdue',
        dueTime: t.dueTime || null,
      });
      continue;
    }
    if (t.dueKind !== 'today' && t.dueKind !== 'overdue') continue;
    out.push({
      id: `task:${t.id}`,
      kind: 'task',
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueKind: t.dueKind,
      dueTime: t.dueTime || null,
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
 * @param {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]} items
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
    .map((i) => {
      const time = i.dueTime ? ` (${i.dueTime})` : '';
      return `${i.title}${time}`;
    })
    .join(', ');
  const more = items.length > 3 ? ` и ещё ${items.length - 3}` : '';
  const body = parts.length
    ? `${parts.join(' · ')}. ${names}${more}`
    : `${names}${more}`;

  return { title, body };
}

function clearExactReminderTimers() {
  for (const timer of exactReminderTimers.values()) {
    clearTimeout(timer);
  }
  exactReminderTimers.clear();
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
  clearExactReminderTimers();
}

/**
 * Fire a one-shot exact-time toast for a single task.
 * Re-checks the task is still open so completed/deleted items stay silent.
 * @param {{ id: string, title: string, dueTime?: string | null }} task
 */
async function fireExactTaskReminder(task) {
  const reminderId = `task:${task.id}`;
  if (isQuitting || !loadSettings().remindersEnabled) return;
  if (wasNotifiedToday(reminderId)) return;
  if (!Notification.isSupported()) return;

  try {
    const data = await getWidgetData();
    if (isQuitting || !loadSettings().remindersEnabled) return;
    const live = (Array.isArray(data?.tasks) ? data.tasks : []).find(
      (t) => t && t.id === task.id
    );
    if (!live || live.completed) return;
  } catch (err) {
    console.warn('[reminders] exact recheck', err && err.message ? err.message : err);
    // Fall through and notify — better a late toast than a missed one if fetch fails.
  }

  const time = task.dueTime || '';
  const title = 'Пора';
  const body = time
    ? `Пора: ${task.title} (${time})`
    : `Пора: ${task.title}`;
  await showReminderToast(title, body, [reminderId]);
}

/**
 * Schedule one-shot timers for open tasks with a resolvable due datetime
 * within the next 24 hours. Cancels previous schedule.
 * @param {any} data
 */
function scheduleExactReminders(data) {
  clearExactReminderTimers();
  if (isQuitting || !loadSettings().remindersEnabled) return;
  if (!Notification.isSupported()) return;

  const now = Date.now();
  const horizon = now + EXACT_REMINDER_HORIZON_MS;
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const state = loadReminderState();
  const notified = new Set(state.notifiedIds);

  /** @type {{ id: string, title: string, dueTime: string | null, dueAt: Date }[]} */
  const upcoming = [];
  for (const t of tasks) {
    if (!t || t.completed || !t.id) continue;
    const dueAt = resolveTaskDueAt(t);
    if (!dueAt) continue;
    const ts = dueAt.getTime();
    if (ts <= now || ts > horizon) continue;
    const reminderId = `task:${t.id}`;
    if (notified.has(reminderId)) continue;
    upcoming.push({
      id: t.id,
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueTime:
        t.dueTime ||
        `${String(dueAt.getHours()).padStart(2, '0')}:${String(dueAt.getMinutes()).padStart(2, '0')}`,
      dueAt,
    });
  }

  upcoming.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  for (const item of upcoming) {
    const delay = Math.max(0, item.dueAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      exactReminderTimers.delete(item.id);
      fireExactTaskReminder(item).catch((err) =>
        console.warn('[reminders] exact', err && err.message ? err.message : err)
      );
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    exactReminderTimers.set(item.id, timer);
  }
}

/**
 * Refresh exact timers from current widget data (best-effort, non-blocking).
 * @param {any} [data]
 */
function refreshExactReminders(data) {
  if (!loadSettings().remindersEnabled || isQuitting) {
    clearExactReminderTimers();
    return;
  }
  if (data) {
    scheduleExactReminders(data);
    return;
  }
  getWidgetData()
    .then((d) => scheduleExactReminders(d))
    .catch((err) =>
      console.warn('[reminders] reschedule', err && err.message ? err.message : err)
    );
}

function reminderToastIconPath() {
  const fileIcon = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(fileIcon)) return fileIcon;
  return undefined;
}

function reminderToastIcon() {
  const fileIcon = reminderToastIconPath();
  if (fileIcon) {
    try {
      const img = nativeImage.createFromPath(fileIcon);
      if (!img.isEmpty()) return img.resize({ width: 64, height: 64 });
    } catch {
      /* fall through */
    }
  }
  try {
    const fromExe = nativeImage.createFromPath(process.execPath);
    if (!fromExe.isEmpty()) return fromExe.resize({ width: 64, height: 64 });
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Native WinRT toast via PowerShell — fallback when Electron Notification fails.
 * Uses the same AppUserModelID so the toast lands under "Glass Tasks Widget"
 * in Action Center (requires Start Menu .lnk with matching AUMID).
 * @param {string} title
 * @param {string} body
 * @returns {boolean}
 */
function showNativeWinRtToast(title, body) {
  if (process.platform !== 'win32') return false;
  try {
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, "''");
    const safeTitle = esc(title).slice(0, 120);
    const safeBody = esc(body).slice(0, 240);
    const iconPath = reminderToastIconPath();
    const iconXml = iconPath
      ? `<image placement="appLogoOverride" src="${esc(pathToFileURL(iconPath).href)}" />`
      : '';
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric">${iconXml}<text>${safeTitle}</text><text>${safeBody}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = 'glass-tasks-reminder'
$toast.Group = 'glass-tasks'
$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_USER_MODEL_ID}')
$n.Show($toast)
`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      windowsHide: true,
      timeout: 8000,
    });
    return true;
  } catch (err) {
    console.warn('[reminders] winrt', err && err.message ? err.message : err);
    return false;
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

/**
 * Tray balloon last-resort backup (not Action Center).
 * @param {string} title
 * @param {string} body
 */
function showTrayBalloon(title, body) {
  if (!tray || tray.isDestroyed()) return false;
  try {
    const icon = reminderToastIcon();
    tray.displayBalloon({
      title: String(title || 'Glass Tasks').slice(0, 63),
      content: String(body || '').slice(0, 255),
      icon,
      iconType: icon ? 'custom' : 'info',
    });
    return true;
  } catch (err) {
    console.warn('[reminders] balloon', err && err.message ? err.message : err);
    return false;
  }
}

/**
 * Try Electron Notification (lands in Windows Action Center when AUMID + shortcut match).
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{ shown: boolean, error?: string }>}
 */
function tryElectronNotification(title, body) {
  return new Promise((resolve) => {
    if (!Notification.isSupported()) {
      resolve({ shown: false, error: 'unsupported' });
      return;
    }

    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let fallback = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (fallback) {
        clearTimeout(fallback);
        fallback = null;
      }
      resolve(result);
    };

    try {
      /** @type {Electron.NotificationConstructorOptions} */
      const nOpts = {
        title,
        body,
        silent: false,
        timeoutType: 'default',
      };
      // Prefer file path — Windows uses shortcut icon when AUMID is registered;
      // NativeImage icon can make some builds show the raw AUMID string.
      const iconPath = reminderToastIconPath();
      if (iconPath) nOpts.icon = iconPath;

      const n = new Notification(nOpts);
      n.on('click', () => {
        if (isQuitting) return;
        showWidget();
        syncTrayMenu();
      });
      n.on('show', () => finish({ shown: true }));
      n.on('failed', (_e, error) => {
        const msg = error ? String(error) : 'failed';
        console.warn('[reminders] electron toast failed', msg);
        finish({ shown: false, error: msg });
      });
      // Windows sometimes omits 'show'; treat no failure as success.
      fallback = setTimeout(() => finish({ shown: true }), 1200);
      if (typeof fallback.unref === 'function') fallback.unref();
      n.show();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[reminders] electron toast', msg);
      finish({ shown: false, error: msg });
    }
  });
}

/**
 * Primary: Electron Notification → Windows Action Center.
 * Fallback: WinRT PowerShell toast with same AppId.
 * Secondary: quiet in-app card (always for force check; otherwise only if OS toast failed).
 * Last resort: tray balloon if nothing OS-level worked.
 * @param {string} title
 * @param {string} body
 * @param {string[]} ids
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ shown: boolean, error?: string, channel?: string, balloon?: boolean, winrt?: boolean, electron?: boolean }>}
 */
async function showReminderToast(title, body, ids, opts = {}) {
  ensureWindowsNotificationShortcut();

  const electron = await tryElectronNotification(title, body);
  let winrt = false;
  let balloon = false;
  let channel = 'none';
  let shown = Boolean(electron.shown);

  if (shown) {
    channel = 'electron';
  } else {
    winrt = showNativeWinRtToast(title, body);
    if (winrt) {
      shown = true;
      channel = 'winrt';
    }
  }

  // In-app: secondary cue — don't steal focus when OS toast already showed.
  if (!shown || opts.force) {
    pushInAppReminder(title, body, { focus: !shown });
  }

  if (!shown) {
    balloon = showTrayBalloon(title, body);
    if (balloon) {
      shown = true;
      channel = 'balloon';
    }
  }

  if (shown && ids.length) markNotified(ids);

  return {
    shown,
    channel,
    electron: Boolean(electron.shown),
    winrt,
    balloon,
    error: electron.error,
  };
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   shown: boolean,
 *   count: number,
 *   reason?: string,
 *   message?: string,
 *   notificationsSupported: boolean,
 * }>}
 */
async function runReminderCheck(opts = {}) {
  const notificationsSupported = Notification.isSupported();
  const empty = {
    ok: false,
    shown: false,
    count: 0,
    notificationsSupported,
  };

  if (reminderCheckInFlight || isQuitting) {
    return { ...empty, reason: 'busy', message: 'Проверка уже выполняется.' };
  }
  const settings = loadSettings();
  if (!settings.remindersEnabled) {
    return {
      ...empty,
      reason: 'disabled',
      message: 'Напоминания выключены в настройках.',
    };
  }
  if (!notificationsSupported) {
    return {
      ...empty,
      reason: 'unsupported',
      message:
        'Система не поддерживает уведомления. Проверьте Параметры Windows → Система → Уведомления.',
    };
  }
  if (!windowsToastsGloballyEnabled()) {
    return {
      ...empty,
      reason: 'os-disabled',
      message:
        'Уведомления Windows выключены глобально (ToastEnabled=0). Включите: Параметры → Система → Уведомления.',
    };
  }

  reminderCheckInFlight = true;
  try {
    const data = await getWidgetData();
    // Re-check after await: user may have quit or disabled reminders mid-fetch.
    if (isQuitting || !loadSettings().remindersEnabled) {
      return {
        ...empty,
        reason: 'disabled',
        message: 'Напоминания выключены.',
      };
    }

    // Manual «Проверить» must always be allowed to re-fire toasts the same day.
    if (opts.force) clearNotifiedToday();

    const candidates = collectReminderCandidates(data);
    scheduleExactReminders(data);
    const state = loadReminderState();
    const notified = new Set(state.notifiedIds);
    const fresh = opts.force
      ? candidates
      : candidates.filter((c) => !notified.has(c.id));
    if (!fresh.length) {
      return {
        ok: true,
        shown: false,
        count: 0,
        reason: candidates.length ? 'already' : 'empty',
        message: candidates.length
          ? 'На сегодня уже отправляли. Нажмите «Проверить» — покажем снова (тост Windows + Action Center).'
          : 'Нет открытых задач на сегодня/просроченных и незакрытых привычек.',
        notificationsSupported,
      };
    }

    const { title, body } = formatReminderToast(fresh);
    const result = await showReminderToast(
      title,
      body,
      fresh.map((c) => c.id),
      { force: Boolean(opts.force) }
    );

    if (!result.shown) {
      return {
        ok: false,
        shown: false,
        count: fresh.length,
        reason: 'failed',
        message:
          'Системный тост не удалось показать. Параметры → Система → Уведомления: включите баннеры и «Glass Tasks Widget». Отключите Фокусировку внимания.',
        notificationsSupported,
      };
    }

    const via =
      result.channel === 'electron'
        ? 'Windows (Electron)'
        : result.channel === 'winrt'
          ? 'Windows (WinRT)'
          : result.channel === 'balloon'
            ? 'подсказка у трея'
            : 'уведомление';
    return {
      ok: true,
      shown: true,
      count: fresh.length,
      channel: result.channel,
      balloon: Boolean(result.balloon),
      winrt: Boolean(result.winrt),
      electron: Boolean(result.electron),
      message: `Отправлено: ${fresh.length} через ${via}. Смотрите баннер Windows / Центр уведомлений.`,
      notificationsSupported,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[reminders]', msg);
    return {
      ...empty,
      reason: 'error',
      message: msg,
    };
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
    runReminderCheck().catch((err) =>
      console.warn('[reminders]', err && err.message ? err.message : err)
    );
  }, delay);
  if (typeof reminderStartupTimer.unref === 'function') reminderStartupTimer.unref();

  reminderInterval = setInterval(() => {
    runReminderCheck().catch((err) =>
      console.warn('[reminders]', err && err.message ? err.message : err)
    );
  }, REMINDER_INTERVAL_MS);
  if (typeof reminderInterval.unref === 'function') reminderInterval.unref();
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

/**
 * Auto-update via GitHub Releases (packaged builds only).
 * Unsigned NSIS (`signAndEditExecutable: false`) cannot verify publisher —
 * we skip code-signature check so updates still install; SmartScreen may warn.
 */
function setupAutoUpdater() {
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
          isQuitting = true;
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
    if (remote && remote !== current) {
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
  if (typeof patch.toggleHotkey === 'string') allowed.toggleHotkey = patch.toggleHotkey;
  if (typeof patch.switchViewHotkey === 'string') allowed.switchViewHotkey = patch.switchViewHotkey;
  if (typeof patch.onboardingSkipped === 'boolean') allowed.onboardingSkipped = patch.onboardingSkipped;
  if (typeof patch.workHoursEnabled === 'boolean') allowed.workHoursEnabled = patch.workHoursEnabled;
  if (typeof patch.workHoursStart === 'string') {
    allowed.workHoursStart = normalizeTime(patch.workHoursStart, '09:00');
  }
  if (typeof patch.workHoursEnd === 'string') {
    allowed.workHoursEnd = normalizeTime(patch.workHoursEnd, '18:00');
  }
  if (patch.workHoursMode === 'instant' || patch.workHoursMode === 'warn') {
    allowed.workHoursMode = normalizeMode(patch.workHoursMode);
  }
  if (Array.isArray(patch.workHoursSites)) {
    allowed.workHoursSites = normalizeSitesList(patch.workHoursSites).sites;
  } else if (typeof patch.workHoursSitesJson === 'string') {
    const parsed = normalizeSitesList(patch.workHoursSitesJson);
    if (parsed.error) {
      const err = new Error(parsed.error);
      err.code = 'WORK_HOURS_SITES_JSON';
      throw err;
    }
    allowed.workHoursSites = parsed.sites;
  }
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

  const workHoursChanged =
    typeof allowed.workHoursEnabled === 'boolean' ||
    typeof allowed.workHoursStart === 'string' ||
    typeof allowed.workHoursEnd === 'string' ||
    typeof allowed.workHoursMode === 'string' ||
    Array.isArray(allowed.workHoursSites);

  return (async () => {
    if (workHoursChanged) {
      try {
        await applyWorkHoursState(next);
      } catch (err) {
        console.warn('[work-hours]', err && err.message ? err.message : err);
      }
    }
    return settingsForRenderer();
  })();
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
    const result = await setTaskCompleted(listKind, taskId, Boolean(completed));
    refreshExactReminders();
    return result;
  });

  ipcMain.handle('widget:create-item', async (event, payload) => {
    if (!isFromWidget(event)) throw new Error('Unauthorized');
    const { listKind, title, parentId } = payload || {};
    const result = await createItem(listKind, title, parentId ? { parentId } : {});
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
    ensureWindowsNotificationShortcut();
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
    ensureWindowsNotificationShortcut();
    const settings = loadSettings();
    applyAutostart(settings.autostart);
    registerIpc();
    createWindow();
    createTray();
    registerHotkeys(settings);
    syncRemindersScheduler(settings.remindersEnabled !== false);
    scheduleHabitsDayRollover();
    startWorkHoursScheduler(() => loadSettings());
    setupAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWidget();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopRemindersScheduler();
    stopHabitsDayRollover();
    cleanupWorkHoursOnQuit();
  });

  app.on('will-quit', () => {
    unregisterHotkeys();
    stopRemindersScheduler();
    stopHabitsDayRollover();
    stopWorkHoursScheduler();
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
