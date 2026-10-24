'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const build = pkg.build;

test('the packaged exe gets the widget icon and version info; only code signing is skipped', () => {
  // The bug: `signAndEditExecutable: false` makes electron-builder skip the resource edit too, so the
  // exe kept Electron's atom icon and "Electron / GitHub, Inc." version info (shortcuts, Apps &
  // features, Task Manager startup apps). `signExecutable: false` skips the signature only.
  assert.notEqual(build.win.signAndEditExecutable, false);
  assert.equal(build.win.signExecutable, false);
});

test('the resource edit has what it writes: an icon, a product name and a company name', () => {
  const icon = build.win.icon || build.icon;
  assert.ok(icon, 'build.icon is set');
  assert.ok(fs.existsSync(path.join(APP_ROOT, icon)), `${icon} exists`);
  assert.equal(build.productName, 'Glass Tasks Widget');
  // electron-builder takes CompanyName from the author.
  assert.ok(typeof pkg.author === 'string' ? pkg.author : pkg.author && pkg.author.name);
});
