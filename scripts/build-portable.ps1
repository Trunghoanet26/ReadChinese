# Builds a runnable ReadChinese (build\ReadChinese\ReadChinese.exe) WITHOUT Node.js/npm.
# Downloads the Windows Electron runtime from GitHub and copies the app source into it.
param([switch]$NoShortcut, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ver  = 'v33.4.11'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root 'build\ReadChinese'
$zip  = Join-Path $env:TEMP "electron-$ver-win32-x64.zip"
$nsVer = '0.2.8'
$nsTgz = Join-Path $env:TEMP "node-screenshots-win32-x64-msvc-$nsVer.tgz"

Write-Host "[1/4] Downloading Electron $ver (~110MB, first time only)..."
if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 100MB) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/$ver/electron-$ver-win32-x64.zip" -OutFile $zip -UseBasicParsing
}

Write-Host '[2/4] Extracting...'
Get-Process ReadChinese -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dest -Force
Rename-Item (Join-Path $dest 'electron.exe') 'ReadChinese.exe'
Remove-Item (Join-Path $dest 'resources\default_app.asar') -ErrorAction SilentlyContinue

Write-Host '[2b] Downloading native screen capture module (node-screenshots, ~1MB)...'
try {
  if (-not (Test-Path $nsTgz)) {
    Invoke-WebRequest -Uri "https://registry.npmjs.org/node-screenshots-win32-x64-msvc/-/node-screenshots-win32-x64-msvc-$nsVer.tgz" -OutFile $nsTgz -UseBasicParsing
  }
  $nsTmp = Join-Path $env:TEMP "rc-ns-$nsVer"
  if (Test-Path $nsTmp) { Remove-Item $nsTmp -Recurse -Force }
  New-Item -ItemType Directory -Force $nsTmp | Out-Null
  tar -xzf $nsTgz -C $nsTmp
  $nativeDir = Join-Path $root 'native'
  New-Item -ItemType Directory -Force $nativeDir | Out-Null
  Copy-Item (Join-Path $nsTmp 'package\node-screenshots.win32-x64-msvc.node') $nativeDir -Force
} catch {
  Write-Host "  (Download failed - the app will fall back to Electron capture: $($_.Exception.Message))" -ForegroundColor Yellow
}

Write-Host '[3/4] Copying app source...'
$app = Join-Path $dest 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'src')          $app -Recurse
Copy-Item (Join-Path $root 'assets')       $app -Recurse
Copy-Item (Join-Path $root 'package.json') $app
if (Test-Path (Join-Path $root 'native')) { Copy-Item (Join-Path $root 'native') $app -Recurse }
New-Item -ItemType Directory -Force (Join-Path $dest 'resources\python') | Out-Null
Copy-Item (Join-Path $root 'python\*') (Join-Path $dest 'resources\python') -Include *.py, requirements.txt

$exe = Join-Path $dest 'ReadChinese.exe'
if (-not $NoShortcut) {
  Write-Host '[4/4] Creating Desktop shortcut...'
  $ws  = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ReadChinese.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = (Join-Path $app 'assets\icon.ico')
  $lnk.Save()
}

Write-Host ''
Write-Host "DONE! $exe" -ForegroundColor Green
if (-not $NoLaunch) { Start-Process $exe }
