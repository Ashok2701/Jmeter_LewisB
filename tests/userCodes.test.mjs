import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { loadAppCsv } from '../lib/appCsv.js';
import { normaliseCsv, parseCsv } from '../lib/csvSchema.js';
import { roleSlug, workbookToApiCsv } from '../lib/userCodes.js';
import { readWorkbook, writeWorkbook } from '../lib/xlsx.js';

const WORKBOOK = 'csv files/Merchandiser_Rest_Apis_query.xlsx';
const BASE = 'https://sage.example.com/api1/x3/erp/PILOT';

const apis = (...rows) => ({
  name: 'APIs',
  rows: [['API_ID', 'API_NAME', 'ENDPOINT', 'BASE_URL', 'USER_ROLE'], ...rows],
});
const roleSheet = (name, codes) => ({ name, rows: [[name], ...codes.map((c) => [c])], textColumns: [0] });
const api = (id, name, ep, role = '') => [String(id), name, ep, BASE, role];
const toRows = (csv) => parseCsv(csv).slice(1);

test('workbook writer and reader round-trip text exactly (zeros, case, markup)', () => {
  const values = ['02B888', '020453', 'co2jb', 'A&B <x> "q"', ' keep '];
  const sheets = readWorkbook(writeWorkbook([roleSheet('Codes', values)]));
  assert.equal(sheets[0].name, 'Codes');
  assert.deepEqual(sheets[0].rows.slice(1).map((r) => r[0]), values);
  assert.equal(sheets[0].numericCells.length, 0);
});

test('every API stays ONE row; its token names its role and the codes go in a separate file', () => {
  const book = writeWorkbook([
    apis(
      api(1, 'Merchandiser - Orders', '/ORD?where=XM%20eq%20%27{USER_CODE}%27', 'Merchandisers'),
      api(2, 'Sales Manager - Orders', '/MORD?where=XS%20eq%20%27{USER_CODE}%27', 'Managers'),
      api(3, 'Admin - Orders', '/AORD?where=XA%20eq%20%27V0302%27')
    ),
    roleSheet('Merchandisers', ['02B888', '020453']),
    roleSheet('Managers', ['M0205']),
  ]);
  const out = workbookToApiCsv(book);
  assert.equal(out.ok, true);
  const rows = toRows(out.csv);
  assert.deepEqual(
    rows.map((r) => r[2]),
    [
      '/ORD?where=XM%20eq%20%27{USER_CODE:merchandisers}%27',
      '/MORD?where=XS%20eq%20%27{USER_CODE:managers}%27',
      '/AORD?where=XA%20eq%20%27V0302%27',
    ]
  );
  // API_NAME and BASE_URL are untouched and USER_ROLE never reaches the run.
  assert.deepEqual(rows.map((r) => r[1]), ['Merchandiser - Orders', 'Sales Manager - Orders', 'Admin - Orders']);
  assert.equal(parseCsv(out.csv)[0].join(), 'API_ID,API_NAME,ENDPOINT,BASE_URL');
  assert.ok(normaliseCsv(out.csv).ok);
  assert.equal(normaliseCsv(out.csv).apiCount, 3);

  // The codes, per role, in sheet order (leading zeros intact).
  assert.deepEqual(parseCsv(out.codesCsv), [
    ['ROLE', 'CODE'],
    ['merchandisers', '02B888'],
    ['merchandisers', '020453'],
    ['managers', 'M0205'],
  ]);
});

test('the token survives the run normalisation, so the label stays one per API', () => {
  const out = workbookToApiCsv(
    writeWorkbook([
      apis(api(1, 'Sales Coordinator - Orders', '/X?where=C%20eq%20%27{USER_CODE}%27', 'Sales Coordinator')),
      roleSheet('Sales Coordinator', ['C02JM', 'C06MC']),
    ])
  );
  const n = normaliseCsv(out.csv);
  assert.equal(n.ok, true);
  const path = parseCsv(n.csv)[1][5];
  assert.match(path, /\{USER_CODE:sales_coordinator\}/);
  assert.equal(roleSlug('Sales Coordinator'), 'sales_coordinator');
});

