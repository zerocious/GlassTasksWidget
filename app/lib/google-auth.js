'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const { loadEnvFile, readSecretJson, writeSecretJson, dataPath, hasGoogleCredentials } = require('./config');

const { describeAuthError } = require('./auth-errors');

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;

/** Shown in the widget when Google rejects / revokes the refresh token. */
const INVALID_GRANT_USER_MESSAGE =
  'Сессия Google истекла или отозвана — войдите снова. Если это повторяется примерно раз в неделю, приложение в Google Cloud в режиме «Testing»: опубликуйте его (Google Auth Platform → Audience → Publish app).';

/** @param {string} message @param {string} code */
function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Detect OAuth grant failures (expired/revoked refresh token, wrong client, etc.).
 * Does not log or return secrets — only boolean / safe codes.
 * @param {unknown} err
 */
function isInvalidGrantError(err) {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /\binvalid_grant\b/i.test(err);
  }
  const e = /** @type {Record<string, any>} */ (err);
  const data = e.response && e.response.data;
  const errorCode = String(
    (data && data.error) || e.error || e.code || ''
  ).toLowerCase();
  if (
    // invalid_token is an access-token problem the client refreshes on its own —
    // treating it as a dead grant would wipe a still-valid refresh token.
    errorCode === 'invalid_grant' ||
    errorCode === 'invalid_rapt'
  ) {
    return true;
  }
  const msg = String(e.message || '');
  if (/\binvalid_grant\b/i.test(msg)) return true;
  if (/token has been expired or revoked/i.test(msg)) return true;
  if (data && typeof data.error_description === 'string') {
    const desc = data.error_description;
    if (/\binvalid_grant\b/i.test(desc)) return true;
    if (/expired or revoked/i.test(desc)) return true;
  }
  return false;
}

/**
 * Map Google OAuth / API auth errors to a safe user-facing Error.
 * Clears saved tokens on invalid_grant so the UI can show «Google» login again.
 * @param {unknown} err
 * @returns {Error}
 */
function normalizeGoogleAuthError(err) {
  if (isInvalidGrantError(err)) {
    try {
      clearTokens();
    } catch {
      /* ignore */
    }
    return codedError(INVALID_GRANT_USER_MESSAGE, 'invalid_grant');
  }
  const known = describeAuthError(err);
  if (known) {
    const out = codedError(known.message, known.code);
    if (known.actionUrl) out.actionUrl = known.actionUrl;
    if (known.actionLabel) out.actionLabel = known.actionLabel;
    return out;
  }
  if (err instanceof Error) return err;
  return new Error(err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message) : String(err));
}

/**
 * Error from the authorization-code exchange, mapped WITHOUT side effects.
 * (normalizeGoogleAuthError clears saved tokens on invalid_grant, which cancels the
 * sign-in in progress; here no grant has been saved yet, so there is nothing to clear.)
 * @param {unknown} err
 * @returns {Error}
 */
function classifyExchangeError(err) {
  if (isInvalidGrantError(err)) {
    return codedError('Google не принял код входа (он истёк или уже использован). Нажмите «Google» и войдите ещё раз.', 'code_exchange_failed');
  }
  const known = describeAuthError(err);
  if (known) {
    const out = codedError(known.message, known.code);
    if (known.actionUrl) out.actionUrl = known.actionUrl;
    if (known.actionLabel) out.actionLabel = known.actionLabel;
    return out;
  }
  return err instanceof Error ? err : new Error(String(err));
}

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

/**
 * OAuth client without a fixed redirect: the loopback URI is chosen per sign-in.
 * fixedPort is set only when the user (or an old install) pinned a port.
 */
function getOAuthClient() {
  loadEnvFile();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }
  const pinned = Number(process.env.OAUTH_REDIRECT_PORT);
  const google = getGoogle();
  return {
    // Desktop clients send client_secret too: Google's token endpoint still requires it.
    oauth2: new google.auth.OAuth2(clientId, clientSecret),
    fixedPort: Number.isFinite(pinned) && pinned > 0 ? Math.round(pinned) : null,
  };
}

function loadSavedTokens() {
  return readSecretJson(tokensFile(), null);
}

function saveTokens(tokens) {
  writeSecretJson(tokensFile(), tokens);
}

/** Bumped on logout / credential change so late OAuth results are discarded. */
let authGeneration = 0;
/** @type {(() => void) | null} */
let cancelInteractiveLogin = null;

/** Drop the in-memory client (e.g. after Client ID / Secret change) and abort a pending login. */
function resetAuthClient() {
  authGeneration += 1;
  cachedClient = null;
  loginInFlight = null;
  if (cancelInteractiveLogin) cancelInteractiveLogin();
}

function clearTokens() {
  resetAuthClient();
  const file = tokensFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    writeSecretJson(file, {});
  }
}

/**
 * Best-effort revoke of the saved refresh token at Google, then clear it locally.
 * Never throws: logout must work offline too.
 */
async function revokeAndClearTokens() {
  const saved = loadSavedTokens();
  const token = saved && (saved.refresh_token || saved.access_token);
  if (token && hasGoogleCredentials()) {
    try {
      const { oauth2 } = getOAuthClient();
      await Promise.race([
        oauth2.revokeToken(token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('revoke timeout')), 5000)),
      ]);
    } catch (err) {
      console.warn('[auth] revoke failed:', err && err.message ? err.message : err);
    }
  }
  clearTokens();
}

function attachTokenSaver(oauth2) {
  const generation = authGeneration;
  oauth2.on('tokens', (tokens) => {
    if (generation !== authGeneration) return;
    const merged = { ...(loadSavedTokens() || {}), ...tokens };
    saveTokens(merged);
  });
}

