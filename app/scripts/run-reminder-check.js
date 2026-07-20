/**
 * Force-run the same reminder toast path as IPC widget:check-reminders.
 * Usage: npx electron scripts/run-reminder-check.js
 */
const { app, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { windowsToastsGloballyEnabled } = require('../lib/windows-toasts');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';
app.setAppUserModelId(APP_USER_MODEL_ID);

app.whenReady().then(async () => {
  const { loadSettings } = require('../lib/settings-store');
  const { getWidgetData, resolveTaskDueAt } = require('../lib/google-tasks');
  const { loadReminderState, markNotified } = require('../lib/reminder-store');

  // Ensure Start Menu shortcut (same as main)
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
    shell.writeShortcutLink(startMenuLnk, fs.existsSync(startMenuLnk) ? 'update' : 'create', {
      target: process.execPath,
      cwd: appRoot,
      args: `"${appRoot}"`,
      appUserModelId: APP_USER_MODEL_ID,
      description: 'Glass Tasks Widget',
      icon: process.execPath,
      iconIndex: 0,
    });
  } catch (e) {
    console.warn('shortcut', e.message);
  }

  const settings = loadSettings();
  const toastOs = windowsToastsGloballyEnabled({ bypassCache: true });
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
  const now = Date.now();
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  /** @type {{ id: string, kind: string, title: string, dueKind?: string, dueTime?: string | null }[]} */
  const candidates = [];
  for (const t of Array.isArray(data?.tasks) ? data.tasks : []) {
    if (!t || t.completed || !t.id) continue;
    const dueAt = resolveTaskDueAt(t);
    if (dueAt) {
      if (dueAt.getTime() > now) continue;
      const dueDay = `${dueAt.getFullYear()}-${String(dueAt.getMonth() + 1).padStart(2, '0')}-${String(dueAt.getDate()).padStart(2, '0')}`;
      if (dueDay > today) continue;
      candidates.push({
        id: `task:${t.id}`,
        kind: 'task',
        title: String(t.title || 'Задача').trim() || 'Задача',
        dueKind: 'overdue',
        dueTime: t.dueTime || null,
      });
      continue;
    }
    if (t.dueKind !== 'today' && t.dueKind !== 'overdue') continue;
    candidates.push({
      id: `task:${t.id}`,
      kind: 'task',
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueKind: t.dueKind,
      dueTime: t.dueTime || null,
    });
  }
  for (const h of Array.isArray(data?.habits) ? data.habits : []) {
    if (!h || h.completed || !h.id) continue;
    candidates.push({
      id: `habit:${h.id}`,
      kind: 'habit',
      title: String(h.title || 'Привычка').trim() || 'Привычка',
    });
  }

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

  const overdue = fresh.filter((i) => i.dueKind === 'overdue');
  const todayItems = fresh.filter((i) => i.dueKind === 'today');
  const habits = fresh.filter((i) => i.kind === 'habit');
  const parts = [];
  if (overdue.length) parts.push(`просрочено: ${overdue.length}`);
  if (todayItems.length) parts.push(`на сегодня: ${todayItems.length}`);
  if (habits.length) parts.push(`привычки: ${habits.length}`);
  const title =
    overdue.length && !todayItems.length && !habits.length
      ? 'Просроченные задачи'
      : habits.length && !overdue.length && !todayItems.length
        ? 'Привычки на сегодня'
        : 'Напоминание Glass Tasks';
  const names = fresh
    .slice(0, 3)
    .map((i) => `${i.title}${i.dueTime ? ` (${i.dueTime})` : ''}`)
    .join(', ');
  const more = fresh.length > 3 ? ` и ещё ${fresh.length - 3}` : '';
  const body = parts.length
    ? `${parts.join(' · ')}. ${names}${more}`
    : `${names}${more}`;

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
