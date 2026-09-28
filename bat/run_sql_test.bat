@echo off
setlocal EnableDelayedExpansion
REM ============================================================
REM run_sql_test.bat <threads> <ramp-up-seconds> <loops> [csv-file]
REM
REM SQL counterpart of run_jmeter_test.bat / run_soap_test.bat: runs
REM sql_test.jmx in non-GUI mode with a configurable Thread Group
REM (Threads / Ramp-Up / Loops), then generates an HTML Dashboard
REM into a unique, timestamped output folder using the SAME report
REM template and internal-sample filter as the REST/SOAP flows.
REM No Duration setting is used.
REM
REM Examples:
REM   run_sql_test.bat 1 1 1        (smoke test, uses SQL_Queries.csv)
REM   run_sql_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
REM
REM The optional 4th argument is the CSV of SQL test cases. It is passed to
REM the test plan as the CSV_FILE property, which the CSV Data Set Config
REM reads. Omit it and SQL_Queries.csv in this folder is used.
REM
REM The number of data rows in that CSV is counted here and passed as
REM CSV_ROW_COUNT, which the Thread Group's loop count uses
REM (loops = LOOPS x CSV_ROW_COUNT) - same mechanism as the REST/SOAP flows.
REM
REM Report metadata (Application Name / API Type) is read from the APP_NAME /
REM API_TYPE environment variables when set, exactly as in
REM run_jmeter_test.bat / run_soap_test.bat.
REM
REM Unlike REST/SOAP, there is no website login here: the database connection
REM is authenticated from DB_USER/DB_PASSWORD in .env (loaded below), never
REM prompted for, never passed as an argument, and never a JMeter -J property
REM (JMeter echoes every -J value to the console and to jmeter.log - DB_HOST/
REM DB_PORT/DB_NAME/DB_USER/DB_PASSWORD reach sql_test.jmx purely through this
REM process's own environment, which the JVM below inherits, and are read
REM there with System.getenv(...) inside a Groovy function expression). None
REM of them are ever written into the CSV, the JMX file, the JTL, or the HTML
REM report.
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
set "TEST_PLAN=sql_test.jmx"
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

REM ---- Database configuration must come from .env, never typed here ----
if not defined DB_HOST (
    echo ERROR: DB_HOST is not set. Add DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD to "%ENV_FILE%".
    set "EXITCODE=1"
    goto :END
)
if not defined DB_NAME (
    echo ERROR: DB_NAME is not set. Add DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD to "%ENV_FILE%".
    set "EXITCODE=1"
    goto :END
)
if not defined DB_USER (
    echo ERROR: DB_USER is not set. Add DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD to "%ENV_FILE%".
    set "EXITCODE=1"
    goto :END
)
if not defined DB_PASSWORD (
    echo ERROR: DB_PASSWORD is not set. Add DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD to "%ENV_FILE%".
    set "EXITCODE=1"
    goto :END
)
if not defined DB_PORT set "DB_PORT=1433"

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

REM ---- Resolve the CSV of SQL test cases to run (4th arg, else SQL_Queries.csv) ----
if "%~4"=="" (
    set "CSV_FILE=%PROJECT_DIR%\SQL_Queries.csv"
) else (
    set "CSV_FILE=%~f4"
)

if not exist "%CSV_FILE%" (
    echo ERROR: CSV file not found: "%CSV_FILE%"
    set "EXITCODE=1"
    goto :END
)

REM Count the SQL test rows in THAT csv - record count, not line count, so a
REM quoted field containing newlines (e.g. a multi-line SQL query) does not
REM inflate the total. This drives CSV_ROW_COUNT below, so every row of the
REM supplied CSV actually runs.
set "TOTAL_APIS="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "@(Import-Csv -LiteralPath $env:CSV_FILE).Count"`) do set "TOTAL_APIS=%%A"
if not defined TOTAL_APIS set "TOTAL_APIS=0"

if "%TOTAL_APIS%"=="0" (
    echo ERROR: No SQL test rows were found in "%CSV_FILE%".
    set "EXITCODE=1"
    goto :END
)

goto :PARAMS_OK

:USAGE
echo Usage: run_sql_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
echo   Example (smoke test):  run_sql_test.bat 1 1 1
echo   Example (own CSV):     run_sql_test.bat 1 1 1 "D:\runs\run-1\test-data.csv"
set "EXITCODE=1"
goto :END

:BADPARAMS
echo.
echo Usage: run_sql_test.bat ^<threads^> ^<ramp-up-seconds^> ^<loops^> [csv-file]
set "EXITCODE=1"
goto :END

:PARAMS_OK

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
echo JMeter SQL Query Automation
echo ========================================
echo Application: %APP_NAME%
echo API Type: %API_TYPE%
echo CSV File: %CSV_FILE%
echo Total Queries: %TOTAL_APIS%
echo Database: %DB_HOST%,%DB_PORT% / %DB_NAME%
echo Threads:  %THREADS%
echo Ramp-Up:  %RAMPUP% seconds
echo Loops:    %LOOPS%
echo Test Started: %DATE% %TIME%
echo.

REM ---- Run JMeter in non-GUI mode. THREADS/RAMPUP/LOOPS are passed as
REM      JMeter properties read by the Thread Group in the .jmx.
REM      DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD are already present in
REM      this process's own environment (loaded from .env above) and are read
REM      directly from there by sql_test.jmx via System.getenv() - never
REM      passed as -J properties, so none of them are ever echoed to the
REM      console or to jmeter.log the way -J values are. ----
REM CSV_FILE / CSV_ROW_COUNT are quoted as whole tokens so a path containing
REM spaces reaches JMeter as a single argument.
call "%JMETER_BAT%" -n -t "%TEST_PLAN%" -l "%RESULT_FILE%" -j "%LOG_FILE%" -JTHREADS=%THREADS% -JRAMPUP=%RAMPUP% -JLOOPS=%LOOPS% "-JCSV_FILE=%CSV_FILE%" "-JCSV_ROW_COUNT=%TOTAL_APIS%" -Jsample_variables=REC_METHOD,REC_URL,REC_APINAME,REC_PASSFAIL,REC_ERROR,REC_RESPONSE
set "JMETER_EXIT_CODE=%ERRORLEVEL%"

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
REM Same helper the REST/SOAP flows use - every value belongs to the run that
REM just executed, nothing is hard-coded. See scripts\Write-ReportRunInfo.ps1.
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
REM Same report template AND the same -q report-generator.properties filter
REM as the REST/SOAP flows: it excludes "Prepare - ..." labelled samples, and
REM every SQL sample here is labelled "SQL <TestName>" (or "Prepare - SQL
REM <TestName>" / "SQL <TestName> (SKIPPED)"), so the existing filter and the
REM webapp's existing summary logic both work unchanged.
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
echo JMeter SQL Query Automation
echo ========================================
echo Result File: %CD%\%RESULT_FILE%
echo JMeter Log:  %CD%\%LOG_FILE%
echo HTML Report: %CD%\%DASHBOARD_DIR%\index.html
echo Test Completed
echo ========================================
set "EXITCODE=0"

:END
pause
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
