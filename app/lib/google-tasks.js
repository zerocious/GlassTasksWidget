'use strict';

const { google } = require('googleapis');
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

/** @type {{ at: number, byTitle: Map<string, string> } | null} */
let listCache = null;
/** @type {Promise<any> | null} */
let dataInFlight = null;

function localDateKey(date = new Date()) {
  return todayIso(date);
}

/** Google Tasks due is date-only UTC midnight — compare by calendar day in local TZ. */
function dueDateKey(due) {
  if (!due) return null;
  try {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) return null;
    // Prefer UTC Y-M-D for typical Google all-day dues
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
      // Always recompute dueKind (offline cache may be from another day)
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

function withHabits(habitsRaw) {
  return enrichHabits(
    habitsRaw.map((h) => ({
      ...h,
      meta: h.meta && h.meta !== 'Task' ? h.meta : 'Daily',
    }))
  ).map((h) => ({
    ...h,
    completed: h.completedToday || h.completed,
  }));
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

  const tasksApi = google.tasks({ version: 'v1', auth });
  const listMap = await getListMap(tasksApi);
  const tasksListId = listMap.get(String(config.tasksListName || '').trim()) || null;
  const habitsListId = listMap.get(String(config.habitsListName || '').trim()) || null;

  const [tasks, habitsRawBase] = await Promise.all([
    listTasks(tasksApi, tasksListId),
    listTasks(tasksApi, habitsListId),
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

async function getWidgetDataUncached() {
  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    const mock = getMockPayload(config);
    mock.tasks = decorateTasks(mock.tasks);
    return mock;
  }
  try {
    return await fetchLivePayload(config);
  } catch (err) {
    console.error('Google Tasks fetch failed:', err.message);
    const offline = offlineFromCache(config, err.message);
    if (offline) return offline;
    // Credentials present but no cache — don't silently switch to demo mock
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

async function getWidgetData() {
  if (dataInFlight) return dataInFlight;
  dataInFlight = getWidgetDataUncached().finally(() => {
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
  await getAuthorizedClient({ interactive: true });
  return fetchLivePayload(config);
}

async function setTaskCompleted(listKind, taskId, completed) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  const config = loadConfig();

  if (!hasGoogleCredentials()) {
    return setMockCompleted(listKind, taskId, completed);
  }

  const auth = await getAuthorizedClient({ interactive: false });
  if (!auth) throw new Error('Не авторизован');

  const tasksApi = google.tasks({ version: 'v1', auth });
  const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
  const listId = await resolveListId(tasksApi, listName);
  if (!listId) throw new Error(`Список «${listName}» не найден`);

  const existing = await tasksApi.tasks.get({ tasklist: listId, task: taskId });
  const body = {
    id: existing.data.id,
    title: existing.data.title,
    notes: existing.data.notes,
    status: completed ? 'completed' : 'needsAction',
  };
  if (existing.data.due) body.due = existing.data.due;
  if (completed) body.completed = new Date().toISOString();

  await tasksApi.tasks.update({
    tasklist: listId,
    task: taskId,
    requestBody: body,
  });

  let stats = null;
  if (listKind === 'habits') {
    stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
  }

  const dueKind = dueKindFor(existing.data.due || null, completed);
  patchOfflineCache(listKind, taskId, {
    status: body.status,
    completed,
    due: existing.data.due || null,
    dueKind,
    meta: formatMeta({
      due: existing.data.due,
      notes: existing.data.notes,
      status: body.status,
    }) || (completed ? 'Done' : listKind === 'habits' ? 'Daily' : 'Task'),
    ...(stats
      ? {
          streak: stats.streak,
          week: stats.week,
          ring: stats.ring,
          completedToday: stats.completedToday,
        }
      : {}),
  });

  return { ok: true, mode: 'google', stats };
}

async function createItem(listKind, title) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  let trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  if (trimmed.length > MAX_TITLE_LEN) trimmed = trimmed.slice(0, MAX_TITLE_LEN);

  const config = loadConfig();

  if (!hasGoogleCredentials()) {
    return addMockItem(listKind, trimmed);
  }

  const auth = await getAuthorizedClient({ interactive: false });
  if (!auth) throw new Error('Не авторизован');

  const tasksApi = google.tasks({ version: 'v1', auth });
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

  const mapped = mapTask(res.data);
  if (listKind === 'habits') {
    mapped.meta = 'Daily';
  }

  patchOfflineCache(listKind, mapped.id, null, mapped);

  return { ok: true, mode: 'google', item: mapped };
}

module.exports = {
  getWidgetData,
  loginGoogle,
  setTaskCompleted,
  createItem,
  invalidateListCache,
  clearOfflineCache,
};
