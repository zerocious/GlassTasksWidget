'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BEGIN_MARKER = '# BEGIN GlassTasksWidget work-hours';
const END_MARKER = '# END GlassTasksWidget work-hours';
const CHECK_INTERVAL_MS = 45 * 1000;
const WARN_SECONDS = 3;

/** Sensible default / placeholder blocklist (normalized bare domains). */
const DEFAULT_WORK_HOURS_SITES = [
  'vk.com',
  'vk.ru',
  'youtube.com',
  'ru.pinterest.com',
  'twitch.tv',
  'mail.yandex.ru',
  'web.telegram.org',
  'music.yandex.ru',
];

/** Domains (and suffixes) we never write into hosts. */
const PROTECTED_SUFFIXES = [
  'localhost',
  'local',
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'microsoft.com',
  'windows.com',
  'live.com',
  'office.com',
  'office.net',
  'msn.com',
  'github.com',
  'githubusercontent.com',
  'electronjs.org',
];

/** @type {http.Server | null} */
let blockServer = null;
/** @type {number | null} */
let blockServerPort = null;
/** @type {'instant' | 'warn'} */
let blockServerMode = 'warn';
/** @type {ReturnType<typeof setInterval> | null} */
let scheduleTimer = null;
/** @type {Promise<void>} */
let applyChain = Promise.resolve();
/** @type {{ ok: boolean, active: boolean, hostsApplied: boolean, error: string | null, serverPort: number | null, mode: string }} */
let lastStatus = {
  ok: true,
  active: false,
  hostsApplied: false,
  error: null,
  serverPort: null,
  mode: 'warn',
};

/**
 * @returns {string}
 */
function hostsPath() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return path.join(root, 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string} HH:MM
 */
function normalizeTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return fallback;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * @param {string} hhmm
 * @returns {number} minutes from midnight
 */
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Same-day or overnight (start > end) intervals. Local wall-clock.
 * @param {string} start HH:MM
 * @param {string} end HH:MM
 * @param {Date} [now]
 * @returns {boolean}
 */
function isWithinWorkHours(start, end, now = new Date()) {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return true; // full day
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  // Overnight e.g. 22:00–06:00
  return cur >= startMin || cur < endMin;
}

/**
 * Strip protocol/www/path → bare hostname; reject IPs and protected domains.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return null;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  if (isProtectedDomain(s)) return null;
  return s;
}

/**
 * @param {string} domain
 * @returns {boolean}
 */
function isProtectedDomain(domain) {
  const d = domain.toLowerCase();
  return PROTECTED_SUFFIXES.some((suf) => d === suf || d.endsWith(`.${suf}`));
}

/**
 * @param {unknown} value array or JSON string
 * @returns {{ sites: string[], error: string | null, sitesJson: string }}
 */
function normalizeSitesList(value) {
  let parsed = value;
  let fromString = false;
  if (typeof value === 'string') {
    fromString = true;
    const trimmed = value.trim();
    if (!trimmed) {
      return { sites: [], error: null, sitesJson: '[]' };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        sites: [],
        error: 'Некорректный JSON списка сайтов',
        sitesJson: trimmed,
      };
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      sites: [],
      error: 'Список сайтов должен быть JSON-массивом строк',
      sitesJson: fromString && typeof value === 'string' ? value.trim() : '[]',
    };
  }
  /** @type {string[]} */
  const sites = [];
  const seen = new Set();
  for (const item of parsed) {
    const d = normalizeDomain(item);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    sites.push(d);
  }
  return {
    sites,
    error: null,
    sitesJson: JSON.stringify(sites),
  };
}

/**
 * @param {unknown} mode
 * @returns {'instant' | 'warn'}
 */
function normalizeMode(mode) {
  return mode === 'instant' ? 'instant' : 'warn';
}

/**
 * @param {string} content
 * @returns {string} content without our marked block
 */
function stripOurBlock(content) {
  const begin = content.indexOf(BEGIN_MARKER);
  if (begin < 0) return content;
  const end = content.indexOf(END_MARKER, begin);
  if (end < 0) {
    // Corrupt / incomplete — remove from begin to EOF (safer than leaving broken)
    return content.slice(0, begin).replace(/\s+$/, '') + (content.endsWith('\n') ? '\n' : '');
  }
  const after = content.slice(end + END_MARKER.length).replace(/^\r?\n/, '');
  const before = content.slice(0, begin).replace(/\s+$/, '');
  if (!before) return after;
  return `${before}\n${after}`;
}

/**
 * @param {string[]} sites
 * @returns {string}
 */
