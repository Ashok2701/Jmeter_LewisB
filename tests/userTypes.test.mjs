import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { loadAppCsv } from '../lib/appCsv.js';
import { normaliseCsv, parseCsv } from '../lib/csvSchema.js';
import { buildRolesPlan, buildThreadPlan, splitApiCsvByType } from '../lib/rolePlan.js';
import { USER_TYPES, supportsUserTypeThreads, userTypeOfApiName, validateTypeThreads } from '../lib/userTypes.js';

const BASE_PLAN = 'bat/JMeter_API_Automation.jmx';

test('only Merchandiser App REST can be split by user type', () => {
  assert.equal(supportsUserTypeThreads('Merchandiser App', 'REST'), true);
  assert.equal(supportsUserTypeThreads('Merchandiser App', 'SOAP'), false);
  assert.equal(supportsUserTypeThreads('Route App', 'REST'), false);
});

test('every API name maps to its user type', () => {
  assert.equal(userTypeOfApiName('Merchandiser - Orders'), 'merchandiser');
  assert.equal(userTypeOfApiName('Sales Manager - Orders'), 'manager');
  assert.equal(userTypeOfApiName('DSM - Orders'), 'dsm');
  assert.equal(userTypeOfApiName('SALCO - Orders'), 'salco');
  assert.equal(userTypeOfApiName('VP - Orders'), 'vp');
  assert.equal(userTypeOfApiName('Admin - Orders'), 'admin');
  assert.equal(userTypeOfApiName('Other - Orders'), null);
  assert.equal(userTypeOfApiName('merchandiser - x'), 'merchandiser');
});

test('thread allocation: optional, but must add up to Total Threads', () => {
  assert.deepEqual(validateTypeThreads({}, 15), { ok: true, value: null });
  assert.deepEqual(validateTypeThreads({ merchandiser: '', manager: ' ' }, 15), { ok: true, value: null });
  assert.deepEqual(validateTypeThreads({ merchandiser: '10', manager: '5' }, 15), {
    ok: true,
    value: { merchandiser: 10, manager: 5 },
  });
  // Zeros are allowed and drop the type.
  assert.deepEqual(validateTypeThreads({ merchandiser: '15', manager: '0' }, '15').value, { merchandiser: 15 });
  assert.match(validateTypeThreads({ merchandiser: '10', manager: '4' }, 15).message, /add up to 14.*Total Threads is 15/);
  assert.match(validateTypeThreads({ merchandiser: '10' }, 15).message, /add up to 10/);
  assert.match(validateTypeThreads({ merchandiser: '-1' }, 15).message, /whole number/);
  assert.match(validateTypeThreads({ vp: '1.5' }, 15).message, /whole number/);
  assert.match(validateTypeThreads({ admin: 'x' }, 15).message, /Admins/);
});

test('the Merchandiser workbook splits cleanly into the six user types', async () => {
  const loaded = await loadAppCsv('Merchandiser App', 'REST');
  const parts = splitApiCsvByType(loaded.buffer.toString('utf8'));
  assert.equal(parts.ok, true);
  assert.deepEqual(Object.keys(parts.byType), USER_TYPES.map((t) => t.key));

  const total = Object.values(parts.byType).reduce((n, p) => n + p.apiNames.length, 0);
  assert.equal(total, parseCsv(loaded.buffer.toString('utf8')).length - 1, 'every API belongs to exactly one type');

  // Each type's list holds only its own APIs and normalises on its own.
  for (const type of USER_TYPES) {
    const part = parts.byType[type.key];
    assert.ok(part.apiNames.length > 0, `${type.label} has APIs`);
    assert.ok(part.apiNames.every((n) => userTypeOfApiName(n) === type.key), `${type.label} APIs only`);
    const n = normaliseCsv(part.csv);
    assert.equal(n.ok, true, `${type.label} normalises`);
    assert.equal(n.apiCount, part.apiNames.length);
  }
  // Role sheets used by each type; Admin has fixed values and no sheet.
  assert.deepEqual(parts.byType.merchandiser.roleSlugs, ['merchandisers']);
  assert.deepEqual(parts.byType.manager.roleSlugs, ['managers']);
  assert.deepEqual(parts.byType.salco.roleSlugs, ['sales_coordinator']);
  assert.deepEqual(parts.byType.admin.roleSlugs, []);
});

test('an API outside every user type is reported', () => {
  const out = splitApiCsvByType('API_ID,API_NAME,ENDPOINT,BASE_URL\n1,Mystery - X,/a,https://h\n');
  assert.equal(out.ok, false);
  assert.match(out.message, /Mystery - X/);
});

