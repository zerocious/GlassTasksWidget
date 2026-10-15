'use strict';

/**
 * data-ipc handlers end to end with a stand-in for the electron module (CI has no Electron
 * binary): sender checks, export options and the «delete all my data» dialogs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { freshDataRoot, tmpDir } = require('./helpers/storage');
const config = require('../lib/config');

const userData = tmpDir('gt-userdata-');
const calls = { handlers: new Map(), dialogs: [], answers: [], opened: [], relaunch: 0, exit: [] };
let saveTarget = '';
const fakeElectron = {
  app: {
    getPath: () => userData,
    relaunch: () => {
      calls.relaunch += 1;
    },
    exit: (code) => calls.exit.push(code),
    on: () => {},
  },
  ipcMain: { handle: (channel, fn) => calls.handlers.set(channel, fn) },
  dialog: {
    showMessageBox: async (_win, opts) => {
      calls.dialogs.push(opts.title);
      return { response: calls.answers.shift() ?? 0 };
    },
    showSaveDialog: async () => ({ canceled: false, filePath: saveTarget }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openExternal: async (url) => calls.opened.push(url),
    openPath: async () => '',
  },
  session: { defaultSession: { clearStorageData: async () => {}, clearCache: async () => {} } },
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron };

const dataIpc = require('../electron/data-ipc');

freshDataRoot();
const mainFrame = { url: dataIpc.WIDGET_PAGE_URL };
const win = { isDestroyed: () => false, webContents: { mainFrame, isLoadingMainFrame: () => false, send: () => {} } };
const patches = [];
dataIpc.registerDataIpc({ getWindow: () => win, applySettingsPatch: (p) => patches.push(p) });
const event = { sender: win.webContents, senderFrame: mainFrame };
const call = (channel, payload) => calls.handlers.get(channel)(event, payload);

test.afterEach(() => config.freezeWrites(false));

test('every data:* channel is registered and refuses other senders', async () => {
  for (const channel of ['data:storage-status', 'data:export-json', 'data:export-tasks-csv', 'data:import-json', 'data:backup-now', 'data:list-backups', 'data:open-folder', 'data:wipe-all']) {
    assert.ok(calls.handlers.has(channel), channel);
  }
  await assert.rejects(calls.handlers.get('data:storage-status')({ sender: {}, senderFrame: mainFrame }), /Unauthorized/);
  await assert.rejects(
    calls.handlers.get('data:storage-status')({ sender: win.webContents, senderFrame: { url: dataIpc.WIDGET_PAGE_URL } }),
    /Unauthorized/
  );
  const status = await call('data:storage-status');
  assert.ok(Array.isArray(status.lines));
});

test('page URLs match whether or not «~ [ ] %», spaces and Cyrillic are escaped', () => {
  const page = path.join(tmpDir(), 'ADMINI~1', 'Programs [x64]', '100%', 'Задачи', 'src', 'index.html');
  const node = pathToFileURL(page).href; // what data-ipc computes
  // What the frame reports: file:///C:/… on Windows (drive letter after a third slash), file:///tmp/… elsewhere.
  const slashed = page.split(path.sep).join('/');
  const chromium = `file://${slashed.startsWith('/') ? '' : '/'}${slashed}`.replace(/ /g, '%20');
  assert.notEqual(chromium, node);
  assert.equal(dataIpc.samePageUrl(chromium, node, false), true);
  assert.equal(dataIpc.samePageUrl(chromium.toUpperCase(), node, true), true, 'Windows: case-insensitive');
  assert.equal(dataIpc.samePageUrl(chromium.replace('index.html', 'evil.html'), node, false), false);
  assert.equal(dataIpc.samePageUrl(`${chromium}.html`, node, false), false);

  // An installed widget on Windows, checked on every OS.
  const installed = 'file:///C:/Users/ADMINI~1/AppData/Local/Programs/Glass%20Tasks%20Widget/resources/app.asar/src/index.html';
  const escaped = 'file:///c:/Users/ADMINI%7E1/AppData/Local/Programs/Glass%20Tasks%20Widget/resources/app.asar/src/index.html';
  assert.equal(dataIpc.samePageUrl(installed, escaped, true), true);
  assert.equal(dataIpc.samePageUrl(installed, escaped, false), false, 'drive letter case matters off Windows');
  assert.equal(dataIpc.samePageUrl(installed.replace('file:///', 'file://'), escaped, true), false, 'host part differs');
  mainFrame.url = `${dataIpc.WIDGET_PAGE_URL}#x`;
  assert.equal(dataIpc.isTrustedSender(event, win), true);
});

test('export includes logs only when the renderer asks for them', async () => {
  freshDataRoot();
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'logs', 'main.log'), 'started\n');
  saveTarget = path.join(tmpDir(), 'export.json');
  assert.equal((await call('data:export-json')).ok, true);
  assert.equal('logs' in JSON.parse(fs.readFileSync(saveTarget, 'utf8')), false);
  await call('data:export-json', { includeLogs: true });
  assert.equal(JSON.parse(fs.readFileSync(saveTarget, 'utf8')).logs.length, 1);
});

test('wipe: cancel does nothing; a failed revoke shows a second dialog with the Google page', async (t) => {
  freshDataRoot();
  calls.answers.push(0); // «Отмена»
  assert.deepEqual(await call('data:wipe-all'), { canceled: true });

  const root = freshDataRoot();
  config.writeSecretJson(path.join(root, 'tokens.json'), { refresh_token: '1//0gLiveRefreshTokenValue_xyz' });
  const { google } = require('googleapis');
  t.mock.method(Object.getPrototypeOf(new google.auth.OAuth2().transporter), 'request', async () => {
    throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' });
  });
  calls.dialogs.length = 0;
  calls.answers.push(1, 0); // «Удалить всё», then «Открыть страницу Google»
  const result = await call('data:wipe-all');
  assert.equal(result.revoke, 'failed');
  assert.equal(result.relaunching, true);
  assert.deepEqual(calls.dialogs, ['Удалить все мои данные', 'Доступ Google не отозван']);
  assert.deepEqual(calls.opened, ['https://myaccount.google.com/permissions']);
  assert.deepEqual(patches.at(-1), { autostart: false });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls.relaunch, 1);
  assert.deepEqual(calls.exit, [0]);
  assert.equal(fs.existsSync(path.join(root, 'tokens.json')), false);
});
