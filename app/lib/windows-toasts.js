'use strict';

const { execSync } = require('child_process');

/** @type {{ at: number, value: boolean }} */
let cache = { at: 0, value: true };
const CACHE_TTL_MS = 30_000;
const REG_TIMEOUT_MS = 3000;

/**
 * HKCU PushNotifications\ToastEnabled — master switch in
 * Settings → System → Notifications. 0 blocks all Electron toasts.
 *
 * Result is cached briefly to avoid spawning `reg` on every settings/reminder tick.
 *
 * @param {{ bypassCache?: boolean }} [opts]
 * @returns {boolean}
 */
function windowsToastsGloballyEnabled(opts = {}) {
  if (process.platform !== 'win32') return true;

  const now = Date.now();
  if (!opts.bypassCache && now - cache.at < CACHE_TTL_MS) return cache.value;

  let value = true;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications" /v ToastEnabled',
      { encoding: 'utf8', windowsHide: true, timeout: REG_TIMEOUT_MS }
    );
    const m = out.match(/ToastEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
    if (m) value = parseInt(m[1], 16) !== 0;
  } catch {
    value = true;
  }

  cache = { at: now, value };
  return value;
}

module.exports = {
  windowsToastsGloballyEnabled,
};
