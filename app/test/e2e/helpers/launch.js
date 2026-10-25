'use strict';

/** Start the real widget (Electron + Playwright) on a fresh profile against the fake Google. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const APP = path.resolve(__dirname, '..', '..', '..');
/** The electron npm package exports the path of its binary. */
const ELECTRON = require('electron');

/** Every app still running when the test file ends (a failed assertion skips its close). */
const running = new Set();
process.on('exit', () => {
  for (const app of running) {
    try {
      app.process().kill();
    } catch {
      /* already gone */
    }
  }
});

/**
 * @param {{ tasks?: any[], habits?: any[], env?: Record<string, string>, dir?: string,
 *   t?: import('node:test').TestContext }} [opts]
 *   dir: reuse a profile (a second launch); its fake Google state is kept.
 *   t: close the app when that test ends, whatever happened in it.
 */
async function launch(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-'));
  const state = path.join(dir, 'google.json');
  const logFile = path.join(dir, 'google.log');
  if (!opts.dir) {
    fs.writeFileSync(state, JSON.stringify({ 'L-tasks': opts.tasks || [], 'L-habits': opts.habits || [] }));
    fs.writeFileSync(logFile, '');
  }
  const startedAt = Date.now();
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: ['-r', path.join(__dirname, 'fake-google-main.js'), '--no-sandbox', APP],
    env: {
      ...process.env,
      GT_USER_DATA_DIR: path.join(dir, 'profile'),
      FAKE_GOOGLE_STATE: state,
      FAKE_GOOGLE_LOG: logFile,
      ...(opts.env || {}),
    },
  });
  running.add(app);
  app.process().once('exit', () => running.delete(app));
  if (opts.t) opts.t.after(() => (running.has(app) ? app.close().catch(() => {}) : undefined));
  const win = await app.firstWindow();
  await win.waitForSelector('#input-add-tasks');
  return {
    app,
    win,
    dir,
    startedAt,
    statePath: state,
    google: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    setGoogle: (next) => fs.writeFileSync(state, JSON.stringify(next)),
    calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    bounds: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
  };
}

/** Wait until `check()` is truthy (polling), or fail with `what`. */
async function until(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pos = (n) => String(n).padStart(20, '0');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

module.exports = { launch, until, pos, daysAgo };
