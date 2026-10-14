'use strict';

const { redact } = require('./logger');

/** Settings that are safe and useful in a bug report (no position, hotkeys are fine). */
const SAFE_SETTING_KEYS = [
  'theme',
  'size',
  'autostart',
  'snapToEdge',
  'autoPalette',
  'bgOpacity',
  'remindersEnabled',
  'dailyHabitsReset',
  'hideCompleted',
  'simpleAnimations',
  'toggleHotkey',
  'switchViewHotkey',
  'onboardingSkipped',
];

/**
 * Plain-text support report. Everything passes through redact(): no tokens, keys,
 * auth codes or Windows user name, and no task content.
 * @param {{
 *   app: { name: string, version: string, packaged: boolean },
 *   versions: Record<string, string>,
 *   os: string,
 *   auth: { credentialsConfigured: boolean, signedIn: boolean, clientId: string | null, pinnedPort: number | null },
 *   settings: Record<string, unknown>,
 *   dataDir: string,
 *   hotkeys?: Record<string, unknown>,
 * }} info
 * @param {string} logTail
 * @returns {string}
 */
function formatDiagnostics(info, logTail) {
  const settings = {};
  for (const key of SAFE_SETTING_KEYS) {
    if (info.settings && key in info.settings) settings[key] = info.settings[key];
  }
  const clientId = info.auth.clientId ? `${String(info.auth.clientId).slice(0, 10)}…` : '—';
  const lines = [
    `${info.app.name} ${info.app.version}${info.app.packaged ? '' : ' (dev)'}`,
    `Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`,
    `OS: ${info.os}`,
    '',
    'Google:',
    `  ключи: ${info.auth.credentialsConfigured ? 'есть' : 'нет'}  клиент: ${clientId}`,
    `  вход выполнен: ${info.auth.signedIn ? 'да' : 'нет'}  порт: ${info.auth.pinnedPort || 'авто'}`,
    '',
    `Данные: ${info.dataDir}`,
    `Настройки: ${JSON.stringify(settings)}`,
    info.hotkeys ? `Горячие клавиши: ${JSON.stringify(info.hotkeys)}` : '',
    '',
    '--- журнал (последние строки) ---',
    logTail || '(пусто)',
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '');
  return redact(lines.join('\n'));
}

module.exports = { formatDiagnostics, SAFE_SETTING_KEYS };
