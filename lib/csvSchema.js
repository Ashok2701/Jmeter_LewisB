/**
 * CSV schema detection, API counting and normalisation.
 *
 * JMeter_API_Automation.jmx declares a fixed, 20-name variable list on its CSV
 * Data Set Config and maps columns to those names POSITIONALLY (the header row
 * is skipped, not read). So a CSV whose columns are in a different order - or a
 * different set entirely - is silently misread rather than rejected: an
 * API_ID/API_NAME/ENDPOINT file lands as Method/URL/Protocol, and every request
 * is built from nonsense.
 *
 * Rather than change how the test plan reads its CSV, this module converts any
 * supported CSV into that canonical 20-column layout before the run. The
 * normalised file is what gets handed to the .bat, so the uploaded CSV really is
 * the source of truth for the run while the .jmx keeps working unchanged.
 */

// The exact variableNames list in JMeter_API_Automation.jmx, in order.
export const CANONICAL_COLUMNS = [
  'Method',
  'URL',
  'Protocol',
  'Host',
  'Port',
  'Path',
  'Query_Parameters',
  'Request_Parameters',
  'Content_Type',
  'Accept',
  'Authorization',
  'Headers',
  'Cookies',
  'Request_Body',
  'CSRF_XSRF_Token',
  'Referer',
  'Origin',
  'User_Agent',
  'Response_Status_Code',
  'Response_Content_Type',
];

/** Parses CSV text into rows of fields, honouring quoted fields and embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  // A UTF-8 BOM would otherwise become part of the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      continue;
    }

    field += char;
    fieldStarted = true;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop rows that are entirely empty - a trailing newline, or a blank
  // separator line, is not an API.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Exported so soapCsvSchema.js can build its own canonical CSV with the same
// quoting rules - critical there, since a SOAP row's REQUEST_XML routinely
// contains commas, quotes and embedded newlines.
export function serialiseCsv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const value = cell == null ? '' : String(cell);
            return /[",\r\n]/.test(value)
              ? `"${value.replace(/"/g, '""')}"`
              : value;
          })
          .join(',')
      )
      .join('\r\n') + '\r\n'
  );
}

// Exported so soapCsvSchema.js identifies its own columns by header name the
// same tolerant way (case/punctuation-insensitive) - one definition of "these
// two header spellings mean the same column" for both schemas.
export const normaliseHeader = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Identifies the CSV layout from its header row.
 *  - "har"      the original 20-column export (Method / URL / Protocol / ...)
 *  - "endpoint" the API_ID / API_NAME / ENDPOINT list, whose endpoints are
 *               relative and need a base URL - supplied either by a BASE_URL
 *               column in the CSV itself, or (when that column is absent or
 *               empty) by the caller.
 */
export function detectSchema(rows) {
  if (!rows.length) return { schema: 'unknown', reason: 'The CSV file is empty.' };

  const header = rows[0].map(normaliseHeader);
  const has = (name) => header.includes(name);

  if (has('method') && has('url')) {
    return { schema: 'har', headerIndex: 0 };
  }
  if (has('endpoint') && (has('apiname') || has('apiid'))) {
    return {
      schema: 'endpoint',
      headerIndex: 0,
      columns: {
        apiId: header.indexOf('apiid'),
        apiName: header.indexOf('apiname'),
        endpoint: header.indexOf('endpoint'),
        method: header.indexOf('method'),
        // Optional: when the CSV itself carries a BASE_URL column, that value
        // is authoritative and no Base URL is ever asked of the user for this
        // file - see normaliseCsv below.
        baseUrl: header.indexOf('baseurl'),
        // Optional: a literal Authorization header value for this row, e.g.
        // "Bearer <token>" or a pre-built "Basic <base64>" - used exactly as
        // given. An endpoint list has no login step of its own, so without
        // this (or the Basic Auth default normaliseCsv falls back to) every
        // request against an authenticated API comes back 401.
        authorization: header.indexOf('authorization'),
      },
    };
  }

  return {
    schema: 'unknown',
    reason:
      'Unrecognised CSV format. Expected either a Method/URL export, or an ' +
      'API list with API_NAME and ENDPOINT columns. Found: ' +
      rows[0].map((c) => c.trim()).filter(Boolean).join(', '),
  };
}

function joinBaseAndEndpoint(baseUrl, endpoint) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const path = String(endpoint).trim();
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/**
 * Converts an uploaded CSV into the canonical 20-column layout the .jmx reads.
 * Returns the normalised CSV text plus the API count and the list of API names,
 * so the UI and the report describe exactly what will run.
 */
