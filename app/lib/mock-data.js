'use strict';

const {
  enrichHabits,
  todayIso,
  markCompleted,
  unmarkCompleted,
  removeHabit,
} = require('./streak-store');
const { readJson, writeJson, dataPath } = require('./config');

function mockFile() {
  return dataPath('mock-items.json');
}

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
    notes: '',
    due: dueIsoDaysFromNow(0),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t2',
    title: 'Design landing page',
    notes: '',
    due: dueIsoDaysFromNow(2),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t3',
    title: 'Reply to emails',
    notes: '',
    due: dueIsoDaysFromNow(-1),
    status: 'completed',
    completed: true,
  },
  {
    id: 'mock-t4',
    title: 'Workout',
    notes: '',
    due: dueIsoDaysFromNow(-2),
    status: 'needsAction',
    completed: false,
  },
  {
    id: 'mock-t5',
    title: 'Grocery shopping',
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
  },
];

const DEFAULT_HABITS = [
  { id: 'mock-h1', title: 'Meditate', meta: 'Daily', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h2', title: 'Exercise', meta: 'Daily', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h3', title: 'Read', meta: 'Daily', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h4', title: 'Drink Water', meta: 'Daily', status: 'needsAction', completed: false, notes: '', due: null },
  { id: 'mock-h5', title: 'No Sugar', meta: 'Weekdays', status: 'needsAction', completed: false, notes: '', due: null },
];

function loadMockStore() {
  const stored = readJson(mockFile(), null);
  if (stored && Array.isArray(stored.tasks) && Array.isArray(stored.habits)) {
    return stored;
  }
  const fresh = {
    tasks: DEFAULT_TASKS.map((t) => ({ ...t })),
    habits: DEFAULT_HABITS.map((h) => ({ ...h })),
  };
  writeJson(mockFile(), fresh);
  return fresh;
}

function saveMockStore(store) {
  writeJson(mockFile(), store);
}

/** Seed demo streak history once so week strip looks alive in mock mode. */
function seedDemoStreaks() {
  const { loadStore } = require('./streak-store');
  const store = loadStore();
  if (Object.keys(store.habits).length > 0) return;

  const seeds = {
    'mock-h1': [0, 1, 2, 3, 4, 5, 6],
    'mock-h2': [0, 2, 3, 4, 5, 6],
    'mock-h3': [0, 1, 2, 3, 4, 5, 6],
    'mock-h4': [0, 1, 2, 3, 4, 5],
    'mock-h5': [0, 1, 2, 3, 4],
  };

  for (const [id, dayOffsets] of Object.entries(seeds)) {
    for (const offset of dayOffsets) {
      const d = new Date();
      d.setDate(d.getDate() - (6 - offset));
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
  return task.meta || (task.completed ? 'Done' : 'Task');
}

function getMockPayload(config) {
  seedDemoStreaks();
  const store = loadMockStore();

  const tasks = store.tasks.map((t) => ({
    ...t,
    meta: formatMockMeta(t),
  }));

  const habits = enrichHabits(
    store.habits.map((h) => ({
      ...h,
      notes: h.notes || '',
      due: h.due || null,
      meta: h.meta || 'Daily',
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

function addMockItem(listKind, title) {
  const store = loadMockStore();
  const id = `mock-${listKind[0]}-${Date.now().toString(36)}`;
  const trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');

  if (listKind === 'habits') {
    const item = {
      id,
      title: trimmed,
      meta: 'Daily',
      status: 'needsAction',
      completed: false,
      notes: '',
      due: null,
    };
    store.habits.unshift(item);
    saveMockStore(store);
    return { ok: true, mode: 'mock', item };
  }

  const item = {
    id,
    title: trimmed,
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
  };
  store.tasks.unshift(item);
  saveMockStore(store);
  return { ok: true, mode: 'mock', item };
}

function setMockCompleted(listKind, taskId, completed) {
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
    saveMockStore(store);
  }
  return { ok: true, mode: 'mock' };
}

function updateMockItem(listKind, taskId, title) {
  const trimmed = String(title || '').trim();
  if (!trimmed) throw new Error('Введите название');
  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const item = store[key].find((i) => i && i.id === taskId);
  if (!item) throw new Error('Элемент не найден');
  item.title = trimmed;
  saveMockStore(store);
  return { ok: true, mode: 'mock', item: { ...item } };
}

function deleteMockItem(listKind, taskId) {
  const store = loadMockStore();
  const key = listKind === 'habits' ? 'habits' : 'tasks';
  const before = store[key].length;
  store[key] = store[key].filter((i) => i && i.id !== taskId);
  if (store[key].length === before) throw new Error('Элемент не найден');
  saveMockStore(store);
  if (listKind === 'habits') removeHabit(taskId);
  return { ok: true, mode: 'mock' };
}

module.exports = {
  getMockPayload,
  addMockItem,
  setMockCompleted,
  updateMockItem,
  deleteMockItem,
  loadMockStore,
};
