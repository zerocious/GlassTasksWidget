'use strict';

/**
 * Work-hours site blocking: the schedule and the site list, as pure functions.
 *
 * Used by settings-store (load / save validation), main.js (settings patches), the scheduler
 * (electron/work-hours.js) and the elevated hosts helper (electron/hosts-helper.js), which runs
 * every payload through normalizeSitesList again instead of trusting the caller.
 */

const { domainToASCII } = require('url');

const DEFAULT_WORK_HOURS_START = '09:00';
const DEFAULT_WORK_HOURS_END = '18:00';

/** At most this many sites are blocked (each one is four lines in hosts). */
const MAX_WORK_HOURS_SITES = 200;
/** Input bounds: a pasted wall of text is cut here instead of being parsed whole. */
const MAX_INPUT_ITEMS = 2000;
const MAX_INPUT_CHARS = 64 * 1024;
/** Dropped entries reported back to the UI (the rest is only counted). */
const MAX_DROPPED_REPORTED = 50;

/** Sensible default / placeholder blocklist (normalized bare domains). */
const DEFAULT_WORK_HOURS_SITES = Object.freeze([
  'vk.com',
  'vk.ru',
  'youtube.com',
  'ru.pinterest.com',
  'twitch.tv',
  'mail.yandex.ru',
  'web.telegram.org',
  'music.yandex.ru',
]);

/**
 * Domains (and every subdomain) never written into hosts: the widget's own Google sign-in and
 * API, Windows and Microsoft services, Windows Update, the update feed of this app, and the
 * certificate authorities whose OCSP / CRL servers every HTTPS connection may need.
 */
const PROTECTED_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'microsoft.com',
  'windows.com',
  'windowsupdate.com',
  'live.com',
  'office.com',
  'office.net',
  'msn.com',
  'msocsp.com',
  'github.com',
  'githubusercontent.com',
  'electronjs.org',
  'digicert.com',
  'letsencrypt.org',
  'lencr.org',
  'sectigo.com',
  'globalsign.com',
  'pki.goog',
]);

/**
 * Why an entry of the list was not accepted (codes; the widget shows them in Russian).
 * @typedef {'invalid' | 'wildcard' | 'ip' | 'protected' | 'too-long' | 'duplicate' | 'limit'} DropReason
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * @param {string} domain lower-case ASCII
 * @returns {boolean}
 */
function isProtectedDomain(domain) {
  const d = String(domain).toLowerCase();
  return PROTECTED_SUFFIXES.some((suf) => d === suf || d.endsWith(`.${suf}`));
}

/**
 * Turn what a user pastes (a URL, «www.site.ru», «site.ru:443», «пример.рф») into a bare
 * host name, or say why that is impossible.
 * @param {unknown} raw
 * @returns {{ domain: string } | { reason: DropReason | 'empty' }}
 */