function buildHostsBlock(sites) {
  const lines = [BEGIN_MARKER];
  for (const site of sites) {
    lines.push(`127.0.0.1 ${site}`);
    lines.push(`127.0.0.1 www.${site}`);
  }
  lines.push(END_MARKER);
  return lines.join(os.EOL);
}

/**
 * @returns {{ ok: boolean, content?: string, error?: string }}
 */
function readHosts() {
  try {
    const content = fs.readFileSync(hostsPath(), 'utf8');
    return { ok: true, content };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      ok: false,
      error: `Не удалось прочитать hosts: ${msg}`,
    };
  }
}

/**
 * @param {string} content
 * @returns {{ ok: boolean, error?: string }}
 */
function writeHosts(content) {
  try {
    fs.writeFileSync(hostsPath(), content, 'utf8');
    flushDnsCache();
    return { ok: true };
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        error:
          'Нет прав на запись в файл hosts. Запустите Glass Tasks Widget от имени администратора (UAC) и включите блокировку снова.',
      };
    }
    const msg = err && err.message ? err.message : String(err);
    return { ok: false, error: `Не удалось записать hosts: ${msg}` };
  }
}

function flushDnsCache() {
  if (process.platform !== 'win32') return;
  try {
    execFile('ipconfig', ['/flushdns'], { windowsHide: true }, () => {});
  } catch {
    // ignore
  }
}

/**
 * Apply or remove our hosts block.
 * @param {boolean} apply
 * @param {string[]} sites
 * @returns {{ ok: boolean, hostsApplied: boolean, error: string | null }}
 */
function syncHostsFile(apply, sites) {
  const read = readHosts();
  if (!read.ok) {
    return { ok: false, hostsApplied: false, error: read.error || 'Ошибка чтения hosts' };
  }
  let next = stripOurBlock(read.content || '');
  if (apply && sites.length) {
    if (!next.endsWith('\n') && next.length) next += os.EOL;
    next += buildHostsBlock(sites) + os.EOL;
  }
  // Avoid rewrite if unchanged
  if (next === read.content) {
    return { ok: true, hostsApplied: Boolean(apply && sites.length), error: null };
  }
  const written = writeHosts(next);
  if (!written.ok) {
    return { ok: false, hostsApplied: false, error: written.error || 'Ошибка записи hosts' };
  }
  return { ok: true, hostsApplied: Boolean(apply && sites.length), error: null };
}

/**
 * @param {'instant' | 'warn'} mode
 * @returns {string}
 */
