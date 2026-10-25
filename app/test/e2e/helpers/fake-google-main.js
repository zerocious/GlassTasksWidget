'use strict';

/**
 * Preloaded into the widget's main process (`electron -r this-file app`): a signed-in profile and
 * a file-backed Google Tasks API, so the real app can be driven without the network.
 *
 * Environment (set by launch.js): GT_USER_DATA_DIR, FAKE_GOOGLE_STATE (JSON: list id → items),
 * FAKE_GOOGLE_LOG (one JSON line per write), FAKE_LATENCY_MS (every call), FAKE_INSERT_DELAY_MS,
 * FAKE_DELETE_DELAY_MS, FAKE_INSERT_FAIL, E2E_SETTINGS (settings saved before start).
 */

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..', '..');
const STATE = process.env.FAKE_GOOGLE_STATE;
const LOG = process.env.FAKE_GOOGLE_LOG;
const LATENCY = Number(process.env.FAKE_LATENCY_MS || 0);
const INSERT_DELAY = Number(process.env.FAKE_INSERT_DELAY_MS || 0);
const DELETE_DELAY = Number(process.env.FAKE_DELETE_DELAY_MS || 0);

const config = require(path.join(APP, 'lib/config'));
const dataRoot = path.join(process.env.GT_USER_DATA_DIR, 'data');
fs.mkdirSync(dataRoot, { recursive: true });
config.setDataRootForTests(dataRoot);
config.setSafeStorageForTests({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8').slice(4), 'base64').toString('utf8'),
});
config.saveGoogleCredentials({ clientId: 'e2e.apps.googleusercontent.com', clientSecret: 'e2e-secret' });
config.writeSecretJson(config.dataPath('tokens.json'), { refresh_token: 'e2e-refresh' });
if (process.env.E2E_SETTINGS) {
  require(path.join(APP, 'lib/settings-store')).saveSettings(JSON.parse(process.env.E2E_SETTINGS));
}

const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
/** Atomic, so the test process never reads a half-written file. */
const save = (s) => {
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${STATE}.tmp`, STATE);
};
const log = (m, p) => fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), m, p })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (s, p) => {
  const t = (s[p.tasklist] || []).find((x) => x.id === p.task);
  if (!t) {
    const e = new Error('Not Found');
    e.response = { status: 404 };
    throw e;
  }
  return t;
};
let seq = 0;

const api = {
  tasklists: { list: async () => ({ data: { items: [{ id: 'L-tasks', title: 'Tasks' }, { id: 'L-habits', title: 'Habits' }] } }) },
  tasks: {
    // As documented: hidden items (completed in Google's apps) only with showHidden; pages of 100.
    list: async (p) => {
      const min = p.completedMin ? Date.parse(p.completedMin) : null;
      const items = (load()[p.tasklist] || []).filter((t) => {
        if (t.hidden && !p.showHidden) return false;
        if (t.status === 'completed' && p.showCompleted === false) return false;
        if (min !== null && !(t.completed && Date.parse(t.completed) >= min)) return false;
        return true;
      });
      const size = Math.min(p.maxResults || 20, 100);
      const start = Number(p.pageToken || 0);
      const next = start + size < items.length ? String(start + size) : undefined;
      return { data: { items: items.slice(start, start + size), nextPageToken: next } };
    },
    get: async (p) => ({ data: { ...find(load(), p) } }),
    patch: async (p) => {
      const s = load();
      const t = find(s, p);
      Object.assign(t, p.requestBody);
      save(s);
      log('patch', { task: p.task, body: p.requestBody });
      return { data: { ...t } };
    },
    insert: async (p) => {
      log('insert:start', p.requestBody.title);
      await sleep(INSERT_DELAY);
      if (process.env.FAKE_INSERT_FAIL) {
        const e = new Error('Invalid value');
        e.response = { status: 400 };
        throw e;
      }
      const s = load();
      seq += 1;
      const t = { id: `n${Date.now()}-${seq}`, status: 'needsAction', notes: '', position: '0'.repeat(20), ...p.requestBody };
      if (p.parent) t.parent = p.parent;
      s[p.tasklist].unshift(t);
      save(s);
      log('insert', t.title);
      return { data: t };
    },
    delete: async (p) => {
      log('delete:start', p.task);
      await sleep(DELETE_DELAY);
      const s = load();
      const list = s[p.tasklist];
      list.splice(list.indexOf(find(s, p)), 1);
      save(s);
      log('delete', p.task);
      return { data: '' };
    },
    move: async (p) => ({ data: { ...find(load(), p) } }),
  },
};

for (const group of [api.tasklists, api.tasks]) {
  for (const [name, fn] of Object.entries(group)) {
    group[name] = async (p) => {
      if (LATENCY) await sleep(LATENCY);
      return fn(p);
    };
  }
}

const modPath = require.resolve('@googleapis/tasks', { paths: [APP] });
const realModule = require(modPath); // loaded first: the cache entry exists only after this
require.cache[modPath].exports = { ...realModule, tasks: () => api };
