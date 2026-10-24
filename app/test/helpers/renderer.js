'use strict';

/**
 * src/app.js is a classic browser script (no modules, no exports), so Node tests cannot require
 * it. These helpers cut named top-level functions out of its source and run them in a fresh vm
 * context next to hand-written stubs for whatever DOM, state or other functions they use.
 *
 * Every free name a function reads must be passed in `globals`: the extract runs in strict mode,
 * so a missing stub throws a ReferenceError instead of passing silently. Values the functions
 * assign (state, timers…) are read back from the returned context.
 *
 * Objects created inside the context come from another realm: compare arrays with
 * `[...arr]` / `Array.from(arr)` before handing them to assert.deepStrictEqual.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', '..', 'src', 'app.js');

let source = null;
function appSource() {
  if (source === null) source = fs.readFileSync(APP_JS, 'utf8').replace(/\r\n/g, '\n');
  return source;
}

/**
 * Source of `function name(…) {…}` (or `async function`) declared at column 0. The body ends at
 * the first `}` alone on a line, which is how every top-level function in app.js is formatted.
 * @param {string} name
 */
function extractFunction(name) {
  const src = appSource();
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found in src/app.js`);
  const end = src.indexOf('\n}\n', m.index);
  if (end < 0) throw new Error(`end of function ${name} not found in src/app.js`);
  return src.slice(m.index, end + 2);
}

/**
 * @param {string[]} names top-level functions of src/app.js to load
 * @param {Record<string, unknown>} [globals] stubs; setTimeout / clearTimeout are added unless given
 * @returns {Record<string, any>} the context: the loaded functions plus the (possibly updated) globals
 */
function loadRendererFunctions(names, globals = {}) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, ...globals });
  const code = `'use strict';\n${names.map(extractFunction).join('\n\n')}`;
  vm.runInContext(code, ctx, { filename: 'src/app.js (extract)' });
  return ctx;
}

module.exports = { extractFunction, loadRendererFunctions };
