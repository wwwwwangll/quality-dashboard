param(
  [ValidateSet('test','production')][string]$Environment = 'test',
  [ValidateRange(0,65535)][int]$Port = 0,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$qualityAppDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qualityProjectDir = [System.IO.Path]::GetFullPath((Join-Path $qualityAppDir '..'))
$qualityNodePath = Join-Path $qualityAppDir 'runtime\node.exe'
$qualityServerPath = Join-Path $qualityAppDir 'server.mjs'
if (-not (Test-Path -LiteralPath $qualityNodePath -PathType Leaf)) { throw '缺少随包运行时，请重新解压完整部署包。' }
if ($Port -eq 0) { if ($Environment -eq 'production') { $Port = 3869 } else { $Port = 3870 } }
$qualityDataDir = Join-Path $qualityAppDir ('data\' + $Environment)
$qualityRunDir = Join-Path $qualityAppDir '.run'
$qualityLogsDir = Join-Path $qualityAppDir ('logs\' + $Environment)
$qualityPidFile = Join-Path $qualityRunDir ($Environment + '.json')
$qualityControlFile = Join-Path $qualityRunDir ($Environment + '.stop')
$qualityUrl = 'http://127.0.0.1:' + $Port
if (Test-Path -LiteralPath (Join-Path $qualityProjectDir 'RELEASE-MANIFEST.json')) {
  & $qualityNodePath (Join-Path $PSScriptRoot 'verify-package.mjs') --release
  if ($LASTEXITCODE -ne 0) { throw '部署包完整性校验失败，请停止使用并核对发布包。' }
} elseif ($Environment -eq 'production') { throw '正式环境必须使用带有 RELEASE-MANIFEST.json 的完整发布包。' }
if (Test-Path -LiteralPath $qualityPidFile) {
  $qualityExisting = Get-Content -LiteralPath $qualityPidFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $qualityProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$qualityExisting.pid) -ErrorAction SilentlyContinue
  if ($qualityProcess) {
    if (-not $qualityProcess.ExecutablePath -or -not ([string]$qualityProcess.ExecutablePath).Equals($qualityNodePath,[StringComparison]::OrdinalIgnoreCase) -or -not ([string]$qualityProcess.CommandLine).Contains($qualityServerPath)) { throw 'PID记录指向未知进程，未启动或结束任何未知进程，请由IT核对。' }
    $qualityStatus = Invoke-RestMethod -Uri ($qualityUrl + '/api/status') -TimeoutSec 3
    if ($qualityStatus.application -ne 'quality-dashboard-local' -or $qualityStatus.environment -ne $Environment) { throw '已有服务与指定环境不一致，请核对端口。' }
    Write-Host ('服务已经运行：' + $qualityUrl + ' [' + $Environment + ']')
    if (-not $NoBrowser) { Start-Process $qualityUrl -WindowStyle Normal }
    exit 0
  }
  Remove-Item -LiteralPath $qualityPidFile
}
if ($Environment -eq 'test' -and -not (Test-Path -LiteralPath (Join-Path $qualityDataDir 'quality.sqlite'))) {
  Write-Host '首次启动新版预览，正在创建独立模拟数据、测试账号和黑屏8D示例，请稍候。'
  & $qualityNodePath (Join-Path $PSScriptRoot 'seed-preview.mjs') --data $qualityDataDir
  if ($LASTEXITCODE -ne 0) { throw '模拟初始化未完成。未覆盖原安装版；请查看上面的错误，不要删除已有业务目录。' }
}
New-Item -ItemType Directory -Path $qualityRunDir,$qualityLogsDir -Force | Out-Null
if (Test-Path -LiteralPath $qualityControlFile) { Remove-Item -LiteralPath $qualityControlFile }
$qualityTime = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$qualityStdout = Join-Path $qualityLogsDir ($qualityTime + '-stdout.log')
$qualityStderr = Join-Path $qualityLogsDir ($qualityTime + '-stderr.log')
$qualityStopToken = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$qualityNames = @('QUALITY_ENV','QUALITY_DATA_DIR','QUALITY_HOST','QUALITY_PORT','QUALITY_STOP_FILE','QUALITY_STOP_TOKEN')
$qualityPrevious = @{}
foreach ($qualityName in $qualityNames) { $qualityPrevious[$qualityName] = [Environment]::GetEnvironmentVariable($qualityName,'Process') }
try {
  $env:QUALITY_ENV = $Environment
  $env:QUALITY_DATA_DIR = $qualityDataDir
  $env:QUALITY_HOST = '127.0.0.1'
  $env:QUALITY_PORT = [string]$Port
  $env:QUALITY_STOP_FILE = $qualityControlFile
  $env:QUALITY_STOP_TOKEN = $qualityStopToken
  $qualityStarted = Start-Process -FilePath $qualityNodePath -ArgumentList @('"' + $qualityServerPath + '"') -WorkingDirectory $qualityAppDir -RedirectStandardOutput $qualityStdout -RedirectStandardError $qualityStderr -WindowStyle Hidden -PassThru
} finally { foreach ($qualityName in $qualityNames) { [Environment]::SetEnvironmentVariable($qualityName,$qualityPrevious[$qualityName],'Process') } }
$qualityRecord = @{ pid=$qualityStarted.Id; environment=$Environment; port=$Port; nodePath=$qualityNodePath; serverPath=$qualityServerPath; dataDir=$qualityDataDir; startTicks=$qualityStarted.StartTime.ToFileTimeUtc().ToString(); stopToken=$qualityStopToken; controlFile=$qualityControlFile }
[System.IO.File]::WriteAllText($qualityPidFile,($qualityRecord | ConvertTo-Json),[System.Text.UTF8Encoding]::new($false))
$qualityReady = $false
for ($qualityAttempt = 0; $qualityAttempt -lt 450; $qualityAttempt++) {
  $qualityStarted.Refresh()
  if ($qualityStarted.HasExited) { throw ('服务启动失败，请查看：' + $qualityStderr) }
  try { $qualityStatus = Invoke-RestMethod -Uri ($qualityUrl + '/api/status') -TimeoutSec 1; if ($qualityStatus.application -eq 'quality-dashboard-local' -and $qualityStatus.environment -eq $Environment) { $qualityReady = $true; break } } catch { }
  Start-Sleep -Milliseconds 200
}
if (-not $qualityReady) { throw ('服务没有按时就绪，请查看日志；可运行停止服务.cmd后重试。日志：' + $qualityStderr) }
Write-Host ('服务已启动：' + $qualityUrl + ' [' + $Environment + ']')
Write-Host ('数据目录：' + $qualityDataDir)
if ($Environment -eq 'test') { Write-Host ('固定初始密码表（安装包根目录也有一份）：' + (Join-Path $qualityDataDir '测试账号.txt')) }
if (-not $NoBrowser) { Start-Process $qualityUrl -WindowStyle Normal }
