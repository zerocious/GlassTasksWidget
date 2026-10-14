'use strict';

/**
 * Detects that the computer slept or the clock jumped, so timers that were set before it
 * (exact reminders, the midnight habit reset) can be re-armed from the real current time.
 *
 * Two signals, de-duplicated:
 *  - notify('resume'): Electron's powerMonitor "resume" event;
 *  - tick(): called every minute — if far more wall-clock time passed than one interval,
 *    the machine slept (or the clock was changed) even if no event reached us.
 *
 * Pure (time is injected) so it can be unit-tested without Electron.
 */

const DEFAULT_DRIFT_MS = 2 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 10 * 1000;

/**
 * @param {{
 *   onWake: (reason: string) => void,
 *   now?: () => number,
 *   driftMs?: number,
 *   debounceMs?: number,
 * }} opts
 */
function createWakeDetector(opts) {
  const now = opts.now || Date.now;
  const driftMs = opts.driftMs || DEFAULT_DRIFT_MS;
  const debounceMs = opts.debounceMs || DEFAULT_DEBOUNCE_MS;
  let lastTick = now();
  let lastWake = -Infinity;

  function fire(reason) {
    const t = now();
    lastTick = t;
    if (t - lastWake < debounceMs) return false;
    lastWake = t;
    opts.onWake(reason);
    return true;
  }

  return {
    /** An explicit signal from the OS. */
    notify(reason = 'resume') {
      return fire(reason);
    },
    /** Call on a steady interval (the gap between calls is what is measured). */
    tick(expectedIntervalMs = 60 * 1000) {
      const t = now();
      const gap = t - lastTick;
      // Forward jump: slept or clock set ahead. Backward: clock set back (DST fall back, manual).
      if (gap > expectedIntervalMs + driftMs) return fire(`clock-jump +${Math.round(gap / 1000)}s`);
      if (gap < -driftMs) return fire(`clock-back ${Math.round(gap / 1000)}s`);
      lastTick = t;
      return false;
    },
  };
}

module.exports = { createWakeDetector };
