'use strict';

const { META_TASK, META_DONE, META_HABIT, localizeMeta } = require('./task-parse');

const {
  enrichHabits,
  markCompleted,
  unmarkCompleted,
  removeHabit,
} = require('./streak-store');
const { todayIso } = require('./dates');
const { dataPath } = require('./config');
const { loadDoc, saveDoc } = require('./storage-files');

function mockFile() {
  return dataPath('mock-items.json');
}

/** mock-items.json: the demo-mode lists (the only copy of tasks typed in demo mode). */
const MOCK_SPEC = {
  name: 'mock-items.json',
  file: mockFile,
  version: 1,
  keepBak: true,
  // v0 -> v1: the file only gained schemaVersion.
  migrations: { 1: (d) => d },
};

function dueIsoDaysFromNow(delta) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + delta);
  return d.toISOString();
}

const DEFAULT_TASKS = [
  {
    id: 'mock-t1',
    title: 'Review project proposal',
    notes: 'время 09:30\nповтор: ежедневно\nCheck budget section before Friday',
    parent: null,
    due: dueIsoDaysFromNow(0),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t1a',
    title: 'Summarize stakeholder feedback',
    notes: '',
    parent: 'mock-t1',
    due: dueIsoDaysFromNow(0),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t2',
    title: 'Design landing page',
    notes: '',
    parent: null,
    due: dueIsoDaysFromNow(2),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t3',
    title: 'Reply to emails',
    notes: '',
    parent: null,
    due: dueIsoDaysFromNow(-1),
    status: 'completed',
    completed: true,
  },
  {
    id: 'mock-t4',
    title: 'Workout',
    notes: '',
    parent: null,
    due: dueIsoDaysFromNow(-2),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t5',
    title: 'Grocery shopping',
    notes: '',
    parent: null,
    due: null,
    status: 'needsAction',
    completed: false,
  },
];

const DEFAULT_HABITS = [
  { id: 'mock-h1', title: 'Meditate', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: 'время 07:00', due: null },
  { id: 'mock-h2', title: 'Exercise', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h3', title: 'Read', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h4', title: 'Drink Water', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h5', title: 'No Sugar', meta: 'Weekdays', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h6', title: 'Sleep 8h', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h7', title: 'Stretch', meta: 'Ежедневно', status: 'needsAction', completed: false, notes: '', due: null },
];

function loadMockStore() {
  const stored = loadDoc(MOCK_SPEC).data;
  if (stored && Array.isArray(stored.tasks) && Array.isArray(stored.habits)) {
    return stored;
  }
  const fresh = {
    tasks: DEFAULT_TASKS.map((t) => ({ ...t })),
    habits: DEFAULT_HABITS.map((h) => ({ ...h })),
  };
  saveDoc(MOCK_SPEC, fresh);
  return fresh;
}

function saveMockStore(store) {
  saveDoc(MOCK_SPEC, store);
}

/** Seed demo streak history once so week strip looks alive in mock mode. */
function seedDemoStreaks() {
  const { loadStore } = require('./streak-store');
  const store = loadStore();
  if (Object.keys(store.habits).length > 0) return;

  const seeds = {
    'mock-h1': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23],
    'mock-h2': [0, 2, 3, 4, 5, 6, 9, 10, 11, 13, 16, 17, 18, 20],
    'mock-h3': [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17, 19, 20, 21],
    'mock-h4': [0, 1, 2, 3, 4, 5, 7, 8, 10, 12, 14, 15, 17, 19, 21],
    'mock-h5': [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22],
    'mock-h6': [0, 1, 3, 4, 5, 6, 8, 10, 11, 13, 15, 17, 18, 20, 22],
    'mock-h7': [1, 2, 4, 5, 6, 9, 11, 12, 14, 16, 18, 19, 21],
  };

  for (const [id, dayOffsets] of Object.entries(seeds)) {
    for (const offset of dayOffsets) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      markCompleted(id, todayIso(d));
    }
  }
}

