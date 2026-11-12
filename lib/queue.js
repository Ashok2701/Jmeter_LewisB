import fsp from 'node:fs/promises';
import path from 'node:path';

import { OUTPUT_DIR } from './config.js';
import { parseCsv } from './csvSchema.js';
import { userTypeOfApiName } from './userTypes.js';

/**
 * The API execution queue of one run, derived from what JMeter has really done.
 *
 * Nothing here is simulated. The queue is the run's own test-data.csv (one entry
 * per row, in the order JMeter pulls them). Its status comes from results.jtl,
 * which JMeter appends to while the test runs (the .bat files switch on
 * jmeter.save.saveservice.autoflush so it is written as it happens):
 *
 *   "Prepare - <api>" sample   The test plan emits this at the start of every
 *                              row, right before the real call. Seeing it means
 *                              the API is now executing  -> Running.
 *   the next sample from the   That thread's real result for the same row
 *   same thread                (success=true/false, or REC_PASSFAIL=SKIPPED)
 *                                                          -> Passed / Failed / Skipped.
 *
 * Tying the result to its row through the thread (not through the result's
 * label) is what makes this work identically for REST, SOAP and SQL, whose
 * result labels are built differently but whose Prepare label always names the
 * row. The JTL is read incrementally, so polling a long run stays cheap.
 */

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_RUNS = 20;

const cache = (globalThis.__jmeterQueueStore ??= new Map());

/** The exact "Prepare - ..." label the test plan gives a row (see scripts\Prepare*.groovy). */
function prepareLabel(apiType, record) {
  const cell = (i) => String(record[i] ?? '');
  if (apiType === 'SOAP') {
    // ServiceName, PublicName, ... - the first non-empty of the two names the row.
    const name = cell(0).trim() || cell(1).trim();
    return `Prepare - ${name || '(unnamed SOAP row)'}`;
  }
  if (apiType === 'SQL') {
    // TestName, Query, ...
    return `Prepare - SQL ${cell(0).trim() || '(unnamed row)'}`;
  }
  // REST: Method, URL, ..., Path (index 5). Path falls back to the URL.
  return `Prepare - ${cell(0)} ${cell(5) || cell(1)}`;
}

/** The run's own run-config.json (written when it was started); {} if unreadable. */
async function readRunConfig(run) {
  try {
    const raw = await fsp.readFile(
      path.join(path.dirname(run.testDataPath), 'run-config.json'),
      'utf8'
    );
    const config = JSON.parse(raw);
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

async function buildState(run) {
  let text;
  try {
    text = await fsp.readFile(run.testDataPath, 'utf8');
  } catch {
    return null;
  }

  const records = parseCsv(text)
    .slice(1)
    .filter((cells) => cells.some((c) => String(c).trim() !== ''));
  if (!records.length) return null;

  const config = await readRunConfig(run);
  const apiNames = Array.isArray(config.apiNames) ? config.apiNames : [];
  const loops = Math.max(1, Number(run.loops) || 1);
  const rows = records.map((record, index) => ({
    index,
    name: apiNames[index] || String(record[5] || record[1] || record[0] || `API ${index + 1}`),
    key: prepareLabel(run.apiType, record),
    // How many times this API is expected to run. Normally Threads x Loops; in a
    // run split by user type only the threads of the API's own user type run it.
    expectedRuns: config.typeThreads
      ? (Number(config.typeThreads[userTypeOfApiName(apiNames[index])]) || 0) * loops
      : Math.max(1, Number(run.threads) * loops) || 1,
    started: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    error: '',
    elapsedMs: null,
  }));

  // Rows that share one label (the same endpoint listed twice) are told apart by
  // taking turns, in the order JMeter hands the rows out.
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }

  return {
    rows,
    byKey,
    seen: new Map(),
    threadRow: new Map(),
    // Per JMeter thread name: APIs it has finished, and the plan of which user
    // type / user code each thread uses (run-config.json -> threadPlan).
    threadDone: new Map(),
    // Paged runs: time spent on the pages of the API a thread is still paging through.
    pageMs: new Map(),
    plan: Array.isArray(config.threadPlan) ? config.threadPlan : [],
    offset: 0,
    cols: null,
    busy: null,
  };
}

/** Splits JTL text into records; a quoted field (a response body) may span lines. */
function splitRecords(text) {
  const records = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      inQuotes = !inQuotes;
    } else if (c === 10 && !inQuotes) {
      records.push(text.slice(start, text[i - 1] === '\r' ? i - 1 : i));
      start = i + 1;
    }
  }
  return { records, consumed: start };
}