test('the generated plan has one Thread Group per type and the original plan is untouched', () => {
  const base = fs.readFileSync(BASE_PLAN, 'utf8');
  const plan = buildRolesPlan(base, [
    { label: 'Merchandisers', threads: 10, rows: 9, csvPath: 'D:\\runs\\a b\\test-data-merchandiser.csv' },
    { label: 'Managers', threads: 5, rows: 12, csvPath: 'D:\\runs\\a b\\test-data-manager.csv' },
  ]);

  const count = (re, text = plan) => (text.match(re) || []).length;
  assert.equal(count(/<ThreadGroup /g), 2);
  assert.equal(count(/<\/ThreadGroup>/g), 2);
  assert.equal(count(/<ResultCollector /g), 1, 'one Results Writer, not one per group');
  // Element tags stay balanced.
  const opens = count(/<hashTree>/g);
  assert.equal(opens, count(/<\/hashTree>/g));
  assert.equal(count(/<CSVDataSet /g), 2);
  assert.equal(count(/<JSR223Sampler /g), count(/<JSR223Sampler /g, base) * 2);

  // Per group: its own name, threads, row count, CSV and per-thread CSV sharing.
  assert.match(plan, /testname="API Execution - Merchandisers"/);
  assert.match(plan, /testname="API Execution - Managers"/);
  assert.deepEqual([...plan.matchAll(/ThreadGroup\.num_threads">(\d+)</g)].map((m) => m[1]), ['10', '5']);
  assert.ok(plan.includes('${__P(LOOPS,1)} as int * 9 as int'));
  assert.ok(plan.includes('${__P(LOOPS,1)} as int * 12 as int'));
  assert.ok(plan.includes('D:\\runs\\a b\\test-data-merchandiser.csv'));
  assert.equal(count(/shareMode\.thread/g), 2);
  assert.equal(count(/shareMode\.all/g), 0);
  // ONE overall ramp-up for every group.
  assert.equal(count(/ThreadGroup\.ramp_time">\$\{__P\(RAMPUP,1\)\}</g), 2);

  assert.ok(base.includes('${__P(THREADS,1)}'), 'the source plan is not modified');
});

async function workbookParts() {
  const loaded = await loadAppCsv('Merchandiser App', 'REST');
  const parts = splitApiCsvByType(loaded.buffer.toString('utf8'));
  const codesByRole = new Map();
  for (const [role, code] of parseCsv(loaded.userCodesCsv).slice(1)) {
    if (!codesByRole.has(role)) codesByRole.set(role, []);
    codesByRole.get(role).push(code);
  }
  return { parts: parts.byType, codesByRole };
}

test('thread plan: thread N of a type takes code N of its own sheet, never random', async () => {
  const { parts, codesByRole } = await workbookParts();
  const split = [
    { key: 'merchandiser', label: 'Merchandisers', threads: 3 },
    { key: 'manager', label: 'Managers', threads: 2 },
    { key: 'admin', label: 'Admins', threads: 1 },
  ];
  const plan = buildThreadPlan({ parts, split, totalThreads: 6, codesByRole });
  const again = buildThreadPlan({ parts, split, totalThreads: 6, codesByRole });
  assert.deepEqual(plan, again, 'the same input always gives the same assignment');

  const m = codesByRole.get('merchandisers');
  const g = codesByRole.get('managers');
  assert.deepEqual(
    plan.map((p) => [p.jmeterThread, p.userType, p.userCode]),
    [
      ['API Execution - Merchandisers 1-1', 'Merchandiser', m[0]],
      ['API Execution - Merchandisers 1-2', 'Merchandiser', m[1]],
      ['API Execution - Merchandisers 1-3', 'Merchandiser', m[2]],
      ['API Execution - Managers 2-1', 'Manager', g[0]],
      ['API Execution - Managers 2-2', 'Manager', g[1]],
      ['API Execution - Admins 3-1', 'Admin', ''],
    ]
  );
  assert.equal(plan[0].apis, parts.merchandiser.apiNames.length);
});

test('thread plan: an unsplit run lists the code of every user type for each thread', async () => {
  const { parts, codesByRole } = await workbookParts();
  const plan = buildThreadPlan({ parts, split: null, totalThreads: 2, codesByRole });
  assert.equal(plan.length, 2);
  assert.equal(plan[1].jmeterThread, 'API Execution - Thread Group 1-2');
  assert.equal(plan[1].userType, 'All user types');
  const second = Object.fromEntries(plan[1].codes.map((c) => [c.userType, c.userCode]));
  assert.equal(second.Merchandiser, codesByRole.get('merchandisers')[1]);
  assert.equal(second.Manager, codesByRole.get('managers')[1]);
  assert.equal(second.DSM, codesByRole.get('dsm')[1]);
  assert.equal(second.Admin, undefined, 'Admin has no user code');
});

test('thread plan: more threads than codes wraps round (unsplit runs only)', async () => {
  const { parts, codesByRole } = await workbookParts();
  const n = codesByRole.get('vp').length;
  const plan = buildThreadPlan({ parts, split: null, totalThreads: n + 1, codesByRole });
  const vp = (p) => p.codes.find((c) => c.userType === 'VP').userCode;
  assert.equal(vp(plan[n]), vp(plan[0]));
});
