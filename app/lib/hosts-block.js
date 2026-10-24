'use strict';

/**
 * The widget's block in the Windows hosts file, as pure text operations.
 *
 *   # BEGIN GlassTasksWidget work-hours
 *   127.0.0.1 youtube.com
 *   127.0.0.1 www.youtube.com
 *   ::1 youtube.com
 *   ::1 www.youtube.com
 *   # END GlassTasksWidget work-hours
 *
 * Only lines between (and including) the markers are ever touched; everything else keeps its
 * bytes. Callers read and write hosts as 'latin1', so any byte round-trips unchanged. The block
 * uses the file's own line ending. A BEGIN without its END is an error, never «delete to the end
 * of the file». applyBlock(text, sites) is idempotent: applying the same list twice gives the
 * same text, so the scheduler can compare before asking Windows for admin rights.
 */

const { normalizeDomain } = require('./work-hours');

const BEGIN_MARKER = '# BEGIN GlassTasksWidget work-hours';
const END_MARKER = '# END GlassTasksWidget work-hours';

/**
 * @typedef {'unterminated' | 'nested' | 'encoding' | 'invalid'} HostsError
 * @typedef {{ text: string, eol: string }} Line
 */

/**
 * @param {string} text
 * @returns {Line[]} the last line has eol '' when the file does not end with a line break
 */
function splitLines(text) {
  /** @type {Line[]} */
  const lines = [];
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('\n', i);
    if (j < 0) {
      lines.push({ text: text.slice(i), eol: '' });
      break;
    }
    const crlf = j > i && text[j - 1] === '\r';
    lines.push({ text: text.slice(i, crlf ? j - 1 : j), eol: crlf ? '\r\n' : '\n' });
    i = j + 1;
  }
  return lines;
}

/** @param {Line[]} lines */
function joinLines(lines) {
  return lines.map((l) => l.text + l.eol).join('');
}

/**
 * The file's line ending: whichever is more common; CRLF (the Windows default) when there is none.
 * @param {string} text
 * @returns {'\r\n' | '\n'}
 */
function detectEol(text) {
  const all = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  if (!all) return '\r\n';
  return crlf >= all - crlf ? '\r\n' : '\n';
}

/**
 * UTF-16 (BOM or NUL bytes when read as latin1 / utf8): appending ASCII lines would corrupt it.
 * @param {string} text
 */
function isUnsupportedEncoding(text) {
  return /^(?:ÿþ|þÿ)/.test(text) || text.includes('\u0000');
}

/**
 * @param {Line[]} lines
 * @returns {{ ok: true, blocks: { start: number, end: number }[], strays: number[] } | { ok: false, error: HostsError, line: number }}
 */
function findBlocks(lines) {
  /** @type {{ start: number, end: number }[]} */
  const blocks = [];
  /** @type {number[]} */
  const strays = [];
  let open = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].text.trim();
    if (t === BEGIN_MARKER) {
      if (open >= 0) return { ok: false, error: 'nested', line: i + 1 };
      open = i;
    } else if (t === END_MARKER) {
      if (open < 0) strays.push(i); // our marker without a block: dropped with the blocks
      else {
        blocks.push({ start: open, end: i });
        open = -1;
      }
    }
  }
  if (open >= 0) return { ok: false, error: 'unterminated', line: open + 1 };
  return { ok: true, blocks, strays };
}

/**
 * @param {string[]} sites normalized domains (anything else throws: nothing unchecked reaches hosts)
 * @param {string} [eol]
 * @returns {string} the block without a trailing line break
 */
function buildBlock(sites, eol = '\r\n') {
  if (eol !== '\r\n' && eol !== '\n') throw new TypeError('eol must be CRLF or LF');
  const lines = [BEGIN_MARKER];
  for (const d of sites) {
    if (typeof d !== 'string' || normalizeDomain(d) !== d) {
      throw new TypeError(`not a normalized domain: ${String(d).slice(0, 80)}`);
    }
    lines.push(`127.0.0.1 ${d}`, `127.0.0.1 www.${d}`);
    // IPv6 too: a browser that prefers AAAA records would otherwise get around the block.
    lines.push(`::1 ${d}`, `::1 www.${d}`);
  }
  lines.push(END_MARKER);
  return lines.join(eol);
}

