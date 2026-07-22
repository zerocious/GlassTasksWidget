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
const onboardingPanel = document.getElementById('onboardingPanel');
const onboardingTitle = document.getElementById('onboardingTitle');
const onboardingError = document.getElementById('onboardingError');
const inputClientId = document.getElementById('inputClientId');
const inputClientSecret = document.getElementById('inputClientSecret');
const inputRedirectPort = document.getElementById('inputRedirectPort');
const btnSaveCredentials = document.getElementById('btnSaveCredentials');
const btnSkipCredentials = document.getElementById('btnSkipCredentials');
const btnOpenConsole = document.getElementById('btnOpenConsole');
const btnGoogleKeys = document.getElementById('btnGoogleKeys');
const optAutostart = document.getElementById('optAutostart');
const optSnap = document.getElementById('optSnap');
const optSimpleAnim = document.getElementById('optSimpleAnim');
const optAutoPalette = document.getElementById('optAutoPalette');
const optBgOpacity = document.getElementById('optBgOpacity');
const bgOpacityValue = document.getElementById('bgOpacityValue');
const optReminders = document.getElementById('optReminders');
const optDailyHabitsReset = document.getElementById('optDailyHabitsReset');
const btnHideCompleted = document.getElementById('btnHideCompleted');
const btnHideCompletedHabits = document.getElementById('btnHideCompletedHabits');
const btnCheckReminders = document.getElementById('btnCheckReminders');
const btnCheckUpdates = document.getElementById('btnCheckUpdates');
const remindersHint = document.getElementById('remindersHint');
const updatesHint = document.getElementById('updatesHint');
const btnRefreshPalette = document.getElementById('btnRefreshPalette');
const hkToggle = document.getElementById('hkToggle');
const hkSwitch = document.getElementById('hkSwitch');
const inputAddTasks = document.getElementById('input-add-tasks');
const inputAddHabits = document.getElementById('input-add-habits');
const notesOverlay = document.getElementById('notesOverlay');
const notesPanelTask = document.getElementById('notesPanelTask');
const notesTextarea = document.getElementById('notesTextarea');
const btnNotesSave = document.getElementById('btnNotesSave');
const btnNotesCancel = document.getElementById('btnNotesCancel');
const btnNotesClose = document.getElementById('btnNotesClose');
const timeOverlay = document.getElementById('timeOverlay');
const timePanelTask = document.getElementById('timePanelTask');
const timeInput = document.getElementById('timeInput');
const btnTimeSave = document.getElementById('btnTimeSave');
const btnTimeCancel = document.getElementById('btnTimeCancel');
const btnTimeClose = document.getElementById('btnTimeClose');
const btnTimeClear = document.getElementById('btnTimeClear');

const NOTES_IND_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h9l3 3v13H6z"/><path d="M14 4v4h4"/><path d="M8 12h8M8 16h6"/></svg>';

/** @type {{ listKind: 'tasks' | 'habits', itemId: string, original: string } | null} */
let notesTarget = null;
/** @type {boolean} */
let notesSaving = false;
/** @type {{ listKind: 'tasks' | 'habits', itemId: string, original: string | null } | null} */
let timeTarget = null;
/** @type {boolean} */
let timeSaving = false;

/** Config accent from last server payload (before wallpaper override). */
let configAccent = '#C4122E';
/** @type {ReturnType<typeof setTimeout> | null} */
let slideClearTimer = null;

const icons = {
  tasks: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg>',
  habits: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
};

/** Inline SVGs for habit rows — stroke icons, 24 viewBox. */
const HABIT_ICON_SVGS = {
  water:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c-2.8 4.2-6 7.6-6 11a6 6 0 0 0 12 0c0-3.4-3.2-6.8-6-11z"/><path d="M9.5 14.5c.4 1.6 1.6 2.5 2.5 2.5"/></svg>',
  read:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5A2.5 2.5 0 0 1 20 21.5z"/></svg>',
  sport:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5v5M17.5 9.5v5M4 11v2M20 11v2M8.5 12h7M6.5 9.5h-1a1.5 1.5 0 0 0 0 3h1M17.5 9.5h1a1.5 1.5 0 0 1 0 3h-1"/></svg>',
  meditate:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="2.25"/><path d="M8.5 21c.5-3 2-5 3.5-5.5M15.5 21c-.5-3-2-5-3.5-5.5M7 14.5c1.5-1 3.2-1.5 5-1.5s3.5.5 5 1.5"/><path d="M9.5 11.5c.8.6 1.7.9 2.5.9s1.7-.3 2.5-.9"/></svg>',
  sleep:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 13.5A6.5 6.5 0 0 1 10 4.2 7.5 7.5 0 1 0 19.8 14a6.4 6.4 0 0 1-3.3-.5z"/></svg>',
  default:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.4 3.2 2.2 5.5 5.5 6.2C14.2 10 12.4 12.3 12 15.5 11.6 12.3 9.8 10 6.5 9.2 9.8 8.5 11.6 6.2 12 3z"/><path d="M12 15.5V21"/></svg>',
};

/**
 * Pick a habit icon key from title keywords (EN + RU).
 * @param {string} title
 * @returns {keyof typeof HABIT_ICON_SVGS}
 */
function habitIconKey(title) {
  const t = String(title || '').toLowerCase();
  if (/water|hydrat|вод|пить|напит/.test(t)) return 'water';
  if (/read|book|чита|книг/.test(t)) return 'read';
  if (/sport|exercis|workout|gym|run|jog|спорт|тренир|упражн|бег|зарядк/.test(t)) return 'sport';
  if (/meditat|yoga|mindful|медита|йог|дыхани/.test(t)) return 'meditate';
  if (/sleep|rest|сон|спат|отдых/.test(t)) return 'sleep';
  return 'default';
}

/** @param {string} title */
function habitIconHtml(title) {
  return HABIT_ICON_SVGS[habitIconKey(title)] || HABIT_ICON_SVGS.default;
}

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
  autoPalette: false,
  bgOpacity: 0.72,
  remindersEnabled: true,
  dailyHabitsReset: true,
  hideCompleted: false,
  simpleAnimations: false,
  onboardingSkipped: false,
};

/** @type {{ configured: boolean, needsOnboarding: boolean, clientId: string | null, redirectPort: number } | null} */
let credentials = null;
/** true when user opened credentials form from Settings (allow close without skip) */
let credentialsFromSettings = false;

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

function applySimpleAnimations(on) {
  document.documentElement.setAttribute('data-simple-anim', on ? 'true' : 'false');
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Instant view switch / no slide timers when quiet motion is active. */
function motionQuiet() {
  return Boolean(settings.simpleAnimations) || prefersReducedMotion();
}

/**
 * Clamp and apply glass fill alpha (0.2–0.95). Keeps strong fill ~0.1 above.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeBgOpacity(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0.72;
  return Math.round(Math.min(0.95, Math.max(0.2, n)) * 100) / 100;
}

/**
 * @param {unknown} value
 * @returns {number} normalized opacity
 */
function applyBgOpacity(value) {
  const opacity = normalizeBgOpacity(value);
  const strong = Math.min(0.98, Math.round((opacity + 0.1) * 100) / 100);
  const root = document.documentElement;
  root.style.setProperty('--glass-opacity', String(opacity));
  root.style.setProperty('--glass-opacity-strong', String(strong));

  const pct = Math.round(opacity * 100);
  if (optBgOpacity) {
    optBgOpacity.value = String(pct);
    optBgOpacity.setAttribute('aria-valuenow', String(pct));
  }
  if (bgOpacityValue) bgOpacityValue.textContent = `${pct}%`;
  return opacity;
}

function syncSettingsUi() {
  applyTheme(settings.theme);
  applySize(settings.size);
  applyBgOpacity(settings.bgOpacity);
  applySimpleAnimations(Boolean(settings.simpleAnimations));

  document.querySelectorAll('.seg-btn[data-setting="theme"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.theme));
  });
  document.querySelectorAll('.seg-btn[data-setting="size"]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.value === settings.size));
  });

  optAutostart.checked = Boolean(settings.autostart);
  optSnap.checked = Boolean(settings.snapToEdge);
  if (optSimpleAnim) optSimpleAnim.checked = Boolean(settings.simpleAnimations);
  if (optAutoPalette) optAutoPalette.checked = Boolean(settings.autoPalette);
  if (optReminders) optReminders.checked = settings.remindersEnabled !== false;
  if (optDailyHabitsReset) {
    optDailyHabitsReset.checked = settings.dailyHabitsReset !== false;
  }
  syncHideCompletedUi();
  syncRemindersHint(settings);

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

