'use strict';

const { readJson, writeJson, dataPath } = require('./config');
const {
  normalizeTime,
  normalizeMode,
  normalizeSitesList,
  DEFAULT_WORK_HOURS_SITES,
} = require('./work-hours-blocker');

/**
 * @typedef {'dark' | 'light'} Theme
 * @typedef {'normal' | 'compact'} WidgetSize
 * @typedef {'geist' | 'system' | 'mono' | 'serif'} FontFamily
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
 *   fontFamily: FontFamily,
 *   pos: WindowPos | null,
 *   toggleHotkey: string,
 *   switchViewHotkey: string,
 *   onboardingSkipped: boolean,
 *   workHoursEnabled: boolean,
 *   workHoursStart: string,
 *   workHoursEnd: string,
 *   workHoursSites: string[],
 *   workHoursMode: 'instant' | 'warn',
 * }} AppSettings
 */

/** Glass fill alpha — matches default dark --glass-fill (0.72). */
const DEFAULT_BG_OPACITY = 0.72;
const BG_OPACITY_MIN = 0.2;
const BG_OPACITY_MAX = 0.95;

/** UI font presets — CSS maps each to a stack via html[data-font]. */
const FONT_FAMILIES = ['geist', 'system', 'mono', 'serif'];
const DEFAULT_FONT_FAMILY = 'geist';

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
  fontFamily: DEFAULT_FONT_FAMILY,
  pos: null,
  toggleHotkey: DEFAULT_TOGGLE_HOTKEY,
  switchViewHotkey: DEFAULT_SWITCH_HOTKEY,
  onboardingSkipped: false,
  workHoursEnabled: false,
  workHoursStart: '09:00',
  workHoursEnd: '18:00',
  workHoursSites: DEFAULT_WORK_HOURS_SITES.slice(),
  workHoursMode: 'warn',
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
    fontFamily: FONT_FAMILIES.includes(raw.fontFamily) ? raw.fontFamily : DEFAULT_FONT_FAMILY,
    pos,
    toggleHotkey: normalizeHotkey(raw.toggleHotkey, DEFAULT_TOGGLE_HOTKEY),
    switchViewHotkey: normalizeHotkey(raw.switchViewHotkey, DEFAULT_SWITCH_HOTKEY),
    onboardingSkipped: Boolean(raw.onboardingSkipped),
    workHoursEnabled: Boolean(raw.workHoursEnabled),
    workHoursStart: normalizeTime(raw.workHoursStart, '09:00'),
    workHoursEnd: normalizeTime(raw.workHoursEnd, '18:00'),
    workHoursSites: normalizeSitesList(
      raw.workHoursSites !== undefined ? raw.workHoursSites : DEFAULTS.workHoursSites
    ).sites,
    workHoursMode: normalizeMode(raw.workHoursMode),
  };
}

/**
 * @returns {AppSettings}
 */
function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = normalizeSettings(readJson(settingsFile(), {}));
  return settingsCache;
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
function saveSettings(patch) {
  const current = loadSettings();
  const next = normalizeSettings({ ...current, ...patch });

  // Skip disk write when nothing meaningful changed (e.g. same pos after snap)
  if (
    next.theme === current.theme &&
    next.size === current.size &&
    next.autostart === current.autostart &&
    next.snapToEdge === current.snapToEdge &&
    next.autoPalette === current.autoPalette &&
    next.accentColor === current.accentColor &&
    next.bgOpacity === current.bgOpacity &&
    next.remindersEnabled === current.remindersEnabled &&
    next.dailyHabitsReset === current.dailyHabitsReset &&
    next.lastHabitsResetDate === current.lastHabitsResetDate &&
    next.hideCompleted === current.hideCompleted &&
    next.simpleAnimations === current.simpleAnimations &&
    next.fontFamily === current.fontFamily &&
    next.toggleHotkey === current.toggleHotkey &&
    next.switchViewHotkey === current.switchViewHotkey &&
    next.onboardingSkipped === current.onboardingSkipped &&
    next.workHoursEnabled === current.workHoursEnabled &&
    next.workHoursStart === current.workHoursStart &&
    next.workHoursEnd === current.workHoursEnd &&
    next.workHoursMode === current.workHoursMode &&
    JSON.stringify(next.workHoursSites) === JSON.stringify(current.workHoursSites) &&
    ((next.pos === null && current.pos === null) ||
      (next.pos &&
        current.pos &&
        next.pos.x === current.pos.x &&
        next.pos.y === current.pos.y))
  ) {
    return current;
  }

  writeJson(settingsFile(), next);
  settingsCache = next;
  return next;
}

function getSizePreset(size) {
  return SIZE_PRESETS[size === 'compact' ? 'compact' : 'normal'];
}

module.exports = {
  DEFAULTS,
  DEFAULT_BG_OPACITY,
  BG_OPACITY_MIN,
  BG_OPACITY_MAX,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
  FONT_FAMILIES,
  SIZE_PRESETS,
  loadSettings,
  saveSettings,
  getSizePreset,
  normalizeBgOpacity,
};
