'use strict';

/**
 * Quick-add parsing: «Позвонить маме завтра в 18:30», «Отчёт в пятницу», «Зарядка каждый день 7:00».
 * Recognised phrases are removed from the title and returned as date / time / repeat.
 */

const { todayIso, addDaysIso } = require('./dates');

// Cyrillic-aware word boundaries (\b only knows ASCII).
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

/**
 * JS getDay(): 0 = Sunday. `pl` is the «по …» form («по средам»).
 * `abbr` is «пт», «Пт» or «ПТ», never next to a hyphen («ср-во»). `noCaps`: «ВС», «СБ»
 * are acronyms («в ВС», «с СБ»); `noNumber`: «60 Вт» is watts.
 * `prep`: only with «в» — a bare «среда» is usually the noun («среда разработки»).
 */
const WEEKDAYS = [
  { day: 1, re: 'понедельник', abbr: 'пн', pl: 'понедельникам' },
  { day: 2, re: 'вторник', abbr: 'вт', pl: 'вторникам', noNumber: true },
  { day: 3, re: 'среду|среда', abbr: 'ср', pl: 'средам', prep: true },
  { day: 4, re: 'четверг', abbr: 'чт', pl: 'четвергам' },
  { day: 5, re: 'пятницу|пятница', abbr: 'пт', pl: 'пятницам' },
  { day: 6, re: 'субботу|суббота', abbr: 'сб', pl: 'субботам', noCaps: true },
  { day: 0, re: 'воскресенье', abbr: 'вс', pl: 'воскресеньям', noCaps: true },
];

const REPEATS = [
  { rule: 'weekdays', re: 'по будням|каждый будний день|в будни|пн\\s*[-–—]\\s*пт' },
  { rule: 'daily', re: 'каждый день|ежедневно' },
  { rule: 'weekly', re: 'каждую неделю|еженедельно' },
];

/**
 * «2.5%», «1.10 кг»: a number with a unit, not a date. A capital after the letters means an
 * abbreviated name: «15.11 м. Пушкинская», «30.10 л. Толстого» are dates.
 */
const UNIT = `\\s*(?:[%₽]|(?:л|мл|кг|км|м|см|мм|шт|руб)${E}(?!\\.?\\s*\\p{Lu}))`;

function rx(body) {
  return new RegExp(`${B}(?:${body})${E}`, 'iu');
}

/** «(во) пт / Пт / ПТ»: case-sensitive, so «пТ» and the `noCaps` acronyms stay text. */
function abbrRx(w) {
  const forms = [w.abbr, w.abbr[0].toUpperCase() + w.abbr.slice(1)];
  if (!w.noCaps) forms.push(w.abbr.toUpperCase());
  const before = w.noNumber ? '(?<![\\p{L}\\p{N}-]|\\d\\s+)' : '(?<![\\p{L}\\p{N}-])';
  return new RegExp(`${before}(?:[вВ]о?\\s+)?(?:${forms.join('|')})(?![\\p{L}\\p{N}-])`, 'u');
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

  const take = (re, onMatch) => {
    const m = text.match(re);
    if (!m) return false;
    if (onMatch(m) === false) return false;
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
    return true;
  };

  for (const r of REPEATS) {
    if (take(rx(r.re), () => {
      recurrence = /** @type {any} */ (r.rule);
    })) break;
  }

  // «каждый вторник», «каждую пятницу», «по средам»: weekly, first time on that day.
  if (!recurrence || recurrence === 'weekly') {
    for (const w of WEEKDAYS) {
      if (take(rx(`(?:каждый|каждую|каждое)\\s+(?:${w.re}|${w.abbr})|по\\s+${w.pl}`), () => {
        recurrence = 'weekly';
        dueKey = nextWeekday(today, w.day);
      })) break;
    }
  }

  // Time: «в 18:30», «18:30» (colon only — «12.10» is a date).
  take(rx('(?:в\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)'), (m) => {
    time = `${m[1].padStart(2, '0')}:${m[2]}`;
  });

  const relative = [
    { re: 'послезавтра', key: () => addDaysIso(today, 2) },
    { re: 'завтра', key: () => addDaysIso(today, 1) },
    { re: 'сегодня', key: () => today },
    { re: 'через неделю', key: () => addDaysIso(today, 7) },
  ];
  if (!dueKey) {
    for (const r of relative) {
      if (take(rx(r.re), () => {
        dueKey = r.key();
      })) break;
    }
  }

  if (!dueKey) {
    take(rx('через\\s+(\\d{1,3})\\s+(?:день|дня|дней)'), (m) => {
      dueKey = addDaysIso(today, Number(m[1]));
    });
  }

  if (!dueKey) {
    for (const w of WEEKDAYS) {
      const hit = () => {
        dueKey = nextWeekday(today, w.day);
      };
      const full = w.prep ? `(?:в|во)\\s+(?:${w.re})` : `(?:(?:в|во)\\s+)?(?:${w.re})`;
      if (take(rx(full), hit) || take(abbrRx(w), hit)) break;
    }
  }

  if (!dueKey) {
    // «12.10», «12.10.2026», «12.10.26», «в / до / к / на 12.10»; a past day without a year
    // means next year. A one-digit month needs a year: «2.5%», «1.5 л», «до 2.5» are numbers.
    // Not rx(): without the «i» flag UNIT can tell a capital («м. Пушкинская») from «м».
    const date = '(\\d{1,2})\\.(?:(\\d{1,2})\\.(\\d{4}|\\d{2})|(\\d{2}))(?!\\.\\d)';
    const prep = '(?:[дД]о|[кК]|[вВ]|[нН]а)\\s+';
    take(new RegExp(`${B}(?:${prep})?${date}(?!${UNIT})${E}`, 'u'), (m) => {
      const d = Number(m[1]);
      const mo = Number(m[2] || m[4]);
      const y0 = m[3] ? Number(m[3]) + (m[3].length === 2 ? 2000 : 0) : now.getFullYear();
      let key = validDateKey(y0, mo, d);
      if (key && !m[3] && key < today) key = validDateKey(y0 + 1, mo, d);
      if (!key) return false;
      dueKey = key;
      return true;
    });
  }

  // «Пт: сдать отчёт» → «сдать отчёт»: no separator left at either end.
  const title = text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/^[,;:]\s*/, '')
    .replace(/[,;:\s-]+$/, '');
  if (!title) return { title: original, dueKey: null, time: null, recurrence: null };

  // A time or repeat rule without a day means «starting today» (Monday for «по будням» at a weekend).
  if (!dueKey && (time || recurrence)) {
    const weekend = weekdayOf(today) === 0 || weekdayOf(today) === 6;
    dueKey = recurrence === 'weekdays' && weekend ? nextWeekday(today, 1) : today;
  }
  return { title, dueKey, time, recurrence };
}

module.exports = { parseQuickAdd };
