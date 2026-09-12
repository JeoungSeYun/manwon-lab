$ErrorActionPreference = 'Stop'
$labDirectory = $PSScriptRoot
$labUrl = 'http://127.0.0.1:8787'
$runningLab = $false
try {
    $labState = Invoke-RestMethod -Uri "$labUrl/api/state" -TimeoutSec 2
    if ($labState.app -ne '만원 실험실') { throw '다른 프로그램이 8787 포트를 사용하고 있습니다.' }
    $runningLab = $true
} catch {
    if ($_.Exception.Message -like '*다른 프로그램*') { throw }
}
if (-not $runningLab) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 22 이상을 설치한 뒤 다시 실행해 주세요.' }
    $labProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + (Join-Path $labDirectory 'server.mjs') + '"') -WorkingDirectory $labDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $labDirectory 'server.log') -RedirectStandardError (Join-Path $labDirectory 'server-error.log') -PassThru
    Set-Content -LiteralPath (Join-Path $labDirectory 'server.pid') -Value $labProcess.Id
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $labState = Invoke-RestMethod -Uri "$labUrl/api/state" -TimeoutSec 2; $runningLab = $labState.app -eq '만원 실험실'; if ($runningLab) { break } } catch {}
        if ($labProcess.HasExited) { throw '서버 실행 실패. server-error.log 파일을 확인해 주세요.' }
    }
    if (-not $runningLab) { throw '서버 시작을 확인하지 못했습니다. server-error.log 파일을 확인해 주세요.' }
}
Start-Process $labUrl
