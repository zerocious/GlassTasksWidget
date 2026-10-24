'use strict';

/**
 * Google mode for lib/google-tasks.js without the network: an in-memory Tasks API behind the
 * real module, a stubbed sign-in and test credentials in a throw-away data folder.
 * Must be required before lib/google-tasks.js (it replaces what that module binds at load).
 */

const path = require('path');

// lib modules may `require('electron')`; these tests never need the real one.
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {} };

const { freshDataRoot } = require('./storage');
const config = require('../../lib/config');
const { saveSettings } = require('../../lib/settings-store');
const { todayIso } = require('../../lib/dates');

/** Signed in unless a test «logs out». */
const session = { signedIn: true };
const auth = require('../../lib/google-auth');
auth.getAuthorizedClient = async () => (session.signedIn ? { fake: 'oauth2' } : null);

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * One fake Google account. Items keep Google's shape (id, title, notes, due, status, completed,
 * parent, position, hidden); sibling order is array order and positions follow it.
 */
function createFakeTasks() {
  /** @type {Map<string, { title: string, items: any[] }>} */
  const lists = new Map();
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  /** Optional async hooks per method, run before it answers (gates, clock jumps). */
  const hooks = {};
  let seq = 0;

  const listOf = (id) => {
    const list = lists.get(id);
    if (!list) throw Object.assign(new Error('Not Found'), { code: 404 });
    return list;
  };
  const find = (listId, taskId) => {
    const item = listOf(listId).items.find((i) => i.id === taskId);
    if (!item) throw Object.assign(new Error('Not Found'), { code: 404 });
    return item;
  };
  const renumber = (list) => {
    const counters = new Map();
    for (const item of list.items) {
      const key = item.parent || '';
      const n = counters.get(key) || 0;
      counters.set(key, n + 1);
      item.position = String(n).padStart(20, '0');
    }
  };
  const placeAfter = (list, item, previousId) => {
    list.items = list.items.filter((i) => i.id !== item.id);
    const at = previousId ? list.items.findIndex((i) => i.id === previousId) + 1 : 0;
    list.items.splice(at, 0, item);
    renumber(list);
  };
  const record = async (method, params) => {
    calls.push({ method, params: clone(params || {}) });
    if (hooks[method]) await hooks[method](params);
  };

  const api = {
    tasklists: {
      list: async (params) => {
        await record('tasklists.list', params);
        return { data: { items: [...lists].map(([id, l]) => ({ id, title: l.title })) } };
      },
    },
    tasks: {
      list: async (params) => {
        await record('tasks.list', params);
        const items = listOf(params.tasklist).items.filter((i) => {
          if (i.status === 'completed' && params.showCompleted === false) return false;
          if (i.hidden && !params.showHidden) return false;
          if (params.completedMin && !(Date.parse(i.completed || '') >= Date.parse(params.completedMin))) {
            return false;
          }
          return true;
        });
        // Pages like Google: `maxResults` per page (default 20), `nextPageToken` while more remain.
        const start = Number(params.pageToken || 0);
        const end = start + (params.maxResults || 20);
        const page = { items: clone(items.slice(start, end)) };
        if (end < items.length) page.nextPageToken = String(end);
        return { data: page };
      },
      get: async (params) => {
        await record('tasks.get', params);
        return { data: clone(find(params.tasklist, params.task)) };
      },
      insert: async (params) => {
        await record('tasks.insert', params);
        const list = listOf(params.tasklist);
        seq += 1;
        const item = { status: 'needsAction', ...clone(params.requestBody), id: `new-${seq}`, parent: params.parent || null };
        placeAfter(list, item, params.previous || null);
        return { data: clone(item) };
      },
      patch: async (params) => {
        await record('tasks.patch', params);
        const item = find(params.tasklist, params.task);
        Object.assign(item, clone(params.requestBody));
        if (item.status !== 'completed') item.hidden = false;
        return { data: clone(item) };
      },
      move: async (params) => {
        await record('tasks.move', params);
        const list = listOf(params.tasklist);
        const item = find(params.tasklist, params.task);
        // Like Google: `previous` and `parent` can not be hidden, and a completed hidden task
        // (ticked in Google's own apps) can only go first at the top level.
        const hiddenRef = [params.previous, params.parent].some((id) => id && find(params.tasklist, id).hidden);
        const pinned = item.hidden && item.status === 'completed' && (params.previous || params.parent);
        if (hiddenRef || pinned) throw Object.assign(new Error('Invalid Value'), { code: 400 });
        // Like Google: no `parent` means «move to the top level».
        item.parent = params.parent || null;
        placeAfter(list, item, params.previous || null);
        return { data: clone(item) };
      },
      delete: async (params) => {
        await record('tasks.delete', params);
        const list = listOf(params.tasklist);
        list.items = list.items.filter((i) => i.id !== params.task && i.parent !== params.task);
        return { data: {} };
      },
    },
  };

  return {
    api,
    calls,
    hooks,
    /** @param {string} id @param {string} title @param {any[]} items in sibling order */
    addList(id, title, items = []) {
      lists.set(id, { title, items: [] });
      this.setItems(id, items);
    },
    /** Replace a list's items (in sibling order). */
    setItems(listId, items) {
      const list = listOf(listId);
      list.items = items.map((i) => ({ status: 'needsAction', parent: null, ...clone(i) }));
      renumber(list);
    },
    /** Google's current copy of an item (a test may edit it, like the phone would). */
    item(listId, taskId) {
      return find(listId, taskId);
    },
    /** Items of a list in sibling order. */
    items(listId) {
      return listOf(listId).items;
    },
    /** Add an item the way another device would (the widget's caches do not know it). */
    addItem(listId, item, previousId = null) {
      const list = listOf(listId);
      placeAfter(list, { status: 'needsAction', parent: null, ...clone(item) }, previousId);
    },
  };
}

/** @type {ReturnType<typeof createFakeTasks>} */
let current = createFakeTasks();
const googleapisPath = require.resolve('@googleapis/tasks', { paths: [path.join(__dirname, '..', '..', 'lib')] });
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  exports: { tasks: () => current.api },
};

/**
 * Fresh data folder, test credentials, signed in, an empty fake account, cold module caches.
 * @param {{ habitsResetDone?: boolean }} [opts] default: today's habits reset already ran
 */
function freshGoogle(opts = {}) {
  const root = freshDataRoot();
  config.saveGoogleCredentials({ clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret' });
  if (opts.habitsResetDone !== false) saveSettings({ lastHabitsResetDate: todayIso() });
  session.signedIn = true;
  current = createFakeTasks();
  const gt = require('../../lib/google-tasks');
  gt.invalidateListCache();
  gt.invalidatePayloadCache();
  const cfg = config.loadConfig();
  current.addList('L-tasks', cfg.tasksListName);
  current.addList('L-habits', cfg.habitsListName);
  return { root, fake: current };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

module.exports = { freshGoogle, session, deferred };
