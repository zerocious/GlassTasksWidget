'use strict';

/**
 * Retry transient Google API failures (rate limits, 5xx, dropped connections)
 * with exponential backoff and jitter, honouring Retry-After.
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Server explicitly refused: safe to retry even non-idempotent calls. */
const REFUSED_STATUS = new Set([429, 503]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']);

function statusOf(err) {
  if (!err || typeof err !== 'object') return 0;
  const e = /** @type {any} */ (err);
  const s = Number((e.response && e.response.status) || e.status || e.code);
  return Number.isFinite(s) ? s : 0;
}

/**
 * @param {unknown} err
 * @param {boolean} idempotent  false for inserts — a lost response may mean it already happened
 */
function isRetryable(err, idempotent) {
  const status = statusOf(err);
  if (status) return idempotent ? RETRYABLE_STATUS.has(status) : REFUSED_STATUS.has(status);
  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : null;
  return idempotent && typeof code === 'string' && NETWORK_CODES.has(code);
}

/** Retry-After in ms (seconds or HTTP date), capped. */
function retryAfterMs(err, cap) {
  const headers = err && /** @type {any} */ (err).response && /** @type {any} */ (err).response.headers;
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(cap, Math.max(0, secs * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(cap, Math.max(0, at - Date.now())) : null;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, maxMs?: number, idempotent?: boolean,
 *   sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 8000;
  const idempotent = opts.idempotent !== false;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err, idempotent)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(retryAfterMs(err, maxMs) ?? backoff);
    }
  }
}

/** Methods that create something: only retried when the server explicitly refused. */
const NON_IDEMPOTENT = new Set(['insert']);

/**
 * Wrap a googleapis Tasks client so every `tasks.*` / `tasklists.*` call retries transient errors.
 * @template {{ tasks: object, tasklists: object }} C
 * @param {C} client
 * @param {Parameters<typeof withRetry>[1]} [opts]
 * @returns {C}
 */
function retryingTasksClient(client, opts = {}) {
  const wrapGroup = (group) => {
    const out = {};
    for (const name of Object.keys(group)) {
      const fn = group[name];
      if (typeof fn !== 'function') continue;
      out[name] = (params) =>
        withRetry(() => fn.call(group, params), { ...opts, idempotent: !NON_IDEMPOTENT.has(name) });
    }
    return out;
  };
  return /** @type {C} */ ({ ...client, tasks: wrapGroup(client.tasks), tasklists: wrapGroup(client.tasklists) });
}

module.exports = { withRetry, isRetryable, retryingTasksClient };
