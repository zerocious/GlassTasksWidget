'use strict';

/**
 * Smoke tests for invalid_grant detection / safe mapping (no network, no Electron).
 * Run: node scripts/test-google-auth-errors.js
 */

const path = require('path');
const assert = require('assert');

// google-auth pulls config which may read files; run from app/
process.chdir(path.join(__dirname, '..'));

const {
  isInvalidGrantError,
  normalizeGoogleAuthError,
  INVALID_GRANT_CODE,
  INVALID_GRANT_USER_MESSAGE,
} = require('../lib/google-auth');

function test(name, fn) {
  try {
    fn();
    console.log('ok -', name);
  } catch (err) {
    console.error('fail -', name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

test('detects response.data.error invalid_grant', () => {
  assert.strictEqual(
    isInvalidGrantError({
      response: { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
    }),
    true
  );
});

test('detects classic message', () => {
  assert.strictEqual(
    isInvalidGrantError(new Error('invalid_grant: Token has been expired or revoked.')),
    true
  );
});

test('detects invalid_rapt', () => {
  assert.strictEqual(
    isInvalidGrantError({ response: { data: { error: 'invalid_rapt' } } }),
    true
  );
});

test('ignores bare invalid_token (do not wipe refresh token)', () => {
  assert.strictEqual(
    isInvalidGrantError({ response: { data: { error: 'invalid_token' } } }),
    false
  );
});

test('ignores numeric HTTP status on err.code', () => {
  assert.strictEqual(isInvalidGrantError({ code: 401, message: 'Request failed' }), false);
});

test('ignores Node errno codes', () => {
  assert.strictEqual(isInvalidGrantError({ code: 'ECONNRESET', message: 'socket hang up' }), false);
});

test('normalize maps to safe Russian message + code', () => {
  const mapped = normalizeGoogleAuthError({
    response: { data: { error: 'invalid_grant' } },
    message: 'invalid_grant',
  });
  assert.strictEqual(mapped.code, INVALID_GRANT_CODE);
  assert.strictEqual(mapped.message, INVALID_GRANT_USER_MESSAGE);
});

test('normalize is idempotent for already-mapped errors', () => {
  const first = normalizeGoogleAuthError({
    response: { data: { error: 'invalid_grant' } },
  });
  const second = normalizeGoogleAuthError(first);
  assert.strictEqual(second, first);
  assert.strictEqual(second.code, INVALID_GRANT_CODE);
});

test('normalize preserves non-auth Error instance', () => {
  const err = new Error('network down');
  assert.strictEqual(normalizeGoogleAuthError(err), err);
});

if (!process.exitCode) {
  console.log('All google-auth error tests passed.');
}