function syncHideCompletedUi() {
  const on = Boolean(settings.hideCompleted);
  const label = on ? 'Показать выполненные' : 'Скрыть выполненные';
  for (const btn of [btnHideCompleted, btnHideCompletedHabits]) {
    if (!btn) continue;
    btn.setAttribute('aria-pressed', String(on));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const showIcon = btn.querySelector('.hide-done-icon-show');
    const hideIcon = btn.querySelector('.hide-done-icon-hide');
    if (showIcon) showIcon.hidden = on;
    if (hideIcon) hideIcon.hidden = !on;
  }
}

/**
 * @param {{ notificationsSupported?: boolean, windowsToastsEnabled?: boolean, remindersEnabled?: boolean } | null} [settings]
 * @param {{ forceShow?: boolean, tone?: 'error' | 'ok' | '', text?: string }} [opts]
 */
function syncRemindersHint(settings, opts = {}) {
  if (!remindersHint) return;
  if (opts.text) {
    remindersHint.hidden = false;
    remindersHint.textContent = opts.text;
    remindersHint.classList.toggle('is-error', opts.tone === 'error');
    remindersHint.classList.toggle('is-ok', opts.tone === 'ok');
    return;
  }
  const unsupported = settings && settings.notificationsSupported === false;
  const osDisabled = settings && settings.windowsToastsEnabled === false;
  if (unsupported || osDisabled || opts.forceShow) {
    remindersHint.hidden = false;
    remindersHint.textContent = osDisabled
      ? 'Уведомления Windows выключены глобально. Параметры → Система → Уведомления — включите переключатель «Уведомления».'
      : 'Если баннеры Windows не появляются: Параметры → Система → Уведомления — разрешите «Glass Tasks Widget». Отключите Фокусировку внимания (Focus Assist).';
    remindersHint.classList.add('is-error');
    remindersHint.classList.remove('is-ok');
    return;
  }
  remindersHint.hidden = true;
  remindersHint.classList.remove('is-error', 'is-ok');
}

/**
 * @param {{ text?: string, tone?: '' | 'ok' | 'error' }} [opts]
 */
function syncUpdatesHint(opts = {}) {
  if (!updatesHint) return;
  if (opts.text) {
    updatesHint.hidden = false;
    updatesHint.textContent = opts.text;
    updatesHint.classList.toggle('is-error', opts.tone === 'error');
    updatesHint.classList.toggle('is-ok', opts.tone === 'ok');
    return;
  }
  updatesHint.hidden = true;
  updatesHint.classList.remove('is-error', 'is-ok');
}

function setOnboardingError(msg) {
  if (!onboardingError) return;
  if (!msg) {
    onboardingError.hidden = true;
    onboardingError.textContent = '';
    return;
  }
  onboardingError.hidden = false;
  onboardingError.textContent = msg;
}

/**
 * @param {{ open?: boolean, fromSettings?: boolean }} [opts]
 */
function syncCredentialsForm(opts = {}) {
  const open = Boolean(opts.open);
  credentialsFromSettings = Boolean(opts.fromSettings);
  if (!onboardingPanel) return;

  if (onboardingTitle) {
    onboardingTitle.textContent = credentialsFromSettings
      ? 'Google API ключи'
      : 'Подключение Google';
  }
  if (btnSkipCredentials) {
    btnSkipCredentials.hidden = credentialsFromSettings && Boolean(credentials?.configured);
    btnSkipCredentials.textContent = credentialsFromSettings
      ? 'Отмена'
      : 'Продолжить в демо';
  }

  if (inputClientId) {
    inputClientId.value = credentials?.clientId || '';
  }
  if (inputClientSecret) {
    inputClientSecret.value = '';
    inputClientSecret.placeholder = credentials?.configured
      ? 'Оставьте пустым, чтобы не менять'
      : 'Секрет клиента';
  }
  if (inputRedirectPort) {
    inputRedirectPort.value = String(credentials?.redirectPort || 42813);
  }
  setOnboardingError('');
  onboardingPanel.hidden = !open;
  if (open) setSettingsOpen(false);
}

function maybeShowFirstRunOnboarding() {
  if (!credentials?.needsOnboarding) {
    if (onboardingPanel && !credentialsFromSettings) onboardingPanel.hidden = true;
    return;
  }
  syncCredentialsForm({ open: true, fromSettings: false });
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
  if (typeof patch.bgOpacity === 'number') applyBgOpacity(patch.bgOpacity);
  if (typeof patch.autostart === 'boolean') optAutostart.checked = patch.autostart;
  if (typeof patch.snapToEdge === 'boolean') optSnap.checked = patch.snapToEdge;
  if (typeof patch.simpleAnimations === 'boolean') {
    applySimpleAnimations(patch.simpleAnimations);
    if (optSimpleAnim) optSimpleAnim.checked = patch.simpleAnimations;
    if (patch.simpleAnimations) {
      panels.classList.remove('is-sliding');
      if (slideClearTimer) {
        clearTimeout(slideClearTimer);
        slideClearTimer = null;
      }
    }
  }
  if (typeof patch.autoPalette === 'boolean' && optAutoPalette) {
    optAutoPalette.checked = patch.autoPalette;
  }
  if (typeof patch.remindersEnabled === 'boolean' && optReminders) {
    optReminders.checked = patch.remindersEnabled;
  }
  if (typeof patch.dailyHabitsReset === 'boolean' && optDailyHabitsReset) {
    optDailyHabitsReset.checked = patch.dailyHabitsReset;
  }
  if (typeof patch.hideCompleted === 'boolean') {
    syncHideCompletedUi();
    renderTasks();
    renderHabits();
  }

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
  }, typeof patch.bgOpacity === 'number' ? 220 : 120);
}

function normalizeAccentHex(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}

function applyAccent(hex) {
  const accent = normalizeAccentHex(hex);
  if (!accent) return;
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
  const prev = view;
  view = next;

  if (slideClearTimer) {
    clearTimeout(slideClearTimer);
    slideClearTimer = null;
  }
  panels.classList.remove('is-sliding');

  const animate = !force && prev !== view && !motionQuiet();
  if (animate) {
    panels.classList.add('is-sliding');
    const onEnd = (e) => {
      if (e.target !== panels || e.propertyName !== 'transform') return;
      panels.classList.remove('is-sliding');
      panels.removeEventListener('transitionend', onEnd);
      if (slideClearTimer) {
        clearTimeout(slideClearTimer);
        slideClearTimer = null;
      }
    };
    panels.addEventListener('transitionend', onEnd);
    slideClearTimer = setTimeout(() => {
      panels.classList.remove('is-sliding');
      panels.removeEventListener('transitionend', onEnd);
      slideClearTimer = null;
    }, 400);
  }

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

function taskHasNotes(task) {
  if (!task) return false;
  const text = String(task.notes || '').trim();
  if (!text) return false;
  // Managed «время HH:MM» line alone is not real notes content.
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l && !/^(?:время|Время|time)\s*[:\-]?\s*\d{1,2}[:.]\d{2}$/i.test(l));
}

