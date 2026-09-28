/**
 * SOAP CSV schema detection and normalisation - the SOAP counterpart of
 * csvSchema.js. Reuses that file's CSV parser/serialiser/header-matching so
 * both schemas quote and detect columns identically; only the column set and
 * the row-building logic differ.
 *
 * JMeter_SOAP_Automation.jmx declares a fixed, 7-name variable list on its CSV
 * Data Set Config and maps columns to those names POSITIONALLY (the header
 * row is skipped, not read) - exactly like the REST test plan. This module
 * converts any uploaded SOAP CSV into that canonical 7-column layout before
 * the run, so the .jmx keeps reading a fixed shape while the columns the
 * client's CSV actually uses (in whatever order, alongside whatever other
 * columns it carries) remain the real source of truth.
 *
 * Reference format (see SOAP_APIs.csv): SERVICE_NO, SERVICE_NAME,
 * PUBLIC_NAME, SOAP_ENDPOINT, SOAP_VERSION, SOAP_ACTION, CODE_LANG,
 * POOL_ALIAS, POOL_ID, REQUEST_CONFIG, REQUEST_XML, INPUT_PARAMETERS,
 * EXPECTED_RESPONSE, EXPECTED_STATUS, EXPECTED_MESSAGE.
 *
 * Of those, REQUEST_XML in that reference file is already a complete,
 * ready-to-send SOAP envelope - publicName, callContext (codeLang/poolAlias/
 * poolId/requestConfig) and every business parameter are already inlined by
 * whoever built the CSV. So CODE_LANG/POOL_ALIAS/POOL_ID/REQUEST_CONFIG/
 * SOAP_VERSION/INPUT_PARAMETERS/EXPECTED_RESPONSE affect nothing about what
 * gets sent and are not carried into the canonical CSV; only what the test
 * plan actually needs to route the call and judge the result is kept:
 * PUBLIC_NAME/SERVICE_NAME (identity), SOAP_ENDPOINT (where to send),
 * SOAP_ACTION (a header), REQUEST_XML (the body), and EXPECTED_STATUS /
 * EXPECTED_MESSAGE (what a passing response looks like).
 */

import { normaliseHeader, parseCsv, serialiseCsv } from './csvSchema.js';

// The exact variableNames list in JMeter_SOAP_Automation.jmx, in order.
export const CANONICAL_SOAP_COLUMNS = [
  'ServiceName',
  'PublicName',
  'SoapEndpoint',
  'SoapAction',
  'RequestXml',
  'ExpectedStatus',
  'ExpectedMessage',
];

// The Sage X3 generic SOAP web service every existing SOAP CSV posts to
// (Merchandiser_SOAP_APIs.csv and Route_SOAP_APIs.csv: all 66 rows are
// SOAP_HOST + this path). SOAP_SERVICE_PATH in .env overrides it.
const DEFAULT_SOAP_SERVICE_PATH = '/soap-generic/syracuse/collaboration/syracuse/CAdxWebServiceXmlCC';

/**
 * What a SOAP_ENDPOINT cell means. A full http(s) URL is used exactly as
 * written. Otherwise the cell may name the Sage X3 pool the call goes to (e.g.
 * "Pilot"): when it matches SOAP_POOL_ALIAS from .env it resolves to
 * SOAP_HOST + the service path, the same URL the URL-style CSVs spell out.
 * Anything else is returned unchanged, so it still fails the URL check below
 * and its row is skipped - a name that is not the configured pool is never
 * guessed at.
 */
