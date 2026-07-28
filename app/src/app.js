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
const taskFilterChips = document.getElementById('taskFilterChips');
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
const repeatOverlay = document.getElementById('repeatOverlay');
const repeatPanelTask = document.getElementById('repeatPanelTask');
const repeatOptions = document.getElementById('repeatOptions');
const streakOverlay = document.getElementById('streakOverlay');
const streakPanelTask = document.getElementById('streakPanelTask');
const streakMonthLabel = document.getElementById('streakMonthLabel');
const streakMonthGrid = document.getElementById('streakMonthGrid');
const streakMonthStat = document.getElementById('streakMonthStat');
const streakMonthStreak = document.getElementById('streakMonthStreak');
const btnStreakPrev = document.getElementById('btnStreakPrev');
const btnStreakNext = document.getElementById('btnStreakNext');
const btnStreakClose = document.getElementById('btnStreakClose');

const NOTES_IND_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h9l3 3v13H6z"/><path d="M14 4v4h4"/><path d="M8 12h8M8 16h6"/></svg>';

const REPEAT_BADGE = {
  daily: 'ежедн.',
  weekdays: 'будни',
  weekly: 'еженед.',
};

const MONTH_NAMES_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/** @type {{ listKind: 'tasks' | 'habits', itemId: string, original: string } | null} */
let notesTarget = null;
/** @type {boolean} */
let notesSaving = false;
/** @type {{ listKind: 'tasks' | 'habits', itemId: string, original: string | null } | null} */
let timeTarget = null;
/** @type {boolean} */
let timeSaving = false;
/** @type {{ listKind: 'tasks' | 'habits', itemId: string, original: string | null } | null} */
let repeatTarget = null;
/** @type {boolean} */
let repeatSaving = false;
/** @type {{ habitId: string, year: number, month: number } | null} */
let streakTarget = null;

/** @type {'all' | 'today' | 'overdue' | 'undated'} */
let taskDueFilter = 'all';

/** Config accent from last server payload (before wallpaper override). */
let configAccent = '#C4122E';
/** @type {ReturnType<typeof setTimeout> | null} */
let slideClearTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let streaksEnterTimer = null;

const icons = {
  tasks: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg>',
  habits: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
};

/** Inline SVGs for habit rows — consistent outline stroke icons, viewBox 0 0 24 24. */
const HABIT_ICON_SVGS = {
  water:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.7l5.2 5.2a7.4 7.4 0 1 1-10.4 0z"/></svg>',
  read:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4h6.5A3.5 3.5 0 0 1 12 7.5V20a2.5 2.5 0 0 0-2.5-2.5H2z"/><path d="M22 4h-6.5A3.5 3.5 0 0 0 12 7.5V20a2.5 2.5 0 0 1 2.5-2.5H22z"/></svg>',
  sport:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 7v10M17.5 7v10M4 10v4M20 10v4M8.5 12h7M6.5 7h-1a2 2 0 0 0 0 4h1M6.5 13h-1a2 2 0 0 0 0 4h1M17.5 7h1a2 2 0 0 1 0 4h-1M17.5 13h1a2 2 0 0 1 0 4h-1"/></svg>',
  walk:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13.5" cy="5" r="2"/><path d="M8 21l2.5-5 2.2 2.2L15 21M11 11l-1.5 4.2L6 17.5M11 11l3.2 1.5 3.3-3.2 2 1.2"/></svg>',
  meditate:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6.5" r="2.2"/><path d="M8.2 21c.6-3.2 2.2-5.2 3.8-5.7M15.8 21c-.6-3.2-2.2-5.2-3.8-5.7"/><path d="M7 14.2c1.6-1.1 3.4-1.6 5-1.6s3.4.5 5 1.6"/><path d="M9.4 11.2c.9.7 1.8 1 2.6 1s1.7-.3 2.6-1"/></svg>',
  sleep:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.2A8.2 8.2 0 1 1 9.8 3 6.4 6.4 0 0 0 21 14.2z"/></svg>',
  food:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c1.4 0 2.6 1 3.8 1 2.8 0 5.7-7.5 5.7-11.5A4.6 4.6 0 0 0 17 5.2c-2.1 0-3.7 1.4-4.6 2-1-.6-2.6-2-4.7-2a4.6 4.6 0 0 0-4.6 5.3C3.1 14.5 6 22 8.8 22c1.2 0 2.4-1 3.2-1z"/><path d="M10.2 3.2c.9.5 1.8 1.8 1.8 4.3"/></svg>',
  stretch:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><path d="M5 10.5h14M12 7.5v5.5M8.5 21l3.5-8 3.5 8M9.5 13l-3.5 2.5M14.5 13l3.5 2.5"/></svg>',
  journal:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v18M11 8h5M11 12h5M11 16h3"/></svg>',
  study:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 10l10-5 10 5-10 5z"/><path d="M6 12v5.2c2.8 2.3 9.2 2.3 12 0V12"/><path d="M22 10v6"/></svg>',
  code:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  vitamins:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 20.5a5.2 5.2 0 0 1-7.4-7.4l7.4-7.4a5.2 5.2 0 0 1 7.4 7.4z"/><path d="M8.5 8.5l7 7"/></svg>',
  nosmoke:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8M8 14h6.5l1.8-2.2M16.5 11.8V9.5h1.8"/><path d="M18.8 9.5h1.2"/></svg>',
  language:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  clean:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.2 3.6L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.4z"/><path d="M18.5 14.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z"/><path d="M5.2 15.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/></svg>',
  coffee:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19H9.5A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 22h6M9 3v2M12 2v2M15 3v2"/></svg>',
  default:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.3 2.3 4.7-5"/></svg>',
};

/**
 * Pick a habit icon key from title keywords (EN + RU).
 * More specific themes are matched before broad ones.
 * @param {string} title
 * @returns {keyof typeof HABIT_ICON_SVGS}
 */