function formatMockMeta(task) {
  if (task.due) {
    try {
      return new Date(task.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return 'Due';
    }
  }
  return localizeMeta(task.meta) || (task.completed ? META_DONE : META_TASK);
}

/**
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @returns {object | null}
 */
function getMockItem(listKind, taskId) {
  if (listKind !== 'tasks' && listKind !== 'habits') return null;
  if (typeof taskId !== 'string' || !taskId.trim()) return null;
  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const item = (store[key] || []).find((i) => i && i.id === taskId);
  if (!item) return null;
  return {
    ...item,
    notes: item.notes || '',
    parent: item.parent || null,
  };
}

function getMockPayload(config) {
  seedDemoStreaks();
  const store = loadMockStore();

  const tasks = store.tasks.map((t) => ({
    ...t,
    notes: t.notes || '',
    parent: t.parent || null,
    meta: formatMockMeta(t),
  }));

  const habits = enrichHabits(
    store.habits.map((h) => ({
      ...h,
      notes: h.notes || '',
      due: h.due || null,
      meta: localizeMeta(h.meta) || META_HABIT,
    }))
  ).map((h) => ({
    ...h,
    completed: h.completedToday,
    status: h.completedToday ? 'completed' : 'needsAction',
  }));

  return {
    mode: 'mock',
    tasksListName: config.tasksListName,
    habitsListName: config.habitsListName,
    accentColor: config.accentColor,
    tasks,
    habits,
    offline: false,
  };
}

function addMockItem(listKind, title, opts = {}) {
  const store = loadMockStore();
  const id = `mock-${listKind[0]}-${Date.now().toString(36)}`;
  const trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  const parentId =
    listKind === 'tasks' &&
    opts &&
    typeof opts.parentId === 'string' &&
    opts.parentId.trim()
      ? opts.parentId.trim()
      : null;

  if (listKind === 'habits') {
    const item = {
      id,
      title: trimmed,
      meta: META_HABIT,
      status: 'needsAction',
      completed: false,
      notes: '',
      due: null,
      parent: null,
    };
    store.habits.unshift(item);
    saveMockStore(store);
    return { ok: true, mode: 'mock', item };
  }

  const item = {
    id,
    title: trimmed,
    notes: typeof opts.notes === 'string' ? opts.notes : '',
    due: typeof opts.due === 'string' ? opts.due : null,
    status: 'needsAction',
    completed: false,
    parent: parentId,
  };
  if (parentId) {
    const idx = store.tasks.findIndex((t) => t && t.id === parentId);
    if (idx >= 0) store.tasks.splice(idx + 1, 0, item);
    else store.tasks.unshift(item);
  } else {
    store.tasks.unshift(item);
  }
  saveMockStore(store);
  return { ok: true, mode: 'mock', item };
}

function setMockCompleted(listKind, taskId, completed, opts = {}) {
  const store = loadMockStore();
  if (listKind === 'habits') {
    const habit = store.habits.find((h) => h.id === taskId);
    if (habit) {
      habit.completed = completed;
      habit.status = completed ? 'completed' : 'needsAction';
      saveMockStore(store);
    }
    const stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
    return { ok: true, mode: 'mock', stats };
  }
  const task = store.tasks.find((t) => t.id === taskId);
  if (task) {
    task.completed = completed;
    task.status = completed ? 'completed' : 'needsAction';
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'due')) {
      task.due = opts.due;
    }
    saveMockStore(store);
  }
  return { ok: true, mode: 'mock' };
}

/**
 * @param {'tasks' | 'habits'} listKind
 * @param {string} taskId
 * @param {string | { title?: string, notes?: string }} patchOrTitle
 */
function updateMockItem(listKind, taskId, patchOrTitle) {
  /** @type {{ title?: string, notes?: string, due?: string | null }} */
  let patch = {};
  if (typeof patchOrTitle === 'string') {
    patch.title = patchOrTitle;
  } else if (patchOrTitle && typeof patchOrTitle === 'object') {
    patch = patchOrTitle;
  }

  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const item = store[key].find((i) => i && i.id === taskId);
  if (!item) throw new Error('Элемент не найден');

  let changed = false;
  if (typeof patch.title === 'string') {
    const trimmed = patch.title.trim();
    if (!trimmed) throw new Error('Введите название');
    item.title = trimmed;
    changed = true;
  }
  if (typeof patch.notes === 'string') {
    item.notes = patch.notes;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'due')) {
    item.due = typeof patch.due === 'string' ? patch.due : null;
    changed = true;
  }
  if (!changed) throw new Error('Нечего обновлять');

  if (item.parent === undefined) item.parent = null;
  if (item.notes === undefined) item.notes = '';

  saveMockStore(store);
  return {
    ok: true,
    mode: 'mock',
    item: { ...item, notes: item.notes || '', parent: item.parent || null },
  };
}

