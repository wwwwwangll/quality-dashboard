param(
  [ValidateSet('test','production','all')][string]$Environment = 'all',
  [switch]$ForceStop
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$qualityAppDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qualityNodePath = Join-Path $qualityAppDir 'runtime\node.exe'
$qualityServerPath = Join-Path $qualityAppDir 'server.mjs'
$qualityEnvironments = @($Environment)
if ($Environment -eq 'all') { $qualityEnvironments = @('test','production') }
foreach ($qualityEnvironment in $qualityEnvironments) {
  $qualityPidFile = Join-Path $qualityAppDir ('.run\' + $qualityEnvironment + '.json')
  if (-not (Test-Path -LiteralPath $qualityPidFile)) { Write-Host ($qualityEnvironment + ' 没有运行记录。'); continue }
  $qualityRecord = Get-Content -LiteralPath $qualityPidFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($qualityRecord.environment -ne $qualityEnvironment) { throw '环境运行记录不一致，拒绝停止。' }
  $qualityProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$qualityRecord.pid) -ErrorAction SilentlyContinue
  if (-not $qualityProcess) { Remove-Item -LiteralPath $qualityPidFile; Write-Host ($qualityEnvironment + ' 已停止。'); continue }
  $qualityLive = Get-Process -Id ([int]$qualityRecord.pid)
  if (-not $qualityProcess.ExecutablePath -or -not ([string]$qualityProcess.ExecutablePath).Equals($qualityNodePath,[StringComparison]::OrdinalIgnoreCase) -or -not ([string]$qualityProcess.CommandLine).Contains($qualityServerPath) -or $qualityLive.StartTime.ToFileTimeUtc().ToString() -ne [string]$qualityRecord.startTicks) { throw 'PID记录不能确认属于本包服务，拒绝结束未知进程。' }
  $qualityControlFile = Join-Path $qualityAppDir ('.run\' + $qualityEnvironment + '.stop')
  [System.IO.File]::WriteAllText($qualityControlFile,(@{environment=$qualityEnvironment;pid=[int]$qualityRecord.pid;token=$qualityRecord.stopToken}|ConvertTo-Json),[System.Text.UTF8Encoding]::new($false))
  $qualityStopped = $false
  for ($qualityAttempt = 0; $qualityAttempt -lt 75; $qualityAttempt++) {
    if (-not (Get-Process -Id ([int]$qualityRecord.pid) -ErrorAction SilentlyContinue)) { $qualityStopped = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $qualityStopped) {
    if (-not $ForceStop) { throw '服务仍在退出，可能正在完成备份。请稍后重试；只有确认后才使用 -ForceStop。' }
    $qualityRecheck = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$qualityRecord.pid) -ErrorAction SilentlyContinue
    $qualityRecheckLive = Get-Process -Id ([int]$qualityRecord.pid) -ErrorAction SilentlyContinue
    if ($qualityRecheck -and $qualityRecheckLive -and ([string]$qualityRecheck.ExecutablePath).Equals($qualityNodePath,[StringComparison]::OrdinalIgnoreCase) -and ([string]$qualityRecheck.CommandLine).Contains($qualityServerPath) -and $qualityRecheckLive.StartTime.ToFileTimeUtc().ToString() -eq [string]$qualityRecord.startTicks) { Stop-Process -Id ([int]$qualityRecord.pid) -Force } else { throw '进程信息发生变化，拒绝强制停止。' }
  }
  if (Test-Path -LiteralPath $qualityPidFile) { Remove-Item -LiteralPath $qualityPidFile }
  if (Test-Path -LiteralPath $qualityControlFile) { Remove-Item -LiteralPath $qualityControlFile }
  Write-Host ($qualityEnvironment + ' 服务已停止。')
}
