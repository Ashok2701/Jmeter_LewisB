import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { OUTPUT_DIR } from '../lib/config.js';
import { CANONICAL_COLUMNS, normaliseCsv, parseCsv } from '../lib/csvSchema.js';
import { PAGINATION, buildPaginationConfig, supportsPagination } from '../lib/pagination.js';
import { readRunQueue } from '../lib/queue.js';
import { buildRolesPlan } from '../lib/rolePlan.js';

test('only Merchandiser App REST can page', () => {
  assert.equal(supportsPagination('Merchandiser App', 'REST'), true);
  assert.equal(supportsPagination('Merchandiser App', 'SOAP'), false);
  assert.equal(supportsPagination('Route App', 'REST'), false);
});

test('pagination is fixed: all pages, 1,000 per page, and nothing limits it', () => {
  assert.deepEqual({ ...PAGINATION }, { mode: 'all', pageSize: 1000 });
  assert.equal(Object.isFrozen(PAGINATION), true);
  // No page limit anywhere: the settings carry none.
  assert.equal('maxPages' in PAGINATION, false);
});
const LIST = [
  'API_ID,API_NAME,ENDPOINT,BASE_URL,PAGINATION,PAGE_TYPE,PAGE_PARAM,SIZE_PARAM',
  '1,Merchandiser - Items,/a?representation=A.$query&count=1000,https://h,,,,',
  '2,Merchandiser - Orders,/b?x=1,https://h,No,,,',
  '3,Merchandiser - Offset,/c?x=1,https://h,Yes,offset,offset,limit',
  '4,Merchandiser - Pages,/d?x=1,https://h,,page,,',
].join('\n') + '\n';

test('per-API settings are read from the optional columns and keyed by the sample path', () => {
  const norm = normaliseCsv(LIST, {});
  const out = buildPaginationConfig(LIST, norm);
  assert.equal(out.ok, true);
  const rows = parseCsv(out.csv);
  assert.deepEqual(rows[0], ['PATH', 'PAGINATION', 'PAGE_TYPE', 'PAGE_PARAM', 'SIZE_PARAM']);
  // API 1 sets nothing: it just follows the run's setting and has no row.
  assert.deepEqual(rows.slice(1), [
    ['/b?x=1', 'no', '', '', ''],
    ['/c?x=1', 'yes', 'offset', 'offset', 'limit'],
    ['/d?x=1', '', 'page', '', ''],
  ]);
  // The PATH is what the test plan's Path column holds.
  const planPaths = parseCsv(norm.csv).slice(1).map((r) => r[CANONICAL_COLUMNS.indexOf('Path')]);
  assert.ok(rows.slice(1).every((r) => planPaths.includes(r[0])));
});

test('a list without pagination columns has no per-API settings', () => {
  const plain = 'API_ID,API_NAME,ENDPOINT,BASE_URL\n1,Merchandiser - X,/a?x=1,https://h\n';
  assert.deepEqual(buildPaginationConfig(plain, normaliseCsv(plain, {})), { ok: true, csv: '', apis: 0 });
});

test('bad per-API settings are rejected with the API named', () => {
  const bad = (cell, column = 'PAGINATION') => {
    const text = `API_ID,API_NAME,ENDPOINT,BASE_URL,${column}\n1,Merchandiser - X,/a?x=1,https://h,${cell}\n`;
    return buildPaginationConfig(text, normaliseCsv(text, {}));
  };
  assert.match(bad('maybe').message, /Merchandiser - X.*PAGINATION must be Yes or No/);
  assert.match(bad('zigzag', 'PAGE_TYPE').message, /link, page or offset/);
  assert.match(bad('a b', 'PAGE_PARAM').message, /not a valid query parameter name/);
});

test('the test plan pages inside a While loop and every generated group keeps it', () => {
  const base = fs.readFileSync('bat/JMeter_API_Automation.jmx', 'utf8');
  const count = (re, text) => (text.match(re) || []).length;

  assert.equal(count(/<WhileController /g, base), 1);
  assert.ok(base.includes('<stringProp name="WhileController.condition">${PAGE_MORE}</stringProp>'));
  assert.ok(base.includes('scripts/Paginate.groovy'));
  // The While loop sits inside the Execute-API branch and wraps the HTTP sample.
  const execute = base.indexOf('If Controller - Execute API');
  const loop = base.indexOf('<WhileController');
  const sampler = base.indexOf('<HTTPSamplerProxy');
  const skip = base.indexOf('If Controller - Skip API');
  assert.ok(execute < loop && loop < sampler && sampler < skip);
  assert.equal(count(/<hashTree>/g, base), count(/<\/hashTree>/g, base) + count(/<hashTree\/>/g, base) * 0, 'tags stay balanced');

  const plan = buildRolesPlan(base, [
    { label: 'Merchandisers', threads: 3, rows: 5, csvPath: 'a.csv' },
    { label: 'Managers', threads: 2, rows: 4, csvPath: 'b.csv' },
  ]);
  assert.equal(count(/<WhileController /g, plan), 2, 'one pagination loop per user-type group');
  assert.equal(count(/scripts\/Paginate\.groovy/g, plan), 2);
  assert.equal(count(/<HTTPSamplerProxy /g, plan), 2);
});

