@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-app\scripts\start.ps1" -Environment test %*
if errorlevel 1 pause
