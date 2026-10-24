'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { shortcutAction, samePath, isInside } = require('../lib/shortcut-policy');

const TMP = path.resolve('/tmp-root/Temp');
const INSTALLED = path.resolve('/apps/Glass Tasks Widget/Glass Tasks Widget.exe');
const REPO_BUILD = path.resolve('/repo/app/dist/win-unpacked/Glass Tasks Widget.exe');
const SMOKE_BUILD = path.join(TMP, 'gt-smoke-AbC123', 'pack', 'win-unpacked', 'Glass Tasks Widget.exe');

const base = { isDesktop: false, isPackaged: true, tmpDir: TMP };

test('a temp (smoke) build never repoints a shortcut that belongs to another existing copy', () => {
  // The bug: every smoke run pointed the user's Start Menu link at a temp folder that was then deleted.
  assert.equal(
    shortcutAction({ ...base, exists: true, execPath: SMOKE_BUILD, currentTarget: REPO_BUILD, currentTargetExists: true }),
    null
  );
});

test('another installed copy that still exists keeps its shortcut', () => {
  assert.equal(
    shortcutAction({ ...base, exists: true, execPath: INSTALLED, currentTarget: REPO_BUILD, currentTargetExists: true }),
    null
  );
});

test('the widget refreshes its own shortcut (same exe, any letter case)', () => {
  const upper = process.platform === 'win32' ? INSTALLED.toUpperCase() : INSTALLED;
  assert.equal(
    shortcutAction({ ...base, exists: true, execPath: INSTALLED, currentTarget: upper, currentTargetExists: true }),
    'update'
  );
});

test('a broken shortcut (its exe is gone) is taken over, but not by a temp build', () => {
  const goneSmoke = path.join(TMP, 'gt-smoke-OLD999', 'pack', 'win-unpacked', 'Glass Tasks Widget.exe');
  const broken = { ...base, exists: true, currentTarget: goneSmoke, currentTargetExists: false };
  assert.equal(shortcutAction({ ...broken, execPath: INSTALLED }), 'update');
  assert.equal(shortcutAction({ ...broken, execPath: SMOKE_BUILD }), null);
});

test('a missing Start Menu link is created, except from a temp build; a missing Desktop link never', () => {
  assert.equal(shortcutAction({ ...base, exists: false, execPath: INSTALLED }), 'create');
  assert.equal(shortcutAction({ ...base, exists: false, execPath: SMOKE_BUILD }), null);
  assert.equal(shortcutAction({ ...base, exists: false, isDesktop: true, execPath: INSTALLED }), null);
});

test('a dev run never repoints an existing shortcut', () => {
  assert.equal(
    shortcutAction({ ...base, isPackaged: false, exists: true, execPath: INSTALLED, currentTarget: null }),
    null
  );
});

test('GT_SKIP_SHORTCUTS (skip) wins over everything', () => {
  assert.equal(shortcutAction({ ...base, skip: true, exists: false, execPath: INSTALLED }), null);
  assert.equal(
    shortcutAction({ ...base, skip: true, exists: true, execPath: INSTALLED, currentTarget: INSTALLED, currentTargetExists: true }),
    null
  );
});

test('path helpers', () => {
  assert.ok(isInside(SMOKE_BUILD, TMP));
  assert.ok(!isInside(INSTALLED, TMP));
  assert.ok(!isInside(TMP, TMP));
  assert.ok(!isInside(path.resolve('/tmp-root/Temp-other/x.exe'), TMP));
  assert.ok(samePath(INSTALLED, INSTALLED + path.sep));
  assert.ok(!samePath(null, INSTALLED));
});
