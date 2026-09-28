import path from 'node:path';

// LOCAL vs DEPLOYMENT is selected centrally in .env via ENVIRONMENT, with the
// matching LOCAL_PROJECT_DIR / DEPLOY_PROJECT_DIR supplying the actual path -
// the same switch bat\run_jmeter_test.bat and bat\run_soap_test.bat use, so
// this never has to be edited separately from them.
const ENVIRONMENT = (process.env.ENVIRONMENT || 'LOCAL').toUpperCase();
const SELECTED_PROJECT_DIR =
  ENVIRONMENT === 'DEPLOYMENT'
    ? process.env.DEPLOY_PROJECT_DIR
    : process.env.LOCAL_PROJECT_DIR;

// run_jmeter_test.bat / run_soap_test.bat / run_sql_test.bat ship inside the
// webapp itself (webapp\bat\) and are always found there.
export const BAT_DIR = path.join(process.cwd(), 'bat');

// Everything the .bat files depend on (the .jmx test plans, scripts\,
// report-template\, output\, SQL_Queries.csv) also lives in webapp\bat\, so
// the project is self-contained. LOCAL_PROJECT_DIR / DEPLOY_PROJECT_DIR are
// now only needed to point at a different folder with that same layout.
export const PROJECT_DIR = path.resolve(SELECTED_PROJECT_DIR || BAT_DIR);

// The only two commands this app is ever allowed to execute - one per API
// Type. Which one runs for a given request is decided server-side from the
// validated apiType, never from a client-supplied path.
export const BAT_NAME = 'run_jmeter_test.bat';
export const BAT_PATH = path.join(BAT_DIR, BAT_NAME);

export const SOAP_BAT_NAME = 'run_soap_test.bat';
export const SOAP_BAT_PATH = path.join(BAT_DIR, SOAP_BAT_NAME);

export const SQL_BAT_NAME = 'run_sql_test.bat';
export const SQL_BAT_PATH = path.join(BAT_DIR, SQL_BAT_NAME);

// Each run gets its own directory under here, holding the CSV exactly as the
// client uploaded it, the normalised CSV actually handed to JMeter, and the
// run's configuration. Nothing is shared between runs and nothing overwrites
// APIs.csv in the project folder any more - the CSV path travels to JMeter as
// the CSV_FILE property instead.
export const TEST_RUNS_DIR = path.resolve(
  process.env.JMETER_TEST_RUNS_DIR || path.join(PROJECT_DIR, 'test-runs')
);

// run_jmeter_test.bat creates output\<yyyy-MM-dd_HHmmss>\{results.jtl,jmeter.log,dashboard\}
export const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');

// App-owned state: one JSON record and one full console log per run.
// Kept inside webapp\ so nothing the JMeter setup owns is touched.
export const RUNS_DIR = path.join(process.cwd(), '.runs');

// The per-application API CSVs. Which one a run uses is decided server-side
// from the selected Application Name + API Type (see lib/appCsv.js).
export const CSV_FILES_DIR = path.join(process.cwd(), 'csv files');

// The logins saved under Configuration (see lib/credentials.js). Git-ignored;
// the passwords in it are encrypted with Windows DPAPI.
export const CREDENTIALS_FILE = path.join(process.cwd(), '.credentials.json');

// The users CSVs JMeter reads for multi-user runs (LOGIN_USERNAME,LOGIN_PASSWORD
// per row), regenerated from the saved logins every time they are saved or a
// run starts. They hold passwords in plain text - JMeter cannot read DPAPI -
// so the folder is git-ignored.
export const USERS_CSV_DIR = path.join(process.cwd(), 'credentials');

// CSVs above this size are rejected before anything is written to disk.
export const MAX_CSV_BYTES = 20 * 1024 * 1024;

// Hard ceilings so a typo (e.g. 100000 threads) cannot take the machine down.
// The .bat itself only enforces "whole number > 0".
export const LIMITS = {
  threads: 10000,
  rampup: 86400,
  loops: 100000,
};

// A run exceeding this is killed and marked failed, so a hung JMeter process
// never blocks the launcher forever. Default 6 hours.
export const RUN_TIMEOUT_MS =
  Number(process.env.JMETER_RUN_TIMEOUT_MS) || 6 * 60 * 60 * 1000;
