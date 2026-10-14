'use strict';

/**
 * Small rotating file logger plus secret redaction, so a user can send a report
 * that contains no tokens, keys, auth codes or their Windows user name.
 * Pure Node (no Electron): the main process wires it up, tests drive it directly.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_KEEP = 3;
const MAX_LINE = 4000;

/** Ordered: broader token shapes first, then keyed values. */
const REDACTIONS = [
  [/ya29\.[A-Za-z0-9_.-]+/g, '<access-token>'],
  [/1\/\/[A-Za-z0-9_-]{20,}/g, '<refresh-token>'],
  [/GOCSPX-[A-Za-z0-9_-]+/g, '<client-secret>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<jwt>'],
  [/(Bearer\s+)[A-Za-z0-9_.~+/-]+=*/gi, '$1<redacted>'],
  [
    /("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|clientSecret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
    '$1"<redacted>"',
  ],
  [/([?&](?:code|state|code_challenge|access_token|refresh_token)=)[^&\s"']+/gi, '$1<redacted>'],
  // Windows profile folder reveals the user name.
  [/([A-Za-z]:\\Users\\)[^\\/\s"']+/gi, '$1<user>'],
];

/**
 * @param {unknown} text
 * @returns {string}
 */
function redact(text) {
  let out = String(text);
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

/** @param {unknown[]} args console-style arguments */
function formatArgs(args) {
  return args
    .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: Infinity })))
    .join(' ');
}

/**
 * @param {{ dir: string, maxBytes?: number, keep?: number, now?: () => Date }} opts
 */
function createLogger(opts) {
  const dir = opts.dir;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const keep = Math.max(1, opts.keep || DEFAULT_KEEP);
  const now = opts.now || (() => new Date());
  const file = path.join(dir, 'main.log');
  let ready = false;
  let size = 0;

  function ensureDir() {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      ready = true;
    } catch {
      ready = false;
    }
    return ready;
  }

  function rotate() {
    // main.log → main.1.log → main.2.log …; the oldest beyond `keep` is dropped.
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : path.join(dir, `main.${i - 1}.log`);
      const to = path.join(dir, `main.${i}.log`);
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* a locked file must not break logging */
      }
    }
    size = 0;
  }

  /**
   * @param {'info' | 'warn' | 'error' | 'debug'} level
   * @param {unknown[]} args
   */
  function write(level, args) {
    if (!ensureDir()) return;
    let line = redact(formatArgs(args));
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…[${line.length - MAX_LINE} more chars]`;
    const text = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${line.replace(/\r?\n/g, '\n    ')}\n`;
    try {
      if (size + Buffer.byteLength(text) > maxBytes) rotate();
      fs.appendFileSync(file, text, 'utf8');
      size += Buffer.byteLength(text);
    } catch {
      /* disk full / permissions: logging is best-effort */
    }
  }

  /** Last `lines` lines across the current and previous file, oldest first, redacted. */
  function tail(lines = 200) {
    const parts = [];
    for (let i = keep - 1; i >= 0; i -= 1) {
      const f = i === 0 ? file : path.join(dir, `main.${i}.log`);
      try {
        parts.push(fs.readFileSync(f, 'utf8'));
      } catch {
        /* missing */
      }
    }
    const all = parts.join('').split('\n').filter(Boolean);
    return redact(all.slice(-lines).join('\n'));
  }

  return { dir, file, write, tail, redact };
}

/**
 * Route console.* of the current process into the logger (output still reaches the terminal).
 * @param {ReturnType<typeof createLogger>} logger
 * @param {Console} target
 */
function captureConsole(logger, target = console) {
  const original = {};
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    original[method] = target[method].bind(target);
    target[method] = (...args) => {
      logger.write(level, args);
      original[method](...args);
    };
  }
  return () => Object.assign(target, original);
}

module.exports = { createLogger, captureConsole, redact, formatArgs, DEFAULT_MAX_BYTES };