function taskHasTime(task) {
  return Boolean(task && typeof task.dueTime === 'string' && /^\d{2}:\d{2}$/.test(task.dueTime));
}

function syncRowTimeChip(li, task) {
  if (!li) return;
  const metaLine = li.querySelector('.row-meta-line');
  let chip = li.querySelector('.row-time');
  if (!taskHasTime(task)) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'row-time';
    chip.setAttribute('aria-label', 'Время');
    if (metaLine) metaLine.appendChild(chip);
    else {
      const meta = li.querySelector('.row-meta');
      if (meta && meta.parentElement) meta.parentElement.appendChild(chip);
    }
  }
  chip.textContent = task.dueTime;
  chip.title = `Время: ${task.dueTime}`;
}

/** Indent only when parent is present in the same open/done bucket. */
function taskShowsAsSubtask(task) {
  if (!task || !task.parent) return false;
  const parent = state.tasks.find((t) => t && t.id === task.parent);
  if (!parent) return false;
  if (Boolean(parent.completed) !== Boolean(task.completed)) return false;
  if (settings.hideCompleted && parent.completed) return false;
  return true;
}

function taskRowClassName(task) {
  return `row${task.completed ? ' done' : ''}${taskDueClass(task)}${taskShowsAsSubtask(task) ? ' row--sub' : ''}`;
}

function buildTaskRow(task) {
  const li = document.createElement('li');
  li.className = taskRowClassName(task);
  li.dataset.id = task.id;
  if (task.parent) li.dataset.parent = task.parent;
  li.innerHTML = `
    <button type="button" class="drag-handle" aria-label="Перетащить" tabindex="-1" title="Перетащить">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>
    </button>
    <span class="check${task.completed ? ' done' : ''}" aria-hidden="true"></span>
    <div class="row-body">
      <div class="row-title-line">
        <div class="row-title"></div>
        <span class="row-notes-ind" title="Есть заметки" aria-label="Есть заметки" hidden>${NOTES_IND_SVG}</span>
      </div>
      <div class="row-meta-line">
        <div class="row-meta"></div>
      </div>
    </div>
  `;
  li.querySelector('.row-title').textContent = task.title;
  li.querySelector('.row-meta').textContent = task.meta || '';
  const notesInd = li.querySelector('.row-notes-ind');
  if (notesInd) notesInd.hidden = !taskHasNotes(task);
  syncRowTimeChip(li, task);
  return li;
}

