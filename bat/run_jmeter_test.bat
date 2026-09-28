@echo off
setlocal EnableDelayedExpansion
REM ============================================================
REM run_jmeter_test.bat <threads> <ramp-up-seconds> <loops> [csv-file]
REM
REM Runs JMeter_API_Automation.jmx in non-GUI mode with a
REM configurable Thread Group (Threads / Ramp-Up / Loops), then
REM generates an HTML Dashboard into a unique, timestamped
REM output folder. No Duration setting is used.
REM
REM Examples:
REM   run_jmeter_test.bat 1 1 1        (smoke test)
REM   run_jmeter_test.bat 100 30 10    (load test: 100 threads,
REM                                     30s ramp-up, 10 loops each)
REM
REM The optional 4th argument is the CSV of APIs to run. It is
REM passed to the test plan as the CSV_FILE property, which the
REM CSV Data Set Config reads. Omit it and APIs.csv in this folder
REM is used, exactly as before - so the 3-argument form above keeps
REM behaving identically.
REM
REM   run_jmeter_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
REM
REM The number of data rows in that CSV is counted here and passed
REM as CSV_ROW_COUNT, which the Thread Group's loop count uses
REM (loops = LOOPS x CSV_ROW_COUNT). Without it the test plan falls
REM back to its built-in default of 14 rows and silently ignores
REM every API past the 14th.
REM
REM Report metadata (Application Name / API Type) is read from the
REM APP_NAME / API_TYPE environment variables when set, the same
REM way credentials are, so no value has to be edited into a file.
REM
REM Credentials are NEVER stored in this file and are NOT passed
REM as command-line arguments (those 3 slots are Threads/Ramp-Up/
REM Loops). Provide them by pre-setting LOGIN_USERNAME /
REM LOGIN_PASSWORD environment variables before running, or by
REM answering the prompts below. The password is read via a
REM masked PowerShell prompt and passed to JMeter as a plain
REM environment variable (not -J), because JMeter echoes -J
REM property values to the console and to its own log file.
REM ============================================================

REM This script's own folder, so the .env lookup below works no matter where
REM the whole project is moved to.
set "SCRIPT_DIR=%~dp0"
set "ENV_FILE=%SCRIPT_DIR%..\.env"

REM ---- Load .env into this process's environment ----
REM cmd.exe does not read .env files on its own. Each KEY=VALUE line is loaded
REM here; a variable the caller (e.g. the webapp) already set in the
REM environment is left alone, so an explicit override always wins over the
REM file. PowerShell (already a hard dependency of this script) does the
REM trimming/comment-filtering, since a native `for /f` mishandles a
REM CRLF-terminated last token.
if exist "%ENV_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%K in (`powershell -NoProfile -Command "Get-Content -LiteralPath '%ENV_FILE%' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') -and $_.Contains('=') }"`) do (
        if not defined %%K set "%%K=%%L"
    )
)

REM ---- Select LOCAL or DEPLOYMENT (ENVIRONMENT in .env; defaults to LOCAL) ----
if not defined ENVIRONMENT set "ENVIRONMENT=LOCAL"
if /i "%ENVIRONMENT%"=="DEPLOYMENT" (
    set "PROJECT_DIR=%DEPLOY_PROJECT_DIR%"
    set "JMETER_BAT=%DEPLOY_JMETER_BAT%"
) else (
    set "PROJECT_DIR=%LOCAL_PROJECT_DIR%"
    set "JMETER_BAT=%LOCAL_JMETER_BAT%"
)

REM The .jmx files, scripts\, report-template\ and output\ all live beside this
REM script in webapp\bat\, so that is the default. LOCAL_PROJECT_DIR /
REM DEPLOY_PROJECT_DIR only need setting to use a different folder.
if not defined PROJECT_DIR set "PROJECT_DIR=%SCRIPT_DIR:~0,-1%"
if not defined JMETER_BAT (
    echo ERROR: JMETER_BAT could not be determined. Set LOCAL_JMETER_BAT / DEPLOY_JMETER_BAT in "%ENV_FILE%".
    set "EXITCODE=1"
    goto :END
)

