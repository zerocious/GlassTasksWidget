'use strict';

/**
 * Pure helpers for task dates, clock time and recurrence.
 * Google Tasks `due` is date-only (UTC midnight), so the widget keeps clock time
 * («время HH:MM») and repeat rules («повтор: …») as managed lines in notes.
 */

const { todayIso, addDaysIso } = require('./dates');

/** True for Google's date-only dues (exact UTC midnight). */
function isUtcMidnight(d) {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}


/** Google Tasks due is date-only UTC midnight — compare by calendar day in local TZ. */
function dueDateKey(due) {
  if (!due) return null;
  try {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

/**
 * @returns {'overdue' | 'today' | 'later' | null}
 */
function dueKindFor(due, completed) {
  if (completed || !due) return null;
  const key = dueDateKey(due);
  if (!key) return null;
  const today = todayIso();
  if (key < today) return 'overdue';
  if (key === today) return 'today';
  return 'later';
}

/** Managed time line written by the widget UI («время HH:MM»). */
const MANAGED_TIME_LINE_RE =
  /^(?:время|Время|time)\s*[:-]?\s*\d{1,2}[:.]\d{2}\s*$/i;

/** Managed recurrence line («повтор: ежедневно|будни|еженедельно»). */
const MANAGED_REPEAT_LINE_RE =
  /^(?:повтор|Повтор|repeat)\s*[:-]?\s*(ежедневно|будни|еженедельно|daily|weekdays|weekly)\s*$/i;

/** @type {Record<string, 'daily' | 'weekdays' | 'weekly'>} */
const REPEAT_ALIAS = {
  ежедневно: 'daily',
  daily: 'daily',
  будни: 'weekdays',
  weekdays: 'weekdays',
  еженедельно: 'weekly',
  weekly: 'weekly',
};

/** @type {Record<'daily' | 'weekdays' | 'weekly', string>} */
const REPEAT_MARKER = {
  daily: 'повтор: ежедневно',
  weekdays: 'повтор: будни',
  weekly: 'повтор: еженедельно',
};

function isManagedNotesLine(line) {
  const t = String(line || '').trim();
  return Boolean(t) && (MANAGED_TIME_LINE_RE.test(t) || MANAGED_REPEAT_LINE_RE.test(t));
}

/**
 * @param {string | null | undefined} notes
 * @returns {'daily' | 'weekdays' | 'weekly' | null}
 */
function parseRecurrence(notes) {
  if (!notes) return null;
  for (const raw of String(notes).split(/\r?\n/)) {
    const m = String(raw).trim().match(MANAGED_REPEAT_LINE_RE);
    if (!m) continue;
    const key = String(m[1] || '').toLowerCase();
    return REPEAT_ALIAS[key] || null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {'daily' | 'weekdays' | 'weekly' | null}
 */
function normalizeRecurrenceInput(value) {
  if (value === null || value === undefined || value === '' || value === 'none') return null;
  if (typeof value !== 'string') throw new Error('Некорректный повтор');
  const key = value.trim().toLowerCase();
  const mapped = REPEAT_ALIAS[key];
  if (!mapped) throw new Error('Повтор: ежедневно, будни или еженедельно');
  return mapped;
}

/**
 * Upsert/clear managed «повтор: …» line in notes.
 * @param {string | null | undefined} notes
 * @param {'daily' | 'weekdays' | 'weekly' | null} recurrence
 */
function applyRecurrenceToNotes(notes, recurrence) {
  const lines = String(notes || '').split(/\r?\n/);
  const kept = lines.filter((line) => !MANAGED_REPEAT_LINE_RE.test(String(line).trim()));
  let rest = kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (!recurrence) return rest;
  const marker = REPEAT_MARKER[recurrence];
  return rest ? `${marker}\n${rest}` : marker;
}

function weekdayOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Sun … 6=Sat
}

function dueIsoFromLocalKey(key) {
  return `${key}T00:00:00.000Z`;
}

/**
 * Advance one step from a local YYYY-MM-DD key.
 * @param {string} key
 * @param {'daily' | 'weekdays' | 'weekly'} recurrence
 */
function advanceDateKey(key, recurrence) {
  if (recurrence === 'weekly') return addDaysIso(key, 7);
  if (recurrence === 'daily') return addDaysIso(key, 1);
  // weekdays: next Mon–Fri
  let next = addDaysIso(key, 1);
  while (weekdayOfKey(next) === 0 || weekdayOfKey(next) === 6) {
    next = addDaysIso(next, 1);
  }
  return next;
}

/**
 * Next due after completing a recurring task (always after today).
 * @param {string | null | undefined} due
 * @param {'daily' | 'weekdays' | 'weekly'} recurrence
 */
function nextOccurrenceDue(due, recurrence) {
  const today = todayIso();
  let cursor = dueDateKey(due) || today;
  if (cursor < today) cursor = today;
  cursor = advanceDateKey(cursor, recurrence);
  while (cursor <= today) {
    cursor = advanceDateKey(cursor, recurrence);
  }
  return dueIsoFromLocalKey(cursor);
}

function formatMeta(task) {
  // Time / recurrence are row chips; meta stays date / notes preview only.
  if (task.due) {
    try {
      const d = new Date(task.due);
      const kind = dueKindFor(task.due, task.status === 'completed');
      const dateLabel = formatDueDateLabel(d, task.due);
      if (kind === 'overdue') return `Просрочено · ${dateLabel}`;
      if (kind === 'today') return 'Сегодня';
      return dateLabel;
    } catch {
      return 'Срок';
    }
  }
  if (task.notes && String(task.notes).trim()) {
    const line = String(task.notes)
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !isManagedNotesLine(l));
    if (line) return line.length > 40 ? `${line.slice(0, 37)}…` : line;
  }
  return '';
}

/**
 * Normalize UI/API dueTime patch: null clears; 'HH:MM' / 'H:MM' → 'HH:MM'.
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeDueTimeInput(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Некорректное время');
  const m = value.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) throw new Error('Время в формате ЧЧ:ММ');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) {
    throw new Error('Время в формате ЧЧ:ММ');
  }
  return formatHm(h, min);
}

/**
 * Upsert/clear managed «время HH:MM» line in notes (Google due is date-only).
 * @param {string | null | undefined} notes
 * @param {string | null} dueTime HH:MM or null to clear
 */
function applyDueTimeToNotes(notes, dueTime) {
  const lines = String(notes || '').split(/\r?\n/);
  const kept = lines.filter((line) => !MANAGED_TIME_LINE_RE.test(String(line).trim()));
  let rest = kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');

  if (dueTime == null || dueTime === '') {
    // Drop standalone time-only lines so Clear fully removes resolvable time.
    rest = rest
      .split(/\r?\n/)
      .filter((line) => {
        const t = String(line).trim();
        if (!t) return true;
        if (/^(?:в|at)\s+\d{1,2}[:.]\d{2}$/i.test(t)) return false;
        if (/^\d{1,2}:\d{2}$/.test(t)) return false;
        return true;
      })
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    return rest;
  }

  const marker = `время ${dueTime}`;
  return rest ? `${marker}\n${rest}` : marker;
}

/**
 * Prefer calendar day from Google's UTC date-only due; fall back to locale date.
 * @param {Date} d
 * @param {string} due
 */
function formatDueDateLabel(d, due) {
  const key = dueDateKey(due);
  if (key) {
    try {
      const [y, m, day] = key.split('-').map(Number);
      const local = new Date(y, m - 1, day);
      return local.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      /* fall through */
    }
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Time from due ISO when not midnight UTC, else common patterns in notes.
 * @param {{ due?: string | null, notes?: string | null }} task
 * @returns {string | null} HH:MM
 */
function resolveTaskTime(task) {
  return dueTimeLabel(task?.due) || timeFromNotes(task?.notes);
}

/**
 * Google Tasks date-only dues are midnight UTC. Any other UTC time is real.
 * @param {string | null | undefined} due
 * @returns {string | null}
 */
function dueTimeLabel(due) {
  if (!due) return null;
  try {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return null;
    const utcMidnight = isUtcMidnight(d);
    if (utcMidnight) return null;
    return formatHm(d.getHours(), d.getMinutes());
  } catch {
    return null;
  }
}

/**
 * Parse time from notes: «14:30», «в 14:30», «time: 9:05», «время 09.30».
 * @param {string | null | undefined} notes
 * @returns {string | null}
 */
function timeFromNotes(notes) {
  if (!notes) return null;
  const text = String(notes);
  const patterns = [
    /(?:^|[\s,;|(])(?:в|В|at|time|время|Время)\s*[:-]?\s*(\d{1,2})[:.](\d{2})\b/i,
    /\b(\d{1,2}):(\d{2})\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) continue;
    return formatHm(h, min);
  }
  return null;
}

function formatHm(h, min) {
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Absolute local Date for a timed reminder, or null if date-only / no resolvable time.
 * Uses real due datetime when not midnight-UTC-only; otherwise notes HH:MM + due day / today.
 * @param {{ due?: string | null, notes?: string | null, dueTime?: string | null }} task
 * @returns {Date | null}
 */
function resolveTaskDueAt(task) {
  if (!task) return null;
  const hm = (task.dueTime && /^\d{2}:\d{2}$/.test(task.dueTime)
    ? task.dueTime
    : null) || resolveTaskTime(task);
  if (!hm) return null;
  const parts = hm.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;

  if (task.due) {
    try {
      const d = new Date(task.due);
      if (!Number.isNaN(d.getTime())) {
        const utcMidnight = isUtcMidnight(d);
        // Real clock on due ISO → absolute instant
        if (!utcMidnight) return d;
        const key = dueDateKey(task.due);
        if (key) {
          const [y, m, day] = key.split('-').map(Number);
          return new Date(y, m - 1, day, hh, mm, 0, 0);
        }
      }
    } catch {
      /* fall through */
    }
  }

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
}

module.exports = {
  dueDateKey,
  dueKindFor,
  isManagedNotesLine,
  parseRecurrence,
  normalizeRecurrenceInput,
  applyRecurrenceToNotes,
  advanceDateKey,
  nextOccurrenceDue,
  formatMeta,
  normalizeDueTimeInput,
  applyDueTimeToNotes,
  resolveTaskTime,
  dueTimeLabel,
  timeFromNotes,
  formatHm,
  resolveTaskDueAt,
  isUtcMidnight,
};