function checkDomain(raw) {
  if (typeof raw !== 'string') return { reason: 'invalid' };
  let s = raw.trim().toLowerCase();
  if (!s) return { reason: 'empty' };
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^\/\//, '');
  s = s.split(/[/?#\\]/)[0];
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  if (/^\[.*\]/.test(s) || s.split(':').length > 2) return { reason: 'ip' }; // IPv6 literal
  s = s.replace(/:\d*$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.includes('*')) return { reason: 'wildcard' };
  if (!s) return { reason: 'invalid' };
  if (IPV4_RE.test(s)) return { reason: 'ip' };
  // Cyrillic and other IDN domains go to hosts in their xn-- form, like the browser asks for them.
  if (/[\u0080-￿]/.test(s)) {
    const ascii = domainToASCII(s);
    if (!ascii) return { reason: 'invalid' };
    s = ascii;
  }
  // Strip every leading «www.»: the result must be a fixed point (normalizeDomain(x) === x),
  // because buildBlock re-checks each site and rejects anything else.
  while (s.startsWith('www.')) s = s.slice(4);
  if (s.length > 253) return { reason: 'too-long' };
  const labels = s.split('.');
  if (labels.length < 2) return { reason: 'invalid' };
  for (const label of labels) {
    if (label.length > 63) return { reason: 'too-long' };
    if (!LABEL_RE.test(label)) return { reason: 'invalid' };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return { reason: 'ip' };
  if (isProtectedDomain(s)) return { reason: 'protected' };
  return { domain: s };
}

/**
 * @param {unknown} raw
 * @returns {string | null} bare host name, or null when it can't (or must not) be blocked
 */
function normalizeDomain(raw) {
  const r = checkDomain(raw);
  return 'domain' in r ? r.domain : null;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function listItems(value) {
  if (Array.isArray(value)) return value.slice(0, MAX_INPUT_ITEMS);
  if (typeof value !== 'string') return [];
  const text = value.slice(0, MAX_INPUT_CHARS);
  const trimmed = text.trim();
  // An early version of the feature stored the list as a JSON string.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_INPUT_ITEMS);
    } catch {
      /* not JSON: one entry per line below */
    }
  }
  // One entry per line: a pasted URL may contain commas or semicolons in its query.
  return text.split(/\r?\n/).slice(0, MAX_INPUT_ITEMS);
}

/**
 * Validate a site list: an array of strings, the textarea text (one per line)
 * or a JSON array string. Valid, unique, non-protected domains are kept in order, up to
 * MAX_WORK_HOURS_SITES; everything else is reported in `dropped` (blank lines are just skipped).
 * @param {unknown} value
 * @returns {{ sites: string[], dropped: { input: string, reason: DropReason }[], droppedCount: number }}
 */
function normalizeSitesList(value) {
  /** @type {string[]} */
  const sites = [];
  /** @type {{ input: string, reason: DropReason }[]} */
  const dropped = [];
  let droppedCount = 0;
  const seen = new Set();
  const drop = (item, reason) => {
    droppedCount += 1;
    if (dropped.length < MAX_DROPPED_REPORTED) {
      dropped.push({ input: (typeof item === 'string' ? item.trim() : String(item)).slice(0, 80), reason });
    }
  };
  for (const item of listItems(value)) {
    const r = checkDomain(item);
    if ('reason' in r) {
      if (r.reason !== 'empty') drop(item, r.reason);
      continue;
    }
    if (seen.has(r.domain)) {
      drop(item, 'duplicate');
      continue;
    }
    if (sites.length >= MAX_WORK_HOURS_SITES) {
      drop(item, 'limit');
      continue;
    }
    seen.add(r.domain);
    sites.push(r.domain);
  }
  return { sites, dropped, droppedCount };
}

/**
 * @param {unknown} value «9:00», «09:00», «09:00:00»
 * @param {string | null} fallback
 * @returns {string | null} HH:MM
 */
function normalizeTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** @param {string} hhmm */
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Local wall-clock window [start, end). start > end runs past midnight (22:00–06:00);
 * start === end means the whole day.
 * @param {Date} now
 * @param {string} start HH:MM
 * @param {string} end HH:MM
 * @returns {boolean}
 */
function isWithinWorkHours(now, start, end) {
  const s = timeToMinutes(normalizeTime(start, DEFAULT_WORK_HOURS_START));
  const e = timeToMinutes(normalizeTime(end, DEFAULT_WORK_HOURS_END));
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s === e) return true;
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

/**
 * The next moment the window opens or closes, strictly after `now`, so the scheduler can arm
 * one exact timer. Null for a whole-day window (start === end): nothing ever changes.
 * @param {Date} now
 * @param {string} start HH:MM
 * @param {string} end HH:MM
 * @returns {Date | null}
 */
function nextWorkHoursBoundary(now, start, end) {
  const s = normalizeTime(start, DEFAULT_WORK_HOURS_START);
  const e = normalizeTime(end, DEFAULT_WORK_HOURS_END);
  if (s === e) return null;
  // Walk real minutes and ask isWithinWorkHours itself, so the answer always agrees with it,
  // also on DST days (a skipped 02:30 opens at 03:00; a repeated hour does not fire twice).
  const inside = isWithinWorkHours(now, s, e);
  const t = new Date(now.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 49 * 60; i += 1) {
    t.setTime(t.getTime() + 60 * 1000);
    if (isWithinWorkHours(t, s, e) !== inside) return new Date(t.getTime());
  }
  return null;
}

/**
 * What hosts should contain right now: the site list, or null for «no block».
 * @param {{ workHoursEnabled?: boolean, workHoursStart?: string, workHoursEnd?: string, workHoursSites?: unknown }} settings
 * @param {Date} now
 * @returns {string[] | null}
 */
function desiredBlockedSites(settings, now) {
  if (!settings || settings.workHoursEnabled !== true) return null;
  const { sites } = normalizeSitesList(settings.workHoursSites);
  if (!sites.length) return null;
  return isWithinWorkHours(now, settings.workHoursStart, settings.workHoursEnd) ? sites : null;
}

module.exports = {
  DEFAULT_WORK_HOURS_START,
  DEFAULT_WORK_HOURS_END,
  DEFAULT_WORK_HOURS_SITES,
  MAX_WORK_HOURS_SITES,
  PROTECTED_SUFFIXES,
  isProtectedDomain,
  checkDomain,
  normalizeDomain,
  normalizeSitesList,
  normalizeTime,
  isWithinWorkHours,
  nextWorkHoursBoundary,
  desiredBlockedSites,
};
