@echo off
setlocal

title Coffee-CLI main2 tauri dev
chcp 65001 >nul

cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found in PATH.
  pause
  exit /b 1
)

echo [INFO] Working directory: %cd%
echo [INFO] Running: cargo +stable tauri dev
echo.

cargo +stable tauri dev
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo [ERROR] cargo tauri dev exited with code %EXITCODE%.
  pause
)

exit /b %EXITCODE%
