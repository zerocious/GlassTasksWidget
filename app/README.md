# Glass Tasks Widget — приложение

Полное описание: корневой [README](../README.md).

```powershell
npm install
npm start
npm test        # юнит-тесты
npm run lint    # ESLint
```

**Первый запуск:** без Client ID/Secret — онбординг или «Продолжить в демо». Ключи → `data\credentials.json` (зашифрованы через `safeStorage`; ручной `.env` не обязателен). Позже: Настройки → Google API ключи.

## Сборка

Вывод в `dist/` (не `dist-ctx` / `dist-fresh`).

| Команда | Результат |
|---------|-----------|
| `npm run dist` / `npm run build:win` | NSIS + ярлык Desktop |
| `npm run pack` / `npm run pack:desktop` | `dist/win-unpacked/` + ярлык |
| `npm run shortcut` | Только обновить ярлык |

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist
```

После `pack` / `dist` — `scripts/update-desktop-shortcut.ps1` обновляет  
`%USERPROFILE%\Desktop\Glass Tasks Widget.lnk`. Установщик: Desktop + Start Menu, per-user.

Если `winCodeSign` / symlink — **Режим разработчика** Windows. См. корневой README: данные, вход в Google (порт выбирается автоматически), напоминания (точное время + sweep), ежедневный сброс привычек, автообновления с GitHub Releases, автопалитра.