function blockedPageHtml(mode) {
  const warn = mode === 'warn';
  const seconds = WARN_SECONDS;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${warn ? '' : '<meta http-equiv="refresh" content="0;url=about:blank" />'}
  <title>Рабочее время</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 50% -10%, #3a1a22, #12141a 55%);
      color: #f2e9ec;
    }
    .card {
      width: min(420px, 92vw); padding: 28px 24px; border-radius: 16px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      text-align: center; backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 10px; font-size: 22px; font-weight: 700; }
    p { margin: 0; font-size: 14px; line-height: 1.45; color: #c9b8be; }
    .count { margin-top: 16px; font-size: 28px; font-weight: 700; color: #e85d5d; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Сейчас рабочее время</h1>
    <p>Этот сайт заблокирован настроенным интервалом в Glass Tasks Widget.</p>
    ${warn ? `<div class="count" id="c">${seconds}</div>` : ''}
  </div>
  <script>
    (function () {
      var warn = ${warn ? 'true' : 'false'};
      function leave() {
        try { window.close(); } catch (e) {}
        try { location.replace('about:blank'); } catch (e2) {}
      }
      if (!warn) {
        leave();
        return;
      }
      var left = ${seconds};
      var el = document.getElementById('c');
      var t = setInterval(function () {
        left -= 1;
        if (el) el.textContent = String(Math.max(0, left));
        if (left <= 0) {
          clearInterval(t);
          leave();
        }
      }, 1000);
    })();
  </script>
</body>
</html>`;
}

/**
 * Close the block server and wait until the port is released.
 * @returns {Promise<void>}
 */
function stopBlockServerAsync() {
  return new Promise((resolve) => {
    if (!blockServer) {
      blockServerPort = null;
      resolve();
      return;
    }
    const server = blockServer;
    blockServer = null;
    blockServerPort = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.once('close', done);
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close();
    } catch {
      done();
    }
    // Safety if close never emits
    setTimeout(done, 2000);
  });
}

function stopBlockServer() {
  if (!blockServer) {
    blockServerPort = null;
    return;
  }
  try {
    blockServer.close();
  } catch {
    // ignore
  }
  blockServer = null;
  blockServerPort = null;
}

/**
 * Ensure loopback HTTP server is up (port 80 required for hosts → browser).
 * Reuses an existing listener; updates mode in place (no restart race).
 * @param {'instant' | 'warn'} mode
 * @returns {Promise<{ ok: boolean, port: number | null, error: string | null }>}
 */
function ensureBlockServer(mode) {
  const nextMode = normalizeMode(mode);
  blockServerMode = nextMode;

  if (blockServer && blockServerPort === 80) {
    return Promise.resolve({ ok: true, port: 80, error: null });
  }

  return stopBlockServerAsync().then(
    () =>
      new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(blockedPageHtml(blockServerMode));
        });
        server.once('error', (err) => {
          try {
            server.close();
          } catch {
            // ignore
          }
          resolve({
            ok: false,
            port: null,
            error:
              err && (err.code === 'EACCES' || err.code === 'EPERM')
                ? 'Не удалось открыть порт 80 для страницы блокировки (нужны права администратора). Записи hosts всё равно применяются — сайты будут недоступны.'
                : err && err.code === 'EADDRINUSE'
                  ? 'Порт 80 занят другим процессом — страница-предупреждение недоступна. Записи hosts всё равно применяются.'
                  : `Сервер блокировки: ${err && err.message ? err.message : String(err)}`,
          });
        });
        server.listen(80, '127.0.0.1', () => {
          blockServer = server;
          blockServerPort = 80;
          resolve({ ok: true, port: 80, error: null });
        });
      })
  );
}

/**
 * @param {{ workHoursEnabled?: boolean, workHoursStart?: string, workHoursEnd?: string, workHoursSites?: string[], workHoursMode?: string }} settings
 * @returns {Promise<typeof lastStatus>}
 */
function applyWorkHoursState(settings) {
  const run = async () => {
    const enabled = Boolean(settings.workHoursEnabled);
    const start = normalizeTime(settings.workHoursStart, '09:00');
    const end = normalizeTime(settings.workHoursEnd, '18:00');
    const mode = normalizeMode(settings.workHoursMode);
    const sites = Array.isArray(settings.workHoursSites)
      ? settings.workHoursSites.map(normalizeDomain).filter(Boolean)
      : [];
    const active = enabled && isWithinWorkHours(start, end) && sites.length > 0;

    let hostsResult = { ok: true, hostsApplied: false, error: null };
    let serverError = null;

    if (active) {
      const server = await ensureBlockServer(mode);
      if (!server.ok && server.error) serverError = server.error;
      hostsResult = syncHostsFile(true, sites);
    } else {
      await stopBlockServerAsync();
      hostsResult = syncHostsFile(false, []);
    }

    // Hosts write is critical; server warning alone does not mark overall failure
    // when hosts succeeded (sites still blocked). Surface serverError in status.
    const ok = hostsResult.ok;
    lastStatus = {
      ok,
      active,
      hostsApplied: Boolean(hostsResult.hostsApplied),
      error: hostsResult.error || serverError,
      serverPort: blockServerPort,
      mode,
    };
    return lastStatus;
  };

  const p = applyChain.then(run, run);
  applyChain = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

/**
 * @param {() => object} getSettings
 */
function startWorkHoursScheduler(getSettings) {
  stopWorkHoursScheduler();
  const tick = () => {
    try {
      // Re-apply every tick: syncHostsFile no-ops when unchanged; retries after
      // admin denial; picks up overnight window edges and site/mode edits.
      applyWorkHoursState(getSettings()).catch((err) => {
        console.warn('[work-hours]', err && err.message ? err.message : err);
      });
    } catch (err) {
      console.warn('[work-hours] tick', err && err.message ? err.message : err);
    }
  };
  tick();
  scheduleTimer = setInterval(tick, CHECK_INTERVAL_MS);
}

function stopWorkHoursScheduler() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
}

/**
 * Best-effort cleanup on quit: remove hosts block and stop server.
 */
function cleanupWorkHoursOnQuit() {
  stopWorkHoursScheduler();
  stopBlockServer();
  try {
    syncHostsFile(false, []);
  } catch (err) {
    console.warn('[work-hours] quit cleanup', err && err.message ? err.message : err);
  }
}

function getWorkHoursStatus() {
  return { ...lastStatus };
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  WARN_SECONDS,
  CHECK_INTERVAL_MS,
  DEFAULT_WORK_HOURS_SITES,
  normalizeTime,
  normalizeMode,
  normalizeDomain,
  normalizeSitesList,
  isWithinWorkHours,
  isProtectedDomain,
  hostsPath,
  syncHostsFile,
  applyWorkHoursState,
  startWorkHoursScheduler,
  stopWorkHoursScheduler,
  cleanupWorkHoursOnQuit,
  getWorkHoursStatus,
};
