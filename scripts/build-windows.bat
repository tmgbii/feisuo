@echo off
chcp 65001 >nul
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1"
if errorlevel 1 pause & exit /b 1
echo.
pause
