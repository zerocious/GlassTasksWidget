'use strict';

/** Local calendar day as YYYY-MM-DD (the widget's "today" everywhere). */
function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift a local YYYY-MM-DD key by whole days (DST-safe: works on calendar dates). */
function addDaysIso(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return todayIso(dt);
}

module.exports = { todayIso, addDaysIso };
