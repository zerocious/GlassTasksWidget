'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const config = require('../lib/config');
const auth = require('../lib/google-auth');
const settings = require('../lib/settings-store');
const streaks = require('../lib/streak-store');
const mock = require('../lib/mock-data');
const backup = require('../lib/storage-backup');
const { getStorageEvents } = require('../lib/storage-status');
const { fakeSafeStorage, useTempDataRoot, write, exists } = require('./helpers/tmp-data');

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-super-secret-value';
const REFRESH = '1//0gRefreshTokenValue-abcdefghijklmnop';
const ACCESS = 'ya29.AccessTokenValue-123456';

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
});
test.afterEach(() => env.cleanup());

function seedSecrets() {
  config.setSafeStorageForTests(fakeSafeStorage);
  config.saveGoogleCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  auth._test.saveTokens({ refresh_token: REFRESH, access_token: ACCESS, id_token: 'eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl' });
}

function seedData() {
  settings.saveSettings({ theme: 'light', bgOpacity: 0.5, toggleHotkey: 'Control+Alt+Q', pos: { x: 5, y: 6 } });
  streaks.markCompleted('h1', '2026-03-01');
  streaks.markCompleted('h1', '2026-03-02');
  streaks.markCompleted('h2', '2026-03-05');
}

const kinds = () => getStorageEvents().map((e) => e.kind);

// ---- item 6: bundles never carry secrets ---------------------------------------------------------

test('a bundle contains settings and habit history but never tokens or the client secret', () => {
  seedSecrets();
  seedData();
  const text = backup.serializeBundle(backup.buildBundle({ kind: 'export', appVersion: '1.2.3' }));
  for (const secret of [CLIENT_SECRET, REFRESH, ACCESS, 'eyJhbGciOi', CLIENT_ID]) {
    assert.equal(text.includes(secret), false, `bundle leaks ${secret}`);
  }
  assert.equal(/refresh_token|clientSecret|client_secret|access_token/i.test(text), false);
  const bundle = JSON.parse(text);
  assert.equal(bundle.app, 'glass-tasks-widget');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.settings.theme, 'light');
  assert.deepEqual(bundle.streaks.habits.h1.dates, ['2026-03-01', '2026-03-02']);
  assert.equal('demo' in bundle, false, 'no demo lists for a user who never used demo mode');
  assert.equal(exists(env.dir, 'mock-items.json'), false, 'exporting must not create the demo file');
});

test('the secret guard refuses text that contains a secret in use', () => {
  seedSecrets();
  const bundle = backup.buildBundle();
  bundle.settings.accentColor = REFRESH; // doctored
  assert.throws(() => backup.serializeBundle(bundle), /секрет/);
  assert.throws(() => backup.assertNoSecrets(`x ${CLIENT_SECRET} y`), /секрет/);
  assert.doesNotThrow(() => backup.assertNoSecrets('harmless text'));
});

test('demo lists are exported only after demo mode created them', () => {
  mock.loadMockStore();
  const bundle = backup.buildBundle();
  assert.ok(Array.isArray(bundle.demo.tasks) && bundle.demo.tasks.length > 0);
});

test('logs are optional, truncated to a tail and redacted', () => {
  seedSecrets();
  const logs = path.join(env.dir, 'logs');
  write(env.dir, 'logs/app.log', `${'x'.repeat(300 * 1024)}\nrefresh_token=${REFRESH}\nBearer ${ACCESS}\nsecret ${CLIENT_SECRET}\nlast line`);
  write(env.dir, 'logs/notes.txt', 'ignored');
  assert.equal('logs' in backup.buildBundle(), false);
  const bundle = backup.buildBundle({ logsDir: logs });
  assert.equal(bundle.logs.length, 1);
  assert.equal(bundle.logs[0].name, 'app.log');
  assert.ok(bundle.logs[0].tail.length <= 100 * 1024 + 50);
  assert.ok(bundle.logs[0].tail.endsWith('last line'));
  const text = backup.serializeBundle(bundle);
  for (const secret of [CLIENT_SECRET, REFRESH, ACCESS]) assert.equal(text.includes(secret), false);
  assert.equal(backup.collectLogTails(path.join(env.dir, 'no-such-dir')).length, 0);
});

test('redactSecrets catches token shapes even when the value is not a known secret', () => {
  const out = backup.redactSecrets(
    'a ya29.abcDEF_123 b 1//0gAbCdEfGhIjKlMnOpQrStUv c GOCSPX-abcDEF_12 d "refresh_token":"abcdef123456" e',
    []
  );
  assert.equal(/ya29|1\/\/0g|GOCSPX|abcdef123456/.test(out), false);
});

// ---- validation of imported files ---------------------------------------------------------------

test('parseBundle accepts a valid export (also with a BOM) and summarizes it', () => {
  seedData();
  const text = backup.serializeBundle(backup.buildBundle({ appVersion: '9.9.9' }));
  const { summary } = backup.parseBundle(`\uFEFF${text}`);
  assert.equal(summary.habits, 2);
  assert.equal(summary.dates, 3);
  assert.equal(summary.hasSettings, true);
  assert.equal(summary.appVersion, '9.9.9');
});

