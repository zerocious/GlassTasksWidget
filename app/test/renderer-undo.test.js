'use strict';

/** Renderer undo window (src/app.js): «… удалена · Отменить» after a delete. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererFunctions } = require('./helpers/renderer');

/**
 * removeItem with the real undo toast, plus the sign-out and Google keys handlers. Google is a
 * fake: deleteItem fails with «Не авторизован» once logout or new keys revoked the tokens.
 */
function undoHarness() {
  const google = { signedIn: true, calls: [] };
  const banners = [];
  const el = () => ({ hidden: true, disabled: false, textContent: '', value: '', setAttribute() {}, removeAttribute() {} });
  const r = loadRendererFunctions(
    [
      'removeItem',
      'showUndoToast',
      'commitPendingUndo',
      'hideUndoToast',
      'onAuthClick',
      'onSaveCredentials',
      'importClientJson',
    ],
    {
      state: {
        mode: 'google',
        tasks: [
          { id: 'a', title: 'Купить молоко', parent: null },
          { id: 'b', title: 'Позвонить', parent: null, completed: false },
          { id: 'c', title: 'Отчёт', parent: null },
        ],
        habits: [],
      },
      pendingIds: new Set(),
      undoState: null,
      UNDO_MS: 5000,
      undoToast: el(),
      undoToastText: el(),
      addBusy: false,
      loginBusy: false,
      credentials: { configured: true },
      inputClientId: { value: 'new-client.apps.googleusercontent.com' },
      inputClientSecret: { value: 'secret' },
      inputRedirectPort: { value: '' },
      btnSaveCredentials: el(),
      btnSkipCredentials: el(),
      onboardingDrop: el(),
      listTasks: {},
      listHabits: {},
      window: {
        widgetApi: {
          deleteItem: async (listKind, id) => {
            google.calls.push(`delete ${id}`);
            if (!google.signedIn) throw new Error('Не авторизован');
          },
          logout: async () => {
            google.calls.push('logout');
            google.signedIn = false;
            return { mode: 'needs_auth', tasks: [], habits: [] };
          },
          saveCredentials: async () => {
            google.calls.push('save keys');
            google.signedIn = false;
            return { data: { mode: 'needs_auth', tasks: [], habits: [] } };
          },
          importClientJson: async () => {
            google.calls.push('import keys');
            google.signedIn = false;
            return { data: { mode: 'needs_auth', tasks: [], habits: [] } };
          },
        },
      },
      guardMutate: () => true,
      signedIn: () => true,
      startLogin: () => {},
      syncCredentialsForm: () => {},
      applyCredentialsResult: (result) => {
        r.state = result.data;
      },
      setOnboardingError: () => {},
      rowById: () => null,
      ensureListEmpty: () => {},
      filterVisibleItems: (items) => items,
      resortTasksLocal: () => {},
      resortHabitsLocal: () => {},
      renderTasks: () => {},
      renderHabits: () => {},
      renderAll: () => {},
      pluralRu: (n) => String(n),
      setBanner: (text) => banners.push(text),
      errText: (err) => String((err && err.message) || err),
    }
  );
  return { r, google, banners };
}

/** What a click on «Отменить» does (the undoToastBtn listener). */
function clickUndo(r) {
  const entry = r.undoState;
  r.undoState = null;
  clearTimeout(entry.timer);
  entry.undo();
}

test('«Отменить» after ↻ keeps what the refresh brought for the other tasks', async () => {
  const { r } = undoHarness();
  const deleted = r.state.tasks[0];
  await r.removeItem('tasks', deleted);
  assert.deepEqual([...r.state.tasks.map((t) => t.id)], ['b', 'c']);
  // ↻ / R within the 5 s: «Позвонить» was renamed and completed on the phone, «Купить хлеб» is new.
  r.state = {
    mode: 'google',
    tasks: [
      { id: 'b', title: 'Позвонить маме', parent: null, completed: true },
      { id: 'c', title: 'Отчёт', parent: null },
      { id: 'd', title: 'Купить хлеб', parent: null },
    ],
    habits: [],
  };
  const fresh = r.state.tasks.slice();
  clickUndo(r);
  assert.deepEqual([...r.state.tasks.map((t) => t.id)].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(r.state.tasks.find((t) => t.id === 'a'), deleted, 'the deleted task is back');
  const b = r.state.tasks.find((t) => t.id === 'b');
  assert.equal(b, fresh[0], 'not the pre-refresh copy');
  assert.equal(b.title, 'Позвонить маме');
  assert.equal(b.completed, true);
  assert.equal(r.state.tasks.find((t) => t.id === 'c'), fresh[1]);
  assert.equal(r.pendingIds.has('a'), false);
});

test('«Выйти» during the undo window deletes the task in Google first; it does not come back', async () => {
  const { r, google, banners } = undoHarness();
  await r.removeItem('tasks', r.state.tasks[0]);
  await r.onAuthClick();
  assert.deepEqual([...google.calls], ['delete a', 'logout']);
  assert.equal(r.state.mode, 'needs_auth');
  assert.deepEqual([...r.state.tasks], [], 'no «deleted» task in the signed-out widget');
  assert.deepEqual(banners, []);
  assert.equal(r.undoState, null);
  assert.equal(r.undoToast.hidden, true);
});

test('new Google keys during the undo window: the delete goes first (form and client_secret.json)', async () => {
  for (const submit of ['onSaveCredentials', 'importClientJson']) {
    const { r, google, banners } = undoHarness();
    await r.removeItem('tasks', r.state.tasks[0]);
    await r[submit]();
    assert.deepEqual(
      [...google.calls],
      ['delete a', submit === 'onSaveCredentials' ? 'save keys' : 'import keys'],
      submit
    );
    assert.deepEqual([...r.state.tasks], [], submit);
    assert.deepEqual(banners, [], submit);
  }
});

test('commitPendingUndo hands back the delete so callers can wait for Google', async () => {
  const { r, google } = undoHarness();
  assert.equal(r.commitPendingUndo(), undefined, 'nothing pending');
  await r.removeItem('tasks', r.state.tasks[0]);
  const pending = r.commitPendingUndo();
  assert.equal(typeof pending?.then, 'function');
  await pending;
  assert.deepEqual([...google.calls], ['delete a']);
  assert.equal(r.pendingIds.has('a'), false);
});
