'use strict';

/**
 * Reminders: one-shot timers for timed tasks within 24 h, plus a periodic sweep
 * for today / overdue tasks and open habits.
 */

const { Notification, powerMonitor } = require('electron');
const { getWidgetData, resolveTaskDueAt } = require('../lib/google-tasks');
const { loadSettings } = require('../lib/settings-store');
const { todayIso } = require('../lib/dates');
const {
  loadReminderState,
  wasNotifiedToday,
  clearNotifiedToday,
} = require('../lib/reminder-store');
const { windowsToastsGloballyEnabled, showReminderToast } = require('./notifications');

const REMINDER_INTERVAL_MS = 45 * 60 * 1000;
/** First check soon after launch so toasts are easy to verify; then every 45 min. */
const REMINDER_STARTUP_DELAY_MS = 8 * 1000;
/** Only schedule one-shot timers for due times within this horizon. */
const EXACT_REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Before this local hour the sweep toasts only while someone is at the PC. */
const NIGHT_END_HOUR = 7;
/** «At the PC» = input within this many seconds and the screen not locked. */
const NIGHT_PRESENCE_IDLE_S = 10 * 60;

/** @type {ReturnType<typeof setInterval> | null} */
let reminderInterval = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reminderStartupTimer = null;
let reminderCheckInFlight = false;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const exactReminderTimers = new Map();
/**
 * `task:<id>` of tasks with a toast on the way (a fired exact timer, or a sweep toast being shown).
 * The «already notified» mark is written only once the toast shows, so without this an exact
 * timer and a sweep waiting on the same data load (e.g. after wake) both toast one task.
 * @type {Set<string>}
 */
const toastingIds = new Set();

/** Set by main.js so timers stay quiet while the app is quitting. */
let isQuittingFn = () => false;
function configureReminders({ isQuitting }) {
  if (typeof isQuitting === 'function') isQuittingFn = isQuitting;
}

/**
 * «Already notified» key of an exact-time toast. It names the time, not just the task: the sweep
 * marks `task:<id>` for a date-level toast in the morning, and a time set or moved later that day
 * must still get its own «Пора».
 * @param {string} taskId
 * @param {Date} dueAt
 */
function exactReminderId(taskId, dueAt) {
  return `exact:${taskId}@${dueAt.toISOString()}`;
}

/** @param {Date} d */
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A time at the start of a notes line, in the forms the notes parser reads: the «время 14:30»
 * line the «Время» panel writes, «в 15:00 забрать посылку», a bare «14:30» (never «10.05»).
 */
const LEADING_TIME_RE =
  /^(?:(?:(?:время|time)\s*(?:[:-]\s*)?|(?:в|at)\s+)(\d{1,2})[:.](\d{2})|(\d{1,2}):(\d{2}))\b/i;

/**
 * When a timed reminder is due. A task without a due date counts as timed («сегодня в …») only
 * when its time (the one on the row's chip) starts a notes line: a time mentioned in passing
 * («созвон был в 10:30», «Иоанн 3:16») would otherwise toast «Пора» every day and show up as
 * «просрочено».
 * @param {any} t
 * @returns {Date | null}
 */
function reminderDueAt(t) {
  const dueAt = resolveTaskDueAt(t);
  if (!dueAt || t.due) return dueAt;
  const time = hhmm(dueAt);
  const leading = String(t.notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(LEADING_TIME_RE))
    .some((m) => m && `${(m[1] || m[3]).padStart(2, '0')}:${m[2] || m[4]}` === time);
  return leading ? dueAt : null;
}

/**
 * Collect actionable open items for the periodic sweep toast.
 * Timed tasks still in the future are skipped (exact timers handle them).
 * Timed tasks whose time already passed (today / overdue / notes+today) stay as safety net,
 * unless their exact «Пора» toast already went out (`exactId`).
 * @param {any} data
 * @returns {{ id: string, exactId?: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]}
 */
