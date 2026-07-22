/**
 * One-shot Windows toast smoke test (same AUMID as the app).
 * Usage: npx electron scripts/test-toast.js
 *
 * Does not rewrite Desktop/Start Menu shortcuts (avoids pointing them at
 * electron.exe after a packaged build). Shortcut AUMID is managed by
 * ensureWindowsNotificationShortcut / npm run shortcut.
 */
const { app, Notification } = require('electron');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';

app.setAppUserModelId(APP_USER_MODEL_ID);

app.whenReady().then(async () => {
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
    timeoutType: 'default',
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
