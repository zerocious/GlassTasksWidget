/**
 * One-shot Windows toast smoke test (same AUMID as the app).
 * Usage: npx electron scripts/test-toast.js
 */
const { app, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';

app.setAppUserModelId(APP_USER_MODEL_ID);

app.whenReady().then(async () => {
  // Ensure Start Menu shortcut with AUMID (same as main process)
  try {
    const startMenuDir = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    );
    fs.mkdirSync(startMenuDir, { recursive: true });
    const appRoot = path.resolve(__dirname, '..');
    const startMenuLnk = path.join(startMenuDir, 'Glass Tasks Widget.lnk');
    const details = {
      target: process.execPath,
      cwd: appRoot,
      args: `"${appRoot}"`,
      appUserModelId: APP_USER_MODEL_ID,
      description: 'Glass Tasks Widget',
      icon: process.execPath,
      iconIndex: 0,
    };
    shell.writeShortcutLink(
      startMenuLnk,
      fs.existsSync(startMenuLnk) ? 'update' : 'create',
      details
    );
  } catch (e) {
    console.warn('shortcut warn', e.message);
  }

  const supported = Notification.isSupported();
  console.log(JSON.stringify({ notificationsSupported: supported, aumid: APP_USER_MODEL_ID }));

  if (!supported) {
    console.error('Notification.isSupported() === false');
    app.exit(2);
    return;
  }

  const n = new Notification({
    title: 'Glass Tasks — тест',
    body: 'Проверка Windows toast (com.glasstasks.widget)',
    silent: false,
  });

  let settled = false;
  const done = (ok, detail) => {
    if (settled) return;
    settled = true;
    console.log(JSON.stringify({ shown: ok, detail: detail || null }));
    setTimeout(() => app.exit(ok ? 0 : 1), 800);
  };

  n.on('show', () => done(true, 'show'));
  n.on('failed', (_e, error) => done(false, String(error || 'failed')));
  setTimeout(() => {
    if (!settled) done(true, 'timeout-no-event');
  }, 4000);

  n.show();
});
