'use strict';

const {
  getAuthorizedClient,
  isInvalidGrantError,
  normalizeGoogleAuthError,
  loadSavedTokens,
} = require('./google-auth');
const {
  enrichHabits,
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
  clearOfflineCache: clearOfflineCacheFile,
  patchOfflineCache,
  reorderOfflineCache,
} = require('./offline-cache');
const { applyItemPatch, reorderList } = require('./list-ops');
const { retryingTasksClient } = require('./retry');
const { parseQuickAdd } = require('./quick-add');

/** Google's own limit: a longer title written elsewhere is kept whole when renamed here. */
const MAX_TITLE_LEN = 1024;
const MAX_NOTES_LEN = 8000;

/** Cut to `max` UTF-16 units without leaving half of an emoji (a lone surrogate) at the end. */
function cutTo(text, max) {
  if (text.length <= max) return text;
  const out = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

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

/** Resolves once every queued edit (and a running habit reset) has settled — before quitting. */
async function whenIdle() {
  while (itemQueues.size || habitsResetInFlight) {
    await Promise.allSettled([...itemQueues.values(), habitsResetInFlight]);
  }
}

/**
 * Collect every page of a Google list call (`tasks.list`, `tasklists.list`).
 * @param {(params: object) => Promise<{ data: { items?: any[], nextPageToken?: string } }>} listFn
 * @param {object} params
 * @returns {Promise<any[]>}
 */
async function listAllPages(listFn, params, maxPages = MAX_PAGES) {
  /** @type {any[]} */
  const items = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
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
    completedAt: (completed && item.completed) || null,
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

/** Completed tasks the widget lists. */
const DONE_SHOWN = 5;

/**
 * The `limit` most recently completed items, kept in input order.
 * @template {{ completedAt?: string | null }} T
 * @param {T[]} done
 * @param {number} limit
 * @returns {T[]}
 */
function recentlyCompleted(done, limit) {
  if (done.length <= limit) return done;
  const at = (item) => Date.parse(item.completedAt || '') || 0;
  const keep = new Set(
    done
      .map((item, index) => ({ item, index }))
      .sort((a, b) => at(b.item) - at(a.item) || a.index - b.index)
      .slice(0, limit)
      .map(({ item }) => item)
  );
  return done.filter((item) => keep.has(item));
}

/**
 * Open first, then up to DONE_SHOWN completed — the most recently completed ones when Google
 * says when (mock data and old caches don't: then the first ones). Google sibling order via
 * `position`, nest subtasks under parents (mock keeps array / DnD order).
 */
function sortTasks(tasks) {
  const open = nestTasksPreserveOrder(tasks.filter((t) => !t.completed));
  const doneAll = tasks.filter((t) => t.completed);
  const done = doneAll.some((t) => t.completedAt)
    ? nestTasksPreserveOrder(recentlyCompleted(doneAll, DONE_SHOWN))
    : nestTasksPreserveOrder(doneAll).slice(0, DONE_SHOWN);
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
      // Always from the item itself: a stored meta goes stale when the notes change (demo mode).
      const meta =
        formatMeta({ ...t, status: t.completed ? 'completed' : 'needsAction' }) ||
        (t.completed ? META_DONE : META_TASK);
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

/**
 * List ids by title that are probably still right (last validated map, or the offline cache of
 * the previous run). A load uses them at once and re-reads tasklists.list alongside.
 * @type {Map<string, string> | null}
 */
let knownLists = null;

/** Forget the validated list map; the ids stay known for the next load to try. */
function invalidateListCache() {
  if (listCache) knownLists = listCache.byTitle;
  listCache = null;
}

/** Signed out or another account: neither the list map nor the remembered ids apply. */
function clearOfflineCache() {
  listCache = null;
  knownLists = null;
  clearOfflineCacheFile();
}

function knownListMap() {
  if (knownLists) return knownLists;
  const cached = loadOfflineCache();
  const ids = cached && cached.listIds;
  if (!ids || typeof ids !== 'object') return null;
  const map = new Map(Object.entries(ids).filter(([title, id]) => title && typeof id === 'string' && id));
  return map.size ? map : null;
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

/** @type {Promise<Map<string, string>> | null} one tasklists.list for callers in the same round */
let listMapInFlight = null;

async function getListMap(tasksApi) {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_CACHE_TTL_MS) {
    return listCache.byTitle;
  }
  if (listMapInFlight) return listMapInFlight;
  const run = (async () => {
    const lists = await listAllPages((p) => tasksApi.tasklists.list(p), {});
    const byTitle = new Map();
    for (const list of lists) {
      const title = (list.title || '').trim();
      if (title && list.id) byTitle.set(title, list.id);
    }
    listCache = { at: now, byTitle };
    knownLists = byTitle;
    return byTitle;
  })().finally(() => {
    if (listMapInFlight === run) listMapInFlight = null;
  });
  listMapInFlight = run;
  return run;
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

/**
 * Completed tasks are read for the last week (all pages: the widget shows the most recent few)
 * and, in the same round, one page of the last month for a week with too few of them.
 */
const DONE_WEEK_DAYS = 7;
const DONE_MONTH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Items of a list mapped to widget shape. `showHidden` everywhere: Google returns tasks
 * completed in its own web UI or mobile apps only with it.
 * Habits (a short list that the daily reset keeps open): everything in one query.
 * Tasks: completed ones pile up for years, so open tasks and recent completions are separate
 * queries in one round — old completions can never push open tasks past the page cap.
 * @param {{ recentDoneOnly?: boolean }} [opts]
 */
async function fetchListItems(tasksApi, listId, opts = {}) {
  if (!listId) return [];
  const list = (params, maxPages) =>
    listAllPages(
      (p) => tasksApi.tasks.list(p),
      { tasklist: listId, showHidden: true, ...params },
      maxPages
    );
  if (!opts.recentDoneOnly) return (await list({ showCompleted: true })).map(mapTask);
  const since = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
  const [open, week, month] = await Promise.all([
    list({ showCompleted: false }),
    list({ showCompleted: true, completedMin: since(DONE_WEEK_DAYS) }),
    list({ showCompleted: true, completedMin: since(DONE_MONTH_DAYS) }, 1),
  ]);
  const weekDone = week.filter((t) => t && t.status === 'completed');
  const done = weekDone.length >= DONE_SHOWN ? weekDone : [...weekDone, ...month];
  const byId = new Map();
  for (const t of open) if (t && t.id && t.status !== 'completed') byId.set(t.id, t);
  for (const t of done) if (t && t.id && t.status === 'completed') byId.set(t.id, t);
  return [...byId.values()].map(mapTask);
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

/**
 * Today's mark of a habit follows Google, so a check or uncheck on the phone shows here:
 * completed today there → done today here; open there → not done today. Earlier days stay.
 * @param {Array<{ id: string, completed: boolean, completedAt?: string | null }>} habitsRaw
 */
function syncHabitsTodayFromGoogle(habitsRaw) {
  const today = todayIso();
  for (const h of habitsRaw) {
    if (!h || !h.id) continue;
    if (h.completed && localDayOf(h.completedAt) === today) markCompleted(h.id, today);
    else if (!h.completed) unmarkCompleted(h.id, today);
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
  const genStart = mutationGeneration;
  const { ids, items } = await fetchWidgetLists(tasksApi, config);
  const { tasks: tasksListId, habits: habitsListId } = ids;
  const [tasksRaw, habitsRaw] = items;
  // Skipped when an edit here raced the fetch: the snapshot may predate it.
  if (genStart === mutationGeneration && mutationsActive === 0) syncHabitsTodayFromGoogle(habitsRaw);

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
    listIds: listCache ? Object.fromEntries(listCache.byTitle) : undefined,
    tasks,
    habits,
    offline: false,
  };
}

/** Ids of the widget's two lists in a title → id map. */
function widgetListIds(map, config) {
  return {
    tasks: map.get(String(config.tasksListName || '').trim()) || null,
    habits: map.get(String(config.habitsListName || '').trim()) || null,
  };
}

function readWidgetLists(tasksApi, ids) {
  return Promise.all([
    fetchListItems(tasksApi, ids.tasks, { recentDoneOnly: true }),
    fetchListItems(tasksApi, ids.habits),
  ]);
}

/**
 * Items of the Tasks and Habits lists. With list ids from before, the items and a fresh
 * tasklists.list are read in the same round; only if the ids turn out to have changed (a list
 * renamed, deleted or recreated) are the items read again.
 */
async function fetchWidgetLists(tasksApi, config) {
  const fresh = listCache && Date.now() - listCache.at < LIST_CACHE_TTL_MS;
  const known = fresh ? null : knownListMap();
  if (!known) {
    const ids = widgetListIds(await getListMap(tasksApi), config);
    return { ids, items: await readWidgetLists(tasksApi, ids) };
  }
  const guess = widgetListIds(known, config);
  const [map, items] = await Promise.allSettled([getListMap(tasksApi), readWidgetLists(tasksApi, guess)]);
  if (map.status === 'rejected') throw map.reason;
  const ids = widgetListIds(map.value, config);
  if (ids.tasks === guess.tasks && ids.habits === guess.habits) {
    if (items.status === 'rejected') throw items.reason;
    return { ids, items: items.value };
  }
  return { ids, items: await readWidgetLists(tasksApi, ids) };
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
 * Data to paint at once, without waiting for Google: the fresh in-memory payload, or else the
 * offline cache of the last run marked `stale` (the caller loads fresh data right after).
 * Null when there is neither, or no one is signed in.
 */
function getQuickWidgetData() {
  const warm = fromPayloadCache();
  if (warm) return warm;
  const tokens = hasGoogleCredentials() ? loadSavedTokens() : null;
  if (!tokens || !tokens.refresh_token) return null;
  const cached = offlineFromCache(loadConfig(), null);
  if (!cached) return null;
  return { ...cached, offline: false, warning: undefined, stale: true };
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
 * Local calendar day of Google's completion timestamp (RFC 3339), or null.
 * @param {string | null | undefined} completed
 */
function localDayOf(completed) {
  if (!completed) return null;
  const d = new Date(completed);
  return Number.isNaN(d.getTime()) ? null : todayIso(d);
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
      // A habit completed today (on the phone, or here after midnight) belongs to the new day.
      const items = all.filter(
        (i) => i && i.id && i.status === 'completed' && localDayOf(i.completed) !== today
      );

      // In parallel: one round for the whole list instead of one per habit.
      await forEachLimited(items, RESET_PARALLEL, async (item) => {
        // Completed on another device on an earlier day: keep that day in the history.
        const day = localDayOf(item.completed);
        if (day && day < today) markCompleted(item.id, day);
        await tasksApi.tasks.patch({
          tasklist: listId,
          task: item.id,
          requestBody: { status: 'needsAction', completed: null },
        });
        patchOfflineCache('habits', item.id, {
          status: 'needsAction',
          completed: false,
        });
      });

      // Caches stay valid: habits show the local streak, not Google's completed flag.
      saveSettings({ lastHabitsResetDate: today });
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
    // Not counted as an edit for fetchLivePayload: it only clears completed flags of earlier
    // days, which a load running alongside may still see without showing anything wrong.
    habitsResetInFlight = null;
  });

  return habitsResetInFlight;
}

/** Habit patches sent at once by the daily reset. */
const RESET_PARALLEL = 8;

/** Run `fn` over `items`, at most `limit` at a time; rejects with the first failure. */
async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function getWidgetDataUncached(force) {
  // Day rollover so habits aren't stuck completed in Google. Skipped briefly after a network
  // failure. Demo mode resets data the payload shows, so it waits; in Google it only clears
  // completed flags the widget doesn't display (habits show the local streak), so the load
  // does not wait for it.
  if (Date.now() >= habitsResetRetryAt) {
    const reset = resetCompletedHabitsForNewDay().catch((err) => {
      console.warn('[habits-reset]', err && err.message ? err.message : err);
    });
    if (!hasGoogleCredentials()) await reset;
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
    completedAt: completed ? new Date().toISOString() : null,
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
  });
}

async function createItem(listKind, title, opts = {}) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  let trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  trimmed = cutTo(trimmed, MAX_TITLE_LEN);
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

    if (listKind === 'tasks' && parentId) {
      invalidatePayloadCache();
      invalidateListCache();
    } else {
      patchOfflineCache(listKind, mapped.id, null, mapped);
      patchPayloadCache(listKind, mapped.id, null, mapped);
    }

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
      // Google: the notes are read with tasks.get below, not from a cache that may predate
      // an edit made on another device.
      if (currentNotes === null && !hasGoogleCredentials()) {
        const mockItem = getMockItem(listKind, taskId);
        if (!mockItem) throw new Error('Элемент не найден');
        currentNotes = mockItem.notes || '';
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
      // Google: the notes are read with tasks.get below, not from a cache that may predate
      // an edit made on another device.
      if (currentNotes === null && !hasGoogleCredentials()) {
        const mockItem = getMockItem(listKind, taskId);
        if (!mockItem) throw new Error('Элемент не найден');
        currentNotes = mockItem.notes || '';
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
      trimmed = cutTo(trimmed, MAX_TITLE_LEN);
      body.title = trimmed;
      itemPatch.title = trimmed;
    }
    if (typeof patch.notes === 'string') {
      let notes = patch.notes;
      notes = cutTo(notes, MAX_NOTES_LEN);
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

    // Fetch the current notes before applying dueTime/recurrence so we don't wipe them.
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
      body.notes = cutTo(currentNotes, MAX_NOTES_LEN);
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

/** Google's answer for an item that does not exist (any more). */
function isNotFoundError(err) {
  const e = /** @type {any} */ (err) || {};
  return Number((e.response && e.response.status) || e.status || e.code) === 404;
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

    try {
      await tasksApi.tasks.delete({
        tasklist: listId,
        task: taskId,
      });
    } catch (err) {
      // Already gone: a retried call whose first answer was lost, or deleted on another device.
      if (!isNotFoundError(err)) throw err;
    }

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
  getQuickWidgetData,
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
  whenIdle,
  /** Exposed for unit tests only. */
  _test: { listAllPages, runMutation },
};
