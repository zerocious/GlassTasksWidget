'use strict';

const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');
const open = require('open');
const { loadEnvFile, readJson, writeJson, dataPath, hasGoogleCredentials } = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const TOKENS_FILE = dataPath('tokens.json');

function getOAuthClient() {
  loadEnvFile();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }
  const port = Number(process.env.OAUTH_REDIRECT_PORT || 42813);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  return {
    oauth2: new google.auth.OAuth2(clientId, clientSecret, redirectUri),
    redirectUri,
    port,
  };
}

function loadSavedTokens() {
  return readJson(TOKENS_FILE, null);
}

function saveTokens(tokens) {
  writeJson(TOKENS_FILE, tokens);
}

function clearTokens() {
  writeJson(TOKENS_FILE, {});
}

/**
 * Returns an authorized OAuth2 client, or null if credentials / tokens unavailable.
 * @param {{ interactive?: boolean }} [opts]
 */
async function getAuthorizedClient(opts = {}) {
  const interactive = opts.interactive !== false;
  if (!hasGoogleCredentials()) return null;

  const { oauth2, port } = getOAuthClient();
  const saved = loadSavedTokens();
  if (saved && saved.refresh_token) {
    oauth2.setCredentials(saved);
    oauth2.on('tokens', (tokens) => {
      const merged = { ...loadSavedTokens(), ...tokens };
      saveTokens(merged);
    });
    return oauth2;
  }

  if (!interactive) return null;
  return interactiveLogin(oauth2, port);
}

function interactiveLogin(oauth2, port) {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Ошибка OAuth</h1><p>${err}</p>`);
          server.close();
          reject(new Error(err));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Нет кода авторизации</h1>');
          return;
        }
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Готово</h1><p>Можно закрыть это окно и вернуться к виджету.</p>'
        );
        server.close();
        resolve(oauth2);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(e.message || e));
        server.close();
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      open(authUrl).catch(() => {
        console.error('Open this URL in a browser:', authUrl);
      });
    });

    server.on('error', reject);
  });
}

module.exports = {
  SCOPES,
  getAuthorizedClient,
  hasGoogleCredentials,
  clearTokens,
  loadSavedTokens,
};
