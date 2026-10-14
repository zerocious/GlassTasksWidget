'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const backup = require('../lib/storage-backup');
const config = require('../lib/config');
const streaks = require('../lib/streak-store');
const settingsStore = require('../lib/settings-store');
const { freshDataRoot, tmpDir } = require('./helpers/storage');

const REFRESH = '1//0gSecretRefreshTokenValue_abcdefghijkl';
const ACCESS = 'ya29.a0SecretAccessToken';
const CLIENT_SECRET = 'GOCSPX-TopSecretClient';

/** A profile with sign-in, keys, habits and settings. */
function populatedProfile() {
  const root = freshDataRoot();
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: REFRESH, access_token: ACCESS });
  config.saveGoogleCredentials({ clientId: '1-a.apps.googleusercontent.com', clientSecret: CLIENT_SECRET });
  settingsStore.saveSettings({ theme: 'light', pos: { x: 5, y: 6 }, hideCompleted: true });
  streaks.markCompleted('habit-1', '2026-10-01');
  streaks.markCompleted('habit-1', '2026-10-02');
  return root;
}

test('export JSON: settings, habit history with titles and logs — never tokens or the client secret', () => {
  populatedProfile();
  const logs = tmpDir('gt-logs-');
  fs.writeFileSync(path.join(logs, 'main.log'), `boot ok\nrefresh ${REFRESH}\n{"access_token":"${ACCESS}"}\nsecret=${CLIENT_SECRET}\n`);
  const out = path.join(tmpDir(), 'export.json');
  const result = backup.exportJson(out, { habitTitles: { 'habit-1': 'Бег' }, logsDir: logs });
  const text = fs.readFileSync(out, 'utf8');
  for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, 'GOCSPX-', 'ya29.']) {
    assert.equal(text.includes(secret), false, `${secret} leaked`);
  }
  const doc = JSON.parse(text);
  assert.equal(doc.format, 'glass-tasks-export');
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(doc.habits['habit-1'], { title: 'Бег', dates: ['2026-10-01', '2026-10-02'] });
  assert.equal(doc.settings.theme, 'light');
  assert.equal('pos' in doc.settings, false, 'window position is machine-specific');
  assert.equal(doc.logs[0].name, 'main.log');
  assert.match(doc.logs[0].text, /boot ok/);
  assert.equal(result.habits, 1);
});

test('redactSecrets catches token shapes and refuses to emit a known secret', () => {
  const text = backup.redactSecrets('{"refresh_token":"abc","client_secret":"xyz"} ya29.QQ 1//0abcdefghijklmnopqrstuvwxyz GOCSPX-1', []);
  assert.equal(text, '{"refresh_token":"[скрыто]","client_secret":"[скрыто]"} [скрыто] [скрыто] [скрыто]');
  assert.equal(backup.redactSecrets('note: plainsecretvalue here', ['plainsecretvalue']), 'note: [скрыто] here');
});

test('CSV: BOM, semicolons, quoting, formula injection neutralised, parent titles', () => {
  const { text, rows } = backup.tasksToCsv({
    tasksListName: 'Tasks',
    habitsListName: 'Habits',
    tasks: [
      { id: 't1', title: 'Купить; молоко', notes: 'строка 1\nстрока "2"', due: '2026-10-14T00:00:00.000Z', dueTime: '18:30', completed: false },
      { id: 't2', title: '=HYPERLINK("http://evil")', parent: 't1', completed: true },
    ],
    habits: [{ id: 'h1', title: 'Бег', completed: true }],
  });
  assert.equal(rows, 3);
  assert.ok(text.startsWith('﻿Список;Название;'));
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines[1], 'Tasks;"Купить; молоко";"строка 1\nстрока ""2""";2026-10-14;18:30;нет;;t1');
  assert.equal(lines[2], `Tasks;"'=HYPERLINK(""http://evil"")";;;;да;"Купить; молоко";t2`);
  assert.equal(lines[3], 'Habits;Бег;;;;да;;h1');
});

test('import: validates the file and rejects anything that is not ours', () => {
  freshDataRoot();
  assert.throws(() => backup.parseImport(''), /пустой/);
  assert.throws(() => backup.parseImport('nope'), /не JSON/);
  assert.throws(() => backup.parseImport('{"habits":{}}'), /не экспорт/);
  assert.throws(() => backup.parseImport('{"format":"glass-tasks-export","schemaVersion":9}'), /более новой версией/);
  assert.throws(() => backup.parseImport('{"format":"glass-tasks-export","habits":[]}'), /habits повреждён/);
  assert.throws(() => backup.parseImport('x'.repeat(backup.MAX_IMPORT_BYTES + 1)), /слишком большой/);
  const parsed = backup.parseImport(
    JSON.stringify({ format: 'glass-tasks-export', habits: { h: { dates: ['2026-10-01', '2026-02-31', 'x'] } } })
  );
  assert.equal(parsed.invalidDates, 2);
  assert.deepEqual(parsed.incoming.habits.h.dates, ['2026-10-01']);
});

