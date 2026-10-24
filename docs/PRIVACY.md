# Политика конфиденциальности Glass Tasks Widget

*Privacy policy in English: see the second half of this page.*

Обновлено: 14 октября 2026.

Glass Tasks Widget — настольное приложение для Windows, которое показывает ваши задачи из
Google Tasks и ведёт локальные привычки. У приложения **нет сервера разработчика**: ваши данные не
отправляются разработчику и третьим лицам.

## Какие данные использует приложение

| Данные | Откуда | Зачем | Где хранятся |
|---|---|---|---|
| Задачи и списки Google Tasks (названия, заметки, сроки, статусы) | Google Tasks API по вашему разрешению (`https://www.googleapis.com/auth/tasks`) | показать задачи, создавать и менять их по вашему действию, напоминания | в Google; копия последней загрузки на вашем компьютере (офлайн-режим) |
| Токен доступа (refresh token) | Google при входе | чтобы не входить каждый раз | на вашем компьютере, зашифрован средствами Windows (DPAPI) |
| Ключи OAuth-клиента (Client ID и Secret) | вы | вход в Google | на вашем компьютере, зашифрованы |
| Настройки, история выполнения привычек, отметки отправленных напоминаний | вы | работа приложения | на вашем компьютере |
| Журнал работы (ошибки, версии) | приложение | диагностика | на вашем компьютере; токены, ключи, коды входа и имя пользователя Windows из него вычищаются |

Данные профиля Google (имя, почта, фото) приложение **не запрашивает и не хранит**.

## Что приложение не делает

- не отправляет данные разработчику: нет аналитики, телеметрии, рекламы, отчётов об ошибках;
- не передаёт данные третьим лицам, не продаёт и не использует их для рекламы или обучения моделей;
- общается только с серверами Google (вход и Google Tasks API) и GitHub (проверка обновлений
  приложения; передаются версия и стандартные данные HTTPS-запроса).

Использование полученных от Google данных соответствует
[Политике использования данных пользователей Google API](https://developers.google.com/terms/api-services-user-data-policy),
включая требования ограниченного использования (Limited Use).

## Как отозвать доступ и удалить данные

- **Выйти** в приложении отзывает токен в Google и удаляет его с компьютера.
- Доступ можно отозвать и на странице https://myaccount.google.com/permissions.
- Локальные данные лежат в `%APPDATA%\glass-tasks-widget` (журнал в подпапке `logs`). Удалите
  папку после удаления программы, чтобы стереть их полностью.
- Ваши задачи остаются в Google Tasks; удалить их можно только там.

## Вопросы

Откройте обращение: https://github.com/zerocious/GlassTasksWidget-releases/issues

---

# Privacy policy (English)

Updated: 14 October 2026.

Glass Tasks Widget is a Windows desktop app that shows your Google Tasks and keeps local habit
streaks. It has **no developer-operated server**: your data is not sent to the developer or any
third party.

**Data used.** Google Tasks content (titles, notes, due dates, status) via the Google Tasks API
(`https://www.googleapis.com/auth/tasks`), only with your consent, to display and change your
tasks and to show reminders. A refresh token and your OAuth client keys, encrypted with Windows
DPAPI, stay on your computer, as do settings, habit history and a copy of your last task list for
offline use. A local log (secrets and your Windows user name are removed) helps diagnose problems.
The app does not request or store your Google profile (name, email, photo).

**What it does not do.** No analytics, telemetry, advertising or crash reporting; no sale or sharing
of data; no use of Google data for advertising or to train AI models. It talks only to Google
(sign-in and Google Tasks API) and GitHub (update checks).

The app's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

**Revoking access and deleting data.** "Выйти" (sign out) revokes the token at Google and deletes
it locally; you can also revoke access at https://myaccount.google.com/permissions. Local data
lives in `%APPDATA%\glass-tasks-widget`; delete that folder after uninstalling. Your tasks stay in
Google Tasks.

**Contact.** https://github.com/zerocious/GlassTasksWidget-releases/issues