export function resolveSoapEndpoint(value) {
  const endpoint = String(value ?? '').trim();
  if (!endpoint || /^https?:\/\//i.test(endpoint)) return endpoint;

  const alias = (process.env.SOAP_POOL_ALIAS ?? '').trim();
  const host = (process.env.SOAP_HOST ?? '').trim().replace(/\/+$/, '');
  if (!alias || !host || endpoint.toLowerCase() !== alias.toLowerCase()) return endpoint;

  const path = (process.env.SOAP_SERVICE_PATH ?? '').trim() || DEFAULT_SOAP_SERVICE_PATH;
  return `${host}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Identifies a SOAP CSV from its header row. Requires PUBLIC_NAME,
 * SOAP_ENDPOINT and REQUEST_XML - the three columns with no sensible
 * default - so a CSV missing any of them is rejected with a clear reason
 * rather than silently producing calls to nowhere with an empty body.
 */
export function detectSoapSchema(rows) {
  if (!rows.length) return { schema: 'unknown', reason: 'The CSV file is empty.' };

  const header = rows[0].map(normaliseHeader);
  const has = (name) => header.includes(name);
  const indexOf = (name) => header.indexOf(name);

  const missing = [];
  if (!has('publicname')) missing.push('PUBLIC_NAME');
  if (!has('soapendpoint')) missing.push('SOAP_ENDPOINT');
  if (!has('requestxml')) missing.push('REQUEST_XML');

  if (missing.length) {
    return {
      schema: 'unknown',
      reason:
        `This does not look like a SOAP API CSV - missing column(s): ${missing.join(', ')}. ` +
        'Expected at least PUBLIC_NAME, SOAP_ENDPOINT and REQUEST_XML columns ' +
        '(SERVICE_NAME, SOAP_ACTION, EXPECTED_STATUS and EXPECTED_MESSAGE are used when present). Found: ' +
        rows[0].map((c) => c.trim()).filter(Boolean).join(', '),
    };
  }

  return {
    schema: 'soap',
    headerIndex: 0,
    columns: {
      serviceName: indexOf('servicename'),
      publicName: indexOf('publicname'),
      soapEndpoint: indexOf('soapendpoint'),
      soapAction: indexOf('soapaction'),
      requestXml: indexOf('requestxml'),
      expectedStatus: indexOf('expectedstatus'),
      expectedMessage: indexOf('expectedmessage'),
    },
  };
}

/**
 * Converts an uploaded SOAP CSV into the canonical 7-column layout the .jmx
 * reads. Returns the same result shape normaliseCsv() (the REST equivalent)
 * does - { ok, schema, csv, apiCount, apiNames, skipped } - so both schemas'
 * results can be handled identically by the routes that call them.
 */
export function normaliseSoapCsv(text) {
  const rows = parseCsv(text);
  const detected = detectSoapSchema(rows);

  if (detected.schema === 'unknown') {
    return { ok: false, message: detected.reason };
  }

  const dataRows = rows.slice(detected.headerIndex + 1);
  if (!dataRows.length) {
    return {
      ok: false,
      message: 'The CSV file must contain a header row and at least one SOAP API row.',
    };
  }

  const cols = detected.columns;
  const out = [CANONICAL_SOAP_COLUMNS];
  const names = [];
  const skipped = [];

  dataRows.forEach((row, index) => {
    const publicName = (row[cols.publicName] ?? '').trim();
    const serviceName = cols.serviceName >= 0 ? (row[cols.serviceName] ?? '').trim() : '';
    const soapEndpoint = resolveSoapEndpoint(row[cols.soapEndpoint]);
    const requestXml = (row[cols.requestXml] ?? '').trim();
    const apiName = serviceName || publicName || `row ${index + 2}`;

    if (!publicName || !soapEndpoint || !requestXml) {
      skipped.push(apiName);
      return;
    }

    let parsed;
    try {
      parsed = new URL(soapEndpoint);
    } catch {
      skipped.push(apiName);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      skipped.push(apiName);
      return;
    }

    const record = new Array(CANONICAL_SOAP_COLUMNS.length).fill('');
    record[0] = serviceName;
    record[1] = publicName;
    record[2] = soapEndpoint;
    record[3] = cols.soapAction >= 0 ? (row[cols.soapAction] ?? '').trim() : '';
    record[4] = requestXml;
    record[5] = cols.expectedStatus >= 0 ? (row[cols.expectedStatus] ?? '').trim() : '';
    record[6] = cols.expectedMessage >= 0 ? (row[cols.expectedMessage] ?? '').trim() : '';

    out.push(record);
    names.push(apiName);
  });

  if (!names.length) {
    return {
      ok: false,
      message:
        'No usable SOAP API rows were found in the CSV - every row was missing ' +
        'PUBLIC_NAME, SOAP_ENDPOINT or REQUEST_XML, or had a SOAP_ENDPOINT that ' +
        'could not be parsed as a URL.',
    };
  }

  return {
    ok: true,
    schema: 'soap',
    csv: serialiseCsv(out),
    apiCount: names.length,
    apiNames: names,
    skipped,
  };
}
