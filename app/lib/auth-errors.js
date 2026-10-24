'use strict';

/**
 * Google OAuth / API failures → short Russian text with a concrete next step.
 * Pure (no Electron), so the main process, data layer and tests share it.
 */

const CONSOLE = 'https://console.cloud.google.com';

/** Links the onboarding wizard and error messages point to. */
const CONSOLE_LINKS = {
  enableApi: `${CONSOLE}/flows/enableapi?apiid=tasks.googleapis.com`,
  branding: `${CONSOLE}/auth/branding`,
  audience: `${CONSOLE}/auth/audience`,
  clients: `${CONSOLE}/auth/clients`,
};

/** @param {unknown} err */
function errorBits(err) {
  if (!err) return { codes: [], text: '', project: null, syscall: '' };
  if (typeof err === 'string') return { codes: [err.toLowerCase()], text: err, project: null, syscall: '' };
  const e = /** @type {any} */ (err);
  const data = e.response && e.response.data;
  const apiErr = data && typeof data.error === 'object' ? data.error : null;
  const codes = [
    typeof e.code === 'string' ? e.code : '',
    data && typeof data.error === 'string' ? data.error : '',
    ...((apiErr && Array.isArray(apiErr.errors) ? apiErr.errors : []).map((x) => x && x.reason)),
    ...((apiErr && Array.isArray(apiErr.details) ? apiErr.details : []).map((x) => x && x.reason)),
  ]
    .filter((c) => typeof c === 'string' && c)
    .map((c) => c.toLowerCase());
  const text = [
    e.message,
    data && data.error_description,
    apiErr && apiErr.message,
  ]
    .filter((t) => typeof t === 'string')
    .join(' ');
  let project = null;
  const fromText = text.match(/project[ s/]+(\d{4,})/i);
  if (fromText) project = fromText[1];
  for (const d of (apiErr && Array.isArray(apiErr.details) ? apiErr.details : [])) {
    const consumer = d && d.metadata && d.metadata.consumer;
    const m = typeof consumer === 'string' && consumer.match(/projects\/(\d+)/);
    if (m) project = m[1];
  }
  return { codes, text, project, syscall: typeof e.syscall === 'string' ? e.syscall : '' };
}

/**
 * @param {unknown} err
 * @returns {{ code: string, message: string, actionUrl?: string, actionLabel?: string } | null}
 *   null when the error is not a recognised auth / setup problem.
 */
function describeAuthError(err) {
  const { codes, text, project, syscall } = errorBits(err);
  const has = (...names) => names.some((n) => codes.includes(n));
  const says = (re) => re.test(text);

  if (has('cancelled')) {
    return { code: 'cancelled', message: 'Вход в Google отменён.' };
  }
  if (has('timeout')) {
    return {
      code: 'timeout',
      message:
        'Не дождались ответа из браузера. Если Google показал ошибку — проверьте шаги настройки и попробуйте снова.',
    };
  }
  if (has('access_denied')) {
    // Google redirects back with access_denied only when the user pressed «Отмена» on its
    // consent screen. Setup errors («Access blocked», test users) never redirect — those are
    // explained by the hint shown while waiting for the browser.
    return {
      code: 'access_denied',
      message:
        'Вы не разрешили доступ к Google Tasks. Нажмите «Google» и разрешите его ещё раз. Если в браузере была ошибка «Access blocked» — добавьте себя в Test users или опубликуйте приложение (Audience → Publish app).',
    };
  }
  if (has('invalid_client', 'unauthorized_client', 'deleted_client') || says(/OAuth client was not found/i)) {
    return {
      code: 'invalid_client',
      message:
        'Google не узнал Client ID или Client Secret. Откройте ⚙ → Google API ключи и загрузите client_secret.json заново. Google удаляет клиенты, которыми не пользовались 6 месяцев.',
      actionUrl: CONSOLE_LINKS.clients,
      actionLabel: 'Открыть клиенты',
    };
  }
  if (has('accessnotconfigured', 'service_disabled') || says(/has not been used in project|is disabled\. Enable it/i)) {
    return {
      code: 'api_disabled',
      message: 'В вашем проекте Google Cloud не включён Google Tasks API. Включите его и нажмите ↻ (Google применяет это за пару минут).',
      actionUrl: project
        ? `${CONSOLE}/apis/api/tasks.googleapis.com/overview?project=${project}`
        : CONSOLE_LINKS.enableApi,
      actionLabel: 'Включить Tasks API',
    };
  }
  if (has('admin_policy_enforced', 'org_internal')) {
    return {
      code: 'admin_policy',
      message: 'Доступ запрещён политикой Google Workspace вашей организации. Обратитесь к администратору или войдите личным аккаунтом.',
    };
  }
  if (has('rate_limit_exceeded')) {
    return { code: 'rate_limit', message: 'Google временно ограничил новые входы. Попробуйте через несколько минут.' };
  }
  // Only a bind failure of the loopback sign-in port (Node marks it syscall 'listen'). The same
  // codes come from an outbound connection blocked by a firewall (connect EACCES) or a locked
  // file (EPERM): there the port advice would point at the wrong setting.
  if (syscall === 'listen' && has('eaddrinuse', 'eacces', 'eperm', 'eaddrnotavail')) {
    return {
      code: 'port_busy',
      message:
        'Порт для входа занят или недоступен (Windows может резервировать порты). Очистите поле порта в ключах Google: тогда порт выберется автоматически.',
    };
  }
  return null;
}

module.exports = { describeAuthError, CONSOLE_LINKS };