function ingest(state, record) {
  if (!record) return;
  const fields = parseCsv(record)[0];
  if (!fields) return;

  if (!state.cols) {
    const idx = (name) => fields.indexOf(name);
    state.cols = {
      label: idx('label'),
      success: idx('success'),
      thread: idx('threadName'),
      code: idx('responseCode'),
      message: idx('responseMessage'),
      elapsed: idx('elapsed'),
      passFail: idx('REC_PASSFAIL'),
      // Only present when the run pages (REC_PAGING = seq|page|records|state|size|mode).
      paging: idx('REC_PAGING'),
    };
    return;
  }

  const c = state.cols;
  if (c.label < 0 || c.success < 0 || c.thread < 0) return;

  const label = fields[c.label] ?? '';
  const ok = fields[c.success] === 'true';
  const thread = fields[c.thread] ?? '';

  if (label.startsWith('Prepare - ')) {
    const rows = state.byKey.get(label);
    if (!rows) {
      state.threadRow.delete(thread);
      return;
    }
    const n = state.seen.get(label) ?? 0;
    state.seen.set(label, n + 1);
    const row = rows[n % rows.length];
    row.started += 1;
    if (ok) {
      state.threadRow.set(thread, row);
    } else {
      // The row could not even be prepared (e.g. an unparseable URL): it ends here.
      row.done += 1;
      row.failed += 1;
      state.threadDone.set(thread, (state.threadDone.get(thread) ?? 0) + 1);
      row.error ||= String(fields[c.message] || fields[c.code] || 'Request could not be prepared');
      state.threadRow.delete(thread);
    }
    return;
  }

  const row = state.threadRow.get(thread);
  if (!row) return;

  // A paged API is one queue row but several samples: it is only done on the page
  // that ends it (state other than MORE); the earlier pages just add up their time.
  const pageState = c.paging >= 0 ? String(fields[c.paging] ?? '').split('|')[3] : '';
  if (pageState === 'MORE') {
    state.pageMs.set(thread, (state.pageMs.get(thread) ?? 0) + (Number(fields[c.elapsed]) || 0));
    return;
  }
  state.threadRow.delete(thread);
  const earlierPagesMs = state.pageMs.get(thread) ?? 0;
  state.pageMs.delete(thread);

  row.done += 1;
  state.threadDone.set(thread, (state.threadDone.get(thread) ?? 0) + 1);
  const passFail = c.passFail >= 0 ? fields[c.passFail] : '';
  if (passFail === 'SKIPPED' || /\(SKIPPED\)\s*$/.test(label)) {
    row.skipped += 1;
    return;
  }
  if (c.elapsed >= 0) {
    const ms = Number(fields[c.elapsed]);
    if (Number.isFinite(ms)) row.elapsedMs = ms + earlierPagesMs;
  }
  if (!ok) {
    row.failed += 1;
    row.error ||= [fields[c.code], fields[c.message]].filter(Boolean).join(' ');
  } else if (pageState === 'FAILED' || pageState === 'REPEAT') {
    // The page itself answered, but paging could not continue: the data is incomplete.
    row.failed += 1;
    row.error ||= pageState === 'REPEAT' ? 'Pagination stopped: the same page was returned again' : 'Pagination stopped: the next page could not be read';
  }
}

// Reads whatever JMeter appended since the last call. Only complete records are
// consumed, so a line JMeter is halfway through writing is picked up next time.
async function pump(state, jtlPath) {
  let handle;
  try {
    handle = await fsp.open(jtlPath, 'r');
  } catch {
    return; // JMeter has not created the file yet
  }
  try {
    const { size } = await handle.stat();
    if (size < state.offset) {
      // The file was replaced: start over.
      state.offset = 0;
      state.cols = null;
      state.seen.clear();
      state.threadRow.clear();
      state.threadDone.clear();
      state.pageMs.clear();
      for (const row of state.rows) {
        Object.assign(row, { started: 0, done: 0, failed: 0, skipped: 0, error: '', elapsedMs: null });
      }
    }
    if (size === state.offset) return;

    const length = Math.min(size - state.offset, MAX_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);

    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return;

    const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
    const { records, consumed } = splitRecords(text);
    for (const record of records) ingest(state, record);
    state.offset += Buffer.byteLength(text.slice(0, consumed), 'utf8');
  } finally {
    await handle.close();
  }
}

