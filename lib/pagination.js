/**
 * Pagination for Merchandiser REST runs.
 *
 * Every Merchandiser REST run pages through each API, always the same way:
 *   - 1,000 records per page (sent to the API as count=1000), and
 *   - page after page until the API says there are no more records.
 * There is no page limit and no record limit; the only things that end a run of
 * pages are the API's own end-of-data signal, a failed page, or the API returning
 * the same page twice (which would otherwise loop forever).
 *
 * Sage X3 ($query) APIs answer one page at a time:
 *   { "$itemsPerPage": 1000, "$resources": [...], "$links": { "$next": { "$url": ... } } }
 * "$next" is present while there is more data and absent on the last page ("$last"
 * or no links at all). JMeter follows that link (see bat\scripts\Paginate.groovy):
 * one real HTTP sample per page, each with its own user's own pagination state.
 *
 * Per-API settings, optional columns of the API list (the workbook's APIs sheet):
 *   PAGINATION  No = this API is never paged (blank / Yes = paged)
 *   PAGE_TYPE   link (default, Sage "$links.$next") | page | offset
 *   PAGE_PARAM  query parameter carrying the page number / offset (page: "page", offset: "offset")
 *   SIZE_PARAM  query parameter carrying the page size (page: "pageSize", offset: "limit")
 * A list without these columns pages every API through its "$next" link.
 */
import { normaliseHeader, parseCsv, serialiseCsv } from './csvSchema.js';
import { supportsUserTypeThreads } from './userTypes.js';

/** The fixed pagination settings of every Merchandiser REST run. */
export const PAGINATION = Object.freeze({ mode: 'all', pageSize: 1000 });

/** Pagination is a Merchandiser REST feature only - every other app / API type is unchanged. */
export const supportsPagination = (applicationName, apiType) => supportsUserTypeThreads(applicationName, apiType);

export const PAGE_TYPES = ['link', 'page', 'offset'];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

const COLUMNS = ['pagination', 'pagetype', 'pageparam', 'sizeparam'];

/**
 * Per-API settings from the optional columns of the API list, written as the
 * run's pagination-config.csv (PATH + the settings; PATH is the sample label's
 * path, which is how JMeter knows the row). '' when the list has no such columns
 * or sets nothing. -> { ok, csv, apis } | { ok: false, message }
 *
 * @param csvText    the API list as loaded (API_NAME / ENDPOINT / ... + the columns above)
 * @param normalised the result of normaliseCsv for that list (csv + apiNames, same order)
 */
export function buildPaginationConfig(csvText, normalised) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: true, csv: '', apis: 0 };
  const header = rows[0].map(normaliseHeader);
  const nameCol = header.indexOf('apiname');
  if (nameCol < 0 || !COLUMNS.some((c) => header.includes(c))) return { ok: true, csv: '', apis: 0 };

  const byName = new Map();
  for (const row of rows.slice(1)) {
    const name = String(row[nameCol] ?? '').trim();
    if (name && !byName.has(name)) byName.set(name, row);
  }

  const out = [['PATH', 'PAGINATION', 'PAGE_TYPE', 'PAGE_PARAM', 'SIZE_PARAM']];
  const normRows = parseCsv(normalised.csv).slice(1);
  for (let i = 0; i < normRows.length; i += 1) {
    const name = normalised.apiNames[i];
    const source = byName.get(name);
    if (!source) continue;
    const cell = (key) => String(source[header.indexOf(key)] ?? '').trim();

    let enabled = '';
    if (!isBlank(cell('pagination'))) {
      const v = cell('pagination').toLowerCase();
      if (['yes', 'y', 'true', '1'].includes(v)) enabled = 'yes';
      else if (['no', 'n', 'false', '0'].includes(v)) enabled = 'no';
      else return { ok: false, message: `API "${name}": PAGINATION must be Yes or No (found "${cell('pagination')}").` };
    }
    const type = cell('pagetype').toLowerCase();
    if (type && !PAGE_TYPES.includes(type)) {
      return { ok: false, message: `API "${name}": PAGE_TYPE must be link, page or offset (found "${cell('pagetype')}").` };
    }
    const pageParam = cell('pageparam');
    const sizeParam = cell('sizeparam');
    for (const [label, value] of [['PAGE_PARAM', pageParam], ['SIZE_PARAM', sizeParam]]) {
      if (value && !/^[A-Za-z0-9_.$-]+$/.test(value)) {
        return { ok: false, message: `API "${name}": ${label} "${value}" is not a valid query parameter name.` };
      }
    }
    if (!enabled && !type && !pageParam && !sizeParam) continue;
    out.push([normRows[i][5], enabled, type, pageParam, sizeParam]);
  }
  return out.length > 1 ? { ok: true, csv: serialiseCsv(out), apis: out.length - 1 } : { ok: true, csv: '', apis: 0 };
}
