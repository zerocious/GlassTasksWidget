'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const hb = require('../lib/hosts-block');

const { BEGIN_MARKER: BEGIN, END_MARKER: END } = hb;

const WINDOWS_HOSTS = [
  '# Copyright (c) 1993-2009 Microsoft Corp.',
  '#',
  '# localhost name resolution is handled within DNS itself.',
  '#\t127.0.0.1       localhost',
  '#\t::1             localhost',
  '192.168.1.10 nas.home   # my NAS',
  '',
].join('\r\n');

test('block: four lines per site (IPv4 and IPv6, bare and www), in the requested line ending', () => {
  assert.equal(
    hb.buildBlock(['vk.com'], '\n'),
    [BEGIN, '127.0.0.1 vk.com', '127.0.0.1 www.vk.com', '::1 vk.com', '::1 www.vk.com', END].join('\n')
  );
  assert.equal(hb.buildBlock([], '\r\n'), `${BEGIN}\r\n${END}`);
});

test('block: anything that is not a normalized domain is refused (no injection into hosts)', () => {
  for (const bad of ['vk.com\r\n1.2.3.4 google.com', 'www.vk.com', 'VK.com', 'google.com', '1.2.3.4', '', 42]) {
    assert.throws(() => hb.buildBlock([bad]), TypeError, String(bad));
  }
  assert.throws(() => hb.buildBlock(['vk.com'], '\r'), TypeError);
});

test('apply: appended to the end with CRLF kept; user lines untouched; idempotent', () => {
  const r = hb.applyBlock(WINDOWS_HOSTS, ['vk.com', 'twitch.tv']);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith(WINDOWS_HOSTS), 'everything before the block is byte-identical');
  assert.ok(!/[^\r]\n/.test(r.text), 'only CRLF line endings');
  assert.ok(r.text.endsWith(`${END}\r\n`));
  const again = hb.applyBlock(r.text, ['vk.com', 'twitch.tv']);
  assert.deepEqual(again, { ok: true, text: r.text, changed: false });
  assert.deepEqual(hb.currentBlockSites(r.text), { ok: true, present: true, sites: ['vk.com', 'twitch.tv'] });
});

test('apply: LF files stay LF; a file without a final line break gets one before the block', () => {
  const lf = '127.0.0.1 a.test\n# comment';
  const r = hb.applyBlock(lf, ['vk.com']);
  assert.equal(r.text, `127.0.0.1 a.test\n# comment\n${hb.buildBlock(['vk.com'], '\n')}\n`);
  assert.equal(hb.applyBlock('', ['vk.com']).text, `${hb.buildBlock(['vk.com'], '\r\n')}\r\n`, 'empty file: CRLF');
});

test('apply: a changed list replaces the block in place; lines after it stay where they are', () => {
  const first = hb.applyBlock(WINDOWS_HOSTS, ['vk.com']).text;
  const withTail = `${first}10.0.0.5 printer.home\r\n`;
  const r = hb.applyBlock(withTail, ['vk.com', 'youtube.com']);
  assert.equal(r.changed, true);
  assert.equal(r.text, `${WINDOWS_HOSTS}${hb.buildBlock(['vk.com', 'youtube.com'])}\r\n10.0.0.5 printer.home\r\n`);
  assert.equal(hb.applyBlock(r.text, ['vk.com', 'youtube.com']).changed, false);
});

test('clear: removes every block and stray END markers, nothing else', () => {
  const block = hb.buildBlock(['vk.com']);
  const text = `a.example 1\r\n${block}\r\nkeep me\r\n${block}\r\n${END}\r\nlast line`;
  const r = hb.stripBlocks(text);
  assert.deepEqual(r, { ok: true, text: 'a.example 1\r\nkeep me\r\nlast line', changed: true });
  assert.deepEqual(hb.applyBlock(r.text, null), { ok: true, text: r.text, changed: false });
  assert.deepEqual(hb.applyBlock(WINDOWS_HOSTS, []), { ok: true, text: WINDOWS_HOSTS, changed: false }, '[] = no block');
  // Apply, then clear: the original text comes back.
  const applied = hb.applyBlock(WINDOWS_HOSTS, ['vk.com']).text;
  assert.equal(hb.applyBlock(applied, null).text, WINDOWS_HOSTS);
});

