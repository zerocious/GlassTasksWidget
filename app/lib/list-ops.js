'use strict';

/**
 * Pure list updates shared by the in-memory payload cache and the offline cache.
 * Inputs are never mutated.
 */

/**
 * Apply one mutation result to a list of items.
 * @template {{ id?: string, parent?: string | null }} T
 * @param {T[]} list
 * @param {string} taskId
 * @param {object | null} patch   null = remove the item and its subtasks
 * @param {T | null} [append]     new item to put first (replaces same id)
 * @returns {T[]}
 */
function applyItemPatch(list, taskId, patch, append = null) {
  const items = Array.isArray(list) ? list : [];
  if (append) {
    return [append, ...items.filter((item) => item && item.id !== append.id)];
  }
  if (patch === null) {
    // Cascade: Google deletes subtasks with their parent.
    return items.filter((item) => item && item.id !== taskId && item.parent !== taskId);
  }
  return items.map((item) => (item && item.id === taskId ? { ...item, ...patch } : item));
}

/**
 * Reorder to match `orderedIds`; items not mentioned keep their relative order at the end.
 * @template {{ id?: string }} T
 * @param {T[]} list
 * @param {string[]} orderedIds
 * @param {Partial<T> & { id?: string } | null} [movedPatch] merged into the moved item
 * @returns {T[]}
 */
function reorderList(list, orderedIds, movedPatch = null) {
  const items = Array.isArray(list) ? list : [];
  const byId = new Map();
  for (const item of items) {
    if (item && item.id) byId.set(item.id, item);
  }
  const next = [];
  const seen = new Set();
  for (const id of orderedIds || []) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    let item = byId.get(id);
    if (!item) continue;
    if (movedPatch && movedPatch.id === id) item = { ...item, ...movedPatch };
    next.push(item);
    seen.add(id);
  }
  for (const item of items) {
    if (item && item.id && !seen.has(item.id)) next.push(item);
  }
  return next;
}

module.exports = { applyItemPatch, reorderList };
