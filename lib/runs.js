import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  OUTPUT_DIR,
  PROJECT_DIR,
  RUNS_DIR,
  RUN_TIMEOUT_MS,
} from './config.js';
import { readRunSummary } from './summary.js';

// Next.js dev mode re-evaluates modules on hot reload; keeping the registry on
// globalThis means an in-flight run is not orphaned by a recompile.
const store = (globalThis.__jmeterRunStore ??= {
  runs: new Map(),
  activeRunId: null,
});

const MAX_LOG_TAIL_CHARS = 8000;

function runRecordPath(id) {
  return path.join(RUNS_DIR, `${id}.json`);
}

export function runLogPath(id) {
  return path.join(RUNS_DIR, `${id}.log`);
}

async function persist(run) {
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  const { ...serializable } = run;
  await fsp.writeFile(
    runRecordPath(run.id),
    JSON.stringify(serializable, null, 2),
    'utf8'
  );
}

/** Public shape returned to the browser - never includes credentials. */
export function toPublicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    applicationName: run.applicationName,
    apiType: run.apiType,
    baseUrl: run.baseUrl ?? '',
    threads: run.threads,
    rampup: run.rampup,
    loops: run.loops,
    csvName: run.csvName,
    csvRows: run.csvRows,
    csvSchema: run.csvSchema ?? null,
    skippedRows: run.skippedRows ?? [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
    reportAvailable: Boolean(run.reportAvailable),
    reportUrl: run.reportAvailable ? `/api/report/${run.id}/index.html` : null,
    summary: run.summary ?? null,
    outputFolder: run.outputFolderName ?? null,
    error: run.error ?? null,
    logTail: run.status === 'failed' ? (run.logTail ?? null) : null,
  };
}

export function getRun(id) {
  return store.runs.get(id) ?? null;
}