function collectReminderCandidates(data) {
  /** @type {{ id: string, exactId?: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]} */
  const out = [];
  const now = Date.now();
  const today = todayIso();
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  for (const t of tasks) {
    if (!t || t.completed || !t.id) continue;
    const dueAt = reminderDueAt(t);
    if (dueAt) {
      if (dueAt.getTime() > now) continue; // exact timer pending
      // Past timed: only if due calendar day is today or earlier (notes-only → today).
      if (todayIso(dueAt) > today) continue;
      out.push({
        id: `task:${t.id}`,
        exactId: exactReminderId(t.id, dueAt),
        kind: 'task',
        title: String(t.title || 'Задача').trim() || 'Задача',
        dueKind: 'overdue',
        dueTime: t.dueTime || null,
      });
      continue;
    }
    if (t.dueKind !== 'today' && t.dueKind !== 'overdue') continue;
    out.push({
      id: `task:${t.id}`,
      kind: 'task',
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueKind: t.dueKind,
      dueTime: t.dueTime || null,
    });
  }
  const habits = Array.isArray(data?.habits) ? data.habits : [];
  for (const h of habits) {
    if (!h || h.completed || !h.id) continue;
    out.push({
      id: `habit:${h.id}`,
      kind: 'habit',
      title: String(h.title || 'Привычка').trim() || 'Привычка',
    });
  }
  return out;
}

/**
 * The «already notified» set starts empty at midnight, so a sweep at 00:15 on a PC left on
 * overnight (interval, maintenance wake, a night restart) would toast every habit and today task
 * to an empty room and use them up for the whole day. At night the sweep waits for the user.
 * @returns {boolean}
 */
function sweepWaitsForMorning() {
  if (new Date().getHours() >= NIGHT_END_HOUR) return false;
  try {
    return powerMonitor.getSystemIdleState(NIGHT_PRESENCE_IDLE_S) !== 'active';
  } catch {
    return true;
  }
}

/**
 * Build Russian title/body for a reminder toast.
 * @param {{ id: string, kind: 'task' | 'habit', title: string, dueKind?: string, dueTime?: string | null }[]} items
 */
function formatReminderToast(items) {
  const overdue = items.filter((i) => i.dueKind === 'overdue');
  const today = items.filter((i) => i.dueKind === 'today');
  const habits = items.filter((i) => i.kind === 'habit');
  const parts = [];
  if (overdue.length) parts.push(`просрочено: ${overdue.length}`);
  if (today.length) parts.push(`на сегодня: ${today.length}`);
  if (habits.length) parts.push(`привычки: ${habits.length}`);

  const title =
    overdue.length && !today.length && !habits.length
      ? 'Просроченные задачи'
      : habits.length && !overdue.length && !today.length
        ? 'Привычки на сегодня'
        : 'Напоминание Glass Tasks';

  const names = items
    .slice(0, 3)
    .map((i) => {
      const time = i.dueTime ? ` (${i.dueTime})` : '';
      return `${i.title}${time}`;
    })
    .join(', ');
  const more = items.length > 3 ? ` и ещё ${items.length - 3}` : '';
  const body = parts.length
    ? `${parts.join(' · ')}. ${names}${more}`
    : `${names}${more}`;

  return { title, body };
}

function clearExactReminderTimers() {
  for (const timer of exactReminderTimers.values()) {
    clearTimeout(timer);
  }
  exactReminderTimers.clear();
}

function stopRemindersScheduler() {
  if (reminderStartupTimer) {
    clearTimeout(reminderStartupTimer);
    reminderStartupTimer = null;
  }
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  clearExactReminderTimers();
}

/**
 * Fire a one-shot exact-time toast for a single task.
 * Re-checks the task is still open and still due at this time, so completed/deleted items
 * and times changed elsewhere (Google, another device) stay silent.
 * @param {{ id: string, reminderId: string, title: string, dueTime?: string | null, dueAt: Date }} task
 */
