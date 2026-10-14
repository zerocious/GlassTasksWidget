'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogger, captureConsole, redact } = require('../lib/logger');
const { formatDiagnostics } = require('../lib/diagnostics');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gt-log-'));

test('redact removes Google tokens, secrets, auth codes and the Windows user name', () => {
  const samples = [
    ['token ya29.a0AfH6SMBx-abc_DEF.123 end', /ya29/],
    ['rt 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-12345 end', /1\/\/0gAb/],
    ['secret GOCSPX-abcDEF_123-xyz', /GOCSPX/],
    ['Authorization: Bearer abc.def-ghi_jkl', /abc\.def/],
    ['{"refresh_token":"1//secretvalue","access_token": "x"}', /secretvalue/],
    ['GET /oauth2callback?code=4/0AVHEtk&state=abc123&scope=x', /4\/0AVHEtk|abc123/],
    ['read C:\\Users\\Ivan\\AppData\\Roaming\\glass-tasks-widget\\data', /Ivan/],
    ['jwt eyJhbGciOiJSUzI1NiIsInR5cCI6.eyJzdWIiOiIxMjM0NTY3ODkwIiwi.SflKxwRJSMeKKF2QT4', /eyJhbGci/],
  ];
  for (const [input, leaked] of samples) {
    const out = redact(input);
    assert.doesNotMatch(out, leaked, `leaked from: ${input}\n  -> ${out}`);
  }
  assert.match(redact('open C:\\Users\\Ivan\\x'), /C:\\Users\\<user>\\x/);
  assert.equal(redact('plain message about tasks'), 'plain message about tasks');
});

test('logger writes timestamped, redacted lines and survives a missing directory', () => {
  const dir = path.join(tmp(), 'nested', 'logs');
  const log = createLogger({ dir, now: () => new Date('2026-10-14T10:00:00Z') });
  log.write('warn', ['sign-in failed', { access_token: 'ya29.secret' }]);
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /^2026-10-14T10:00:00\.000Z WARN {2}sign-in failed/);
  assert.doesNotMatch(text, /ya29\.secret/);
});

test('logger rotates at the size limit and keeps only N files', () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 300, keep: 3 });
  for (let i = 0; i < 40; i += 1) log.write('info', [`line ${i} ${'x'.repeat(40)}`]);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['main.1.log', 'main.2.log', 'main.log']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 400, f);
  const tail = log.tail(5).split('\n');
  assert.equal(tail.length, 5);
  assert.match(tail[tail.length - 1], /line 39 /);
});

test('very long lines are truncated and multi-line text stays one record', () => {
  const dir = tmp();
  const log = createLogger({ dir });
  log.write('error', ['y'.repeat(10000)]);
  log.write('error', ['first\nsecond']);
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /more chars\]/);
  assert.match(text, /first\n {4}second/);
});

test('captureConsole mirrors console output into the log and can be undone', () => {
  const dir = tmp();
  const log = createLogger({ dir });
  const seen = [];
  const fake = { log: (...a) => seen.push(a), info: () => {}, warn: (...a) => seen.push(a), error: () => {} };
  const restore = captureConsole(log, fake);
  fake.warn('[auth] port busy', 1234);
  assert.deepEqual(seen, [['[auth] port busy', 1234]]);
  assert.match(fs.readFileSync(log.file, 'utf8'), /WARN {2}\[auth\] port busy 1234/);
  restore();
  fake.warn('after');
  assert.doesNotMatch(fs.readFileSync(log.file, 'utf8'), /after/);
});

test('diagnostics report has the essentials and no secrets or private settings', () => {
  const report = formatDiagnostics(
    {
      app: { name: 'Glass Tasks Widget', version: '1.2.3', packaged: true },
      versions: { electron: '33.2.0', chrome: '130', node: '20' },
      os: 'Windows 10 Pro 10.0.19045',
      auth: { credentialsConfigured: true, signedIn: true, clientId: '1234567890-abc.apps.googleusercontent.com', pinnedPort: null },
      settings: { theme: 'dark', pos: { x: 1, y: 2 }, accentColor: '#fff', toggleHotkey: 'Control+Alt+W' },
      dataDir: 'C:\\Users\\Ivan\\AppData\\Roaming\\glass-tasks-widget\\data',
    },
    '2026-10-14T10:00:00Z ERROR token ya29.leak'
  );
  assert.match(report, /Glass Tasks Widget 1\.2\.3/);
  assert.match(report, /Electron 33\.2\.0/);
  assert.match(report, /вход выполнен: да/);
  assert.match(report, /клиент: 1234567890…/);
  assert.match(report, /"theme":"dark"/);
  assert.doesNotMatch(report, /"pos"|accentColor/);
  assert.doesNotMatch(report, /Ivan|ya29\.leak|abc\.apps/);
});
