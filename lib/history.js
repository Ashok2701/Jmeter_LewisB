import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUT_DIR, RUNS_DIR } from './config.js';
import { forgetRun, getActiveRun, runLogPath } from './runs.js';

// Run History is built from the record every run already writes to
// webapp\.runs\<run-id>.json (plus <run-id>.log for its console output) the
// moment it starts and again when it finishes - see lib/runs.js. That store
// survives page refreshes, browser restarts and server restarts, and every run
// has its own file, so nothing is ever overwritten. This module reads it (and
// deletes a record on request - see deleteHistoryRecord); the report and log
// are served by the existing /api/report and /api/run/<id>/log routes.

async function exists(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readRecord(file) {
  try {
    const record = JSON.parse(await fsp.readFile(file, 'utf8'));
    return record && typeof record.id === 'string' ? record : null;
  } catch {
    // A half-written or hand-edited file must not take the whole history down.
    return null;
  }
}

/** One History row: everything the page shows, never credentials or the log text. */
async function toHistoryEntry(record, activeId) {
  // A record still marked "running" that is not the run this server is
  // executing belongs to a run that was cut short (the app was stopped or
  // crashed mid-test) - it will never be updated, so show it as failed.
  const interrupted = record.status === 'running' && record.id !== activeId;
  const status = interrupted ? 'failed' : record.status;

  // The folder name comes from our own record, but is reduced to a bare name
  // anyway so it can only ever point inside output\.
  const folder = record.outputFolderName ? path.basename(record.outputFolderName) : null;
  const reportFile = folder ? path.join(OUTPUT_DIR, folder, 'dashboard', 'index.html') : null;
  const logFile = runLogPath(record.id);

  // 'available': the report is there; 'missing': the run produced one but the
  // file has since been deleted or moved; 'none': the run never produced one.
  let reportState = 'none';
  if (record.reportAvailable && reportFile) {
    reportState = (await exists(reportFile)) ? 'available' : 'missing';
  }
  const logAvailable = await exists(logFile);

  const summary = record.summary ?? null;
  const started = Date.parse(record.startedAt);
  const finished = record.finishedAt ? Date.parse(record.finishedAt) : NaN;

  return {
    id: record.id,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    durationSeconds:
      Number.isFinite(started) && Number.isFinite(finished)
        ? Math.max(0, Math.round((finished - started) / 1000))
        : null,
    applicationName: record.applicationName ?? '',
    // Runs saved before the API Type existed were all REST.
    apiType: record.apiType || 'REST',
    csvName: record.csvName ?? '',
    threads: record.threads ?? '',
    rampup: record.rampup ?? '',
    loops: record.loops ?? '',
    totalItems: record.csvRows ?? null,
    status,
    interrupted,
    exitCode: record.exitCode ?? null,
    error: interrupted
      ? 'The run did not finish - the application was stopped while it was still running.'
      : (record.error ?? null),
    dbServer: record.dbServer ?? null,
    passed: summary ? summary.apiPassed : null,
    failed: summary ? summary.apiErrors : null,
    reportState,
    reportUrl: reportState === 'available' ? `/api/report/${record.id}/index.html` : null,
    // Relative to the webapp folder, e.g. bat\output\2026-09-24_100000\dashboard\index.html.
    // Only for a run that produced a report - a failed run's output folder is
    // not a report location.
    reportPath: reportState !== 'none' ? path.relative(process.cwd(), reportFile) : null,
    logUrl: logAvailable ? `/api/run/${record.id}/log` : null,
    logPath: logAvailable ? path.relative(process.cwd(), logFile) : null,
  };
}

/** Every saved run, newest first. */
export async function listHistory() {
  let names;
  try {
    names = await fsp.readdir(RUNS_DIR);
  } catch {
    return [];
  }

  const activeId = getActiveRun()?.id ?? null;
  const records = await Promise.all(
    names.filter((n) => n.endsWith('.json')).map((n) => readRecord(path.join(RUNS_DIR, n)))
  );
  const entries = await Promise.all(
    records.filter(Boolean).map((record) => toHistoryEntry(record, activeId))
  );

  return entries.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

// Run ids are UUIDs made by the app itself; anything else is refused before it
// can become part of a file path.
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes one History record: its <run-id>.json record and <run-id>.log in
 * webapp\.runs - the two files the list above is built from. The report
 * folder under output\ and the run's inputs under test-runs\ are separate
 * artifacts (History already shows "report no longer available" when one is
 * gone) and are left exactly as they are. The run that is executing right now
 * cannot be deleted. The record goes last, so an interrupted delete never
 * leaves a listed record without its log.
 *
 * Returns { ok: true } or { ok: false, status, message }.
 */
export async function deleteHistoryRecord(id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) {
    return { ok: false, status: 400, message: 'That is not a valid run id.' };
  }

  const recordFile = path.join(RUNS_DIR, `${id}.json`);
  const record = await readRecord(recordFile);
  if (!record || record.id !== id) {
    return { ok: false, status: 404, message: 'That run is not in the history.' };
  }
  if (getActiveRun()?.id === id) {
    return { ok: false, status: 409, message: 'This run is still running and cannot be deleted yet.' };
  }

  await fsp.rm(runLogPath(id), { force: true });
  await fsp.rm(recordFile, { force: true });
  forgetRun(id);
  return { ok: true };
}