'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const settings = require('../lib/settings-store');
const { freshDataRoot, writeRaw, readRaw } = require('./helpers/storage');
const { getStorageIssues } = require('../lib/storage-events');

const { normalizeAccelerator } = settings;

test('accelerators are canonicalised (case, aliases, modifier order)', () => {
  assert.equal(normalizeAccelerator('Control+Alt+W'), 'Control+Alt+W');
  assert.equal(normalizeAccelerator('ctrl+alt+w'), 'Control+Alt+W');
  assert.equal(normalizeAccelerator('Alt+CmdOrCtrl+w'), 'Control+Alt+W');
  assert.equal(normalizeAccelerator('CommandOrControl+Shift+f9'), 'Control+Shift+F9');
  assert.equal(normalizeAccelerator('Control+Tab'), 'Control+Tab');
  assert.equal(normalizeAccelerator('alt+pageup'), 'Alt+PageUp');
  assert.equal(normalizeAccelerator('W+Control+Alt'), 'Control+Alt+W', 'modifiers in any order');
  assert.equal(normalizeAccelerator('Control+Plus'), 'Control+Plus');
  assert.equal(normalizeAccelerator('alt+mediaplaypause'), 'Alt+MediaPlayPause');
  assert.equal(normalizeAccelerator('Control+Shift+volumeup'), 'Control+Shift+VolumeUp');
  assert.equal(normalizeAccelerator('Control+`'), 'Control+`', 'console-style toggle');
  assert.equal(normalizeAccelerator('alt+shift+/'), 'Alt+Shift+/');
  assert.equal(normalizeAccelerator('F13'), 'F13', 'keys nobody types may stand alone');
});

test('accelerators that would hijack typing or system keys are rejected', () => {
  for (const bad of [
    'Return', 'Space', 'A', 'Enter', 'F5', 'Tab', // no modifier
    'Shift+A', 'Shift+Return', // Shift alone still types
    'Control+V', 'ctrl+c', 'CmdOrCtrl+X', 'CommandOrControl+v', 'Control+Z', 'Control+A', 'Control+Insert',
    'Alt+F4', 'alt+f4', 'Alt+Tab', 'Alt+Escape', 'Alt+Space', 'Control+Escape',
    'Control+Alt+Delete', 'Control+Shift+Escape',
    '`', 'Shift+=', 'Control+Alt', 'Control+', '+W', 'Control+W+Q', 'Control+Alt+Control+W', 'Control+Ö', 'Control+F99',
    // Electron 33 on Windows drops Super / AltGr: these would register a bare key or Ctrl+C
    'Super+A', 'AltGr+A', 'Meta+Shift+C', 'Control+Super+C', 'Alt+Super+F4', 'Cmd+Q', 'Command+Alt+W',
    '', null, 42, 'x'.repeat(100),
  ]) {
    assert.equal(normalizeAccelerator(bad), null, String(bad));
  }
});

test('settings.json with a dangerous hotkey falls back to the default', () => {
  const root = freshDataRoot();
  writeRaw(root, 'settings.json', { schemaVersion: 1, toggleHotkey: 'Return', switchViewHotkey: 'Control+V' });
  const s = settings.loadSettings();
  assert.equal(s.toggleHotkey, settings.DEFAULT_TOGGLE_HOTKEY);
  assert.equal(s.switchViewHotkey, settings.DEFAULT_SWITCH_HOTKEY);
  assert.equal(settings.saveSettings({ toggleHotkey: 'alt+shift+q' }).toggleHotkey, 'Alt+Shift+Q');
  assert.equal(settings.saveSettings({ toggleHotkey: 'Space' }).toggleHotkey, 'Alt+Shift+Q', 'a rejected change keeps the current one');
  const issues = getStorageIssues().filter((i) => i.kind === 'hotkey-rejected');
  assert.equal(issues.length, 3, 'two from the file, one from the change');
  assert.match(issues[0].message, /«Return» не принято/);
});

test('settings written by a work-hours build (schema 0) keep fontFamily and workHours* after load + save', () => {
  const root = freshDataRoot();
  settings.resetSettingsCache();
  // What feature/work-hours-blocker writes: no schemaVersion, sites possibly as a JSON string.
  writeRaw(root, 'settings.json', {
    theme: 'light',
    fontFamily: 'serif',
    workHoursEnabled: true,
    workHoursStart: '8:30',
    workHoursEnd: '17:45',
    workHoursSites: '["vk.com","https://www.YouTube.com/watch","google.com"]',
    workHoursMode: 'instant',
  });
  const loaded = settings.loadSettings();
  assert.equal(loaded.fontFamily, 'serif');
  assert.equal(loaded.workHoursEnabled, true);
  assert.equal(loaded.workHoursStart, '08:30');
  assert.equal(loaded.workHoursEnd, '17:45');
  assert.deepEqual(loaded.workHoursSites, ['vk.com', 'youtube.com'], 'normalised; protected google.com dropped');
  assert.equal(loaded.workHoursMode, 'instant');

  // An unrelated save (e.g. the window moved) must not erase them.
  settings.saveSettings({ pos: { x: 10, y: 20 } });
  settings.resetSettingsCache();
  const disk = readRaw(root, 'settings.json');
  for (const key of ['fontFamily', 'workHoursEnabled', 'workHoursStart', 'workHoursEnd', 'workHoursSites', 'workHoursMode']) {
    assert.deepEqual(disk[key], loaded[key], key);
  }
});

test('an explicit empty site list stays empty; a missing one gets the defaults; equal lists do not rewrite', () => {
  const root = freshDataRoot();
  settings.resetSettingsCache();
  writeRaw(root, 'settings.json', { schemaVersion: 1, workHoursSites: [] });
  assert.deepEqual(settings.loadSettings().workHoursSites, []);
  settings.resetSettingsCache();
  writeRaw(root, 'settings.json', { schemaVersion: 1 });
  const s = settings.loadSettings();
  assert.ok(s.workHoursSites.length > 0);
  assert.equal(s.fontFamily, 'geist');
  assert.equal(s.workHoursMode, 'warn');
  // Same values as now (a new but equal array) are "unchanged": no write, same object back.
  assert.equal(settings.saveSettings({ workHoursSites: s.workHoursSites.slice() }), s);
});
