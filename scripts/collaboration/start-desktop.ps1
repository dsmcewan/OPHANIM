param([string]$SourceRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$taskConfigPath = Join-Path $SourceRoot 'desktop.local.json'
$taskLockPath = Join-Path $SourceRoot 'run\desktop.lock'
if (Test-Path -LiteralPath $taskLockPath) {
    $taskLock = Get-Content -LiteralPath $taskLockPath -Raw | ConvertFrom-Json
    $taskExisting = Get-Process -Id $taskLock.pid -ErrorAction SilentlyContinue
    if ($taskExisting) { Write-Output "Desktop bridge already running as PID $($taskLock.pid)"; exit 0 }
}
if (-not $env:CODEX_APP_TOOLS_PIPE_PATH) { throw 'Run this from a Codex desktop task so its local app-tools connection is inherited.' }
$taskPluginRoot = 'C:\Users\dsmce\.codex\plugins\cache\openai-bundled\codex-app-tools'
$taskServer = Get-ChildItem -LiteralPath $taskPluginRoot -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'server.mjs' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $taskServer) { throw 'Installed Codex app-tools MCP server not found' }
$taskConfiguration = @{
    distro = 'kali-linux'
    node = '/home/colchis/.nvm/versions/node/v24.18.0/bin/node'
    cli = '/home/colchis/Projects/OPHANIM-shared/collaboration/cli.mjs'
    codexThreadId = '01a20038-f786-7011-973b-0aa57166a846'
    appToolsServer = $taskServer
    pollMs = 3000
}
[System.IO.File]::WriteAllText($taskConfigPath, ($taskConfiguration | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
$taskRunDir = Join-Path $SourceRoot 'run'
New-Item -ItemType Directory -Path $taskRunDir -Force | Out-Null
$taskNode = (Get-Command node.exe).Source
$taskScript = Join-Path $SourceRoot 'desktop-bridge.mjs'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'), ('"' + $taskConfigPath + '"')) -WorkingDirectory $SourceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRunDir 'desktop.stdout.log') -RedirectStandardError (Join-Path $taskRunDir 'desktop.stderr.log')
Write-Output "Started desktop bridge as PID $($taskProcess.Id)"
