@echo off
setlocal
REM ============================================================
REM start-webapp.bat
REM
REM Starts the JMeter Performance Test web UI on http://localhost:3000
REM
REM This launcher pins the Node.js version used by the app WITHOUT
REM running "nvm use", so the machine-wide Node version (and every
REM other project on this machine) is left untouched.
REM
REM First-time setup, run once from this folder:
REM     setup-webapp.bat
REM ============================================================

set "APP_DIR=%~dp0"
set "NODE_DIR=%LOCALAPPDATA%\nvm\v22.22.3"

REM Port the web UI listens on. 3000 is already taken by Grafana on this
REM machine, hence 3100. Override by passing a port: start-webapp.bat 8080
if "%~1"=="" (set "PORT=3100") else (set "PORT=%~1")

REM Fall back to whatever "node" is on PATH if the pinned version is absent
REM (e.g. on a client machine with a normal Node 18+ install).
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

set "NEXT_TELEMETRY_DISABLED=1"
cd /d "%APP_DIR%"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js was not found. Install Node.js 18.18 or newer.
    pause
    exit /b 1
)

if not exist "%APP_DIR%node_modules" (
    echo ERROR: Dependencies are not installed. Run setup-webapp.bat first.
    pause
    exit /b 1
)

if not exist "%APP_DIR%.next" (
    echo ERROR: The app is not built. Run setup-webapp.bat first.
    pause
    exit /b 1
)

echo ========================================
echo JMeter Performance Test - Web UI
echo ========================================
node -v
echo Open http://localhost:%PORT% in your browser.
echo Press Ctrl+C in this window to stop the app.
echo.

call npm run start
endlocal
