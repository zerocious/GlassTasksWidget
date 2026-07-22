'use strict';

const { getAuthorizedClient } = require('./google-auth');
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
/** @type {Promise<any> | null} */
let habitsResetInFlight = null;

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

function formatMeta(task) {
  // Time is shown as a row chip (dueTime); meta stays date / notes preview only.
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
      .find((l) => l && !MANAGED_TIME_LINE_RE.test(l));
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
  return {
    id: item.id,
    title: item.title || '(без названия)',
    notes: item.notes || '',
    due,
    dueKind,
    dueTime,
    status: item.status || 'needsAction',
    completed,
    position: item.position || '',
    parent: item.parent || null,
    meta: formatMeta(item) || (completed ? 'Done' : 'Task'),
  };
}

/**
 * Nest children under parents while preserving relative sibling order.
 * @param {Array<{ id: string, parent?: string | null }>} tasks
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
  /** @type {typeof tasks} */
  const out = [];
  const walk = (list) => {
    for (const t of list) {
      out.push(t);
      const kids = children.get(t.id);
      if (kids && kids.length) walk(kids);
    }
  };
  walk(roots);
  return out;
}

/**
 * Open first, then up to 5 completed — preserve relative order within each group
 * (Google Tasks list order / manual DnD), nest subtasks under parents.
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
      const meta =
        t.due || dueTime || !t.meta
          ? formatMeta({ ...t, status: t.completed ? 'completed' : 'needsAction' }) ||
            (t.completed ? 'Done' : 'Task')
          : t.meta;
      return { ...t, dueKind, dueTime, meta };
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

async function listTasks(tasksApi, listId) {
  if (!listId) return [];
  const res = await tasksApi.tasks.list({
    tasklist: listId,
    showCompleted: true,
    showHidden: false,
    maxResults: 50,
  });
  const items = res.data.items || [];
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
  // Preserve Google/manual order; only partition open vs done for today.
  const open = enriched.filter((h) => !h.completed);
  const done = enriched.filter((h) => h.completed);
  return [...open, ...done];
}

/** List habits without the tasks "open + 5 done" truncation. */
async function listHabitTasks(tasksApi, listId) {
  if (!listId) return [];
  const res = await tasksApi.tasks.list({
    tasklist: listId,
    showCompleted: true,
    showHidden: false,
    maxResults: 50,
  });
  return (res.data.items || []).map(mapTask);
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
  setPayloadCache(next);
  return next;
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

      const res = await tasksApi.tasks.list({
        tasklist: listId,
        showCompleted: true,
        showHidden: true,
        maxResults: 100,
      });
      const items = (res.data.items || []).filter(
        (i) => i && i.id && i.status === 'completed'
      );

      for (const item of items) {
        await tasksApi.tasks.patch({
          tasklist: listId,
          task: item.id,
          requestBody: { status: 'needsAction', completed: null },
        });
        patchOfflineCache('habits', item.id, {
          status: 'needsAction',
          completed: false,
        });
      }

      saveSettings({ lastHabitsResetDate: today });
      invalidateListCache();
      invalidatePayloadCache();
      return { ok: true, reset: true, mode: 'google', count: items.length };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[habits-reset]', msg);
      return { ok: false, reset: false, reason: 'error', message: msg };
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
    console.error('Google Tasks fetch failed:', err.message);
    const offline = offlineFromCache(config, err.message);
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
      warning: err.message || 'Нет сети и нет локального кэша',
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
  await getAuthorizedClient({ interactive: true });
  return fetchLivePayload(config);
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

async function setTaskCompleted(listKind, taskId, completed) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  const flightKey = `set:${listKind}:${taskId}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const cached = lookupCachedItem(listKind, taskId);
      const result = setMockCompleted(listKind, taskId, completed);
      const status = completed ? 'completed' : 'needsAction';
      const due = cached && cached.due ? cached.due : null;
      const notes = cached && cached.notes ? cached.notes : '';
      const dueKind = dueKindFor(due, completed);
      const dueTime = resolveTaskTime({ due, notes });
      const meta =
        formatMeta({ due, notes, status }) ||
        (completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');
      const itemPatch = {
        status,
        completed,
        dueKind,
        dueTime,
        meta: listKind === 'habits' ? (cached && cached.meta) || 'Daily' : meta,
        ...(result.stats
          ? {
              streak: result.stats.streak,
              week: result.stats.week,
              ring: result.stats.ring,
              completedToday: result.stats.completedToday,
            }
          : {}),
      };
      patchPayloadCache(listKind, taskId, itemPatch);
      return { ...result, item: { id: taskId, ...itemPatch } };
    }

    const auth = await getAuthorizedClient({ interactive: false });
    if (!auth) throw new Error('Не авторизован');

    const tasksApi = getGoogle().tasks({ version: 'v1', auth });
    const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
    const listId = await resolveListId(tasksApi, listName);
    if (!listId) throw new Error(`Список «${listName}» не найден`);

    const cached = lookupCachedItem(listKind, taskId);
    const status = completed ? 'completed' : 'needsAction';

    // Patch-only: skip redundant tasks.get (saves one round-trip per toggle)
    const requestBody = { status };
    if (completed) requestBody.completed = new Date().toISOString();
    else requestBody.completed = null;

    await tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody,
    });

    let stats = null;
    if (listKind === 'habits') {
      stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
    }

    const due = cached && cached.due ? cached.due : null;
    const notes = cached && cached.notes ? cached.notes : '';
    const dueKind = dueKindFor(due, completed);
    const dueTime = resolveTaskTime({ due, notes });
    const meta =
      formatMeta({ due, notes, status }) ||
      (completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');

    const itemPatch = {
      status,
      completed,
      dueKind,
      dueTime,
      meta: listKind === 'habits' ? (cached && cached.meta) || 'Daily' : meta,
      ...(stats
        ? {
            streak: stats.streak,
            week: stats.week,
            ring: stats.ring,
            completedToday: stats.completedToday,
          }
        : {}),
    };

    patchOfflineCache(listKind, taskId, itemPatch);
    patchPayloadCache(listKind, taskId, itemPatch);

    return {
      ok: true,
      mode: 'google',
      stats,
      item: { id: taskId, ...itemPatch },
    };
  })().finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
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
  })().finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

/**
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string | { title?: string, notes?: string, dueTime?: string | null }} patchOrTitle
 */
async function updateItem(listKind, taskId, patchOrTitle) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  /** @type {{ title?: string, notes?: string, dueTime?: string | null }} */
  let patch = {};
  if (typeof patchOrTitle === 'string') {
    patch.title = patchOrTitle;
  } else if (patchOrTitle && typeof patchOrTitle === 'object') {
    patch = { ...patchOrTitle };
  }

  /** @type {string | null | undefined} undefined = no dueTime change */
  let pendingDueTime;

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
  if (!Object.keys(body).length && pendingDueTime === undefined) {
    throw new Error('Нечего обновлять');
  }

  const flightKey = `update:${listKind}:${taskId}:${[
    ...Object.keys(body).sort(),
    pendingDueTime !== undefined ? 'dueTime' : '',
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

    // Cache miss: fetch current notes before applying dueTime so we don't wipe them.
    if (pendingDueTime !== undefined && body.notes === undefined) {
      const existing = await tasksApi.tasks.get({
        tasklist: listId,
        task: taskId,
      });
      const currentNotes = (existing && existing.data && existing.data.notes) || '';
      const notes = applyDueTimeToNotes(currentNotes, pendingDueTime);
      body.notes = notes.length > MAX_NOTES_LEN ? notes.slice(0, MAX_NOTES_LEN) : notes;
      itemPatch.notes = body.notes;
    }

    if (!Object.keys(body).length) throw new Error('Нечего обновлять');

    await tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody: body,
    });

    // Refresh meta/dueTime when notes change (time may live in notes).
    if (Object.prototype.hasOwnProperty.call(itemPatch, 'notes')) {
      const cached = lookupCachedItem(listKind, taskId);
      const merged = {
        ...(cached || {}),
        ...itemPatch,
        status: cached && cached.completed ? 'completed' : 'needsAction',
      };
      itemPatch.dueTime = resolveTaskTime(merged);
      itemPatch.meta =
        formatMeta(merged) ||
        (merged.completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');
    }

    patchOfflineCache(listKind, taskId, itemPatch);
    patchPayloadCache(listKind, taskId, itemPatch);

    return { ok: true, mode: 'google', item: { id: taskId, ...itemPatch } };
  })().finally(() => {
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
  })().finally(() => {
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

    reorderOfflineCache(listKind, ids);
    reorderPayloadCache(listKind, ids, movedPatch);
    // Drop soft TTL so next getData picks up moved order if cache was stale-shaped
    if (payloadCache) payloadCache.at = Date.now();

    return {
      ok: true,
      mode: 'google',
      orderedIds: ids,
      item: movedPatch,
    };
  })().finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

module.exports = {
  getWidgetData,
  loginGoogle,
  setTaskCompleted,
  createItem,
  updateItem,
  deleteItem,
  moveItem,
  invalidateListCache,
  invalidatePayloadCache,
  clearOfflineCache,
  resolveTaskTime,
  resolveTaskDueAt,
  normalizeDueTimeInput,
  applyDueTimeToNotes,
  resetCompletedHabitsForNewDay,
};
