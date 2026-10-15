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
  const result = backup.exportJson(out, { habitTitles: { 'habit-1': 'Бег' }, logsDir: logs, includeLogs: true });
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

test('import never changes autostart or global hotkeys, with or without applySettings', () => {
  freshDataRoot();
  settingsStore.saveSettings({ theme: 'dark', autostart: false });
  const file = JSON.stringify({
    format: 'glass-tasks-export',
    settings: { theme: 'light', autostart: true, toggleHotkey: 'Alt+Q', switchViewHotkey: 'Control+V' },
  });
  const viaMain = [];
  const report = backup.importData(file, { applySettings: (p) => viaMain.push(p) });
  assert.deepEqual(report.settingsApplied, ['theme']);
  assert.deepEqual(viaMain, [{ theme: 'light' }]);
  backup.importData(file); // default path: saveSettings directly
  const s = settingsStore.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.autostart, false);
  assert.equal(s.toggleHotkey, settingsStore.DEFAULT_TOGGLE_HOTKEY);
  assert.equal(s.switchViewHotkey, settingsStore.DEFAULT_SWITCH_HOTKEY);
});

test('hostile import cannot blow up the history: future days dropped, totals capped, createdAt checked', () => {
  freshDataRoot();
  const months = {};
  for (let y = 2027; y < 2200; y += 1) for (let m = 1; m <= 12; m += 1) months[`${y}-${String(m).padStart(2, '0')}`] = 0x7fffffff;
  const habits = {};
  for (let i = 0; i < 50; i += 1) habits[`h${i}`] = { months };
  const started = process.hrtime.bigint();
  const report = backup.importData(JSON.stringify({ format: 'glass-tasks-export', createdAt: 'x'.repeat(1000), habits }), {
    today: '2026-10-14',
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(report.daysAdded, 0, 'nothing from the future');
  assert.equal(report.createdAt, null, 'unexpected createdAt is not echoed back');
  assert.ok(ms < 3000, `import took ${ms} ms`);

  const many = {};
  const day = (i) => new Date(Date.UTC(2017, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  const dates = Array.from({ length: 3000 }, (_, i) => day(i));
  for (let i = 0; i < 400; i += 1) many[`m${i}`] = { dates };
  assert.throws(
    () => backup.importData(JSON.stringify({ format: 'glass-tasks-export', habits: many }), { today: '2026-10-14' }),
    /слишком много отметок/
  );
});

test('CSV: formula starts are neutralised wherever Excel could begin a field or row', () => {
  const cell = backup.csvCell;
  // Split on «,» (en-US list separator), «;», tab, or a newline inside a quoted value.
  assert.equal(cell('Invoice 42,=HYPERLINK("x"),see'), `"Invoice 42,'=HYPERLINK(""x""),see"`);
  assert.equal(cell('agenda\n=1+1,'), `"agenda\n'=1+1,"`);
  assert.equal(cell('a;  +cmd|calc'), `"a;  '+cmd|calc"`);
  assert.equal(cell('x\t@SUM(1)'), `"x\t'@SUM(1)"`);
  assert.equal(cell('-2+3'), `'-2+3`);
  assert.equal(cell('price - 5'), 'price - 5', 'operators mid-text are fine');
  assert.equal(cell('e-mail, re: x'), '"e-mail, re: x"');
  assert.equal(cell('a,"=1+1'), `"a,""'=1+1"`, 'a quote before the formula does not help it');
  // Every field Excel could see after splitting on «,» starts safely.
  const line = backup.tasksToCsv({ tasks: [{ id: 't', title: 'a,=1,+2,-3,@4' }] }).text.split('\r\n')[1];
  for (const field of line.split(',')) assert.doesNotMatch(field.replace(/^"/, ''), /^\s*[=+\-@]/, field);
});

test('redactSecrets: encoded, truncated and JWT/Bearer/code forms are removed too', () => {
  const live = '1//0gLiveRefreshTokenValue_abcdefghij';
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6Iml2YW5AZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  const input = [
    `revoke?token=${encodeURIComponent(live)}`,
    `body refresh_token=${encodeURIComponent(live)}&x=1`,
    `id_token ${jwt}`,
    'Authorization: Bearer ya29.a0AfH6SMBx',
    'Authorization: Bearer abc.def-ghi_jkl',
    'code=4/0AY0e-g7abcdefghijklmnop&scope=x',
    "{ refresh_token: 'not-a-1slash-token-value' }",
    `tail cut: ${live.slice(9)}`, // log tail started inside the token
  ].join('\n');
  const out = backup.redactSecrets(input, [live]);
  for (const leak of [live, encodeURIComponent(live), live.slice(9), jwt, 'a0AfH6SMBx', 'abc.def-ghi_jkl', '4/0AY0e', 'not-a-1slash']) {
    assert.equal(out.includes(leak), false, `${leak} survived:\n${out}`);
  }
  assert.match(out, /x=1/, 'harmless text stays');
});

test('export log tails start at a line boundary', () => {
  freshDataRoot();
  const logs = tmpDir('gt-logs-');
  const line = 'x'.repeat(100);
  fs.writeFileSync(path.join(logs, 'main.log'), `${line}\n`.repeat(20_000)); // ~2 MB > 1 MB budget
  const out = path.join(tmpDir(), 'e.json');
  backup.exportJson(out, { logsDir: logs, includeLogs: true });
  const text = JSON.parse(fs.readFileSync(out, 'utf8')).logs[0].text;
  assert.ok(text.startsWith(line), 'no partial first line');
});

test('import stops decoding as soon as the day cap is exceeded (bounded work and memory)', () => {
  freshDataRoot();
  const months = {};
  for (let i = 0; i < 119; i += 1) {
    const d = new Date(2026, 9 - i, 1);
    months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = 0x7fffffff;
  }
  const habits = {};
  for (let i = 0; i < 500; i += 1) habits[`h${i}`] = { months };
  const started = process.hrtime.bigint();
  const today = { today: '2026-10-14' };
  assert.throws(() => backup.parseImport(JSON.stringify({ format: 'glass-tasks-export', habits }), today), /слишком много отметок/);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1500, `took ${ms} ms`);
  habits.h500 = { months };
  assert.throws(() => backup.parseImport(JSON.stringify({ format: 'glass-tasks-export', habits }), today), /слишком много привычек/);
});

test('export includes logs only when asked', () => {
  freshDataRoot();
  const logs = tmpDir('gt-logs-');
  fs.writeFileSync(path.join(logs, 'main.log'), 'line\n');
  const out = path.join(tmpDir(), 'e.json');
  backup.exportJson(out, { logsDir: logs });
  assert.equal('logs' in JSON.parse(fs.readFileSync(out, 'utf8')), false);
  backup.exportJson(out, { logsDir: logs, includeLogs: true });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).logs.length, 1);
});

test('export stays valid, importable JSON and catches tokens at the start of log lines', () => {
  populatedProfile();
  const logs = tmpDir('gt-logs-');
  const stale = '1//0gStaleButValidRefreshTokenXYZabcdef';
  fs.writeFileSync(
    path.join(logs, 'main.log'),
    [
      '{"url":"https://x/revoke?token=abc\\"def","quote":"he said \\"hi\\""}',
      stale, // a whole line that is a token (old, not the live one)
      `\t${'ya29.a0AfStale'}`,
      `${REFRESH.slice(5)} at line start`, // live-token fragment
      'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6InhAeC5jb20ifQ.c2lnbmF0dXJlLXg',
    ].join('\n')
  );
  const out = path.join(tmpDir(), 'export.json');
  backup.exportJson(out, { logsDir: logs, includeLogs: true, habitTitles: { 'habit-1': 'Бег\n"утром"' } });
  const text = fs.readFileSync(out, 'utf8');
  const doc = JSON.parse(text); // must parse
  const logText = doc.logs[0].text;
  for (const leak of [stale, 'ya29.a0AfStale', REFRESH.slice(5), 'eyJhbGciOiJSUzI1NiJ9']) {
    assert.equal(logText.includes(leak), false, leak);
  }
  assert.ok(logText.includes('token=[скрыто]\\"def'), 'an escaped quote after a value is kept');
  assert.ok(logText.includes('he said \\"hi\\"'), 'ordinary text and escapes intact');
  assert.equal(doc.habits['habit-1'].title, 'Бег\n"утром"');
  assert.equal(backup.importData(text, { includeSettings: false }).daysAdded, 0, 'export re-imports');
});

test('CSV keeps the user\'s own text: ?code=, Bearer, refresh_token= in notes are not secrets', () => {
  const notes = 'join https://club.example/join?code=SPRING2026 — explain Bearer auth; refresh_token=docs';
  const { text } = backup.tasksToCsv({ tasks: [{ id: 't', title: 'Клуб', notes }] }, ['GOCSPX-live-secret-value']);
  assert.ok(text.includes('?code=SPRING2026'));
  assert.ok(text.includes('Bearer auth'));
  assert.ok(text.includes('refresh_token=docs'));
  const leaked = backup.tasksToCsv({ tasks: [{ id: 't', title: 'x GOCSPX-live-secret-value' }] }, ['GOCSPX-live-secret-value']).text;
  assert.equal(leaked.includes('GOCSPX-live'), false, 'a real credential is still removed');
});

test('CSV neutralising stays linear on long runs of tabs', () => {
  const started = process.hrtime.bigint();
  backup.csvCell(`${'\t'.repeat(65536)}x`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 100, `${ms} ms`);
  assert.equal(backup.csvCell('\t \t=1'), `"\t \t'=1"`);
});