/**
 * Put our block for `sites` into hosts text (null / [] = remove it). An existing block is
 * replaced where it stands; extra blocks and stray END markers are removed; without one, the
 * block goes to the end of the file.
 * @param {string} text
 * @param {string[] | null} sites
 * @returns {{ ok: true, text: string, changed: boolean } | { ok: false, text: string, changed: false, error: HostsError, line?: number }}
 */
function applyBlock(text, sites) {
  if (typeof text !== 'string') return { ok: false, text: '', changed: false, error: 'invalid' };
  if (isUnsupportedEncoding(text)) return { ok: false, text, changed: false, error: 'encoding' };
  const lines = splitLines(text);
  const found = findBlocks(lines);
  if (!found.ok) return { ok: false, text, changed: false, error: found.error, line: found.line };

  const eol = detectEol(text);
  const want = Array.isArray(sites) && sites.length ? sites : null;
  /** @type {Line[]} */
  const blockLines = want ? buildBlock(want, eol).split(eol).map((t) => ({ text: t, eol })) : [];
  const remove = new Set(found.strays);
  for (const b of found.blocks) for (let i = b.start; i <= b.end; i += 1) remove.add(i);

  const first = found.blocks[0];
  /** @type {Line[]} */
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (want && first && i === first.start) out.push(...blockLines);
    if (!remove.has(i)) out.push(lines[i]);
  }
  if (want && !first) {
    const last = out[out.length - 1];
    if (last && last.eol === '') out[out.length - 1] = { text: last.text, eol };
    out.push(...blockLines);
  }
  const next = joinLines(out);
  return { ok: true, text: next, changed: next !== text };
}

/**
 * Remove every block of ours (and stray END markers).
 * @param {string} text
 */
function stripBlocks(text) {
  return applyBlock(text, null);
}

/**
 * What is blocked right now according to the file.
 * @param {string} text
 * @returns {{ ok: true, present: boolean, sites: string[] } | { ok: false, error: HostsError, line?: number }}
 */
function currentBlockSites(text) {
  if (typeof text !== 'string') return { ok: false, error: 'invalid' };
  if (isUnsupportedEncoding(text)) return { ok: false, error: 'encoding' };
  const lines = splitLines(text);
  const found = findBlocks(lines);
  if (!found.ok) return { ok: false, error: found.error, line: found.line };
  /** @type {string[]} */
  const hosts = [];
  for (const b of found.blocks) {
    for (let i = b.start + 1; i < b.end; i += 1) {
      const parts = lines[i].text.replace(/#.*/, '').trim().split(/\s+/);
      for (const h of parts.slice(1)) if (h) hosts.push(h.toLowerCase());
    }
  }
  const all = new Set(hosts);
  const seen = new Set();
  /** @type {string[]} */
  const sites = [];
  for (const h of hosts) {
    if (h.startsWith('www.') && all.has(h.slice(4))) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    sites.push(h);
  }
  return { ok: true, present: found.blocks.length > 0, sites };
}

/**
 * @param {HostsError | string | null | undefined} code
 * @returns {string}
 */
function describeHostsError(code) {
  switch (code) {
    case 'unterminated':
      return 'В файле hosts есть строка начала блока виджета без строки конца. Виджет не меняет такой файл: исправьте его вручную.';
    case 'nested':
      return 'В файле hosts блок виджета начат дважды. Виджет не меняет такой файл: исправьте его вручную.';
    case 'encoding':
      return 'Файл hosts сохранён в UTF-16. Виджет не меняет его, чтобы не испортить: пересохраните файл в UTF-8.';
    default:
      return 'Файл hosts не удалось разобрать.';
  }
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  detectEol,
  buildBlock,
  applyBlock,
  stripBlocks,
  currentBlockSites,
  describeHostsError,
};
