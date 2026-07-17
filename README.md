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

При первом запуске без ключей виджет покажет **онбординг** (Client ID / Secret) или кнопку «Продолжить в демо». Ручной `.env` больше не обязателен для обычных пользователей — ключи сохраняются в `%APPDATA%\glass-tasks-widget\.env` (и `data/credentials.json`).

## Сборка установщика (.exe)

```powershell
cd C:\Users\User\Desktop\GlassTasksWidget\app
npm install
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist
```

Готовый установщик: `app\dist\Glass Tasks Widget-Setup-1.0.0.exe`

После каждой сборки (`npm run dist` / `npm run pack`) ярлык на Desktop **обновляется автоматически**  
(`scripts/update-desktop-shortcut.ps1` → `dist\win-unpacked\...` или установленный exe).

Если ошибка `winCodeSign` / symbolic link — включите **Режим разработчика** Windows и повторите. В конфиге `signAndEditExecutable: false`. Если `app.asar` занят — закройте запущенный виджет и удалите `app\dist`, затем снова `npm run dist`.

| Команда | Результат |
|---------|-----------|
| `npm run dist` / `npm run build:win` | NSIS-установщик + автоярлык Desktop |
| `npm run pack` / `npm run pack:desktop` | `app/dist/win-unpacked/` + автоярлык |
| `npm run shortcut` | Только обновить ярлык |

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
| Прозрачность фона | Слайдер плотности стекла (`bgOpacity`, по умолчанию ~72%) |
| Автозапуск с Windows | `setLoginItemSettings` |
| Прилипание к краю | После перетаскивания — к ближайшему краю (лево/право/верх) |
| Напоминания | Windows toast: просроченные / на сегодня / незакрытые привычки (раз в ~45 мин, без повтора в тот же день) |

### Горячие клавиши

| Клавиши | Действие |
|---------|----------|
| **Ctrl+Alt+W** | Показать / скрыть |
| **Ctrl+Tab** | Tasks ↔ Habits (если занято → **Ctrl+Shift+Tab**) |

Кнопки **–** / **×** скрывают виджет в трей (полный выход — пункт «Выход» в меню трея).

## Google Tasks

1. Google Cloud → Tasks API → OAuth Desktop client.
2. Списки с именами из `app/config.json` (`Tasks`, `Habits`).
3. При первом запуске введите Client ID / Secret в UI виджета (или Настройки → **Google API ключи**), затем кнопка **Google**.
4. Альтернатива для разработчиков: `Copy-Item .env.example .env` → вставьте ключи → `npm start`.

Ключи: `%APPDATA%\glass-tasks-widget\.env` (установка) или `app/.env` / AppData в dev. Токены: `app/data/tokens.json` (dev) или AppData (установка). Стрики: `streaks.json` (локально).

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
