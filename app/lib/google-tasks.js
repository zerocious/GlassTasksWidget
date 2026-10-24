'use strict';

const {
  getAuthorizedClient,
  isInvalidGrantError,
  normalizeGoogleAuthError,
} = require('./google-auth');
const {
  enrichHabits,
  getHabitStats,
  markCompleted,
  unmarkCompleted,
  removeHabit,
} = require('./streak-store');
const { todayIso } = require('./dates');
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
const {
  dueKindFor,
  parseRecurrence,
  normalizeRecurrenceInput,
  applyRecurrenceToNotes,
  nextOccurrenceDue,
  formatMeta,
  normalizeDueTimeInput,
  applyDueTimeToNotes,
  resolveTaskTime,
  resolveTaskDueAt,
  META_TASK,
  META_DONE,
  META_HABIT,
  localizeMeta,
  isPlaceholderMeta,
} = require('./task-parse');
const { loadSettings, saveSettings } = require('./settings-store');
const {
  saveOfflineCache,
  loadOfflineCache,
  clearOfflineCache,
  patchOfflineCache,
  reorderOfflineCache,
} = require('./offline-cache');
const { applyItemPatch, reorderList } = require('./list-ops');
const { retryingTasksClient } = require('./retry');
const { parseQuickAdd } = require('./quick-add');

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
/** @type {Map<string, Promise<any>>} last queued mutation per item (serializes edits). */
const itemQueues = new Map();
/** Bumped when any mutation settles; a fetch that overlapped one must not overwrite caches. */
let mutationGeneration = 0;
let mutationsActive = 0;
/** @type {Promise<any> | null} */
let forcedDataInFlight = null;
/** @type {Promise<any> | null} */
let habitsResetInFlight = null;
/** After a network failure, don't block every data load on another reset attempt. */
let habitsResetRetryAt = 0;
const HABITS_RESET_RETRY_MS = 5 * 60 * 1000;
/** Google Tasks API page size cap and a sanity ceiling on pages per list. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Re-throw Google API failures with a user-safe Russian message when needed. */
function rejectGoogleAuth(err) {
  throw normalizeGoogleAuthError(err);
}

/**
 * Run a mutation with per-item ordering and safe de-duplication.
 * - Same `flightKey` while it is still the latest queued op for the item → share the promise
 *   (double-click). A different op in between breaks the dedupe, so on→off→on ends "on".
 * - Ops on the same `queueKey` run strictly in order, each reading caches the previous one wrote.
 * @template T
 * @param {string} flightKey  identity of this exact request (kind + id + values)
 * @param {string} queueKey   item identity (kind + id)
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function runMutation(flightKey, queueKey, task) {
  const existing = mutationInFlight.get(flightKey);
  if (existing && itemQueues.get(queueKey) === existing) return existing;

  const prev = itemQueues.get(queueKey);
  mutationsActive += 1;
  const run = (async () => {
    if (prev) {
      try {
        await prev;
      } catch {
        /* previous failure doesn't block the next edit */
      }
    }
    return task();
  })()
    .catch(rejectGoogleAuth)
    .finally(() => {
      mutationsActive -= 1;
      mutationGeneration += 1;
      if (mutationInFlight.get(flightKey) === run) mutationInFlight.delete(flightKey);
      if (itemQueues.get(queueKey) === run) itemQueues.delete(queueKey);
    });

  mutationInFlight.set(flightKey, run);
  itemQueues.set(queueKey, run);
  return run;
}

/**
 * Collect every page of a Google list call (`tasks.list`, `tasklists.list`).
 * @param {(params: object) => Promise<{ data: { items?: any[], nextPageToken?: string } }>} listFn
 * @param {object} params
 * @returns {Promise<any[]>}
 */
