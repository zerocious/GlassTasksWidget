'use strict';

const { createJsonDoc } = require('./storage-doc');
const { reportStorageIssue } = require('./storage-events');

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
/** Works inside the widget only (see IN_WIDGET_ACCELERATORS). */
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

/**
 * settings.json. Schema 1 = the flat settings object plus `schemaVersion`
 * (schema 0, written before versioning, has the same fields; normalizeSettings fills gaps).
 */
const settingsDoc = createJsonDoc({
  name: 'settings.json',
  label: 'настройки',
  version: 1,
  lastGood: true,
  defaults: () => ({}),
});

/**
 * Electron modifier names (any case) → canonical name. Super / Meta / Command / AltGr map to
 * null: Electron 33 on Windows drops them when it calls RegisterHotKey, so «Super+A» would
 * register a bare A (and «Control+Super+C» a plain Ctrl+C).
 * @type {Record<string, string | null>}
 */
const MODIFIERS = {
  control: 'Control',
  ctrl: 'Control',
  cmdorctrl: 'Control', // Windows: CmdOrCtrl = Control
  commandorcontrol: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  altgr: null,
  super: null,
  meta: null,
  command: null,
  cmd: null,
};
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift'];

/** Non-letter keys a hotkey may use (lower-case → canonical). */
const NAMED_KEYS = Object.fromEntries(
  [
    'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Escape', 'Esc',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen',
    'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
    'numadd', 'numsub', 'nummult', 'numdiv', 'numdec', 'Plus', 'Capslock', 'Numlock', 'Scrolllock',
    'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
  ].map((k) => [k.toLowerCase(), k])
);

/** Punctuation keys Electron accepts as a single character (e.g. the «Control+`» console toggle). */
const PUNCTUATION_KEYS = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

/**
 * Global shortcuts swallow the key in every application (RegisterHotKey): never take
 * clipboard / undo / select-all or the Windows system combos, whatever the spelling.
 */
const RESERVED_ACCELERATORS = new Set([
  'Control+C', 'Control+V', 'Control+X', 'Control+Z', 'Control+Y', 'Control+A', 'Control+Insert',
  'Control+Escape', 'Control+Esc', 'Control+Alt+Delete', 'Control+Shift+Escape', 'Control+Shift+Esc',
  'Alt+F4', 'Alt+Tab', 'Alt+Escape', 'Alt+Esc', 'Alt+Space',
]);

/**
 * Tab switching in browsers, editors and Explorer. Registered globally they would stop working
 * in every other application, so the widget handles them only while it has focus (the
 * renderer's keydown handler) and never registers them. settings.json may still name them:
 * Ctrl+Tab is the default, and older versions saved it as a global hotkey.
 */
const IN_WIDGET_ACCELERATORS = new Set(['Control+Tab', 'Control+Shift+Tab']);

/**
 * @param {string} accel canonical accelerator (see normalizeAccelerator)
 * @returns {boolean} true when the widget must not register it as a global shortcut
 */
function isInWidgetAccelerator(accel) {
  return IN_WIDGET_ACCELERATORS.has(accel);
}

/**
 * Canonical, safe accelerator or null. Requires Control or Alt (Shift alone still types),
 * exactly one key (modifiers in any order), and no reserved system combo; F13–F24 may stand
 * alone. Super / Meta / AltGr are refused (see MODIFIERS).
 * @param {unknown} value e.g. "ctrl+alt+w"
 * @returns {string | null} e.g. "Control+Alt+W"
 */
function normalizeAccelerator(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = value.trim().split('+');
  /** @type {Set<string>} */
  const mods = new Set();
  /** @type {string | null} */
  let key = null;
  for (const part of parts) {
    const token = part.trim();
    if (!/^[A-Za-z0-9]+$/.test(token) && !PUNCTUATION_KEYS.has(token)) return null;
    const lower = token.toLowerCase();
    if (Object.hasOwn(MODIFIERS, lower)) {
      const mod = MODIFIERS[lower];
      if (!mod || mods.has(mod)) return null;
      mods.add(mod);
      continue;
    }
    if (key) return null;
    if (/^[a-z0-9]$/.test(lower) || PUNCTUATION_KEYS.has(token)) key = token.toUpperCase();
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) key = lower.toUpperCase();
    else if (NAMED_KEYS[lower]) key = NAMED_KEYS[lower];
    else return null;
  }
  if (!key) return null;
  const bareOk = /^F(1[3-9]|2[0-4])$/.test(key);
  if (!bareOk && !mods.has('Control') && !mods.has('Alt')) return null;
  const accel = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  return RESERVED_ACCELERATORS.has(accel) ? null : accel;
}

function normalizeHotkey(value, fallback) {
  return normalizeAccelerator(value) || fallback;
}

const HOTKEY_KEYS = /** @type {const} */ (['toggleHotkey', 'switchViewHotkey']);

/** Tell the user a hotkey from settings.json or a settings change was not accepted. */
function reportRejectedHotkey(value, used) {
  reportStorageIssue({
    kind: 'hotkey-rejected',
    file: 'settings.json',
    repeat: true,
    message: `Сочетание «${String(value).slice(0, 64)}» не принято: оно занимает системную клавишу, не содержит Ctrl или Alt либо не поддерживается Windows. Используется «${used}».`,
  });
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
  const raw = settingsDoc.read();
  settingsCache = normalizeSettings(raw);
  for (const key of HOTKEY_KEYS) {
    if (typeof raw[key] === 'string' && raw[key].trim() && !normalizeAccelerator(raw[key])) {
      reportRejectedHotkey(raw[key], settingsCache[key]);
    }
  }
  return settingsCache;
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
function saveSettings(patch) {
  const current = loadSettings();
  const accepted = { ...patch };
  for (const key of HOTKEY_KEYS) {
    // A rejected hotkey keeps the current one instead of silently resetting it to the default.
    if (key in accepted && !normalizeAccelerator(accepted[key])) {
      reportRejectedHotkey(accepted[key], current[key]);
      delete accepted[key];
    }
  }
  const next = normalizeSettings({ ...current, ...accepted });

  // Skip disk write when nothing meaningful changed (e.g. same pos after snap).
  // DEFAULTS lists every setting, so a new key can't be forgotten here.
  const unchanged = Object.keys(DEFAULTS).every((key) =>
    key === 'pos'
      ? (next.pos === null && current.pos === null) ||
        Boolean(next.pos && current.pos && next.pos.x === current.pos.x && next.pos.y === current.pos.y)
      : next[key] === current[key]
  );
  if (unchanged) return current;

  settingsDoc.write(next);
  settingsCache = next;
  return next;
}

/** Forget the in-memory copy (after import / wipe) so the next load reads the file. */
function resetSettingsCache() {
  settingsCache = null;
}

function getSizePreset(size) {
  return SIZE_PRESETS[size === 'compact' ? 'compact' : 'normal'];
}

module.exports = {
  DEFAULT_BG_OPACITY,
  BG_OPACITY_MIN,
  BG_OPACITY_MAX,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
  SIZE_PRESETS,
  DEFAULTS,
  normalizeAccelerator,
  isInWidgetAccelerator,
  loadSettings,
  saveSettings,
  resetSettingsCache,
  normalizeSettings,
  getSizePreset,
  normalizeBgOpacity,
  settingsDoc,
};