function buildHabitRow(habit) {
  const week = habit.week || [false, false, false, false, false, false, false];
  const streak = habit.streak || 0;
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
    <button type="button" class="drag-handle" aria-label="Перетащить" tabindex="-1" title="Перетащить">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>
    </button>
    <span class="habit-icon" aria-hidden="true">${habitIconHtml(habit.title)}</span>
    <div class="row-body">
      <div class="row-title"></div>
      <div class="row-meta-line">
        <div class="row-meta"></div>
      </div>
    </div>
    <div class="streak" aria-label="Стрик ${streak} дней">
      <div class="week-strip" aria-hidden="true">${pills}</div>
      <span class="streak-badge">${streak} <span class="unit">дн.</span></span>
    </div>
  `;
  li.querySelector('.row-title').textContent = habit.title;
  li.querySelector('.row-meta').textContent = habit.meta || 'Daily';
  syncRowTimeChip(li, habit);
  return li;
}

/** @param {any[]} items */
function filterVisibleItems(items) {
  if (!settings.hideCompleted) return items;
  return items.filter((it) => !it.completed);
}

function ensureListEmpty(listEl, kind, allItems, visibleItems) {
  if (visibleItems.length) return;
  const empty =
    kind === 'habits'
      ? allItems.length
        ? '<li class="empty">Все привычки на сегодня выполнены.</li>'
        : '<li class="empty">Нет привычек. Добавьте ниже или создайте список «Habits».</li>'
      : allItems.length
        ? '<li class="empty">Все задачи выполнены.</li>'
        : '<li class="empty">Нет задач. Добавьте ниже или создайте список Google Tasks.</li>';
  listEl.innerHTML = empty;
}

function renderTasks() {
  const visible = filterVisibleItems(state.tasks);
  if (!visible.length) {
    ensureListEmpty(listTasks, 'tasks', state.tasks, visible);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const task of visible) {
    frag.appendChild(buildTaskRow(task));
  }
  listTasks.replaceChildren(frag);
}

function renderHabits() {
  const visible = filterVisibleItems(state.habits);
  if (!visible.length) {
    ensureListEmpty(listHabits, 'habits', state.habits, visible);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const habit of visible) {
    frag.appendChild(buildHabitRow(habit));
  }
  listHabits.replaceChildren(frag);
}

function rowById(listEl, id) {
  const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(id)) : String(id).replace(/"/g, '');
  return listEl.querySelector(`li.row[data-id="${safe}"]`);
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
  const visible = filterVisibleItems(state.tasks);
  if (settings.hideCompleted && task.completed) {
    const li = rowById(listTasks, task.id);
    if (li) li.remove();
    syncListOrder(listTasks, visible);
    ensureListEmpty(listTasks, 'tasks', state.tasks, visible);
    return;
  }
  const empty = listTasks.querySelector('.empty');
  if (empty) empty.remove();
  let li = rowById(listTasks, task.id);
  if (!li) {
    li = buildTaskRow(task);
    listTasks.appendChild(li);
  } else {
    li.className = taskRowClassName(task);
    if (task.parent) li.dataset.parent = task.parent;
    else delete li.dataset.parent;
    const check = li.querySelector('.check');
    if (check) check.className = `check${task.completed ? ' done' : ''}`;
    const title = li.querySelector('.row-title');
    if (title) title.textContent = task.title;
    let metaLine = li.querySelector('.row-meta-line');
    let meta = li.querySelector('.row-meta');
    if (!metaLine && meta) {
      metaLine = document.createElement('div');
      metaLine.className = 'row-meta-line';
      meta.replaceWith(metaLine);
      metaLine.appendChild(meta);
    }
    if (!meta && metaLine) {
      meta = document.createElement('div');
      meta.className = 'row-meta';
      metaLine.prepend(meta);
    }
    if (meta) meta.textContent = task.meta || '';
    syncRowTimeChip(li, task);
    let notesInd = li.querySelector('.row-notes-ind');
    if (!notesInd) {
      const titleLine = li.querySelector('.row-title-line') || li.querySelector('.row-body');
      if (titleLine) {
        notesInd = document.createElement('span');
        notesInd.className = 'row-notes-ind';
        notesInd.title = 'Есть заметки';
        notesInd.setAttribute('aria-label', 'Есть заметки');
        notesInd.innerHTML = NOTES_IND_SVG;
        const titleEl = li.querySelector('.row-title');
        if (titleEl && titleEl.parentElement === titleLine) titleLine.appendChild(notesInd);
        else titleLine.prepend(notesInd);
      }
    }
    if (notesInd) notesInd.hidden = !taskHasNotes(task);
  }
  syncListOrder(listTasks, visible);
  ensureListEmpty(listTasks, 'tasks', state.tasks, visible);
}

function patchHabitRow(habit) {
  const visible = filterVisibleItems(state.habits);
  if (settings.hideCompleted && habit.completed) {
    const li = rowById(listHabits, habit.id);
    if (li) li.remove();
    syncListOrder(listHabits, visible);
    ensureListEmpty(listHabits, 'habits', state.habits, visible);
    return;
  }
  const empty = listHabits.querySelector('.empty');
  if (empty) empty.remove();
  let li = rowById(listHabits, habit.id);
  if (!li) {
    li = buildHabitRow(habit);
    listHabits.appendChild(li);
  } else {
    const done = Boolean(habit.completed);
    li.className = `row${done ? ' done' : ''}`;
    const icon = li.querySelector('.habit-icon');
    if (icon) icon.innerHTML = habitIconHtml(habit.title);
    const title = li.querySelector('.row-title');
    if (title) title.textContent = habit.title;
    let metaLine = li.querySelector('.row-meta-line');
    let meta = li.querySelector('.row-meta');
    if (!metaLine && meta) {
      metaLine = document.createElement('div');
      metaLine.className = 'row-meta-line';
      meta.replaceWith(metaLine);
      metaLine.appendChild(meta);
    }
    if (!meta && metaLine) {
      meta = document.createElement('div');
      meta.className = 'row-meta';
      metaLine.prepend(meta);
    }
    if (meta) meta.textContent = habit.meta || 'Daily';
    syncRowTimeChip(li, habit);
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
  syncListOrder(listHabits, visible);
  ensureListEmpty(listHabits, 'habits', state.habits, visible);
}

function nestTasksLocal(tasks) {
  const byId = new Map();
  for (const t of tasks) {
    if (t && t.id) byId.set(t.id, t);
  }
  /** @type {Map<string, typeof tasks>} */
  const children = new Map();
  /** @type {typeof tasks} */
  const roots = [];
  for (const t of tasks) {
    if (!t || !t.id) continue;
    if (t.parent && byId.has(t.parent)) {
      if (!children.has(t.parent)) children.set(t.parent, []);
      children.get(t.parent).push(t);
    } else {
      roots.push(t);
    }
  }
  /** @type {typeof tasks} */
  const out = [];
  const walk = (list) => {
    for (const t of list) {
      out.push(t);
      const kids = children.get(t.id);
      if (kids && kids.length) walk(kids);
    }
  };
  walk(roots);
  return out;
}

function resortTasksLocal() {
  // Preserve sibling order; nest children under parents; partition open vs done.
  const open = nestTasksLocal(state.tasks.filter((t) => !t.completed));
  const done = nestTasksLocal(state.tasks.filter((t) => t.completed)).slice(0, 5);
  state.tasks = [...open, ...done];
}

function resortHabitsLocal() {
  const open = state.habits.filter((h) => !h.completed);
  const done = state.habits.filter((h) => h.completed);
  state.habits = [...open, ...done];
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
    banner = 'Демо-режим: UI на mock-данных. Подключите Google в настройках (Google API ключи).';
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
      if (state.defaultAccent) configAccent = state.defaultAccent;
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
    // Server recomputes dueKind/meta/dueTime — critical after uncomplete
    // so we don't stick on optimistic "Done" / null dueKind.
    if (result && result.item && typeof result.item === 'object') {
      Object.assign(item, result.item);
    }
    if (listKind === 'habits' && result && result.stats) {
      applyHabitStats(item, result.stats);
    }
    if (listKind === 'habits') {
      resortHabitsLocal();
      patchHabitRow(item);
    } else {
      resortTasksLocal();
      patchTaskRow(item);
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
    state.tasks = state.tasks.filter((t) => t.id !== item.id);
    if (item.parent) {
      const idx = state.tasks.findIndex((t) => t.id === item.parent);
      if (idx >= 0) state.tasks.splice(idx + 1, 0, item);
      else state.tasks.unshift(item);
    } else {
      state.tasks.unshift(item);
    }
    resortTasksLocal();
    renderTasks();
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

function guardMutate(actionLabel) {
  if (!window.widgetApi) return false;
  if (state.offline && state.mode === 'google') {
    setBanner(`Офлайн: нельзя ${actionLabel} в Google. Обновите, когда сеть появится.`);
    return false;
  }
  if (state.mode === 'needs_auth') {
    setBanner('Сначала войдите через Google.');
    return false;
  }
  return true;
}

/** @type {boolean} */
let dndActive = false;
/** @type {boolean} */
let swipeArmed = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let dndClickBlockTimer = null;

/**
 * Pointer-based row reorder (drag handle). Avoids HTML5 DnD + window drag conflicts.
 * @param {'tasks' | 'habits'} listKind
 * @param {HTMLElement} listEl
 */
function bindListReorder(listKind, listEl) {
  /** @type {{
   *   pointerId: number,
   *   row: HTMLElement,
   *   ghost: HTMLElement,
   *   indicator: HTMLElement,
   *   startY: number,
   *   offsetY: number,
   *   fromIndex: number,
   *   toIndex: number,
   *   ids: string[],
   *   moved: boolean,
   * } | null} */
  let session = null;

  function clearDropIndicator() {
    listEl.querySelectorAll('.row.drop-before, .row.drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function rowIds() {
    return [...listEl.querySelectorAll('li.row[data-id]')].map((r) => r.dataset.id);
  }

  function endSession(commit) {
    if (!session) return;
    detachDocListeners();
    const { pointerId, row, ghost, fromIndex, toIndex, ids, moved } = session;
    try {
      row.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    ghost.remove();
    row.classList.remove('is-dragging');
    listEl.classList.remove('is-reordering');
    clearDropIndicator();
    document.body.classList.remove('is-dnd');
    const wasMoved = moved;
    session = null;
    dndActive = false;

    if (wasMoved) {
      if (dndClickBlockTimer) clearTimeout(dndClickBlockTimer);
      dndClickBlockTimer = setTimeout(() => {
        dndClickBlockTimer = null;
      }, 120);
    }

    if (!commit || !moved || fromIndex === toIndex) return;

    const nextIds = ids.slice();
    const [movedId] = nextIds.splice(fromIndex, 1);
    nextIds.splice(toIndex, 0, movedId);
    applyLocalReorder(listKind, nextIds);
    const finalIds = (listKind === 'habits' ? state.habits : state.tasks).map((it) => it.id);
    const newIndex = finalIds.indexOf(movedId);
    if (newIndex < 0 || finalIds.join('\0') === ids.join('\0')) return;
    const previousId = previousSiblingId(listKind, finalIds, movedId);
    persistReorder(listKind, movedId, previousId, finalIds);
  }

  function previousSiblingId(kind, orderedIds, taskId) {
    const items = kind === 'habits' ? state.habits : state.tasks;
    const byId = new Map(items.map((it) => [it.id, it]));
    const moved = byId.get(taskId);
    if (!moved) return null;
    const parent = moved.parent || null;
    const idx = orderedIds.indexOf(taskId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const id = orderedIds[i];
      if (parent && id === parent) return null;
      const prev = byId.get(id);
      if (!prev) continue;
      if ((prev.parent || null) === parent) return id;
    }
    return null;
  }

  function applyLocalReorder(kind, orderedIds) {
    const key = kind === 'habits' ? 'habits' : 'tasks';
    const byId = new Map(state[key].map((it) => [it.id, it]));
    const next = [];
    for (const id of orderedIds) {
      const it = byId.get(id);
      if (it) next.push(it);
    }
    for (const it of state[key]) {
      if (!orderedIds.includes(it.id)) next.push(it);
    }
    state[key] = next;
    if (kind === 'habits') {
      resortHabitsLocal();
      syncListOrder(listHabits, filterVisibleItems(state.habits));
    } else {
      resortTasksLocal();
      syncListOrder(listTasks, filterVisibleItems(state.tasks));
    }
  }

  async function persistReorder(kind, taskId, previousId, orderedIds) {
    if (!guardMutate('изменить порядок')) {
      await loadData(true);
      return;
    }
    if (!window.widgetApi?.moveItem) {
      setBanner('Обновите приложение: перестановка недоступна.');
      return;
    }
    try {
      await window.widgetApi.moveItem(kind, taskId, previousId, orderedIds);
    } catch (err) {
      setBanner(`Не удалось изменить порядок: ${err.message || err}`);
      await loadData(true);
    }
  }

  function updateDropTarget(clientY) {
    if (!session) return;
    const others = [...listEl.querySelectorAll('li.row[data-id]')].filter(
      (r) => r !== session.row
    );
    clearDropIndicator();

    let insertAt = others.length;
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }

    session.toIndex = insertAt;
    if (!others.length) return;
    if (insertAt < others.length) {
      others[insertAt].classList.add('drop-before');
    } else {
      others[others.length - 1].classList.add('drop-after');
    }
  }

  function onPointerMove(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    const dy = e.clientY - session.startY;
    if (!session.moved && Math.abs(dy) < 4) return;
    session.moved = true;
    dndActive = true;
    swipeArmed = false;

    session.ghost.style.top = `${e.clientY - session.offsetY}px`;
    updateDropTarget(e.clientY);
  }

  function onPointerUp(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    endSession(true);
  }

  function onPointerCancel(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    endSession(false);
  }

  function attachDocListeners() {
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  }

  function detachDocListeners() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
  }

  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !listEl.contains(handle)) return;
    if (e.button !== 0) return;
    const row = handle.closest('li.row[data-id]');
    if (!row || row.classList.contains('is-editing')) return;
    if (pendingIds.has(row.dataset.id)) return;

    e.preventDefault();
    e.stopPropagation();
    hideCtxMenu();

    if (state.offline && state.mode === 'google') {
      setBanner('Офлайн: нельзя изменить порядок в Google. Обновите, когда сеть появится.');
      return;
    }
    if (state.mode === 'needs_auth') {
      setBanner('Сначала войдите через Google.');
      return;
    }

    const ids = rowIds();
    const fromIndex = ids.indexOf(row.dataset.id);
    if (fromIndex < 0) return;

    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    ghost.classList.add('row-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ghost);

    row.classList.add('is-dragging');
    listEl.classList.add('is-reordering');
    document.body.classList.add('is-dnd');
    dndActive = true;
    swipeArmed = false;

    session = {
      pointerId: e.pointerId,
      row,
      ghost,
      indicator: null,
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      fromIndex,
      toIndex: fromIndex,
      ids,
      moved: false,
    };

    attachDocListeners();
    try {
      row.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
}

bindListReorder('tasks', listTasks);
bindListReorder('habits', listHabits);

async function renameItem(listKind, item, nextTitle) {
  const trimmed = String(nextTitle || '').trim();
  if (!trimmed || trimmed === item.title) return;
  if (!guardMutate('изменить задачу')) return;
  if (pendingIds.has(item.id)) return;

  pendingIds.add(item.id);
  const prevTitle = item.title;
  item.title = trimmed;
  if (listKind === 'habits') patchHabitRow(item);
  else patchTaskRow(item);

  try {
    await window.widgetApi.updateItem(listKind, item.id, trimmed);
  } catch (err) {
    item.title = prevTitle;
    if (listKind === 'habits') patchHabitRow(item);
    else patchTaskRow(item);
    setBanner(`Не удалось изменить: ${err.message || err}`);
  } finally {
    pendingIds.delete(item.id);
  }
}

async function removeItem(listKind, item) {
  if (!guardMutate('удалить задачу')) return;
  if (pendingIds.has(item.id)) return;
  const label = listKind === 'habits' ? 'привычку' : 'задачу';
  const childCount =
    listKind === 'tasks'
      ? state.tasks.filter((t) => t && t.parent === item.id).length
      : 0;
  const confirmMsg =
    childCount > 0
      ? `Удалить задачу «${item.title}» и ${childCount} подзадач${childCount === 1 ? 'у' : childCount < 5 ? 'и' : ''}?`
      : `Удалить ${label} «${item.title}»?`;
  if (!window.confirm(confirmMsg)) return;

  pendingIds.add(item.id);
  const listKey = listKind === 'habits' ? 'habits' : 'tasks';
  const prevList = state[listKey].slice();
  const removedIds = new Set([item.id]);
  if (listKind === 'tasks') {
    for (const t of prevList) {
      if (t && t.parent === item.id) removedIds.add(t.id);
    }
  }
  state[listKey] = prevList.filter((i) => i && !removedIds.has(i.id));

  const listEl = listKind === 'habits' ? listHabits : listTasks;
  for (const id of removedIds) {
    const row = rowById(listEl, id);
    if (row) row.remove();
  }
  const visible = filterVisibleItems(state[listKey]);
  ensureListEmpty(listEl, listKind, state[listKey], visible);

  try {
    await window.widgetApi.deleteItem(listKind, item.id);
  } catch (err) {
    state[listKey] = prevList;
    if (listKind === 'habits') renderHabits();
    else renderTasks();
    setBanner(`Не удалось удалить: ${err.message || err}`);
  } finally {
    pendingIds.delete(item.id);
  }
}

function beginInlineEdit(listKind, item, row) {
  if (!row || row.classList.contains('is-editing')) return;
  if (!guardMutate('изменить задачу')) return;

  const titleEl = row.querySelector('.row-title');
  if (!titleEl) return;
  row.classList.add('is-editing');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'row-title-edit';
  input.maxLength = 200;
  input.value = item.title;
  input.setAttribute('aria-label', 'Новое название');
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    row.classList.remove('is-editing');
    const next = document.createElement('div');
    next.className = 'row-title';
    const value = String(input.value || '').trim();
    next.textContent = save && value ? value : item.title;
    if (input.parentNode) input.replaceWith(next);
    if (save && value && value !== item.title) await renameItem(listKind, item, value);
    else next.textContent = item.title;
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    finish(true);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** @type {{ listKind: 'tasks' | 'habits', itemId: string } | null} */
let ctxMenuTarget = null;
let ctxMenuEl = null;

function closeNotesPanel({ revert } = {}) {
  if (!notesOverlay || notesOverlay.hidden) return;
  if (revert && notesTarget) {
    const items = notesTarget.listKind === 'habits' ? state.habits : state.tasks;
    const item = items.find((i) => i.id === notesTarget.itemId);
    if (item) item.notes = notesTarget.original;
  }
  notesTarget = null;
  notesOverlay.hidden = true;
  if (notesTextarea) notesTextarea.value = '';
}

async function saveNotesPanel({ closeAfter } = {}) {
  if (!notesTarget || !window.widgetApi || notesSaving) return false;
  if (!guardMutate('сохранить заметки')) return false;
  const { listKind, itemId, original } = notesTarget;
  const items = listKind === 'habits' ? state.habits : state.tasks;
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    closeNotesPanel();
    return false;
  }
  const notes = String(notesTextarea?.value || '');
  if (notes === original) {
    if (closeAfter) closeNotesPanel();
    return true;
  }
  notesSaving = true;
  if (btnNotesSave) btnNotesSave.disabled = true;
  try {
    const result = await window.widgetApi.updateItem(listKind, itemId, { notes });
    item.notes = notes;
    if (result && result.item) {
      if (typeof result.item.meta === 'string') item.meta = result.item.meta;
      if (typeof result.item.dueTime === 'string' || result.item.dueTime === null) {
        item.dueTime = result.item.dueTime;
      }
    }
    notesTarget.original = notes;
    if (listKind === 'habits') patchHabitRow(item);
    else patchTaskRow(item);
    if (closeAfter) closeNotesPanel();
    return true;
  } catch (err) {
    setBanner(`Не удалось сохранить заметки: ${err.message || err}`);
    return false;
  } finally {
    notesSaving = false;
    if (btnNotesSave) btnNotesSave.disabled = false;
  }
}

function openNotesPanel(listKind, item) {
  if (!notesOverlay || !notesTextarea || !item) return;
  if (!guardMutate('изменить заметки')) return;
  hideCtxMenu();
  closeTimePanel();
  notesTarget = {
    listKind,
    itemId: item.id,
    original: String(item.notes || ''),
  };
  if (notesPanelTask) notesPanelTask.textContent = item.title || '';
  notesTextarea.value = notesTarget.original;
  notesOverlay.hidden = false;
  notesTextarea.focus();
  notesTextarea.setSelectionRange(notesTextarea.value.length, notesTextarea.value.length);
}

function closeTimePanel() {
  if (!timeOverlay || timeOverlay.hidden) return;
  timeTarget = null;
  timeOverlay.hidden = true;
  if (timeInput) timeInput.value = '';
}

async function saveTimePanel({ closeAfter, clear } = {}) {
  if (!timeTarget || !window.widgetApi || timeSaving) return false;
  if (!guardMutate('сохранить время')) return false;
  const { listKind, itemId, original } = timeTarget;
  const items = listKind === 'habits' ? state.habits : state.tasks;
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    closeTimePanel();
    return false;
  }

  /** @type {string | null} */
  let next = null;
  if (!clear) {
    const raw = String(timeInput?.value || '').trim();
    if (!raw) {
      setBanner('Укажите время или нажмите «Сбросить»');
      return false;
    }
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      setBanner('Время в формате ЧЧ:ММ');
      return false;
    }
    next = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  }

  if (next === original || (next === null && original === null)) {
    if (closeAfter) closeTimePanel();
    return true;
  }

  timeSaving = true;
  if (btnTimeSave) btnTimeSave.disabled = true;
  if (btnTimeClear) btnTimeClear.disabled = true;
  try {
    const result = await window.widgetApi.updateItem(listKind, itemId, { dueTime: next });
    if (result && result.item) {
      if (typeof result.item.notes === 'string') item.notes = result.item.notes;
      if (typeof result.item.meta === 'string') item.meta = result.item.meta;
      if (typeof result.item.dueTime === 'string' || result.item.dueTime === null) {
        item.dueTime = result.item.dueTime;
      } else {
        item.dueTime = next;
      }
    } else {
      item.dueTime = next;
    }
    timeTarget.original = item.dueTime || null;
    if (listKind === 'habits') patchHabitRow(item);
    else patchTaskRow(item);
    if (closeAfter) closeTimePanel();
    return true;
  } catch (err) {
    setBanner(`Не удалось сохранить время: ${err.message || err}`);
    return false;
  } finally {
    timeSaving = false;
    if (btnTimeSave) btnTimeSave.disabled = false;
    if (btnTimeClear) btnTimeClear.disabled = false;
  }
}

function openTimePanel(listKind, item) {
  if (!timeOverlay || !timeInput || !item) return;
  if (!guardMutate('изменить время')) return;
  hideCtxMenu();
  closeNotesPanel();
  const original =
    typeof item.dueTime === 'string' && /^\d{2}:\d{2}$/.test(item.dueTime) ? item.dueTime : null;
  timeTarget = {
    listKind,
    itemId: item.id,
    original,
  };
  if (timePanelTask) timePanelTask.textContent = item.title || '';
  timeInput.value = original || '';
  timeOverlay.hidden = false;
  timeInput.focus();
}

async function beginAddSubtask(parentItem, parentRow) {
  if (!parentItem || !parentRow) return;
  if (!guardMutate('добавить подзадачу')) return;
  hideCtxMenu();

  const existing = listTasks.querySelector('.row-sub-edit');
  if (existing) existing.remove();

  const wrap = document.createElement('li');
  wrap.className = 'row-sub-edit';
  wrap.setAttribute('aria-label', 'Новая подзадача');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'row-sub-edit-input';
  input.maxLength = 200;
  input.placeholder = 'Новая подзадача…';
  input.setAttribute('aria-label', 'Название подзадачи');
  wrap.appendChild(input);
  parentRow.insertAdjacentElement('afterend', wrap);
  input.focus();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const title = String(input.value || '').trim();
    wrap.remove();
    if (!save || !title) return;
    if (addBusy) return;
    addBusy = true;
    try {
      const result = await window.widgetApi.createItem('tasks', title, {
        parentId: parentItem.id,
      });
      if (result && result.item) {
        insertCreatedItem('tasks', result.item);
      } else {
        await loadData(true);
      }
    } catch (err) {
      setBanner(`Не удалось добавить подзадачу: ${err.message || err}`);
    } finally {
      addBusy = false;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    // Allow click on empty cancel without fighting focus changes
    setTimeout(() => finish(Boolean(String(input.value || '').trim())), 120);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

function ensureCtxMenu() {
  if (ctxMenuEl) return ctxMenuEl;
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.id = 'rowCtxMenu';
  ctxMenuEl.className = 'ctx-menu';
  ctxMenuEl.hidden = true;
  ctxMenuEl.setAttribute('role', 'menu');
  ctxMenuEl.innerHTML =
    '<button type="button" class="ctx-menu-item" role="menuitem" data-action="edit">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 4.8l5 5M4 20l1.4-5.2L15 5.2l3.8 3.8L9.2 18.6 4 20z"/></svg>' +
      '<span>Изменить</span>' +
    '</button>' +
    '<button type="button" class="ctx-menu-item" role="menuitem" data-action="notes">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h9l3 3v13H6z"/><path d="M14 4v4h4"/><path d="M8 12h8M8 16h6"/></svg>' +
      '<span>Заметки</span>' +
    '</button>' +
    '<button type="button" class="ctx-menu-item" role="menuitem" data-action="time">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></svg>' +
      '<span>Время</span>' +
    '</button>' +
    '<button type="button" class="ctx-menu-item" role="menuitem" data-action="subtask">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h8M4 18h16"/><path d="M14 10l4 2-4 2"/></svg>' +
      '<span>Подзадача</span>' +
    '</button>' +
    '<button type="button" class="ctx-menu-item danger" role="menuitem" data-action="delete">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M10 11v6M14 11v6M6 7l1 12h10l1-12"/></svg>' +
      '<span>Удалить</span>' +
    '</button>';
  document.body.appendChild(ctxMenuEl);

  ctxMenuEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-menu-item[data-action]');
    if (!btn || !ctxMenuTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const { listKind, itemId } = ctxMenuTarget;
    const items = listKind === 'habits' ? state.habits : state.tasks;
    const item = items.find((i) => i.id === itemId);
    const listEl = listKind === 'habits' ? listHabits : listTasks;
    const row = item ? rowById(listEl, item.id) : null;
    const action = btn.dataset.action;
    hideCtxMenu();
    if (!item) return;
    if (action === 'edit') beginInlineEdit(listKind, item, row);
    else if (action === 'notes') openNotesPanel(listKind, item);
    else if (action === 'time') openTimePanel(listKind, item);
    else if (action === 'subtask' && listKind === 'tasks') beginAddSubtask(item, row);
    else if (action === 'delete') removeItem(listKind, item);
  });

  return ctxMenuEl;
}

function hideCtxMenu() {
  if (!ctxMenuEl || ctxMenuEl.hidden) return;
  ctxMenuEl.hidden = true;
  ctxMenuTarget = null;
}

function showCtxMenu(listKind, item, e) {
  const menu = ensureCtxMenu();
  ctxMenuTarget = { listKind, itemId: item.id };
  const subBtn = menu.querySelector('[data-action="subtask"]');
  // Google Tasks supports one nesting level — only top-level tasks get «Подзадача».
  if (subBtn) subBtn.hidden = listKind !== 'tasks' || Boolean(item.parent);
  menu.hidden = false;

  // Measure off-screen then clamp into viewport
  menu.style.left = '0px';
  menu.style.top = '0px';
  const { width, height } = menu.getBoundingClientRect();
  const pad = 8;
  const x = Math.min(e.clientX, window.innerWidth - width - pad);
  const y = Math.min(e.clientY, window.innerHeight - height - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

function handleRowContextMenu(listKind, e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.target.closest('.row-title-edit')) {
    hideCtxMenu();
    return;
  }
  const listEl = listKind === 'habits' ? listHabits : listTasks;
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listEl.contains(li) || li.classList.contains('is-editing')) {
    hideCtxMenu();
    return;
  }
  const items = listKind === 'habits' ? state.habits : state.tasks;
  const item = items.find((i) => i.id === li.dataset.id);
  if (!item) {
    hideCtxMenu();
    return;
  }
  showCtxMenu(listKind, item, e);
}

async function applyWallpaperPalette({ persistAuto } = {}) {
  if (!window.widgetApi?.sampleWallpaperPalette) {
    setBanner('Палитра с обоев недоступна.');
    return;
  }
  try {
    if (persistAuto) {
      patchSettings({ autoPalette: true });
      await flushSettingsWrites();
    }
    const result = await window.widgetApi.sampleWallpaperPalette();
    if (result && result.accent) {
      state.accentColor = result.accent;
      lastAccent = '';
      applyAccent(result.accent);
      patchSettings({ accentColor: result.accent });
      setBanner('');
    }
  } catch (err) {
    setBanner(`Палитра: ${err.message || err}`);
    if (optAutoPalette) optAutoPalette.checked = Boolean(settings.autoPalette);
  }
}

async function onAutoPaletteChange() {
  const enabled = Boolean(optAutoPalette?.checked);
  if (enabled) {
    await applyWallpaperPalette({ persistAuto: true });
    return;
  }
  patchSettings({ autoPalette: false, accentColor: null });
  lastAccent = '';
  state.accentColor = configAccent;
  applyAccent(configAccent);
}

async function onAuthClick() {
  if (!window.widgetApi || addBusy) return;
  if (state.mode !== 'google' && !state.offline && credentials && !credentials.configured) {
    syncCredentialsForm({ open: true, fromSettings: true });
    return;
  }
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

async function onSaveCredentials() {
  if (!window.widgetApi || addBusy) return;
  const clientId = (inputClientId?.value || '').trim();
  const clientSecret = (inputClientSecret?.value || '').trim();
  const redirectPort = Number(inputRedirectPort?.value || 42813);
  if (!clientId) {
    setOnboardingError('Укажите Client ID');
    return;
  }
  if (!clientSecret && !credentials?.configured) {
    setOnboardingError('Укажите Client Secret');
    return;
  }
  addBusy = true;
  if (btnSaveCredentials) btnSaveCredentials.disabled = true;
  if (btnSkipCredentials) btnSkipCredentials.disabled = true;
  setOnboardingError('');
  try {
    const result = await window.widgetApi.saveCredentials({
      clientId,
      clientSecret,
      redirectPort,
    });
    credentials = result.credentials || credentials;
    if (result.settings) settings = result.settings;
    if (result.data) state = result.data;
    syncCredentialsForm({ open: false });
    syncSettingsUi();
    renderAll();
    setBanner(
      state.mode === 'needs_auth'
        ? 'Ключи сохранены — нажмите Google для входа.'
        : 'Ключи сохранены.'
    );
  } catch (err) {
    setOnboardingError(err.message || String(err));
  } finally {
    addBusy = false;
    if (btnSaveCredentials) btnSaveCredentials.disabled = false;
    if (btnSkipCredentials) btnSkipCredentials.disabled = false;
  }
}

async function onSkipCredentials() {
  if (!window.widgetApi || addBusy) return;
  if (credentialsFromSettings) {
    syncCredentialsForm({ open: false });
    return;
  }
  addBusy = true;
  if (btnSaveCredentials) btnSaveCredentials.disabled = true;
  if (btnSkipCredentials) btnSkipCredentials.disabled = true;
  try {
    const result = await window.widgetApi.skipCredentials();
    credentials = result.credentials || credentials;
    if (result.settings) settings = result.settings;
    if (result.data) state = result.data;
    syncCredentialsForm({ open: false });
    syncSettingsUi();
    renderAll();
  } catch (err) {
    setOnboardingError(err.message || String(err));
  } finally {
    addBusy = false;
    if (btnSaveCredentials) btnSaveCredentials.disabled = false;
    if (btnSkipCredentials) btnSkipCredentials.disabled = false;
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
      credentials = boot.credentials || null;
      if (state.defaultAccent) configAccent = state.defaultAccent;
      else if (!settings.autoPalette && state.accentColor) configAccent = state.accentColor;
      syncSettingsUi();
      renderAll();
      maybeShowFirstRunOnboarding();
      return;
    }
    settings = await window.widgetApi.getSettings();
    if (window.widgetApi.getCredentialsStatus) {
      credentials = await window.widgetApi.getCredentialsStatus();
    }
    syncSettingsUi();
    await loadData();
    maybeShowFirstRunOnboarding();
  } catch (err) {
    syncSettingsUi();
    setBanner(`Ошибка загрузки: ${err.message || err}`);
  }
}

// Event delegation — one listener per list instead of N per-row handlers
listTasks.addEventListener('click', (e) => {
  hideCtxMenu();
  if (e.target.closest('.row-title-edit, .drag-handle')) return;
  if (dndActive || dndClickBlockTimer) return;
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listTasks.contains(li) || li.classList.contains('is-editing')) return;
  const item = state.tasks.find((t) => t.id === li.dataset.id);
  if (item) toggleItem('tasks', item);
});

listHabits.addEventListener('click', (e) => {
  hideCtxMenu();
  if (e.target.closest('.row-title-edit, .drag-handle')) return;
  if (dndActive || dndClickBlockTimer) return;
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listHabits.contains(li) || li.classList.contains('is-editing')) return;
  const item = state.habits.find((h) => h.id === li.dataset.id);
  if (item) toggleItem('habits', item);
});

listTasks.addEventListener('contextmenu', (e) => handleRowContextMenu('tasks', e));
listHabits.addEventListener('contextmenu', (e) => handleRowContextMenu('habits', e));

document.addEventListener('pointerdown', (e) => {
  if (ctxMenuEl && !ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) hideCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (timeOverlay && !timeOverlay.hidden) {
    e.preventDefault();
    closeTimePanel();
    return;
  }
  if (notesOverlay && !notesOverlay.hidden) {
    e.preventDefault();
    closeNotesPanel({ revert: true });
    return;
  }
  hideCtxMenu();
});
window.addEventListener('blur', hideCtxMenu);
window.addEventListener('resize', hideCtxMenu);
panels?.addEventListener('scroll', hideCtxMenu, true);
panelTasks?.addEventListener('scroll', hideCtxMenu);
panelHabits?.addEventListener('scroll', hideCtxMenu);

/** Avoid textarea blur auto-save when Cancel / overlay dismiss is intended. */
let notesIgnoreBlur = false;
function armNotesIgnoreBlur() {
  notesIgnoreBlur = true;
  setTimeout(() => {
    notesIgnoreBlur = false;
  }, 200);
}

if (btnNotesSave) {
  btnNotesSave.addEventListener('mousedown', armNotesIgnoreBlur);
  btnNotesSave.addEventListener('click', (e) => {
    e.preventDefault();
    saveNotesPanel({ closeAfter: true });
  });
}
if (btnNotesCancel) {
  btnNotesCancel.addEventListener('mousedown', armNotesIgnoreBlur);
  btnNotesCancel.addEventListener('click', (e) => {
    e.preventDefault();
    closeNotesPanel({ revert: true });
  });
}
if (btnNotesClose) {
  btnNotesClose.addEventListener('mousedown', armNotesIgnoreBlur);
  btnNotesClose.addEventListener('click', (e) => {
    e.preventDefault();
    closeNotesPanel({ revert: true });
  });
}
if (notesOverlay) {
  notesOverlay.addEventListener('mousedown', (e) => {
    if (e.target === notesOverlay) armNotesIgnoreBlur();
  });
  notesOverlay.addEventListener('click', (e) => {
    if (e.target === notesOverlay) closeNotesPanel({ revert: true });
  });
}
if (notesTextarea) {
  notesTextarea.addEventListener('blur', () => {
    setTimeout(() => {
      if (notesIgnoreBlur || !notesOverlay || notesOverlay.hidden || notesSaving) return;
      saveNotesPanel({ closeAfter: false });
    }, 120);
  });
  notesTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeNotesPanel({ revert: true });
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveNotesPanel({ closeAfter: true });
    }
  });
}

if (btnTimeSave) {
  btnTimeSave.addEventListener('click', (e) => {
    e.preventDefault();
    saveTimePanel({ closeAfter: true });
  });
}
if (btnTimeClear) {
  btnTimeClear.addEventListener('click', (e) => {
    e.preventDefault();
    saveTimePanel({ closeAfter: true, clear: true });
  });
}
if (btnTimeCancel) {
  btnTimeCancel.addEventListener('click', (e) => {
    e.preventDefault();
    closeTimePanel();
  });
}
if (btnTimeClose) {
  btnTimeClose.addEventListener('click', (e) => {
    e.preventDefault();
    closeTimePanel();
  });
}
if (timeOverlay) {
  timeOverlay.addEventListener('click', (e) => {
    if (e.target === timeOverlay) closeTimePanel();
  });
}
if (timeInput) {
  timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeTimePanel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      saveTimePanel({ closeAfter: true });
    }
  });
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
if (optSimpleAnim) {
  optSimpleAnim.addEventListener('change', () =>
    patchSettings({ simpleAnimations: optSimpleAnim.checked })
  );
}
if (optReminders) {
  optReminders.addEventListener('change', () =>
    patchSettings({ remindersEnabled: optReminders.checked })
  );
}
if (optDailyHabitsReset) {
  optDailyHabitsReset.addEventListener('change', () =>
    patchSettings({ dailyHabitsReset: optDailyHabitsReset.checked })
  );
}

function onHideCompletedToggle(e) {
  e.preventDefault();
  e.stopPropagation();
  patchSettings({ hideCompleted: !settings.hideCompleted });
}

if (btnHideCompleted) {
  btnHideCompleted.addEventListener('click', onHideCompletedToggle);
}
if (btnHideCompletedHabits) {
  btnHideCompletedHabits.addEventListener('click', onHideCompletedToggle);
}

if (btnCheckReminders) {
  btnCheckReminders.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.widgetApi?.checkReminders) return;
    btnCheckReminders.disabled = true;
    try {
      const result = await window.widgetApi.checkReminders();
      if (result?.shown) {
        syncRemindersHint(null, {
          text:
            result.message ||
            `Отправлено: ${result.count || 0}. Смотрите баннер Windows / Центр уведомлений.`,
          tone: 'ok',
        });
      } else if (
        result?.reason === 'unsupported' ||
        result?.reason === 'failed' ||
        result?.reason === 'os-disabled'
      ) {
        syncRemindersHint(null, {
          text:
            result.message ||
            'Тосты Windows недоступны. Параметры → Система → Уведомления — разрешите «Glass Tasks Widget» и отключите Фокусировку внимания.',
          tone: 'error',
        });
      } else {
        syncRemindersHint(null, {
          text: result?.message || 'Нечего напоминать прямо сейчас.',
          tone: '',
        });
      }
    } catch (err) {
      syncRemindersHint(null, {
        text: err?.message || 'Не удалось проверить напоминания.',
        tone: 'error',
      });
    } finally {
      btnCheckReminders.disabled = false;
    }
  });
}
if (btnCheckUpdates) {
  btnCheckUpdates.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.widgetApi?.checkUpdates) return;
    btnCheckUpdates.disabled = true;
    syncUpdatesHint({ text: 'Проверяем…', tone: '' });
    try {
      const result = await window.widgetApi.checkUpdates();
      const tone =
        result?.ok === false || result?.reason === 'error' ? 'error' : result?.reason === 'available' ? 'ok' : '';
      syncUpdatesHint({
        text: result?.message || 'Готово.',
        tone,
      });
    } catch (err) {
      syncUpdatesHint({
        text: err?.message || 'Не удалось проверить обновления.',
        tone: 'error',
      });
    } finally {
      btnCheckUpdates.disabled = false;
    }
  });
}
if (optBgOpacity) {
  optBgOpacity.addEventListener('input', () => {
    const opacity = normalizeBgOpacity(Number(optBgOpacity.value) / 100);
    patchSettings({ bgOpacity: opacity });
  });
}
if (optAutoPalette) {
  optAutoPalette.addEventListener('change', () => {
    onAutoPaletteChange();
  });
}
if (btnRefreshPalette) {
  btnRefreshPalette.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyWallpaperPalette({ persistAuto: true });
  });
}

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  if (onboardingPanel && !onboardingPanel.hidden && !credentialsFromSettings) return;
  if (onboardingPanel && !onboardingPanel.hidden && credentialsFromSettings) {
    syncCredentialsForm({ open: false });
  }
  setSettingsOpen(settingsPanel.hidden);
});

document.addEventListener('click', (e) => {
  if (settingsPanel.hidden) return;
  const t = e.target;
  if (settingsPanel.contains(t) || btnSettings.contains(t)) return;
  if (onboardingPanel && !onboardingPanel.hidden && onboardingPanel.contains(t)) return;
  setSettingsOpen(false);
});

document.getElementById('btnMin').addEventListener('click', () => window.widgetApi?.minimize());
document.getElementById('btnClose').addEventListener('click', () => window.widgetApi?.close());
document.getElementById('btnRefresh').addEventListener('click', () => loadData(true));
btnAuth.addEventListener('click', onAuthClick);

if (btnGoogleKeys) {
  btnGoogleKeys.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    syncCredentialsForm({ open: true, fromSettings: true });
  });
}
if (btnSaveCredentials) {
  btnSaveCredentials.addEventListener('click', (e) => {
    e.preventDefault();
    onSaveCredentials();
  });
}
if (btnSkipCredentials) {
  btnSkipCredentials.addEventListener('click', (e) => {
    e.preventDefault();
    onSkipCredentials();
  });
}
if (btnOpenConsole) {
  btnOpenConsole.addEventListener('click', (e) => {
    e.preventDefault();
    window.widgetApi?.openExternal('https://console.cloud.google.com/apis/credentials');
  });
}

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
viewport.addEventListener('pointerdown', (e) => {
  if (
    dndActive ||
    e.target.closest(
      '.add-row, .settings-panel, .onboarding-panel, button, input, .drag-handle'
    )
  ) {
    swipeArmed = false;
    return;
  }
  swipeArmed = true;
  startX = e.clientX;
});
viewport.addEventListener('pointerup', (e) => {
  if (!swipeArmed || dndActive) {
    swipeArmed = false;
    return;
  }
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
if (window.widgetApi?.onHabitsReset) {
  window.widgetApi.onHabitsReset(() => {
    loadData(true).catch(() => {});
  });
}

/** @type {ReturnType<typeof setTimeout> | null} */
let inAppToastTimer = null;
function showInAppReminderToast(payload) {
  const el = document.getElementById('inAppToast');
  const titleEl = document.getElementById('inAppToastTitle');
  const bodyEl = document.getElementById('inAppToastBody');
  if (!el || !titleEl || !bodyEl) return;
  titleEl.textContent = payload?.title || 'Напоминание';
  bodyEl.textContent = payload?.body || '';
  el.hidden = false;
  if (inAppToastTimer) clearTimeout(inAppToastTimer);
  inAppToastTimer = setTimeout(() => {
    el.hidden = true;
    inAppToastTimer = null;
  }, 8000);
  el.onclick = () => {
    el.hidden = true;
    if (inAppToastTimer) {
      clearTimeout(inAppToastTimer);
      inAppToastTimer = null;
    }
  };
}
if (window.widgetApi?.onInAppReminder) {
  window.widgetApi.onInAppReminder((payload) => showInAppReminderToast(payload));
}

setView('tasks', true);
bootstrap();