test('parseBundle rejects anything that is not a Glass Tasks export', () => {
  const bad = (text, re) => assert.throws(() => backup.parseBundle(text), re);
  bad('', /пустой/);
  bad('   ', /пустой/);
  bad('{not json', /JSON/);
  bad('[]', /не файл экспорта/);
  bad(JSON.stringify({ app: 'other', schemaVersion: 1 }), /не файл экспорта/);
  bad(JSON.stringify({ app: 'glass-tasks-widget' }), /версии/);
  bad(JSON.stringify({ app: 'glass-tasks-widget', schemaVersion: 99, streaks: {} }), /новой версией/);
  bad(JSON.stringify({ app: 'glass-tasks-widget', schemaVersion: 1 }), /нет данных/);
  bad(JSON.stringify({ app: 'glass-tasks-widget', schemaVersion: 1, streaks: { habits: { '__proto__x y': { dates: ['x'] } } } }), /нет данных/);
  bad('x'.repeat(backup.MAX_IMPORT_BYTES + 1), /большой/);
});

// ---- import / merge --------------------------------------------------------------------------------

test('import merges habit dates, applies only portable settings, and takes a pre-import backup', () => {
  seedData();
  const text = backup.serializeBundle(backup.buildBundle());
  // a different machine with other data
  env.cleanup();
  env = useTempDataRoot();
  settings.saveSettings({ theme: 'dark', toggleHotkey: 'Control+Alt+Z', pos: { x: 99, y: 99 } });
  streaks.markCompleted('h1', '2026-03-03');
  streaks.markCompleted('h3', '2026-04-01');

  const result = backup.applyBundle(backup.parseBundle(text), { appVersion: '1' });
  assert.equal(result.settingsApplied, true);
  assert.deepEqual(result.streaks, { habitsAdded: 1, habitsUpdated: 1, datesAdded: 3, rejected: 0 });
  assert.deepEqual(streaks.getHabitStats('h1').completedDates, ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.deepEqual(streaks.getHabitStats('h3').completedDates, ['2026-04-01'], 'local-only habit survives');
  assert.deepEqual(streaks.getHabitStats('h2').completedDates, ['2026-03-05']);

  const s = settings.loadSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.bgOpacity, 0.5);
  assert.equal(s.toggleHotkey, 'Control+Alt+Z', 'hotkeys are machine specific');
  assert.deepEqual(s.pos, { x: 99, y: 99 }, 'window position is machine specific');

  assert.match(result.backup, /^pre-import-/);
  const pre = JSON.parse(backup.readBackupText(result.backup));
  assert.deepEqual(pre.streaks.habits.h1.dates, ['2026-03-03'], 'the backup holds the state BEFORE the import');
  assert.ok(kinds().includes('imported'));
});

test('importing the same file twice changes nothing the second time', () => {
  seedData();
  const parsed = backup.parseBundle(backup.serializeBundle(backup.buildBundle()));
  backup.applyBundle(parsed);
  const second = backup.applyBundle(parsed);
  assert.deepEqual(second.streaks, { habitsAdded: 0, habitsUpdated: 0, datesAdded: 0, rejected: 0 });
});

test('import can be limited to some sections', () => {
  seedData();
  const parsed = backup.parseBundle(backup.serializeBundle(backup.buildBundle()));
  env.cleanup();
  env = useTempDataRoot();
  const result = backup.applyBundle(parsed, { settings: false });
  assert.equal(result.settingsApplied, false);
  assert.equal(settings.loadSettings().theme, 'dark');
  assert.deepEqual(streaks.getHabitStats('h1').completedDates.length, 2);
});

test('a hostile file cannot inject unknown settings or prototype keys', () => {
  const hostile = JSON.parse(
    '{"app":"glass-tasks-widget","schemaVersion":1,"settings":{"theme":"light","__proto__":{"polluted":1},"toggleHotkey":"x","evil":"<script>"},"streaks":{"habits":{"__proto__":{"dates":["2026-01-01"]},"ok":{"dates":["2026-01-02"]}}}}'
  );
  const result = backup.applyBundle(backup.parseBundle(JSON.stringify(hostile)));
  assert.equal(({}).polluted, undefined);
  assert.equal(result.streaks.habitsAdded, 1);
  assert.equal(result.streaks.rejected, 1);
  assert.equal('evil' in settings.loadSettings(), false);
});

test('if the pre-import backup cannot be written, nothing is imported', () => {
  seedData();
  const parsed = backup.parseBundle(backup.serializeBundle(backup.buildBundle()));
  env.cleanup();
  env = useTempDataRoot();
  write(env.dir, 'backups', 'a file where the backups folder should be');
  assert.throws(() => backup.applyBundle(parsed));
  assert.equal(exists(env.dir, 'streaks.json'), false);
  assert.ok(kinds().includes('backup-failed'));
});

