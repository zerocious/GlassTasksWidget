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
let busy = false;
/** @type {Promise<void> | null} */
let loadInFlight = null;

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

async function patchSettings(patch) {
  if (!window.widgetApi) return;
  try {
    settings = await window.widgetApi.setSettings(patch);
    syncSettingsUi();
  } catch (err) {
    setBanner(`Настройки: ${err.message || err}`);
  }
}

function applyAccent(hex) {
  if (!hex || typeof hex !== 'string') return;
  const accent = hex.trim();
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

function setView(next) {
  if (next !== 'tasks' && next !== 'habits') return;
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
  viewIcon.innerHTML = icons[view];
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

function renderTasks() {
  listTasks.innerHTML = '';
  if (!state.tasks.length) {
    listTasks.innerHTML = '<li class="empty">Нет задач. Добавьте ниже или создайте список Google Tasks.</li>';
    return;
  }
  for (const task of state.tasks) {
    const li = document.createElement('li');
    const dueClass =
      !task.completed && task.dueKind === 'overdue'
        ? ' due-overdue'
        : !task.completed && task.dueKind === 'today'
          ? ' due-today'
          : '';
    li.className = `row${task.completed ? ' done' : ''}${dueClass}`;
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
    li.addEventListener('click', () => toggleItem('tasks', task));
    listTasks.appendChild(li);
  }
}

function renderHabits() {
  listHabits.innerHTML = '';
  if (!state.habits.length) {
    listHabits.innerHTML = '<li class="empty">Нет привычек. Добавьте ниже или создайте список «Habits».</li>';
    return;
  }
  for (const habit of state.habits) {
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
    li.addEventListener('click', () => toggleItem('habits', habit));
    listHabits.appendChild(li);
  }
}

function renderAll() {
  applyAccent(state.accentColor);
  renderTasks();
  renderHabits();
  setView(view);

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

async function loadData() {
  if (!window.widgetApi) {
    setBanner('Запустите через Electron (npm start), не открывайте HTML напрямую.');
    return;
  }
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    try {
      state = await window.widgetApi.getData();
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
  if (busy || !window.widgetApi) return;
  if (state.offline && state.mode === 'google') {
    setBanner('Офлайн: нельзя изменить задачу в Google. Обновите, когда сеть появится.');
    return;
  }
  busy = true;
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
      : { status: item.status, meta: item.meta };

  const next = !prevCompleted;
  item.completed = next;
  item.status = next ? 'completed' : 'needsAction';
  if (listKind === 'tasks') {
    item.meta = next ? 'Done' : item.meta === 'Done' ? 'Task' : item.meta;
  }
  if (listKind === 'habits') renderHabits();
  else renderTasks();

  try {
    const result = await window.widgetApi.setCompleted(listKind, item.id, next);
    if (listKind === 'habits' && result && result.stats) {
      applyHabitStats(item, result.stats);
      renderHabits();
    }
  } catch (err) {
    item.completed = prevCompleted;
    if (listKind === 'habits') {
      Object.assign(item, prevSnapshot);
      renderHabits();
    } else {
      item.status = prevSnapshot.status;
      item.meta = prevSnapshot.meta;
      renderTasks();
    }
    setBanner(`Не удалось обновить: ${err.message || err}`);
  } finally {
    busy = false;
  }
}

async function onAddSubmit(listKind, input) {
  if (busy || !window.widgetApi) return;
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
  busy = true;
  try {
    await window.widgetApi.createItem(listKind, title);
    input.value = '';
    await loadData();
  } catch (err) {
    setBanner(`Не удалось добавить: ${err.message || err}`);
  } finally {
    busy = false;
  }
}

async function onAuthClick() {
  if (!window.widgetApi || busy) return;
  busy = true;
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
    busy = false;
  }
}

async function initSettings() {
  if (!window.widgetApi?.getSettings) {
    syncSettingsUi();
    return;
  }
  try {
    settings = await window.widgetApi.getSettings();
    syncSettingsUi();
  } catch {
    syncSettingsUi();
  }
}

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
document.getElementById('btnRefresh').addEventListener('click', () => loadData());
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

setView('tasks');
initSettings().then(() => loadData());
