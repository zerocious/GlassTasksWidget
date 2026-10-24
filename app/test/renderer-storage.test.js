'use strict';

/** Renderer storage warnings (src/app.js): data:storage-issue / data:storage-status in the banner. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadRendererFunctions, extractFunction } = require('./helpers/renderer');

const issue = (kind, message, extra = {}) => ({
  at: '2026-10-25T09:00:00.000Z',
  kind,
  file: 'settings.json',
  level: 'warning',
  message,
  ...extra,
});

const MEMORY_ONLY = issue(
  'secrets-memory-only',
  'Шифрование Windows (DPAPI) недоступно: ключи и вход Google сохранены только до закрытия виджета. После перезапуска войдите снова.',
  { file: 'tokens.json' }
);
const RESTORED = issue('restored-from-backup', 'Настройки: файл был повреждён и восстановлен из последней хорошей копии.', {
  level: 'error',
});

function bannerHarness(issues) {
  const banners = [];
  const r = loadRendererFunctions(['addStorageNotice', 'dismissStorageNotice', 'loadStorageNotices', 'renderBanner'], {
    storageNotices: [],
    storageIssuesSeen: new Set(),
    state: { mode: 'needs_auth', tasks: [], habits: [] },
    setupAction: () => null,
    syncCredentialsForm: () => {},
    setBanner: (text, action) => banners.push({ text, action }),
    window: { widgetApi: { getStorageStatus: async () => ({ ok: false, issues }) } },
  });
  const shown = () => banners[banners.length - 1];
  return { r, banners, shown };
}

test('warnings from before the window loaded are shown ahead of the sign-in banner', async () => {
  const migrated = issue('migrated', 'Настройки: формат обновлён (схема 1 → 2).', { level: 'info' });
  const { r, shown } = bannerHarness([migrated, MEMORY_ONLY, RESTORED]);
  await r.loadStorageNotices();
  assert.equal(shown().text, `${MEMORY_ONLY.message} (ещё 1)`);
  assert.equal(shown().action.label, 'Понятно');

  r.renderBanner(); // renderAll after a refresh keeps it
  assert.equal(shown().text, `${MEMORY_ONLY.message} (ещё 1)`);

  shown().action.onClick();
  assert.equal(shown().text, RESTORED.message, 'the next one; «migrated» is info only');
  shown().action.onClick();
  assert.equal(shown().text, 'Учётные данные есть — нажмите Google для входа.');
  assert.equal(shown().action, null);
});

test('an issue that arrives live and in the status is shown once; a repeat replaces its text', async () => {
  const { r, shown } = bannerHarness([MEMORY_ONLY]);
  assert.equal(r.addStorageNotice(MEMORY_ONLY), true, 'live data:storage-issue');
  await r.loadStorageNotices();
  assert.equal(r.storageNotices.length, 1);

  const hotkey = (key, at) =>
    issue('hotkey-rejected', `Сочетание «${key}» не принято. Используется «Ctrl+Alt+T».`, { at });
  assert.equal(r.addStorageNotice(hotkey('Win+L', '2026-10-25T09:01:00.000Z')), true);
  assert.equal(r.addStorageNotice(hotkey('F1', '2026-10-25T09:02:00.000Z')), true);
  assert.equal(r.storageNotices.length, 2);
  r.renderBanner();
  shown().action.onClick();
  assert.equal(shown().text, hotkey('F1').message);
});

test('info issues and broken payloads are ignored; a failed status call shows nothing', async () => {
  const { r, banners } = bannerHarness([]);
  assert.equal(r.addStorageNotice(null), false);
  assert.equal(r.addStorageNotice(issue('migrated', 'Формат обновлён.', { level: 'info' })), false);
  assert.equal(r.addStorageNotice(issue('reset-corrupt', '')), false);
  r.window.widgetApi.getStorageStatus = async () => {
    throw new Error("No handler registered for 'data:storage-status'");
  };
  await r.loadStorageNotices();
  assert.deepEqual(banners, []);
});

test('the widget listens for data:storage-issue and reads the status at startup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(src, /widgetApi\.onStorageIssue\(/);
  assert.match(extractFunction('bootstrap'), /loadStorageNotices\(\)/);
  assert.match(extractFunction('renderAll'), /renderBanner\(\)/);
});
