/**
 * Role-based user codes for a workbook API source.
 *
 * A workbook (.xlsx) has one sheet of API definitions - "APIs" - plus one sheet
 * per user role (Merchandisers, Managers, DSM, ...), each holding that role's
 * user codes down its first column. Nothing here names a role or a code:
 *
 *  - Every sheet other than APIs is a role sheet, found by its own name. A new
 *    sheet is a new role; a new row on a sheet is a new code. No code change.
 *  - An APIs row says which role sheet it uses in its USER_ROLE column, and
 *    marks where the code goes with the {USER_CODE} token in its ENDPOINT.
 *    One definition per API - it is never duplicated per role or per code.
 *  - When the file is loaded, the APIs are written out in the plain
 *    API_ID / API_NAME / ENDPOINT / BASE_URL layout the rest of the app
 *    already understands (lib/csvSchema.js) - still ONE row per API, so
 *    Total APIs is the number of API definitions. {USER_CODE} becomes
 *    {USER_CODE:<role>}, and the role sheets' codes are returned separately
 *    (codesCsv: ROLE,CODE). At run time scripts\PrepareRequest.groovy gives
 *    each JMeter thread its own code of the role (thread 1 = code 1, wrapping
 *    round when there are more threads than codes).
 *  - A row with no {USER_CODE} token, or no USER_ROLE, is passed through as it
 *    is (e.g. an Admin API whose codes have no sheet).
 */
import crypto from 'node:crypto';

import { normaliseHeader, parseCsv, serialiseCsv } from './csvSchema.js';
import { readWorkbook } from './xlsx.js';

export const USER_CODE_TOKEN = '{USER_CODE}';
export const APIS_SHEET = 'APIs';

/**
 * A role sheet's name as it travels inside an endpoint and the codes file:
 * lower-case letters, digits and underscores only, so it survives URL parsing
 * unchanged ("Sales Coordinator" -> "sales_coordinator").
 */
export const roleSlug = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * An optional ceiling on codes used per role, from USER_CODES_MAX_PER_ROLE in
 * .env. Unset (or 0) = every code in the sheet. Provided because running every
 * API once per code of a large role is a very large test.
 */
function maxCodesPerRole() {
  const n = Number(process.env.USER_CODES_MAX_PER_ROLE);
  return Number.isInteger(n) && n > 0 ? n : Infinity;
}

