'use strict';

const { enrichHabits, todayIso } = require('./streak-store');

const MOCK_TASKS = [
  {
    id: 'mock-t1',
    title: 'Review project proposal',
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
    meta: '10:00 AM',
  },
  {
    id: 'mock-t2',
    title: 'Design landing page',
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
    meta: 'Website',
  },
  {
    id: 'mock-t3',
    title: 'Reply to emails',
    notes: '',
    due: null,
    status: 'completed',
    completed: true,
    meta: '11:00 AM',
  },
  {
    id: 'mock-t4',
    title: 'Workout',
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
    meta: 'Personal',
  },
  {
    id: 'mock-t5',
    title: 'Grocery shopping',
    notes: '',
    due: null,
    status: 'needsAction',
    completed: false,
    meta: 'Personal',
  },
];

const MOCK_HABITS_BASE = [
  { id: 'mock-h1', title: 'Meditate', meta: 'Daily', status: 'needsAction', completed: false },
  { id: 'mock-h2', title: 'Exercise', meta: 'Daily', status: 'needsAction', completed: false },
  { id: 'mock-h3', title: 'Read', meta: 'Daily', status: 'needsAction', completed: false },
  { id: 'mock-h4', title: 'Drink Water', meta: 'Daily', status: 'needsAction', completed: false },
  { id: 'mock-h5', title: 'No Sugar', meta: 'Weekdays', status: 'needsAction', completed: false },
];

/** Seed demo streak history once so week strip looks alive in mock mode. */
function seedDemoStreaks() {
  const { markCompleted, loadStore } = require('./streak-store');
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

function getMockPayload(config) {
  seedDemoStreaks();
  const habits = enrichHabits(
    MOCK_HABITS_BASE.map((h) => ({
      ...h,
      notes: '',
      due: null,
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
    tasks: MOCK_TASKS.map((t) => ({ ...t })),
    habits,
  };
}

module.exports = {
  getMockPayload,
  MOCK_TASKS,
  MOCK_HABITS_BASE,
};
