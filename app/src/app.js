'use strict';

const panels = document.getElementById('panels');
const viewTitle = document.getElementById('viewTitle');
const sourceLabel = document.getElementById('sourceLabel');
const viewIcon = document.getElementById('viewIcon');
const panelTasks = document.getElementById('panel-tasks');
const panelHabits = document.getElementById('panel-habits');
const listTasks = document.getElementById('list-tasks');
const listHabits = document.getElementById('list-habits');
const statusBanner = document.getElementById('statusBanner');
const offlinePill = document.getElementById('offlinePill');
const btnAuth = document.getElementById('btnAuth');
const btnSettings = document.getElementById('btnSettings');
const settingsPanel = document.getElementById('settingsPanel');
const optAutostart = document.getElementById('optAutostart');
const optSnap = document.getElementById('optSnap');
const hkToggle = document.getElementById('hkToggle');
const hkSwitch = document.getElementById('hkSwitch');
const inputAddTasks = document.getElementById('input-add-tasks');
const inputAddHabits = document.getElementById('input-add-habits');

const icons = {
  tasks: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg>',
  habits: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
};

/** @type {any} */
let state = {
  mode: 'mock',
  tasks: [],
  habits: [],
  tasksListName: 'Tasks',
  habitsListName: 'Habits',
  accentColor: '#C4122E',
  offline: false,
};

/** @type {any} */
let settings = {
  theme: 'dark',
  size: 'normal',
  autostart: false,
  snapToEdge: false,
};

let view = 'tasks';
/** @type {Set<string>} */
const pendingIds = new Set();
let addBusy = false;
/** @type {Promise<void> | null} */
let loadInFlight = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let settingsWriteTimer = null;
/** @type {Record<string, any>} */
let settingsWritePending = {};
let lastAccent = '';
let lastIconView = '';

function formatAccel(accel) {
  return String(accel || '')
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Command/gi, '⌘')
    .replace(/\+/g, '+');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function applySize(size) {
  document.documentElement.setAttribute('data-size', size === 'compact' ? 'compact' : 'normal');
}

function syncSettingsUi() {
  applyTheme(settings.theme);
  applySize(settings.size);

  document.querySelectorAll('.seg-btn[data-setting="theme"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.theme));
  });
  document.querySelectorAll('.seg-btn[data-setting="size"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.size));
  });

  optAutostart.checked = Boolean(settings.autostart);
  optSnap.checked = Boolean(settings.snapToEdge);

  const hotkeys = settings.hotkeys || {};
  hkToggle.textContent = formatAccel(hotkeys.toggleHotkey || settings.toggleHotkey || 'Control+Alt+W');
  let switchLabel = formatAccel(hotkeys.switchViewHotkey || settings.switchViewHotkey || 'Control+Tab');
  if (hotkeys.switchViewFallback) switchLabel += ' (запасная)';
  hkSwitch.textContent = switchLabel;
}

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  btnSettings.setAttribute('aria-expanded', String(open));
}

async function flushSettingsWrites() {
  if (settingsWriteTimer) {
    clearTimeout(settingsWriteTimer);
    settingsWriteTimer = null;
  }
  const patch = settingsWritePending;
  settingsWritePending = {};
  if (!Object.keys(patch).length || !window.widgetApi) return;
  try {
    settings = await window.widgetApi.setSettings(patch);
    syncSettingsUi();
  } catch (err) {
    setBanner(`Настройки: ${err.message || err}`);
  }
}

function patchSettings(patch) {
  // Apply locally first for snappy UI
  Object.assign(settings, patch);
  if (patch.theme) applyTheme(patch.theme);
  if (patch.size) applySize(patch.size);
  if (typeof patch.autostart === 'boolean') optAutostart.checked = patch.autostart;
  if (typeof patch.snapToEdge === 'boolean') optSnap.checked = patch.snapToEdge;

  document.querySelectorAll('.seg-btn[data-setting="theme"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.theme));
  });
  document.querySelectorAll('.seg-btn[data-setting="size"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.size));
  });

  Object.assign(settingsWritePending, patch);
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null;
    flushSettingsWrites();
  }, 120);
}

