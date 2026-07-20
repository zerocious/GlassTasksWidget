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

module.exports = {
  reorderByIds,
  normalizeOrderedIds,
};
