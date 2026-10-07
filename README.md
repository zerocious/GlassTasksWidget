# Glass Tasks Widget

Десктоп-виджет **Tasks ↔ Habits** со стеклянным UI на Electron. Синхронизация с **Google Tasks** или локальный **демо-режим** (mock) без ключей.

Макеты: [`mockups/`](./mockups/). Приложение: [`app/`](./app/).

## Быстрый старт

**Уже собрано** — ярлык на Desktop (`Glass Tasks Widget.lnk`), обычно на `app\dist\win-unpacked\…` или установленный exe.

**Из исходников:**

```powershell
cd C:\Users\User\Desktop\GlassTasksWidget\app
npm install
npm start
```

**Установщик / unpacked:**

```powershell
cd C:\Users\User\Desktop\GlassTasksWidget\app
npm install
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist    # NSIS → app\dist\Glass Tasks Widget-Setup-1.0.0.exe + ярлык
# или
npm run pack    # app\dist\win-unpacked\ + ярлык
```

После `dist` / `pack` скрипт `scripts/update-desktop-shortcut.ps1` обновляет ярлык на Desktop (и Start Menu). Только ярлык: `npm run shortcut`.

Если ошибка `winCodeSign` / symbolic link — включите **Режим разработчика** Windows и повторите. В конфиге `signAndEditExecutable: false`. Если `app.asar` занят — закройте виджет, удалите `app\dist`, снова `npm run dist`.

| Команда | Результат |
|---------|-----------|
| `npm start` / `npm run dev` | Запуск из исходников |
| `npm run dist` / `npm run build:win` | NSIS-установщик + автоярлык |
| `npm run pack` / `npm run pack:desktop` | `win-unpacked/` + автоярлык |
| `npm run shortcut` | Только обновить ярлык |
| `npm test` | Юнит-тесты (`node:test`, папка `app/test/`) |
| `npm run lint` | ESLint |

Чтобы запустить dev-сборку рядом с установленным виджетом (отдельные настройки, токены и single-instance lock), укажите отдельный профиль:

```powershell
$env:GT_USER_DATA_DIR = "$env:TEMP\gt-dev"
npm start
```

Dev-запуск не перезаписывает существующие ярлыки «Glass Tasks Widget».

## Первый запуск (Google)

Ручной `.env` **не нужен** для обычных пользователей.

1. При старте без ключей — онбординг: **Client ID / Secret** (опционально порт redirect) или **«Продолжить в демо»**.
2. Ключи сохраняются в `data\credentials.json`, зашифрованными через Electron `safeStorage` (DPAPI). `.env`, который писали старые версии, при первом запуске переносится туда и удаляется.
3. Позже: Настройки → **Google API ключи**. Затем кнопка **Google** для OAuth.

Разработчики по-прежнему могут скопировать `app/.env.example` → `.env` (читаются только `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_PORT`; ключи из `credentials.json` имеют приоритет).

## Возможности

- **Tasks ↔ Habits** — табы, слайд, свайп; у привычек week-strip стриков и иконки по ключевым словам в названии
- **Добавление** — поле внизу панели (Google API или mock)
- **ПКМ по строке** — изменить / удалить (с подтверждением)
- **Сроки** — today / overdue, сортировка; время из due (если не «полночь UTC») или из notes (`14:30`, `в 14:30`, `time: …`, `время …`)
- **Офлайн-кэш** — при сбое сети последние Google-данные + бейдж «офлайн»
- **Автопалитра с обоев** — акцент из wallpaper Windows; тумблер и кнопка «С обоев»
- **Трей** — показать/скрыть, вид, добавить, выход (кнопки **–** / **×** только скрывают в трей)
- **Шрифт** — **Geist Mono** (локальные файлы в `src/fonts/`)

### Настройки (⚙)

| Параметр | Описание |
|----------|----------|
| Тема стекла | Тёмная / Светлая |
| Размер | Обычный (380×460) / Компакт (300×360) |
| Прозрачность фона | Слайдер плотности стекла (`bgOpacity`, по умолчанию ~72%) |
| Автозапуск | С Windows (`setLoginItemSettings`) |
| Прилипание к краю | После перетаскивания — к ближайшему краю |
| Напоминания | Точное время + sweep ~45 мин (см. ниже) |
| Сброс привычек | Каждый день `completed` → `needsAction` в Google |
| Проверить напоминания | Ручная проверка тоста |
| Обновления | auto-update с GitHub Releases (сборка) |
| Автопалитра с обоев | Акцент из текущего wallpaper |
| Google API ключи | Онбординг / смена Client ID·Secret |