test('import merges habit days, applies settings except machine ones, takes a pre-import backup', () => {
  const root = populatedProfile();
  const file = JSON.stringify({
    format: 'glass-tasks-export',
    schemaVersion: 1,
    settings: { theme: 'dark', bgOpacity: 0.4, pos: { x: 999, y: 999 }, onboardingSkipped: true, unknownKey: 1 },
    habits: { 'habit-1': { title: 'Бег', dates: ['2026-09-30', '2026-10-01'] }, 'habit-2': { dates: ['2026-10-05'] } },
  });
  /** @type {object[]} */
  const applied = [];
  const report = backup.importData(file, {
    applySettings: (patch) => {
      applied.push(patch);
      settingsStore.saveSettings(patch);
    },
  });
  assert.equal(report.daysAdded, 2);
  assert.equal(report.habitsUpdated, 2);
  assert.deepEqual(applied[0], { theme: 'dark', bgOpacity: 0.4 });
  assert.deepEqual(settingsStore.loadSettings().pos, { x: 5, y: 6 });
  assert.deepEqual(streaks.loadStore().habits['habit-1'].dates, ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.match(report.backup, /^backup-\d{8}-\d{6}-pre-import\.json$/);
  const pre = JSON.parse(fs.readFileSync(path.join(root, 'backups', report.backup), 'utf8'));
  assert.equal(pre.settings.theme, 'light', 'the backup holds the state before the import');
  // A backup file is itself importable.
  assert.equal(backup.importData(JSON.stringify(pre), { includeSettings: false }).daysAdded, 0);
});

test('weekly backups: one per 7 days, newest N kept, nothing for an empty profile', () => {
  freshDataRoot();
  assert.equal(backup.runScheduledBackup(new Date(2026, 0, 1, 12)), null, 'nothing to back up yet');
  streaks.markCompleted('h', '2026-01-01');
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(2026, 0, 1, 12).getTime();
  assert.ok(backup.runScheduledBackup(new Date(start)));
  assert.equal(backup.runScheduledBackup(new Date(start + 3 * day)), null, 'too soon');
  for (let week = 1; week <= 11; week += 1) {
    assert.ok(backup.runScheduledBackup(new Date(start + week * 7 * day)), `week ${week}`);
  }
  const weekly = backup.listBackups().filter((b) => b.reason === 'weekly');
  assert.equal(weekly.length, backup.BACKUP_KEEP.weekly);
  assert.equal(new Date(weekly[0].createdAt).getTime(), start + 11 * 7 * day, 'newest first');
  const text = fs.readFileSync(weekly[0].path, 'utf8');
  assert.equal(JSON.parse(text).format, 'glass-tasks-backup');
});

test('backups never contain secrets or task content', () => {
  const root = populatedProfile();
  require('../lib/offline-cache').saveOfflineCache({ mode: 'google', tasks: [{ id: 't', title: 'Личная задача' }], habits: [] });
  const created = backup.createBackup({ reason: 'manual' });
  const text = fs.readFileSync(created.path, 'utf8');
  for (const s of [REFRESH, ACCESS, CLIENT_SECRET, 'Личная задача']) assert.equal(text.includes(s), false);
  assert.ok(created.path.startsWith(path.join(root, 'backups')));
});

test('import ignores prototype keys and odd habit ids', () => {
  freshDataRoot();
  const parsed = backup.parseImport(
    '{"format":"glass-tasks-export","habits":{"__proto__":{"dates":["2026-10-01"]},"constructor":{"dates":["2026-10-01"]},"bad id":{"dates":["2026-10-01"]},"ok-id":{"dates":["2026-10-01"]}}}'
  );
  assert.deepEqual(Object.keys(parsed.incoming.habits), ['ok-id']);
  assert.equal({}.dates, undefined, 'Object.prototype untouched');
  const many = { format: 'glass-tasks-export', habits: {} };
  for (let i = 0; i <= 5000; i += 1) many.habits[`h${i}`] = { dates: [] };
  assert.throws(() => backup.parseImport(JSON.stringify(many)), /слишком много привычек/);
});
