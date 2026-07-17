# Glass Tasks Widget — приложение

См. корневой [README](../README.md) для установки и Google OAuth.

```powershell
npm install
npm start
```

**Первый запуск:** если нет Google Client ID/Secret, виджет покажет форму онбординга (или «Продолжить в демо»). Ключи пишутся в `%APPDATA%\glass-tasks-widget\.env` — вручную править `.env` не нужно. Позже: Настройки → Google API ключи.

## Сборка

Стабильный вывод всегда в `dist/` (не `dist-ctx` / `dist-fresh`).

| Команда | Результат |
|---------|-----------|
| `npm run dist` / `npm run build:win` | NSIS-установщик + ярлык на Desktop |
| `npm run pack` / `npm run pack:desktop` | `dist/win-unpacked/` + ярлык на Desktop |
| `npm run shortcut` | Только обновить ярлык на Desktop |

После `pack` / `dist` скрипт `scripts/update-desktop-shortcut.ps1` пересоздаёт  
`%USERPROFILE%\Desktop\Glass Tasks Widget.lnk` → `dist\win-unpacked\Glass Tasks Widget.exe`  
(или установленный путь, если unpacked нет).

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist
```

Установщик: Desktop + Start Menu shortcuts, per-user (`perMachine: false`).