async function fireExactTaskReminder(task) {
  const { reminderId } = task;
  const taskKey = `task:${task.id}`;
  if (isQuittingFn() || !loadSettings().remindersEnabled) return;
  if (wasNotifiedToday(reminderId) || toastingIds.has(taskKey)) return;
  if (!Notification.isSupported()) return;

  toastingIds.add(taskKey);
  try {
    try {
      const data = await getWidgetData();
      if (isQuittingFn() || !loadSettings().remindersEnabled) return;
      const live = (Array.isArray(data?.tasks) ? data.tasks : []).find(
        (t) => t && t.id === task.id
      );
      if (!live || live.completed) return;
      const liveDueAt = reminderDueAt(live);
      if (!liveDueAt || liveDueAt.getTime() !== task.dueAt.getTime()) {
        // The time moved since this timer was set: no toast for the old one, arm the new one.
        scheduleExactReminders(data);
        return;
      }
    } catch (err) {
      console.warn('[reminders] exact recheck', err && err.message ? err.message : err);
      // Fall through and notify — better a late toast than a missed one if fetch fails.
    }

    const time = task.dueTime || '';
    const title = 'Пора';
    const body = time
      ? `Пора: ${task.title} (${time})`
      : `Пора: ${task.title}`;
    await showReminderToast(title, body, [reminderId]);
  } finally {
    toastingIds.delete(taskKey);
  }
}

/**
 * Schedule one-shot timers for open tasks with a resolvable due datetime
 * within the next 24 hours. Cancels previous schedule.
 * @param {any} data
 */
function scheduleExactReminders(data) {
  clearExactReminderTimers();
  if (isQuittingFn() || !loadSettings().remindersEnabled) return;
  if (!Notification.isSupported()) return;

  const now = Date.now();
  const horizon = now + EXACT_REMINDER_HORIZON_MS;
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const state = loadReminderState();
  const notified = new Set(state.notifiedIds);

  /** @type {{ id: string, reminderId: string, title: string, dueTime: string | null, dueAt: Date }[]} */
  const upcoming = [];
  for (const t of tasks) {
    if (!t || t.completed || !t.id) continue;
    const dueAt = reminderDueAt(t);
    if (!dueAt) continue;
    const ts = dueAt.getTime();
    if (ts <= now || ts > horizon) continue;
    const reminderId = exactReminderId(t.id, dueAt);
    if (notified.has(reminderId)) continue;
    upcoming.push({
      id: t.id,
      reminderId,
      title: String(t.title || 'Задача').trim() || 'Задача',
      dueTime: t.dueTime || hhmm(dueAt),
      dueAt,
    });
  }

  upcoming.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  for (const item of upcoming) {
    const delay = Math.max(0, item.dueAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      exactReminderTimers.delete(item.id);
      fireExactTaskReminder(item).catch((err) =>
        console.warn('[reminders] exact', err && err.message ? err.message : err)
      );
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    exactReminderTimers.set(item.id, timer);
  }
}

/**
 * Refresh exact timers from current widget data (best-effort, non-blocking).
 * @param {any} [data]
 */
function refreshExactReminders(data) {
  if (!loadSettings().remindersEnabled || isQuittingFn()) {
    clearExactReminderTimers();
    return;
  }
  if (data) {
    scheduleExactReminders(data);
    return;
  }
  getWidgetData()
    .then((d) => scheduleExactReminders(d))
    .catch((err) =>
      console.warn('[reminders] reschedule', err && err.message ? err.message : err)
    );
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   shown: boolean,
 *   count: number,
 *   reason?: string,
 *   message?: string,
 *   notificationsSupported: boolean,
 * }>}
 */
