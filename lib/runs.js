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
  // Live child processes by run id - kept out of the run record, which is
  // written to disk. Used by stopRun().
  children: new Map(),
});
store.children ??= new Map();

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
    batchId: run.batchId ?? null,
    batchIndex: run.batchIndex ?? null,
    batchSize: run.batchSize ?? null,
    status: run.status,
    applicationName: run.applicationName,
    apiType: run.apiType,
    baseUrl: run.baseUrl ?? '',
    threads: run.threads,
    rampup: run.rampup,
    loops: run.loops,
    numUsers: run.numUsers ?? null,
    csvName: run.csvName,
    csvRows: run.csvRows,
    csvSchema: run.csvSchema ?? null,
    skippedRows: run.skippedRows ?? [],
    dbServer: run.dbServer ?? null,
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

/** Drops a finished run from memory once its History record has been deleted. */
export function forgetRun(id) {
  if (store.activeRunId !== id) store.runs.delete(id);
}

// Waits for the run's process to exit and its record to be saved as stopped.
function waitForStopped(run, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (run.status !== 'running' || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

/**
 * Stops one running execution: kills its whole process tree (the .bat, the
 * jmeter.bat it spawns, java, and any report-generation process) and lets the
 * normal exit handler record it as 'stopped'. Other runs are untouched - only
 * this run's own pid tree is killed.
 *
 * Returns { ok, status, message, run }.
 */
export async function stopRun(id) {
  const run = store.runs.get(id);
  const child = store.children.get(id);
  const pid = child?.pid ?? run?.pid;
  if (!run || run.status !== 'running' || !pid) {
    return { ok: false, status: 409, message: 'This execution is not running.', run };
  }
  if (!run.stopRequested) {
    run.stopRequested = true;
    const killTree = () =>
      new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', resolve);
        killer.on('close', resolve);
      });
    await killTree();
    // taskkill fails if the tree already exited; the close handler then
    // finishes the run on its own. A process started while the tree was being
    // walked can survive the first pass and keep the run "running", so sweep
    // again shortly after.
    setTimeout(killTree, 1500);
  }
  await waitForStopped(run, 15000);
  if (run.status === 'running') {
    return { ok: false, status: 500, message: 'The execution could not be stopped. Please try again.', run };
  }
  return { ok: true, status: 200, run };
}