REM scripts\ and report-template\ are resolved from PROJECT_DIR, never
REM hardcoded, so moving/redeploying the project needs no script edits.
set "SCRIPTS_DIR=%PROJECT_DIR%\scripts"
set "TEST_PLAN=JMeter_API_Automation.jmx"
set "EXITCODE=0"

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
    echo ERROR: Could not switch to project folder "%PROJECT_DIR%"
    set "EXITCODE=1"
    goto :END
)

if not exist "%JMETER_BAT%" (
    echo ERROR: JMeter executable not found at "%JMETER_BAT%"
    set "EXITCODE=1"
    goto :END
)

if not exist "%TEST_PLAN%" (
    echo ERROR: Test plan not found at "%PROJECT_DIR%\%TEST_PLAN%"
    set "EXITCODE=1"
    goto :END
)

REM ---- Parse and validate Threads / Ramp-Up / Loops ----
if "%~1"=="" goto :USAGE
if "%~2"=="" goto :USAGE
if "%~3"=="" goto :USAGE
if not "%~5"=="" goto :USAGE

call :ValidateNumber "%~1" "Threads" || goto :BADPARAMS
call :ValidateNumber "%~2" "Ramp-Up seconds" || goto :BADPARAMS
call :ValidateNumber "%~3" "Loops" || goto :BADPARAMS

set "THREADS=%~1"
set "RAMPUP=%~2"
set "LOOPS=%~3"

REM ---- Resolve the CSV of APIs to run (4th arg, else APIs.csv) ----
if "%~4"=="" (
    set "CSV_FILE=%PROJECT_DIR%\APIs.csv"
) else (
    set "CSV_FILE=%~f4"
)

if not exist "%CSV_FILE%" (
    echo ERROR: CSV file not found: "%CSV_FILE%"
    set "EXITCODE=1"
    goto :END
)

REM Count the API rows in THAT csv - record count, not line count, so a
REM quoted field containing newlines does not inflate the total. This drives
REM CSV_ROW_COUNT below, so every row of the supplied CSV actually runs.
set "TOTAL_APIS="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "@(Import-Csv -LiteralPath $env:CSV_FILE).Count"`) do set "TOTAL_APIS=%%A"
if not defined TOTAL_APIS set "TOTAL_APIS=0"

if "%TOTAL_APIS%"=="0" (
    echo ERROR: No API rows were found in "%CSV_FILE%".
    set "EXITCODE=1"
    goto :END
)

goto :PARAMS_OK

:USAGE
echo Usage: run_jmeter_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
echo   Example (smoke test):  run_jmeter_test.bat 1 1 1
echo   Example (load test):   run_jmeter_test.bat 100 30 10
echo   Example (own CSV):     run_jmeter_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
set "EXITCODE=1"
goto :END

:BADPARAMS
echo.
echo Usage: run_jmeter_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
set "EXITCODE=1"
goto :END

:PARAMS_OK

REM ---- Resolve credentials: env vars > interactive prompt (never CLI args) ----
REM Remember whether both were already set, so a fully non-interactive
REM (e.g. CI) invocation doesn't get stuck waiting on the final "pause".
set "CREDS_PRESET=false"
if defined LOGIN_USERNAME if defined LOGIN_PASSWORD set "CREDS_PRESET=true"

if not defined LOGIN_USERNAME (
    set /p LOGIN_USERNAME=Enter login username:
)

if not defined LOGIN_PASSWORD (
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s = Read-Host -AsSecureString 'Enter login password'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "LOGIN_PASSWORD=%%P"
)

if not defined LOGIN_USERNAME (
    echo ERROR: LOGIN_USERNAME was not provided.
    set "EXITCODE=1"
    goto :END
)
if not defined LOGIN_PASSWORD (
    echo ERROR: LOGIN_PASSWORD was not provided.
    set "EXITCODE=1"
    goto :END
)

REM ---- Build a unique, timestamped output folder (never overwrites past runs) ----
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "TIMESTAMP=%%T"

set "RUN_DIR=output\%TIMESTAMP%"
set "RESULT_FILE=%RUN_DIR%\results.jtl"
set "LOG_FILE=%RUN_DIR%\jmeter.log"
set "DASHBOARD_DIR=%RUN_DIR%\dashboard"

if exist "%RUN_DIR%" (
    echo ERROR: Output folder "%RUN_DIR%" already exists. Aborting to avoid overwriting results.
    set "EXITCODE=1"
    goto :END
)
mkdir "%RUN_DIR%"

if exist "%DASHBOARD_DIR%" (
    echo ERROR: Dashboard folder "%DASHBOARD_DIR%" already exists. Aborting before calling jmeter -o.
    set "EXITCODE=1"
    goto :END
)

REM Archive the exact CSV this run used next to its own results, so every
REM output folder is self-contained and can be traced back to its input.
copy /y "%CSV_FILE%" "%RUN_DIR%\test-data.csv" >nul

REM Display timestamp for the report's Test Configuration section.
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "Get-Date -Format 'dd-MMM-yyyy hh:mm tt'"`) do set "RUN_STARTED=%%D"

