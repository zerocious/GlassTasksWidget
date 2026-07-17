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
const btnAuth = document.getElementById('btnAuth');

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
};

let view = 'tasks';
let busy = false;

function applyAccent(hex) {
  if (!hex || typeof hex !== 'string') return;
  const accent = hex.trim();
  document.documentElement.style.setProperty('--accent', accent);
  // soft / glow derived roughly
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
        : 'Google Tasks';
  sourceLabel.textContent = `${prefix} · ${listName}`;
  viewIcon.innerHTML = icons[view];
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
    listTasks.innerHTML = '<li class="empty">Нет задач. Создайте список Google Tasks с именем из config.json.</li>';
    return;
  }
  for (const task of state.tasks) {
    const li = document.createElement('li');
    li.className = `row${task.completed ? ' done' : ''}`;
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
    listHabits.innerHTML = '<li class="empty">Нет привычек. Создайте список Google Tasks «Habits» (или имя из config).</li>';
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

  let banner = '';
  if (state.mode === 'mock') {
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

  btnAuth.textContent = state.mode === 'google' ? 'Выйти' : 'Google';
}

async function loadData() {
  if (!window.widgetApi) {
    setBanner('Запустите через Electron (npm start), не открывайте HTML напрямую.');
    return;
  }
  try {
    state = await window.widgetApi.getData();
    renderAll();
  } catch (err) {
    setBanner(`Ошибка загрузки: ${err.message || err}`);
  }
}

async function toggleItem(listKind, item) {
  if (busy || !window.widgetApi) return;
  busy = true;
  try {
    const next = !item.completed;
    await window.widgetApi.setCompleted(listKind, item.id, next);
    await loadData();
  } catch (err) {
    setBanner(`Не удалось обновить: ${err.message || err}`);
  } finally {
    busy = false;
  }
}

async function onAuthClick() {
  if (!window.widgetApi || busy) return;
  busy = true;
  try {
    if (state.mode === 'google') {
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

document.querySelectorAll('.tab, .dot').forEach((el) => {
  el.addEventListener('click', () => setView(el.dataset.view));
});

document.getElementById('btnMin').addEventListener('click', () => window.widgetApi?.minimize());
document.getElementById('btnClose').addEventListener('click', () => window.widgetApi?.close());
document.getElementById('btnRefresh').addEventListener('click', () => loadData());
btnAuth.addEventListener('click', onAuthClick);

const viewport = document.getElementById('viewport');
let startX = 0;
viewport.addEventListener('pointerdown', (e) => {
  startX = e.clientX;
});
viewport.addEventListener('pointerup', (e) => {
  const dx = e.clientX - startX;
  if (Math.abs(dx) < 40) return;
  setView(dx < 0 ? 'habits' : 'tasks');
});

setView('tasks');
loadData();