export function getActiveRun() {
  if (!store.activeRunId) return null;
  const run = store.runs.get(store.activeRunId);
  return run && run.status === 'running' ? run : null;
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

/**
 * Every run is handed its own output folder name (RUN_OUTPUT_NAME), so the
 * folder is known up front. The "HTML Report:" line is still honoured first;
 * the assigned name is the fallback. Never a before/after listing of output\ -
 * with runs in parallel that would attribute another run's folder to this one.
 */
function resolveOutputFolder(consoleOutput, outputName) {
  const reported = parseReportPath(consoleOutput);
  if (reported) {
    // ...\output\<folder>\dashboard\index.html -> <folder>
    const dashboardDir = path.dirname(reported);
    const runDir = path.dirname(dashboardDir);
    if (path.dirname(runDir) === OUTPUT_DIR) {
      return path.basename(runDir);
    }
  }
  return fs.existsSync(path.join(OUTPUT_DIR, outputName)) ? outputName : null;
}

// yyyy-MM-dd_HHmmss in local time (the format the .bat files always used), plus
// the start of the run id, so two runs started in the same second get different
// folders and the name still sorts chronologically.
function outputFolderName(id) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(
    d.getHours()
  )}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return `${stamp}_${id.replace(/[^0-9a-f]/gi, '').slice(0, 8)}`;
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
  usersCsvPath = '',
  numUsers = null,
  csvName,
  csvRows,
  csvSchema,
  skippedRows,
  testDataPath,
  batName,
  batPath,
  dbConfig = null,
  batchId = null,
  batchIndex = null,
  batchSize = null,
  // Called once the run has finished and its record is saved (either way).
  onFinish = null,
}) {
  const outputName = outputFolderName(id);
  const logPath = runLogPath(id);

  await fsp.mkdir(RUNS_DIR, { recursive: true });

  const run = {
    id,
    batchId,
    batchIndex,
    batchSize,
    status: 'running',
    applicationName,
    apiType,
    baseUrl,
    threads,
    rampup,
    loops,
    numUsers,
    csvName,
    csvRows,
    csvSchema,
    skippedRows,
    testDataPath,
    // Query Testing only: where the queries ran, for display. The username and
    // password are never stored.
    dbServer: dbConfig ? `${dbConfig.host}:${dbConfig.port} / ${dbConfig.name}` : null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    reportAvailable: false,
    outputFolderName: null,
    // Known before the run ends (it is passed to the .bat as RUN_OUTPUT_NAME),
    // so the live execution queue can read this run's results.jtl while it is
    // still being written (lib/queue.js).
    outputName,
    pid: null,
    error: null,
    logTail: null,
    command: `${batName} ${threads} ${rampup} ${loops} "${testDataPath}"`,
  };

  store.runs.set(id, run);
  // activeRunId tracks the single stand-alone run; a batch's runs overlap, so
  // the batch (lib/batches.js) is what reports "something is running" for them.
  if (!batchId) store.activeRunId = id;
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
      // Multi-user runs: the CSV of every saved login for this application's
      // credential group (LOGIN_USERNAME,LOGIN_PASSWORD per row). Read by
      // scripts\AssignLoginUser.groovy, which gives each JMeter thread its own
      // row (thread 1 = row 1, ...). Only a path - never a credential - so it
      // is safe in an environment variable; unset for Query Testing and for a
      // .bat started by hand, where LOGIN_USERNAME/LOGIN_PASSWORD above apply.
      ...(usersCsvPath ? { LOGIN_USERS_CSV: usersCsvPath } : {}),
      // Read by scripts\Write-ReportRunInfo.ps1 when the .bat regenerates
      // report-run-info.js, so this run's own values reach its dashboard.
      // Passed as environment rather than arguments so any punctuation in an
      // application name is carried safely.
      APP_NAME: applicationName,
      API_TYPE: apiType,
      // This run's own output\<folder>, chosen here so concurrent runs can
      // never pick the same one (the .bat otherwise names it to the second).
      RUN_OUTPUT_NAME: outputName,
      // Read by scripts\Write-ReportRunInfo.ps1 for the report's Number of
      // Users / Number of Runs rows. Unset for Query Testing (no login).
      ...(numUsers ? { NUM_USERS: String(numUsers) } : {}),
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
      // Query Testing: this run's SQL Server connection, read by
      // run_sql_test.bat and, through the JVM's environment, by sql_test.jmx's
      // JDBC Connection Configuration (System.getenv). Set here, they take
      // precedence over the same names in .env. Never a command-line argument
      // or -J property, so never echoed to a console, log or report.
      ...(dbConfig
        ? {
            DB_HOST: dbConfig.host,
            DB_PORT: dbConfig.port,
            DB_NAME: dbConfig.name,
            DB_USER: dbConfig.user,
            DB_PASSWORD: dbConfig.password,
          }
        : {}),
    },
  });

  // Recorded so a run can be matched to its OS process (and overlap proven).
  run.pid = child.pid ?? null;
  store.children.set(id, child);
  await persist(run);
  logStream.write(`[launcher] pid ${run.pid}, output folder ${outputName}\r\n`);

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
    store.children.delete(id);
    logStream.end(`\r\n[launcher] Failed to start ${batName}: ${err.message}\r\n`);
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    run.error = `Could not start ${batName}: ${err.message}`;
    run.logTail = run.error;
    if (store.activeRunId === id) store.activeRunId = null;
    await persist(run);
    onFinish?.(run);
  });

  // 'close' waits for the output pipes, which a stray grandchild process can
  // hold open after the .bat itself has died. Once a stopped run's process has
  // exited, release the pipes so the run is recorded as stopped promptly.
  child.on('exit', () => {
    if (!run.stopRequested) return;
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 2000);
  });

  child.on('close', async (code) => {
    clearTimeout(timeout);
    store.children.delete(id);
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();

    // Stopped by the user (stopRun): never completed or failed, never a report
    // link - whatever the output folder holds is a partial result.
    if (run.stopRequested) {
      run.outputFolderName = resolveOutputFolder(consoleOutput, outputName);
      run.status = 'stopped';
      run.reportAvailable = false;
      run.summary = null;
      run.error = 'Execution was stopped by the user.';
      run.logTail = consoleOutput.slice(-MAX_LOG_TAIL_CHARS);
      logStream.end(`
[launcher] Execution stopped by the user at ${run.finishedAt}
`);
      if (store.activeRunId === id) store.activeRunId = null;
      await persist(run);
      onFinish?.(run);
      return;
    }

    const folder = resolveOutputFolder(consoleOutput, outputName);
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
    onFinish?.(run);
  });

  return run;
}