test('a new code on a sheet is used with no code change; repeated codes are listed once', () => {
  const build = (codes) =>
    workbookToApiCsv(
      writeWorkbook([
        apis(api(1, 'DSM - Orders', '/X?w=%27{USER_CODE}%27', 'DSM')),
        roleSheet('DSM', codes),
      ])
    );
  const codesOf = (out) => parseCsv(out.codesCsv).slice(1).map((r) => r[1]);
  assert.deepEqual(codesOf(build(['D0207', 'D0225'])), ['D0207', 'D0225']);
  assert.deepEqual(codesOf(build(['D0207', 'D0225', 'D0999'])), ['D0207', 'D0225', 'D0999']);
  assert.deepEqual(codesOf(build(['D0207', 'D0225', 'D0207'])), ['D0207', 'D0225']);
  // Still one API however many codes there are.
  assert.equal(toRows(build(['D0207', 'D0225', 'D0999']).csv).length, 1);
});

test('a sheet added to the workbook becomes a usable role', () => {
  const out = workbookToApiCsv(
    writeWorkbook([
      apis(api(1, 'Area - Orders', '/X?w={USER_CODE}', 'Area Managers')),
      roleSheet('Area Managers', ['A001', 'A002']),
    ])
  );
  assert.equal(out.ok, true);
  assert.match(toRows(out.csv)[0][2], /\{USER_CODE:area_managers\}/);
  assert.deepEqual(parseCsv(out.codesCsv).slice(1), [
    ['area_managers', 'A001'],
    ['area_managers', 'A002'],
  ]);
});

test('a workbook with no code-driven API has no codes file', () => {
  const out = workbookToApiCsv(
    writeWorkbook([apis(api(1, 'Admin - Orders', '/X?w=%27V1%27')), roleSheet('DSM', ['D1'])])
  );
  assert.equal(out.ok, true);
  assert.equal(out.codesCsv, '');
});

test('configuration mistakes are reported, not silently run', () => {
  const rows = [api(1, 'DSM - Orders', '/X?w={USER_CODE}', 'DSM')];
  const noRole = workbookToApiCsv(writeWorkbook([apis(api(1, 'DSM - O', '/X?w={USER_CODE}')), roleSheet('DSM', ['D1'])]));
  assert.match(noRole.message, /USER_ROLE is empty/);
  const noSheet = workbookToApiCsv(writeWorkbook([apis(...rows), roleSheet('VP', ['V1'])]));
  assert.match(noSheet.message, /no sheet with that name/);
  const noCodes = workbookToApiCsv(writeWorkbook([apis(...rows), roleSheet('DSM', [])]));
  assert.match(noCodes.message, /no user codes/);
  assert.match(workbookToApiCsv(Buffer.from('not a workbook')).message, /could not be read/);
  const alike = workbookToApiCsv(
    writeWorkbook([
      apis(api(1, 'A - X', '/X?w={USER_CODE}', 'Area Mgr'), api(2, 'B - X', '/Y?w={USER_CODE}', 'Area-Mgr')),
      roleSheet('Area Mgr', ['A1']),
      roleSheet('Area-Mgr', ['B1']),
    ])
  );
  assert.match(alike.message, /too alike/);
});

test('USER_CODES_MAX_PER_ROLE caps the codes listed per role', () => {
  const book = writeWorkbook([
    apis(api(1, 'DSM - Orders', '/X?w={USER_CODE}', 'DSM')),
    roleSheet('DSM', ['D1', 'D2', 'D3']),
  ]);
  process.env.USER_CODES_MAX_PER_ROLE = '2';
  try {
    assert.equal(parseCsv(workbookToApiCsv(book).codesCsv).length - 1, 2);
  } finally {
    delete process.env.USER_CODES_MAX_PER_ROLE;
  }
  assert.equal(parseCsv(workbookToApiCsv(book).codesCsv).length - 1, 3);
});

