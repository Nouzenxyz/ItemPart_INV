$ErrorActionPreference = 'Stop'
$projectFolder = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $projectFolder '.runtime\server.pid'
$messageBox = New-Object -ComObject WScript.Shell

if (-not (Test-Path $pidFile)) {
  $null = $messageBox.Popup('The inventory server does not appear to be running.', 0, 'Inventory application', 64)
  exit 0
}

$serverPid = 0
[void][int]::TryParse((Get-Content $pidFile -Raw), [ref]$serverPid)
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$process = if ($serverPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue } else { $null }
$entryPath = Join-Path $projectFolder 'dist\index.js'
$isInventoryProcess = $process -and $nodeCommand -and $process.ExecutablePath -eq $nodeCommand.Source -and $process.CommandLine.Contains($entryPath)
if ($isInventoryProcess) {
  Stop-Process -Id $serverPid -Force
  $null = $messageBox.Popup('The inventory server has been stopped. Your saved inventory data remains in the data folder.', 0, 'Inventory application', 64)
} else {
  $null = $messageBox.Popup('The inventory server is already stopped.', 0, 'Inventory application', 64)
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
