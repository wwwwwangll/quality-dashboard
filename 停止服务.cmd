@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-app\scripts\stop.ps1" -Environment all %*
if errorlevel 1 pause
