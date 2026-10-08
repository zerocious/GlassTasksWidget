'use strict';

const {
  getAuthorizedClient,
  isInvalidGrantError,
  normalizeGoogleAuthError,
} = require('./google-auth');
const {
  enrichHabits,
  markCompleted,
  unmarkCompleted,
  removeHabit,
  todayIso,
} = require('./streak-store');
const {
  getMockPayload,
  getMockItem,
  addMockItem,
  setMockCompleted,
  updateMockItem,
  deleteMockItem,
  reorderMockItems,
  resetMockHabitsCompleted,
  clearMockCompletedTasks,
} = require('./mock-data');
const { loadConfig, hasGoogleCredentials } = require('./config');
const { loadSettings, saveSettings } = require('./settings-store');
const {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
  reorderOfflineCache,
} = require('./offline-cache');

const MAX_TITLE_LEN = 200;
const MAX_NOTES_LEN = 8000;

const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
/** Soft TTL for in-memory widget payload — avoids double network on rapid IPC. */
const PAYLOAD_CACHE_TTL_MS = 45 * 1000;

/** @type {{ at: number, byTitle: Map<string, string> } | null} */
let listCache = null;
/** @type {Promise<any> | null} */
let dataInFlight = null;
/** @type {{ at: number, payload: any } | null} */
let payloadCache = null;
/** @type {Map<string, Promise<any>>} */
const mutationInFlight = new Map();
/** Per-item completion toggles: key → latest queued { completed, run }. */
/** @type {Map<string, { completed: boolean, run: Promise<any> }>} */
const completionInFlight = new Map();
/** @type {Promise<any> | null} */
let habitsResetInFlight = null;

/** Re-throw Google API failures with a user-safe Russian message when needed. */
function rejectGoogleAuth(err) {
  throw normalizeGoogleAuthError(err);
}

/** Lazy-load heavy googleapis only on first Google API use. */
function getGoogle() {
  return require('googleapis').google;
}

function localDateKey(date = new Date()) {
  return todayIso(date);
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
  const today = localDateKey();
  if (key < today) return 'overdue';
  if (key === today) return 'today';
  return 'later';
}

/** Managed time line written by the widget UI («время HH:MM»). */
const MANAGED_TIME_LINE_RE =
  /^(?:время|Время|time)\s*[:\-]?\s*\d{1,2}[:.]\d{2}\s*$/i;

/** Managed recurrence line («повтор: ежедневно|будни|еженедельно»). */
const MANAGED_REPEAT_LINE_RE =
  /^(?:повтор|Повтор|repeat)\s*[:\-]?\s*(ежедневно|будни|еженедельно|daily|weekdays|weekly)\s*$/i;

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

/** @type {Record<'daily' | 'weekdays' | 'weekly', string>} */
const REPEAT_BADGE = {
  daily: 'ежедн.',
  weekdays: 'будни',
  weekly: 'еженед.',
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

function addDaysToKey(key, delta) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
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
  if (recurrence === 'weekly') return addDaysToKey(key, 7);
  if (recurrence === 'daily') return addDaysToKey(key, 1);
  // weekdays: next Mon–Fri
  let next = addDaysToKey(key, 1);
  while (weekdayOfKey(next) === 0 || weekdayOfKey(next) === 6) {
    next = addDaysToKey(next, 1);
  }
  return next;
}

/**
 * Next due after completing a recurring task (always after today).
 * @param {string | null | undefined} due
 * @param {'daily' | 'weekdays' | 'weekly'} recurrence
 */
