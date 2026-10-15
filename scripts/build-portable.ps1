# Dung ban ReadChinese chay duoc (thu muc build\ReadChinese\ReadChinese.exe) ma KHONG can Node.js/npm.
# Tai Electron ban Windows tu GitHub roi chep source cua app vao.
param([switch]$NoShortcut, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ver  = 'v33.4.11'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root 'build\ReadChinese'
$zip  = Join-Path $env:TEMP "electron-$ver-win32-x64.zip"

Write-Host "[1/4] Tai Electron $ver (~110MB, chi tai lan dau)..."
if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 100MB) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/$ver/electron-$ver-win32-x64.zip" -OutFile $zip -UseBasicParsing
}

Write-Host '[2/4] Giai nen...'
Get-Process ReadChinese, PotPinyin -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dest -Force
Rename-Item (Join-Path $dest 'electron.exe') 'ReadChinese.exe'
Remove-Item (Join-Path $dest 'resources\default_app.asar') -ErrorAction SilentlyContinue

Write-Host '[3/4] Chep source app...'
$app = Join-Path $dest 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'src')          $app -Recurse
Copy-Item (Join-Path $root 'assets')       $app -Recurse
Copy-Item (Join-Path $root 'package.json') $app
New-Item -ItemType Directory -Force (Join-Path $dest 'resources\python') | Out-Null
Copy-Item (Join-Path $root 'python\*') (Join-Path $dest 'resources\python') -Include *.py, requirements.txt

$exe = Join-Path $dest 'ReadChinese.exe'
if (-not $NoShortcut) {
  Write-Host '[4/4] Tao shortcut ngoai Desktop...'
  $ws  = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ReadChinese.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = (Join-Path $app 'assets\icon.ico')
  $lnk.Save()
}

Write-Host ''
Write-Host "XONG! $exe" -ForegroundColor Green
if (-not $NoLaunch) { Start-Process $exe }
