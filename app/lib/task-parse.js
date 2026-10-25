'use strict';

/**
 * Pure helpers for task dates, clock time and recurrence.
 * Google Tasks `due` is date-only (UTC midnight), so the widget keeps clock time
 * («время HH:MM») and repeat rules («повтор: …») as managed lines in notes.
 */

const { todayIso, addDaysIso } = require('./dates');

/** Row subtitles when an item has no date and no notes preview. */
const META_TASK = 'Задача';
const META_DONE = 'Готово';
const META_HABIT = 'Ежедневно';
/** Caches written by older versions hold the English placeholders. */
const LEGACY_META = { Task: META_TASK, Done: META_DONE, Daily: META_HABIT };

/** Translate a legacy English placeholder; other text is returned unchanged. */
function localizeMeta(meta) {
  return (meta && LEGACY_META[meta]) || meta || '';
}

/** Empty or the generic «task» placeholder (old or new spelling). */
function isPlaceholderMeta(meta) {
  return !meta || meta === META_TASK || meta === 'Task';
}

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
  /^(?:время|Время|time)\s*(?:[:-]\s*)?\d{1,2}[:.]\d{2}\s*$/i;

/** Managed recurrence line («повтор: ежедневно|будни|еженедельно»). */
const MANAGED_REPEAT_LINE_RE =
  /^(?:повтор|Повтор|repeat)\s*(?:[:-]\s*)?(ежедневно|будни|еженедельно|daily|weekdays|weekly)\s*$/i;

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

/** «в 14:30», «time: 9:05», «время 09.30» inside any text (not a «12:30:45» timestamp). */
const PREFIXED_TIME_RE =
  /(^|[\s,;|(])(?:в|В|at|time|время|Время)\s*(?:[:-]\s*)?(\d{1,2})[:.](\d{2})\b(?![:.]\d)/i;

const PREFIXED_TIME_GLOBAL_RE = new RegExp(PREFIXED_TIME_RE.source, 'gi');

/** A line that is nothing but a clock time («14:30»). */
const BARE_TIME_LINE_RE = /^(\d{1,2}):(\d{2})$/;

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
 * Strip leading / trailing newlines. A loop, not /\n+$/: that regex is quadratic on a long
 * run of newlines, and notes come from Google (anyone who can put a task in the list).
 * @param {string} text
 */
function trimNewlines(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 10) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 10) end -= 1;
  return text.slice(start, end);
}

/**
 * Upsert/clear managed «повтор: …» line in notes.
 * @param {string | null | undefined} notes
 * @param {'daily' | 'weekdays' | 'weekly' | null} recurrence
 */
function applyRecurrenceToNotes(notes, recurrence) {
  const lines = String(notes || '').split(/\r?\n/);
  const kept = lines.filter((line) => !MANAGED_REPEAT_LINE_RE.test(String(line).trim()));
  let rest = trimNewlines(kept.join('\n'));
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

/** Whole calendar days from local key `from` to `to`. */
function daysBetweenKeys(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Next due after completing a recurring task (always after today).
 * A weekly task completed late stays on its weekday.
 * @param {string | null | undefined} due
 * @param {'daily' | 'weekdays' | 'weekly'} recurrence
 */
function nextOccurrenceDue(due, recurrence) {
  const today = todayIso();
  let cursor = dueDateKey(due) || today;
  if (cursor < today) {
    cursor =
      recurrence === 'weekly'
        ? addDaysIso(cursor, 7 * Math.floor(daysBetweenKeys(cursor, today) / 7))
        : today;
  }
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
    if (line) {
      // By code points: a UTF-16 cut could split an emoji into a lone surrogate («�»).
      const chars = Array.from(line);
      return chars.length > 40 ? `${chars.slice(0, 37).join('')}…` : line;
    }
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
 * Cut «в 15:00»-style phrases out of one notes line.
 * @param {string} line
 * @returns {string | null} null when nothing else was on the line
 */
function stripPrefixedTimes(line) {
  let changed = false;
  const out = line.replace(PREFIXED_TIME_GLOBAL_RE, (whole, lead, h, min) => {
    if (!isClock(h, min)) return whole;
    changed = true;
    return lead;
  });
  if (!changed) return line;
  // Collapse runs first, so the patterns after it never meet long whitespace (linear).
  const tidy = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\([ \t]?\)/g, '')
    .replace(/[ \t]([,.;:!?])/g, '$1')
    .replace(/([,;])(?:[ \t]?[,;])+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return tidy || null;
}

/**
 * Upsert/clear managed «время HH:MM» line in notes (Google due is date-only).
 * @param {string | null | undefined} notes
 * @param {string | null} dueTime HH:MM or null to clear
 */
function applyDueTimeToNotes(notes, dueTime) {
  const lines = String(notes || '').split(/\r?\n/);
  const kept = lines.filter((line) => !MANAGED_TIME_LINE_RE.test(String(line).trim()));
  let rest = trimNewlines(kept.join('\n'));

  if (dueTime == null || dueTime === '') {
    // Remove everything timeFromNotes would still read, so Clear really clears the time:
    // time-only lines («14:30», «в 14:30») and phrases inside text («позвонить в 15:00 Ивану»).
    rest = rest
      .split(/\r?\n/)
      .filter((line) => !BARE_TIME_LINE_RE.test(line.trim()))
      .map(stripPrefixedTimes)
      .filter((line) => line !== null)
      .join('\n');
    rest = trimNewlines(rest);
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
 * Parse time from notes: «в 14:30», «time: 9:05», «время 09.30» anywhere, a bare «14:30» only
 * as a line of its own — «открыт 9:00-18:00», «глава 3:16» or «12:30:45» are not the task's time.
 * @param {string | null | undefined} notes
 * @returns {string | null}
 */
function timeFromNotes(notes) {
  if (!notes) return null;
  const text = String(notes);
  const m = text.match(PREFIXED_TIME_RE);
  if (m && isClock(m[2], m[3])) return formatHm(Number(m[2]), Number(m[3]));
  for (const line of text.split(/\r?\n/)) {
    const bare = line.trim().match(BARE_TIME_LINE_RE);
    if (bare && isClock(bare[1], bare[2])) return formatHm(Number(bare[1]), Number(bare[2]));
  }
  return null;
}

function isClock(h, min) {
  return Number(h) <= 23 && Number(min) <= 59;
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
  META_TASK,
  META_DONE,
  META_HABIT,
  localizeMeta,
  isPlaceholderMeta,
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
