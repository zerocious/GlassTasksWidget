# Best-effort: stop running widget and clear dist/ so electron-builder can write.
$ErrorActionPreference = 'SilentlyContinue'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

Get-Process -Name 'Glass Tasks Widget' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

if (Test-Path -LiteralPath 'dist') {
  Remove-Item -LiteralPath 'dist' -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath 'dist') {
  Write-Warning "dist/ is locked. Build may use a temporary folder or fail — close any handle to dist\\win-unpacked and retry."
  exit 0
}
Write-Host "dist/ cleared"