function habitIconKey(title) {
  const t = String(title || '').toLowerCase();
  if (/water|hydrat|вод|пить|напит|hydr/.test(t)) return 'water';
  if (/smoke|smok|куре|сигарет|nicotin/.test(t)) return 'nosmoke';
  if (/sugar|sweet|candy|diet|calorie|сахар|сладк|диет|калор|фастфуд|junk/.test(t)) return 'food';
  if (/vitamin|pill|supplem|витамин|таблет|бад/.test(t)) return 'vitamins';
  if (/coffee|tea|caffeine|кофе|чай/.test(t)) return 'coffee';
  if (/code|coding|program|dev\b|программ|\bкод\b|кодить|хакер/.test(t)) return 'code';
  if (/music|piano|guitar|музык|гитар|пианин|песн/.test(t)) return 'music';
  if (/language|english|spanish|french|german|japanes|chinese|язык|англий|испан|немец|франц|япон|китай|иностран/.test(t))
    return 'language';
  if (/clean|tidy|laundry|уборк|чист|пыл|стирк|мыт[ьа]/.test(t)) return 'clean';
  if (/journal|diary|gratitude|дневник|журнал|благодар|запис/.test(t)) return 'journal';
  if (/study|homework|learn|учеба|учеб|урок|домашк|учить|обучен/.test(t)) return 'study';
  if (/stretch|flexib|растяж|разминк|гибк/.test(t)) return 'stretch';
  if (/read|book|чита|книг/.test(t)) return 'read';
  if (/sleep|rest|bedtime|сон|спат|отдых|высып/.test(t)) return 'sleep';
  if (/meditat|yoga|mindful|calm|breath|медита|йог|дыхани|спокой|дзен/.test(t)) return 'meditate';
  if (/walk|steps|прогул|шаг|пешк|ходьб/.test(t)) return 'walk';
  if (/sport|exercis|workout|gym|run|jog|fitness|bike|цикл|спорт|тренир|упражн|бег|зарядк|фитнес|качал/.test(t))
    return 'sport';
  if (/food|eat|meal|nutrition|еда|питан|завтрак|обед|ужин/.test(t)) return 'food';
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

/** @type {ReturnType<typeof setTimeout> | null} */
let settingsCloseTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let notesCloseTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let timeCloseTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let repeatCloseTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let streakCloseTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let ctxCloseTimer = null;
/** Bump to cancel a pending afterPaint open (close raced open). */
let settingsOpenGen = 0;
let notesOpenGen = 0;
let timeOpenGen = 0;
let repeatOpenGen = 0;
let streakOpenGen = 0;
let ctxOpenGen = 0;

function motionMs(cssVar, fallback) {
  if (motionQuiet()) return 0;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    if (!raw) return fallback;
    if (raw.endsWith('ms')) return Math.max(0, parseFloat(raw) || fallback);
    if (raw.endsWith('s')) return Math.max(0, (parseFloat(raw) || fallback / 1000) * 1000);
  } catch {
    /* ignore */
  }
  return fallback;
}

/** One rAF is enough after unhiding — double-rAF added a frame of mush. */
function afterPaint(fn) {
  requestAnimationFrame(fn);
}

function setSettingsOpen(open) {
  if (settingsCloseTimer) {
    clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }
  btnSettings.setAttribute('aria-expanded', String(open));
  if (open) {
    const gen = ++settingsOpenGen;
    settingsPanel.hidden = false;
    if (motionQuiet()) {
      settingsPanel.classList.add('is-open');
      return;
    }
    settingsPanel.classList.remove('is-open');
    afterPaint(() => {
      if (gen !== settingsOpenGen || settingsPanel.hidden) return;
      settingsPanel.classList.add('is-open');
    });
    return;
  }
  settingsOpenGen += 1;
  settingsPanel.classList.remove('is-open');
  if (motionQuiet()) {
    settingsPanel.hidden = true;
    return;
  }
  settingsCloseTimer = setTimeout(() => {
    settingsPanel.hidden = true;
    settingsCloseTimer = null;
  }, motionMs('--panel-ms', 210) + 40);
}

/**
 * @param {HTMLElement | null} overlay
 * @param {boolean} open
 * @param {{ timerRef: 'notes' | 'time' | 'repeat' | 'streak', onClosed?: () => void, focusEl?: HTMLElement | null }} opts
 */
