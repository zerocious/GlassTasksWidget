'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { GaxiosError } = require('gaxios');

const { parseClientSecretJson, looksLikeClientJson } = require('../lib/client-secret-file');
const { describeAuthError, CONSOLE_LINKS } = require('../lib/auth-errors');

const ID = '1234-abc.apps.googleusercontent.com';

test('parseClientSecretJson reads a Desktop ("installed") client', () => {
  const text = JSON.stringify({
    installed: { client_id: ID, client_secret: 'GOCSPX-xyz', redirect_uris: ['http://localhost'] },
  });
  assert.deepEqual(parseClientSecretJson(text), { clientId: ID, clientSecret: 'GOCSPX-xyz' });
});

test('parseClientSecretJson rejects web clients, junk and missing secrets with Russian hints', () => {
  assert.throws(() => parseClientSecretJson(JSON.stringify({ web: { client_id: ID, client_secret: 's' } })), /Приложение для ПК/);
  assert.throws(() => parseClientSecretJson('not json'), /JSON/);
  assert.throws(() => parseClientSecretJson(''), /пустой/);
  assert.throws(() => parseClientSecretJson(JSON.stringify({ installed: { client_id: 'x', client_secret: 's' } })), /client_id/);
  assert.throws(() => parseClientSecretJson(JSON.stringify({ installed: { client_id: ID } })), /client_secret/);
  assert.throws(() => parseClientSecretJson('x'.repeat(70 * 1024)), /большой/);
});

test('looksLikeClientJson detects a pasted file', () => {
  assert.equal(looksLikeClientJson('{"installed":{"client_id":"a"}}'), true);
  assert.equal(looksLikeClientJson(ID), false);
});

test('describeAuthError maps OAuth codes from callback, token endpoint and API errors', () => {
  assert.equal(describeAuthError(Object.assign(new Error('access_denied'), { code: 'access_denied' })).code, 'access_denied');
  assert.equal(
    describeAuthError({ message: 'invalid_client', response: { data: { error: 'invalid_client', error_description: 'Unauthorized' } } }).code,
    'invalid_client'
  );
  assert.equal(describeAuthError(new Error('The OAuth client was not found.')).code, 'invalid_client');
  assert.equal(describeAuthError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', syscall: 'listen' })).code, 'port_busy');
  assert.equal(describeAuthError(new Error('Something else')), null);
  assert.equal(describeAuthError(null), null);
});

test('describeAuthError links the right project when the Tasks API is disabled', () => {
  const apiErr = {
    message: 'Google Tasks API has not been used in project 987654321 before or it is disabled.',
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message: 'Google Tasks API has not been used in project 987654321 before or it is disabled.',
          errors: [{ reason: 'accessNotConfigured' }],
          details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'projects/987654321' } }],
        },
      },
    },
  };
  const d = describeAuthError(apiErr);
  assert.equal(d.code, 'api_disabled');
  assert.match(d.actionUrl, /project=987654321$/);
  assert.equal(describeAuthError(new Error('API is disabled. Enable it by visiting …')).actionUrl, CONSOLE_LINKS.enableApi);
});

test('describeAuthError maps every bind failure of the loopback port', async () => {
  for (const code of ['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL']) {
    assert.equal(describeAuthError(Object.assign(new Error('listen failed'), { code, syscall: 'listen' })).code, 'port_busy', code);
  }
  // The real error Node gives a server whose port is taken.
  const taken = http.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  try {
    const second = http.createServer();
    const err = await new Promise((resolve) => {
      second.on('error', resolve);
      second.listen(/** @type {any} */ (taken.address()).port, '127.0.0.1');
    });
    assert.equal(describeAuthError(err).code, 'port_busy');
  } finally {
    taken.close();
  }
});

test('the same codes from a blocked connection or a file are not «port busy»', () => {
  // A firewall / antivirus blocking outbound HTTPS: node-fetch's FetchError, wrapped by gaxios.
  const fetchErr = Object.assign(new Error('request to https://tasks.googleapis.com/ failed, reason: connect EACCES 142.250.1.1:443'), {
    name: 'FetchError',
    code: 'EACCES',
    errno: 'EACCES',
    erroredSysCall: 'connect',
  });
  const blocked = new GaxiosError(fetchErr.message, { url: 'https://tasks.googleapis.com/' }, undefined, fetchErr);
  assert.equal(blocked.code, 'EACCES');
  assert.equal(describeAuthError(blocked), null);
  assert.equal(describeAuthError(Object.assign(new Error('connect EACCES 142.250.1.1:443'), { code: 'EACCES', syscall: 'connect' })), null);
  assert.equal(describeAuthError(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' })), null);
  assert.equal(describeAuthError(Object.assign(new Error('EPERM'), { code: 'EPERM' })), null);
});

test('access_denied tells the user they declined, without a console button', () => {
  const d = describeAuthError('access_denied');
  assert.match(d.message, /не разрешили/);
  assert.equal(d.actionUrl, undefined);
});
