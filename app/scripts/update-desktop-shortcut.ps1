# Recreate Desktop (+ Start Menu) shortcut for Glass Tasks Widget after a build.
# App sets AppUserModelID on the .lnk at launch (required for Windows toasts).

$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$ShortcutName = 'Glass Tasks Widget.lnk'
$DesktopShortcut = Join-Path $Desktop $ShortcutName
$StartMenuShortcut = Join-Path $StartMenu $ShortcutName
$ProductName = 'Glass Tasks Widget'
$ExeName = "$ProductName.exe"

$Candidates = @(
  (Join-Path $AppRoot "dist\win-unpacked\$ExeName"),
  (Join-Path $AppRoot "dist-fresh\win-unpacked\$ExeName"),
  (Join-Path $AppRoot "dist-build\win-unpacked\$ExeName"),
  (Join-Path $env:LOCALAPPDATA "Programs\glass-tasks-widget\$ExeName"),
  (Join-Path $env:LOCALAPPDATA "Programs\$ProductName\$ExeName")
)

$Target = $null
$BestTime = [DateTime]::MinValue
foreach ($c in $Candidates) {
  if (Test-Path -LiteralPath $c) {
    $write = (Get-Item -LiteralPath $c).LastWriteTime
    if ($write -ge $BestTime) {
      $BestTime = $write
      $Target = (Resolve-Path -LiteralPath $c).Path
    }
  }
}

if (-not $Target) {
  Write-Warning "Executable not found. Tried:`n  $($Candidates -join "`n  ")"
  exit 1
}

$WorkDir = Split-Path -Parent $Target

function New-AppShortcut([string]$Path, [string]$TargetPath, [string]$WorkingDirectory) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $Wsh = New-Object -ComObject WScript.Shell
  $Shortcut = $Wsh.CreateShortcut($Path)
  $Shortcut.TargetPath = $TargetPath
  $Shortcut.WorkingDirectory = $WorkingDirectory
  $Shortcut.WindowStyle = 1
  $Shortcut.Description = $ProductName
  if (Test-Path -LiteralPath $TargetPath) {
    $Shortcut.IconLocation = "$TargetPath,0"
  }
  $Shortcut.Save()
}

New-AppShortcut -Path $DesktopShortcut -TargetPath $Target -WorkingDirectory $WorkDir
New-AppShortcut -Path $StartMenuShortcut -TargetPath $Target -WorkingDirectory $WorkDir

Write-Host "Desktop shortcut updated:"
Write-Host "  $DesktopShortcut"
Write-Host "  -> $Target"
Write-Host "Start Menu shortcut updated:"
Write-Host "  $StartMenuShortcut"
Write-Host "Note: AppUserModelID (com.glasstasks.widget) is applied when the app starts."