// ---- the Test Running popup ----
const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,success,failureMessage,REC_PASSFAIL,REC_PAGING\n';
const row = (thread, label, ms, code, ok, paging = '') => `1,${ms},${label},${code},,${thread},${ok},,${ok ? 'PASS' : 'FAIL'},${paging}\n`;

function queueSetup() {
  const id = `paging-queue-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paging-run-'));
  const outputDir = path.join(OUTPUT_DIR, id);
  fs.mkdirSync(outputDir, { recursive: true });
  const record = new Array(CANONICAL_COLUMNS.length).fill('');
  record[0] = 'GET';
  record[1] = 'https://host/a';
  record[5] = '/a';
  fs.writeFileSync(path.join(runDir, 'test-data.csv'), [CANONICAL_COLUMNS.join(','), record.join(',')].join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'run-config.json'), JSON.stringify({ apiNames: ['Alpha'] }));
  const run = { id, status: 'running', apiType: 'REST', threads: '1', loops: '1', testDataPath: path.join(runDir, 'test-data.csv'), outputName: id, skippedRows: [] };
  return {
    run,
    jtl: path.join(outputDir, 'results.jtl'),
    cleanup: () => { fs.rmSync(runDir, { recursive: true, force: true }); fs.rmSync(outputDir, { recursive: true, force: true }); },
  };
}

test('queue: a paged API stays Running until its last page, and adds the page times', async () => {
  const { run, jtl, cleanup } = queueSetup();
  try {
    const T = 'Group 1-1';
    fs.writeFileSync(jtl, HEADER + row(T, 'Prepare - GET /a', 1, 200, true));
    fs.appendFileSync(jtl, row(T, 'GET /a', 100, 200, true, '1|1|1000|MORE|1000|all'));
    let q = await readRunQueue(run);
    assert.equal(q.items[0].status, 'running', 'page 1 of several is not the end of the API');

    fs.appendFileSync(jtl, row(T, 'GET /a', 150, 200, true, '1|2|1000|MORE|1000|all'));
    assert.equal((await readRunQueue(run)).items[0].status, 'running');

    fs.appendFileSync(jtl, row(T, 'GET /a', 50, 200, true, '1|3|400|END|1000|all'));
    q = await readRunQueue(run);
    assert.equal(q.items[0].status, 'passed');
    assert.equal(q.items[0].elapsedMs, 300, 'time of all three pages');
  } finally {
    cleanup();
  }
});

test('queue: a failed intermediate page or a repeated page marks the API Failed', async () => {
  for (const [state, ok, message] of [['FAILED', false, /500/], ['REPEAT', true, /same page/]]) {
    const { run, jtl, cleanup } = queueSetup();
    try {
      const T = 'Group 1-1';
      fs.writeFileSync(jtl, HEADER + row(T, 'Prepare - GET /a', 1, 200, true));
      fs.appendFileSync(jtl, row(T, 'GET /a', 10, 200, true, '1|1|1000|MORE|1000|all'));
      fs.appendFileSync(jtl, row(T, 'GET /a', 10, ok ? 200 : 500, ok, `1|2|${ok ? 1000 : ''}|${state}|1000|all`));
      const q = await readRunQueue(run);
      assert.equal(q.items[0].status, 'failed');
      assert.match(q.items[0].error, message);
    } finally {
      cleanup();
    }
  }
});

test('queue: a run that does not page behaves exactly as before', async () => {
  const { run, jtl, cleanup } = queueSetup();
  try {
    const T = 'Group 1-1';
    fs.writeFileSync(jtl, 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,success,failureMessage,REC_PASSFAIL\n' + `1,1,Prepare - GET /a,200,,${T},true,,\n` + `1,42,GET /a,200,,${T},true,,PASS\n`);
    const q = await readRunQueue(run);
    assert.equal(q.items[0].status, 'passed');
    assert.equal(q.items[0].elapsedMs, 42);
  } finally {
    cleanup();
  }
});
