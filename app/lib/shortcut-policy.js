'use strict';

const path = require('path');

/** Case-insensitive on Windows, like the file system. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function isInside(file, dir) {
  if (!file || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Decide whether this run may write a widget shortcut (Start Menu or Desktop).
 *
 * The Start Menu link carries the AppUserModelID Windows toasts need, so the widget keeps it
 * pointed at itself, but only when that does not steal the link from another copy of the
 * widget: a packaged build launched from a temp folder (smoke test, unpacked zip) must not
 * repoint the user's real shortcut at an exe that is about to disappear.
 *
 * @param {{
 *   exists: boolean,
 *   isDesktop: boolean,
 *   isPackaged: boolean,
 *   execPath: string,
 *   currentTarget?: string | null,
 *   currentTargetExists?: boolean,
 *   tmpDir?: string | null,
 *   skip?: boolean,
 * }} o
 * @returns {'create' | 'update' | null}
 */
function shortcutAction(o) {
  if (o.skip) return null;
  const throwAway = isInside(o.execPath, o.tmpDir);
  if (!o.exists) {
    // Never add a Desktop icon the user does not have; a throw-away build adds nothing.
    if (o.isDesktop || throwAway) return null;
    return 'create';
  }
  // A dev run (`npm start`) must not repoint the installed widget's shortcuts.
  if (!o.isPackaged) return null;
  if (samePath(o.currentTarget, o.execPath)) return 'update';
  // The link belongs to another copy that still exists: leave it alone.
  if (o.currentTarget && o.currentTargetExists) return null;
  // Broken link (its exe is gone): take it over, unless we are throw-away ourselves.
  return throwAway ? null : 'update';
}

module.exports = { shortcutAction, samePath, isInside };
