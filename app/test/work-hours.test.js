'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const wh = require('../lib/work-hours');

const at = (h, m, day = 15) => new Date(2026, 9, day, h, m, 0, 0);

test('domains: URLs, www, ports, case and trailing dots become a bare host name', () => {
  const cases = {
    'youtube.com': 'youtube.com',
    '  YouTube.COM  ': 'youtube.com',
    'https://www.youtube.com/watch?v=1': 'youtube.com',
    'http://vk.com': 'vk.com',
    '//twitch.tv/': 'twitch.tv',
    'www.vk.ru': 'vk.ru',
    'ru.pinterest.com': 'ru.pinterest.com',
    'm.youtube.com:443': 'm.youtube.com',
    'https://user@web.telegram.org/k/': 'web.telegram.org',
    'mail.yandex.ru.': 'mail.yandex.ru',
    'site.ru#top': 'site.ru',
    'site.ru\\path': 'site.ru',
    'a-b.example.org': 'a-b.example.org',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(wh.normalizeDomain(input), want, input);
});

test('domains: Cyrillic (IDN) names are stored in their xn-- form', () => {
  assert.equal(wh.normalizeDomain('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(wh.normalizeDomain('https://www.пример.рф/'), 'xn--e1afmkfd.xn--p1ai');
});

test('domains: the reason a value is refused', () => {
  const cases = {
    '': 'empty',
    '   ': 'empty',
    localhostlike: 'invalid',
    'not a domain.com': 'invalid',
    '-bad.com': 'invalid',
    'bad-.com': 'invalid',
    'under_score.com': 'invalid',
    'a..com': 'invalid',
    '*.youtube.com': 'wildcard',
    'you*tube.com': 'wildcard',
    '127.0.0.1': 'ip',
    'http://10.0.0.1:8080/': 'ip',
    '::1': 'ip',
    '[2001:db8::1]:80': 'ip',
    '1.2.3.456': 'ip',
    'example.123': 'ip',
    'localhost': 'invalid',
    'printer.local': 'protected',
    'accounts.google.com': 'protected',
    'tasks.googleapis.com': 'protected',
    'google.com': 'protected',
    'update.microsoft.com': 'protected',
    'download.windowsupdate.com': 'protected',
    'objects.githubusercontent.com': 'protected',
    'ocsp.digicert.com': 'protected',
    'r3.o.lencr.org': 'protected',
    'ocsp.sectigo.com': 'protected',
    'ocsp.globalsign.com': 'protected',
    'letsencrypt.org': 'protected',
    [`${'a'.repeat(64)}.com`]: 'too-long',
    [`${'abcdefghi.'.repeat(26)}com`]: 'too-long',
  };
  for (const [input, reason] of Object.entries(cases)) {
    assert.deepEqual(wh.checkDomain(input), { reason }, input);
  }
  assert.deepEqual(wh.checkDomain(42), { reason: 'invalid' });
  assert.deepEqual(wh.checkDomain(null), { reason: 'invalid' });
  // Lookalikes of protected names are ordinary sites.
  assert.equal(wh.normalizeDomain('notgoogle.com'), 'notgoogle.com');
  assert.equal(wh.normalizeDomain('google.com.evil.net'), 'google.com.evil.net');
  // Just inside the limits.
  assert.equal(wh.normalizeDomain(`${'a'.repeat(63)}.com`), `${'a'.repeat(63)}.com`);
});

test('site list: order kept, duplicates and bad entries reported, blank lines skipped', () => {
  const r = wh.normalizeSitesList('youtube.com\r\n\r\nhttps://www.YouTube.com/\nvk.com, twitch.tv;*.x.com\ngoogle.com\n127.0.0.1\n');
  assert.deepEqual(r.sites, ['youtube.com', 'vk.com', 'twitch.tv']);
  assert.deepEqual(r.dropped, [
    { input: 'https://www.YouTube.com/', reason: 'duplicate' },
    { input: '*.x.com', reason: 'wildcard' },
    { input: 'google.com', reason: 'protected' },
    { input: '127.0.0.1', reason: 'ip' },
  ]);
  assert.equal(r.droppedCount, 4);
});

test('site list: array, JSON string (an early stored form) and junk', () => {
  assert.deepEqual(wh.normalizeSitesList(['vk.com', 'VK.com', 42, null]).sites, ['vk.com']);
  assert.deepEqual(wh.normalizeSitesList(['vk.com', 42]).dropped, [{ input: '42', reason: 'invalid' }]);
  assert.deepEqual(wh.normalizeSitesList('["vk.com","twitch.tv"]').sites, ['vk.com', 'twitch.tv']);
  assert.deepEqual(wh.normalizeSitesList('[not json').sites, []);
  assert.deepEqual(wh.normalizeSitesList(undefined), { sites: [], dropped: [], droppedCount: 0 });
  assert.deepEqual(wh.normalizeSitesList({ length: 3 }).sites, []);
  assert.deepEqual(wh.normalizeSitesList(wh.DEFAULT_WORK_HOURS_SITES.slice()).sites, wh.DEFAULT_WORK_HOURS_SITES);
});

test('site list: at most 200 sites; the rest is reported as over the limit', () => {
  const many = Array.from({ length: 205 }, (_, i) => `site${i}.com`);
  const r = wh.normalizeSitesList(many);
  assert.equal(r.sites.length, wh.MAX_WORK_HOURS_SITES);
  assert.equal(r.sites[199], 'site199.com');
  assert.equal(r.droppedCount, 5);
  assert.ok(r.dropped.every((d) => d.reason === 'limit'));
  // A huge paste is cut, not parsed whole; the reported list stays short.
  const junk = wh.normalizeSitesList(Array.from({ length: 5000 }, () => 'x').join('\n'));
  assert.equal(junk.droppedCount, 2000);
  assert.equal(junk.dropped.length, 50);
});

test('time: HH:MM with fallbacks', () => {
  assert.equal(wh.normalizeTime('9:05', '09:00'), '09:05');
  assert.equal(wh.normalizeTime('09:00:00', null), '09:00');
  assert.equal(wh.normalizeTime(' 23:59 ', null), '23:59');
  for (const bad of ['24:00', '12:60', '1200', '', 'aa:bb', '12:5', null, 7]) {
    assert.equal(wh.normalizeTime(bad, '18:00'), '18:00', String(bad));
  }
  assert.equal(wh.normalizeTime('nope', null), null);
});

test('window: [start, end) during the day, past midnight, and the whole day', () => {
  assert.equal(wh.isWithinWorkHours(at(8, 59), '09:00', '18:00'), false);
  assert.equal(wh.isWithinWorkHours(at(9, 0), '09:00', '18:00'), true);
  assert.equal(wh.isWithinWorkHours(at(17, 59), '09:00', '18:00'), true);
  assert.equal(wh.isWithinWorkHours(at(18, 0), '09:00', '18:00'), false);
  // 22:00–06:00
  assert.equal(wh.isWithinWorkHours(at(23, 30), '22:00', '06:00'), true);
  assert.equal(wh.isWithinWorkHours(at(2, 0), '22:00', '06:00'), true);
  assert.equal(wh.isWithinWorkHours(at(6, 0), '22:00', '06:00'), false);
  assert.equal(wh.isWithinWorkHours(at(12, 0), '22:00', '06:00'), false);
  // start === end: all day
  assert.equal(wh.isWithinWorkHours(at(3, 0), '10:00', '10:00'), true);
  // bad values fall back to 09:00–18:00
  assert.equal(wh.isWithinWorkHours(at(10, 0), 'x', 'y'), true);
  assert.equal(wh.isWithinWorkHours(at(19, 0), 'x', 'y'), false);
});

test('next boundary: the closest start or end strictly after now', () => {
  assert.deepEqual(wh.nextWorkHoursBoundary(at(8, 0), '09:00', '18:00'), at(9, 0));
  assert.deepEqual(wh.nextWorkHoursBoundary(at(9, 0), '09:00', '18:00'), at(18, 0), 'strictly after');
  assert.deepEqual(wh.nextWorkHoursBoundary(at(12, 30), '09:00', '18:00'), at(18, 0));
  assert.deepEqual(wh.nextWorkHoursBoundary(at(18, 0), '09:00', '18:00'), at(9, 0, 16));
  assert.deepEqual(wh.nextWorkHoursBoundary(at(23, 0), '22:00', '06:00'), at(6, 0, 16));
  assert.deepEqual(wh.nextWorkHoursBoundary(at(5, 0), '22:00', '06:00'), at(6, 0));
  assert.equal(wh.nextWorkHoursBoundary(at(5, 0), '07:00', '07:00'), null, 'whole day never changes');
  // End of month rolls over.
  assert.deepEqual(wh.nextWorkHoursBoundary(new Date(2026, 9, 31, 20, 0), '09:00', '18:00'), new Date(2026, 10, 1, 9, 0));
});

test('desired block: enabled, inside the window and a non-empty list', () => {
  const s = { workHoursEnabled: true, workHoursStart: '09:00', workHoursEnd: '18:00', workHoursSites: ['vk.com', 'google.com'] };
  assert.deepEqual(wh.desiredBlockedSites(s, at(10, 0)), ['vk.com']);
  assert.equal(wh.desiredBlockedSites(s, at(19, 0)), null);
  assert.equal(wh.desiredBlockedSites({ ...s, workHoursEnabled: false }, at(10, 0)), null);
  assert.equal(wh.desiredBlockedSites({ ...s, workHoursEnabled: 'true' }, at(10, 0)), null);
  assert.equal(wh.desiredBlockedSites({ ...s, workHoursSites: [] }, at(10, 0)), null);
  assert.equal(wh.desiredBlockedSites(null, at(10, 0)), null);
});