function applyAccent(hex) {
  if (!hex || typeof hex !== 'string') return;
  const accent = hex.trim();
  if (accent === lastAccent) return;
  lastAccent = accent;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(accent, 0.22));
  document.documentElement.style.setProperty('--accent-glow', hexToRgba(accent, 0.35));
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(196, 18, 46, ${a})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function updateSourceLabel() {
  const listName = view === 'tasks' ? state.tasksListName : state.habitsListName;
  const prefix =
    state.mode === 'mock'
      ? 'Demo'
      : state.mode === 'needs_auth'
        ? 'Google · вход'
        : state.offline
          ? 'Кэш'
          : 'Google Tasks';
  sourceLabel.textContent = `${prefix} · ${listName}`;
}

function setView(next, force) {
  if (next !== 'tasks' && next !== 'habits') return;
  if (!force && next === view) return;
  view = next;
  panels.dataset.view = view;

  document.querySelectorAll('.tab').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.view === view));
  });
  document.querySelectorAll('.dot').forEach((el) => {
    el.setAttribute('aria-current', String(el.dataset.view === view));
  });

  panelTasks.setAttribute('aria-hidden', String(view !== 'tasks'));
  panelHabits.setAttribute('aria-hidden', String(view !== 'habits'));

  viewTitle.textContent = view === 'tasks' ? 'Tasks' : 'Habits';
  updateSourceLabel();
  if (lastIconView !== view) {
    lastIconView = view;
    viewIcon.innerHTML = icons[view];
  }
}

function toggleView() {
  setView(view === 'tasks' ? 'habits' : 'tasks');
}

function focusAddInput() {
  const input = view === 'habits' ? inputAddHabits : inputAddTasks;
  input?.focus();
}

function setBanner(text) {
  if (!text) {
    statusBanner.classList.remove('visible');
    statusBanner.textContent = '';
    return;
  }
  statusBanner.textContent = text;
  statusBanner.classList.add('visible');
}

function taskDueClass(task) {
  if (task.completed) return '';
  if (task.dueKind === 'overdue') return ' due-overdue';
  if (task.dueKind === 'today') return ' due-today';
  return '';
}

function buildTaskRow(task) {
  const li = document.createElement('li');
  li.className = `row${task.completed ? ' done' : ''}${taskDueClass(task)}`;
  li.dataset.id = task.id;
  li.innerHTML = `
    <span class="check${task.completed ? ' done' : ''}" aria-hidden="true"></span>
    <div class="row-body">
      <div class="row-title"></div>
      <div class="row-meta"></div>
    </div>
  `;
  li.querySelector('.row-title').textContent = task.title;
  li.querySelector('.row-meta').textContent = task.meta || '';
  return li;
}

function buildHabitRow(habit) {
  const week = habit.week || [false, false, false, false, false, false, false];
  const streak = habit.streak || 0;
  const ring = habit.ring != null ? habit.ring : 50;
  const done = Boolean(habit.completed);

  const li = document.createElement('li');
  li.className = `row${done ? ' done' : ''}`;
  li.dataset.id = habit.id;

  const pills = week
    .map(
      (d, i) =>
        `<span class="day-pill" style="--i:${i}" data-done="${d ? 'true' : 'false'}"></span>`
    )
    .join('');

  li.innerHTML = `
    <span class="ring" style="--p: ${ring}%" aria-hidden="true"></span>
    <div class="row-body">
      <div class="row-title"></div>
      <div class="row-meta"></div>
    </div>
    <div class="streak" aria-label="Стрик ${streak} дней">
      <div class="week-strip" aria-hidden="true">${pills}</div>
      <span class="streak-badge">${streak} <span class="unit">дн.</span></span>
    </div>
  `;
  li.querySelector('.row-title').textContent = habit.title;
  li.querySelector('.row-meta').textContent = habit.meta || 'Daily';
  return li;
}

function renderTasks() {
  const frag = document.createDocumentFragment();
  if (!state.tasks.length) {
    listTasks.innerHTML = '<li class="empty">Нет задач. Добавьте ниже или создайте список Google Tasks.</li>';
    return;
  }
  for (const task of state.tasks) {
    frag.appendChild(buildTaskRow(task));
  }
  listTasks.replaceChildren(frag);
}

function renderHabits() {
  const frag = document.createDocumentFragment();
  if (!state.habits.length) {
    listHabits.innerHTML = '<li class="empty">Нет привычек. Добавьте ниже или создайте список «Habits».</li>';
    return;
  }
  for (const habit of state.habits) {
    frag.appendChild(buildHabitRow(habit));
  }
  listHabits.replaceChildren(frag);
}

function rowById(listEl, id) {
  // Prefer getElementById-style scan; ids are Google/mock tokens without quotes
  return listEl.querySelector(`li.row[data-id="${id.replace(/"/g, '')}"]`);
}

