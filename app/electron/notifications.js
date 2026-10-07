'use strict';

/**
 * OS notifications: Electron toast → WinRT PowerShell toast → tray balloon,
 * plus the Start Menu shortcut (AppUserModelID) Windows needs to show them.
 */

const { app, shell, nativeImage, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { markNotified } = require('../lib/reminder-store');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';

/** Window / tray wiring supplied by main.js. */
let hooks = {
  /** @returns {Electron.Tray | null} */
  getTray: () => null,
  /** @type {(title: string, body: string, opts?: { focus?: boolean }) => void} */
  pushInApp: () => {},
  onClick: () => {},
};

/** @param {Partial<typeof hooks>} next */
function configureNotifications(next) {
  hooks = { ...hooks, ...next };
}

let shortcutsEnsured = false;

/** @type {{ value: boolean, at: number } | null} */
let toastsEnabledCache = null;
const TOASTS_ENABLED_TTL_MS = 30 * 1000;

/**
 * HKCU PushNotifications\ToastEnabled — master switch in
 * Settings → System → Notifications. 0 blocks all Electron toasts.
 * @returns {boolean}
 */
function windowsToastsGloballyEnabled() {
  if (process.platform !== 'win32') return true;
  // Synchronous `reg query` — cache it so bootstrap / settings IPC don't block every call.
  if (toastsEnabledCache && Date.now() - toastsEnabledCache.at < TOASTS_ENABLED_TTL_MS) {
    return toastsEnabledCache.value;
  }
  let value = true;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications" /v ToastEnabled',
      { encoding: 'utf8', windowsHide: true }
    );
    const m = out.match(/ToastEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
    if (m) value = parseInt(m[1], 16) !== 0;
  } catch {
    value = true;
  }
  toastsEnabledCache = { value, at: Date.now() };
  return value;
}

/**
 * Ensure Start Menu + Desktop shortcuts carry AppUserModelID matching
 * app.setAppUserModelId — required for Windows Action Center toasts.
 * Runs once per session (or when forced). The Start Menu link is required and always
 * written; the Desktop link is only refreshed if the user still has one.
 */
function ensureWindowsNotificationShortcut(opts = {}) {
  if (process.platform !== 'win32') return;
  if (shortcutsEnsured && !opts.force) return;
  shortcutsEnsured = true;
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
      const exists = fs.existsSync(lnk);
      if (!exists && lnk === desktopLnk) continue;
      // A dev run (`npm start`) must not repoint the installed widget's shortcuts.
      if (exists && !app.isPackaged) continue;
      const op = exists ? 'update' : 'create';
      const ok = shell.writeShortcutLink(lnk, op, details);
      if (!ok) console.warn('[reminders] shortcut write failed', lnk);
    }
  } catch (err) {
    console.warn('[reminders] shortcut', err && err.message ? err.message : err);
  }
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
 * Static WinRT toast script. Title, body and icon arrive only through environment
 * variables and are XML-escaped inside PowerShell — user text is never part of the code.
 */
const WINRT_TOAST_PS = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Security.SecurityElement]::Escape([string]$env:GT_TOAST_TITLE)
$b = [Security.SecurityElement]::Escape([string]$env:GT_TOAST_BODY)
$img = ''
if ($env:GT_TOAST_ICON) { $img = '<image placement="appLogoOverride" src="' + [Security.SecurityElement]::Escape($env:GT_TOAST_ICON) + '" />' }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric">' + $img + '<text>' + $t + '</text><text>' + $b + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = 'glass-tasks-reminder'
$toast.Group = 'glass-tasks'
$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:GT_TOAST_AUMID)
$n.Show($toast)
`;

/**
 * Native WinRT toast via PowerShell — fallback when Electron Notification fails.
 * Uses the same AppUserModelID so the toast lands under "Glass Tasks Widget"
 * in Action Center (requires Start Menu .lnk with matching AUMID).
 * @param {string} title
 * @param {string} body
 * @returns {Promise<boolean>}
 */
function showNativeWinRtToast(title, body) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const iconPath = reminderToastIconPath();
  const encoded = Buffer.from(WINRT_TOAST_PS, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        timeout: 8000,
        env: {
          ...process.env,
          GT_TOAST_TITLE: String(title || '').slice(0, 120),
          GT_TOAST_BODY: String(body || '').slice(0, 240),
          GT_TOAST_ICON: iconPath ? pathToFileURL(iconPath).href : '',
          GT_TOAST_AUMID: APP_USER_MODEL_ID,
        },
      },
      (err) => {
        if (err) {
          console.warn('[reminders] winrt', err.message || err);
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

/**
 * Tray balloon last-resort backup (not Action Center).
 * @param {string} title
 * @param {string} body
 */
function showTrayBalloon(title, body) {
  const tray = hooks.getTray();
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
      n.on('click', () => hooks.onClick());
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
    winrt = await showNativeWinRtToast(title, body);
    if (winrt) {
      shown = true;
      channel = 'winrt';
    }
  }

  // In-app: secondary cue — don't steal focus when OS toast already showed.
  if (!shown || opts.force) {
    hooks.pushInApp(title, body, { focus: !shown });
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

module.exports = {
  APP_USER_MODEL_ID,
  configureNotifications,
  windowsToastsGloballyEnabled,
  ensureWindowsNotificationShortcut,
  showReminderToast,
};