### Напоминания

- **Точное время:** для открытых задач с локальным date+time (due не midnight-UTC, либо время из notes + дата due / сегодня) — one-shot таймер (горизонт 24 ч). Тост: «Пора: Title (14:30)».
- **Sweep ~45 мин:** safety net для date-only (today/overdue), просроченных timed и незакрытых привычек (без часов).
- Первый проход ~через 8 с после старта; таймеры пересобираются после refresh/мутаций; сбрасываются при выключении напоминаний / quit.
- Один и тот же пункт не спамит повторно в тот же день (`reminders.json`).
- **«Проверить»** — принудительный тост (игнорирует «уже уведомляли сегодня»).
- Если тостов нет: Параметры Windows → Система → Уведомления — разрешите приложение; отключите Фокусировку внимания.

### Привычки: ежедневный сброс

- Раз в локальные сутки (и при старте, если день новый): в списке Habits все `completed` → `needsAction` (Google API или mock). Стрики локальные — не трогаем.
- Тумблер в настройках (по умолчанию вкл.); дата последнего сброса — `lastHabitsResetDate` в `settings.json`.

### Автообновления

- Только **упакованная** сборка (`app.isPackaged`); `npm start` проверки пропускает.
- Провайдер: GitHub Releases (`zerocious/GlassTasksWidget`). NSIS `dist` пишет `latest.yml` + blockmap.
- Публикация: создайте GitHub Release с артефактами из `npm run dist` (Setup.exe, `.blockmap`, `latest.yml`). Без опубликованного релиза проверка ничего не найдёт.
- Сборка **без подписи** (`signAndEditExecutable: false`): SmartScreen может ругаться; updater отключает проверку publisher signature, иначе обновления не встанут. Для продакшена лучше code signing.

### Горячие клавиши

| Клавиши | Действие |
|---------|----------|
| **Ctrl+Alt+W** | Показать / скрыть |
| **Ctrl+Tab** | Tasks ↔ Habits (если занято → **Ctrl+Shift+Tab**) |

## Google Cloud

1. Включите **Google Tasks API**.
2. OAuth-клиент типа **Desktop**.
3. Пока приложение в статусе **Testing** — добавьте себя в **Test users**.
4. Redirect (loopback): `http://127.0.0.1:42813/oauth2callback`  
   Для Desktop обычно ничего дописывать не нужно; для Web-клиента — точный URI в Authorized redirect URIs.
5. В Google Tasks создайте списки с именами из `app/config.json` (по умолчанию `Tasks`, `Habits`).

OAuth: **state** + **PKCE (S256)**. Refresh-токен хранится зашифрованным; «Выйти» отзывает его в Google.

## Где лежат данные

| Что | Dev | Установка / Electron |
|-----|-----|----------------------|
| `.env` (необязательно, для разработки) | `app/.env` или `%APPDATA%\glass-tasks-widget\.env` | — |
| credentials, tokens, streaks, reminders, offline-cache, settings | `app/data/` | `%APPDATA%\glass-tasks-widget\data\` |

Типичные файлы: `tokens.json`, `streaks.json`, `reminders.json`, `offline-cache.json`, `settings.json`, `credentials.json`. `tokens.json` и `credentials.json` зашифрованы. Все файлы пишутся атомарно (временный файл, затем переименование). Повреждённый JSON не перезаписывается молча, а переименовывается в `*.corrupt-<время>`.

## Структура

```
GlassTasksWidget/
  app/
    electron/   # main (окно, трей, IPC), notifications, reminders, updater, preload
    lib/        # Google API, task-parse (время/повторы), list-ops, dates, streaks, settings, mock, offline, wallpaper
    test/       # node:test
    src/        # UI + Geist Mono fonts
    build/      # icon
    dist/       # вывод сборки
  mockups/
  README.md
```

## Отложено / ограничения

- Google Tasks чаще отдаёт **только дату** (без времени) — время в виджете из notes или нестандартного due
- Стрики привычек **локальные** (нет облачной синхронизации)
- Редактор горячих клавиш в UI
- Нативный Windows Widgets provider / Tauri
