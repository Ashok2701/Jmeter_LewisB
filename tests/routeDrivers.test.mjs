import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadAppCsv } from '../lib/appCsv.js';
import { parseCsv } from '../lib/csvSchema.js';
import { buildCodeThreadPlan } from '../lib/rolePlan.js';
import { shuffleUserCodesCsv, usesRandomUserCodes } from '../lib/userCodes.js';

test('Route App REST loads the workbook: 16 APIs, 127 drivers, {USER_CODE:drivers}', async () => {
  assert.ok(usesRandomUserCodes('Route App', 'REST'));
  assert.ok(!usesRandomUserCodes('Merchandiser App', 'REST'));
  assert.ok(!usesRandomUserCodes('Route App', 'SOAP'));

  const loaded = await loadAppCsv('Route App', 'REST');
  assert.ok(loaded.ok, loaded.message);
  assert.equal(loaded.fileName, 'Route_App_Rest_Apis.xlsx');
  assert.equal(parseCsv(loaded.buffer.toString('utf8')).length - 1, 16);
  assert.match(loaded.buffer.toString('utf8'), /\{USER_CODE:drivers\}/);
  assert.equal(parseCsv(loaded.userCodesCsv).length - 1, 127);
});

test('every run shuffles the same 127 drivers into a different order', async () => {
  const { userCodesCsv } = await loadAppCsv('Route App', 'REST');
  const codes = (csv) => parseCsv(csv).slice(1).map((r) => r[1]);
  const a = codes(shuffleUserCodesCsv(userCodesCsv));
  const b = codes(shuffleUserCodesCsv(userCodesCsv));
  assert.deepEqual([...a].sort(), codes(userCodesCsv).sort());
  assert.equal(new Set(a).size, 127);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, codes(userCodesCsv));
  assert.ok(a.every((c) => /^\d{6}$/.test(c))); // leading zeros kept
});

test('thread plan gives each thread its own driver and wraps only past the list', () => {
  const plan = buildCodeThreadPlan({ userType: 'Driver', codes: ['a', 'b', 'c'], totalThreads: 4, apiCount: 16 });
  assert.deepEqual(plan.map((p) => p.userCode), ['a', 'b', 'c', 'a']);
  assert.equal(plan[0].jmeterThread, 'API Execution - Thread Group 1-1');
});
