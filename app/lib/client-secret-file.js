'use strict';

/**
 * Parse the client_secret_*.json Google Cloud offers when creating an OAuth client.
 * Shape: { "installed": { client_id, client_secret, ... } } for Desktop clients,
 * { "web": { ... } } for web-application clients (not usable with an ephemeral loopback port).
 */

const MAX_FILE_BYTES = 64 * 1024;
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * @param {string} text
 * @returns {{ clientId: string, clientSecret: string }}
 */
function parseClientSecretJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Файл пустой.');
  if (raw.length > MAX_FILE_BYTES) throw new Error('Это не похоже на client_secret.json: файл слишком большой.');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Не удалось прочитать JSON. Нужен файл client_secret_….json из Google Cloud (кнопка «Download JSON»).');
  }
  if (!data || typeof data !== 'object') throw new Error('Неверный формат client_secret.json.');
  if (data.web && !data.installed) {
    throw new Error(
      'Это клиент типа «Веб-приложение». Создайте в Google Cloud клиент типа «Приложение для ПК» (Desktop app) и загрузите его JSON.'
    );
  }
  const section = data.installed;
  if (!section || typeof section !== 'object') {
    throw new Error('В файле нет раздела «installed». Нужен JSON клиента типа «Приложение для ПК» (Desktop app).');
  }
  const clientId = typeof section.client_id === 'string' ? section.client_id.trim() : '';
  const clientSecret = typeof section.client_secret === 'string' ? section.client_secret.trim() : '';
  if (!clientId.endsWith(CLIENT_ID_SUFFIX)) throw new Error('В файле нет корректного client_id.');
  if (!clientSecret) {
    throw new Error('В файле нет client_secret. Скачайте JSON сразу при создании клиента — позже Google секрет не показывает.');
  }
  return { clientId, clientSecret };
}

/** True if a pasted string looks like the JSON file rather than a bare Client ID. */
function looksLikeClientJson(text) {
  const t = String(text || '').trim();
  return t.startsWith('{') && /"(installed|web)"\s*:/.test(t);
}

module.exports = { parseClientSecretJson, looksLikeClientJson, CLIENT_ID_SUFFIX, MAX_FILE_BYTES };
