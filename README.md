# Glass Tasks Widget

Десктоп-виджет Tasks ↔ Habits со стеклянным UI (по утверждённому демо).

## Почему Electron, а не Windows Widgets / Tauri

- **Windows Widgets** плохо подходит под glassmorphism, кастомную анимацию слайда и всегда-поверх-окон поведение демо.
- **Tauri** предпочтительнее по весу, но на этой машине нет Rust/MSVC toolchain — сборка была бы блокером.
- **Electron** даёт тот же WebView/CSS (`backdrop-filter`, transition Tasks↔Habits) и быстрый always-on-top прозрачный мини-окно на Windows 10/11.

Макеты и интерактивное HTML-демо лежат в [`mockups/`](./mockups/). Рабочее приложение — в [`app/`](./app/).

## Быстрый старт (демо без Google)

```powershell
cd C:\Users\User\Desktop\GlassTasksWidget\app
npm install
npm start
```

Без файла `.env` виджет запускается в **mock-режиме** с демо-задачами и локальными стриками.

## Google Tasks (реальные данные)

1. [Google Cloud Console](https://console.cloud.google.com/) → создайте проект.
2. Включите **Google Tasks API**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Скопируйте Client ID и Client Secret.
4. Настройте OAuth consent screen (External или Internal). Добавьте scope `https://www.googleapis.com/auth/tasks` и тестового пользователя при необходимости.
5. В Google Tasks создайте два списка с именами из `app/config.json` (по умолчанию `Tasks` и `Habits`).
6. В папке `app`:

```powershell
Copy-Item .env.example .env
# Отредактируйте .env — вставьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET
npm start
```

7. В виджете нажмите **Google** → браузер → разрешите доступ. Токен сохранится в `app/data/tokens.json`.

### Конфиг (`app/config.json`)

| Поле | Описание |
|------|----------|
| `tasksListName` | Имя списка задач в Google Tasks |
| `habitsListName` | Имя списка привычек |
| `accentColor` | Акцент (по умолчанию `#C4122E` с обоев) |
| `window.*` | Размер, alwaysOnTop, skipTaskbar |

### Стрики привычек

История выполнений хранится локально в `app/data/streaks.json`. При отметке привычки обновляется Google Task **и** локальный стрик (week strip из 7 day-pills + бейдж «N дн.»).

## Структура

```
GlassTasksWidget/
  app/                 # Electron-приложение
    electron/          # main + preload
    lib/               # config, Google OAuth/Tasks, streaks, mock
    src/               # UI (HTML/CSS/JS как в демо)
    config.json
    .env.example
  mockups/             # утверждённые макеты + single-block-widget-demo.html
  README.md
```

## Отложено (не v1)

- Нативный Windows Widgets provider
- Миграция на Tauri после установки Rust/MSVC
- Автосэмплинг палитры с обоев Windows
- Упаковка в установщик (.exe / MSIX)
- Создание/удаление задач из виджета (только complete / uncomplete)
- Синхронизация стриков в облако
