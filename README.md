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

## Сборка установщика (.exe)

```powershell
cd C:\Users\User\Desktop\GlassTasksWidget\app
npm install
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist
```

Готовый установщик: `app\dist\Glass Tasks Widget-Setup-1.0.0.exe`

Если ошибка `winCodeSign` / symbolic link — включите **Режим разработчика** Windows и повторите. В конфиге `signAndEditExecutable: false`. Если `app.asar` занят — закройте запущенный виджет и удалите `app\dist`, затем снова `npm run dist`.

| Команда | Результат |
|---------|-----------|
| `npm run dist` | NSIS-установщик в `app/dist/` |
| `npm run pack` | `app/dist/win-unpacked/` без инсталлятора |

Установленная версия: `.env` и данные в `%APPDATA%\glass-tasks-widget\` (см. `.env.example` в ресурсах).

## Возможности

- **Tasks ↔ Habits** — слайд, табы, свайп, стрик week-strip
- **Добавление** — поле «Новая задача / привычка» внизу панели (Google API или mock)
- **Сроки** — today / overdue подсветка и сортировка в Tasks
- **Офлайн-кэш** — при сбое сети показываются последние Google-данные + бейдж «офлайн»
- **Трей** — иконка в системном трее: показать/скрыть, переключение вида, добавить, выход
- **Настройки (⚙)** — тема, размер, автозапуск, прилипание

### Настройки

| Параметр | Описание |
|----------|----------|
| Тема стекла | Тёмная / Светлая |
| Размер | Обычный (380×460) / Компакт (300×360) |
| Автозапуск с Windows | `setLoginItemSettings` |
| Прилипание к краю | После перетаскивания — к ближайшему краю (лево/право/верх) |

### Горячие клавиши

| Клавиши | Действие |
|---------|----------|
| **Ctrl+Alt+W** | Показать / скрыть |
| **Ctrl+Tab** | Tasks ↔ Habits (если занято → **Ctrl+Shift+Tab**) |

Кнопки **–** / **×** скрывают виджет в трей (полный выход — пункт «Выход» в меню трея).

## Google Tasks

1. Google Cloud → Tasks API → OAuth Desktop client.
2. Списки с именами из `app/config.json` (`Tasks`, `Habits`).
3. `Copy-Item .env.example .env` → вставьте Client ID/Secret → `npm start` → кнопка **Google**.

Токены: `app/data/tokens.json` (dev) или AppData (установка). Стрики: `streaks.json` (локально, не зависят от офлайн-кэша задач).

OAuth loopback использует **state** + **PKCE (S256)** против CSRF при входе.

## Структура

```
GlassTasksWidget/
  app/
    electron/   # main, preload, tray, hotkeys
    lib/        # Google, streaks, settings, mock, offline-cache
    src/        # UI
    build/      # icon.png для трея / сборки
    dist/       # installer output
  mockups/
  README.md
```

## Отложено

- Нативный Windows Widgets provider / Tauri
- Автосэмплинг палитры с обоев
- Удаление задач из виджета
- Редактор горячих клавиш в UI
- Облачная синхронизация стриков