async function listAllPages(listFn, params) {
  /** @type {any[]} */
  const items = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await listFn({ ...params, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
    const data = (res && res.data) || {};
    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/** Lazy-load the Google client only on first Google API use. */
function getGoogle() {
  return require('@googleapis/tasks');
}

/** Tasks API client whose calls retry rate limits / transient server errors. */
function tasksClient(auth) {
  return retryingTasksClient(getGoogle().tasks({ version: 'v1', auth }));
}

/** Google Tasks `due` for a local YYYY-MM-DD (the API keeps only the date). */
function dueIsoFromKey(key) {
  return `${key}T00:00:00.000Z`;
}

/**
 * @param {unknown} value  'YYYY-MM-DD', or null / '' to clear
 * @returns {string | null}
 */
function normalizeDueKeyInput(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Дата в формате ГГГГ-ММ-ДД');
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error('Некорректная дата');
  }
  return value;
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
    meta: formatMeta(item) || (completed ? META_DONE : META_TASK),
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
            (t.completed ? META_DONE : META_TASK)
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
  const next = reorderList(prev[key], orderedIds, movedPatch);
  const ordered =
    listKind === 'tasks'
      ? decorateTasks(next)
      : (() => {
          const open = next.filter((h) => !h.completed);
          const done = next.filter((h) => h.completed);
          return [...open, ...done];
        })();
  replacePayloadKeepingAge({ ...prev, [key]: ordered, offline: false });
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

/** Replace cached payload contents without extending its freshness window. */
function replacePayloadKeepingAge(payload) {
  if (!payloadCache) {
    setPayloadCache(payload);
    return;
  }
  payloadCache = { at: payloadCache.at, payload };
}

function patchPayloadCache(listKind, taskId, patch, append = null) {
  if (!payloadCache || !payloadCache.payload) return;
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const prev = payloadCache.payload;
  let list = applyItemPatch(prev[key], taskId, patch, append);
  if (append) {
    if (listKind === 'tasks') list = decorateTasks(list);
    else list = withHabits(list);
  } else if (patch !== null) {
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
  replacePayloadKeepingAge({ ...prev, [key]: list, offline: false });
}

async function getListMap(tasksApi) {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) {
    return listCache.byTitle;
  }
  const lists = await listAllPages((p) => tasksApi.tasklists.list(p), {});
  const byTitle = new Map();
  for (const list of lists) {
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

/**
 * Authorized Tasks API client plus the id of the widget's list for `listKind`.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {'tasks' | 'habits'} listKind
 */
async function openList(config, listKind) {
  const auth = await getAuthorizedClient({ interactive: false });
  if (!auth) throw new Error('Не авторизован');
  const tasksApi = tasksClient(auth);
  const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
  const listId = await resolveListId(tasksApi, listName);
  if (!listId) throw new Error(`Список «${listName}» не найден`);
  return { tasksApi, listId };
}

/** Every visible item of a list (open + completed, all pages), mapped to widget shape. */
async function fetchListItems(tasksApi, listId) {
  if (!listId) return [];
  const items = await listAllPages((p) => tasksApi.tasks.list(p), {
    tasklist: listId,
    showCompleted: true,
    showHidden: false,
  });
  return items.map(mapTask);
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
        !isPlaceholderMeta(formatted)
          ? formatted
          : !isPlaceholderMeta(h.meta)
            ? localizeMeta(h.meta)
            : META_HABIT;
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

async function fetchLivePayload(config) {
  // A fetch that overlaps a mutation may return pre-edit state: retry after edits settle.
  for (let attempt = 0; ; attempt += 1) {
    const genStart = mutationGeneration;
    const busyStart = mutationsActive;
    const payload = await fetchLivePayloadOnce(config);
    if (payload.mode !== 'google') return payload;
    const consistent =
      busyStart === 0 && mutationsActive === 0 && genStart === mutationGeneration;
    if (consistent) {
      saveOfflineCache(payload);
      setPayloadCache(payload);
      return payload;
    }
    if (attempt >= 2) {
      // Still racing edits: prefer the cache those edits patched over this snapshot.
      const patched = payloadCache && payloadCache.payload;
      return patched && patched.mode === 'google' ? patched : payload;
    }
    await Promise.allSettled([...mutationInFlight.values()]);
  }
}

async function fetchLivePayloadOnce(config) {
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
      message: 'Нажмите «Google» внизу, чтобы войти.',
    };
  }

  const tasksApi = tasksClient(auth);
  const listMap = await getListMap(tasksApi);
  const tasksListId = listMap.get(String(config.tasksListName || '').trim()) || null;
  const habitsListId = listMap.get(String(config.habitsListName || '').trim()) || null;

  const [tasksRaw, habitsRaw] = await Promise.all([
    fetchListItems(tasksApi, tasksListId),
    fetchListItems(tasksApi, habitsListId),
  ]);

  const tasks = decorateTasks(tasksRaw);
  // Habits skip the tasks "open + 5 done" truncation.
  const habits = withHabits(habitsRaw);

  return {
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
      meta: !isPlaceholderMeta(h.meta) ? localizeMeta(h.meta) : META_HABIT,
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
  replacePayloadKeepingAge(next);
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
    const today = todayIso();
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

      const tasksApi = tasksClient(auth);
      const listId = await resolveListId(tasksApi, config.habitsListName);
      if (!listId) {
        // Persist so we don't hammer the API when the Habits list is missing.
        saveSettings({ lastHabitsResetDate: today });
        return { ok: true, reset: false, reason: 'no_list' };
      }

      const all = await listAllPages((p) => tasksApi.tasks.list(p), {
        tasklist: listId,
        showCompleted: true,
        showHidden: true,
      });
      // Only completions from before today: a reset that runs late (no network at midnight,
      // retried minutes later) must not un-tick habits the user has already done today.
      const [y, m, d] = today.split('-').map(Number);
      const dayStart = new Date(y, m - 1, d).getTime();
      const doneToday = (i) =>
        Date.parse(i.completed || '') >= dayStart || getHabitStats(i.id).completedToday;
      const items = all.filter((i) => i && i.id && i.status === 'completed' && !doneToday(i));

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
      const mapped = normalizeGoogleAuthError(err);
      console.warn('[habits-reset]', mapped.message);
      if (!isInvalidGrantError(err)) habitsResetRetryAt = Date.now() + HABITS_RESET_RETRY_MS;
      return {
        ok: false,
        reset: false,
        reason: isInvalidGrantError(err) ? 'auth' : 'error',
        message: mapped.message,
      };
    }
  })().finally(() => {
    mutationsActive -= 1;
    mutationGeneration += 1;
    habitsResetInFlight = null;
  });
  mutationsActive += 1;

  return habitsResetInFlight;
}

async function getWidgetDataUncached(force) {
  // Day rollover before serving data so habits aren't stuck completed in Google.
  // Skipped briefly after a network failure so offline loads aren't delayed twice.
  if (Date.now() >= habitsResetRetryAt) {
    try {
      await resetCompletedHabitsForNewDay();
    } catch (err) {
      console.warn(
        '[habits-reset]',
        err && err.message ? err.message : err
      );
    }
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
    // Setup problems (API disabled, client deleted, org policy) are not «offline»:
    // retrying won't help until the user fixes something in Google Cloud.
    if (SETUP_ERROR_CODES.has(mapped.code)) {
      invalidateListCache();
      invalidatePayloadCache();
      return {
        mode: 'needs_setup',
        tasksListName: config.tasksListName,
        habitsListName: config.habitsListName,
        accentColor: config.accentColor,
        tasks: [],
        habits: [],
        offline: false,
        message: mapped.message,
        code: mapped.code,
        actionUrl: mapped.actionUrl || null,
        actionLabel: mapped.actionLabel || null,
      };
    }
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

/** Errors that need a fix in Google Cloud rather than a retry. */
const SETUP_ERROR_CODES = new Set(['api_disabled', 'invalid_client', 'admin_policy']);

/**
 * @param {{ force?: boolean, lists?: boolean }} [opts]
 *   lists: also re-read the task-list names (user-initiated refresh after creating a list).
 */
async function getWidgetData(opts = {}) {
  const force = Boolean(opts && opts.force);
  if (force && opts.lists) invalidateListCache();
  if (dataInFlight && !force) return dataInFlight;
  if (force) {
    // Forced refreshes queued behind the same in-flight load share one round-trip.
    // Once a forced load has started fetching it is not reused: a caller that just
    // logged out / saved credentials must see a load that began after that.
    if (forcedDataInFlight) return forcedDataInFlight;
    const prior = dataInFlight;
    const run = (async () => {
      try {
        // Always yields once, so `run` is assigned before it is read below.
        await prior;
      } catch {
        /* ignore */
      }
      if (forcedDataInFlight === run) forcedDataInFlight = null;
      return getWidgetDataUncached(true);
    })().finally(() => {
      if (forcedDataInFlight === run) forcedDataInFlight = null;
      if (dataInFlight === run) dataInFlight = null;
    });
    forcedDataInFlight = run;
    dataInFlight = run;
    return run;
  }
  const run = getWidgetDataUncached(false).finally(() => {
    if (dataInFlight === run) dataInFlight = null;
  });
  dataInFlight = run;
  return run;
}

/**
 * @param {{ onSignedIn?: () => void }} [opts] called once the browser step is over,
 *   before the (possibly slow) first data load
 */
async function loginGoogle(opts = {}) {
  if (!hasGoogleCredentials()) {
    throw new Error('Сначала сохраните Google Client ID и Secret в настройках виджета');
  }
  invalidateListCache();
  invalidatePayloadCache();
  try {
    await getAuthorizedClient({ interactive: true });
  } catch (err) {
    throw normalizeGoogleAuthError(err);
  }
  if (opts.onSignedIn) {
    try {
      opts.onSignedIn();
    } catch {
      /* UI notification only */
    }
  }
  // Signed in: a failing first load (e.g. Tasks API disabled) becomes a payload the UI explains.
  return getWidgetData({ force: true });
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
    (completed ? META_DONE : listKind === 'habits' ? META_HABIT : META_TASK);
  return {
    status,
    completed,
    due,
    dueKind,
    dueTime,
    recurrence,
    notes,
    meta: listKind === 'habits' ? localizeMeta(cached && cached.meta) || META_HABIT : meta,
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
  // The day of the click, not of the reply: a tick at 23:59:59 whose request finishes
  // after midnight still counts for the day the user meant (habit streaks).
  const clickedAt = new Date();
  const clickDay = todayIso(clickedAt);

  return runMutation(`set:${listKind}:${taskId}:${completed}`, `${listKind}:${taskId}`, async () => {
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
      const result = setMockCompleted(listKind, taskId, completed, { day: clickDay });
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

    const { tasksApi, listId } = await openList(config, listKind);

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
      requestBody.completed = completed ? clickedAt.toISOString() : null;
    }

    await tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody,
    });

    let stats = null;
    if (listKind === 'habits') {
      stats = completed ? markCompleted(taskId, clickDay) : unmarkCompleted(taskId, clickDay);
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
  });
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

  // «Позвонить завтра в 18:30» → title + due + time / repeat lines in notes.
  /** @type {{ due?: string, notes?: string }} */
  const extra = {};
  if (opts && opts.parse && listKind === 'tasks') {
    const parsed = parseQuickAdd(trimmed);
    trimmed = parsed.title;
    if (parsed.dueKey) extra.due = dueIsoFromKey(parsed.dueKey);
    let notes = '';
    if (parsed.time) notes = applyDueTimeToNotes(notes, parsed.time);
    if (parsed.recurrence) notes = applyRecurrenceToNotes(notes, parsed.recurrence);
    if (notes) extra.notes = notes;
  }

  const flightKey = `create:${listKind}:${parentId || ''}:${trimmed.toLowerCase()}:${extra.due || ''}:${extra.notes || ''}`;
  return runMutation(flightKey, `${listKind}:create`, async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = addMockItem(listKind, trimmed, { parentId, ...extra });
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

    const { tasksApi, listId } = await openList(config, listKind);

    /** @type {Record<string, string>} */
    const body = {
      title: trimmed,
      status: 'needsAction',
      ...extra,
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

    // Subtasks too (patchPayloadCache re-nests them): a drag right after creating one must
    // find its parent in the caches, or tasks.move would lift it to the top level.
    patchOfflineCache(listKind, mapped.id, null, mapped);
    patchPayloadCache(listKind, mapped.id, null, mapped);

    return { ok: true, mode: 'google', item: mapped };
  });
}

/**
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string | { title?: string, notes?: string, due?: string | null, dueTime?: string | null, recurrence?: string | null }} patchOrTitle
 *   `due` is a local 'YYYY-MM-DD' (null clears it).
 */
async function updateItem(listKind, taskId, patchOrTitle) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  /** @type {{ title?: string, notes?: string, due?: string | null, dueTime?: string | null, recurrence?: string | null }} */
  let patch = {};
  if (typeof patchOrTitle === 'string') {
    patch.title = patchOrTitle;
  } else if (patchOrTitle && typeof patchOrTitle === 'object') {
    patch = { ...patchOrTitle };
  }

  // Notes-derived fields are computed inside the queued task so back-to-back edits
  // (time, then repeat) each start from the notes the previous edit wrote.
  return runMutation(`update:${listKind}:${taskId}:${JSON.stringify(patch)}`, `${listKind}:${taskId}`, async () => {
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

    /** @type {Record<string, string | null>} */
    const body = {};
    /** @type {Record<string, any>} */
    const itemPatch = {};

    if (Object.prototype.hasOwnProperty.call(patch, 'due')) {
      const key = normalizeDueKeyInput(patch.due);
      body.due = key ? dueIsoFromKey(key) : null;
      itemPatch.due = body.due;
    }

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

    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = updateMockItem(listKind, taskId, {
        ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
        ...(typeof patch.notes === 'string' ? { notes: patch.notes } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'due') ? { due: body.due } : {}),
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
          due: item.due || null,
          dueKind: item.dueKind || null,
          meta: item.meta,
          dueTime,
          recurrence: item.recurrence || null,
        });
      } else {
        invalidatePayloadCache();
      }
      return result;
    }

    const { tasksApi, listId } = await openList(config, listKind);

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

    // Refresh meta/dueTime/recurrence when notes or the date change.
    if (
      Object.prototype.hasOwnProperty.call(itemPatch, 'notes') ||
      Object.prototype.hasOwnProperty.call(itemPatch, 'due')
    ) {
      const cached = lookupCachedItem(listKind, taskId);
      const merged = {
        ...(cached || {}),
        ...itemPatch,
        status: cached && cached.completed ? 'completed' : 'needsAction',
      };
      itemPatch.dueTime = resolveTaskTime(merged);
      itemPatch.recurrence = parseRecurrence(merged.notes);
      itemPatch.dueKind = dueKindFor(merged.due, Boolean(merged.completed));
      itemPatch.meta =
        formatMeta(merged) ||
        (merged.completed ? META_DONE : listKind === 'habits' ? META_HABIT : META_TASK);
    }

    patchOfflineCache(listKind, taskId, itemPatch);
    patchPayloadCache(listKind, taskId, itemPatch);

    return { ok: true, mode: 'google', item: { id: taskId, ...itemPatch } };
  });
}

