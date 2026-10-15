'use strict';

const { createJsonDoc } = require('./storage-doc');
const { todayIso } = require('./dates');

/**
 * Persist which items were notified today to avoid spam.
 * @typedef {{ date: string, notifiedIds: string[] }} ReminderState
 */

/** reminders.json — schema 1 = `{ date, notifiedIds }` (schema 0 had the same fields). */
const remindersDoc = createJsonDoc({
  name: 'reminders.json',
  label: 'журнал напоминаний',
  version: 1,
  rereadsEveryTime: true,
  defaults: () => ({}),
});

/**
 * @returns {ReminderState}
 */
function loadReminderState() {
  const raw = remindersDoc.read();
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
  remindersDoc.write({
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
  loadReminderState,
  saveReminderState,
  markNotified,
  wasNotifiedToday,
  clearNotifiedToday,
  remindersDoc,
};