function isPackagedApp() {
  try {
    const { app } = require('electron');
    return Boolean(app && app.isPackaged);
  } catch {
    return false; // plain node (tests)
  }
}

function openAuthUrl(authUrl) {
  // Dev / automated checks only: drive the loopback callback without a real browser.
  // Ignored in packaged builds so a stray environment variable can't silently break sign-in.
  if (process.env.GT_OAUTH_NO_BROWSER && !isPackagedApp()) {
    console.log('[auth] browser suppressed (GT_OAUTH_NO_BROWSER); sign-in URL:', authUrl);
    return Promise.resolve();
  }
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

  const { oauth2, fixedPort } = getOAuthClient();
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
  const generation = authGeneration;
  const flight = interactiveLogin(oauth2, fixedPort)
    .then((client) => {
      if (generation !== authGeneration) throw new Error('Вход в Google отменён');
      cachedClient = client;
      return client;
    })
    .finally(() => {
      if (loginInFlight === flight) loginInFlight = null;
    });
  loginInFlight = flight;
  return flight;
}

/** Auth URL of the sign-in currently waiting for the browser (for «open again» / «copy link»). */
let pendingAuthUrl = null;

function getPendingLoginUrl() {
  return pendingAuthUrl;
}

/** Re-open the pending sign-in page (the user closed the tab or the browser did not open). */
function reopenLoginInBrowser() {
  if (!pendingAuthUrl) return false;
  openAuthUrl(pendingAuthUrl).catch(() => {});
  return true;
}

/** Abort the sign-in waiting for the browser; the pending login rejects with code «cancelled». */
function cancelLogin() {
  if (!cancelInteractiveLogin) return false;
  cancelInteractiveLogin();
  return true;
}

/** Callback page shown in the browser after Google redirects back. */
function callbackPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>Glass Tasks</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;
}

/**
 * Loopback + PKCE sign-in in the system browser.
 * Listens on fixedPort when one is pinned, otherwise on a free port picked by the OS;
 * a busy pinned port falls back to a free one (Desktop clients accept any loopback port).
 */
function interactiveLogin(oauth2, fixedPort) {
  return new Promise((resolve, reject) => {
    const state = randomUrlSafe(24);
    const codeVerifier = randomUrlSafe(64);
    const codeChallenge = pkceChallengeS256(codeVerifier);
    /** @type {string} */
    let redirectUri = '';

    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    const generation = authGeneration;
    const finish = (err, client) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancelInteractiveLogin === cancel) cancelInteractiveLogin = null;
      pendingAuthUrl = null;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(client);
    };
    const cancel = () => finish(codedError('Вход в Google отменён', 'cancelled'));
    cancelInteractiveLogin = cancel;

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        // Anything without our state is not Google's redirect (another page or program poking
        // the well-known loopback port): answer 400 and keep waiting for the real one.
        if (!returnedState || returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackPage('Запрос не принят', 'Это не ответ Google для текущего входа. Вернитесь в виджет.'));
          return;
        }
        const errParam = url.searchParams.get('error');
        if (errParam) {
          // Never echo Google's raw string into the widget: map it, or use a fixed text.
          const mapped = describeAuthError(errParam);
          const message = mapped
            ? mapped.message
            : 'Google отклонил вход. Попробуйте снова или проверьте настройки клиента.';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackPage('Вход не выполнен', message));
          const failure = codedError(message, mapped ? mapped.code : /^[a-z_]{1,64}$/.test(errParam) ? errParam : 'oauth_error');
          if (mapped && mapped.actionUrl) {
            failure.actionUrl = mapped.actionUrl;
            failure.actionLabel = mapped.actionLabel;
          }
          finish(failure);
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackPage('Нет кода авторизации', 'Закройте окно и войдите снова из виджета.'));
          finish(new Error('OAuth: нет кода авторизации'));
          return;
        }
        const { tokens } = await oauth2.getToken({ code, codeVerifier, redirect_uri: redirectUri });
        if (settled || generation !== authGeneration) {
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackPage('Вход отменён', 'Закройте окно и войдите снова из виджета.'));
          return;
        }
        oauth2.setCredentials(tokens);
        attachTokenSaver(oauth2);
        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Готово', 'Можно закрыть это окно и вернуться к виджету.'));
        finish(null, oauth2);
      } catch (e) {
        const mapped = classifyExchangeError(e);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Вход не выполнен', mapped.message));
        finish(mapped);
      }
    });

    timer = setTimeout(() => {
      finish(codedError('Не дождались ответа из браузера (3 мин).', 'timeout'));
    }, OAUTH_TIMEOUT_MS);

    const onListening = () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : fixedPort;
      redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      pendingAuthUrl = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
      });
      openAuthUrl(pendingAuthUrl).catch(() => {
        console.error('Could not open browser for OAuth. Redirect port:', port);
      });
    };

    let triedFallback = false;
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && fixedPort && !triedFallback) {
        triedFallback = true;
        console.warn(`[auth] port ${fixedPort} busy, using a free port`);
        server.listen(0, '127.0.0.1');
        return;
      }
      finish(e);
    });
    server.on('listening', onListening);
    server.listen(fixedPort || 0, '127.0.0.1');
  });
}

module.exports = {
  SCOPES,
  INVALID_GRANT_USER_MESSAGE,
  getAuthorizedClient,
  hasGoogleCredentials,
  clearTokens,
  revokeAndClearTokens,
  resetAuthClient,
  cancelLogin,
  reopenLoginInBrowser,
  getPendingLoginUrl,
  loadSavedTokens,
  isInvalidGrantError,
  normalizeGoogleAuthError,
  classifyExchangeError,
  /** Exposed for unit tests only. */
  _test: { interactiveLogin },
};
