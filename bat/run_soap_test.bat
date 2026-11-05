@echo off
setlocal EnableDelayedExpansion
REM ============================================================
REM run_soap_test.bat <threads> <ramp-up-seconds> <loops> [csv-file]
REM
REM SOAP counterpart of run_jmeter_test.bat: runs
REM JMeter_SOAP_Automation.jmx in non-GUI mode with a configurable
REM Thread Group (Threads / Ramp-Up / Loops), then generates an
REM HTML Dashboard into a unique, timestamped output folder using
REM the SAME report template and API-count fix as the REST flow.
REM No Duration setting is used.
REM
REM Examples:
REM   run_soap_test.bat 1 1 1        (smoke test, uses SOAP_APIs.csv)
REM   run_soap_test.bat 50 30 5      (load test: 50 threads,
REM                                   30s ramp-up, 5 loops each)
REM
REM The optional 4th argument is the CSV of SOAP APIs to run. It is
REM passed to the test plan as the CSV_FILE property, which the
REM CSV Data Set Config reads. Omit it and SOAP_APIs.csv in this
REM folder is used.
REM
REM   run_soap_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
REM
REM The number of data rows in that CSV is counted here and passed
REM as CSV_ROW_COUNT, which the Thread Group's loop count uses
REM (loops = LOOPS x CSV_ROW_COUNT).
REM
REM Report metadata (Application Name / API Type) is read from the
REM APP_NAME / API_TYPE environment variables when set, exactly as
REM in run_jmeter_test.bat.
REM
REM Credentials use the EXACT SAME mechanism as run_jmeter_test.bat:
REM never stored in this file, never passed as command-line arguments
REM (those 3 slots are Threads/Ramp-Up/Loops), provided via LOGIN_USERNAME
REM / LOGIN_PASSWORD environment variables (set by the web UI) or the
REM interactive prompts below. The SOAP gateway (e.g. Sage X3's Web
REM Service) sits behind the same login as the REST API, so
REM scripts\ApplyAuthHeader.groovy - already wired into
REM JMeter_SOAP_Automation.jmx - applies HTTP Basic Auth from these same
REM credentials to every SOAP call, exactly as it already does for a
REM REST endpoint-list CSV with no login step of its own.
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
set "TEST_PLAN=JMeter_SOAP_Automation.jmx"
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

REM ---- Resolve the CSV of SOAP APIs to run (4th arg, else SOAP_APIs.csv) ----
if "%~4"=="" (
    set "CSV_FILE=%PROJECT_DIR%\SOAP_APIs.csv"
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
echo Usage: run_soap_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
echo   Example (smoke test):  run_soap_test.bat 1 1 1
echo   Example (load test):   run_soap_test.bat 50 30 5
echo   Example (own CSV):     run_soap_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
set "EXITCODE=1"
goto :END

:BADPARAMS
echo.
echo Usage: run_soap_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
set "EXITCODE=1"
goto :END

:PARAMS_OK

REM ---- Resolve credentials: env vars > interactive prompt (never CLI args) ----
REM Identical to run_jmeter_test.bat - the SOAP gateway sits behind the same
REM login as the REST API, so this is the exact same mechanism, not a new one.
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

REM Read by scripts\ApplyAuthHeader.groovy: unlike the REST flow (where this
REM is only turned on for an endpoint-list CSV with no login step of its
REM own), every SOAP CSV row needs it, since REQUEST_XML never carries
REM transport-level credentials - only the gateway sees this header, matching
REM exactly the same Basic Auth behaviour the REST flow already relies on.
set "USE_BASIC_AUTH_DEFAULT=true"

REM ---- Build a unique, timestamped output folder (never overwrites past runs) ----
REM The webapp sets RUN_OUTPUT_NAME so that tests running in parallel never pick the
REM same folder (a timestamp alone is only unique to the second). Started by hand it
REM is unset and the timestamp is used, exactly as before.
set "TIMESTAMP=%RUN_OUTPUT_NAME%"
if not defined TIMESTAMP for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "TIMESTAMP=%%T"

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

REM Display timestamp for the report's summary cells.
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "Get-Date -Format 'dd-MMM-yyyy hh:mm tt'"`) do set "RUN_STARTED=%%D"

echo ========================================
echo JMeter SOAP API Automation
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
REM      JMeter properties read by the Thread Group in the .jmx. ----
REM CSV_FILE / CSV_ROW_COUNT are quoted as whole tokens so a path containing
REM spaces reaches JMeter as a single argument.
call "%JMETER_BAT%" -n -t "%TEST_PLAN%" -l "%RESULT_FILE%" -j "%LOG_FILE%" -JTHREADS=%THREADS% -JRAMPUP=%RAMPUP% -JLOOPS=%LOOPS% "-JCSV_FILE=%CSV_FILE%" "-JCSV_ROW_COUNT=%TOTAL_APIS%" -Jjmeter.save.saveservice.autoflush=true -Jsample_variables=REC_METHOD,REC_URL,REC_APINAME,REC_PASSFAIL,REC_ERROR,REC_RESPONSE
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

REM ---- Refresh per-run report info (the report's summary cells) ----
REM Same helper the REST flow uses - every value belongs to the run that just
REM executed, nothing is hard-coded. See scripts\Write-ReportRunInfo.ps1.
REM NUM_USERS is set in this process's environment by the webapp exactly as
REM for the REST flow (the SOAP gateway uses the same saved-login groups), so
REM it is passed through here the same way too.
REM Written into THIS run's dashboard after it is generated, never into the shared
REM report-template\ (concurrent runs would overwrite each other's values there).
set "RUN_INFO_FILE=%CD%\%DASHBOARD_DIR%\content\js\report-run-info.js"
set "REPORT_TEMPLATE_DIR=%PROJECT_DIR%\report-template"
set "RUN_INFO_TOTAL_APIS=%TOTAL_APIS%"
set "RUN_INFO_THREADS=%THREADS%"
set "RUN_INFO_RAMPUP=%RAMPUP%"
set "RUN_INFO_LOOPS=%LOOPS%"
set "RUN_INFO_NUM_USERS=%NUM_USERS%"
set "RUN_INFO_CSV=%CSV_FILE%"
set "RUN_INFO_STARTED=%RUN_STARTED%"

REM ---- Generate HTML Dashboard (only after a successful test run) ----
REM Same report template AND the same -q report-generator.properties filter
REM as the REST flow, so "Prepare - ..." internal samplers are excluded from
REM Passed/Failed/Total APIs/statistics/graphs here too.
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS_DIR%\Write-ReportRunInfo.ps1"
if errorlevel 1 (
    echo WARNING: Could not refresh report-run-info.js; the report's summary
    echo cells may show stale values.
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

REM ---- Add the actual per-user run counts to the generated report ----
REM Same helper the REST flow uses - see scripts\Write-ReportUserInfo.ps1.
set "USER_INFO_JTL=%CD%\%RESULT_FILE%"
set "USER_INFO_FILE=%CD%\%DASHBOARD_DIR%\content\js\report-user-info.js"
set "USER_INFO_NUM_USERS=%NUM_USERS%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS_DIR%\Write-ReportUserInfo.ps1"
if errorlevel 1 (
    echo WARNING: Could not write report-user-info.js; the report's Runs by
    echo User graph may be empty.
)
echo.
echo ========================================
echo JMeter SOAP API Automation
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
