/**
 * Create/update Desktop + Start Menu shortcuts with AppUserModelID.
 * WScript.Shell cannot set AUMID — Windows toasts require it on the .lnk.
 *
 * Usage: electron ./scripts/write-shortcuts.js
 *        electron ./scripts/write-shortcuts.js --target "C:\\path\\to\\Glass Tasks Widget.exe"
 */
'use strict';

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_USER_MODEL_ID = 'com.glasstasks.widget';
const SHORTCUT_NAME = 'Glass Tasks Widget.lnk';
const PRODUCT_NAME = 'Glass Tasks Widget';

app.setAppUserModelId(APP_USER_MODEL_ID);

function resolveTargetExe() {
  const argIdx = process.argv.indexOf('--target');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return path.resolve(process.argv[argIdx + 1]);
  }

  const appRoot = path.resolve(__dirname, '..');
  const candidates = [
    path.join(appRoot, 'dist', 'win-unpacked', `${PRODUCT_NAME}.exe`),
    path.join(appRoot, 'dist-fresh', 'win-unpacked', `${PRODUCT_NAME}.exe`),
    path.join(appRoot, 'dist-build', 'win-unpacked', `${PRODUCT_NAME}.exe`),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'glass-tasks-widget', `${PRODUCT_NAME}.exe`),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`),
  ];

  let best = null;
  let bestTime = 0;
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    try {
      const t = fs.statSync(c).mtimeMs;
      if (t >= bestTime) {
        bestTime = t;
        best = c;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

/**
 * @param {string} lnkPath
 * @param {string} target
 * @param {string} cwd
 */
function writeLnk(lnkPath, target, cwd) {
  const dir = path.dirname(lnkPath);
  fs.mkdirSync(dir, { recursive: true });
  const op = fs.existsSync(lnkPath) ? 'update' : 'create';
  const ok = shell.writeShortcutLink(lnkPath, op, {
    target,
    cwd,
    args: '',
    appUserModelId: APP_USER_MODEL_ID,
    description: PRODUCT_NAME,
    icon: target,
    iconIndex: 0,
  });
  if (!ok) throw new Error(`writeShortcutLink failed: ${lnkPath}`);
}

app.whenReady().then(() => {
  try {
    const target = resolveTargetExe();
    if (!target || !fs.existsSync(target)) {
      console.error('Executable not found. Build with npm run pack first, or pass --target.');
      app.exit(1);
      return;
    }

    const cwd = path.dirname(target);
    const desktop = path.join(app.getPath('desktop'), SHORTCUT_NAME);
    const startMenu = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      SHORTCUT_NAME
    );

    writeLnk(desktop, target, cwd);
    writeLnk(startMenu, target, cwd);

    console.log(`Desktop shortcut: ${desktop}`);
    console.log(`Start Menu shortcut: ${startMenu}`);
    console.log(`Target: ${target}`);
    console.log(`AppUserModelID: ${APP_USER_MODEL_ID}`);
    app.exit(0);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    app.exit(1);
  }
});
