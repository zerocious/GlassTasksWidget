'use strict';

/** Repository-level guarantees around user data: ignore rules, uninstaller option, docs. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');

function lines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim());
}

test('.gitignore keeps the whole data folder and leftovers out of git', () => {
  for (const file of [path.join(APP, '.gitignore'), path.join(REPO, '.gitignore')]) {
    const rules = lines(file);
    for (const rule of ['data/', '*.corrupt-*', '*.tmp', '*.bak', '.env']) {
      assert.ok(rules.includes(rule), `${path.relative(REPO, file)} misses ${rule}`);
    }
    assert.equal(rules.some((r) => /^data\/.+\.json$/.test(r)), false, 'no per-file data rules left');
  }
  const probes = ['data/some-future-file.json', 'data/backups/x.json', 'x.json.bak', 'x.json.corrupt-1'];
  const git = spawnSync('git', ['check-ignore', ...probes], { cwd: APP, encoding: 'utf8' });
  if (git.error || git.status === 128) return; // no git / not a checkout: the rule check above still ran
  assert.deepEqual(git.stdout.trim().split(/\r?\n/), probes, 'git must ignore every probe');
});

test('uninstaller asks before deleting user data and never does it on updates', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  const raw = fs.readFileSync(path.join(APP, 'build', 'installer.nsh'));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM, or NSIS garbles the Russian text');
  const nsh = raw.toString('utf8');
  assert.match(nsh, /!macro customUnInstall/);
  assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(nsh, /\$\{ifNot\} \$\{Silent\}/);
  assert.match(nsh, /MB_DEFBUTTON2/, '«No» is the default answer');
  assert.match(nsh, /RMDir \/r "\$APPDATA\\\$\{APP_PACKAGE_NAME\}"/);
});

test('README «Где лежат данные» lists every data file the app writes', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Где лежат данные'));
  require('../lib/storage-status'); // registers every document
  const { listDocs } = require('../lib/storage-doc');
  const files = [...listDocs().map((d) => d.spec.name), 'tokens.json', 'credentials.json', 'backups'];
  for (const name of files) assert.ok(section.includes(`\`${name}`), `README does not mention ${name}`);
});

test('uninstaller removes the autostart entry on a real uninstall (not on updates)', () => {
  const nsh = fs.readFileSync(path.join(APP, 'build', 'installer.nsh'), 'utf8');
  const notification = fs.readFileSync(path.join(APP, 'electron', 'notifications.js'), 'utf8');
  const aumid = /APP_USER_MODEL_ID = '([^']+)'/.exec(notification)[1];
  const body = nsh.slice(nsh.indexOf('${ifNot} ${isUpdated}'));
  for (const key of ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run']) {
    assert.ok(body.includes(`DeleteRegValue HKCU "${key}" "${aumid}"`), key);
  }
  assert.ok(nsh.indexOf('DeleteRegValue') > nsh.indexOf('${ifNot} ${isUpdated}'), 'only inside the not-updated branch');
});
