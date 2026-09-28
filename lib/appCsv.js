import fsp from 'node:fs/promises';
import path from 'node:path';

import { APPLICATIONS } from './applications.js';
import { CSV_FILES_DIR, MAX_CSV_BYTES } from './config.js';

// Which file in webapp\csv files\ each Application Name + API Type runs.
// Names are the files' actual names on disk (including "Mechandiser", as the
// file is spelled). null = no CSV exists yet for that combination; add the
// file to csv files\ and name it here to enable it.
const APP_CSV_FILES = {
  'Merchandiser App': {
    REST: 'Mechandiser_REST_APIs.csv',
    SOAP: 'Merchandiser_SOAP.csv',
  },
  'Route App': {
    REST: 'Route_REST_APIs.csv',
    SOAP: 'Route_SOAP.csv',
  },
  'Sales Order Adjustment Web App': {
    REST: 'Sales Order Rest APIs.csv',
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
  const fileName = APP_CSV_FILES[applicationName]?.[apiType];
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
  return { ok: true, fileName, buffer };
}