function nextOccurrenceDue(due, recurrence) {
  const today = localDateKey();
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
    const utcMidnight =
      d.getUTCHours() === 0 &&
      d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 &&
      d.getUTCMilliseconds() === 0;
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
    /(?:^|[\s,;|(])(?:в|В|at|time|время|Время)\s*[:\-]?\s*(\d{1,2})[:\.](\d{2})\b/i,
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
        const utcMidnight =
          d.getUTCHours() === 0 &&
          d.getUTCMinutes() === 0 &&
          d.getUTCSeconds() === 0 &&
          d.getUTCMilliseconds() === 0;
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

function mapTask(item) {
  const completed = item.status === 'completed';
  const due = item.due || null;
  const dueKind = dueKindFor(due, completed);
  const dueTime = resolveTaskTime(item);
  const recurrence = parseRecurrence(item.notes);
  return {
    id: item.id,
    title: item.title || '(без названия)',
    notes: item.notes || '',
    due,
    dueKind,
    dueTime,
    recurrence,
    status: item.status || 'needsAction',
    completed,
    position: item.position || '',
    parent: item.parent || null,
    meta: formatMeta(item) || (completed ? 'Done' : 'Task'),
  };
}

/**
 * Sort siblings by Google Tasks `position` (lexicographic). When no item has a
 * position (mock / array-ordered caches), keep stable input order.
 * @template {{ position?: string | null }} T
 * @param {T[]} list
 * @returns {T[]}
 */
function sortSiblingGroup(list) {
  if (!Array.isArray(list) || list.length < 2) return list;
  const hasPos = list.some((t) => t && t.position);
  if (!hasPos) return list;
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = String((a.item && a.item.position) || '');
      const pb = String((b.item && b.item.position) || '');
      if (pa !== pb) {
        if (!pa) return 1;
        if (!pb) return -1;
        return pa < pb ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Nest children under parents. Sibling order follows Google `position` when
 * present; otherwise preserves relative input order (mock / DnD caches).
 * @param {Array<{ id: string, parent?: string | null, position?: string | null }>} tasks
 */
function nestTasksPreserveOrder(tasks) {
  const byId = new Map();
  for (const t of tasks) {
    if (t && t.id) byId.set(t.id, t);
  }
  /** @type {Map<string, typeof tasks>} */
  const children = new Map();
  /** @type {typeof tasks} */
  const roots = [];
  for (const t of tasks) {
    if (!t || !t.id) continue;
    if (t.parent && byId.has(t.parent)) {
      if (!children.has(t.parent)) children.set(t.parent, []);
      children.get(t.parent).push(t);
    } else {
      roots.push(t);
    }
  }
  for (const [parentId, kids] of children) {
    children.set(parentId, sortSiblingGroup(kids));
  }
  /** @type {typeof tasks} */
  const out = [];
  const walk = (list) => {
    for (const t of list) {
      out.push(t);
      const kids = children.get(t.id);
      if (kids && kids.length) walk(kids);
    }
  };
  walk(sortSiblingGroup(roots));
  return out;
}

/**
 * Open first, then up to 5 completed — Google sibling order via `position`,
 * nest subtasks under parents (mock keeps array / DnD order).
 */
function sortTasks(tasks) {
  const open = nestTasksPreserveOrder(tasks.filter((t) => !t.completed));
  const done = nestTasksPreserveOrder(tasks.filter((t) => t.completed)).slice(0, 5);
  return [...open, ...done];
}

function decorateTasks(tasks) {
  return sortTasks(
    tasks.map((t) => {
      const dueKind = dueKindFor(t.due, Boolean(t.completed));
      const dueTime = resolveTaskTime(t);
      const recurrence =
        Object.prototype.hasOwnProperty.call(t, 'recurrence') && t.recurrence !== undefined
          ? t.recurrence
          : parseRecurrence(t.notes);
      const meta =
        t.due || dueTime || !t.meta
          ? formatMeta({ ...t, status: t.completed ? 'completed' : 'needsAction' }) ||
            (t.completed ? 'Done' : 'Task')
          : t.meta;
      return { ...t, dueKind, dueTime, recurrence, meta };
    })
  );
}

/**
 * Reorder in-memory payload list to match orderedIds (stable partition after).
 * @param {'tasks' | 'habits'} listKind
 * @param {string[]} orderedIds
 * @param {{ id?: string, position?: string } | null} [movedPatch]
 */
function reorderPayloadCache(listKind, orderedIds, movedPatch = null) {
  if (!payloadCache || !payloadCache.payload) return;
  if (!Array.isArray(orderedIds) || !orderedIds.length) return;
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const prev = payloadCache.payload;
  const list = Array.isArray(prev[key]) ? prev[key].slice() : [];
  const byId = new Map();
  for (const item of list) {
    if (item && item.id) byId.set(item.id, item);
  }
  const next = [];
  const seen = new Set();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    let item = byId.get(id);
    if (!item) continue;
    if (movedPatch && movedPatch.id === id) {
      item = { ...item, ...movedPatch };
    }
    next.push(item);
    seen.add(id);
  }
  for (const item of list) {
    if (item && item.id && !seen.has(item.id)) next.push(item);
  }
  const ordered =
    listKind === 'tasks'
      ? decorateTasks(next)
      : (() => {
          const open = next.filter((h) => !h.completed);
          const done = next.filter((h) => h.completed);
          return [...open, ...done];
        })();
  setPayloadCache({ ...prev, [key]: ordered, offline: false });
}

function invalidateListCache() {
  listCache = null;
}

function invalidatePayloadCache() {
  payloadCache = null;
}

function setPayloadCache(payload) {
  if (!payload) {
    payloadCache = null;
    return;
  }
  payloadCache = { at: Date.now(), payload };
}

function patchPayloadCache(listKind, taskId, patch, append = null) {
  if (!payloadCache || !payloadCache.payload) return;
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const prev = payloadCache.payload;
  let list = Array.isArray(prev[key]) ? prev[key].slice() : [];
  if (append) {
    list = [append, ...list.filter((item) => item && item.id !== append.id)];
    if (listKind === 'tasks') list = decorateTasks(list);
    else list = withHabits(list);
  } else if (patch === null) {
    // Cascade: Google deletes subtasks with their parent.
    list = list.filter(
      (item) => item && item.id !== taskId && item.parent !== taskId
    );
  } else {
    list = list.map((item) =>
      item && item.id === taskId ? { ...item, ...patch } : item
    );
    if (listKind === 'tasks') list = decorateTasks(list);
    else {
      list = list.map((h) => ({
        ...h,
        completed: Boolean(h.completedToday != null ? h.completedToday : h.completed),
        status: (h.completedToday != null ? h.completedToday : h.completed)
          ? 'completed'
          : 'needsAction',
      }));
      const open = list.filter((h) => !h.completed);
      const done = list.filter((h) => h.completed);
      list = [...open, ...done];
    }
  }
  setPayloadCache({ ...prev, [key]: list, offline: false });
}

async function getListMap(tasksApi) {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) {
    return listCache.byTitle;
  }
  const res = await tasksApi.tasklists.list({ maxResults: 100 });
  const byTitle = new Map();
  for (const list of res.data.items || []) {
    const title = (list.title || '').trim();
    if (title && list.id) byTitle.set(title, list.id);
  }
  listCache = { at: now, byTitle };
  return byTitle;
}

async function resolveListId(tasksApi, name) {
  const map = await getListMap(tasksApi);
  return map.get(String(name || '').trim()) || null;
}

/** Hard cap on pages per list fetch (100 items each) — guards against runaway loops. */
const MAX_LIST_PAGES = 10;

/**
 * Fetch every task in a list, following nextPageToken. A single 50-item page
 * used to drop open tasks once enough completed ones accumulated.
 * @param {any} tasksApi
 * @param {string} listId
 * @param {{ showHidden?: boolean }} [opts]
 */
async function listAllTaskItems(tasksApi, listId, opts = {}) {
  const items = [];
  let pageToken;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await tasksApi.tasks.list({
      tasklist: listId,
      showCompleted: true,
      showHidden: Boolean(opts.showHidden),
      maxResults: 100,
      pageToken,
    });
    items.push(...((res.data && res.data.items) || []));
    pageToken = res.data && res.data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

async function listTasks(tasksApi, listId) {
  if (!listId) return [];
  // Include hidden (cleared) completed tasks — the Google Tasks app still shows
  // them under «Выполненные», and the widget's «Удалить выполненные» must see them.
  const items = await listAllTaskItems(tasksApi, listId, { showHidden: true });
  return decorateTasks(items.map(mapTask));
}

/**
 * Habits are daily: UI "done" is local streak today, not Google's sticky completed status.
 * Also re-sort without truncating — listTasks may have dropped "done" Google items.
 */
function withHabits(habitsRaw) {
  const enriched = enrichHabits(
    habitsRaw.map((h) => {
      const status = h.status || 'needsAction';
      const dueTime = resolveTaskTime(h);
      const formatted = formatMeta({ ...h, status });
      const meta =
        formatted && formatted !== 'Task'
          ? formatted
          : h.meta && h.meta !== 'Task'
            ? h.meta
            : 'Daily';
      return { ...h, dueTime, meta };
    })
  ).map((h) => ({
      ...h,
      completed: Boolean(h.completedToday),
      status: h.completedToday ? 'completed' : 'needsAction',
  }));
  // Google sibling order via position; mock keeps array order. Partition open/done.
  const open = sortSiblingGroup(enriched.filter((h) => !h.completed));
  const done = sortSiblingGroup(enriched.filter((h) => h.completed));
  return [...open, ...done];
}

/** List habits without the tasks "open + 5 done" truncation. */
async function listHabitTasks(tasksApi, listId) {
  if (!listId) return [];
  const items = await listAllTaskItems(tasksApi, listId);
  return items.map(mapTask);
}

async function fetchLivePayload(config) {
  const auth = await getAuthorizedClient({ interactive: false });
  if (!auth) {
    return {
      mode: 'needs_auth',
      tasksListName: config.tasksListName,
      habitsListName: config.habitsListName,
      accentColor: config.accentColor,
      tasks: [],
      habits: [],
      offline: false,
      message: 'Нужна авторизация Google',
    };
  }

  const tasksApi = getGoogle().tasks({ version: 'v1', auth });
  const listMap = await getListMap(tasksApi);
  const tasksListId = listMap.get(String(config.tasksListName || '').trim()) || null;
  const habitsListId = listMap.get(String(config.habitsListName || '').trim()) || null;

  const [tasks, habitsRawBase] = await Promise.all([
    listTasks(tasksApi, tasksListId),
    listHabitTasks(tasksApi, habitsListId),
  ]);

  const habits = withHabits(habitsRawBase);

  const payload = {
    mode: 'google',
    tasksListName: config.tasksListName,
    habitsListName: config.habitsListName,
    accentColor: config.accentColor,
    tasksListFound: Boolean(tasksListId),
    habitsListFound: Boolean(habitsListId),
    tasks,
    habits,
    offline: false,
  };

  saveOfflineCache(payload);
  setPayloadCache(payload);
  return payload;
}

function offlineFromCache(config, errMessage) {
  const cached = loadOfflineCache();
  if (!cached) return null;
  return {
    mode: 'google',
    tasksListName: cached.tasksListName || config.tasksListName,
    habitsListName: cached.habitsListName || config.habitsListName,
    accentColor: cached.accentColor || config.accentColor,
    tasksListFound: cached.tasksListFound,
    habitsListFound: cached.habitsListFound,
    tasks: decorateTasks(cached.tasks || []),
    habits: withHabits(cached.habits || []),
    offline: true,
    warning: errMessage || 'Нет сети — показан кэш',
    cachedAt: cached.savedAt || null,
  };
}

/**
 * Serve warm memory payload when fresh; re-enrich habits + task dueKind for day-rollover.
 */
function fromPayloadCache() {
  if (!payloadCache) return null;
  if (Date.now() - payloadCache.at > PAYLOAD_CACHE_TTL_MS) return null;
  const p = payloadCache.payload;
  if (!p || p.mode !== 'google' || p.offline) return null;
  const habits = withHabits(
    (p.habits || []).map((h) => ({
      id: h.id,
      title: h.title,
      notes: h.notes || '',
      due: h.due || null,
      status: h.status || 'needsAction',
      completed: false,
      meta: h.meta && h.meta !== 'Task' ? h.meta : 'Daily',
    }))
  );
  // Recompute dueKind/meta so midnight rollover is correct within the soft TTL.
  const tasks = decorateTasks(
    (p.tasks || []).map((t) => ({
      ...t,
      completed: Boolean(t.completed),
    }))
  );
  const next = { ...p, tasks, habits, offline: false };
  // Keep the original fetch time — refreshing `at` here made the soft TTL
  // slide forever under frequent reads, so Google was never re-fetched.
  payloadCache = { at: payloadCache.at, payload: next };
  return next;
}

/**
 * Last known payload without triggering a fetch (for reminder rescheduling
 * after local mutations). Null when nothing is cached yet.
 */
function peekWidgetData() {
  return payloadCache ? payloadCache.payload : null;
}

/**
 * Once per local calendar day: clear completed flags on Habits (Google or mock).
 * Streak store is untouched — only sticky Google/mock completed status resets.
 * @returns {Promise<{
 *   ok: boolean,
 *   reset: boolean,
 *   reason?: string,
 *   mode?: string,
 *   count?: number,
 *   message?: string,
 * }>}
 */
async function resetCompletedHabitsForNewDay() {
  if (habitsResetInFlight) return habitsResetInFlight;

  habitsResetInFlight = (async () => {
    const settings = loadSettings();
    if (settings.dailyHabitsReset === false) {
      return { ok: true, reset: false, reason: 'disabled' };
    }
    const today = localDateKey();
    if (settings.lastHabitsResetDate === today) {
      return { ok: true, reset: false, reason: 'already' };
    }

    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const count = resetMockHabitsCompleted();
      saveSettings({ lastHabitsResetDate: today });
      invalidatePayloadCache();
      return { ok: true, reset: true, mode: 'mock', count };
    }

    try {
      const auth = await getAuthorizedClient({ interactive: false });
      if (!auth) {
        return { ok: false, reset: false, reason: 'auth' };
      }

      const tasksApi = getGoogle().tasks({ version: 'v1', auth });
      const listId = await resolveListId(tasksApi, config.habitsListName);
      if (!listId) {
        // Persist so we don't hammer the API when the Habits list is missing.
        saveSettings({ lastHabitsResetDate: today });
        return { ok: true, reset: false, reason: 'no_list' };
      }

      const all = await listAllTaskItems(tasksApi, listId, { showHidden: true });
      const items = all.filter((i) => i && i.id && i.status === 'completed');

      await Promise.all(
        items.map((item) =>
          tasksApi.tasks.patch({
            tasklist: listId,
            task: item.id,
            requestBody: { status: 'needsAction', completed: null },
          })
        )
      );
      const resetIds = new Set(items.map((item) => item.id));
      const cached = resetIds.size ? loadOfflineCache() : null;
      if (cached) {
        // One write for the whole batch instead of one per habit.
        saveOfflineCache({
          ...cached,
          mode: 'google',
          habits: (cached.habits || []).map((h) =>
            h && resetIds.has(h.id) ? { ...h, status: 'needsAction', completed: false } : h
          ),
        });
      }

      saveSettings({ lastHabitsResetDate: today });
      invalidateListCache();
      invalidatePayloadCache();
      return { ok: true, reset: true, mode: 'google', count: items.length };
    } catch (err) {
      const mapped = normalizeGoogleAuthError(err);
      console.warn('[habits-reset]', mapped.message);
      return {
        ok: false,
        reset: false,
        reason: isInvalidGrantError(err) ? 'auth' : 'error',
        message: mapped.message,
      };
    }
  })().finally(() => {
    habitsResetInFlight = null;
  });

  return habitsResetInFlight;
}

async function getWidgetDataUncached(force) {
  // Day rollover before serving data so habits aren't stuck completed in Google.
  try {
    await resetCompletedHabitsForNewDay();
  } catch (err) {
    console.warn(
      '[habits-reset]',
      err && err.message ? err.message : err
    );
  }

  if (!force) {
    const warm = fromPayloadCache();
    if (warm) return warm;
  }

  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    const mock = getMockPayload(config);
    mock.tasks = decorateTasks(mock.tasks);
    mock.habits = withHabits(mock.habits);
    setPayloadCache(mock);
    return mock;
  }
  try {
    return await fetchLivePayload(config);
  } catch (err) {
    const mapped = normalizeGoogleAuthError(err);
    console.error('Google Tasks fetch failed:', mapped.message);
    if (isInvalidGrantError(err) || mapped.code === 'invalid_grant') {
      invalidateListCache();
      invalidatePayloadCache();
      return {
        mode: 'needs_auth',
        tasksListName: config.tasksListName,
        habitsListName: config.habitsListName,
        accentColor: config.accentColor,
        tasks: [],
        habits: [],
        offline: false,
        message: mapped.message,
      };
    }
    const offline = offlineFromCache(config, mapped.message);
    if (offline) {
      setPayloadCache(offline);
      return offline;
    }
    return {
      mode: 'google',
      tasksListName: config.tasksListName,
      habitsListName: config.habitsListName,
      accentColor: config.accentColor,
      tasksListFound: true,
      habitsListFound: true,
      tasks: [],
      habits: [],
      offline: true,
      warning: mapped.message || 'Нет сети и нет локального кэша',
    };
  }
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function getWidgetData(opts = {}) {
  const force = Boolean(opts && opts.force);
  if (dataInFlight && !force) return dataInFlight;
  if (force && dataInFlight) {
    // Wait for in-flight then force-refresh so callers don't race
    try {
      await dataInFlight;
    } catch {
      /* ignore */
    }
  }
  dataInFlight = getWidgetDataUncached(force).finally(() => {
    dataInFlight = null;
  });
  return dataInFlight;
}

async function loginGoogle() {
  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    throw new Error('Сначала сохраните Google Client ID и Secret в настройках виджета');
  }
  invalidateListCache();
  invalidatePayloadCache();
  try {
    await getAuthorizedClient({ interactive: true });
    return await fetchLivePayload(config);
  } catch (err) {
    throw normalizeGoogleAuthError(err);
  }
}

/**
 * Find item fields from warm caches to avoid tasks.get before patch.
 */
function lookupCachedItem(listKind, taskId) {
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const fromMem = payloadCache && payloadCache.payload && payloadCache.payload[key];
  if (Array.isArray(fromMem)) {
    const hit = fromMem.find((i) => i && i.id === taskId);
    if (hit) return hit;
  }
  const offline = loadOfflineCache();
  if (offline && Array.isArray(offline[key])) {
    return offline[key].find((i) => i && i.id === taskId) || null;
  }
  return null;
}

/**
 * Build the item patch returned after a completion toggle (and optional reschedule).
 * @param {'tasks' | 'habits'} listKind
 * @param {object | null} cached
 * @param {boolean} completed
 * @param {{ due?: string | null, notes?: string, status?: string }} [overrides]
 * @param {object | null} [stats]
 */
function buildCompletedItemPatch(listKind, cached, completed, overrides = {}, stats = null) {
  const status = overrides.status || (completed ? 'completed' : 'needsAction');
  const due =
    Object.prototype.hasOwnProperty.call(overrides, 'due')
      ? overrides.due
      : cached && cached.due
        ? cached.due
        : null;
  const notes =
    Object.prototype.hasOwnProperty.call(overrides, 'notes')
      ? overrides.notes
      : cached && cached.notes
        ? cached.notes
        : '';
  const dueKind = dueKindFor(due, completed);
  const dueTime = resolveTaskTime({ due, notes });
  const recurrence = parseRecurrence(notes);
  const meta =
    formatMeta({ due, notes, status }) ||
    (completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');
  return {
    status,
    completed,
    due,
    dueKind,
    dueTime,
    recurrence,
    notes,
    meta: listKind === 'habits' ? (cached && cached.meta) || 'Daily' : meta,
    ...(stats
      ? {
          streak: stats.streak,
          week: stats.week,
          ring: stats.ring,
          completedToday: stats.completedToday,
          completedDates: stats.completedDates,
        }
      : {}),
  };
}

/**
 * Recurrence from notes marker, with cached.recurrence as fallback.
 * @param {object | null | undefined} item
 * @returns {'daily' | 'weekdays' | 'weekly' | null}
 */
function recurrenceFromItem(item) {
  if (!item) return null;
  const fromNotes = parseRecurrence(item.notes);
  if (fromNotes) return fromNotes;
  const r = item.recurrence;
  if (r === 'daily' || r === 'weekdays' || r === 'weekly') return r;
  return null;
}

async function setTaskCompleted(listKind, taskId, completed) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  const flightKey = `set:${listKind}:${taskId}`;
  const queued = completionInFlight.get(flightKey);
  // Same target state already in flight → share it. The opposite state (quick
  // check → uncheck) used to get the pending result back and was silently
  // dropped; now it runs after the pending one so Google sees clicks in order.
  if (queued && queued.completed === completed) return queued.run;
  const after = queued ? queued.run.catch(() => {}) : Promise.resolve();

  const run = after.then(async () => {
    const config = loadConfig();
    let cached = lookupCachedItem(listKind, taskId);
    // Recurring tasks: stay open and roll due forward (keeps id / reminders / nesting).
    let recurrence = listKind === 'tasks' && completed ? recurrenceFromItem(cached) : null;

    if (!hasGoogleCredentials()) {
      // Cold payload cache: mock store still has notes / due.
      if (listKind === 'tasks' && completed && !recurrence) {
        const mockItem = getMockItem(listKind, taskId);
        if (mockItem) {
          cached = { ...(cached || {}), ...mockItem };
          recurrence = recurrenceFromItem(cached);
        }
      }
      if (recurrence) {
        const nextDue = nextOccurrenceDue(cached && cached.due, recurrence);
        const result = setMockCompleted(listKind, taskId, false, { due: nextDue });
        const itemPatch = buildCompletedItemPatch(
          listKind,
          cached,
          false,
          { due: nextDue, status: 'needsAction' },
          result.stats || null
        );
        patchPayloadCache(listKind, taskId, itemPatch);
        return {
          ...result,
          rescheduled: true,
          item: { id: taskId, ...itemPatch },
        };
      }
      const result = setMockCompleted(listKind, taskId, completed);
      const itemPatch = buildCompletedItemPatch(
        listKind,
        cached,
        completed,
        {},
        result.stats || null
      );
      patchPayloadCache(listKind, taskId, itemPatch);
      return { ...result, item: { id: taskId, ...itemPatch } };
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    // Cold cache: one tasks.get so we don't permanently complete a recurring task.
    if (listKind === 'tasks' && completed && !cached) {
      try {
        const existing = await tasksApi.tasks.get({
          tasklist: listId,
          task: taskId,
        });
        const data = (existing && existing.data) || {};
        cached = {
          id: taskId,
          notes: data.notes || '',
          due: data.due || null,
          parent: data.parent || null,
          position: data.position || '',
          status: data.status || 'needsAction',
          completed: data.status === 'completed',
        };
        recurrence = recurrenceFromItem(cached);
      } catch (err) {
        console.warn(
          '[setTaskCompleted] cache miss fetch failed:',
          err && err.message ? err.message : err
        );
      }
    }

    const reschedule = Boolean(recurrence);

    /** @type {Record<string, any>} */
    const requestBody = {};
    let nextDue = null;
    if (reschedule) {
      nextDue = nextOccurrenceDue(cached && cached.due, recurrence);
      requestBody.status = 'needsAction';
      requestBody.completed = null;
      requestBody.due = nextDue;
    } else {
      requestBody.status = completed ? 'completed' : 'needsAction';
      requestBody.completed = completed ? new Date().toISOString() : null;
    }

    await tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody,
    });

    let stats = null;
    if (listKind === 'habits') {
      stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
    }

    const effectiveCompleted = reschedule ? false : completed;
    const itemPatch = buildCompletedItemPatch(
      listKind,
      cached,
      effectiveCompleted,
      reschedule ? { due: nextDue, status: 'needsAction' } : {},
      stats
    );

    patchOfflineCache(listKind, taskId, itemPatch);
    patchPayloadCache(listKind, taskId, itemPatch);

    return {
      ok: true,
      mode: 'google',
      stats,
      rescheduled: reschedule,
      item: { id: taskId, ...itemPatch },
    };
  })
    .catch(rejectGoogleAuth)
    .finally(() => {
      const current = completionInFlight.get(flightKey);
      if (current && current.run === run) completionInFlight.delete(flightKey);
    });

  completionInFlight.set(flightKey, { completed, run });
  return run;
}

