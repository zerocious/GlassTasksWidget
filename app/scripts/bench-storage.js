'use strict';

/**
 * Measures what the offline cache costs, to back the «encrypt it, write it debounced» decision.
 *
 *   node scripts/bench-storage.js              # JSON + file write + AES-GCM stand-in (NOT DPAPI)
 *   npx electron scripts/bench-storage.js      # same, with the REAL safeStorage (DPAPI on Windows)
 *
 * Uses a throw-away folder; never touches app/data or %APPDATA%.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../lib/config');
const offline = require('../lib/offline-cache');

const RUNS = 20;
const SIZES = [50, 200, 1000, 5000];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function bench(fn) {
  fn(); // warm up
  return median(Array.from({ length: RUNS }, () => time(fn)));
}

function payload(n) {
  return {
    mode: 'google',
    tasksListName: 'Tasks',
    habitsListName: 'Habits',
    accentColor: '#C4122E',
    tasksListFound: true,
    habitsListFound: true,
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `task-${i}-${crypto.randomBytes(8).toString('hex')}`,
      title: `Task number ${i}: prepare the quarterly report and send it to the team`,
      notes: 'время 09:30\nповтор: ежедневно\nCheck the budget section before Friday',
      due: '2026-10-15T00:00:00.000Z',
      status: 'needsAction',
      completed: false,
      parent: null,
      position: String(i).padStart(20, '0'),
      meta: 'Today',
    })),
    habits: [],
  };
}

function aesStandIn() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]);
    },
    decryptString: (b) => {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
    },
  };
}

function run(label, ss) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bench-'));
  const dir = path.join(base, 'data');
  fs.mkdirSync(dir);
  config.setDataRootForTests(dir);
  const file = path.join(dir, 'offline-cache.json');

  console.log(`\nOffline cache cost, median of ${RUNS} runs (${label})`);
  console.log('tasks | JSON KB | stringify | plain write | encrypt | write enc. | read+decrypt | saveOfflineCache() call');
  for (const n of SIZES) {
    const p = payload(n);
    const text = JSON.stringify(p);
    const kb = (Buffer.byteLength(text) / 1024).toFixed(0);
    const stringify = bench(() => JSON.stringify(p));
    const plainWrite = bench(() => config.writeFileAtomic(file, text));
    const encrypt = bench(() => ss.encryptString(text));
    const writeEnc = bench(() => config.writeSecretJson(file, p));
    const readDec = bench(() => config.readSecretJson(file, null));
    // The mutation path: update memory + arm the debounce timer. No disk, no encryption.
    offline.resetOfflineCacheForTests();
    const call = bench(() => offline.saveOfflineCache(p));
    offline.resetOfflineCacheForTests();
    const f = (v) => `${v.toFixed(2)} ms`.padStart(9);
    console.log(`${String(n).padStart(5)} | ${kb.padStart(7)} | ${f(stringify)} | ${f(plainWrite)} | ${f(encrypt)} | ${f(writeEnc)} | ${f(readDec)} | ${f(call)}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

function main() {
  let label = 'AES-256-GCM stand-in, NOT DPAPI — run with `electron` for real numbers';
  let ss = null;
  if (process.versions.electron) {
    const { safeStorage } = require('electron');
    if (safeStorage.isEncryptionAvailable()) {
      ss = safeStorage;
      label = `Electron safeStorage on ${process.platform}`;
    } else {
      label = 'Electron, but safeStorage is unavailable here — falling back to the AES stand-in';
    }
  }
  ss = ss || aesStandIn();
  config.setSafeStorageForTests(ss);
  run(label, ss);
}

if (process.versions.electron) {
  const { app } = require('electron');
  app.whenReady().then(() => {
    main();
    app.quit();
  });
} else {
  main();
}
