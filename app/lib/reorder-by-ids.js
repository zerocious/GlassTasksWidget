'use strict';

/**
 * Reorder a list to match orderedIds. Unknown ids are skipped; items missing
 * from orderedIds stay at the end in prior order. Optional patch merges into
 * the matching item while rebuilding.
 *
 * @template {{ id?: string }} T
 * @param {T[]} list
 * @param {string[]} orderedIds
 * @param {Partial<T> & { id?: string } | null} [patch]
 * @returns {T[]}
 */
function reorderByIds(list, orderedIds, patch = null) {
  const source = Array.isArray(list) ? list : [];
  if (!Array.isArray(orderedIds) || !orderedIds.length) return source.slice();

  const byId = new Map();
  for (const item of source) {
    if (item && item.id) byId.set(item.id, item);
  }

  const next = [];
  const seen = new Set();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    let item = byId.get(id);
    if (!item) continue;
    if (patch && patch.id === id) item = { ...item, ...patch };
    next.push(item);
    seen.add(id);
  }
  for (const item of source) {
    if (item && item.id && !seen.has(item.id)) next.push(item);
  }
  return next;
}

/**
 * Normalize an ordered id list from IPC: strings only, deduped, capped.
 * @param {unknown} orderedIds
 * @param {number} max
 * @returns {string[]}
 */
function normalizeOrderedIds(orderedIds, max) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return [];
  const out = [];
  const seen = new Set();
  const limit = Math.max(1, max | 0);
  for (const id of orderedIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Previous sibling id for nested lists: same parent, never the parent row.
 * @template {{ id?: string, parent?: string | null }} T
 * @param {T[]} items
 * @param {string[]} orderedIds
 * @param {string} taskId
 * @returns {string | null}
 */
function previousSiblingFromOrder(items, orderedIds, taskId) {
  if (!Array.isArray(orderedIds) || !taskId) return null;
  const byId = new Map();
  for (const item of items || []) {
    if (item && item.id) byId.set(item.id, item);
  }
  const moved = byId.get(taskId);
  if (!moved) return null;
  const parent = moved.parent || null;
  const idx = orderedIds.indexOf(taskId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const id = orderedIds[i];
    if (parent && id === parent) return null;
    const prev = byId.get(id);
    if (!prev) continue;
    if ((prev.parent || null) === parent) return id;
  }
  return null;
}

module.exports = {
  reorderByIds,
  normalizeOrderedIds,
  previousSiblingFromOrder,
};
