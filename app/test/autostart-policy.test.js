'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loginItem, loginItemRegistered, startupWritesLoginItem } = require('../lib/autostart-policy');

const AUMID = 'com.glasstasks.widget';
const TMP = path.resolve('/tmp-root/Temp');
const INSTALLED = path.resolve('/apps/Glass Tasks Widget/Glass Tasks Widget.exe');
const SMOKE_BUILD = path.join(TMP, 'gt-smoke-AbC123', 'pack', 'win-unpacked', 'Glass Tasks Widget.exe');
const UNPACKED_PORTABLE = path.join(TMP, '2Ab3Cd4Ef', 'Glass Tasks Widget.exe');
const PORTABLE = path.resolve('/Users/me/Downloads/Glass-Tasks-Widget-Portable-1.1.0.exe');
const ELECTRON = path.resolve('/repo/app/node_modules/electron/dist/electron.exe');
const APP_ROOT = path.resolve('/repo/app');

const packaged = { aumid: AUMID, isPackaged: true, appRoot: APP_ROOT, tmpDir: TMP };

test('an installed copy uses the AppUserModelId and Electron’s default (quoted) exe path', () => {
  assert.deepEqual(loginItem({ ...packaged, execPath: INSTALLED }), { name: AUMID, exe: INSTALLED, options: {} });
});

test('a dev run has a login item name of its own', () => {
  const item = loginItem({ ...packaged, isPackaged: false, execPath: ELECTRON });
  assert.equal(item.name, `${AUMID}.dev`);
  assert.notEqual(item.name, AUMID, 'never the installed widget’s value');
  assert.deepEqual(item.options, { path: ELECTRON, args: [APP_ROOT] });
});

test('the portable build starts the portable exe, not its temp copy', () => {
  const item = loginItem({ ...packaged, execPath: UNPACKED_PORTABLE, portableExe: PORTABLE });
  assert.deepEqual(item, { name: AUMID, exe: PORTABLE, options: { path: `"${PORTABLE}"`, args: [] } });
});

test('PORTABLE_EXECUTABLE_FILE is ignored outside the portable launcher’s temp copy', () => {
  assert.equal(loginItem({ ...packaged, execPath: INSTALLED, portableExe: PORTABLE }).exe, INSTALLED, 'inherited by an installed exe');
  assert.equal(loginItem({ ...packaged, execPath: UNPACKED_PORTABLE, portableExe: 'relative.exe' }).exe, UNPACKED_PORTABLE);
  assert.equal(loginItem({ ...packaged, isPackaged: false, execPath: ELECTRON, portableExe: PORTABLE }).exe, ELECTRON);
});

test('a start never removes the login item and never writes one that is already there', () => {
  const base = { exe: INSTALLED, tmpDir: TMP };
  assert.equal(startupWritesLoginItem({ ...base, wanted: false, registered: false }), false, 'fresh profile: autostart off');
  assert.equal(startupWritesLoginItem({ ...base, wanted: false, registered: true }), false);
  assert.equal(startupWritesLoginItem({ ...base, wanted: true, registered: true }), false, 'keeps «Disabled» in Task Manager');
  assert.equal(startupWritesLoginItem({ ...base, wanted: true, registered: false }), true, 'missing or foreign entry is restored');
});

test('a copy in the temp folder never writes the login item at start', () => {
  assert.equal(startupWritesLoginItem({ exe: SMOKE_BUILD, tmpDir: TMP, wanted: true, registered: false }), false);
  assert.equal(startupWritesLoginItem({ exe: PORTABLE, tmpDir: TMP, wanted: true, registered: false }), true, 'portable: the exe is not in temp');
});

test('the portable exe is not named like the installer', () => {
  // win.artifactName applies to every Windows target; the release workflow uploads Glass-Tasks-Widget-Setup-*.exe.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const name = pkg.build.portable && pkg.build.portable.artifactName;
  assert.ok(name, 'build.portable.artifactName is set');
  assert.doesNotMatch(name, /Setup/);
  assert.notEqual(name, pkg.build.win.artifactName);
});

test('registered means: an entry under this name starts this exe (Windows launchItems)', () => {
  const items = (...list) => ({ openAtLogin: false, launchItems: list });
  assert.equal(loginItemRegistered(AUMID, items({ name: AUMID, scope: 'user' }), 'win32'), true);
  assert.equal(loginItemRegistered(AUMID, items({ name: AUMID.toUpperCase(), scope: 'user' }), 'win32'), true, 'value names ignore case');
  assert.equal(loginItemRegistered(AUMID, items({ name: `${AUMID}.dev`, scope: 'user' }), 'win32'), false);
  assert.equal(loginItemRegistered(AUMID, items({ name: AUMID, scope: 'machine' }), 'win32'), false, 'HKLM is not ours');
  assert.equal(loginItemRegistered(AUMID, items(), 'win32'), false);
  assert.equal(loginItemRegistered(AUMID, null, 'win32'), false);
  assert.equal(loginItemRegistered(AUMID, { openAtLogin: true }, 'darwin'), true);
});