/** The codes of one role sheet: its first column, below the header, as written. */
function readRoleCodes(sheet) {
  const header = (sheet.rows[0] ?? []).findIndex((h) => same(h ?? '', sheet.name));
  const column = header >= 0 ? header : 0;

  const numeric = new Set(sheet.numericCells);
  const letter = (i) => String.fromCharCode(65 + i);
  const stored = [];
  for (let r = 1; r < sheet.rows.length; r += 1) {
    const raw = sheet.rows[r]?.[column];
    if (raw === undefined || String(raw).trim() === '') continue;
    if (numeric.has(`${letter(column)}${r + 1}`)) stored.push(`${letter(column)}${r + 1}`);
  }
  if (stored.length) {
    return {
      ok: false,
      message:
        `Sheet "${sheet.name}": ${stored.length} user code(s) are stored as numbers (first: ` +
        `${stored[0]}), so leading zeros may have been lost. Format the column as Text and ` +
        `re-enter them.`,
    };
  }

  // Executed once each: the first occurrence wins and the order is the
  // sheet's. (The sheet itself is never rewritten - a repeated code stays.)
  const seen = new Set();
  const codes = [];
  for (let r = 1; r < sheet.rows.length; r += 1) {
    const code = String(sheet.rows[r]?.[column] ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return { ok: true, codes };
}

/**
 * Route App REST picks its drivers at random: every run, the ROLE,CODE list is
 * shuffled (per role) before it is handed to scripts\PrepareRequest.groovy, so
 * thread 1 takes the first code of the shuffled list, thread 2 the second, ...
 * - i.e. a fresh random set of distinct drivers, one per thread, each run. The
 * workbook itself is never changed. (Merchandiser REST keeps the sheet order.)
 */
export const usesRandomUserCodes = (applicationName, apiType) =>
  applicationName === 'Route App' && apiType === 'REST';

export function shuffleUserCodesCsv(codesCsv) {
  if (!codesCsv) return codesCsv;
  const rows = parseCsv(codesCsv);
  const byRole = new Map();
  for (const [role, code] of rows.slice(1)) {
    if (!role || !code) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(code);
  }
  const out = [['ROLE', 'CODE']];
  for (const [role, codes] of byRole) {
    for (let i = codes.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(i + 1); // Fisher-Yates with a CSPRNG
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
    for (const code of codes) out.push([role, code]);
  }
  return serialiseCsv(out);
}

/**
 * Turns a workbook into the API CSV text the rest of the app reads.
 * Returns { ok, csv, summary } - summary: [{ role, sheet, codes, apis, requests }] -
 * or { ok: false, message }.
 */
export function workbookToApiCsv(buffer, { fileName = 'workbook' } = {}) {
  let sheets;
  try {
    sheets = readWorkbook(buffer);
  } catch (err) {
    return { ok: false, message: `${fileName}: ${err.message}` };
  }

  const apis = sheets.find((s) => same(s.name, APIS_SHEET)) ?? null;
  if (!apis) {
    return { ok: false, message: `${fileName}: there is no "${APIS_SHEET}" sheet.` };
  }

  const roleSheets = new Map();
  for (const sheet of sheets) {
    if (sheet === apis) continue;
    const read = readRoleCodes(sheet);
    if (!read.ok) return { ok: false, message: `${fileName}: ${read.message}` };
    roleSheets.set(sheet.name.trim().toLowerCase(), { sheet: sheet.name, codes: read.codes });
  }

  const rows = apis.rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (rows.length < 2) {
    return { ok: false, message: `${fileName}: the ${APIS_SHEET} sheet has no API rows.` };
  }
  const header = rows[0].map((h) => String(h ?? ''));
  const norm = header.map(normaliseHeader);
  const endpointCol = norm.indexOf('endpoint');
  const roleCol = norm.indexOf('userrole');
  if (endpointCol < 0) {
    return { ok: false, message: `${fileName}: the ${APIS_SHEET} sheet needs an ENDPOINT column.` };
  }

  // USER_ROLE is a workbook-only column; downstream never sees it.
  const keep = header.map((_, i) => i).filter((i) => i !== roleCol);
  const cap = maxCodesPerRole();
  const out = [keep.map((i) => header[i])];
  const usage = new Map(); // sheet name -> { codes, apis, requests }
  const roleCodes = new Map(); // role slug -> codes, in sheet order
  const slugOwner = new Map(); // role slug -> sheet name

  for (let r = 1; r < rows.length; r += 1) {
    const row = header.map((_, i) => String(rows[r][i] ?? ''));
    const endpoint = row[endpointCol];
    const role = roleCol >= 0 ? row[roleCol].trim() : '';
    const label = () => row[norm.indexOf('apiname')] || row[norm.indexOf('apiid')] || `row ${r + 1}`;

    if (!endpoint.includes(USER_CODE_TOKEN)) {
      out.push(keep.map((i) => row[i]));
      continue;
    }
    if (!role) {
      return {
        ok: false,
        message: `${fileName}: API "${label()}" uses ${USER_CODE_TOKEN} but its USER_ROLE is empty.`,
      };
    }
    const found = roleSheets.get(role.toLowerCase());
    if (!found) {
      return {
        ok: false,
        message: `${fileName}: API "${label()}" has USER_ROLE "${role}", but the workbook has no sheet with that name.`,
      };
    }
    const codes = found.codes.slice(0, cap);
    if (!codes.length) {
      return {
        ok: false,
        message: `${fileName}: the "${found.sheet}" sheet has no user codes, needed by API "${label()}".`,
      };
    }

    // The API stays ONE row. The token is rewritten to name its role, and
    // scripts\PrepareRequest.groovy fills in the code at run time: each JMeter
    // thread uses its own code of that role (thread 1 = code 1, ...), so the
    // API count stays at the number of API definitions.
    const slug = roleSlug(found.sheet);
    const taken = slugOwner.get(slug);
    if (taken && taken !== found.sheet) {
      return {
        ok: false,
        message: `${fileName}: the sheets "${taken}" and "${found.sheet}" are too alike to tell apart (both "${slug}").`,
      };
    }
    slugOwner.set(slug, found.sheet);
    roleCodes.set(slug, codes);

    const tagged = row.slice();
    tagged[endpointCol] = endpoint.split(USER_CODE_TOKEN).join(`{USER_CODE:${slug}}`);
    out.push(keep.map((i) => tagged[i]));

    const u = usage.get(found.sheet) ?? { codes: codes.length, apis: 0, requests: 0 };
    u.apis += 1;
    u.requests += 1;
    usage.set(found.sheet, u);
  }

  // One row per code, for the roles the APIs actually use: ROLE,CODE.
  const codeRows = [['ROLE', 'CODE']];
  for (const [slug, codes] of roleCodes) for (const code of codes) codeRows.push([slug, code]);

  return {
    ok: true,
    csv: serialiseCsv(out),
    codesCsv: roleCodes.size ? serialiseCsv(codeRows) : '',
    summary: [...usage].map(([sheet, u]) => ({ sheet, ...u })),
  };
}
