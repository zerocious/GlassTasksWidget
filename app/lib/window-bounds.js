'use strict';

/**
 * Widget window placement inside a display's work area (pure, for electron/main.js).
 * A window larger than the work area (small screen, high scaling) is pinned to the top-left
 * margin instead of being pushed past the opposite edge, so its header stays reachable.
 */

const MARGIN = 8;

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

function clamp(n, min, max) {
  return Math.min(Math.max(min, max), Math.max(min, n));
}

/** @param {Rect} size @param {Rect} wa */
function limits(size, wa, margin) {
  return {
    minX: wa.x + margin,
    maxX: wa.x + wa.width - size.width - margin,
    minY: wa.y + margin,
    maxY: wa.y + wa.height - size.height - margin,
  };
}

/**
 * @param {Rect} bounds  window position and size
 * @param {Rect} workArea
 * @returns {{ x: number, y: number }}
 */
function clampIntoWorkArea(bounds, workArea, margin = MARGIN) {
  const l = limits(bounds, workArea, margin);
  return {
    x: Math.round(clamp(bounds.x, l.minX, l.maxX)),
    y: Math.round(clamp(bounds.y, l.minY, l.maxY)),
  };
}

/**
 * Move to the nearest of the left, right and top edges, then keep inside the work area.
 * @param {Rect} bounds
 * @param {Rect} workArea
 * @returns {{ x: number, y: number }}
 */
function snapToNearestEdge(bounds, workArea, margin = MARGIN) {
  const l = limits(bounds, workArea, margin);
  const distLeft = Math.abs(bounds.x - l.minX);
  const distRight = Math.abs(bounds.x - l.maxX);
  const distTop = Math.abs(bounds.y - l.minY);
  const nearest = Math.min(distLeft, distRight, distTop);
  let { x, y } = bounds;
  if (nearest === distLeft) x = l.minX;
  else if (nearest === distRight) x = l.maxX;
  else y = l.minY;
  return clampIntoWorkArea({ ...bounds, x, y }, workArea, margin);
}

/** The strip the window is dragged by (tabs and buttons) and how much of it must be on a screen. */
const HEADER_HEIGHT = 40;
const MIN_GRAB_WIDTH = 80;
const MIN_GRAB_HEIGHT = 20;

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** Distance from a point to a rectangle (0 inside). */
function distanceTo(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * Where to move a window the user can no longer grab (its monitor was unplugged, the
 * resolution or scaling changed), or null when its header is still on some screen.
 * @param {Rect} bounds
 * @param {Rect[]} workAreas
 * @returns {{ x: number, y: number } | null}
 */
function placeOnScreen(bounds, workAreas, margin = MARGIN) {
  if (!workAreas.length) return null;
  const grabbable = workAreas.some(
    (wa) =>
      overlap(bounds.x, bounds.x + bounds.width, wa.x, wa.x + wa.width) >= MIN_GRAB_WIDTH &&
      overlap(bounds.y, bounds.y + HEADER_HEIGHT, wa.y, wa.y + wa.height) >= MIN_GRAB_HEIGHT
  );
  if (grabbable) return null;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const nearest = workAreas.reduce((best, wa) =>
    distanceTo(cx, cy, wa) < distanceTo(cx, cy, best) ? wa : best
  );
  return clampIntoWorkArea(bounds, nearest, margin);
}

module.exports = { clampIntoWorkArea, snapToNearestEdge, placeOnScreen };
