'use strict';

/**
 * Environment for child processes (PowerShell toasts, reg.exe …).
 * The OAuth client id / secret live in process.env for the sign-in code; a child process
 * must never inherit them (it could end up in crash dumps, process listings or logs).
 */

const SECRET_ENV_KEYS = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_PORT']);
const SECRET_ENV_PATTERN = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_?KEY)(?:_|$)/i;

/**
 * @param {Record<string, string>} [extra] variables to add (win over inherited ones)
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {Record<string, string>}
 */
function childEnv(extra = {}, base = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEYS.has(key) || SECRET_ENV_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

module.exports = { childEnv };