test('the Merchandiser workbook has the five role sheets and every code intact', () => {
  const sheets = readWorkbook(fs.readFileSync(WORKBOOK));
  const byName = Object.fromEntries(sheets.map((s) => [s.name, s]));
  assert.deepEqual(sheets.map((s) => s.name), ['APIs', 'Merchandisers', 'Managers', 'DSM', 'VP', 'Sales Coordinator']);

  const column = (s) => s.rows.slice(1).map((r) => r[0]);
  const counts = { Merchandisers: 1224, Managers: 59, DSM: 14, VP: 4, 'Sales Coordinator': 4 };
  for (const [name, n] of Object.entries(counts)) {
    assert.equal(byName[name].rows[0][0], name, `${name} column name`);
    assert.equal(column(byName[name]).length, n, `${name} code count`);
    assert.equal(byName[name].numericCells.length, 0, `${name} has no numeric cells`);
  }
  // Leading zeros and exact capitalisation.
  assert.ok(column(byName.Merchandisers).includes('020453'));
  assert.ok(column(byName.Merchandisers).includes('02B888'));
  assert.ok(column(byName.Merchandisers).every((c) => /^0\d[0-9AB]\d{3}$/.test(c)));
  assert.ok(column(byName.Managers).every((c) => /^M0[0-9A-Z]{3}$/.test(c)));
  assert.deepEqual(column(byName.VP), ['V0201', 'V0202', 'V0303', 'V0901']);
  assert.deepEqual(column(byName['Sales Coordinator']), ['C02JM', 'C06MC', 'CO2JB', 'CO2PS']);
});

test('Merchandiser App REST loads the workbook: one row per API, codes only in the codes file', async () => {
  const sheets = Object.fromEntries(readWorkbook(fs.readFileSync(WORKBOOK)).map((s) => [s.name, s]));
  const unique = (name) => [...new Set(sheets[name].rows.slice(1).map((r) => r[0]))];
  const apiRows = sheets.APIs.rows.slice(1);

  const loaded = await loadAppCsv('Merchandiser App', 'REST');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fileName, 'Merchandiser_Rest_Apis_query.xlsx');
  const rows = toRows(loaded.buffer.toString('utf8'));

  // Total APIs is the number of API definitions - not APIs x user codes.
  assert.equal(rows.length, apiRows.length);
  const n = normaliseCsv(loaded.buffer.toString('utf8'));
  assert.equal(n.ok, true);
  assert.equal(n.apiCount, apiRows.length);

  // Each code-driven API (one whose endpoint has {USER_CODE}) names its own role;
  // the others are untouched - a USER_ROLE on a row without the token (e.g. the
  // Admin APIs, which use a fixed value) does nothing.
  for (const def of apiRows) {
    const row = rows.find((r) => r[0] === def[0]);
    if (def[2].includes('{USER_CODE}')) {
      assert.ok(row[2].includes(`{USER_CODE:${roleSlug(def[4])}}`), `${def[1]} names role ${def[4]}`);
    } else {
      assert.ok(!row[2].includes('USER_CODE'), `${def[1]} has no placeholder`);
    }
  }

  // The codes file holds every unique code of every role in use, and only those.
  const listed = {};
  for (const [role, code] of parseCsv(loaded.userCodesCsv).slice(1)) (listed[role] ??= []).push(code);
  const used = new Set(apiRows.filter((r) => r[2].includes('{USER_CODE}')).map((r) => r[4]));
  assert.deepEqual(Object.keys(listed).sort(), [...used].map(roleSlug).sort());
  for (const sheet of used) assert.deepEqual(listed[roleSlug(sheet)], unique(sheet), `${sheet} codes`);
});
