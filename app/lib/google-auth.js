'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const { loadEnvFile, readJson, writeJson, dataPath, hasGoogleCredentials } = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** Lazy-load heavy googleapis only when OAuth is needed. */
function getGoogle() {
  return require('googleapis').google;
}

function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallengeS256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function tokensFile() {
  return dataPath('tokens.json');
}

/** @type {import('googleapis').Auth.OAuth2Client | null} */
let cachedClient = null;
/** @type {Promise<import('googleapis').Auth.OAuth2Client> | null} */
let loginInFlight = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getOAuthClient() {
  loadEnvFile();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }
  const port = Number(process.env.OAUTH_REDIRECT_PORT || 42813);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const google = getGoogle();
  return {
    oauth2: new google.auth.OAuth2(clientId, clientSecret, redirectUri),
    redirectUri,
    port,
  };
}

function loadSavedTokens() {
  return readJson(tokensFile(), null);
}

function saveTokens(tokens) {
  writeJson(tokensFile(), tokens);
}

function clearTokens() {
  cachedClient = null;
  loginInFlight = null;
  const file = tokensFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    writeJson(file, {});
  }
}

function attachTokenSaver(oauth2) {
  oauth2.on('tokens', (tokens) => {
    const merged = { ...(loadSavedTokens() || {}), ...tokens };
    saveTokens(merged);
  });
}

function openAuthUrl(authUrl) {
  try {
    const { shell } = require('electron');
    return Promise.resolve(shell.openExternal(authUrl));
  } catch {
    console.error('Could not open system browser for OAuth. Redirect listens on 127.0.0.1.');
    return Promise.resolve();
  }
}

/**
 * Returns an authorized OAuth2 client, or null if credentials / tokens unavailable.
 * @param {{ interactive?: boolean }} [opts]
 */
async function getAuthorizedClient(opts = {}) {
  const interactive = Boolean(opts.interactive);
  if (!hasGoogleCredentials()) return null;

  if (cachedClient) return cachedClient;

  const { oauth2, port } = getOAuthClient();
  const saved = loadSavedTokens();
  if (saved && saved.refresh_token) {
    oauth2.setCredentials(saved);
    oauth2.removeAllListeners('tokens');
    attachTokenSaver(oauth2);
    cachedClient = oauth2;
    return oauth2;
  }

  if (!interactive) return null;

  if (loginInFlight) return loginInFlight;
  loginInFlight = interactiveLogin(oauth2, port)
    .then((client) => {
      cachedClient = client;
      return client;
    })
    .finally(() => {
      loginInFlight = null;
    });
  return loginInFlight;
}

function interactiveLogin(oauth2, port) {
  return new Promise((resolve, reject) => {
    const state = randomUrlSafe(24);
    const codeVerifier = randomUrlSafe(64);
    const codeChallenge = pkceChallengeS256(codeVerifier);

    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    const finish = (err, client) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(client);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Ошибка OAuth</h1><p>${escapeHtml(err)}</p>`);
          finish(new Error(err));
          return;
        }
        if (!returnedState || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Неверный state</h1><p>Возможная CSRF-атака. Закройте окно и войдите снова.</p>');
          finish(new Error('OAuth state mismatch'));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Нет кода авторизации</h1>');
          finish(new Error('OAuth: нет кода авторизации'));
          return;
        }
        const { tokens } = await oauth2.getToken({ code, codeVerifier });
        oauth2.setCredentials(tokens);
        attachTokenSaver(oauth2);
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Готово</h1><p>Можно закрыть это окно и вернуться к виджету.</p>'
        );
        finish(null, oauth2);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(e.message || e));
        finish(e);
      }
    });

    timer = setTimeout(() => {
      finish(new Error('OAuth: время ожидания истекло (5 мин). Попробуйте снова.'));
    }, OAUTH_TIMEOUT_MS);

    server.listen(port, '127.0.0.1', () => {
      openAuthUrl(authUrl).catch(() => {
        console.error('Could not open browser for OAuth. Redirect port:', port);
      });
    });

    server.on('error', (e) => finish(e));
  });
}

module.exports = {
  SCOPES,
  getAuthorizedClient,
  hasGoogleCredentials,
  clearTokens,
  loadSavedTokens,
};