function setOverlayOpen(overlay, open, opts) {
  if (!overlay) return;
  const timerKey = opts.timerRef;
  const clearClose = () => {
    if (timerKey === 'notes' && notesCloseTimer) {
      clearTimeout(notesCloseTimer);
      notesCloseTimer = null;
    }
    if (timerKey === 'time' && timeCloseTimer) {
      clearTimeout(timeCloseTimer);
      timeCloseTimer = null;
    }
    if (timerKey === 'repeat' && repeatCloseTimer) {
      clearTimeout(repeatCloseTimer);
      repeatCloseTimer = null;
    }
    if (timerKey === 'streak' && streakCloseTimer) {
      clearTimeout(streakCloseTimer);
      streakCloseTimer = null;
    }
  };
  clearClose();
  const bumpOpenGen = () => {
    if (timerKey === 'notes') return ++notesOpenGen;
    if (timerKey === 'repeat') return ++repeatOpenGen;
    if (timerKey === 'streak') return ++streakOpenGen;
    return ++timeOpenGen;
  };
  const latestOpenGen = () => {
    if (timerKey === 'notes') return notesOpenGen;
    if (timerKey === 'repeat') return repeatOpenGen;
    if (timerKey === 'streak') return streakOpenGen;
    return timeOpenGen;
  };
  if (open) {
    const gen = bumpOpenGen();
    overlay.hidden = false;
    if (motionQuiet()) {
      overlay.classList.add('is-open');
      opts.focusEl?.focus?.();
      return;
    }
    overlay.classList.remove('is-open');
    afterPaint(() => {
      if (gen !== latestOpenGen() || overlay.hidden) return;
      overlay.classList.add('is-open');
      opts.focusEl?.focus?.();
    });
    return;
  }
  if (timerKey === 'notes') notesOpenGen += 1;
  else if (timerKey === 'repeat') repeatOpenGen += 1;
  else if (timerKey === 'streak') streakOpenGen += 1;
  else timeOpenGen += 1;
  overlay.classList.remove('is-open');
  const finish = () => {
    overlay.hidden = true;
    opts.onClosed?.();
    if (timerKey === 'notes') notesCloseTimer = null;
    if (timerKey === 'time') timeCloseTimer = null;
    if (timerKey === 'repeat') repeatCloseTimer = null;
    if (timerKey === 'streak') streakCloseTimer = null;
  };
  if (motionQuiet()) {
    finish();
    return;
  }
  const delay = motionMs('--panel-ms', 210) + 40;
  if (timerKey === 'notes') notesCloseTimer = setTimeout(finish, delay);
  else if (timerKey === 'repeat') repeatCloseTimer = setTimeout(finish, delay);
  else if (timerKey === 'streak') streakCloseTimer = setTimeout(finish, delay);
  else timeCloseTimer = setTimeout(finish, delay);
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
      panels.classList.remove('is-sliding', 'streaks-enter');
      if (slideClearTimer) {
        clearTimeout(slideClearTimer);
        slideClearTimer = null;
      }
      if (streaksEnterTimer) {
        clearTimeout(streaksEnterTimer);
        streaksEnterTimer = null;
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
  if (streaksEnterTimer) {
    clearTimeout(streaksEnterTimer);
    streaksEnterTimer = null;
  }
  panels.classList.remove('is-sliding');
  panels.classList.remove('streaks-enter');

  const animate = !force && prev !== view && !motionQuiet();
  if (animate) {
    panels.classList.add('is-sliding');
    if (view === 'habits') {
      // Must be on before data-view flips so streak transitions pick up the delay.
      panels.classList.add('streaks-enter');
    }
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
    const slideMs = motionMs('--slide-ms', 340);
    slideClearTimer = setTimeout(() => {
      panels.classList.remove('is-sliding');
      panels.removeEventListener('transitionend', onEnd);
      slideClearTimer = null;
    }, slideMs + 60);
    if (view === 'habits') {
      // Keep enter delays until the staggered streak motion finishes.
      streaksEnterTimer = setTimeout(() => {
        panels.classList.remove('streaks-enter');
        streaksEnterTimer = null;
      }, slideMs + 280);
    }
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
  // Managed «время» / «повтор» lines alone are not real notes content.
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some(
      (l) =>
        l &&
        !/^(?:время|Время|time)\s*[:\-]?\s*\d{1,2}[:.]\d{2}$/i.test(l) &&
        !/^(?:повтор|Повтор|repeat)\s*[:\-]?\s*(ежедневно|будни|еженедельно|daily|weekdays|weekly)\s*$/i.test(
          l
        )
    );
}

function taskHasTime(task) {
  return Boolean(task && typeof task.dueTime === 'string' && /^\d{2}:\d{2}$/.test(task.dueTime));
}

function taskRecurrence(task) {
  const r = task && task.recurrence;
  if (r === 'daily' || r === 'weekdays' || r === 'weekly') return r;
  return null;
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

function syncRowRepeatBadge(li, task) {
  if (!li) return;
  const metaLine = li.querySelector('.row-meta-line');
  let badge = li.querySelector('.row-repeat');
  const rule = taskRecurrence(task);
  if (!rule) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'row-repeat';
    badge.setAttribute('aria-label', 'Повтор');
    if (metaLine) metaLine.appendChild(badge);
    else {
      const meta = li.querySelector('.row-meta');
      if (meta && meta.parentElement) meta.parentElement.appendChild(badge);
    }
  }
  badge.textContent = REPEAT_BADGE[rule] || rule;
  badge.title =
    rule === 'daily'
      ? 'Повтор: ежедневно'
      : rule === 'weekdays'
        ? 'Повтор: будни'
        : 'Повтор: еженедельно';
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
  syncRowRepeatBadge(li, task);
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
    <div class="streak" aria-label="Стрик ${streak} дней" title="История стрика" role="button" tabindex="0" data-streak-open="1">
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

/**
 * Nesting choice: if a child matches the date filter, keep its parent in the list
 * for context (parent may not match). Non-matching siblings stay hidden.
 * @param {any} task
 * @param {'all' | 'today' | 'overdue' | 'undated'} filter
 */
function taskMatchesDueFilter(task, filter) {
  if (!task || filter === 'all') return true;
  if (filter === 'undated') return !task.due;
  if (filter === 'today') return task.dueKind === 'today';
  if (filter === 'overdue') return task.dueKind === 'overdue';
  return true;
}

/**
 * @param {any[]} items already hideCompleted-filtered
 * @param {'all' | 'today' | 'overdue' | 'undated'} filter
 */
function filterTasksByDue(items, filter) {
  if (!filter || filter === 'all') return items;
  const byId = new Map();
  for (const t of items) {
    if (t && t.id) byId.set(t.id, t);
  }
  const keep = new Set();
  for (const t of items) {
    if (taskMatchesDueFilter(t, filter)) keep.add(t.id);
  }
  for (const id of [...keep]) {
    let cur = byId.get(id);
    while (cur && cur.parent && byId.has(cur.parent)) {
      keep.add(cur.parent);
      cur = byId.get(cur.parent);
    }
  }
  return items.filter((t) => t && keep.has(t.id));
}

/** Tasks list after hideCompleted + due filter. */
function visibleTasks() {
  return filterTasksByDue(filterVisibleItems(state.tasks), taskDueFilter);
}

function countOpenDue(kind) {
  let n = 0;
  for (const t of state.tasks) {
    if (!t || t.completed) continue;
    if (kind === 'today' && t.dueKind === 'today') n += 1;
    else if (kind === 'overdue' && t.dueKind === 'overdue') n += 1;
  }
  return n;
}

function syncTaskFilterUi() {
  if (!taskFilterChips) return;
  for (const btn of taskFilterChips.querySelectorAll('[data-filter]')) {
    const f = btn.getAttribute('data-filter') || 'all';
    const on = f === taskDueFilter;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const todayEl = taskFilterChips.querySelector('[data-count="today"]');
  const overdueEl = taskFilterChips.querySelector('[data-count="overdue"]');
  const todayN = countOpenDue('today');
  const overdueN = countOpenDue('overdue');
  if (todayEl) {
    todayEl.textContent = todayN ? String(todayN) : '';
    todayEl.hidden = !todayN;
  }
  if (overdueEl) {
    overdueEl.textContent = overdueN ? String(overdueN) : '';
    overdueEl.hidden = !overdueN;
  }
}

function setTaskDueFilter(next) {
  const allowed = next === 'today' || next === 'overdue' || next === 'undated' ? next : 'all';
  if (allowed === taskDueFilter) return;
  taskDueFilter = allowed;
  syncTaskFilterUi();
  renderTasks();
}

function ensureListEmpty(listEl, kind, allItems, visibleItems) {
  if (visibleItems.length) return;
  const empty =
    kind === 'habits'
      ? allItems.length
        ? '<li class="empty">Все привычки на сегодня выполнены.</li>'
        : '<li class="empty">Нет привычек. Добавьте ниже или создайте список «Habits».</li>'
      : taskDueFilter !== 'all' && allItems.length
        ? '<li class="empty">Нет задач в этом фильтре.</li>'
        : allItems.length
          ? '<li class="empty">Все задачи выполнены.</li>'
          : '<li class="empty">Нет задач. Добавьте ниже или создайте список Google Tasks.</li>';
  listEl.innerHTML = empty;
}

function renderTasks() {
  syncTaskFilterUi();
  const visible = visibleTasks();
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

function markRowEnter(li) {
  if (!li || motionQuiet()) return;
  li.classList.remove('row-enter');
  // Force restart if re-added quickly
  void li.offsetWidth;
  li.classList.add('row-enter');
  const clear = (e) => {
    if (e && e.target !== li) return;
    li.classList.remove('row-enter');
    li.removeEventListener('animationend', clear);
  };
  li.addEventListener('animationend', clear);
  setTimeout(() => li.classList.remove('row-enter'), 400);
}

function removeRowAnimated(li, done) {
  if (!li) {
    done?.();
    return;
  }
  if (motionQuiet()) {
    li.remove();
    done?.();
    return;
  }
  li.classList.add('row-leave');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    li.removeEventListener('transitionend', onEnd);
    if (li.parentNode) li.remove();
    done?.();
  };
  const onEnd = (e) => {
    if (e.target !== li || (e.propertyName !== 'opacity' && e.propertyName !== 'transform')) return;
    finish();
  };
  li.addEventListener('transitionend', onEnd);
  setTimeout(finish, 260);
}

function syncListOrder(listEl, items) {
  const idSet = new Set(items.map((it) => it.id));
  for (const item of items) {
    const row = rowById(listEl, item.id);
    if (row) listEl.appendChild(row);
  }
  for (const row of [...listEl.querySelectorAll('li.row')]) {
    if (!idSet.has(row.dataset.id)) row.remove();
  }
}

function patchTaskRow(task) {
  syncTaskFilterUi();
  const visible = visibleTasks();
  const inView = visible.some((t) => t.id === task.id);
  if (!inView) {
    const li = rowById(listTasks, task.id);
    if (li) {
      removeRowAnimated(li, () => {
        syncListOrder(listTasks, visibleTasks());
        ensureListEmpty(listTasks, 'tasks', state.tasks, visibleTasks());
      });
      return;
    }
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
    markRowEnter(li);
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
    syncRowRepeatBadge(li, task);
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
    if (li) {
      removeRowAnimated(li, () => {
        syncListOrder(listHabits, filterVisibleItems(state.habits));
        ensureListEmpty(listHabits, 'habits', state.habits, filterVisibleItems(state.habits));
      });
      return;
    }
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
    markRowEnter(li);
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
      streakEl.setAttribute('title', 'История стрика');
      streakEl.setAttribute('role', 'button');
      streakEl.setAttribute('tabindex', '0');
      streakEl.setAttribute('data-streak-open', '1');
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
  if (streakTarget && streakTarget.habitId === habit.id) renderStreakMonth();
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
    if (t.parent && byId.has(t.parent) && t.parent !== t.id) {
      if (!children.has(t.parent)) children.set(t.parent, []);
      children.get(t.parent).push(t);
    } else {
      roots.push(t);
    }
  }
  /** @type {typeof tasks} */
  const out = [];
  const visiting = new Set();
  const walk = (list) => {
    for (const t of list) {
      if (!t || !t.id || visiting.has(t.id)) continue;
      visiting.add(t.id);
      out.push(t);
      const kids = children.get(t.id);
      if (kids && kids.length) walk(kids);
      visiting.delete(t.id);
    }
  };
  walk(roots);
  for (const t of tasks) {
    if (t && t.id && !out.some((x) => x.id === t.id)) out.push(t);
  }
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
  if (Array.isArray(stats.completedDates)) {
    item.completedDates = stats.completedDates.slice();
  }
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
          completedDates: item.completedDates && item.completedDates.slice(),
        }
      : {
          status: item.status,
          meta: item.meta,
          dueKind: item.dueKind,
          due: item.due,
          completed: item.completed,
          recurrence: item.recurrence,
        };

  const next = !prevCompleted;
  const willReschedule = listKind === 'tasks' && next && Boolean(taskRecurrence(item));

  if (willReschedule) {
    // Optimistic: stay open; due rolls forward on server — keep UI open.
    item.completed = false;
    item.status = 'needsAction';
    item.dueKind = null;
    item.meta = 'Следующий…';
    resortTasksLocal();
    patchTaskRow(item);
  } else if (listKind === 'tasks') {
    item.completed = next;
    item.status = next ? 'completed' : 'needsAction';
    item.meta = next ? 'Done' : item.meta === 'Done' ? 'Task' : item.meta;
    item.dueKind = next ? null : item.dueKind;
    resortTasksLocal();
    patchTaskRow(item);
  } else {
    item.completed = next;
    item.status = next ? 'completed' : 'needsAction';
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
    // Server recomputes dueKind/meta/dueTime — critical after uncomplete / reschedule.
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
      Object.assign(item, prevSnapshot);
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
    markRowEnter(rowById(listTasks, item.id));
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
/** @type {Set<'tasks' | 'habits'>} */
const reorderLocks = new Set();

/**
 * Pointer-based row reorder (drag handle). Avoids HTML5 DnD + window drag conflicts.
 * Drops stay within the same completion group and the same parent (sibling reorder only).
 * @param {'tasks' | 'habits'} listKind
 * @param {HTMLElement} listEl
 */
function bindListReorder(listKind, listEl) {
  /** @type {{
   *   pointerId: number,
   *   row: HTMLElement,
   *   ghost: HTMLElement,
   *   startY: number,
   *   offsetY: number,
   *   ids: string[],
   *   targetIds: string[],
   *   draggedDone: boolean,
   *   draggedParent: string | null,
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

  function itemsForKind() {
    return listKind === 'habits' ? state.habits : state.tasks;
  }

  function endSession(commit) {
    if (!session) return;
    detachDocListeners();
    const { pointerId, row, ghost, ids, targetIds, moved } = session;
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
    const nextIds = targetIds && targetIds.length ? targetIds.slice() : ids.slice();
    session = null;
    dndActive = false;

    if (wasMoved) {
      if (dndClickBlockTimer) clearTimeout(dndClickBlockTimer);
      dndClickBlockTimer = setTimeout(() => {
        dndClickBlockTimer = null;
      }, 120);
    }

    if (!commit || !moved) return;
    if (nextIds.join('\0') === ids.join('\0')) return;

    const movedId = row.dataset.id;
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
    const visibleSet = new Set(orderedIds);
    // Splice the new visible order into existing slots so hideCompleted /
    // due-filter don't shove hidden items to the end of the full list.
    const slots = [];
    for (let i = 0; i < state[key].length; i += 1) {
      const it = state[key][i];
      if (it && visibleSet.has(it.id)) slots.push(i);
    }
    let next;
    if (slots.length === orderedIds.length && orderedIds.every((id) => byId.has(id))) {
      next = state[key].slice();
      for (let i = 0; i < slots.length; i += 1) {
        next[slots[i]] = byId.get(orderedIds[i]);
      }
    } else {
      next = [];
      const seen = new Set();
      for (const id of orderedIds) {
        const it = byId.get(id);
        if (!it || seen.has(id)) continue;
        next.push(it);
        seen.add(id);
      }
      for (const it of state[key]) {
        if (it && it.id && !seen.has(it.id)) next.push(it);
      }
    }
    state[key] = next;
    if (kind === 'habits') {
      resortHabitsLocal();
      syncListOrder(listHabits, filterVisibleItems(state.habits));
    } else {
      resortTasksLocal();
      syncListOrder(listTasks, visibleTasks());
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
    if (reorderLocks.has(kind)) return;
    reorderLocks.add(kind);
    try {
      await window.widgetApi.moveItem(kind, taskId, previousId, orderedIds);
    } catch (err) {
      setBanner(`Не удалось изменить порядок: ${err.message || err}`);
      await loadData(true);
    } finally {
      reorderLocks.delete(kind);
    }
  }

  function updateDropTarget(clientY) {
    if (!session) return;
    const items = itemsForKind();
    const byId = new Map(items.map((it) => [it.id, it]));
    const draggedDone = session.draggedDone;
    const draggedParent = session.draggedParent;

    const peers = [...listEl.querySelectorAll('li.row[data-id]')].filter((r) => {
      if (r === session.row) return false;
      const it = byId.get(r.dataset.id);
      if (!it) return false;
      if (Boolean(it.completed) !== draggedDone) return false;
      return (it.parent || null) === draggedParent;
    });

    clearDropIndicator();

    let insertAmongPeers = peers.length;
    for (let i = 0; i < peers.length; i++) {
      const rect = peers[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertAmongPeers = i;
        break;
      }
    }

    const groupIds = session.ids.filter((id) => {
      const it = byId.get(id);
      return (
        it &&
        Boolean(it.completed) === draggedDone &&
        (it.parent || null) === draggedParent
      );
    });
    const fromInGroup = groupIds.indexOf(session.row.dataset.id);
    if (fromInGroup < 0) return;

    const nextGroup = groupIds.slice();
    nextGroup.splice(fromInGroup, 1);
    nextGroup.splice(Math.min(insertAmongPeers, nextGroup.length), 0, session.row.dataset.id);

    let gi = 0;
    session.targetIds = session.ids.map((id) => {
      const it = byId.get(id);
      if (
        it &&
        Boolean(it.completed) === draggedDone &&
        (it.parent || null) === draggedParent
      ) {
        return nextGroup[gi++];
      }
      return id;
    });

    if (!peers.length) return;
    if (insertAmongPeers < peers.length) {
      peers[insertAmongPeers].classList.add('drop-before');
    } else {
      peers[peers.length - 1].classList.add('drop-after');
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

  function onKeyDown(e) {
    if (!session) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      endSession(false);
    }
  }

  function attachDocListeners() {
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKeyDown);
  }

  function detachDocListeners() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('keydown', onKeyDown);
  }

  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !listEl.contains(handle)) return;
    if (e.button !== 0) return;
    const row = handle.closest('li.row[data-id]');
    if (!row || row.classList.contains('is-editing')) return;
    if (pendingIds.has(row.dataset.id)) return;
    if (reorderLocks.has(listKind) || session) return;

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

    const dragged = itemsForKind().find((it) => it.id === row.dataset.id);
    if (!dragged) return;

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
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      ids,
      targetIds: ids.slice(),
      draggedDone: Boolean(dragged.completed),
      draggedParent: dragged.parent || null,
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
  const visible =
    listKind === 'habits'
      ? filterVisibleItems(state[listKey])
      : visibleTasks();
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

function closeNotesPanel({ revert, instant } = {}) {
  if (!notesOverlay || (notesOverlay.hidden && !notesOverlay.classList.contains('is-open'))) return;
  if (revert && notesTarget) {
    const items = notesTarget.listKind === 'habits' ? state.habits : state.tasks;
    const item = items.find((i) => i.id === notesTarget.itemId);
    if (item) item.notes = notesTarget.original;
  }
  notesTarget = null;
  if (notesTextarea) notesTextarea.value = '';
  if (instant) {
    if (notesCloseTimer) {
      clearTimeout(notesCloseTimer);
      notesCloseTimer = null;
    }
    notesOpenGen += 1;
    notesOverlay.classList.remove('is-open');
    notesOverlay.hidden = true;
    return;
  }
  setOverlayOpen(notesOverlay, false, { timerRef: 'notes' });
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
      if (Object.prototype.hasOwnProperty.call(result.item, 'recurrence')) {
        item.recurrence = result.item.recurrence;
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
  hideCtxMenu({ instant: true });
  closeTimePanel({ instant: true });
  closeRepeatPanel({ instant: true });
  closeStreakPanel({ instant: true });
  notesTarget = {
    listKind,
    itemId: item.id,
    original: String(item.notes || ''),
  };
  if (notesPanelTask) notesPanelTask.textContent = item.title || '';
  notesTextarea.value = notesTarget.original;
  setOverlayOpen(notesOverlay, true, {
    timerRef: 'notes',
    focusEl: notesTextarea,
  });
  afterPaint(() => {
    if (!notesTarget || !notesTextarea || notesOverlay.hidden) return;
    notesTextarea.setSelectionRange(notesTextarea.value.length, notesTextarea.value.length);
  });
}

function closeTimePanel({ instant } = {}) {
  if (!timeOverlay || (timeOverlay.hidden && !timeOverlay.classList.contains('is-open'))) return;
  timeTarget = null;
  if (timeInput) timeInput.value = '';
  if (instant) {
    if (timeCloseTimer) {
      clearTimeout(timeCloseTimer);
      timeCloseTimer = null;
    }
    timeOpenGen += 1;
    timeOverlay.classList.remove('is-open');
    timeOverlay.hidden = true;
    return;
  }
  setOverlayOpen(timeOverlay, false, { timerRef: 'time' });
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
  hideCtxMenu({ instant: true });
  closeNotesPanel({ instant: true });
  closeRepeatPanel({ instant: true });
  closeStreakPanel({ instant: true });
  const original =
    typeof item.dueTime === 'string' && /^\d{2}:\d{2}$/.test(item.dueTime) ? item.dueTime : null;
  timeTarget = {
    listKind,
    itemId: item.id,
    original,
  };
  if (timePanelTask) timePanelTask.textContent = item.title || '';
  timeInput.value = original || '';
  setOverlayOpen(timeOverlay, true, {
    timerRef: 'time',
    focusEl: timeInput,
  });
}

function closeRepeatPanel({ instant } = {}) {
  if (!repeatOverlay || (repeatOverlay.hidden && !repeatOverlay.classList.contains('is-open'))) {
    return;
  }
  repeatTarget = null;
  if (instant) {
    if (repeatCloseTimer) {
      clearTimeout(repeatCloseTimer);
      repeatCloseTimer = null;
    }
    repeatOpenGen += 1;
    repeatOverlay.classList.remove('is-open');
    repeatOverlay.hidden = true;
    return;
  }
  setOverlayOpen(repeatOverlay, false, { timerRef: 'repeat' });
}

function syncRepeatOptionsUi(selected) {
  if (!repeatOptions) return;
  for (const btn of repeatOptions.querySelectorAll('[data-repeat]')) {
    const val = btn.getAttribute('data-repeat') || 'none';
    const on = (selected || 'none') === val;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-active', on);
  }
}

async function saveRepeatPanel(next) {
  if (!repeatTarget || !window.widgetApi || repeatSaving) return false;
  if (!guardMutate('сохранить повтор')) return false;
  const { listKind, itemId, original } = repeatTarget;
  const items = listKind === 'habits' ? state.habits : state.tasks;
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    closeRepeatPanel();
    return false;
  }
  const value = next === 'none' || !next ? null : next;
  if (value === original || (value === null && original === null)) {
    closeRepeatPanel();
    return true;
  }
  repeatSaving = true;
  try {
    const result = await window.widgetApi.updateItem(listKind, itemId, { recurrence: value });
    if (result && result.item) {
      if (typeof result.item.notes === 'string') item.notes = result.item.notes;
      if (typeof result.item.meta === 'string') item.meta = result.item.meta;
      if (Object.prototype.hasOwnProperty.call(result.item, 'recurrence')) {
        item.recurrence = result.item.recurrence;
      } else {
        item.recurrence = value;
      }
    } else {
      item.recurrence = value;
    }
    if (listKind === 'habits') patchHabitRow(item);
    else patchTaskRow(item);
    closeRepeatPanel();
    return true;
  } catch (err) {
    setBanner(`Не удалось сохранить повтор: ${err.message || err}`);
    return false;
  } finally {
    repeatSaving = false;
  }
}

function openRepeatPanel(listKind, item) {
  if (!repeatOverlay || !item) return;
  if (!guardMutate('изменить повтор')) return;
  hideCtxMenu({ instant: true });
  closeNotesPanel({ instant: true });
  closeTimePanel({ instant: true });
  closeStreakPanel({ instant: true });
  const original = taskRecurrence(item);
  repeatTarget = {
    listKind,
    itemId: item.id,
    original,
  };
  if (repeatPanelTask) repeatPanelTask.textContent = item.title || '';
  syncRepeatOptionsUi(original || 'none');
  setOverlayOpen(repeatOverlay, true, {
    timerRef: 'repeat',
    focusEl: repeatOptions?.querySelector('[data-repeat].is-active') || repeatOptions,
  });
}

function localIsoFromParts(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function closeStreakPanel({ instant } = {}) {
  if (!streakOverlay || (streakOverlay.hidden && !streakOverlay.classList.contains('is-open'))) {
    return;
  }
  streakTarget = null;
  if (instant) {
    if (streakCloseTimer) {
      clearTimeout(streakCloseTimer);
      streakCloseTimer = null;
    }
    streakOpenGen += 1;
    streakOverlay.classList.remove('is-open');
    streakOverlay.hidden = true;
    return;
  }
  setOverlayOpen(streakOverlay, false, { timerRef: 'streak' });
}

function renderStreakMonth() {
  if (!streakTarget || !streakMonthGrid) return;
  const habit = state.habits.find((h) => h.id === streakTarget.habitId);
  const dates = new Set(
    Array.isArray(habit && habit.completedDates) ? habit.completedDates : []
  );
  const { year, month } = streakTarget;
  const today = new Date();
  const todayKey = localIsoFromParts(
    today.getFullYear(),
    today.getMonth() + 1,
    today.getDate()
  );
  if (streakMonthLabel) {
    streakMonthLabel.textContent = `${MONTH_NAMES_RU[month]} ${year}`;
  }
  // Monday-first grid
  const first = new Date(year, month, 1);
  let startPad = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const frag = document.createDocumentFragment();
  let doneInMonth = 0;
  for (let i = 0; i < startPad; i += 1) {
    const empty = document.createElement('span');
    empty.className = 'streak-day is-empty';
    empty.setAttribute('aria-hidden', 'true');
    frag.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = localIsoFromParts(year, month + 1, day);
    const cell = document.createElement('span');
    const done = dates.has(key);
    if (done) doneInMonth += 1;
    const isToday = key === todayKey;
    const isFuture = key > todayKey;
    cell.className = `streak-day${done ? ' is-done' : ''}${isToday ? ' is-today' : ''}${
      isFuture ? ' is-future' : ''
    }`;
    cell.textContent = String(day);
    cell.title = done ? `${key} · выполнено` : key;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', done ? `${day}, выполнено` : String(day));
    frag.appendChild(cell);
  }
  streakMonthGrid.replaceChildren(frag);
  if (streakMonthStat) {
    streakMonthStat.textContent = `${doneInMonth} дн. в месяце`;
  }
  if (streakMonthStreak) {
    const streak = (habit && habit.streak) || 0;
    streakMonthStreak.textContent = streak ? `Стрик ${streak} дн.` : '';
  }
  if (btnStreakNext) {
    const now = new Date();
    const atCurrent =
      year > now.getFullYear() ||
      (year === now.getFullYear() && month >= now.getMonth());
    btnStreakNext.disabled = atCurrent;
  }
}

function shiftStreakMonth(delta) {
  if (!streakTarget) return;
  let { year, month } = streakTarget;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  const now = new Date();
  if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth())) {
    return;
  }
  streakTarget = { ...streakTarget, year, month };
  renderStreakMonth();
}

function openStreakPanel(habit) {
  if (!streakOverlay || !habit) return;
  hideCtxMenu({ instant: true });
  closeNotesPanel({ instant: true });
  closeTimePanel({ instant: true });
  closeRepeatPanel({ instant: true });
  const now = new Date();
  streakTarget = {
    habitId: habit.id,
    year: now.getFullYear(),
    month: now.getMonth(),
  };
  if (streakPanelTask) streakPanelTask.textContent = habit.title || '';
  renderStreakMonth();
  setOverlayOpen(streakOverlay, true, {
    timerRef: 'streak',
    focusEl: btnStreakClose,
  });
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
    '<button type="button" class="ctx-menu-item" role="menuitem" data-action="repeat">' +
      '<svg class="ctx-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' +
      '<span>Повтор</span>' +
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
    hideCtxMenu({ instant: true });
    if (!item) return;
    if (action === 'edit') beginInlineEdit(listKind, item, row);
    else if (action === 'notes') openNotesPanel(listKind, item);
    else if (action === 'time') openTimePanel(listKind, item);
    else if (action === 'repeat' && listKind === 'tasks') openRepeatPanel(listKind, item);
    else if (action === 'subtask' && listKind === 'tasks') beginAddSubtask(item, row);
    else if (action === 'delete') removeItem(listKind, item);
  });

  return ctxMenuEl;
}

function hideCtxMenu({ instant } = {}) {
  if (!ctxMenuEl) return;
  if (ctxMenuEl.hidden && !ctxMenuEl.classList.contains('is-open')) {
    ctxMenuTarget = null;
    return;
  }
  if (ctxCloseTimer) {
    clearTimeout(ctxCloseTimer);
    ctxCloseTimer = null;
  }
  ctxOpenGen += 1;
  ctxMenuTarget = null;
  ctxMenuEl.classList.remove('is-open');
  const finish = () => {
    ctxMenuEl.hidden = true;
    ctxCloseTimer = null;
  };
  if (instant || motionQuiet()) {
    finish();
    return;
  }
  ctxCloseTimer = setTimeout(finish, motionMs('--ctx-ms', 120) + 30);
}

function showCtxMenu(listKind, item, e) {
  const menu = ensureCtxMenu();
  if (ctxCloseTimer) {
    clearTimeout(ctxCloseTimer);
    ctxCloseTimer = null;
  }
  const gen = ++ctxOpenGen;
  ctxMenuTarget = { listKind, itemId: item.id };
  const subBtn = menu.querySelector('[data-action="subtask"]');
  // Google Tasks supports one nesting level — only top-level tasks get «Подзадача».
  if (subBtn) subBtn.hidden = listKind !== 'tasks' || Boolean(item.parent);
  const repeatBtn = menu.querySelector('[data-action="repeat"]');
  // Habits already reset daily via streak store — recurrence is for tasks.
  if (repeatBtn) repeatBtn.hidden = listKind !== 'tasks';

  menu.classList.remove('is-open');
  menu.hidden = false;

  // Measure off-screen then clamp into viewport
  menu.style.left = '0px';
  menu.style.top = '0px';
  const { width, height } = menu.getBoundingClientRect();
  const pad = 8;
  const x = Math.min(e.clientX, window.innerWidth - width - pad);
  const y = Math.min(e.clientY, window.innerHeight - height - pad);
  const left = Math.max(pad, x);
  const top = Math.max(pad, y);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Scale from click corner: prefer top-left; flip origin when clamped to bottom/right.
  const originX = e.clientX > left + width * 0.55 ? '100%' : '0%';
  const originY = e.clientY > top + height * 0.55 ? '100%' : '0%';
  menu.style.transformOrigin = `${originX} ${originY}`;

  if (motionQuiet()) {
    menu.classList.add('is-open');
    return;
  }
  // Double-rAF so the browser paints the closed state before opening.
  afterPaint(() => {
    if (gen !== ctxOpenGen || menu.hidden || !ctxMenuTarget) return;
    menu.classList.add('is-open');
  });
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
  const streakHit = e.target.closest('[data-streak-open]');
  if (streakHit) {
    e.preventDefault();
    e.stopPropagation();
    const li = streakHit.closest('li.row[data-id]');
    if (!li || !listHabits.contains(li)) return;
    const item = state.habits.find((h) => h.id === li.dataset.id);
    if (item) openStreakPanel(item);
    return;
  }
  const li = e.target.closest('li.row[data-id]');
  if (!li || !listHabits.contains(li) || li.classList.contains('is-editing')) return;
  const item = state.habits.find((h) => h.id === li.dataset.id);
  if (item) toggleItem('habits', item);
});

listHabits.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const streakHit = e.target.closest('[data-streak-open]');
  if (!streakHit || !listHabits.contains(streakHit)) return;
  e.preventDefault();
  const li = streakHit.closest('li.row[data-id]');
  if (!li) return;
  const item = state.habits.find((h) => h.id === li.dataset.id);
  if (item) openStreakPanel(item);
});

listTasks.addEventListener('contextmenu', (e) => handleRowContextMenu('tasks', e));
listHabits.addEventListener('contextmenu', (e) => handleRowContextMenu('habits', e));

document.addEventListener('pointerdown', (e) => {
  if (ctxMenuEl && !ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) hideCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (streakOverlay && !streakOverlay.hidden) {
    e.preventDefault();
    closeStreakPanel();
    return;
  }
  if (repeatOverlay && !repeatOverlay.hidden) {
    e.preventDefault();
    closeRepeatPanel();
    return;
  }
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
  hideCtxMenu({ instant: true });
});
window.addEventListener('blur', () => hideCtxMenu({ instant: true }));
window.addEventListener('resize', () => hideCtxMenu({ instant: true }));
panels?.addEventListener('scroll', () => hideCtxMenu({ instant: true }), true);
panelTasks?.addEventListener('scroll', () => hideCtxMenu({ instant: true }));
panelHabits?.addEventListener('scroll', () => hideCtxMenu({ instant: true }));

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
      if (
        notesIgnoreBlur ||
        !notesTarget ||
        !notesOverlay ||
        notesOverlay.hidden ||
        !notesOverlay.classList.contains('is-open') ||
        notesSaving
      ) {
        return;
      }
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
if (repeatOptions) {
  repeatOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-repeat]');
    if (!btn || repeatSaving) return;
    e.preventDefault();
    const val = btn.getAttribute('data-repeat') || 'none';
    syncRepeatOptionsUi(val);
    saveRepeatPanel(val === 'none' ? null : val);
  });
}
if (repeatOverlay) {
  repeatOverlay.addEventListener('click', (e) => {
    if (e.target === repeatOverlay) closeRepeatPanel();
  });
}
const btnRepeatClose = document.getElementById('btnRepeatClose');
if (btnRepeatClose) {
  btnRepeatClose.addEventListener('click', (e) => {
    e.preventDefault();
    closeRepeatPanel();
  });
}
if (btnStreakClose) {
  btnStreakClose.addEventListener('click', (e) => {
    e.preventDefault();
    closeStreakPanel();
  });
}
if (btnStreakPrev) {
  btnStreakPrev.addEventListener('click', (e) => {
    e.preventDefault();
    shiftStreakMonth(-1);
  });
}
if (btnStreakNext) {
  btnStreakNext.addEventListener('click', (e) => {
    e.preventDefault();
    shiftStreakMonth(1);
  });
}
if (streakOverlay) {
  streakOverlay.addEventListener('click', (e) => {
    if (e.target === streakOverlay) closeStreakPanel();
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
if (taskFilterChips) {
  taskFilterChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn || !taskFilterChips.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    setTaskDueFilter(btn.getAttribute('data-filter') || 'all');
  });
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
  const open = btnSettings.getAttribute('aria-expanded') !== 'true';
  setSettingsOpen(open);
});

document.addEventListener('click', (e) => {
  if (btnSettings.getAttribute('aria-expanded') !== 'true') return;
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