/** Falls back to the on-disk record so report links survive a server restart. */
export async function loadRun(id) {
  const inMemory = store.runs.get(id);
  if (inMemory) return inMemory;
  try {
    const raw = await fsp.readFile(runRecordPath(id), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getActiveRun() {
  if (!store.activeRunId) return null;
  const run = store.runs.get(store.activeRunId);
  return run && run.status === 'running' ? run : null;
}

async function listOutputDirs() {
  try {
    const entries = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

/**
 * The .bat prints "HTML Report: <abs path>\dashboard\index.html" on success.
 * That is the authoritative answer; the before/after directory diff is the
 * fallback for a run whose output was truncated or reworded.
 */
function parseReportPath(consoleOutput) {
  const match = consoleOutput.match(/^HTML Report:\s*(.+?)\s*$/m);
  return match ? match[1] : null;
}

async function resolveOutputFolder(run, consoleOutput, dirsBefore) {
  const reported = parseReportPath(consoleOutput);
  if (reported) {
    // ...\output\<timestamp>\dashboard\index.html -> <timestamp>
    const dashboardDir = path.dirname(reported);
    const runDir = path.dirname(dashboardDir);
    if (path.dirname(runDir) === OUTPUT_DIR) {
      return path.basename(runDir);
    }
  }

  const dirsAfter = await listOutputDirs();
  const created = [...dirsAfter].filter((name) => !dirsBefore.has(name));
  if (created.length === 1) return created[0];
  if (created.length > 1) return created.sort().pop();
  return null;
}

/**
 * Starts the given .bat (run_jmeter_test.bat for REST, run_soap_test.bat for
 * SOAP - selected server-side by the route from the validated API Type, never
 * from anything client-supplied). Returns as soon as the process is spawned;
 * the caller polls getRun()/loadRun() for completion.
 *
 * Security notes:
 *  - The executable is one of exactly two fixed constants (BAT_PATH /
 *    SOAP_BAT_PATH in config.js). Nothing user-supplied ever reaches the
 *    command name.
 *  - threads/rampup/loops are pre-validated digits-only strings.
 *  - shell:false, so no shell metacharacter interpretation is possible.
 *  - stdin is ignored, so if the .bat ever reached one of its interactive
 *    prompts (or its trailing `pause`) it gets EOF and fails fast instead of
 *    hanging the server forever.
 */
export async function startRun({
  id,
  applicationName,
  apiType,
  baseUrl,
  threads,
  rampup,
  loops,
  username,
  password,
  csvName,
  csvRows,
  csvSchema,
  skippedRows,
  testDataPath,
  batName,
  batPath,
}) {
  const dirsBefore = await listOutputDirs();
  const logPath = runLogPath(id);

  await fsp.mkdir(RUNS_DIR, { recursive: true });

  const run = {
    id,
    status: 'running',
    applicationName,
    apiType,
    baseUrl,
    threads,
    rampup,
    loops,
    csvName,
    csvRows,
    csvSchema,
    skippedRows,
    testDataPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    reportAvailable: false,
    outputFolderName: null,
    error: null,
    logTail: null,
    command: `${batName} ${threads} ${rampup} ${loops} "${testDataPath}"`,
  };

  store.runs.set(id, run);
  store.activeRunId = id;
  await persist(run);

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(
    `=== ${run.startedAt} === ${run.command} (CSV: ${csvName}, ${csvRows} data rows)\r\n\r\n`
  );

  // PROJECT_DIR contains spaces, so the .bat path has to be quoted - but a
  // plain `cmd /c` strips that quote pair straight back off whenever the
  // quoted text names a real executable, splitting the path at the space. The
  // command line is therefore built in the canonical `cmd /s /c "" ... ""`
  // form and handed over verbatim: /s makes cmd strip exactly the outer quote
  // pair and take the rest literally. threads/rampup/loops are digits-only by
  // the time they reach here, so nothing interpolated below can alter the
  // command that runs.
  // The CSV path is this run's own test-data.csv, generated by the app - never
  // anything the client typed - so quoting it here cannot smuggle in arguments.
  const commandLine = `""${batPath}" ${threads} ${rampup} ${loops} "${testDataPath}""`;

  const child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
    cwd: PROJECT_DIR,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Pre-setting BOTH is what makes the .bat non-interactive: it skips its
      // username/password prompts AND its trailing `pause` (CREDS_PRESET=true).
      LOGIN_USERNAME: username,
      LOGIN_PASSWORD: password,
      // Read by scripts\Write-ReportRunInfo.ps1 when the .bat regenerates
      // report-run-info.js, so this run's own values reach its dashboard.
      // Passed as environment rather than arguments so any punctuation in an
      // application name is carried safely.
      APP_NAME: applicationName,
      API_TYPE: apiType,
      // The file JMeter reads is a normalised copy; the report should name the
      // file the client actually chose.
      CSV_DISPLAY_NAME: csvName,
      // Read by scripts\ApplyAuthHeader.groovy. An endpoint-list CSV
      // (API_NAME/ENDPOINT, optionally its own BASE_URL) has no login step of
      // its own, so unless a row supplies its own Authorization value, every
      // request defaults to HTTP Basic Auth using this run's own login
      // credentials - the standard authentication method for a stateless REST
      // API with no session step (e.g. Sage X3's Web Service REST API). A
      // Method/URL (har) export - which authenticates via its own captured
      // login request - never sets this, so that flow is unaffected.
      USE_BASIC_AUTH_DEFAULT: csvSchema === 'endpoint' ? 'true' : 'false',
    },
  });

  let consoleOutput = '';
  const capture = (chunk) => {
    const text = chunk.toString();
    consoleOutput += text;
    logStream.write(text);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const timeout = setTimeout(() => {
    run.error = `The test exceeded the maximum run time of ${Math.round(
      RUN_TIMEOUT_MS / 60000
    )} minutes and was stopped.`;
    // Kill the whole tree - the .bat spawns jmeter.bat, which spawns java.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    });
  }, RUN_TIMEOUT_MS);

  child.on('error', async (err) => {
    clearTimeout(timeout);
    logStream.end(`\r\n[launcher] Failed to start ${batName}: ${err.message}\r\n`);
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    run.error = `Could not start ${batName}: ${err.message}`;
    run.logTail = run.error;
    if (store.activeRunId === id) store.activeRunId = null;
    await persist(run);
  });

  child.on('close', async (code) => {
    clearTimeout(timeout);
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();

    const folder = await resolveOutputFolder(run, consoleOutput, dirsBefore);
    run.outputFolderName = folder;

    if (folder) {
      const indexPath = path.join(OUTPUT_DIR, folder, 'dashboard', 'index.html');
      run.reportAvailable = fs.existsSync(indexPath);
    }

    if (code === 0 && run.reportAvailable) {
      run.status = 'completed';
      run.error = null;
      // A run can finish cleanly with every API call failing - the .bat exits 0
      // because JMeter ran, not because the APIs responded. Summarise the
      // results so the UI can say so instead of only "Completed".
      run.summary = await readRunSummary(folder).catch(() => null);
    } else {
      run.status = 'failed';
      if (!run.error) {
        run.error =
          code === 0
            ? 'The test finished but the HTML report was not generated. Please check the execution logs.'
            : `JMeter test execution failed (exit code ${code}). Please check the execution logs.`;
      }
      run.reportAvailable = false;
    }

    run.logTail = consoleOutput.slice(-MAX_LOG_TAIL_CHARS);
    logStream.end(
      `\r\n[launcher] ${batName} exited with code ${code} at ${run.finishedAt}\r\n`
    );

    if (store.activeRunId === id) store.activeRunId = null;
    await persist(run);
  });

  return run;
}