function deleteMockItem(listKind, taskId) {
  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const before = store[key].length;
  // Google Tasks deletes children with the parent — keep mock in sync.
  store[key] = store[key].filter(
    (i) => i && i.id !== taskId && !(listKind === 'tasks' && i.parent === taskId)
  );
  if (store[key].length === before) throw new Error('Элемент не найден');
  saveMockStore(store);
  if (listKind === 'habits') removeHabit(taskId);
  return { ok: true, mode: 'mock' };
}

/**
 * Reorder mock list by explicit id sequence. Unknown ids are ignored;
 * items missing from orderedIds stay at the end in prior order.
 * @param {'tasks' | 'habits'} listKind
 * @param {string[]} orderedIds
 */
function reorderMockItems(listKind, orderedIds) {
  if (listKind !== 'tasks' && listKind !== 'habits') {
    throw new Error('Некорректный тип списка');
  }
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw new Error('Некорректный порядок');
  }
  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const byId = new Map();
  for (const item of store[key] || []) {
    if (item && item.id) byId.set(item.id, item);
  }
  const next = [];
  const seen = new Set();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    next.push(item);
    seen.add(id);
  }
  for (const item of store[key] || []) {
    if (item && item.id && !seen.has(item.id)) next.push(item);
  }
  if (!next.length) throw new Error('Элемент не найден');
  store[key] = next;
  saveMockStore(store);
  return { ok: true, mode: 'mock', orderedIds: next.map((i) => i.id) };
}

/**
 * Clear Google-style completed flags on habits for a new day.
 * Does not touch the streak store (completedToday / history stay intact).
 * @returns {number} how many habits were flipped
 */
function resetMockHabitsCompleted() {
  const store = loadMockStore();
  let n = 0;
  for (const h of store.habits || []) {
    if (!h) continue;
    if (h.completed || h.status === 'completed') {
      h.completed = false;
      h.status = 'needsAction';
      n += 1;
    }
  }
  if (n) saveMockStore(store);
  return n;
}

/** Demo lists for export / backup. */
function exportMockStore() {
  const store = loadMockStore();
  return { tasks: store.tasks.slice(), habits: store.habits.slice() };
}

const MOCK_TEXT_MAX = { id: 200, title: 1000, notes: 8000, meta: 200 };

/** Whitelist the fields of one imported demo item; null when it is unusable. */
function cleanMockItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const id = str(raw.id, MOCK_TEXT_MAX.id);
  const title = str(raw.title, MOCK_TEXT_MAX.title).trim();
  if (!id || !title || id === '__proto__') return null;
  const completed = raw.completed === true || raw.status === 'completed';
  /** @type {Record<string, unknown>} */
  const item = {
    id,
    title,
    notes: str(raw.notes, MOCK_TEXT_MAX.notes),
    due: typeof raw.due === 'string' && !Number.isNaN(Date.parse(raw.due)) ? raw.due : null,
    status: completed ? 'completed' : 'needsAction',
    completed,
    parent: typeof raw.parent === 'string' && raw.parent ? raw.parent.slice(0, MOCK_TEXT_MAX.id) : null,
  };
  if (typeof raw.meta === 'string') item.meta = raw.meta.slice(0, MOCK_TEXT_MAX.meta);
  return item;
}

/**
 * Add imported demo items whose ids do not exist yet (existing items are never changed).
 * @param {unknown} raw `{ tasks: [], habits: [] }`
 * @returns {{ tasksAdded: number, habitsAdded: number, rejected: number }}
 */
function mergeMockStore(raw) {
  const result = { tasksAdded: 0, habitsAdded: 0, rejected: 0 };
  if (!raw || typeof raw !== 'object') return result;
  const store = loadMockStore();
  for (const key of ['tasks', 'habits']) {
    const incoming = Array.isArray(raw[key]) ? raw[key] : [];
    const known = new Set(store[key].map((i) => i && i.id));
    for (const entry of incoming) {
      const item = cleanMockItem(entry);
      if (!item) {
        result.rejected += 1;
        continue;
      }
      if (known.has(item.id)) continue;
      known.add(item.id);
      store[key].push(item);
      result[key === 'tasks' ? 'tasksAdded' : 'habitsAdded'] += 1;
    }
  }
  if (result.tasksAdded || result.habitsAdded) saveMockStore(store);
  return result;
}

module.exports = {
  MOCK_SPEC,
  exportMockStore,
  mergeMockStore,
  getMockPayload,
  getMockItem,
  addMockItem,
  setMockCompleted,
  resetMockHabitsCompleted,
  updateMockItem,
  deleteMockItem,
  reorderMockItems,
  loadMockStore,
};
