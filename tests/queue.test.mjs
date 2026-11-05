import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OUTPUT_DIR } from '../lib/config.js';
import { CANONICAL_COLUMNS } from '../lib/csvSchema.js';
import { readRunQueue } from '../lib/queue.js';

// The queue is read from results.jtl as JMeter writes it. These tests write a
// JTL the way JMeter does (a "Prepare - ..." sample, then the same thread's
// result) and check the status each API shows at every step.

const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,success,failureMessage,REC_PASSFAIL\n';
const sample = (thread, label, code, message, ok, passFail = '') =>
  `1,10,${label},${code},${message},${thread},${ok},,${passFail}\n`;

function restRow(method, apiPath) {
  const record = new Array(CANONICAL_COLUMNS.length).fill('');
  record[0] = method;
  record[1] = `https://host${apiPath}`;
  record[5] = apiPath;
  return record.join(',');
}

function setup(names, rows, overrides = {}) {
  const id = `queue-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-run-'));
  const outputDir = path.join(OUTPUT_DIR, id);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'test-data.csv'),
    [CANONICAL_COLUMNS.join(','), ...rows].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(runDir, 'run-config.json'), JSON.stringify({ apiNames: names }));
  const run = {
    id,
    status: 'running',
    apiType: 'REST',
    threads: '1',
    loops: '1',
    testDataPath: path.join(runDir, 'test-data.csv'),
    outputName: id,
    skippedRows: [],
    ...overrides,
  };
  const jtl = path.join(outputDir, 'results.jtl');
  const cleanup = () => {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  };
  return { run, jtl, cleanup };
}

const statuses = (queue) => queue.items.map((i) => i.status);

test('a row moves Pending -> Running -> Passed/Failed/Skipped as JMeter writes its samples', async () => {
  const T = 'Group 1-1';
  const { run, jtl, cleanup } = setup(
    ['Alpha', 'Beta', 'Gamma'],
    [restRow('GET', '/a'), restRow('POST', '/b'), restRow('GET', '/c')]
  );
  try {
    // JMeter has not created the file yet.
    assert.deepEqual(statuses(await readRunQueue(run)), ['pending', 'pending', 'pending']);

    fs.writeFileSync(jtl, HEADER + sample(T, 'Prepare - GET /a', 200, 'OK', true));
    let q = await readRunQueue(run);
    assert.deepEqual(statuses(q), ['running', 'pending', 'pending']);
    assert.deepEqual(q.current, ['Alpha']);

    fs.appendFileSync(jtl, sample(T, 'GET /a', 200, 'OK', true, 'PASS'));
    fs.appendFileSync(jtl, sample(T, 'Prepare - POST /b', 200, 'OK', true));
    q = await readRunQueue(run);
    assert.deepEqual(statuses(q), ['passed', 'running', 'pending']);
    assert.equal(q.progress.percent, 33);

    // A record JMeter is half way through writing (open quote) must be left alone.
    fs.appendFileSync(jtl, `1,10,POST /b,500,"Server Error, ba`);
    assert.deepEqual(statuses(await readRunQueue(run)), ['passed', 'running', 'pending']);

    fs.appendFileSync(jtl, `d",${T},false,,FAIL\n`);
    q = await readRunQueue(run);
    assert.deepEqual(statuses(q), ['passed', 'failed', 'pending']);
    assert.equal(q.items[1].error, '500 Server Error, bad');

    fs.appendFileSync(
      jtl,
      sample(T, 'Prepare - GET /c', 'N/A', 'OK', true) +
        sample(T, 'GET /c', 'SKIPPED', 'Not executed', true, 'SKIPPED')
    );
    run.status = 'completed';
    q = await readRunQueue(run);
    assert.deepEqual(statuses(q), ['passed', 'failed', 'skipped']);
    assert.deepEqual(q.counts, { pending: 0, running: 0, passed: 1, failed: 1, skipped: 1 });
    assert.equal(q.progress.percent, 100);
  } finally {
    cleanup();
  }
});

test('a stopped run reports the APIs it never reached as Skipped', async () => {
  const T = 'Group 1-1';
  const { run, jtl, cleanup } = setup(['Alpha', 'Beta'], [restRow('GET', '/a'), restRow('GET', '/b')], {
    status: 'stopped',
  });
  try {
    fs.writeFileSync(
      jtl,
      HEADER + sample(T, 'Prepare - GET /a', 200, 'OK', true) + sample(T, 'GET /a', 200, 'OK', true, 'PASS')
    );
    assert.deepEqual(statuses(await readRunQueue(run)), ['passed', 'skipped']);
  } finally {
    cleanup();
  }
});

test('with several threads each thread\'s result is credited to the row it prepared', async () => {
  const { run, jtl, cleanup } = setup(['Alpha', 'Beta'], [restRow('GET', '/a'), restRow('GET', '/b')], {
    threads: '2',
  });
  try {
    // Two threads interleave: t1 prepares /a, t2 prepares /b, then t2 fails and t1 passes.
    fs.writeFileSync(
      jtl,
      HEADER +
        sample('G 1-1', 'Prepare - GET /a', 200, 'OK', true) +
        sample('G 1-2', 'Prepare - GET /b', 200, 'OK', true)
    );
    assert.deepEqual(statuses(await readRunQueue(run)), ['running', 'running']);

    fs.appendFileSync(
      jtl,
      sample('G 1-2', 'GET /b', 500, 'Boom', false, 'FAIL') + sample('G 1-1', 'GET /a', 200, 'OK', true, 'PASS')
    );
    // Each API is called by 2 threads, so one result is not yet "all done".
    const q = await readRunQueue(run);
    assert.deepEqual(statuses(q), ['pending', 'failed']);
    assert.equal(q.items[0].executed, 1);
    assert.equal(q.items[0].expected, 2);
  } finally {
    cleanup();
  }
});

test('rows dropped before the run are listed as Skipped', async () => {
  const { run, cleanup } = setup(['Alpha'], [restRow('GET', '/a')], { skippedRows: ['No endpoint row'] });
  try {
    const q = await readRunQueue(run);
    assert.equal(q.total, 2);
    assert.deepEqual(statuses(q), ['pending', 'skipped']);
  } finally {
    cleanup();
  }
});
