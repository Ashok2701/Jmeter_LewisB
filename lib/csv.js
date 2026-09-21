import fsp from 'node:fs/promises';
import path from 'node:path';

import { TEST_RUNS_DIR } from './config.js';

/**
 * Creates this run's own directory and writes both CSVs into it:
 *
 *   test-runs/<runId>/uploaded.csv    exactly what the client sent, untouched
 *   test-runs/<runId>/test-data.csv   normalised to the 20 columns the .jmx reads
 *   test-runs/<runId>/run-config.json the full configuration of this run
 *
 * test-data.csv is what gets passed to run_jmeter_test.bat as its 4th argument,
 * so the CSV uploaded for THIS run is the one JMeter reads. Nothing is written
 * to a shared location, so a run can never pick up a previous run's CSV.
 */
export async function createRunDirectory(runId) {
  const dir = path.join(TEST_RUNS_DIR, runId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeRunCsvFiles(runDir, { uploadedBuffer, normalisedCsv }) {
  const uploadedPath = path.join(runDir, 'uploaded.csv');
  const testDataPath = path.join(runDir, 'test-data.csv');

  await fsp.writeFile(uploadedPath, uploadedBuffer);
  // UTF-8 without a BOM: the .jmx reads this file with fileEncoding=UTF-8 and
  // ignoreFirstLine=true, and a BOM would ride along on the first header cell.
  await fsp.writeFile(testDataPath, normalisedCsv, 'utf8');

  return { uploadedPath, testDataPath };
}

export async function writeRunConfig(runDir, config) {
  await fsp.writeFile(
    path.join(runDir, 'run-config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}
