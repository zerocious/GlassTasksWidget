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

module.exports = { clampIntoWorkArea, snapToNearestEdge };