async function createItem(listKind, title, opts = {}) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  let trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  if (trimmed.length > MAX_TITLE_LEN) trimmed = trimmed.slice(0, MAX_TITLE_LEN);
  const parentId =
    opts && typeof opts.parentId === 'string' && opts.parentId.trim()
      ? opts.parentId.trim()
      : null;

  const flightKey = `create:${listKind}:${parentId || ''}:${trimmed.toLowerCase()}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = addMockItem(listKind, trimmed, { parentId });
      if (result.item) {
        const item =
          listKind === 'habits'
            ? withHabits([result.item])[0]
            : decorateTasks([result.item])[0];
        result.item = item;
        // Full re-nest for tasks when adding a child
        if (listKind === 'tasks' && parentId) invalidatePayloadCache();
        else patchPayloadCache(listKind, item.id, null, item);
      } else {
        invalidatePayloadCache();
      }
      return result;
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    /** @type {Record<string, string>} */
    const body = {
      title: trimmed,
      status: 'needsAction',
    };
    // `parent` is a query param only (Task.parent is output-only on the resource).

    const res = await tasksApi.tasks.insert({
      tasklist: listId,
      parent: parentId || undefined,
      requestBody: body,
    });

    let mapped = mapTask(res.data);
    if (parentId && !mapped.parent) mapped.parent = parentId;
    if (listKind === 'habits') {
      mapped = withHabits([mapped])[0];
    }

    if (listKind === 'tasks' && parentId) {
      invalidatePayloadCache();
      invalidateListCache();
    } else {
      patchOfflineCache(listKind, mapped.id, null, mapped);
      patchPayloadCache(listKind, mapped.id, null, mapped);
    }

    return { ok: true, mode: 'google', item: mapped };
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

/**
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string | { title?: string, notes?: string, dueTime?: string | null, recurrence?: string | null }} patchOrTitle
 */
async function updateItem(listKind, taskId, patchOrTitle) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  /** @type {{ title?: string, notes?: string, dueTime?: string | null, recurrence?: string | null }} */
  let patch = {};
  if (typeof patchOrTitle === 'string') {
    patch.title = patchOrTitle;
  } else if (patchOrTitle && typeof patchOrTitle === 'object') {
    patch = { ...patchOrTitle };
  }

  /** @type {string | null | undefined} undefined = no dueTime change */
  let pendingDueTime;
  /** @type {'daily' | 'weekdays' | 'weekly' | null | undefined} */
  let pendingRecurrence;

  // Google Tasks due is date-only UTC — persist clock time via notes marker.
  if (Object.prototype.hasOwnProperty.call(patch, 'dueTime')) {
    const hm = normalizeDueTimeInput(patch.dueTime);
    delete patch.dueTime;
    let currentNotes = typeof patch.notes === 'string' ? patch.notes : null;
    if (currentNotes === null) {
      if (!hasGoogleCredentials()) {
        const mockItem = getMockItem(listKind, taskId);
        if (!mockItem) throw new Error('Элемент не найден');
        currentNotes = mockItem.notes || '';
      } else {
        const cached = lookupCachedItem(listKind, taskId);
        if (cached && typeof cached.notes === 'string') currentNotes = cached.notes;
      }
    }
    if (currentNotes !== null) {
      patch.notes = applyDueTimeToNotes(currentNotes, hm);
    } else {
      pendingDueTime = hm;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'recurrence')) {
    const rule = normalizeRecurrenceInput(patch.recurrence);
    delete patch.recurrence;
    let currentNotes = typeof patch.notes === 'string' ? patch.notes : null;
    if (currentNotes === null) {
      if (!hasGoogleCredentials()) {
        const mockItem = getMockItem(listKind, taskId);
        if (!mockItem) throw new Error('Элемент не найден');
        currentNotes = mockItem.notes || '';
      } else {
        const cached = lookupCachedItem(listKind, taskId);
        if (cached && typeof cached.notes === 'string') currentNotes = cached.notes;
      }
    }
    if (currentNotes !== null) {
      patch.notes = applyRecurrenceToNotes(currentNotes, rule);
    } else {
      pendingRecurrence = rule;
    }
  }

  /** @type {Record<string, string>} */
  const body = {};
  /** @type {Record<string, any>} */
  const itemPatch = {};

  if (typeof patch.title === 'string') {
    let trimmed = patch.title.trim();
    if (!trimmed) throw new Error('Введите название');
    if (trimmed.length > MAX_TITLE_LEN) trimmed = trimmed.slice(0, MAX_TITLE_LEN);
    body.title = trimmed;
    itemPatch.title = trimmed;
  }
  if (typeof patch.notes === 'string') {
    let notes = patch.notes;
    if (notes.length > MAX_NOTES_LEN) notes = notes.slice(0, MAX_NOTES_LEN);
    body.notes = notes;
    itemPatch.notes = notes;
  }
  if (
    !Object.keys(body).length &&
    pendingDueTime === undefined &&
    pendingRecurrence === undefined
  ) {
    throw new Error('Нечего обновлять');
  }

  const flightKey = `update:${listKind}:${taskId}:${[
    ...Object.keys(body).sort(),
    pendingDueTime !== undefined ? 'dueTime' : '',
    pendingRecurrence !== undefined ? 'recurrence' : '',
  ]
    .filter(Boolean)
    .join(',')}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = updateMockItem(listKind, taskId, {
        ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
        ...(typeof patch.notes === 'string' ? { notes: patch.notes } : {}),
      });
      if (result.item) {
        const item =
          listKind === 'habits'
            ? withHabits([result.item])[0]
            : decorateTasks([result.item])[0];
        result.item = item;
        const dueTime = resolveTaskTime(item);
        patchPayloadCache(listKind, taskId, {
          title: item.title,
          notes: item.notes || '',
          meta: item.meta,
          dueTime,
          recurrence: item.recurrence || null,
        });
      } else {
        invalidatePayloadCache();
      }
      return result;
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    // Cache miss: fetch current notes before applying dueTime/recurrence so we don't wipe them.
    if (
      (pendingDueTime !== undefined || pendingRecurrence !== undefined) &&
      body.notes === undefined
    ) {
      const existing = await tasksApi.tasks.get({
        tasklist: listId,
        task: taskId,
      });
      let currentNotes = (existing && existing.data && existing.data.notes) || '';
      if (pendingDueTime !== undefined) {
        currentNotes = applyDueTimeToNotes(currentNotes, pendingDueTime);
      }
      if (pendingRecurrence !== undefined) {
        currentNotes = applyRecurrenceToNotes(currentNotes, pendingRecurrence);
      }
      body.notes =
        currentNotes.length > MAX_NOTES_LEN
          ? currentNotes.slice(0, MAX_NOTES_LEN)
          : currentNotes;
      itemPatch.notes = body.notes;
    }

    if (!Object.keys(body).length) throw new Error('Нечего обновлять');

    await tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody: body,
    });

    // Refresh meta/dueTime/recurrence when notes change.
    if (Object.prototype.hasOwnProperty.call(itemPatch, 'notes')) {
      const cached = lookupCachedItem(listKind, taskId);
      const merged = {
        ...(cached || {}),
        ...itemPatch,
        status: cached && cached.completed ? 'completed' : 'needsAction',
      };
      itemPatch.dueTime = resolveTaskTime(merged);
      itemPatch.recurrence = parseRecurrence(merged.notes);
      itemPatch.meta =
        formatMeta(merged) ||
        (merged.completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');
    }

    patchOfflineCache(listKind, taskId, itemPatch);
    patchPayloadCache(listKind, taskId, itemPatch);

    return { ok: true, mode: 'google', item: { id: taskId, ...itemPatch } };
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

async function deleteItem(listKind, taskId) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  const flightKey = `delete:${listKind}:${taskId}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = deleteMockItem(listKind, taskId);
      patchPayloadCache(listKind, taskId, null);
      return result;
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    await tasksApi.tasks.delete({
      tasklist: listId,
      task: taskId,
    });

    if (listKind === 'habits') removeHabit(taskId);

    patchOfflineCache(listKind, taskId, null);
    patchPayloadCache(listKind, taskId, null);

    return { ok: true, mode: 'google' };
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

/**
 * Drop completed tasks from in-memory + offline caches after a clear.
 * @param {(t: any) => boolean} isCleared
 */
function dropClearedFromCaches(isCleared) {
  if (payloadCache && payloadCache.payload && Array.isArray(payloadCache.payload.tasks)) {
    const prev = payloadCache.payload;
    payloadCache = {
      at: payloadCache.at,
      payload: { ...prev, tasks: prev.tasks.filter((t) => !(t && isCleared(t))) },
    };
  }
  const cached = loadOfflineCache();
  if (cached) {
    saveOfflineCache({
      ...cached,
      mode: 'google',
      tasks: (cached.tasks || []).filter((t) => !(t && isCleared(t))),
    });
  }
}

/**
 * Completed tasks that are safe to delete, subtasks first. A completed parent
 * with open subtasks is skipped: Google deletes children with their parent.
 * @param {Array<{ id?: string, parent?: string | null, status?: string, completed?: boolean }>} items
 * @returns {{ toDelete: any[], skipped: any[] }}
 */
function pickDeletableCompleted(items) {
  const isDone = (t) => t.status === 'completed' || t.completed === true;
  const list = (items || []).filter((t) => t && t.id);
  const parentsWithOpenKids = new Set(
    list.filter((t) => t.parent && !isDone(t)).map((t) => t.parent)
  );
  const done = list.filter(isDone);
  const skipped = done.filter((t) => parentsWithOpenKids.has(t.id));
  const deletable = done.filter((t) => !parentsWithOpenKids.has(t.id));
  // Children before parents so a parent delete never races its own subtasks.
  const toDelete = [...deletable.filter((t) => t.parent), ...deletable.filter((t) => !t.parent)];
  return { toDelete, skipped };
}

/** Run async jobs with a small concurrency cap (Google Tasks rate limits). */
async function runLimited(items, limit, job) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await job(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Delete all completed tasks from the Tasks list (incl. ones already hidden).
 * tasks.clear only marks them hidden — the Google Tasks app still lists them
 * under «Выполненные», so the button looked like it did nothing there.
 * @returns {Promise<{ ok: boolean, mode: string, removedIds: string[], skipped: number }>}
 */
async function clearCompletedTasks() {
  const flightKey = 'clear:tasks';
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const store = getMockPayload(config).tasks;
      const { toDelete, skipped } = pickDeletableCompleted(store);
      const result = clearMockCompletedTasks(toDelete.map((t) => t.id));
      const removed = new Set(result.removedIds);
      dropClearedFromCaches((t) => removed.has(t.id));
      return { ...result, skipped: skipped.length };
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listId = await resolveListId(tasksApi, config.tasksListName);
    if (!listId) throw new Error(`Список «${config.tasksListName}» не найден`);

    const all = await listAllTaskItems(tasksApi, listId, { showHidden: true });
    const { toDelete, skipped } = pickDeletableCompleted(all);

    // Subtasks first (they're ordered first), then their parents.
    const removed = new Set();
    const children = toDelete.filter((t) => t.parent);
    const roots = toDelete.filter((t) => !t.parent);
    for (const group of [children, roots]) {
      await runLimited(group, 5, async (t) => {
        try {
          await tasksApi.tasks.delete({ tasklist: listId, task: t.id });
        } catch (err) {
          // Already gone (deleted elsewhere / with its parent) counts as removed.
          const code = err && (err.code || (err.response && err.response.status));
          if (code !== 404 && code !== 410) throw err;
        }
        removed.add(t.id);
      });
    }

    dropClearedFromCaches((t) => removed.has(t.id));
    return { ok: true, mode: 'google', removedIds: [...removed], skipped: skipped.length };
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
      mutationInFlight.delete(flightKey);
    });

  mutationInFlight.set(flightKey, run);
  return run;
}

/**
 * Previous sibling for tasks.move — never the parent row, and only an item
 * that shares the same parent (roots share parent=null).
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string[]} orderedIds
 * @param {string | null} [hintPreviousId]
 * @returns {string | null}
 */
function resolveMovePreviousSibling(listKind, taskId, orderedIds, hintPreviousId) {
  const moved = lookupCachedItem(listKind, taskId);
  const parent = (moved && moved.parent) || null;
  const ids = Array.isArray(orderedIds) ? orderedIds : [];
  const idx = ids.indexOf(taskId);

  const isSibling = (id) => {
    if (!id || id === taskId) return false;
    if (parent && id === parent) return false;
    const item = lookupCachedItem(listKind, id);
    if (!item) return false;
    return (item.parent || null) === parent;
  };

  if (hintPreviousId && isSibling(hintPreviousId)) return hintPreviousId;

  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const id = ids[i];
    if (parent && id === parent) return null;
    if (isSibling(id)) return id;
  }
  return null;
}

/**
 * Move a task/habit within its list (Google tasks.move) or reorder mock store.
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string | null} previousId  sibling that should precede taskId (null = top)
 * @param {string[]} orderedIds       full visible order after drop (for caches)
 */
async function moveItem(listKind, taskId, previousId, orderedIds) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }
  const ids = Array.isArray(orderedIds)
    ? orderedIds.filter((id) => typeof id === 'string' && id)
    : [];
  if (!ids.length || !ids.includes(taskId)) {
    throw new Error('Некорректный порядок');
  }
  const prevHint =
    previousId == null || previousId === ''
      ? null
      : String(previousId);
  if (prevHint && prevHint === taskId) {
    throw new Error('Некорректная позиция');
  }

  const flightKey = `move:${listKind}:${taskId}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = reorderMockItems(listKind, ids);
      const mock = getMockPayload(config);
      mock.tasks = decorateTasks(mock.tasks);
      mock.habits = withHabits(mock.habits);
      setPayloadCache(mock);
      return {
        ok: true,
        mode: 'mock',
        orderedIds: (result.orderedIds || ids).slice(),
      };
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    const cached = lookupCachedItem(listKind, taskId);
    const prev = resolveMovePreviousSibling(listKind, taskId, ids, prevHint);

    const moveParams = {
      tasklist: listId,
      task: taskId,
    };
    if (prev) moveParams.previous = prev;
    // Keep existing nesting; omit parent for roots so Google does not reparent.
    if (cached && cached.parent) moveParams.parent = cached.parent;

    const res = await tasksApi.tasks.move(moveParams);
    const movedPatch = {
      id: taskId,
      position: (res && res.data && res.data.position) || '',
      parent: (res && res.data && res.data.parent) || (cached && cached.parent) || null,
    };

    reorderOfflineCache(listKind, ids, movedPatch);
    reorderPayloadCache(listKind, ids, movedPatch);
    // Drop soft TTL so next getData picks up moved order if cache was stale-shaped
    if (payloadCache) payloadCache.at = Date.now();

    return {
      ok: true,
      mode: 'google',
      orderedIds: ids,
      item: movedPatch,
    };
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

module.exports = {
  getWidgetData,
  peekWidgetData,
  loginGoogle,
  setTaskCompleted,
  createItem,
  updateItem,
  deleteItem,
  clearCompletedTasks,
  moveItem,
  invalidateListCache,
  invalidatePayloadCache,
  clearOfflineCache,
  resolveTaskTime,
  resolveTaskDueAt,
  normalizeDueTimeInput,
  applyDueTimeToNotes,
  parseRecurrence,
  applyRecurrenceToNotes,
  nextOccurrenceDue,
  resetCompletedHabitsForNewDay,
};
