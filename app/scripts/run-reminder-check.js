/**
 * Force-run the same reminder toast path as IPC widget:check-reminders.
 * Usage: npx electron scripts/run-reminder-check.js
 */
const { app, Notification } = require('electron');
const { execSync } = require('child_process');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';
app.setAppUserModelId(APP_USER_MODEL_ID);

function windowsToastsGloballyEnabled() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications" /v ToastEnabled',
      { encoding: 'utf8' }
    );
    const m = out.match(/ToastEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    if (!m) return true;
    return parseInt(m[1], 16) !== 0;
  } catch {
    return true;
  }
}

app.whenReady().then(async () => {
  const { loadSettings } = require('../lib/settings-store');
  const { getWidgetData } = require('../lib/google-tasks');
  const { loadReminderState, markNotified } = require('../lib/reminder-store');
  const { collectReminderCandidates, formatReminderToast } = require('../electron/reminders');
  const { ensureWindowsNotificationShortcut } = require('../electron/notifications');

  // Start Menu shortcut with the AUMID, same as main: a dev run like this one only creates a
  // missing link and never repoints the installed widget's link at node_modules\electron.
  ensureWindowsNotificationShortcut();

  const settings = loadSettings();
  const toastOs = windowsToastsGloballyEnabled();
  const supported = Notification.isSupported();

  console.log(
    JSON.stringify({
      remindersEnabled: settings.remindersEnabled !== false,
      notificationsSupported: supported,
      windowsToastEnabled: toastOs,
      aumid: APP_USER_MODEL_ID,
    })
  );

  if (settings.remindersEnabled === false) {
    console.log(JSON.stringify({ ok: false, reason: 'disabled' }));
    app.exit(3);
    return;
  }
  if (!supported) {
    console.log(JSON.stringify({ ok: false, reason: 'unsupported' }));
    app.exit(2);
    return;
  }
  if (!toastOs) {
    console.log(
      JSON.stringify({
        ok: false,
        reason: 'os-disabled',
        message: 'Windows ToastEnabled=0 — включите уведомления в Параметры Windows.',
      })
    );
    app.exit(4);
    return;
  }

  const data = await getWidgetData();
  // The same items the widget's sweep would pick.
  const candidates = collectReminderCandidates(data);

  // force: true — same as widget:check-reminders
  const fresh = candidates;
  const state = loadReminderState();
  console.log(
    JSON.stringify({
      candidateCount: candidates.length,
      alreadyNotifiedToday: state.notifiedIds?.length || 0,
      force: true,
    })
  );

  if (!fresh.length) {
    console.log(JSON.stringify({ ok: true, shown: false, reason: 'empty', count: 0 }));
    app.exit(0);
    return;
  }

  const { title, body } = formatReminderToast(fresh);

  const n = new Notification({ title, body, silent: false });
  await new Promise((resolve) => {
    let settled = false;
    const done = (shown, detail) => {
      if (settled) return;
      settled = true;
      if (shown) markNotified(fresh.map((c) => c.id));
      console.log(JSON.stringify({ ok: shown, shown, count: fresh.length, detail, title, body }));
      resolve(shown);
    };
    n.on('show', () => done(true, 'show'));
    n.on('failed', (_e, error) => done(false, String(error || 'failed')));
    setTimeout(() => {
      if (!settled) done(true, 'timeout-no-event');
    }, 4000);
    n.show();
  }).then((ok) => {
    setTimeout(() => app.exit(ok ? 0 : 1), 500);
  });
});
