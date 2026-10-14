'use strict';

/**
 * Offline-cache cost: before (pretty JSON written synchronously on every mutation) vs now
 * (encrypted, compact, debounced). Works in a temp folder only — never touches a profile.
 *
 *   node scripts/bench-storage.js              AES-256-GCM stand-in for safeStorage
 *   npx electron scripts/bench-storage.js      real Electron safeStorage (DPAPI on Windows)
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNS = 25;
const SIZES = [50, 200, 1000];
const HABITS = 10;

function electronApp() {
  try {
    const { app } = require('electron');
    return app && typeof app.whenReady === 'function' ? app : null;
  } catch {
    return null;
  }
}

/** Same contract as safeStorage; AES-256-GCM like an in-process cipher with a cached key. */
function aesStandIn() {
  const key = crypto.randomBytes(32);
  return {
    label: 'AES-256-GCM (node, заменитель safeStorage)',
    isEncryptionAvailable: () => true,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decryptString(b) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

function payload(taskCount) {
  const notes = 'Уточнить детали у Марии, взять документы, позвонить в 14:30. '.repeat(3);
  const dates = [];
  for (let i = 0; i < 800; i += 1) dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
  return {
    mode: 'google',
    tasksListName: 'Tasks',
    habitsListName: 'Habits',
    accentColor: '#C4122E',
    tasksListFound: true,
    habitsListFound: true,
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `MTIzNDU2Nzg5MDEyMzQ1Njc4OTA${i}`,
      title: `Задача номер ${i}: подготовить отчёт по проекту`,
      notes,
      due: '2026-10-14T00:00:00.000Z',
      dueKind: 'today',
      dueTime: '14:30',
      recurrence: null,
      status: 'needsAction',
      completed: false,
      position: String(i).padStart(20, '0'),
      parent: null,
      meta: 'Сегодня · 14:30',
    })),
    // What the widget payload carries for habits (stats included), as the old cache stored it.
    habits: Array.from({ length: HABITS }, (_, i) => ({
      id: `habit-${i}`,
      title: `Привычка ${i}`,
      notes: '',
      status: 'needsAction',
      completed: false,
      habitId: `habit-${i}`,
      streak: 12,
      week: [true, true, false, true, true, true, true],
      ring: 86,
      completedToday: true,
      completedDates: dates,
    })),
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(fn) {
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = process.hrtime.bigint();
    fn(i);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(samples);
}

/** The pre-change path: pretty JSON, temp file + rename, on every mutation. */
function oldWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function run(safeStorage) {
  const config = require('../lib/config');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bench-')), 'data');
  config.setDataRootForTests(root);
  config.setSafeStorageForTests(safeStorage);
  const cache = require('../lib/offline-cache');
  const { flushAllDocs } = require('../lib/storage-doc');
  fs.mkdirSync(root, { recursive: true });
  const cacheFile = path.join(root, 'offline-cache.json');
  const oldFile = path.join(root, 'old-offline-cache.json');

  const rows = [];
  for (const n of SIZES) {
    const p = payload(n);
    const oldMutation = time(() => oldWrite(oldFile, { savedAt: new Date().toISOString(), ...p }));
    const oldBytes = fs.statSync(oldFile).size;

    cache.resetOfflineCacheMemory();
    const newMutation = time((i) => cache.saveOfflineCache({ ...p, tasksListName: `Tasks${i}` }));
    const deferredWrite = time(() => {
      cache.saveOfflineCache(p);
      flushAllDocs();
    });
    const newBytes = fs.statSync(cacheFile).size;
    const startupRead = time(() => {
      cache.resetOfflineCacheMemory();
      cache.loadOfflineCache();
    });
    rows.push({ n, oldBytes, newBytes, oldMutation, newMutation, deferredWrite, startupRead });
  }
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  return rows;
}

function report(label, rows) {
  const kb = (b) => `${(b / 1024).toFixed(0)} КБ`;
  const ms = (v) => `${v.toFixed(2)} мс`;
  console.log(`\nШифрование: ${label}; медиана из ${RUNS} прогонов; ${os.platform()} ${os.release()}\n`);
  console.log('| Задач | Файл было | Файл стало | Мутация было (sync запись) | Мутация стало | Отложенная запись (шифр + fsync) | Чтение при старте |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.n} | ${kb(r.oldBytes)} | ${kb(r.newBytes)} | ${ms(r.oldMutation)} | ${ms(r.newMutation)} | ${ms(r.deferredWrite)} | ${ms(r.startupRead)} |`
    );
  }
}

const app = electronApp();
if (app) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bench-profile-')));
  app.whenReady().then(() => {
    const { safeStorage } = require('electron');
    if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable()) {
      safeStorage.setUsePlainTextEncryption(true);
    }
    const label = `Electron safeStorage (${process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform})`;
    report(label, run(undefined));
    app.quit();
  });
} else {
  const standIn = aesStandIn();
  report(standIn.label, run(standIn));
}
