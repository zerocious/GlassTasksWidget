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

const TASKS_LIST = { id: 'L-tasks', title: 'Tasks' };
const HABITS_LIST = { id: 'L-habits', title: 'Habits' };

/**
 * loseResponse: the next call of that method is applied, then fails like a dropped connection.
 * @type {{ lists: Record<string, any[]>, calls: { method: string, params: any }[], loseResponse: string | null }}
 */
const server = { lists: {}, calls: [], loseResponse: null };

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
      return { data: { items: [TASKS_LIST, HABITS_LIST] } };
    },
  },
  tasks: {
    list: async (params) => {
      server.calls.push({ method: 'tasks.list', params });
      return { data: { items: (server.lists[params.tasklist] || []).map((t) => ({ ...t })) } };
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
  server.lists = {
    [TASKS_LIST.id]: (lists.tasks || []).map((t) => ({ ...t })),
    [HABITS_LIST.id]: (lists.habits || []).map((t) => ({ ...t })),
  };
  server.calls = [];
  server.loseResponse = null;
  return server;
}

/** The item as the fake Google server holds it now. */
function serverItem(listKind, id) {
  const listId = listKind === 'habits' ? HABITS_LIST.id : TASKS_LIST.id;
  return server.lists[listId].find((t) => t.id === id) || null;
}

module.exports = { signedInWith, serverItem, server };
