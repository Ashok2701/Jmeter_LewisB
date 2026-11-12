import fsp from 'node:fs/promises';
import path from 'node:path';

import { APPLICATIONS } from './applications.js';
import { CSV_FILES_DIR, MAX_CSV_BYTES } from './config.js';
import { CANONICAL_COLUMNS, parseCsv, serialiseCsv } from './csvSchema.js';
import { convertSalesQueryCsv, isSalesQueryCsv } from './salesQueryCsv.js';
import { soapUiProjectToCsv } from './soapUiProject.js';
import { workbookToApiCsv } from './userCodes.js';

// Which file in webapp\csv files\ each Application Name + API Type runs.
// Names are the files' actual names on disk (including "Mechandiser", as the
// file is spelled). null = no CSV exists yet for that combination; add the
// file to csv files\ and name it here to enable it.
const APP_CSV_FILES = {
  'Merchandiser App': {
    // A workbook: an APIs sheet plus one sheet of user codes per role (see
    // lib/userCodes.js). Every API is run once per code of its own role.
    REST: 'Merchandiser_Rest_Apis_query.xlsx',
    // A SoapUI project XML, like Route App SOAP (see lib/soapUiProject.js).
    SOAP: 'Merchandiser_SOAP_XML.xml',
  },
  'Route App': {
    REST: 'Route_REST_APIs.csv',
    // A SoapUI project, not a CSV: its request test steps are the only
    // service input for Route App SOAP (see lib/soapUiProject.js).
    SOAP: 'Route_SOAP_XML.xml',
  },
  'Sales Order Adjustment Web App': {
    // Sales Query layout (Base_URL / API_Name / HTTP_Method / Endpoint /
    // Parameter): converted at load time by lib/salesQueryCsv.js. An array
    // would run several files in one test, in order.
    REST: ['Sales_REST_APIs.csv'],
    SOAP: 'Sales_Order_Adjustment_SOAP.csv',
    // Query Testing: TestName,Query,Parameters,ExpectedRows,Enabled,Description
    SQL: 'Sales Order Queries.csv',
  },
};

/** The Application Name dropdown's value - only the listed applications. */
export function validateApplicationName(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return { ok: false, message: 'Please select the Application Name.' };
  }
  if (!APPLICATIONS.includes(value)) {
    return { ok: false, message: `Unknown Application Name "${value}".` };
  }
  return { ok: true, value };
}

/**
 * Reads the CSV for this Application Name + API Type from csv files\. The
 * path is built only from the fixed table above - nothing the client sends
 * ever becomes part of it.
 *
 * Returns { ok, fileName, buffer } or { ok: false, message }.
 */
export async function loadAppCsv(applicationName, apiType) {
  const entry = APP_CSV_FILES[applicationName]?.[apiType];
  if (Array.isArray(entry)) return loadCombinedCsv(applicationName, apiType, entry);
  return loadSingleCsv(applicationName, apiType, entry);
}

async function loadSingleCsv(applicationName, apiType, fileName) {
  if (!fileName) {
    return {
      ok: false,
      message: `No ${apiType} API CSV file is available for ${applicationName}. Add one to the "csv files" folder to run ${apiType} tests for this application.`,
    };
  }
  const filePath = path.join(CSV_FILES_DIR, fileName);
  let buffer;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_CSV_BYTES) {
      return {
        ok: false,
        message: `The CSV file "${fileName}" is too large (max ${Math.round(MAX_CSV_BYTES / 1024 / 1024)} MB).`,
      };
    }
    buffer = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        message: `The CSV file "${fileName}" for ${applicationName} (${apiType}) was not found in the "csv files" folder.`,
      };
    }
    return { ok: false, message: `The CSV file "${fileName}" could not be read: ${err.message}` };
  }

  if (!buffer.length) {
    return { ok: false, message: `The CSV file "${fileName}" is empty.` };
  }

  // A SoapUI project XML is converted in memory to the SOAP CSV layout, so the
  // rest of the run (normalise, run directory, JMeter) is unchanged.
  if (path.extname(fileName).toLowerCase() === '.xml') {
    const converted = soapUiProjectToCsv(buffer.toString('utf8'));
    if (!converted.ok) {
      return { ok: false, message: `${fileName}: ${converted.message}` };
    }
    return { ok: true, fileName, buffer: Buffer.from(converted.csv, 'utf8') };
  }
  // A workbook is expanded in memory to the same API CSV layout: each API that
  // takes a user code becomes one row per code of its role's sheet.
  if (path.extname(fileName).toLowerCase() === '.xlsx') {
    const converted = workbookToApiCsv(buffer, { fileName });
    if (!converted.ok) return { ok: false, message: converted.message };
    return {
      ok: true,
      fileName,
      buffer: Buffer.from(converted.csv, 'utf8'),
      userCodes: converted.summary,
      // ROLE,CODE rows for scripts\PrepareRequest.groovy; '' when no API takes a code.
      userCodesCsv: converted.codesCsv,
    };
  }
  return { ok: true, fileName, buffer };
}

/**
 * Several files, one run. The first file's rows come first and its header is
 * kept; every other file is converted to that same 20-column layout (only the
 * Sales Query layout is supported) and appended.
 */
async function loadCombinedCsv(applicationName, apiType, fileNames) {
  const loaded = [];
  for (const fileName of fileNames) {
    const one = await loadSingleCsv(applicationName, apiType, fileName);
    if (!one.ok) return one;
    loaded.push(one);
  }

  const skipped = [];
  let out;
  let rest = loaded;
  if (isSalesQueryCsv(loaded[0].buffer.toString('utf8'))) {
    out = [CANONICAL_COLUMNS];
  } else {
    out = parseCsv(loaded[0].buffer.toString('utf8'));
    rest = loaded.slice(1);
  }

  for (const one of rest) {
    const text = one.buffer.toString('utf8');
    if (!isSalesQueryCsv(text)) {
      return {
        ok: false,
        message: `The CSV file "${one.fileName}" is not in the Sales Query layout (needs Base_URL, API_Name, HTTP_Method, Endpoint, Parameter columns).`,
      };
    }
    const converted = convertSalesQueryCsv(text);
    if (!converted.ok) return { ok: false, message: `${one.fileName}: ${converted.message}` };
    out.push(...converted.rows);
    skipped.push(...converted.skipped);
  }

  return {
    ok: true,
    fileName: loaded.map((l) => l.fileName).join(' + '),
    buffer: Buffer.from(serialiseCsv(out), 'utf8'),
    skipped,
  };
}