echo ========================================
echo JMeter API Automation
echo ========================================
echo Application: %APP_NAME%
echo API Type: %API_TYPE%
echo CSV File: %CSV_FILE%
echo Total APIs: %TOTAL_APIS%
echo Threads:  %THREADS%
echo Ramp-Up:  %RAMPUP% seconds
echo Loops:    %LOOPS%
echo Test Started: %DATE% %TIME%
echo.

REM ---- Run JMeter in non-GUI mode. THREADS/RAMPUP/LOOPS are passed as
REM      JMeter properties read by the Thread Group in the .jmx.
REM      LOGIN_USERNAME/LOGIN_PASSWORD are passed as plain environment
REM      variables, not -J, so they are never logged. ----
REM CSV_FILE / CSV_ROW_COUNT are quoted as whole tokens so a path containing
REM spaces reaches JMeter as a single argument.
call "%JMETER_BAT%" -n -t "%TEST_PLAN%" -l "%RESULT_FILE%" -j "%LOG_FILE%" -JTHREADS=%THREADS% -JRAMPUP=%RAMPUP% -JLOOPS=%LOOPS% "-JCSV_FILE=%CSV_FILE%" "-JCSV_ROW_COUNT=%TOTAL_APIS%" -Jsample_variables=REC_METHOD,REC_URL,REC_APINAME,REC_PASSFAIL,REC_ERROR,REC_RESPONSE
set "JMETER_EXIT_CODE=%ERRORLEVEL%"

REM Clear the password from this process's environment as soon as we're done with it
set "LOGIN_PASSWORD="

if not "%JMETER_EXIT_CODE%"=="0" (
    echo.
    echo ========================================
    echo ERROR: JMeter execution FAILED.
    echo JMeter Exit Code: %JMETER_EXIT_CODE%
    echo ========================================
    set "EXITCODE=%JMETER_EXIT_CODE%"
    goto :END
)

