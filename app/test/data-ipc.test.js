'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Loads without Electron (CI skips the binary): electron is required lazily on register.
const { isTrustedSender, WIDGET_PAGE_URL } = require('../electron/data-ipc');
const { readFileCapped } = require('../lib/storage-backup');
const { tmpDir } = require('./helpers/storage');

function fakeWindow() {
  const mainFrame = { url: WIDGET_PAGE_URL };
  return { isDestroyed: () => false, webContents: { mainFrame } };
}

test('only the widget main frame on its own page may call data:* channels', () => {
  assert.equal(WIDGET_PAGE_URL, pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href);
  const win = fakeWindow();
  const ok = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(isTrustedSender(ok, win), true);
  win.webContents.mainFrame.url = `${WIDGET_PAGE_URL}#settings`;
  assert.equal(isTrustedSender(ok, win), true, 'hash routes are the same page');

  assert.equal(isTrustedSender({ sender: {}, senderFrame: win.webContents.mainFrame }, win), false, 'other webContents');
  assert.equal(isTrustedSender({ sender: win.webContents, senderFrame: { url: WIDGET_PAGE_URL } }, win), false, 'subframe');
  assert.equal(isTrustedSender({ sender: win.webContents, senderFrame: null }, win), false, 'frame gone');
  win.webContents.mainFrame.url = 'file:///C:/Users/x/Downloads/evil.html';
  assert.equal(isTrustedSender(ok, win), false, 'navigated away');
  win.webContents.mainFrame.url = `${WIDGET_PAGE_URL}.evil.html`;
  assert.equal(isTrustedSender(ok, win), false, 'prefix match is not enough');
  assert.equal(isTrustedSender(ok, null), false, 'no window');
  win.webContents.mainFrame.url = WIDGET_PAGE_URL.toUpperCase();
  assert.equal(isTrustedSender(ok, win, true), true, 'Windows: case-insensitive path');
  assert.equal(isTrustedSender(ok, win, false), false, 'elsewhere: exact');
});

test('readFileCapped reads the whole file, rejects anything over the cap and non-files', async () => {
  const dir = tmpDir();
  const small = path.join(dir, 'small.json');
  fs.writeFileSync(small, '{"a":1}');
  assert.equal(await readFileCapped(small, 100), '{"a":1}');
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, 'x'.repeat(300_000)); // several chunks
  assert.equal((await readFileCapped(big, 300_000)).length, 300_000);
  await assert.rejects(readFileCapped(big, 299_999), /слишком большой/);
  await assert.rejects(readFileCapped(dir, 100), /не файл/);
});
