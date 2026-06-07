@echo off
setlocal
cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
  echo cargo is required but was not found in PATH.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required but was not found in PATH.
  exit /b 1
)

if not exist "src-ui\node_modules" (
  pushd src-ui
  call npm install
  if errorlevel 1 exit /b %errorlevel%
  popd
)

cargo tauri dev
