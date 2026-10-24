'use strict';

/**
 * Smoke test of the PACKAGED app on a brand-new profile.
 *
 *   npm run smoke:packaged                 build (electron-builder --dir) into a temp folder, then test
 *   node scripts/smoke-packaged.js --exe "C:\path\Glass Tasks Widget.exe"   test an existing build
 *
 * Safe by construction: output goes to a temp folder (never app/dist), the app runs with
 * --user-data-dir on an empty temp profile (never %APPDATA%\glass-tasks-widget), it runs with
 * GT_SKIP_SHORTCUTS=1 and checks the user's Start Menu / Desktop links are unchanged, and no
 * process-killing script is involved.
 *
 * Checks what only a packaged build can break: every module is inside app.asar, the first
 * launch works without any data files, Electron fuses are set, the log is written.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** sha256 of the widget's Start Menu and Desktop links (missing = null), keyed by path. */
function snapshotShortcuts() {
  const name = 'Glass Tasks Widget.lnk';
  const files = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', name),
    path.join(os.homedir(), 'Desktop', name),
  ];
  const out = {};
  for (const f of files) {
    try {
      out[f] = require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    } catch {
      out[f] = null;
    }
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function buildUnpacked(outDir) {
  console.log('• building (electron-builder --dir) …');
  execFileSync('npx', ['electron-builder', '--dir', '--win', '--x64', `--config.directories.output=${outDir}`, '--publish', 'never'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  const exe = path.join(outDir, 'win-unpacked', 'Glass Tasks Widget.exe');
  if (!fs.existsSync(exe)) throw new Error(`build finished but ${exe} is missing`);
  return exe;
}

async function connect(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        };
        const evaluate = (expression) =>
          new Promise((resolve, reject) => {
            const mine = ++id;
            pending.set(mine, (m) => {
              const r = m.result;
              if (r.exceptionDetails) reject(new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
              else resolve(r.result.value);
            });
            ws.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
          });
        return { ws, evaluate };
      }
    } catch {
      /* app not up yet */
    }
    await sleep(500);
  }
  throw new Error('the widget window never appeared');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-smoke-'));
  const userData = path.join(tmp, 'profile');
  fs.mkdirSync(userData);
  let exe = arg('--exe');
  if (!exe) exe = buildUnpacked(path.join(tmp, 'pack'));

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  };

  // Fuses: the exe must not be usable as a Node interpreter or an open debugger.
  try {
    const { getCurrentFuseWire, FuseState, FuseV1Options } = require('@electron/fuses');
    const wire = await getCurrentFuseWire(exe);
    const on = (opt) => wire[opt] === FuseState.ENABLE;
    check('fuse RunAsNode disabled', !on(FuseV1Options.RunAsNode));
    check('fuse NODE_OPTIONS disabled', !on(FuseV1Options.EnableNodeOptionsEnvironmentVariable));
    check('fuse --inspect disabled', !on(FuseV1Options.EnableNodeCliInspectArguments));
    check('fuse asar integrity on', on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation));
    check('fuse only-load-from-asar on', on(FuseV1Options.OnlyLoadAppFromAsar));
  } catch (err) {
    check('read Electron fuses', false, err.message.split('\n')[0]);
  }

  const port = await freePort();
  console.log(`• launching on a clean profile (debug port ${port}) …`);
  // The widget keeps its Start Menu link pointed at itself; a throw-away build must leave the
  // user's real shortcuts alone (it used to repoint them at this temp folder).
  const shortcutsBefore = snapshotShortcuts();
  const child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, GT_SKIP_SHORTCUTS: '1' },
  });
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  try {
    const { ws, evaluate } = await connect(port);
    // A cold start (fresh install, antivirus scanning new files) can be slower than a fixed delay:
    // wait until the first list has rendered, then give the rest of the UI a moment.
    for (let i = 0; i < 30; i++) {
      const ready = await evaluate(
        `typeof state === 'object' && document.querySelectorAll('#list-tasks li.row').length > 0`,
      ).catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    await sleep(300);
    const page = await evaluate(`({
      title: document.title,
      csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
      mode: typeof state === 'object' ? state.mode : null,
      error: (document.getElementById('statusBanner') || {}).textContent || '',
      tasks: document.querySelectorAll('#list-tasks li.row').length,
      habits: document.querySelectorAll('#list-habits li.row').length,
      tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
      font: document.fonts.check('12px "Geist Mono"'),
      api: Object.keys(window.widgetApi || {}).length,
      nodeLeak: typeof require !== 'undefined' || typeof process !== 'undefined',
    })`);
    check('window title', page.title === 'Glass Tasks Widget', page.title);
    check('CSP present', page.csp);
    check('first launch loads demo data (no crash)', page.mode === 'mock' && page.tasks > 0 && page.habits > 0, `mode=${page.mode} tasks=${page.tasks} habits=${page.habits}`);
    check('no load error banner', !/Ошибка загрузки/.test(page.error), page.error.slice(0, 80));
    check('UI is Russian', page.tabs.join() === 'Задачи,Привычки', page.tabs.join());
    check('bundled font loads', page.font);
    check('preload API exposed', page.api >= 25, `${page.api} methods`);
    check('renderer is isolated from Node', !page.nodeLeak);

    const created = await evaluate(`(async () => {
      const r = await window.widgetApi.createItem('tasks', 'Smoke: проверка завтра в 9:30', { parse: true });
      await loadData(true);
      const t = state.tasks.find((x) => x.id === r.item.id);
      return { title: t.title, dueTime: t.dueTime, dueKind: t.dueKind };
    })()`);
    check('quick-add creates a task with date and time', created.title === 'Smoke: проверка' && created.dueTime === '09:30', JSON.stringify(created));

    const diag = await evaluate(`window.widgetApi.copyDiagnostics().then((r) => r.ok)`);
    check('diagnostics report builds', diag === true);
    ws.close();
  } catch (err) {
    check('drive the app', false, err.message);
  }

  child.kill();
  await sleep(800);

  const logFile = path.join(userData, 'logs', 'main.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('log file written', /\[app\] start v[\d.]+ packaged/.test(log));
  // A --dir build has no app-update.yml (only installers do): that updater error is expected.
  const errors = log.split('\n').filter((l) => /\sERROR\s/.test(l) && !/app-update\.yml|\[updater\]|Checking for update/.test(l));
  check('no unexpected errors in the log', errors.length === 0, errors[0] ? errors[0].slice(0, 140) : '');
  check('app was still running until we stopped it', exited === null);
  const shortcutsAfter = snapshotShortcuts();
  const touched = Object.keys({ ...shortcutsBefore, ...shortcutsAfter }).filter((k) => shortcutsBefore[k] !== shortcutsAfter[k]);
  check('user shortcuts left untouched', touched.length === 0, touched.map((k) => path.basename(path.dirname(k))).join(', '));

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a locked temp file is not a failure */
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