REM ---- Refresh per-run report info (the report's Test Configuration table) ----
REM Every value here belongs to the run that just executed: Total APIs is the
REM record count of the CSV this run actually used, the rest come from this
REM run's own arguments and environment. Nothing is hard-coded.
REM
REM This is written by a PowerShell helper rather than a series of `echo ... >>`
REM lines. `echo x: %RAMPUP%>>file` is silently broken for any single-digit
REM value, because cmd reads the `1` in `1>>` as a stream handle rather than as
REM text - which used to emit `rampUpSeconds:` with no value at all, producing
REM invalid JavaScript that blanked the whole table. The helper also escapes
REM values properly, so an application name containing & < > | or quotes is safe.
set "RUN_INFO_FILE=%PROJECT_DIR%\report-template\content\js\report-run-info.js"
set "REPORT_TEMPLATE_DIR=%PROJECT_DIR%\report-template"
set "RUN_INFO_TOTAL_APIS=%TOTAL_APIS%"
set "RUN_INFO_THREADS=%THREADS%"
set "RUN_INFO_RAMPUP=%RAMPUP%"
set "RUN_INFO_LOOPS=%LOOPS%"
set "RUN_INFO_CSV=%CSV_FILE%"
set "RUN_INFO_STARTED=%RUN_STARTED%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS_DIR%\Write-ReportRunInfo.ps1"
if errorlevel 1 (
    echo WARNING: Could not refresh report-run-info.js; the report's Test
    echo Configuration table may show stale values.
)

REM ---- Generate HTML Dashboard (only after a successful test run) ----
REM Uses the project-local, customized report template (report-template\)
REM instead of the default JMeter install template, so the dashboard
REM customizations (Application Name / API Type / Service naming / layout)
REM are applied on every run without touching the JMeter installation.
REM
REM -q adds scripts\report-generator.properties, which filters the internal
REM "Prepare - ..." samplers out of the report so every count (Passed/Failed,
REM statistics, APDEX, errors, graphs) reflects actual API requests only.
REM It is a file rather than another -J switch because the filter is a regular
REM expression containing "!", and cmd's delayed expansion silently strips that
REM character from any command line - producing a filter that matches nothing
REM like it was meant to, with no error.
call "%JMETER_BAT%" -g "%RESULT_FILE%" -o "%DASHBOARD_DIR%" -q "%SCRIPTS_DIR%\report-generator.properties" -Jjmeter.reportgenerator.exporter.html.property.template_dir="%REPORT_TEMPLATE_DIR%"
set "DASHBOARD_EXIT_CODE=%ERRORLEVEL%"

if not "%DASHBOARD_EXIT_CODE%"=="0" (
    echo.
    echo ========================================
    echo ERROR: HTML Dashboard generation FAILED.
    echo Dashboard Exit Code: %DASHBOARD_EXIT_CODE%
    echo ========================================
    set "EXITCODE=%DASHBOARD_EXIT_CODE%"
    goto :END
)

REM ---- Add per-API Method / Status Code data to the generated report ----
REM JMeter's dashboard data has no per-API method or response status code, so
REM scripts\Write-ReportSampleInfo.ps1 reads them from this run's results.jtl
REM into dashboard\content\js\report-sample-info.js, which the Statistics and
REM Errors tables use. Runs after generation, so JMeter's own report step is
REM unchanged; if it fails the report still opens, just without status codes.
set "SAMPLE_INFO_JTL=%CD%\%RESULT_FILE%"
set "SAMPLE_INFO_FILE=%CD%\%DASHBOARD_DIR%\content\js\report-sample-info.js"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS_DIR%\Write-ReportSampleInfo.ps1"
if errorlevel 1 (
    echo WARNING: Could not write report-sample-info.js; the report's Method /
    echo Status Code columns may show "-".
)
echo.
echo ========================================
echo JMeter API Automation
echo ========================================
echo Result File: %CD%\%RESULT_FILE%
echo JMeter Log:  %CD%\%LOG_FILE%
echo HTML Report: %CD%\%DASHBOARD_DIR%\index.html
echo Test Completed
echo ========================================
set "EXITCODE=0"

:END
if "%CREDS_PRESET%"=="true" goto :NOPAUSE
pause
:NOPAUSE
endlocal & exit /b %EXITCODE%

:ValidateNumber
setlocal
set "VAL=%~1"
set "LABEL=%~2"
echo %VAL%| findstr /r "^[1-9][0-9]*$" >nul
if errorlevel 1 (
    echo ERROR: %LABEL% must be a whole number greater than zero. Got: "%VAL%"
    endlocal
    exit /b 1
)
endlocal
exit /b 0