async function deleteItem(listKind, taskId) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('Некорректный id задачи');
  }

  return runMutation(`delete:${listKind}:${taskId}`, `${listKind}:${taskId}`, async () => {
    const config = loadConfig();

    if (!hasGoogleCredentials()) {
      const result = deleteMockItem(listKind, taskId);
      patchPayloadCache(listKind, taskId, null);
      return result;
    }

    const { tasksApi, listId } = await openList(config, listKind);

    await tasksApi.tasks.delete({
      tasklist: listId,
      task: taskId,
    });

    if (listKind === 'habits') removeHabit(taskId);

    patchOfflineCache(listKind, taskId, null);
    patchPayloadCache(listKind, taskId, null);

    return { ok: true, mode: 'google' };
  });
}

/**
 * Previous sibling for tasks.move — never the parent row, and only an item
 * that shares the same parent (roots share parent=null).
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string[]} orderedIds
 * @param {string | null} [hintPreviousId]
 * @param {{ parent?: string | null } | null} [moved] the moved item (its parent decides siblings)
 * @returns {string | null}
 */
function resolveMovePreviousSibling(listKind, taskId, orderedIds, hintPreviousId, moved = null) {
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

  // Moves share one queue per list: each relies on the order the previous one produced.
  return runMutation(`move:${listKind}:${taskId}:${ids.join(',')}`, `${listKind}:move`, async () => {
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

    const { tasksApi, listId } = await openList(config, listKind);

    let cached = lookupCachedItem(listKind, taskId);
    if (!cached) {
      // Not in the caches (created elsewhere since the last load): ask Google for its parent,
      // since a move without `parent` would lift a subtask to the top level.
      const existing = await tasksApi.tasks.get({ tasklist: listId, task: taskId });
      const data = (existing && existing.data) || {};
      cached = { id: taskId, parent: data.parent || null };
    }
    const prev = resolveMovePreviousSibling(listKind, taskId, ids, prevHint, cached);

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

    return {
      ok: true,
      mode: 'google',
      orderedIds: ids,
      item: movedPatch,
    };
  });
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
  parseRecurrence,
  applyRecurrenceToNotes,
  nextOccurrenceDue,
  resetCompletedHabitsForNewDay,
  /** Exposed for unit tests only. */
  _test: { listAllPages, runMutation },
};
