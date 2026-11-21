param([string]$SourceRoot = $PSScriptRoot, [string]$ConfigPath = (Join-Path $PSScriptRoot 'desktop.local.json'))
$ErrorActionPreference = 'Stop'
$taskConfiguration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$taskUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskMutexName = 'Local\OPHANIMCollaboration-' + $taskUserSid + '-' + $taskConfiguration.codexThreadId
$taskMutex = [System.Threading.Mutex]::new($false, $taskMutexName)
$taskOwned = $false
$taskResult = 0
try {
    try { $taskOwned = $taskMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $taskOwned = $true }
    if (-not $taskOwned) { Write-Output 'Desktop bridge mutex is already held'; exit 0 }
    $env:OPHANIM_DESKTOP_MUTEX_HELD = '1'
    $env:OPHANIM_DESKTOP_SUPERVISOR_PID = [string]$PID
    $taskNode = (Get-Command node.exe).Source
    & $taskNode (Join-Path $SourceRoot 'desktop-bridge.mjs') $ConfigPath
    $taskResult = $LASTEXITCODE
} finally {
    if ($taskOwned) { $taskMutex.ReleaseMutex() }
    $taskMutex.Dispose()
}
exit $taskResult
