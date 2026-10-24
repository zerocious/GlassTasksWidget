'use strict';

const path = require('path');
const { isInside } = require('./shortcut-policy');

/**
 * This copy's Windows login item (HKCU\…\Run): the registry value name, the exe it starts and
 * the options to pass to app.setLoginItemSettings / app.getLoginItemSettings.
 *
 * Every build shares the AppUserModelId, which Electron also uses as the default value name, so
 * a dev run (`npm start`) gets a name of its own: with the shared one it removed or repointed the
 * installed widget's entry. The portable build runs from a copy its launcher unpacks into %TEMP%
 * and deletes on exit, so its entry starts the portable exe itself (PORTABLE_EXECUTABLE_FILE).
 *
 * @param {{
 *   aumid: string,
 *   isPackaged: boolean,
 *   execPath: string,
 *   appRoot: string,
 *   portableExe?: string | null,
 *   tmpDir?: string | null,
 * }} o
 * @returns {{ name: string, exe: string, options: { path?: string, args?: string[] } }}
 */
function loginItem(o) {
  if (!o.isPackaged) {
    return { name: `${o.aumid}.dev`, exe: o.execPath, options: { path: o.execPath, args: [o.appRoot] } };
  }
  // Only the unpacked copy is trusted with the variable: an installed exe that merely inherited
  // it (started by a portable copy) keeps its own path.
  const portable = typeof o.portableExe === 'string' && path.isAbsolute(o.portableExe) && isInside(o.execPath, o.tmpDir);
  if (portable) {
    // Electron writes a given path as is; quote it the way its own default (process.execPath) is.
    return { name: o.aumid, exe: o.portableExe, options: { path: `"${o.portableExe}"`, args: [] } };
  }
  return { name: o.aumid, exe: o.execPath, options: {} };
}

/**
 * True when the Run key already starts this exe under `name`. On Windows Electron lists in
 * `launchItems` only the entries whose exe matches the one it was asked about; value names are
 * case-insensitive there.
 * @param {string} name
 * @param {{ openAtLogin?: boolean, launchItems?: Array<{ name?: string, scope?: string }> } | null | undefined} current
 * @param {string} [platform]
 */
function loginItemRegistered(name, current, platform = process.platform) {
  if (!current) return false;
  if (platform !== 'win32') return Boolean(current.openAtLogin);
  const wanted = name.toLowerCase();
  return (current.launchItems || []).some(
    (item) => item && item.scope !== 'machine' && String(item.name || '').toLowerCase() === wanted
  );
}

/**
 * Whether a start writes the login item. A start never removes it: on a fresh profile (smoke
 * test, dev profile, another copy) autostart is off, and removing would take the installed
 * widget's entry away; only the settings toggle removes it. An entry that already starts this
 * exe stays as it is, so «Disabled» in Task Manager survives (Electron re-enables on every write).
 * A copy running from the temp folder (smoke test, unpacked zip) never writes: its exe is about
 * to disappear.
 * @param {{ wanted: boolean, registered: boolean, exe: string, tmpDir?: string | null }} o
 */
function startupWritesLoginItem(o) {
  if (!o.wanted || o.registered) return false;
  return !isInside(o.exe, o.tmpDir);
}

module.exports = { loginItem, loginItemRegistered, startupWritesLoginItem };
