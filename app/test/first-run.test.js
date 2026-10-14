'use strict';

/**
 * Guards for bugs that only show on a brand-new profile or after a refactor:
 *  - first launch (no data files) in demo mode must work;
 *  - every `const { a, b } = require('./x')` must name something x really exports.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

test('demo mode works on a fresh profile (no data files yet)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-fresh-'));
  const config = require('../lib/config');
  config.setDataRootForTests(dir);
  try {
    const { getMockPayload } = require('../lib/mock-data');
    const payload = getMockPayload({
      tasksListName: 'Tasks',
      habitsListName: 'Habits',
      accentColor: '#C4122E',
    });
    assert.equal(payload.mode, 'mock');
    assert.ok(payload.tasks.length > 0, 'demo tasks');
    assert.ok(payload.habits.length > 0, 'demo habits');
    assert.ok(
      payload.habits.some((h) => h.streak > 0),
      'demo history is seeded so the week strip is not empty'
    );
    assert.deepEqual(fs.readdirSync(dir).sort(), ['mock-items.json', 'streaks.json']);
  } finally {
    config.setDataRootForTests(null);
  }
});

/** `const { a, b: c = 1 } = require('./mod')` → [{ file, mod, names }] */
function findDestructuredRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g;
  const found = [];
  for (const m of src.matchAll(re)) {
    const names = m[1]
      .split(',')
      .map((part) => part.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter(Boolean)
      .map((part) => part.split(':')[0].split('=')[0].trim());
    found.push({ mod: m[2], names });
  }
  return found;
}

test('every destructured require() between app modules names a real export', () => {
  const dirs = ['lib', 'electron'];
  const problems = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(APP_ROOT, dir))) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(APP_ROOT, dir, name);
      for (const { mod, names } of findDestructuredRequires(file)) {
        const target = path.resolve(path.dirname(file), mod);
        // electron/* needs the Electron runtime to load; only check imports of lib/* (loadable in Node).
        if (!target.startsWith(path.join(APP_ROOT, 'lib') + path.sep)) continue;
        let exported;
        try {
          exported = require(target);
        } catch (err) {
          problems.push(`${dir}/${name}: cannot load ${mod}: ${err.message}`);
          continue;
        }
        for (const n of names) {
          if (!(n in exported)) problems.push(`${dir}/${name}: ${mod} has no export "${n}"`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
