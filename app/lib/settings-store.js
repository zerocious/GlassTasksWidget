'use strict';

const { dataPath } = require('./config');
const { loadDoc, saveDoc } = require('./storage-files');

/**
 * @typedef {'dark' | 'light'} Theme
 * @typedef {'normal' | 'compact'} WidgetSize
 * @typedef {{ x: number, y: number }} WindowPos
 * @typedef {{
 *   theme: Theme,
 *   size: WidgetSize,
 *   autostart: boolean,
 *   snapToEdge: boolean,
 *   autoPalette: boolean,
 *   accentColor: string | null,
 *   bgOpacity: number,
 *   remindersEnabled: boolean,
 *   dailyHabitsReset: boolean,
 *   lastHabitsResetDate: string | null,
 *   hideCompleted: boolean,
 *   simpleAnimations: boolean,
 *   pos: WindowPos | null,
 *   toggleHotkey: string,
 *   switchViewHotkey: string,
 *   onboardingSkipped: boolean,
 * }} AppSettings
 */

/** Glass fill alpha — matches default dark --glass-fill (0.72). */
const DEFAULT_BG_OPACITY = 0.72;
const BG_OPACITY_MIN = 0.2;
const BG_OPACITY_MAX = 0.95;

const DEFAULT_TOGGLE_HOTKEY = 'Control+Alt+W';
const DEFAULT_SWITCH_HOTKEY = 'Control+Tab';

const DEFAULTS = /** @type {AppSettings} */ ({
  theme: 'dark',
  size: 'normal',
  autostart: false,
  snapToEdge: false,
  autoPalette: false,
  accentColor: null,
  bgOpacity: DEFAULT_BG_OPACITY,
  remindersEnabled: true,
  dailyHabitsReset: true,
  lastHabitsResetDate: null,
  hideCompleted: false,
  simpleAnimations: false,
  pos: null,
  toggleHotkey: DEFAULT_TOGGLE_HOTKEY,
  switchViewHotkey: DEFAULT_SWITCH_HOTKEY,
  onboardingSkipped: false,
});

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeBgOpacity(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BG_OPACITY;
  const clamped = Math.min(BG_OPACITY_MAX, Math.max(BG_OPACITY_MIN, n));
  return Math.round(clamped * 100) / 100;
}

function normalizeAccentHex(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}

const SIZE_PRESETS = {
  normal: { width: 380, height: 460, minWidth: 320, minHeight: 380 },
  compact: { width: 300, height: 360, minWidth: 280, minHeight: 300 },
};

/** @type {AppSettings | null} */
let settingsCache = null;

function settingsFile() {
  return dataPath('settings.json');
}

/** settings.json: window/theme preferences. Keeps a last good copy (settings.json.bak). */
const SETTINGS_SPEC = {
  name: 'settings.json',
  file: settingsFile,
  version: 1,
  keepBak: true,
  // v0 -> v1: the file only gained schemaVersion; normalizeSettings() already fills defaults.
  migrations: { 1: (d) => d },
};

function normalizeHotkey(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim();
}

/**
 * @param {any} raw
 * @returns {AppSettings}
 */
function normalizeSettings(raw) {
  const theme = raw.theme === 'light' ? 'light' : 'dark';
  const size = raw.size === 'compact' ? 'compact' : 'normal';
  let pos = null;
  if (
    raw.pos &&
    typeof raw.pos.x === 'number' &&
    typeof raw.pos.y === 'number' &&
    Number.isFinite(raw.pos.x) &&
    Number.isFinite(raw.pos.y)
  ) {
    pos = { x: Math.round(raw.pos.x), y: Math.round(raw.pos.y) };
  }
  return {
    theme,
    size,
    autostart: Boolean(raw.autostart),
    snapToEdge: Boolean(raw.snapToEdge),
    autoPalette: Boolean(raw.autoPalette),
    accentColor: normalizeAccentHex(raw.accentColor),
    bgOpacity: normalizeBgOpacity(
      raw.bgOpacity !== undefined ? raw.bgOpacity : DEFAULT_BG_OPACITY
    ),
    remindersEnabled:
      raw.remindersEnabled === undefined ? true : Boolean(raw.remindersEnabled),
    dailyHabitsReset:
      raw.dailyHabitsReset === undefined ? true : Boolean(raw.dailyHabitsReset),
    lastHabitsResetDate:
      typeof raw.lastHabitsResetDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.lastHabitsResetDate)
        ? raw.lastHabitsResetDate
        : null,
    hideCompleted: Boolean(raw.hideCompleted),
    simpleAnimations: Boolean(raw.simpleAnimations),
    pos,
    toggleHotkey: normalizeHotkey(raw.toggleHotkey, DEFAULT_TOGGLE_HOTKEY),
    switchViewHotkey: normalizeHotkey(raw.switchViewHotkey, DEFAULT_SWITCH_HOTKEY),
    onboardingSkipped: Boolean(raw.onboardingSkipped),
  };
}

/**
 * @returns {AppSettings}
 */
function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = normalizeSettings(loadDoc(SETTINGS_SPEC).data || {});
  return settingsCache;
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
function saveSettings(patch) {
  const current = loadSettings();
  const next = normalizeSettings({ ...current, ...patch });

  // Skip disk write when nothing meaningful changed (e.g. same pos after snap).
  // DEFAULTS lists every setting, so a new key can't be forgotten here.
  const unchanged = Object.keys(DEFAULTS).every((key) =>
    key === 'pos'
      ? (next.pos === null && current.pos === null) ||
        Boolean(next.pos && current.pos && next.pos.x === current.pos.x && next.pos.y === current.pos.y)
      : next[key] === current[key]
  );
  if (unchanged) return current;

  saveDoc(SETTINGS_SPEC, next);
  settingsCache = next;
  return next;
}

function getSizePreset(size) {
  return SIZE_PRESETS[size === 'compact' ? 'compact' : 'normal'];
}

/** Forget the in-memory copy so the next load reads the file again. */
function resetSettingsCache() {
  settingsCache = null;
}

module.exports = {
  SETTINGS_SPEC,
  DEFAULT_BG_OPACITY,
  BG_OPACITY_MIN,
  BG_OPACITY_MAX,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
  SIZE_PRESETS,
  loadSettings,
  saveSettings,
  resetSettingsCache,
  normalizeSettings,
  getSizePreset,
  normalizeBgOpacity,
};
