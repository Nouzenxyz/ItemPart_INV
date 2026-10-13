$ErrorActionPreference = 'Stop'
$projectFolder = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeFolder = Join-Path $projectFolder '.runtime'
$pidFile = Join-Path $runtimeFolder 'server.pid'
$nodeOutput = Join-Path $runtimeFolder 'server.out.log'
$nodeError = Join-Path $runtimeFolder 'server.err.log'
$setupLog = Join-Path $runtimeFolder 'setup.log'
$messageBox = New-Object -ComObject WScript.Shell

function Show-Message([string]$message, [int]$style = 48) {
  $null = $messageBox.Popup($message, 0, 'Inventory application', $style)
}

try {
  Set-Location $projectFolder
  New-Item -ItemType Directory -Force -Path $runtimeFolder | Out-Null

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Show-Message 'Node.js LTS is not installed or is not on PATH. Install Node.js, then double-click Start Inventory again.'
    exit 1
  }

  if (Test-Path $pidFile) {
    $savedPid = 0
    [void][int]::TryParse((Get-Content $pidFile -Raw), [ref]$savedPid)
    $savedProcess = if ($savedPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue } else { $null }
    $entryPath = Join-Path $projectFolder 'dist\index.js'
    $isInventoryProcess = $savedProcess -and $savedProcess.ExecutablePath -eq $nodeCommand.Source -and $savedProcess.CommandLine.Contains($entryPath)
    if ($isInventoryProcess) {
      try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 2 -UseBasicParsing | Out-Null
        Start-Process 'http://localhost:3000'
        exit 0
      } catch {
        Show-Message 'The inventory server is already running. Open http://localhost:3000 in your browser.' 64
        exit 0
      }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path (Join-Path $projectFolder 'node_modules'))) {
    Show-Message 'First-time setup is starting. It will download the app dependencies and may take a few minutes.' 64
    $env:ITEMPART_SETUP_LOG = $setupLog
    $install = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c npm install > `"%ITEMPART_SETUP_LOG%`" 2>&1" -WorkingDirectory $projectFolder -WindowStyle Hidden -Wait -PassThru
    Remove-Item Env:ITEMPART_SETUP_LOG -ErrorAction SilentlyContinue
    if ($install.ExitCode -ne 0) {
      Show-Message "Setup could not install dependencies. Check the internet connection and see:`n$setupLog"
      exit 1
    }
  }

  if (-not (Test-Path (Join-Path $projectFolder 'dist\index.js'))) {
    $env:ITEMPART_SETUP_LOG = $setupLog
    $build = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c npm run build > `"%ITEMPART_SETUP_LOG%`" 2>&1" -WorkingDirectory $projectFolder -WindowStyle Hidden -Wait -PassThru
    Remove-Item Env:ITEMPART_SETUP_LOG -ErrorAction SilentlyContinue
    if ($build.ExitCode -ne 0) {
      Show-Message "The app could not be built. See:`n$setupLog"
      exit 1
    }
  }

  $entryPath = Join-Path $projectFolder 'dist\index.js'
  $server = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $entryPath + '"') -WorkingDirectory $projectFolder -WindowStyle Hidden -PassThru -RedirectStandardOutput $nodeOutput -RedirectStandardError $nodeError
  Set-Content -Path $pidFile -Value $server.Id -NoNewline

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) { break }
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 2 -UseBasicParsing | Out-Null
      $ready = $true
      break
    } catch { }
  }

  if ($ready) {
    Start-Process 'http://localhost:3000'
    exit 0
  }

  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Show-Message "The inventory server did not start. Check the log files in:`n$runtimeFolder"
  exit 1
} catch {
  Show-Message "Could not start the inventory app:`n$($_.Exception.Message)"
  exit 1
}
