'use strict';

const { readJson, writeJson, dataPath } = require('./config');

/**
 * @typedef {'dark' | 'light'} Theme
 * @typedef {'normal' | 'compact'} WidgetSize
 * @typedef {{ x: number, y: number }} WindowPos
 * @typedef {{
 *   theme: Theme,
 *   size: WidgetSize,
 *   autostart: boolean,
 *   snapToEdge: boolean,
 *   pos: WindowPos | null,
 *   toggleHotkey: string,
 *   switchViewHotkey: string,
 * }} AppSettings
 */

const DEFAULT_TOGGLE_HOTKEY = 'Control+Alt+W';
const DEFAULT_SWITCH_HOTKEY = 'Control+Tab';

const DEFAULTS = /** @type {AppSettings} */ ({
  theme: 'dark',
  size: 'normal',
  autostart: false,
  snapToEdge: false,
  pos: null,
  toggleHotkey: DEFAULT_TOGGLE_HOTKEY,
  switchViewHotkey: DEFAULT_SWITCH_HOTKEY,
});

const SIZE_PRESETS = {
  normal: { width: 380, height: 460, minWidth: 320, minHeight: 380 },
  compact: { width: 300, height: 360, minWidth: 280, minHeight: 300 },
};

function settingsFile() {
  return dataPath('settings.json');
}

function normalizeHotkey(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim();
}

/**
 * @returns {AppSettings}
 */
function loadSettings() {
  const raw = readJson(settingsFile(), {});
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
    pos,
    toggleHotkey: normalizeHotkey(raw.toggleHotkey, DEFAULT_TOGGLE_HOTKEY),
    switchViewHotkey: normalizeHotkey(raw.switchViewHotkey, DEFAULT_SWITCH_HOTKEY),
  };
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };

  next.theme = next.theme === 'light' ? 'light' : 'dark';
  next.size = next.size === 'compact' ? 'compact' : 'normal';
  next.autostart = Boolean(next.autostart);
  next.snapToEdge = Boolean(next.snapToEdge);
  next.toggleHotkey = normalizeHotkey(next.toggleHotkey, DEFAULT_TOGGLE_HOTKEY);
  next.switchViewHotkey = normalizeHotkey(next.switchViewHotkey, DEFAULT_SWITCH_HOTKEY);

  if (
    next.pos &&
    typeof next.pos.x === 'number' &&
    typeof next.pos.y === 'number' &&
    Number.isFinite(next.pos.x) &&
    Number.isFinite(next.pos.y)
  ) {
    next.pos = { x: Math.round(next.pos.x), y: Math.round(next.pos.y) };
  } else {
    next.pos = null;
  }

  writeJson(settingsFile(), next);
  return next;
}

function getSizePreset(size) {
  return SIZE_PRESETS[size === 'compact' ? 'compact' : 'normal'];
}

module.exports = {
  DEFAULTS,
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_SWITCH_HOTKEY,
  SIZE_PRESETS,
  loadSettings,
  saveSettings,
  getSizePreset,
};
