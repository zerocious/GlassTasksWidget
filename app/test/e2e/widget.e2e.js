'use strict';

/**
 * The real widget (Electron) against a fake Google: what unit tests cannot see — the page,
 * the main process and the quit sequence together. Needs the Electron binary and a display
 * (on Linux: `xvfb-run -a npm run test:e2e`). Not part of `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { launch, until, pos, daysAgo } = require('./helpers/launch');

const rowTitles = (win, list) =>
  win.$$eval(`${list} li.row .row-title`, (els) => els.map((e) => e.textContent));

test('a delete still in its undo window reaches Google when the app quits at once', async (t) => {
  const h = await launch({
    t,
    tasks: [
      { id: 'T1', title: 'Удалить и выйти', status: 'needsAction', position: pos(1) },
      { id: 'T2', title: 'Остаётся', status: 'needsAction', position: pos(2) },
    ],
    env: { FAKE_DELETE_DELAY_MS: '800' },
  });
  await h.win.locator('li.row[data-id="T1"]').focus();
  await h.win.keyboard.press('Delete');
  await h.win.locator('#undoToast').waitFor();
  const exited = new Promise((r) => h.app.process().once('exit', r));
  await h.app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;

  assert.deepEqual(h.google()['L-tasks'].map((t) => t.id), ['T2']);
});

test('a quit with nothing pending is not held up', async (t) => {
  const h = await launch({ t, tasks: [{ id: 'T1', title: 'Задача', status: 'needsAction', position: pos(1) }] });
  await h.win.locator('li.row[data-id="T1"]').waitFor();
  const started = Date.now();
  const exited = new Promise((r) => h.app.process().once('exit', r));
  await h.app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;

  assert.ok(Date.now() - started < 2000, `quit took ${Date.now() - started} ms`);
});

test('a new task is on screen before Google answers and becomes Google\'s item', async (t) => {
  const h = await launch({ t, env: { FAKE_INSERT_DELAY_MS: '1500' } });
  const input = h.win.locator('#input-add-tasks');
  await input.fill('Сразу видна');
  const started = Date.now();
  await input.press('Enter');
  const row = h.win.locator('#list-tasks li.row', { hasText: 'Сразу видна' }).first();
  await row.waitFor();
  const shownMs = Date.now() - started;
  assert.ok(await row.evaluate((el) => el.classList.contains('is-pending')));
  await row.evaluate((el) => el.querySelector('.check').click()); // not actionable yet

  await until(async () => (await h.win.$$('#list-tasks li.row.is-pending')).length === 0, 'Google item');
  await h.app.close();

  assert.ok(shownMs < 500, `shown after ${shownMs} ms`);
  assert.equal(h.calls().filter((c) => c.m === 'patch').length, 0);
  assert.deepEqual(h.google()['L-tasks'].map((t) => t.title), ['Сразу видна']);
});

test('a failed add removes its row and gives the text back', async (t) => {
  const h = await launch({ t, env: { FAKE_INSERT_DELAY_MS: '300', FAKE_INSERT_FAIL: '1' } });
  const input = h.win.locator('#input-add-tasks');
  await input.fill('Не сохранится');
  await input.press('Enter');
  await until(async () => (await input.inputValue()) === 'Не сохранится', 'text back');
  const rows = await rowTitles(h.win, '#list-tasks');
  const banner = await h.win.evaluate(() => document.body.innerText.includes('Не удалось добавить «Не сохранится»'));
  await h.app.close();

  assert.deepEqual(rows, []);
  assert.ok(banner);
});

test('text typed while a task is saving is kept, and Enter then adds it next', async (t) => {
  const h = await launch({ t, env: { FAKE_INSERT_DELAY_MS: '1200' } });
  const input = h.win.locator('#input-add-tasks');
  await input.fill('Первая');
  await input.press('Enter');
  await input.type('Вторая');
  await input.press('Enter');
  await until(() => h.google()['L-tasks'].length === 2, 'both saved');
  const kept = await input.inputValue();
  await h.app.close();

  assert.equal(kept, '');
  assert.deepEqual(h.google()['L-tasks'].map((t) => t.title).sort(), ['Вторая', 'Первая']);
});

test('a subtask entered while another task is saving is not dropped', async (t) => {
  const h = await launch({
    t,
    tasks: [{ id: 'T1', title: 'Родитель', status: 'needsAction', position: pos(1) }],
    env: { FAKE_INSERT_DELAY_MS: '1200' },
  });
  const input = h.win.locator('#input-add-tasks');
  await input.fill('Основная');
  await input.press('Enter');
  await h.win.locator('li.row[data-id="T1"]').click({ button: 'right' });
  await h.win.locator('[data-action="subtask"]').click();
  await h.win.locator('.row-sub-edit-input').type('Подзадача');
  await h.win.locator('.row-sub-edit-input').press('Enter');
  await until(() => h.google()['L-tasks'].length === 3, 'subtask saved', 20000);
  await h.app.close();

  assert.equal(h.google()['L-tasks'].find((t) => t.title === 'Подзадача').parent, 'T1');
});

test('renaming keeps a long Google title whole and leaves an untouched one alone', async (t) => {
  const long = `${'Очень длинное название задачи. '.repeat(10).trim()} конец`;
  const h = await launch({
    t,
    tasks: [
      { id: 'L1', title: long, status: 'needsAction', position: pos(1) },
      { id: 'S1', title: '  С пробелами  ', status: 'needsAction', position: pos(2) },
    ],
  });
  await h.win.locator('li.row[data-id="L1"]').focus();
  await h.win.keyboard.press('F2');
  await h.win.locator('li.row[data-id="L1"] .row-title-edit').press('End');
  await h.win.keyboard.type('!');
  await h.win.keyboard.press('Enter');
  await until(() => h.google()['L-tasks'][0].title.endsWith('!'), 'rename saved');
  await h.win.locator('li.row[data-id="S1"]').focus();
  await h.win.keyboard.press('F2');
  await h.win.keyboard.press('Enter');
  await h.win.waitForTimeout(500);
  await h.app.close();

  assert.equal(h.google()['L-tasks'][0].title, `${long}!`);
  assert.ok(!h.calls().some((c) => c.m === 'patch' && c.p.task === 'S1'));
});

test('an Enter that confirms IME input does not save the field', async (t) => {
  const h = await launch({ t, tasks: [{ id: 'T1', title: 'Задача', status: 'needsAction', position: pos(1) }] });
  await h.win.locator('li.row[data-id="T1"]').focus();
  await h.win.keyboard.press('F2');
  const sel = 'li.row[data-id="T1"] .row-title-edit';
  await h.win.locator(sel).fill('任务');
  await h.win.evaluate((s) => {
    document.querySelector(s).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    );
  }, sel);
  const stillEditing = await h.win.locator(sel).count();
  await h.app.close();

  assert.equal(stillEditing, 1);
});

test('a window left on a monitor that is gone comes back', async (t) => {
  const h = await launch({ t });
  await h.app.evaluate(({ BrowserWindow, screen }) => {
    BrowserWindow.getAllWindows()[0].setPosition(5000, 300);
    screen.emit('display-removed', {}, screen.getPrimaryDisplay());
  });
  await h.win.waitForTimeout(1000);
  const b = await h.bounds();
  const wa = await h.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  await h.app.close();

  assert.ok(b.x + 80 <= wa.x + wa.width && b.y >= wa.y, JSON.stringify(b));
});

test('what the user sees from Google: phone check-ins, recent completions, quick add', async (t) => {
  const h = await launch({
    t,
    tasks: [
      { id: 'E1', title: 'Эмодзи', status: 'needsAction', notes: `${'a'.repeat(36)}😀 конец строки`, position: pos(1) },
      { id: 'N1', title: 'МФЦ', status: 'needsAction', notes: 'Офис открыт 9:00-18:00', position: pos(2) },
      { id: 'J1', title: 'Выполнить сейчас', status: 'needsAction', position: pos(9) },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        id: `D${n}`, title: `Старая ${n}`, status: 'completed', completed: daysAgo(10 + n), position: pos(n + 2),
      })),
    ],
    habits: [
      { id: 'H1', title: 'Зарядка', status: 'completed', completed: new Date().toISOString(), position: pos(1) },
      { id: 'H2', title: 'Чтение', status: 'completed', completed: daysAgo(1), position: pos(2) },
      { id: 'H3', title: 'Вода', status: 'completed', completed: new Date().toISOString(), hidden: true, position: pos(3) },
    ],
  });
  const w = h.win;
  await w.locator('li.row[data-id="E1"]').waitFor();
  const meta = await w.locator('li.row[data-id="E1"] .row-meta').textContent();
  const timeChips = await w.locator('li.row[data-id="N1"] .row-time').count();

  await w.locator('li.row[data-id="J1"] .check').click();
  await until(() => h.google()['L-tasks'].find((t) => t.id === 'J1').status === 'completed', 'J1 saved');
  await w.locator('#btnRefresh').click();
  await w.waitForTimeout(800);
  const done = await w.$$eval('#list-tasks li.row', (els) =>
    els.filter((e) => e.querySelector('.check.done')).map((e) => e.dataset.id));

  const habitDone = (id) => w.locator(`#list-habits li.row.done[data-id="${id}"]`).count();
  const habits = { H1: await habitDone('H1'), H2: await habitDone('H2'), H3: await habitDone('H3') };
  await until(() => h.google()['L-habits'].find((t) => t.id === 'H2').status === 'needsAction', 'H2 reset');

  const input = w.locator('#input-add-tasks');
  for (const title of ['Купить 1.5 л молока', 'С 9:00 до 18:00 работа']) {
    await input.fill(title);
    await input.press('Enter');
    await until(() => h.google()['L-tasks'].some((t) => t.title === title), `${title} saved`);
  }
  const added = h.google()['L-tasks'].filter((t) => t.title.startsWith('Купить') || t.title.startsWith('С 9:00'));
  await h.app.close();

  assert.ok(meta.includes('😀') && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(meta), meta);
  assert.equal(timeChips, 0);
  assert.ok(done.includes('J1'), done.join(','));
  assert.deepEqual(habits, { H1: 1, H2: 0, H3: 1 });
  assert.deepEqual(added.map((t) => [t.title, t.due || null]).sort(), [
    ['Купить 1.5 л молока', null],
    ['С 9:00 до 18:00 работа', null],
  ]);
});

test('a second launch paints the last run\'s tasks, then the current ones', async (t) => {
  const first = await launch({
    t,
    tasks: [{ id: 'T1', title: 'Вчерашнее', status: 'needsAction', position: pos(1) }],
    env: { FAKE_LATENCY_MS: '400' },
  });
  await first.win.locator('li.row[data-id="T1"]').waitFor();
  await first.app.close();
  const g = first.google();
  g['L-tasks'][0].title = 'Изменено на телефоне';
  first.setGoogle(g);

  const second = await launch({ t, dir: first.dir, env: { FAKE_LATENCY_MS: '400' } });
  await second.win.locator('li.row[data-id="T1"]').waitFor();
  const paintedMs = Date.now() - second.startedAt;
  await second.win.locator('li.row[data-id="T1"] .row-title', { hasText: 'Изменено на телефоне' }).waitFor();
  await second.app.close();

  assert.ok(paintedMs < 5000, `painted after ${paintedMs} ms`);
});

test('demo mode shows the time written in the notes, not a fake 12:00', async (t) => {
  const { _electron } = require('playwright-core');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.resolve(__dirname, '..', '..')],
    env: { ...process.env, GT_USER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-demo-')) },
  });
  t.after(() => app.close().catch(() => {}));
  const win = await app.firstWindow();
  await win.locator('li.row[data-id="mock-t1"]').waitFor();
  const times = await win.$$eval('#list-tasks li.row', (els) =>
    els.map((e) => e.querySelector('.row-time')?.textContent || null).filter(Boolean));
  await app.close();

  assert.deepEqual(times, ['09:30']);
});
