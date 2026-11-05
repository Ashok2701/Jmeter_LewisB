import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { RUNS_DIR } from './config.js';
import { getRun, startRun, stopRun, toPublicRun } from './runs.js';

// A batch is one click of Run Test with any number of test configurations. Each
// configuration is an ordinary run (lib/runs.js): its own run id, its own
// test-runs\<id> inputs, its own output\<folder> with results.jtl and HTML
// report, its own History record, log and JMeter process. The batch starts all
// of them at once and keeps the overall status until the last one has exited.
// Nothing is shared between them: each run gets its own output folder name
// (RUN_OUTPUT_NAME) and the .bat files write per-run report info into the run's
// own dashboard rather than into the shared report-template\.
//
// Batch records go to .runs\batches\ (not .runs itself) so History, which lists
// the *.json files in .runs, keeps showing one row per configuration run.

const store = (globalThis.__jmeterBatchStore ??= {
  batches: new Map(),
  activeBatchId: null,
});

const BATCH_DIR = path.join(RUNS_DIR, 'batches');

// Configurations finish at different times and each saves the batch record, so
// writes are chained: two overlapping writeFile calls could interleave.
function persist(batch) {
  batch.writing = (batch.writing ?? Promise.resolve()).then(async () => {
    try {
      await fsp.mkdir(BATCH_DIR, { recursive: true });
      await fsp.writeFile(
        path.join(BATCH_DIR, `${batch.id}.json`),
        JSON.stringify(toPublicBatch(batch), null, 2),
        'utf8'
      );
    } catch {
      // The batch record is a trace only; failing to write it must not stop a test.
    }
  });
  return batch.writing;
}

export function getActiveBatch() {
  if (!store.activeBatchId) return null;
  const batch = store.batches.get(store.activeBatchId);
  return batch && batch.status === 'running' ? batch : null;
}

export function getBatch(id) {
  return store.batches.get(id) ?? null;
}

/** Public shape for the browser. Per-configuration results stay separate. */
export function toPublicBatch(batch) {
  if (!batch) return null;
  const configs = batch.configs.map((c) => {
    const run = c.runId ? getRun(c.runId) : null;
    return {
      index: c.index,
      applicationName: c.applicationName,
      apiType: c.apiType,
      csvName: c.csvName,
      status: run ? run.status : c.status,
      error: run ? (run.error ?? c.error) : c.error,
      run: run ? toPublicRun(run) : null,
      runId: c.runId,
    };
  });
  return {
    id: batch.id,
    status: batch.status,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    total: configs.length,
    configs,
  };
}

function waitForFinish(startArgs) {
  return new Promise((resolve) => {
    startRun({ ...startArgs, onFinish: resolve }).then(
      (run) => {
        startArgs.onStarted?.(run);
      },
      (err) => resolve({ startError: err })
    );
  });
}

// One configuration, start to finish. Never throws: a failure here marks only
// this configuration failed and leaves the others running.
async function runConfig(batch, items, i) {
  const config = batch.configs[i];
  try {
    config.status = 'starting';
    const startArgs = await items[i].materialize();
    // "Stop all" arrived before this configuration got its process.
    if (batch.stopRequested) {
      config.status = 'stopped';
      config.error = 'Execution was stopped by the user.';
      return;
    }
    const result = await waitForFinish({
      ...startArgs,
      batchId: batch.id,
      batchIndex: i + 1,
      batchSize: items.length,
      onStarted: (run) => {
        config.runId = run.id;
        // A spawn error can already have failed the run by now.
        if (run.status === 'running') config.status = 'running';
        // "Stop all" was pressed while this one was still starting.
        if (batch.stopRequested && run.status === 'running') stopRun(run.id).catch(() => {});
        persist(batch);
      },
    });
    if (result?.startError) throw result.startError;
  } catch (err) {
    config.status = 'failed';
    config.error = `Could not run this configuration: ${err.message}`;
  }
  await persist(batch);
}

async function execute(batch, items) {
  // All configurations start together; the batch stays 'running' until every
  // one of them has finished (runConfig resolves only when its process exits).
  await Promise.all(items.map((_, i) => runConfig(batch, items, i)));

  const states = batch.configs.map((c) => (c.runId ? getRun(c.runId)?.status : c.status));
  const ok = states.filter((s) => s === 'completed').length;
  batch.status =
    ok === states.length
      ? 'completed'
      : states.every((s) => s === 'stopped')
        ? 'stopped'
        : ok === 0
          ? 'failed'
          : 'partial';
  batch.finishedAt = new Date().toISOString();
  if (store.activeBatchId === batch.id) store.activeBatchId = null;
  await persist(batch);
}

/**
 * Stops one configuration of a batch (runId), or every still-running one
 * (runId omitted). Only the chosen runs' process trees are killed; the rest of
 * the batch keeps running and the batch ends when the last one exits.
 */
export async function stopBatch(batch, runId = null) {
  if (runId) {
    const config = batch.configs.find((c) => c.runId === runId);
    if (!config) return { ok: false, status: 404, message: 'That execution is not part of this batch.' };
    return stopRun(runId);
  }
  batch.stopRequested = true;
  const ids = batch.configs
    .map((c) => c.runId)
    .filter((id) => id && getRun(id)?.status === 'running');
  await Promise.all(ids.map((id) => stopRun(id)));
  return { ok: true, status: 200 };
}

/**
 * items: [{ applicationName, apiType, csvName, materialize }] in run order.
 * materialize() writes that configuration's run directory and returns the
 * startRun() arguments - deferred until its turn so credentials are held in
 * memory only as long as needed and nothing is written for a config never run.
 */
export function startBatch(items) {
  const batch = {
    id: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    configs: items.map((item, i) => ({
      index: i + 1,
      applicationName: item.applicationName,
      apiType: item.apiType,
      csvName: item.csvName,
      status: 'pending',
      error: null,
      runId: null,
    })),
  };
  store.batches.set(batch.id, batch);
  store.activeBatchId = batch.id;
  persist(batch);
  execute(batch, items).catch(async (err) => {
    batch.status = 'failed';
    batch.finishedAt = new Date().toISOString();
    batch.error = err.message;
    if (store.activeBatchId === batch.id) store.activeBatchId = null;
    await persist(batch);
  });
  return batch;
}