test('apply with several blocks: the first is replaced, the rest removed', () => {
  const b = hb.buildBlock(['vk.com'], '\n');
  const text = `x\n${b}\ny\n${b}\nz\n`;
  const r = hb.applyBlock(text, ['twitch.tv']);
  assert.equal(r.text, `x\n${hb.buildBlock(['twitch.tv'], '\n')}\ny\nz\n`);
});

test('a BEGIN without END is an error, never «delete to the end of the file»', () => {
  const broken = `keep\r\n${BEGIN}\r\n127.0.0.1 vk.com\r\nuser line after\r\n`;
  for (const sites of [null, ['vk.com']]) {
    const r = hb.applyBlock(broken, sites);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unterminated');
    assert.equal(r.line, 2);
    assert.equal(r.text, broken, 'text handed back untouched');
    assert.equal(r.changed, false);
  }
  assert.equal(hb.currentBlockSites(broken).ok, false);
  const nested = `${BEGIN}\n${BEGIN}\n${END}\n`;
  assert.equal(hb.applyBlock(nested, null).error, 'nested');
  assert.match(hb.describeHostsError('unterminated'), /вручную/);
});

test('markers match whole (trimmed) lines only', () => {
  const text = `# see ${BEGIN} in docs\n  ${BEGIN}  \n::1 vk.com\n\t${END}\n`;
  assert.deepEqual(hb.currentBlockSites(text), { ok: true, present: true, sites: ['vk.com'] });
  assert.equal(hb.applyBlock(text, null).text, `# see ${BEGIN} in docs\n`);
});

test('current sites: read back from blocks written by the old work-hours build too', () => {
  // The first work-hours build wrote no ::1 lines and used os.EOL (CRLF) in an LF file.
  const old = `127.0.0.1 localhost\n${BEGIN}\r\n127.0.0.1 vk.com\r\n127.0.0.1 www.vk.com\r\n${END}\r\n`;
  assert.deepEqual(hb.currentBlockSites(old), { ok: true, present: true, sites: ['vk.com'] });
  const r = hb.applyBlock(old, ['vk.com']);
  assert.equal(r.changed, true, 'rewritten once to add the IPv6 lines');
  assert.equal(hb.applyBlock(r.text, ['vk.com']).changed, false);
  assert.deepEqual(hb.currentBlockSites(WINDOWS_HOSTS), { ok: true, present: false, sites: [] });
  // www.<site> alone (no bare entry) is reported as is; comments inside the block are ignored.
  const odd = `${BEGIN}\n127.0.0.1 www.only.com # note\n# 127.0.0.1 hidden.com\n${END}\n`;
  assert.deepEqual(hb.currentBlockSites(odd).sites, ['www.only.com']);
});

test('UTF-16 files are refused; latin1 bytes outside the block round-trip', () => {
  const utf16 = `ÿþ#\u0000 \u0000`;
  assert.equal(hb.applyBlock(utf16, ['vk.com']).error, 'encoding');
  assert.equal(hb.currentBlockSites(utf16).error, 'encoding');
  const cp1251 = Buffer.from([0x23, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]).toString('latin1');
  const r = hb.applyBlock(cp1251, ['vk.com']);
  const back = hb.applyBlock(r.text, null).text;
  assert.deepEqual(Buffer.from(back, 'latin1'), Buffer.from(cp1251, 'latin1'));
  assert.equal(hb.applyBlock(null, null).ok, false);
});

test('line ending detection', () => {
  assert.equal(hb.detectEol('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(hb.detectEol('a\nb\nc\r\n'), '\n');
  assert.equal(hb.detectEol('no break'), '\r\n');
});
