'use strict';

/**
 * Google mode without the network: saved client keys and a refresh token in a temp data root,
 * and an in-memory Tasks API behind `require('@googleapis/tasks').tasks()`.
 * Each test file runs in its own process, so replacing the cached module is safe.
 */

const config = require('../../lib/config');
const { resetAuthClient } = require('../../lib/google-auth');
const { invalidateListCache, invalidatePayloadCache } = require('../../lib/google-tasks');
const { freshDataRoot } = require('./storage');

/** Ids of the «Tasks» and «Habits» lists; a test may change one (list deleted and recreated). */
const DEFAULT_LIST_IDS = { tasks: 'L-tasks', habits: 'L-habits' };

/**
 * loseResponse: the next call of that method is applied, then fails like a dropped connection.
 * @type {{ lists: Record<string, any[]>, calls: { method: string, params: any }[], loseResponse: string | null }}
 */
const server = {
  lists: {},
  listIds: { ...DEFAULT_LIST_IDS },
  calls: [],
  loseResponse: null,
  maxDepth: 0,
  doneDepth: 0,
  latencyMs: 1,
};

/**
 * Round trips on the critical path: a call is one round deeper than the deepest call that had
 * finished when it started, so calls in flight together share a round. startRounds() resets it.
 */
function startRounds() {
  server.maxDepth = 0;
  server.doneDepth = 0;
}

async function inRound(fn) {
  const depth = server.doneDepth + 1;
  server.maxDepth = Math.max(server.maxDepth, depth);
  await new Promise((resolve) => setTimeout(resolve, server.latencyMs));
  try {
    return await fn();
  } finally {
    server.doneDepth = Math.max(server.doneDepth, depth);
  }
}

function dropConnectionIfAsked(method) {
  if (server.loseResponse !== method) return;
  server.loseResponse = null;
  const err = new Error('socket hang up');
  /** @type {any} */ (err).code = 'ECONNRESET';
  throw err;
}

function notFound() {
  const err = new Error('Not Found');
  /** @type {any} */ (err).response = { status: 404 };
  return err;
}

function findTask(params) {
  const task = (server.lists[params.tasklist] || []).find((t) => t.id === params.task);
  if (!task) throw notFound();
  return task;
}

const fakeTasksApi = {
  tasklists: {
    list: async (params) => {
      server.calls.push({ method: 'tasklists.list', params });
      return {
        data: {
          items: [
            { id: server.listIds.tasks, title: 'Tasks' },
            { id: server.listIds.habits, title: 'Habits' },
          ],
        },
      };
    },
  },
  tasks: {
    // Filters as documented for tasks.list: hidden items (completed in Google's own apps) only
    // with showHidden; completedMin taken strictly (an open task has no completion date);
    // pages of maxResults (default 20, max 100).
    list: async (params) => {
      server.calls.push({ method: 'tasks.list', params });
      if (!server.lists[params.tasklist]) throw notFound();
      const min = params.completedMin ? Date.parse(params.completedMin) : null;
      const matching = server.lists[params.tasklist].filter((t) => {
        if (t.hidden && !params.showHidden) return false;
        if (t.status === 'completed' && params.showCompleted === false) return false;
        if (min !== null && !(t.completed && Date.parse(t.completed) >= min)) return false;
        return true;
      });
      const size = Math.min(params.maxResults || 20, 100);
      const start = Number(params.pageToken || 0);
      const next = start + size < matching.length ? String(start + size) : undefined;
      return { data: { items: matching.slice(start, start + size).map((t) => ({ ...t })), nextPageToken: next } };
    },
    get: async (params) => {
      server.calls.push({ method: 'tasks.get', params });
      return { data: { ...findTask(params) } };
    },
    patch: async (params) => {
      server.calls.push({ method: 'tasks.patch', params });
      const task = findTask(params);
      Object.assign(task, params.requestBody);
      return { data: { ...task } };
    },
    delete: async (params) => {
      server.calls.push({ method: 'tasks.delete', params });
      const list = server.lists[params.tasklist] || [];
      list.splice(list.indexOf(findTask(params)), 1);
      dropConnectionIfAsked('tasks.delete');
      return { data: '' };
    },
  },
};

for (const group of [fakeTasksApi.tasklists, fakeTasksApi.tasks]) {
  for (const [name, fn] of Object.entries(group)) group[name] = (params) => inRound(() => fn(params));
}

const tasksModulePath = require.resolve('@googleapis/tasks');
const realTasksModule = require('@googleapis/tasks');
require.cache[tasksModulePath].exports = { ...realTasksModule, tasks: () => fakeTasksApi };

/**
 * Fresh data root, signed in, with these items in the «Tasks» and «Habits» lists.
 * @param {{ tasks?: any[], habits?: any[] }} [lists]
 */
function signedInWith(lists = {}) {
  freshDataRoot();
  config.saveGoogleCredentials({ clientId: 'test.apps.googleusercontent.com', clientSecret: 'test-secret' });
  config.writeSecretJson(config.dataPath('tokens.json'), { refresh_token: 'test-refresh' });
  resetAuthClient();
  invalidateListCache();
  invalidatePayloadCache();
  server.listIds = { ...DEFAULT_LIST_IDS };
  server.lists = {
    [server.listIds.tasks]: (lists.tasks || []).map((t) => ({ ...t })),
    [server.listIds.habits]: (lists.habits || []).map((t) => ({ ...t })),
  };
  server.calls = [];
  server.loseResponse = null;
  startRounds();
  return server;
}

/** The item as the fake Google server holds it now. */
function serverItem(listKind, id) {
  const listId = listKind === 'habits' ? server.listIds.habits : server.listIds.tasks;
  return (server.lists[listId] || []).find((t) => t.id === id) || null;
}

module.exports = { signedInWith, serverItem, server, startRounds };
