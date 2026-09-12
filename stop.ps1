$ErrorActionPreference = 'Stop'
$labPidFile = Join-Path $PSScriptRoot 'server.pid'
if (-not (Test-Path -LiteralPath $labPidFile)) { Write-Output '실행한 서버 PID 기록이 없습니다.'; exit 0 }
$labProcessId = [int](Get-Content -LiteralPath $labPidFile)
$labProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $labProcessId"
if (-not $labProcess) { Write-Output '서버가 이미 종료되어 있습니다.'; exit 0 }
$expectedScript = Join-Path $PSScriptRoot 'server.mjs'
if ($labProcess.Name -ne 'node.exe' -or -not $labProcess.CommandLine.Contains($expectedScript)) { throw 'PID가 실험실 서버와 일치하지 않아 종료하지 않았습니다.' }
Stop-Process -Id $labProcessId
Write-Output '실험실 서버를 종료했습니다. 저장된 기록은 유지됩니다.'