function syncListOrder(listEl, items) {
  for (const item of items) {
    const row = rowById(listEl, item.id);
    if (row) listEl.appendChild(row);
  }
  for (const row of [...listEl.querySelectorAll('li.row')]) {
    if (!items.some((it) => it.id === row.dataset.id)) row.remove();
  }
}

function patchTaskRow(task) {
  const empty = listTasks.querySelector('.empty');
  if (empty) empty.remove();
  let li = rowById(listTasks, task.id);
  if (!li) {
    li = buildTaskRow(task);
    listTasks.appendChild(li);
  } else {
    li.className = `row${task.completed ? ' done' : ''}${taskDueClass(task)}`;
    const check = li.querySelector('.check');
    if (check) check.className = `check${task.completed ? ' done' : ''}`;
    const title = li.querySelector('.row-title');
    if (title) title.textContent = task.title;
    const meta = li.querySelector('.row-meta');
    if (meta) meta.textContent = task.meta || '';
  }
  syncListOrder(listTasks, state.tasks);
  if (!state.tasks.length) {
    listTasks.innerHTML = '<li class="empty">Нет задач. Добавьте ниже или создайте список Google Tasks.</li>';
  }
}

function patchHabitRow(habit) {
  const empty = listHabits.querySelector('.empty');
  if (empty) empty.remove();
  let li = rowById(listHabits, habit.id);
  if (!li) {
    li = buildHabitRow(habit);
    listHabits.appendChild(li);
  } else {
    const done = Boolean(habit.completed);
    li.className = `row${done ? ' done' : ''}`;
    const ring = li.querySelector('.ring');
    if (ring) ring.style.setProperty('--p', `${habit.ring != null ? habit.ring : 50}%`);
    const title = li.querySelector('.row-title');
    if (title) title.textContent = habit.title;
    const meta = li.querySelector('.row-meta');
    if (meta) meta.textContent = habit.meta || 'Daily';
    const streakEl = li.querySelector('.streak');
    if (streakEl) {
      const streak = habit.streak || 0;
      streakEl.setAttribute('aria-label', `Стрик ${streak} дней`);
      const badge = streakEl.querySelector('.streak-badge');
      if (badge) {
        badge.textContent = '';
        badge.appendChild(document.createTextNode(`${streak} `));
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = 'дн.';
        badge.appendChild(unit);
      }
      const week = habit.week || [false, false, false, false, false, false, false];
      streakEl.querySelectorAll('.day-pill').forEach((pill, i) => {
        pill.setAttribute('data-done', week[i] ? 'true' : 'false');
      });
    }
  }
  syncListOrder(listHabits, state.habits);
  if (!state.habits.length) {
    listHabits.innerHTML = '<li class="empty">Нет привычек. Добавьте ниже или создайте список «Habits».</li>';
  }
}

function resortTasksLocal() {
  const rank = { overdue: 0, today: 1, later: 2, null: 3, undefined: 3 };
  const open = state.tasks.filter((t) => !t.completed);
  const done = state.tasks.filter((t) => t.completed).slice(0, 5);
  open.sort((a, b) => {
    const ra = rank[a.dueKind] ?? 3;
    const rb = rank[b.dueKind] ?? 3;
    if (ra !== rb) return ra - rb;
    const da = a.due || '';
    const db = b.due || '';
    if (da !== db) return da < db ? -1 : 1;
    return String(a.title).localeCompare(String(b.title));
  });
  state.tasks = [...open, ...done];
}

function resortHabitsLocal() {
  state.habits.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return String(a.title).localeCompare(String(b.title));
  });
}

function renderAll() {
  applyAccent(state.accentColor);
  renderTasks();
  renderHabits();
  setView(view, true);

  offlinePill.hidden = !state.offline;

  let banner = '';
  if (state.offline) {
    banner = state.warning
      ? `Офлайн: ${state.warning}`
      : 'Офлайн — показаны последние загруженные данные.';
  } else if (state.mode === 'mock') {
    banner = 'Демо-режим: нет .env с Google OAuth. UI работает на mock-данных.';
  } else if (state.mode === 'needs_auth') {
    banner = 'Учётные данные есть — нажмите Google для входа.';
  } else if (state.warning) {
    banner = `Предупреждение: ${state.warning}`;
  } else if (state.mode === 'google') {
    const missing = [];
    if (state.tasksListFound === false) missing.push(`«${state.tasksListName}»`);
    if (state.habitsListFound === false) missing.push(`«${state.habitsListName}»`);
    if (missing.length) banner = `Списки не найдены: ${missing.join(', ')}. Проверьте имена в config.json.`;
  }
  setBanner(banner);

  btnAuth.textContent = state.mode === 'google' || state.offline ? 'Выйти' : 'Google';
}