export function normaliseCsv(text, { baseUrl = '', defaultMethod = 'GET' } = {}) {
  const rows = parseCsv(text);
  const detected = detectSchema(rows);

  if (detected.schema === 'unknown') {
    return { ok: false, message: detected.reason };
  }

  const dataRows = rows.slice(detected.headerIndex + 1);
  if (!dataRows.length) {
    return {
      ok: false,
      message: 'The CSV file must contain a header row and at least one API row.',
    };
  }

  if (detected.schema === 'har') {
    // Already the layout the test plan expects - pass the rows through as they
    // are, only padding/trimming each to the exact column count so a short row
    // cannot shift later fields onto the wrong variable.
    const out = [CANONICAL_COLUMNS];
    const names = [];
    for (const row of dataRows) {
      const padded = CANONICAL_COLUMNS.map((_, i) => row[i] ?? '');
      out.push(padded);
      names.push(padded[5] || padded[1] || '');
    }
    return {
      ok: true,
      schema: 'har',
      csv: serialiseCsv(out),
      apiCount: names.length,
      apiNames: names,
    };
  }

  // endpoint schema - needs a base URL to become a real request. The CSV's own
  // BASE_URL column, when present and populated, is authoritative: the caller
  // is never asked for one, and whatever was passed in as `baseUrl` is only a
  // fallback for rows (or whole files) that don't carry their own.
  const cols = detected.columns;
  const hasBaseUrlColumn = cols.baseUrl >= 0;
  const externalBaseUrl = baseUrl ? String(baseUrl).trim() : '';

  // The single value used for anything that needs one Base URL rather than a
  // per-row one (the pre-flight connection check, the report's Test
  // Configuration table) - the first non-empty value the CSV itself supplies,
  // else whatever was passed in.
  let csvBaseUrl = '';
  if (hasBaseUrlColumn) {
    for (const row of dataRows) {
      const value = (row[cols.baseUrl] ?? '').trim();
      if (value) {
        csvBaseUrl = value;
        break;
      }
    }
  }
  const effectiveBaseUrl = csvBaseUrl || externalBaseUrl;

  if (!effectiveBaseUrl) {
    return {
      ok: false,
      message:
        'This CSV lists relative endpoints, so a Base URL is required to build ' +
        'the requests. Please enter the Base URL.',
    };
  }

  const out = [CANONICAL_COLUMNS];
  const names = [];
  const skipped = [];

  dataRows.forEach((row, index) => {
    const endpoint = (row[cols.endpoint] ?? '').trim();
    const apiName = cols.apiName >= 0 ? (row[cols.apiName] ?? '').trim() : '';
    // A METHOD column is honoured when present, otherwise every row uses the
    // default (GET) - these ?representation=...$query endpoints are reads.
    const method =
      cols.method >= 0 && (row[cols.method] ?? '').trim()
        ? (row[cols.method] ?? '').trim().toUpperCase()
        : defaultMethod;
    // This row's own BASE_URL value wins when the column exists and is
    // populated, so a CSV that varies its Base URL row-by-row is still honoured
    // exactly as written; an empty cell falls back to the file-wide value.
    const rowBaseUrl = hasBaseUrlColumn
      ? (row[cols.baseUrl] ?? '').trim() || effectiveBaseUrl
      : effectiveBaseUrl;

    if (!endpoint) {
      skipped.push(apiName || `row ${index + 2}`);
      return;
    }

    const fullUrl = joinBaseAndEndpoint(rowBaseUrl, endpoint);
    let parsed;
    try {
      parsed = new URL(fullUrl);
    } catch {
      skipped.push(apiName || endpoint);
      return;
    }

    const record = new Array(CANONICAL_COLUMNS.length).fill('');
    record[0] = method; // Method
    record[1] = fullUrl; // URL
    record[2] = parsed.protocol.replace(':', ''); // Protocol
    record[3] = parsed.hostname; // Host
    record[4] = parsed.port; // Port
    record[5] = `${parsed.pathname}${parsed.search}`; // Path - also the sample label
    record[9] = 'application/json'; // Accept
    // A literal value from the CSV's own AUTHORIZATION column, used as-is; a
    // CSV without one relies on the Basic Auth default run_jmeter_test.bat
    // applies for this schema (see scripts/ApplyAuthHeader.groovy).
    if (cols.authorization >= 0) {
      record[10] = (row[cols.authorization] ?? '').trim();
    }

    out.push(record);
    names.push(apiName || record[5]);
  });

  if (!names.length) {
    return {
      ok: false,
      message:
        'No usable API rows were found in the CSV - every row was missing an ' +
        'endpoint or had one that could not be turned into a URL.',
    };
  }

  return {
    ok: true,
    schema: 'endpoint',
    csv: serialiseCsv(out),
    apiCount: names.length,
    apiNames: names,
    skipped,
    baseUrl: effectiveBaseUrl,
    baseUrlSource: hasBaseUrlColumn && csvBaseUrl ? 'csv' : 'input',
  };
}
