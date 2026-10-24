'use strict';

/** Renderer edit panels (src/app.js): notes, time, the Google keys form. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererFunctions } = require('./helpers/renderer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** saveNotesPanel / saveTimePanel with an updateItem call the test answers by hand. */
function panelHarness() {
  const reply = deferred();
  const calls = { banners: [], patched: [], closedNotes: 0, closedTime: 0 };
  const r = loadRendererFunctions(['saveNotesPanel', 'saveTimePanel'], {
    notesTarget: { listKind: 'tasks', itemId: 'a', original: 'старые' },
    notesSaving: false,
    timeTarget: { listKind: 'tasks', itemId: 'a', original: null },
    timeSaving: false,
    state: {
      tasks: [
        { id: 'a', title: 'A', notes: 'старые', dueTime: null },
        { id: 'b', title: 'B', notes: 'заметки B', dueTime: '18:00' },
      ],
      habits: [],
    },
    window: { widgetApi: { updateItem: () => reply.promise } },
    guardMutate: () => true,
    notesTextarea: { value: 'новые' },
    btnNotesSave: { disabled: false },
    timeInput: { value: '9:30' },
    btnTimeSave: { disabled: false },
    btnTimeClear: { disabled: false },
    patchTaskRow: (item) => calls.patched.push(item.id),
    patchHabitRow: (item) => calls.patched.push(item.id),
    setBanner: (text) => calls.banners.push(text),
    errText: (err) => String((err && err.message) || err),
  });
  r.closeNotesPanel = () => {
    calls.closedNotes += 1;
    r.notesTarget = null;
  };
  r.closeTimePanel = () => {
    calls.closedTime += 1;
    r.timeTarget = null;
  };
  return { r, reply, calls };
}

test('notes saved after the panel was closed: no false error, the row is still updated', async () => {
  const { r, reply, calls } = panelHarness();
  const saving = r.saveNotesPanel({ closeAfter: true });
  r.notesTarget = null; // Esc / «Отмена» while Google is answering
  reply.resolve({ item: { meta: 'новые' } });
  assert.equal(await saving, true);
  assert.deepEqual(calls.banners, [], 'Google did save the notes');
  assert.deepEqual(calls.patched, ['a'], 'the notes indicator is updated');
  assert.equal(r.state.tasks[0].notes, 'новые');
  assert.equal(calls.closedNotes, 0);
});

test('a notes save that lands while another item is open leaves that panel alone', async () => {
  const { r, reply, calls } = panelHarness();
  const saving = r.saveNotesPanel({ closeAfter: true });
  const other = { listKind: 'tasks', itemId: 'b', original: 'заметки B' };
  r.notesTarget = other; // closed A, opened Notes on B
  reply.resolve({ item: {} });
  assert.equal(await saving, true);
  assert.equal(other.original, 'заметки B', "A's text does not become B's original");
  assert.equal(calls.closedNotes, 0, "B's panel stays open with what was typed there");
  assert.equal(r.notesTarget, other);
  assert.equal(r.state.tasks[1].notes, 'заметки B');
});

test('a notes save closes its own panel when asked', async () => {
  const { r, reply, calls } = panelHarness();
  const target = r.notesTarget;
  const saving = r.saveNotesPanel({ closeAfter: true });
  reply.resolve({ item: {} });
  assert.equal(await saving, true);
  assert.equal(target.original, 'новые');
  assert.equal(calls.closedNotes, 1);
});

test('time saved after the panel was closed: no false error, the time chip is updated', async () => {
  const { r, reply, calls } = panelHarness();
  const saving = r.saveTimePanel({ closeAfter: true });
  r.timeTarget = null;
  reply.resolve({ item: { dueTime: '09:30' } });
  assert.equal(await saving, true);
  assert.deepEqual(calls.banners, []);
  assert.deepEqual(calls.patched, ['a']);
  assert.equal(r.state.tasks[0].dueTime, '09:30');
  assert.equal(calls.closedTime, 0);
});

function notesBlurHarness() {
  const cancel = { name: 'btnNotesCancel' };
  const close = { name: 'btnNotesClose' };
  const save = { name: 'btnNotesSave' };
  const saves = [];
  const r = loadRendererFunctions(['onNotesBlur'], {
    notesIgnoreBlur: false,
    notesTarget: { listKind: 'tasks', itemId: 'a', original: '' },
    notesSaving: false,
    notesOverlay: {
      hidden: false,
      classList: { contains: (c) => c === 'is-open' },
      contains: (node) => node === cancel || node === close || node === save,
    },
    saveNotesPanel: (opts) => saves.push(opts),
  });
  return { r, saves, cancel, close, save };
}

test('Tab from the notes text to «Отмена» or × does not save the edit before Cancel runs', async () => {
  const { r, saves, cancel, close } = notesBlurHarness();
  r.onNotesBlur({ relatedTarget: cancel });
  r.onNotesBlur({ relatedTarget: close });
  await sleep(160);
  assert.deepEqual(saves, []);
});

test('Tab to «Сохранить» leaves the save to the button (no autosave racing it)', async () => {
  const { r, saves, save } = notesBlurHarness();
  r.onNotesBlur({ relatedTarget: save });
  await sleep(160);
  assert.deepEqual(saves, []);
});

test('leaving the notes text any other way (window loses focus) still autosaves', async () => {
  const { r, saves } = notesBlurHarness();
  r.onNotesBlur({ relatedTarget: null });
  await sleep(160);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].closeAfter, false);
});

test('a time save that lands while another item is open leaves that panel alone', async () => {
  const { r, reply, calls } = panelHarness();
  const saving = r.saveTimePanel({ closeAfter: true });
  const other = { listKind: 'tasks', itemId: 'b', original: '18:00' };
  r.timeTarget = other;
  reply.resolve({ item: { dueTime: '09:30' } });
  assert.equal(await saving, true);
  assert.equal(other.original, '18:00');
  assert.equal(calls.closedTime, 0);
  assert.equal(r.timeTarget, other);
});
