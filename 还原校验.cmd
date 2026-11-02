@echo off
setlocal
set "quality_env=test"
if not "%~1"=="" set "quality_env=%~1"
"%~dp0local-app\runtime\node.exe" "%~dp0local-app\scripts\operational.mjs" verify-backup --environment "%quality_env%" --data-dir "%~dp0local-app\data\%quality_env%"
if errorlevel 1 pause
endlocal