async function runReminderCheck(opts = {}) {
  const notificationsSupported = Notification.isSupported();
  const empty = {
    ok: false,
    shown: false,
    count: 0,
    notificationsSupported,
  };

  if (reminderCheckInFlight || isQuittingFn()) {
    return { ...empty, reason: 'busy', message: 'Проверка уже выполняется.' };
  }
  const settings = loadSettings();
  if (!settings.remindersEnabled) {
    return {
      ...empty,
      reason: 'disabled',
      message: 'Напоминания выключены в настройках.',
    };
  }
  if (!notificationsSupported) {
    return {
      ...empty,
      reason: 'unsupported',
      message:
        'Система не поддерживает уведомления. Проверьте Параметры Windows → Система → Уведомления.',
    };
  }
  if (!windowsToastsGloballyEnabled()) {
    return {
      ...empty,
      reason: 'os-disabled',
      message:
        'Уведомления Windows выключены глобально (ToastEnabled=0). Включите: Параметры → Система → Уведомления.',
    };
  }

  reminderCheckInFlight = true;
  try {
    const data = await getWidgetData();
    // Re-check after await: user may have quit or disabled reminders mid-fetch.
    if (isQuittingFn() || !loadSettings().remindersEnabled) {
      return {
        ...empty,
        reason: 'disabled',
        message: 'Напоминания выключены.',
      };
    }

    // Manual «Проверить» must always be allowed to re-fire toasts the same day.
    if (opts.force) clearNotifiedToday();

    const candidates = collectReminderCandidates(data);
    scheduleExactReminders(data);
    if (!opts.force && sweepWaitsForMorning()) {
      return {
        ok: true,
        shown: false,
        count: 0,
        reason: 'night',
        message: 'Ночью напоминания ждут утра или пока вы не вернётесь к компьютеру.',
        notificationsSupported,
      };
    }
    const state = loadReminderState();
    const notified = new Set(state.notifiedIds);
    const fresh = opts.force
      ? candidates
      : candidates.filter(
          (c) =>
            !notified.has(c.id) &&
            !(c.exactId && notified.has(c.exactId)) &&
            !toastingIds.has(c.id)
        );
    if (!fresh.length) {
      return {
        ok: true,
        shown: false,
        count: 0,
        reason: candidates.length ? 'already' : 'empty',
        message: candidates.length
          ? 'На сегодня уже отправляли. Нажмите «Проверить» — покажем снова (тост Windows + Action Center).'
          : 'Нет открытых задач на сегодня/просроченных и незакрытых привычек.',
        notificationsSupported,
      };
    }

    const { title, body } = formatReminderToast(fresh);
    const ids = fresh.map((c) => c.id);
    const claimed = ids.filter((id) => !toastingIds.has(id));
    for (const id of claimed) toastingIds.add(id);
    let result;
    try {
      result = await showReminderToast(title, body, ids, { force: Boolean(opts.force) });
    } finally {
      for (const id of claimed) toastingIds.delete(id);
    }

    if (!result.shown) {
      return {
        ok: false,
        shown: false,
        count: fresh.length,
        reason: 'failed',
        message:
          'Системный тост не удалось показать. Параметры → Система → Уведомления: включите баннеры и «Glass Tasks Widget». Отключите Фокусировку внимания.',
        notificationsSupported,
      };
    }

    const via =
      result.channel === 'electron'
        ? 'Windows (Electron)'
        : result.channel === 'winrt'
          ? 'Windows (WinRT)'
          : result.channel === 'balloon'
            ? 'подсказка у трея'
            : 'уведомление';
    return {
      ok: true,
      shown: true,
      count: fresh.length,
      channel: result.channel,
      balloon: Boolean(result.balloon),
      winrt: Boolean(result.winrt),
      electron: Boolean(result.electron),
      message: `Отправлено: ${fresh.length} через ${via}. Смотрите баннер Windows / Центр уведомлений.`,
      notificationsSupported,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[reminders]', msg);
    return {
      ...empty,
      reason: 'error',
      message: msg,
    };
  } finally {
    reminderCheckInFlight = false;
  }
}

/**
 * @param {boolean} enabled
 * @param {{ immediate?: boolean }} [opts]
 */
function syncRemindersScheduler(enabled, opts = {}) {
  stopRemindersScheduler();
  if (!enabled) return;

  const delay = opts.immediate ? 2500 : REMINDER_STARTUP_DELAY_MS;
  reminderStartupTimer = setTimeout(() => {
    reminderStartupTimer = null;
    runReminderCheck().catch((err) =>
      console.warn('[reminders]', err && err.message ? err.message : err)
    );
  }, delay);
  if (typeof reminderStartupTimer.unref === 'function') reminderStartupTimer.unref();

  reminderInterval = setInterval(() => {
    runReminderCheck().catch((err) =>
      console.warn('[reminders]', err && err.message ? err.message : err)
    );
  }, REMINDER_INTERVAL_MS);
  if (typeof reminderInterval.unref === 'function') reminderInterval.unref();
}

module.exports = {
  configureReminders,
  collectReminderCandidates,
  formatReminderToast,
  runReminderCheck,
  syncRemindersScheduler,
  stopRemindersScheduler,
  refreshExactReminders,
  scheduleExactReminders,
};
