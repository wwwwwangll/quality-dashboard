@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-app\scripts\start.ps1" -Environment production %*
if errorlevel 1 pause
