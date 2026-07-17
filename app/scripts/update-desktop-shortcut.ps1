# Recreate Desktop shortcut for Glass Tasks Widget after a build.
# Prefers: dist/win-unpacked exe (dev/pack), else installed LocalAppData path.

$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'Glass Tasks Widget.lnk'
$ProductName = 'Glass Tasks Widget'
$ExeName = "$ProductName.exe"

$Candidates = @(
  (Join-Path $AppRoot "dist\win-unpacked\$ExeName"),
  (Join-Path $AppRoot "dist-build\win-unpacked\$ExeName"),
  (Join-Path $env:LOCALAPPDATA "Programs\glass-tasks-widget\$ExeName"),
  (Join-Path $env:LOCALAPPDATA "Programs\$ProductName\$ExeName")
)

$Target = $null
foreach ($c in $Candidates) {
  if (Test-Path -LiteralPath $c) {
    $Target = (Resolve-Path -LiteralPath $c).Path
    break
  }
}

if (-not $Target) {
  Write-Warning "Executable not found. Tried:`n  $($Candidates -join "`n  ")"
  exit 1
}

$WorkDir = Split-Path -Parent $Target
$Wsh = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $WorkDir
$Shortcut.WindowStyle = 1
$Shortcut.Description = $ProductName
if (Test-Path -LiteralPath $Target) {
  $Shortcut.IconLocation = "$Target,0"
}
$Shortcut.Save()

Write-Host "Desktop shortcut updated:"
Write-Host "  $ShortcutPath"
Write-Host "  -> $Target"
