@echo off
setlocal
REM ============================================================
REM setup-webapp.bat
REM
REM One-time setup: installs dependencies and builds the web UI.
REM Run this once, then use start-webapp.bat to launch the app.
REM ============================================================

set "APP_DIR=%~dp0"
set "NODE_DIR=%LOCALAPPDATA%\nvm\v22.22.3"

if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

set "NEXT_TELEMETRY_DISABLED=1"
cd /d "%APP_DIR%"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js was not found. Install Node.js 18.18 or newer.
    pause
    exit /b 1
)

echo Using Node:
node -v
echo.

echo Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo Building the application...
call npm run build
if errorlevel 1 (
    echo ERROR: npm run build failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo Setup complete. Run start-webapp.bat to launch the app.
echo ========================================
pause
endlocal
