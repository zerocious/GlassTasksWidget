'use strict';

/**
 * Quick-add parsing: «Позвонить маме завтра в 18:30», «Отчёт в пятницу», «Зарядка каждый день 7:00».
 * Recognised phrases are removed from the title and returned as date / time / repeat.
 */

const { todayIso, addDaysIso } = require('./dates');

// Cyrillic-aware word boundaries (\b only knows ASCII); a hyphen joins words («ср-во», «пн-пт»).
const B = '(?<![\\p{L}\\p{N}-])';
const E = '(?![\\p{L}\\p{N}-])';
/** Neither end of a range: «10:00 - 12:00», «12.10 – 15.10». */
const NOT_RANGE = '(?<!\\d\\s*[-–—]\\s*)';
const NOT_RANGE_AFTER = '(?!\\s*[-–—]\\s*\\d)';
/** A bare «2:10» right after «счёт [матча]», «глава», «стих» is a score or a verse, not a time. */
const NOT_SCORE = '(?<!(?<!\\p{L})(?:сч[её]т|глав[аеуы]?|стих)(?:\\s+\\p{L}+)?\\s+)';

/** JS getDay(): 0 = Sunday. */
const WEEKDAYS = [
  { day: 1, re: 'понедельник|пн' },
  { day: 2, re: 'вторник|вт' },
  { day: 3, re: 'среду|среда|ср' },
  { day: 4, re: 'четверг|чт' },
  { day: 5, re: 'пятницу|пятница|пт' },
  { day: 6, re: 'субботу|суббота|сб' },
  { day: 0, re: 'воскресенье|вс' },
];

const REPEATS = [
  { rule: 'weekdays', re: 'по будням|каждый будний день|в будни' },
  { rule: 'daily', re: 'каждый день|ежедневно' },
  { rule: 'weekly', re: 'каждую неделю|еженедельно' },
];

function rx(body) {
  return new RegExp(`${B}(?:${body})${E}`, 'giu');
}

function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Next date (today included) that falls on `day`. */
function nextWeekday(today, day) {
  const delta = (day - weekdayOf(today) + 7) % 7;
  return addDaysIso(today, delta);
}

function validDateKey(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
    ? todayIso(dt)
    : null;
}

/**
 * @param {string} input
 * @param {Date} [now]
 * @returns {{ title: string, dueKey: string | null, time: string | null,
 *   recurrence: 'daily' | 'weekdays' | 'weekly' | null }}
 */
function parseQuickAdd(input, now = new Date()) {
  const original = String(input || '').trim();
  const today = todayIso(now);
  let text = ` ${original} `;
  /** @type {string | null} */
  let dueKey = null;
  /** @type {string | null} */
  let time = null;
  /** @type {'daily' | 'weekdays' | 'weekly' | null} */
  let recurrence = null;

  /** Remove the first match `onMatch` accepts («2.50» is skipped, «12.11» after it is taken). */
  const take = (re, onMatch) => {
    for (const m of text.matchAll(re)) {
      if (onMatch(m) === false) continue;
      text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
      return true;
    }
    return false;
  };

  for (const r of REPEATS) {
    if (take(rx(r.re), () => {
      recurrence = /** @type {any} */ (r.rule);
    })) break;
  }

  // Time: «в 18:30», «18:30» (colon only — «12.10» is a date); not «12:30:45».
  take(rx(`${NOT_RANGE}(?:в\\s+|${NOT_SCORE})([01]?\\d|2[0-3]):([0-5]\\d)(?![:.]\\d)${NOT_RANGE_AFTER}`), (m) => {
    time = `${m[1].padStart(2, '0')}:${m[2]}`;
  });

  const relative = [
    { re: 'послезавтра', key: () => addDaysIso(today, 2) },
    { re: 'завтра', key: () => addDaysIso(today, 1) },
    { re: 'сегодня', key: () => today },
    { re: 'через неделю', key: () => addDaysIso(today, 7) },
  ];
  for (const r of relative) {
    if (take(rx(r.re), () => {
      dueKey = r.key();
    })) break;
  }

  if (!dueKey) {
    take(rx('через\\s+(\\d{1,3})\\s+(?:день|дня|дней)'), (m) => {
      dueKey = addDaysIso(today, Number(m[1]));
    });
  }

  if (!dueKey) {
    for (const w of WEEKDAYS) {
      if (take(rx(`(?:(?:в|во)\\s+)?(?:${w.re})`), () => {
        dueKey = nextWeekday(today, w.day);
      })) break;
    }
  }

  if (!dueKey) {
    // «12.10», «12.10.2026», «до 12.10»; a past day without a year means next year.
    // A two-digit month and no dotted neighbours keep «1.5 л», «3.4», «192.168.1.1» out.
    const date = '(\\d{1,2})\\.(\\d{2})(?:\\.(\\d{4}))?';
    take(rx(`${NOT_RANGE}(?<!\\d[.,])(?:до\\s+|к\\s+)?${date}(?![.,]\\d)${NOT_RANGE_AFTER}`), (m) => {
      const d = Number(m[1]);
      const mo = Number(m[2]);
      const y0 = m[3] ? Number(m[3]) : now.getFullYear();
      let key = validDateKey(y0, mo, d);
      if (key && !m[3] && key < today) key = validDateKey(y0 + 1, mo, d);
      if (!key) return false;
      dueKey = key;
      return true;
    });
  }

  const title = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim().replace(/[,;:\s-]+$/, '');
  if (!title) return { title: original, dueKey: null, time: null, recurrence: null };

  // A time or repeat rule without a day means «starting today».
  if (!dueKey && (time || recurrence)) dueKey = today;
  return { title, dueKey, time, recurrence };
}

module.exports = { parseQuickAdd };
