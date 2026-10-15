'use strict';

const { dataPath } = require('./config');
const { loadDoc, saveDoc } = require('./storage-files');
const { todayIso } = require('./dates');

/**
 * Persist which items were notified today to avoid spam.
 * @typedef {{ date: string, notifiedIds: string[] }} ReminderState
 */

function remindersFile() {
  return dataPath('reminders.json');
}

/** reminders.json: which items were already announced today. Disposable: no last good copy. */
const REMINDERS_SPEC = {
  name: 'reminders.json',
  file: remindersFile,
  version: 1,
  // v0 -> v1: the file only gained schemaVersion.
  migrations: { 1: (d) => d },
};

/**
 * @returns {ReminderState}
 */
function loadReminderState() {
  const raw = loadDoc(REMINDERS_SPEC).data || {};
  const date = typeof raw.date === 'string' ? raw.date : '';
  const today = todayIso();
  if (date !== today) {
    return { date: today, notifiedIds: [] };
  }
  const ids = Array.isArray(raw.notifiedIds)
    ? raw.notifiedIds.filter((id) => typeof id === 'string' && id)
    : [];
  return { date: today, notifiedIds: [...new Set(ids)] };
}

/**
 * @param {ReminderState} state
 */
function saveReminderState(state) {
  saveDoc(REMINDERS_SPEC, {
    date: state.date || todayIso(),
    notifiedIds: [...new Set(state.notifiedIds || [])],
  });
}

/**
 * @param {string[]} ids
 */
function markNotified(ids) {
  if (!ids.length) return;
  const state = loadReminderState();
  const set = new Set(state.notifiedIds);
  for (const id of ids) set.add(id);
  state.notifiedIds = [...set];
  saveReminderState(state);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function wasNotifiedToday(id) {
  const state = loadReminderState();
  return state.notifiedIds.includes(id);
}

/**
 * Clear today's notified set (used by manual «Проверить» so toasts can fire again).
 */
function clearNotifiedToday() {
  saveReminderState({ date: todayIso(), notifiedIds: [] });
}

module.exports = {
  REMINDERS_SPEC,
  loadReminderState,
  saveReminderState,
  markNotified,
  wasNotifiedToday,
  clearNotifiedToday,
};
