'use strict';

/**
 * Hold the first quit until pending work is written (an undoable delete waiting out its five
 * seconds, an edit still on its way to Google), then quit for real. A flush that hangs or
 * fails never keeps the app open longer than `timeoutMs`.
 *
 * @param {{ flush: () => Promise<unknown>, quit: () => void, timeoutMs: number }} opts
 */
function createQuitGate({ flush, quit, timeoutMs }) {
  /** @type {Promise<void> | null} */
  let running = null;
  let done = false;

  return {
    /** Electron `before-quit` handler. */
    onBeforeQuit(event) {
      if (done) return;
      event.preventDefault();
      if (running) return;
      let timer;
      const limit = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      running = Promise.race([Promise.resolve().then(flush).catch(() => {}), limit]).then(() => {
        clearTimeout(timer);
        done = true;
        quit();
      });
    },
    /** Resolves once a started flush has finished and quit() was called (tests). */
    idle() {
      return running || Promise.resolve();
    },
  };
}

module.exports = { createQuitGate };
