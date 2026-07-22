# Recreate Desktop (+ Start Menu) shortcuts for Glass Tasks Widget after a build.
# Delegates to Electron writeShortcutLink so AppUserModelID is set (required for toasts).
# Prefer: npm run shortcut

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $AppRoot
& npx --yes electron ./scripts/write-shortcuts.js @args
exit $LASTEXITCODE
