/**
 * SQL CSV schema detection and normalisation - the SQL counterpart of
 * csvSchema.js / soapCsvSchema.js. Reuses csvSchema.js's quoted-field-aware
 * CSV parser/serialiser so a SQL query containing commas, quotes or embedded
 * newlines round-trips correctly, exactly like the REST/SOAP schemas.
 *
 * sql_test.jmx declares this exact 6-name variable list on its CSV Data Set
 * Config and maps columns to those names POSITIONALLY (the header row is
 * skipped, not read) - exactly like the REST/SOAP test plans. This module
 * validates an uploaded SQL CSV strictly (see normaliseSqlCsv) and converts
 * it into that canonical 6-column layout before the run, so the .jmx keeps
 * reading a fixed shape while the CSV itself remains the single source of
 * truth for which SQL tests exist.
 *
 * Required header: TestName,Query,Parameters,ExpectedRows,Enabled,Description
 */

import { normaliseHeader, parseCsv, serialiseCsv } from './csvSchema.js';

// The exact variableNames list in sql_test.jmx, in order.
export const CANONICAL_SQL_COLUMNS = [
  'TestName',
  'Query',
  'Parameters',
  'ExpectedRows',
  'Enabled',
  'Description',
];

const REQUIRED_LABELS = CANONICAL_SQL_COLUMNS.join(', ');

/**
 * Identifies a SQL CSV from its header row. All six columns are required -
 * unlike the REST/SOAP schemas, nothing here has a sensible default, and a
 * missing column would either silently misread every row or (for ExpectedRows
 * / Enabled) make the pass/fail and execute/skip decision meaningless.
 */
export function detectSqlSchema(rows) {
  if (!rows.length) return { schema: 'unknown', reason: 'The CSV file is empty.' };

  const header = rows[0].map(normaliseHeader);
  const indexOf = (name) => header.indexOf(name);

  const columns = {
    testName: indexOf('testname'),
    query: indexOf('query'),
    parameters: indexOf('parameters'),
    expectedRows: indexOf('expectedrows'),
    enabled: indexOf('enabled'),
    description: indexOf('description'),
  };

  const missing = Object.entries({
    TestName: columns.testName,
    Query: columns.query,
    Parameters: columns.parameters,
    ExpectedRows: columns.expectedRows,
    Enabled: columns.enabled,
    Description: columns.description,
  })
    .filter(([, idx]) => idx < 0)
    .map(([name]) => name);

  if (missing.length) {
    return {
      schema: 'unknown',
      reason:
        `Invalid SQL CSV format.\n\nRequired columns: ${REQUIRED_LABELS}\n\n` +
        `Missing: ${missing.join(', ')}. Found: ` +
        rows[0].map((c) => c.trim()).filter(Boolean).join(', '),
    };
  }

  return { schema: 'sql', headerIndex: 0, columns };
}

const TRUE_FALSE = new Set(['true', 'false']);
// One key=value pair per "|"-separated segment, e.g. "Driver=DRV001|Active=2".
// Only the value (everything after the first "=") is ever bound to the
// query's "?" placeholders - the key name is documentation for whoever wrote
// the CSV.
function splitParameters(raw) {
  if (!raw) return [];
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validates and converts an uploaded SQL CSV into the canonical 6-column
 * layout sql_test.jmx reads. Unlike the REST/SOAP normalisers (which skip a
 * malformed row and keep going), a structurally invalid SQL CSV rejects the
 * whole file outright with a specific, row-numbered reason - per the
 * requirement that JMeter must never start against a CSV that hasn't been
 * validated first.
 */
export function normaliseSqlCsv(text) {
  const rows = parseCsv(text);
  const detected = detectSqlSchema(rows);

  if (detected.schema === 'unknown') {
    return { ok: false, message: detected.reason };
  }

  const dataRows = rows.slice(detected.headerIndex + 1);
  if (!dataRows.length) {
    return { ok: false, message: 'No SQL test cases found in the CSV.' };
  }

  const cols = detected.columns;
  const out = [CANONICAL_SQL_COLUMNS];
  const names = [];
  const seenNames = new Set();

  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    const rowNum = index + 2; // +1 for the header row, +1 for 1-based display

    const testName = (row[cols.testName] ?? '').trim();
    const query = (row[cols.query] ?? '').trim();
    const parametersRaw = (row[cols.parameters] ?? '').trim();
    const expectedRowsRaw = (row[cols.expectedRows] ?? '').trim();
    const enabledRaw = (row[cols.enabled] ?? '').trim();
    const enabled = enabledRaw.toLowerCase();
    const description = (row[cols.description] ?? '').trim();

    if (!testName) {
      return { ok: false, message: `Row ${rowNum}: TestName is required and cannot be empty.` };
    }
    if (seenNames.has(testName.toLowerCase())) {
      return {
        ok: false,
        message: `Row ${rowNum}: duplicate TestName "${testName}" - TestName must be unique.`,
      };
    }
    if (!query) {
      return {
        ok: false,
        message: `Row ${rowNum} ("${testName}"): Query is required and cannot be empty.`,
      };
    }
    // Empty = no row-count check for this query (scripts\ValidateSqlResult.groovy
    // then passes it whenever it runs without a SQL error).
    if (expectedRowsRaw && !/^\d+$/.test(expectedRowsRaw)) {
      return {
        ok: false,
        message:
          `Row ${rowNum} ("${testName}"): ExpectedRows must be empty or a whole number ` +
          `(0 or greater); got "${expectedRowsRaw}".`,
      };
    }
    if (!TRUE_FALSE.has(enabled)) {
      return {
        ok: false,
        message:
          `Row ${rowNum} ("${testName}"): Enabled must be "true" or "false"; got "${enabledRaw}".`,
      };
    }
    const badSegment = splitParameters(parametersRaw).find((s) => !s.includes('='));
    if (badSegment) {
      return {
        ok: false,
        message:
          `Row ${rowNum} ("${testName}"): Parameters segment "${badSegment}" is not in ` +
          'Key=Value format (use "Key=Value" or "Key1=Value1|Key2=Value2").',
      };
    }

    seenNames.add(testName.toLowerCase());
    out.push([testName, query, parametersRaw, expectedRowsRaw, enabled, description]);
    names.push(testName);
  }

  return {
    ok: true,
    schema: 'sql',
    csv: serialiseCsv(out),
    // Every row counts toward Total Queries, including Enabled=false ones -
    // they still run through the test plan and appear in the report as
    // SKIPPED, exactly like a REST/SOAP row the harness intentionally skips.
    apiCount: names.length,
    apiNames: names,
    skipped: [],
  };
}
