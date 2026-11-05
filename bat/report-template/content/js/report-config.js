/*
 * Fallback values for the dashboard's summary cells.
 *
 * Application Name and API Type are normally supplied per run - from the web
 * UI, or from the APP_NAME / API_TYPE environment variables when
 * run_jmeter_test.bat is run by hand - and land in content/js/report-run-info.js,
 * which takes precedence over this file.
 *
 * These values are only used when a run supplied neither, so they are
 * deliberately generic: a stale project name here would otherwise be
 * mislabelled onto somebody else's report.
 */
var REPORT_CONFIG = {
    applicationName: "Not specified",
    apiType: "Not specified"
};
