'use strict';

/**
 * Schema versions for the JSON files under data/.
 *
 * Every file carries `schemaVersion` at the top level (encrypted files also on the envelope).
 * A file without it is version 0: the format written before versioning existed.
 * `migrations[v]` turns data of version v-1 into version v; a missing step means
 * «nothing to change but the number». Steps get a copy without `schemaVersion`
 * and must not throw on odd input — normalizers downstream clean up the values.
 */

/**
 * @param {unknown} raw parsed file
 * @returns {number}
 */
function schemaVersionOf(raw) {
  const v = raw && typeof raw === 'object' ? /** @type {any} */ (raw).schemaVersion : undefined;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Bring a parsed document up to `spec.version`.
 * @param {Record<string, any>} raw
 * @param {{ version: number, migrations?: Record<number, (data: any) => any> }} spec
 * @returns {{ data: Record<string, any>, from: number, to: number, changed: boolean, newer: boolean }}
 *   newer: the file comes from a newer app version; it is returned as-is, not downgraded.
 */
function migrate(raw, spec) {
  const from = schemaVersionOf(raw);
  /** @type {Record<string, any>} */
  let data = { ...raw };
  delete data.schemaVersion;
  if (from > spec.version) {
    return { data, from, to: from, changed: false, newer: true };
  }
  for (let v = from + 1; v <= spec.version; v += 1) {
    const step = spec.migrations && spec.migrations[v];
    if (step) {
      const next = step(data);
      data = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
    }
  }
  return { data, from, to: spec.version, changed: from !== spec.version, newer: false };
}

module.exports = { migrate, schemaVersionOf };
