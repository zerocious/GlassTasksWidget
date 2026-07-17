'use strict';

const { getAuthorizedClient } = require('./google-auth');
const { enrichHabits, markCompleted, unmarkCompleted, todayIso } = require('./streak-store');
const { getMockPayload, addMockItem, setMockCompleted } = require('./mock-data');
const { loadConfig, hasGoogleCredentials } = require('./config');
const {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
} = require('./offline-cache');

const MAX_TITLE_LEN = 200;

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

function formatMeta(task) {
  if (task.due) {
    try {
      const d = new Date(task.due);
      const kind = dueKindFor(task.due, task.status === 'completed');
      const dateLabel = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      if (kind === 'overdue') return `Просрочено · ${dateLabel}`;
      if (kind === 'today') return `Сегодня · ${dateLabel}`;
      return dateLabel;
    } catch {
      return 'Срок';
    }
  }
  if (task.notes && String(task.notes).trim()) {
    const line = String(task.notes).trim().split(/\r?\n/)[0];
    return line.length > 40 ? `${line.slice(0, 37)}…` : line;
  }
  return '';
}

function mapTask(item) {
  const completed = item.status === 'completed';
  const due = item.due || null;
  const dueKind = dueKindFor(due, completed);
  return {
    id: item.id,
    title: item.title || '(без названия)',
    notes: item.notes || '',
    due,
    dueKind,
    status: item.status || 'needsAction',
    completed,
    meta: formatMeta(item) || (completed ? 'Done' : 'Task'),
  };
}

function sortTasks(tasks) {
  const rank = { overdue: 0, today: 1, later: 2, null: 3, undefined: 3 };
  const open = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed).slice(0, 5);
  open.sort((a, b) => {
    const ra = rank[a.dueKind] ?? 3;
    const rb = rank[b.dueKind] ?? 3;
    if (ra !== rb) return ra - rb;
    const da = a.due || '';
    const db = b.due || '';
    if (da !== db) return da < db ? -1 : 1;
    return String(a.title).localeCompare(String(b.title));
  });
  return [...open, ...done];
}

function decorateTasks(tasks) {
  return sortTasks(
    tasks.map((t) => {
      const dueKind = dueKindFor(t.due, Boolean(t.completed));
      const meta =
        t.due || !t.meta
          ? formatMeta({ ...t, status: t.completed ? 'completed' : 'needsAction' }) ||
            (t.completed ? 'Done' : 'Task')
          : t.meta;
      return { ...t, dueKind, meta };
    })
  );
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
    list = list.filter((item) => item && item.id !== taskId);
  } else {
    list = list.map((item) =>
      item && item.id === taskId ? { ...item, ...patch } : item
    );
    if (listKind === 'tasks') list = decorateTasks(list);
    else {
      list = list
        .map((h) => ({
          ...h,
          completed: Boolean(h.completedToday != null ? h.completedToday : h.completed),
          status: (h.completedToday != null ? h.completedToday : h.completed)
            ? 'completed'
            : 'needsAction',
        }))
        .sort((a, b) => {
          if (a.completed !== b.completed) return a.completed ? 1 : -1;
          return String(a.title).localeCompare(String(b.title));
        });
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
  return enrichHabits(
    habitsRaw.map((h) => ({
      ...h,
      meta: h.meta && h.meta !== 'Task' ? h.meta : 'Daily',
    }))
  )
    .map((h) => ({
      ...h,
      completed: Boolean(h.completedToday),
      status: h.completedToday ? 'completed' : 'needsAction',
    }))
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return String(a.title).localeCompare(String(b.title));
    });
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
 * Serve warm memory payload when fresh; re-enrich habits for day-rollover correctness.
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
  const next = { ...p, habits, offline: false };
  setPayloadCache(next);
  return next;
}

async function getWidgetDataUncached(force) {
  if (!force) {
    const warm = fromPayloadCache();
    if (warm) return warm;
  }

  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    const mock = getMockPayload(config);
    mock.tasks = decorateTasks(mock.tasks);
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
    throw new Error('Добавьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в файл .env');
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
      const result = setMockCompleted(listKind, taskId, completed);
      invalidatePayloadCache();
      return result;
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
    const meta =
      formatMeta({ due, notes, status }) ||
      (completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task');

    const itemPatch = {
      status,
      completed,
      dueKind,
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

    return { ok: true, mode: 'google', stats };
  })().finally(() => {
    mutationInFlight.delete(flightKey);
  });

  mutationInFlight.set(flightKey, run);
  return run;
}

async function createItem(listKind, title) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  let trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  if (trimmed.length > MAX_TITLE_LEN) trimmed = trimmed.slice(0, MAX_TITLE_LEN);

  const flightKey = `create:${listKind}:${trimmed.toLowerCase()}`;
  if (mutationInFlight.has(flightKey)) return mutationInFlight.get(flightKey);

  const run = (async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = addMockItem(listKind, trimmed);
      if (result.item) {
        const item =
          listKind === 'habits'
            ? withHabits([result.item])[0]
            : decorateTasks([result.item])[0];
        result.item = item;
        patchPayloadCache(listKind, item.id, null, item);
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

    const res = await tasksApi.tasks.insert({
      tasklist: listId,
      requestBody: {
        title: trimmed,
        status: 'needsAction',
      },
    });

    let mapped = mapTask(res.data);
    if (listKind === 'habits') {
      mapped = withHabits([mapped])[0];
    }

    patchOfflineCache(listKind, mapped.id, null, mapped);
    patchPayloadCache(listKind, mapped.id, null, mapped);

    return { ok: true, mode: 'google', item: mapped };
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
  invalidateListCache,
  invalidatePayloadCache,
  clearOfflineCache,
};
