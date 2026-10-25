'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { snapToNearestEdge, clampIntoWorkArea } = require('../lib/window-bounds');

// 1280×720 at 150 %: 853×480 DIP, minus a 40 px taskbar.
const SMALL = { x: 0, y: 0, width: 853, height: 440 };
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 };

test('snapping goes to the nearest of the left, right and top edges', () => {
  assert.deepEqual(snapToNearestEdge({ x: 30, y: 300, width: 380, height: 460 }, FULL_HD), { x: 8, y: 300 });
  assert.deepEqual(snapToNearestEdge({ x: 1500, y: 300, width: 380, height: 460 }, FULL_HD), { x: 1532, y: 300 });
  assert.deepEqual(snapToNearestEdge({ x: 700, y: 40, width: 380, height: 460 }, FULL_HD), { x: 700, y: 8 });
});

test('a window taller than the screen snaps with its top edge on screen', () => {
  const pos = snapToNearestEdge({ x: 20, y: 100, width: 380, height: 460 }, SMALL);
  assert.deepEqual(pos, { x: 8, y: 8 });
});

test('a window wider than the screen keeps its left edge on screen', () => {
  const pos = snapToNearestEdge({ x: 700, y: 30, width: 900, height: 300 }, SMALL);
  assert.deepEqual(pos, { x: 8, y: 8 });
});

test('a saved position on a monitor that is gone comes back onto the screen', () => {
  assert.deepEqual(clampIntoWorkArea({ x: 2500, y: -200, width: 380, height: 460 }, FULL_HD), { x: 1532, y: 8 });
  assert.deepEqual(clampIntoWorkArea({ x: 400, y: 100, width: 380, height: 460 }, SMALL), { x: 400, y: 8 });
});

test('work areas that do not start at 0,0 (a second monitor) are respected', () => {
  const left = { x: -1280, y: 200, width: 1280, height: 984 };
  assert.deepEqual(snapToNearestEdge({ x: -1250, y: 500, width: 380, height: 460 }, left), { x: -1272, y: 500 });
});
