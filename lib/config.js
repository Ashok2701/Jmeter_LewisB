import path from 'node:path';

// The app lives in <project>/webapp, so the existing JMeter setup is one level up.
// Override with JMETER_PROJECT_DIR if the app is ever deployed elsewhere.
export const PROJECT_DIR = path.resolve(
  process.env.JMETER_PROJECT_DIR || path.join(process.cwd(), '..')
);

// The only two commands this app is ever allowed to execute - one per API
// Type. Which one runs for a given request is decided server-side from the
// validated apiType, never from a client-supplied path.
export const BAT_NAME = 'run_jmeter_test.bat';
export const BAT_PATH = path.join(PROJECT_DIR, BAT_NAME);

export const SOAP_BAT_NAME = 'run_soap_test.bat';
export const SOAP_BAT_PATH = path.join(PROJECT_DIR, SOAP_BAT_NAME);

// Each run gets its own directory under here, holding the CSV exactly as the
// client uploaded it, the normalised CSV actually handed to JMeter, and the
// run's configuration. Nothing is shared between runs and nothing overwrites
// APIs.csv in the project folder any more - the CSV path travels to JMeter as
// the CSV_FILE property instead.
export const TEST_RUNS_DIR = path.resolve(
  process.env.JMETER_TEST_RUNS_DIR || path.join(process.cwd(), 'test-runs')
);

// run_jmeter_test.bat creates output\<yyyy-MM-dd_HHmmss>\{results.jtl,jmeter.log,dashboard\}
export const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');

// App-owned state: one JSON record and one full console log per run.
// Kept inside webapp\ so nothing the JMeter setup owns is touched.
export const RUNS_DIR = path.join(process.cwd(), '.runs');

// Uploaded CSVs above this size are rejected before anything is written to disk.
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
