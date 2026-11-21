param([string]$SourceRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$taskLockPath = Join-Path $SourceRoot 'run\desktop.lock'
if (-not (Test-Path -LiteralPath $taskLockPath)) { Write-Output 'Desktop bridge is stopped'; exit 0 }
$taskLock = Get-Content -LiteralPath $taskLockPath -Raw | ConvertFrom-Json
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskLock.pid)"
if ($taskProcess) {
    $taskExpectedScript = Join-Path $SourceRoot 'desktop-bridge.mjs'
    if (-not $taskProcess.CommandLine.Contains($taskExpectedScript)) { throw 'PID belongs to another process; refusing to stop it' }
    Stop-Process -Id $taskLock.pid
}
Remove-Item -LiteralPath $taskLockPath -Force -ErrorAction SilentlyContinue
Write-Output 'Desktop bridge stopped; mailbox and receipts retained'