function rowStatus(row, expected, finished) {
  // No thread was given this API (its user type got no threads): it never runs.
  if (expected === 0) return 'skipped';
  const inFlight = row.started - row.done;

  if (finished) {
    if (row.done === 0) return 'skipped'; // never executed (stopped, or failed before it)
    if (row.failed > 0) return 'failed';
    if (row.skipped === row.done) return 'skipped';
    return 'passed';
  }

  if (inFlight > 0) return 'running';
  if (row.done === 0) return 'pending';
  if (row.failed > 0) return 'failed';
  if (row.skipped === row.done) return 'skipped';
  // Passed every time so far, but with threads x loops > 1 it still has runs to
  // go; until they have all happened it is waiting for its next turn.
  return row.done >= expected ? 'passed' : 'pending';
}

/**
 * The queue of a run as the UI shows it:
 *   { available, running, total, counts, progress, current, items }
 * `run` is the stored run record (loadRun).
 */
export async function readRunQueue(run) {
  let state = cache.get(run.id);
  if (!state) {
    state = await buildState(run);
    if (!state) return { available: false };
    if (cache.size >= MAX_CACHED_RUNS) cache.delete(cache.keys().next().value);
    cache.set(run.id, state);
  }

  // Concurrent polls (two tabs, a batch) share one read instead of racing on the offset.
  const jtlName = run.outputName || run.outputFolderName;
  if (jtlName) {
    state.busy ??= pump(state, path.join(OUTPUT_DIR, jtlName, 'results.jtl')).finally(() => {
      state.busy = null;
    });
    await state.busy;
  }

  const finished = run.status !== 'running';
  const loops = Math.max(1, Number(run.loops) || 1);

  const items = state.rows.map((row) => ({
    order: row.index + 1,
    name: row.name,
    status: rowStatus(row, row.expectedRuns, finished),
    executed: Math.min(row.done, row.expectedRuns),
    expected: row.expectedRuns,
    failed: row.failed,
    elapsedMs: row.elapsedMs,
    error: row.failed > 0 ? row.error : '',
  }));

  // Rows the CSV listed but normalisation dropped (no endpoint, bad URL): they
  // are never given to JMeter, so they are Skipped from the start.
  for (const name of run.skippedRows ?? []) {
    items.push({
      order: items.length + 1,
      name: String(name),
      status: 'skipped',
      executed: 0,
      expected: 0,
      failed: 0,
      elapsedMs: null,
      error: '',
    });
  }

  const counts = { pending: 0, running: 0, passed: 0, failed: 0, skipped: 0 };
  for (const item of items) counts[item.status] += 1;

  // Progress counts every individual execution (an API called by 3 threads x 2
  // loops is 6), so the bar keeps moving through a multi-thread / multi-loop run
  // and only equals "APIs finished / total APIs" when each runs once.
  const totalRuns = state.rows.reduce((sum, row) => sum + row.expectedRuns, 0);
  const doneRuns = state.rows.reduce((sum, row) => sum + Math.min(row.done, row.expectedRuns), 0);
  const percent = finished && run.status === 'completed'
    ? 100
    : totalRuns
      ? Math.min(100, Math.round((doneRuns / totalRuns) * 100))
      : 0;

  // One entry per thread: its user type, its user code (from the run's thread
  // plan - the same assignment the threads use) and what it is doing now.
  const threads = state.plan.map((p) => {
    const done = state.threadDone.get(p.jmeterThread) ?? 0;
    const row = state.threadRow.get(p.jmeterThread);
    const perThread = p.apis != null ? p.apis * loops : null;
    let status = 'waiting';
    if (row) status = 'running';
    else if (finished) status = done > 0 ? 'done' : 'notrun';
    else if (perThread !== null && done >= perThread) status = 'done';
    return {
      label: p.label,
      userType: p.userType,
      userCode: p.userCode || '',
      codes: Array.isArray(p.codes) ? p.codes : null,
      status,
      current: row ? row.name : '',
      executed: perThread !== null ? Math.min(done, perThread) : done,
      total: perThread,
    };
  });

  return {
    available: true,
    threads,
    running: !finished,
    started: state.rows.some((row) => row.started > 0),
    total: items.length,
    counts,
    progress: {
      percent,
      completed: counts.passed + counts.failed + counts.skipped,
      total: items.length,
      executions: { done: doneRuns, total: totalRuns },
    },
    current: items.filter((item) => item.status === 'running').map((item) => item.name),
    items,
  };
}