async function loadData(force) {
  if (!window.widgetApi) {
    setBanner('Запустите через Electron (npm start), не открывайте HTML напрямую.');
    return;
  }
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    try {
      state = await window.widgetApi.getData(force ? { force: true } : {});
      renderAll();
    } catch (err) {
      setBanner(`Ошибка загрузки: ${err.message || err}`);
    } finally {
      loadInFlight = null;
    }
  })();
  return loadInFlight;
}

function applyHabitStats(item, stats) {
  if (!stats) return;
  item.streak = stats.streak;
  item.week = stats.week;
  item.ring = stats.ring;
  item.completedToday = stats.completedToday;
  item.completed = Boolean(stats.completedToday);
  item.status = item.completed ? 'completed' : 'needsAction';
}

async function toggleItem(listKind, item) {
  if (!window.widgetApi || pendingIds.has(item.id)) return;
  if (state.offline && state.mode === 'google') {
    setBanner('Офлайн: нельзя изменить задачу в Google. Обновите, когда сеть появится.');
    return;
  }
  pendingIds.add(item.id);
  const prevCompleted = Boolean(item.completed);
  const prevSnapshot =
    listKind === 'habits'
      ? {
          streak: item.streak,
          week: item.week && item.week.slice(),
          ring: item.ring,
          completedToday: item.completedToday,
          status: item.status,
        }
      : { status: item.status, meta: item.meta, dueKind: item.dueKind };

  const next = !prevCompleted;
  item.completed = next;
  item.status = next ? 'completed' : 'needsAction';
  if (listKind === 'tasks') {
    item.meta = next ? 'Done' : item.meta === 'Done' ? 'Task' : item.meta;
    item.dueKind = next ? null : item.dueKind;
    resortTasksLocal();
    patchTaskRow(item);
  } else {
    // Optimistic habit: flip today pill / ring lightly before server stats
    if (Array.isArray(item.week) && item.week.length) {
      item.week = item.week.slice();
      item.week[item.week.length - 1] = next;
      item.ring = Math.round((item.week.filter(Boolean).length / 7) * 100);
    }
    item.completedToday = next;
    item.streak = next ? (item.streak || 0) + (prevCompleted ? 0 : 1) : Math.max(0, (item.streak || 1) - 1);
    resortHabitsLocal();
    patchHabitRow(item);
  }

  try {
    const result = await window.widgetApi.setCompleted(listKind, item.id, next);
    if (listKind === 'habits' && result && result.stats) {
      applyHabitStats(item, result.stats);
      resortHabitsLocal();
      patchHabitRow(item);
    }
  } catch (err) {
    item.completed = prevCompleted;
    if (listKind === 'habits') {
      Object.assign(item, prevSnapshot);
      resortHabitsLocal();
      patchHabitRow(item);
    } else {
      item.status = prevSnapshot.status;
      item.meta = prevSnapshot.meta;
      item.dueKind = prevSnapshot.dueKind;
      resortTasksLocal();
      patchTaskRow(item);
    }
    setBanner(`Не удалось обновить: ${err.message || err}`);
  } finally {
    pendingIds.delete(item.id);
  }
}

function insertCreatedItem(listKind, item) {
  if (!item || !item.id) return;
  if (listKind === 'habits') {
    state.habits = [item, ...state.habits.filter((h) => h.id !== item.id)];
    resortHabitsLocal();
    patchHabitRow(item);
  } else {
    state.tasks = [item, ...state.tasks.filter((t) => t.id !== item.id)];
    resortTasksLocal();
    patchTaskRow(item);
  }
}

async function onAddSubmit(listKind, input) {
  if (addBusy || !window.widgetApi) return;
  const title = String(input.value || '').trim();
  if (!title) return;
  if (state.offline && state.mode === 'google') {
    setBanner('Офлайн: нельзя создать задачу в Google.');
    return;
  }
  if (state.mode === 'needs_auth') {
    setBanner('Сначала войдите через Google.');
    return;
  }
  addBusy = true;
  try {
    const result = await window.widgetApi.createItem(listKind, title);
    input.value = '';
    if (result && result.item) {
      insertCreatedItem(listKind, result.item);
    } else {
      await loadData(true);
    }
  } catch (err) {
    setBanner(`Не удалось добавить: ${err.message || err}`);
  } finally {
    addBusy = false;
  }
}

