'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { childEnv } = require('../lib/child-env');

test('childEnv drops OAuth credentials and secret-looking variables, keeps the rest', () => {
  const env = childEnv(
    { GT_TOAST_TITLE: 'Пора' },
    {
      PATH: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-x',
      OAUTH_REDIRECT_PORT: '42813',
      GH_TOKEN: 'ghp_x',
      MY_API_KEY: 'k',
      DB_PASSWORD: 'p',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    }
  );
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'GT_TOAST_TITLE', 'PATH', 'SystemRoot']);
});

test('extra variables win over inherited ones and the base is not mutated', () => {
  const base = { PATH: 'a', GOOGLE_CLIENT_SECRET: 's' };
  const env = childEnv({ PATH: 'b' }, base);
  assert.equal(env.PATH, 'b');
  assert.deepEqual(base, { PATH: 'a', GOOGLE_CLIENT_SECRET: 's' });
});