test('export from one profile and import into a fresh one reproduces the history', () => {
  seedData();
  for (let i = 1; i <= 20; i += 1) streaks.markCompleted('long', `2026-02-${String(i).padStart(2, '0')}`);
  const before = streaks.exportHistory();
  const text = backup.serializeBundle(backup.buildBundle());
  env.cleanup();
  env = useTempDataRoot();
  backup.applyBundle(backup.parseBundle(text));
  streaks.resetStreakCache();
  assert.deepEqual(streaks.exportHistory(), before);
});

// ---- weekly backups -------------------------------------------------------------------------------

const day = (iso) => new Date(`${iso}T10:00:00`);

test('weekly backup: created when due, skipped when recent, pruned to the newest 8', () => {
  seedData();
  assert.deepEqual(backup.ensureWeeklyBackup({ now: day('2026-03-10') }), { created: true, name: 'weekly-2026-03-10.json' });
  assert.deepEqual(backup.ensureWeeklyBackup({ now: day('2026-03-16') }), { created: false, reason: 'recent' });
  assert.equal(backup.ensureWeeklyBackup({ now: day('2026-03-17') }).created, true, 'exactly 7 days later');
  for (let i = 1; i <= 12; i += 1) {
    const d = new Date(day('2026-03-17').getTime() + i * 7 * 86400000);
    backup.ensureWeeklyBackup({ now: d });
  }
  const weekly = backup.listBackups().filter((b) => b.kind === 'weekly');
  assert.equal(weekly.length, backup.BACKUP_KEEP.weekly);
  assert.equal(weekly[0].date > weekly[weekly.length - 1].date, true, 'newest first, oldest pruned');
});

test('weekly backup: a fresh install with no data creates nothing', () => {
  assert.deepEqual(backup.ensureWeeklyBackup({ now: day('2026-03-10') }), { created: false, reason: 'no-data' });
  assert.equal(exists(env.dir, 'backups'), false);
});

test('weekly backup never throws: a failure is reported instead', () => {
  seedData();
  write(env.dir, 'backups', 'blocker');
  assert.deepEqual(backup.ensureWeeklyBackup({ now: day('2026-03-10') }), { created: false, reason: 'failed' });
  assert.ok(kinds().includes('backup-failed'));
});

test('backup files hold no secrets and are valid bundles', () => {
  seedSecrets();
  seedData();
  const { name } = backup.createBackup({ kind: 'manual' });
  const text = backup.readBackupText(name);
  assert.equal(text.includes(CLIENT_SECRET) || text.includes(REFRESH), false);
  assert.equal(backup.parseBundle(text).summary.habits, 2);
});

test('listBackups ignores foreign files; readBackupText only reads our own backup names', () => {
  seedData();
  backup.createBackup({ kind: 'manual' });
  write(env.dir, 'backups/notes.txt', 'x');
  write(env.dir, 'backups/weekly-2026-01-01.json.tmp', 'x');
  assert.equal(backup.listBackups().length, 1);
  for (const evil of ['../streaks.json', '..\\settings.json', '/etc/passwd', 'weekly-2026-01-01.json/../../x', '', null, undefined, 5]) {
    assert.throws(() => backup.readBackupText(evil), /Неизвестная/);
  }
  assert.throws(() => backup.readBackupText('weekly-2020-01-01.json'), /не найдена/);
});

// ---- CSV ---------------------------------------------------------------------------------------------

test('CSV export: BOM, CRLF, quoting, and spreadsheet formulas are neutralised', () => {
  const csv = backup.tasksToCsv({
    tasks: [
      { id: 't1', title: 'Plain', notes: 'line1\nline2', due: '2026-03-01T00:00:00.000Z', completed: false, parent: null },
      { id: 't2', title: '=HYPERLINK("http://evil","x")', notes: 'say "hi", ok', due: null, completed: true, parent: 't1' },
      { id: 't3', title: '+1 call', notes: '@home', due: null, completed: false },
      null,
    ],
    habits: [{ id: 'h1', title: 'Meditate', completed: true }],
  });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'list,title,status,due,notes,id,parent_id');
  assert.equal(lines[1], 'tasks,Plain,needsAction,2026-03-01T00:00:00.000Z,"line1\nline2",t1,');
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"",""x"")"'));
  assert.ok(csv.includes('"say ""hi"", ok"'));
  assert.ok(csv.includes("tasks,'+1 call,needsAction,,'@home,t3,"));
  assert.ok(csv.includes('habits,Meditate,completed,,,h1,'));
  assert.equal(csv.endsWith('\r\n'), true);
  assert.equal(backup.tasksToCsv({}).slice(1), 'list,title,status,due,notes,id,parent_id\r\n');
  assert.equal(backup.tasksToCsv(null).slice(1), 'list,title,status,due,notes,id,parent_id\r\n');
});