async function onAuthClick() {
  if (!window.widgetApi || addBusy) return;
  addBusy = true;
  try {
    if (state.mode === 'google' || state.offline) {
      state = await window.widgetApi.logout();
    } else {
      setBanner('Откройте браузер и подтвердите доступ к Google Tasks…');
      state = await window.widgetApi.login();
    }
    renderAll();
  } catch (err) {
    setBanner(`OAuth: ${err.message || err}`);
  } finally {
    addBusy = false;
  }
}

async function bootstrap() {
  if (!window.widgetApi) {
    setBanner('Запустите через Electron (npm start), не открывайте HTML напрямую.');
    syncSettingsUi();
    return;
  }
  try {
    if (typeof window.widgetApi.bootstrap === 'function') {
      const boot = await window.widgetApi.bootstrap();
      settings = boot.settings || settings;
      state = boot.data || state;
      syncSettingsUi();
      renderAll();
      return;
    }
    settings = await window.widgetApi.getSettings();
    syncSettingsUi();
    await loadData();
  } catch (err) {
    syncSettingsUi();
    setBanner(`Ошибка загрузки: ${err.message || err}`);
  }
}

// Event delegation — one listener per list instead of N per-row handlers
listTasks.addEventListener('click', (e) => {
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listTasks.contains(li)) return;
  const item = state.tasks.find((t) => t.id === li.dataset.id);
  if (item) toggleItem('tasks', item);
});

listHabits.addEventListener('click', (e) => {
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listHabits.contains(li)) return;
  const item = state.habits.find((h) => h.id === li.dataset.id);
  if (item) toggleItem('habits', item);
});

document.querySelectorAll('.tab, .dot').forEach((el) => {
  el.addEventListener('click', () => setView(el.dataset.view));
});

document.querySelectorAll('.seg-btn').forEach((el) => {
  el.addEventListener('click', () => {
    const key = el.dataset.setting;
    const value = el.dataset.value;
    if (!key || !value) return;
    patchSettings({ [key]: value });
  });
});

optAutostart.addEventListener('change', () => patchSettings({ autostart: optAutostart.checked }));
optSnap.addEventListener('change', () => patchSettings({ snapToEdge: optSnap.checked }));

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  setSettingsOpen(settingsPanel.hidden);
});

document.addEventListener('click', (e) => {
  if (settingsPanel.hidden) return;
  const t = e.target;
  if (settingsPanel.contains(t) || btnSettings.contains(t)) return;
  setSettingsOpen(false);
});

document.getElementById('btnMin').addEventListener('click', () => window.widgetApi?.minimize());
document.getElementById('btnClose').addEventListener('click', () => window.widgetApi?.close());
document.getElementById('btnRefresh').addEventListener('click', () => loadData(true));
btnAuth.addEventListener('click', onAuthClick);

document.getElementById('form-add-tasks').addEventListener('submit', (e) => {
  e.preventDefault();
  onAddSubmit('tasks', inputAddTasks);
});
document.getElementById('form-add-habits').addEventListener('submit', (e) => {
  e.preventDefault();
  onAddSubmit('habits', inputAddHabits);
});

const viewport = document.getElementById('viewport');
let startX = 0;
let swipeArmed = false;
viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.add-row, .settings-panel, button, input')) {
    swipeArmed = false;
    return;
  }
  swipeArmed = true;
  startX = e.clientX;
});
viewport.addEventListener('pointerup', (e) => {
  if (!swipeArmed) return;
  swipeArmed = false;
  const dx = e.clientX - startX;
  if (Math.abs(dx) < 40) return;
  setView(dx < 0 ? 'habits' : 'tasks');
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab')) return;
  const hotkeys = settings.hotkeys || {};
  if (hotkeys.switchRegistered && !hotkeys.switchViewFallback) return;
  e.preventDefault();
  toggleView();
});

if (window.widgetApi?.onSwitchView) {
  window.widgetApi.onSwitchView(() => toggleView());
}
if (window.widgetApi?.onFocusAdd) {
  window.widgetApi.onFocusAdd(() => focusAddInput());
}

setView('tasks', true);
bootstrap();
