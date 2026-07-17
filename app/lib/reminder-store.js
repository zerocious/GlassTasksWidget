'use strict';

const { readJson, writeJson, dataPath } = require('./config');

/**
 * Persist which items were notified today to avoid spam.
 * @typedef {{ date: string, notifiedIds: string[] }} ReminderState
 */

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function remindersFile() {
  return dataPath('reminders.json');
}

/**
 * @returns {ReminderState}
 */
function loadReminderState() {
  const raw = readJson(remindersFile(), {});
  const date = typeof raw.date === 'string' ? raw.date : '';
  const today = todayKey();
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
  writeJson(remindersFile(), {
    date: state.date || todayKey(),
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

module.exports = {
  todayKey,
  loadReminderState,
  saveReminderState,
  markNotified,
  wasNotifiedToday,
};
