'use strict';

const { google } = require('googleapis');
const { getAuthorizedClient } = require('./google-auth');
const { enrichHabits, markCompleted, unmarkCompleted } = require('./streak-store');
const { getMockPayload } = require('./mock-data');
const { loadConfig, hasGoogleCredentials } = require('./config');

function formatMeta(task) {
  if (task.due) {
    try {
      const d = new Date(task.due);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Due';
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
  return {
    id: item.id,
    title: item.title || '(без названия)',
    notes: item.notes || '',
    due: item.due || null,
    status: item.status || 'needsAction',
    completed,
    meta: formatMeta(item) || (completed ? 'Done' : 'Task'),
  };
}

async function findListIdByName(tasksApi, name) {
  const res = await tasksApi.tasklists.list({ maxResults: 100 });
  const lists = res.data.items || [];
  const found = lists.find((l) => (l.title || '').trim() === name.trim());
  return found ? found.id : null;
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
  // Prefer incomplete first, keep a few completed
  const mapped = items.map(mapTask);
  const open = mapped.filter((t) => !t.completed);
  const done = mapped.filter((t) => t.completed).slice(0, 5);
  return [...open, ...done];
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
      message: 'Нужна авторизация Google',
    };
  }

  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasksListId = await findListIdByName(tasksApi, config.tasksListName);
  const habitsListId = await findListIdByName(tasksApi, config.habitsListName);

  const tasks = tasksListId ? await listTasks(tasksApi, tasksListId) : [];
  let habitsRaw = habitsListId ? await listTasks(tasksApi, habitsListId) : [];

  habitsRaw = habitsRaw.map((h) => ({
    ...h,
    meta: h.meta && h.meta !== 'Task' ? h.meta : 'Daily',
  }));

  const habits = enrichHabits(habitsRaw).map((h) => ({
    ...h,
    // Local streak is source of truth for "done today" in Habits UI;
    // Google completed status still reflected when present.
    completed: h.completedToday || h.completed,
  }));

  return {
    mode: 'google',
    tasksListName: config.tasksListName,
    habitsListName: config.habitsListName,
    accentColor: config.accentColor,
    tasksListFound: Boolean(tasksListId),
    habitsListFound: Boolean(habitsListId),
    tasks,
    habits,
  };
}

/**
 * Load widget data: Google Tasks if credentials+token, else mock.
 */
async function getWidgetData() {
  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    return getMockPayload(config);
  }
  try {
    return await fetchLivePayload(config);
  } catch (err) {
    console.error('Google Tasks fetch failed, falling back to mock:', err.message);
    const mock = getMockPayload(config);
    mock.mode = 'mock';
    mock.warning = err.message;
    return mock;
  }
}

async function loginGoogle() {
  const config = loadConfig();
  if (!hasGoogleCredentials()) {
    throw new Error('Добавьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в файл .env');
  }
  await getAuthorizedClient({ interactive: true });
  return fetchLivePayload(config);
}

async function setTaskCompleted(listKind, taskId, completed) {
  const config = loadConfig();

  if (!hasGoogleCredentials()) {
    // Mock: only habits update local streak
    if (listKind === 'habits') {
      const stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
      return { ok: true, mode: 'mock', stats };
    }
    return { ok: true, mode: 'mock' };
  }

  const auth = await getAuthorizedClient({ interactive: false });
  if (!auth) throw new Error('Не авторизован');

  const tasksApi = google.tasks({ version: 'v1', auth });
  const listName = listKind === 'habits' ? config.habitsListName : config.tasksListName;
  const listId = await findListIdByName(tasksApi, listName);
  if (!listId) throw new Error(`Список «${listName}» не найден`);

  const existing = await tasksApi.tasks.get({ tasklist: listId, task: taskId });
  const body = {
    ...existing.data,
    status: completed ? 'completed' : 'needsAction',
  };
  if (completed) body.completed = new Date().toISOString();
  else delete body.completed;

  await tasksApi.tasks.update({
    tasklist: listId,
    task: taskId,
    requestBody: body,
  });

  let stats = null;
  if (listKind === 'habits') {
    stats = completed ? markCompleted(taskId) : unmarkCompleted(taskId);
  }

  return { ok: true, mode: 'google', stats };
}

module.exports = {
  getWidgetData,
  loginGoogle,
  setTaskCompleted,
};
