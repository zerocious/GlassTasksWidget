'use strict';

/**
 * How fast the widget feels with a slow Google (every API call FAKE_LATENCY_MS, default 250 ms):
 * the real app (Electron + Playwright) against the fake Google of test/e2e, on fresh profiles.
 *
 *   npm run bench:app                 (Linux without a display: xvfb-run -a npm run bench:app)
 *   RUNS=5 FAKE_LATENCY_MS=400 npm run bench:app
 *
 * Data: 60 open tasks, 200 completed in the last month (a quarter of them in Google's apps),
 * 300 older ones, 8 habits checked yesterday. Prints medians in ms as JSON.
 *
 *   firstStart    first launch until the lists are on screen
 *   nextDayStart  launch on a new day (habits to reset) until the lists are on screen
 *   sameDayStart  another launch the same day until the lists are on screen
 *   sameDayFresh  …until a change made on the phone meanwhile is on screen
 *   refresh       ↻ until a change made on the phone is on screen
 *   add           Enter until the new task is on screen
 *   addSaved      Enter until Google has it
 *   habitCheckUi  click until the habit shows as done
 *   habitCheckSaved  click until Google has it
 */

const fs = require('fs');
const path = require('path');
const { launch } = require('../test/e2e/helpers/launch');

const RUNS = Number(process.env.RUNS || 3);
const LATENCY = process.env.FAKE_LATENCY_MS || '250';
const pos = (n) => String(n).padStart(20, '0');
const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dataset() {
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const open = Array.from({ length: 60 }, (_, i) => ({
    id: `o${i}`, title: `Открытая задача ${i}`, status: 'needsAction', position: pos(i),
    notes: i % 5 === 0 ? `время 1${i % 10}:30\nзаметка ${i}` : '', ...(i % 3 === 0 ? { due: today } : {}),
  }));
  const recent = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`, title: `Выполнена ${i}`, status: 'completed', completed: ago(1 + (i % 25)),
    position: pos(100 + i), hidden: i % 4 === 0,
  }));
  const old = Array.from({ length: 300 }, (_, i) => ({
    id: `x${i}`, title: `Давняя ${i}`, status: 'completed', completed: ago(60 + i), position: pos(400 + i),
  }));
  const habits = Array.from({ length: 8 }, (_, i) => ({
    id: `h${i}`, title: `Привычка ${i}`, status: 'completed', completed: ago(1), position: pos(i),
  }));
  return { tasks: [...open, ...recent, ...old], habits };
}

async function waitFor(check, what) {
  for (const end = Date.now() + 30000; ; ) {
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}

async function start(opts) {
  const h = await launch({ ...opts, env: { FAKE_LATENCY_MS: LATENCY } });
  await h.win.locator('#list-tasks li.row[data-id="o0"]').waitFor({ timeout: 60000 });
  await h.win.locator('#list-habits li.row[data-id="h0"]').waitFor({ state: 'attached', timeout: 60000 });
  return { ...h, ms: Date.now() - h.startedAt };
}

function editGoogle(h, fn) {
  const g = h.google();
  fn(g);
  h.setGoogle(g);
}

(async () => {
  const keys = ['firstStart', 'nextDayStart', 'sameDayStart', 'sameDayFresh', 'refresh', 'add', 'addSaved',
    'habitCheckUi', 'habitCheckSaved'];
  const res = Object.fromEntries(keys.map((k) => [k, []]));
  for (let run = 0; run < RUNS; run += 1) {
    let h = await start(dataset());
    res.firstStart.push(h.ms);

    editGoogle(h, (g) => { g['L-tasks'].find((t) => t.id === 'o0').title = `Изменено ${run}`; });
    let t = Date.now();
    await h.win.locator('#btnRefresh').click();
    await h.win.locator('li.row[data-id="o0"] .row-title', { hasText: `Изменено ${run}` }).waitFor({ timeout: 60000 });
    res.refresh.push(Date.now() - t);

    const input = h.win.locator('#input-add-tasks');
    await input.fill(`Новая ${run}`);
    t = Date.now();
    await input.press('Enter');
    await h.win.locator('#list-tasks li.row .row-title', { hasText: `Новая ${run}` }).waitFor({ timeout: 60000 });
    res.add.push(Date.now() - t);
    await waitFor(() => h.google()['L-tasks'].some((x) => x.title === `Новая ${run}`), 'add saved');
    res.addSaved.push(Date.now() - t);

    // Let the page finish painting the add first: this measures the click, not that queue.
    await h.win.waitForTimeout(500);
    t = Date.now();
    await h.win.evaluate(() => document.querySelector('#list-habits li.row[data-id="h1"]').click());
    await h.win.locator('#list-habits li.row.done[data-id="h1"]').waitFor({ state: 'attached', timeout: 60000 });
    res.habitCheckUi.push(Date.now() - t);
    await waitFor(() => {
      const habit = h.google()['L-habits'].find((x) => x.id === 'h1');
      return habit.status === 'completed' && Date.parse(habit.completed) > Date.now() - 60000;
    }, 'habit saved');
    res.habitCheckSaved.push(Date.now() - t);
    await h.app.close();

    editGoogle(h, (g) => { g['L-tasks'].find((x) => x.id === 'o1').title = `Свежее ${run}`; });
    const again = await start({ dir: h.dir });
    res.sameDayStart.push(again.ms);
    await again.win.locator('li.row[data-id="o1"] .row-title', { hasText: `Свежее ${run}` }).waitFor({ timeout: 60000 });
    res.sameDayFresh.push(Date.now() - again.startedAt);
    await again.app.close();

    // A new day: habits checked «yesterday» again and the last reset was yesterday.
    editGoogle(h, (g) => { for (const x of g['L-habits']) Object.assign(x, { status: 'completed', completed: ago(1) }); });
    const settingsFile = path.join(h.dir, 'profile', 'data', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
    settings.lastHabitsResetDate =
      `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const nextDay = await start({ dir: h.dir });
    res.nextDayStart.push(nextDay.ms);
    await nextDay.app.close();
  }
  console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, { median: median(res[k]), runs: res[k] }]))));
})().catch((err) => {
  console.error('bench failed:', err);
  process.exit(1);
});
