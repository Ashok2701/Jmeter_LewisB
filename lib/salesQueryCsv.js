/**
 * Converts the Sales Query APIs CSV (Sales_Query_APIs_JMeter.csv) into rows of
 * the canonical 20-column layout JMeter_API_Automation.jmx reads, so those APIs
 * run through the existing REST test plan with no change to the plan itself.
 *
 * The CSV is deliberately small:
 *
 *   Base_URL, API_Name, HTTP_Method, Endpoint, Parameter
 *
 * `Parameter` holds only the VALUES, comma separated, in the same order as the
 * API's parameter names (the order they have in the API definition, listed in
 * QUERY_API_PARAMS below), e.g. `product_tom` -> `02113240, 4600892, 102` means
 * customer=02113240, product=4600892, site=102.
 *
 *   GET  -> the values become the query string.
 *   POST -> the values become the JSON body.
 *
 * A row that cannot be turned into a real request (value count does not match,
 * a value left as its parameter name / empty) is NOT guessed at: it is emitted
 * with no Method/URL, which the test plan routes to its skip branch, so it
 * shows as SKIPPED in the report and the reason is listed in `skipped`.
 */
import { CANONICAL_COLUMNS, normaliseHeader, parseCsv } from './csvSchema.js';

// `isoDates` lists the parameters the live API validates as YYYY-MM-DD
// ("Order_Date must be a date like 2026-08-07", HTTP 400 otherwise). The CSV may
// hold the date as MM/DD/YYYY (as the other, working date APIs accept); it is
// converted to ISO here, per parameter, so those rows send what the API expects.
//
// Parameter names, in order, exactly as the API definition (and the live
// /api/queries listing) spells them. Names are case sensitive.
export const QUERY_API_PARAMS = {
  '/api/query/login': { method: 'POST', names: ['Userid', 'Password'] },
  '/api/query/login_sso': { method: 'GET', names: ['Email'] },
  '/api/query/logout': { method: 'POST', names: ['Sales_manager'] },
  '/api/query/sales_admin_write': { method: 'GET', names: ['Login_Id'] },
  '/api/query/sales_admin_read': { method: 'GET', names: ['Login_Id'] },
  '/api/query/user_image': { method: 'GET', names: ['User_Code'] },
  '/api/query/district_sales_manager': { method: 'GET', names: ['Login_Id'] },
  '/api/query/sales_supervisor': { method: 'GET', names: ['Login_Id'] },
  '/api/query/sales_manager_vp': { method: 'GET', names: ['Login_Id'] },
  '/api/query/sales_coordinator': { method: 'GET', names: ['Login_Id'] },
  '/api/query/sales_manager_detail': { method: 'GET', names: ['Login_Id'] },
  '/api/query/week_list': { method: 'GET', names: ['Date'] },
  '/api/query/customer_list_route': { method: 'GET', names: ['Route_Code'] },
  '/api/query/lock_order': { method: 'GET', names: ['Date_Time', 'Site'] },
  '/api/query/holiday_list': { method: 'GET', names: ['site_id'] },
  '/api/query/product_list': { method: 'GET', names: ['Login_Id'] },
  '/api/query/product_tom': { method: 'GET', names: ['customer', 'product', 'site'] },
  '/api/query/product_sold': { method: 'GET', names: ['customer', 'site', 'product'] },
  '/api/query/total_tom': { method: 'GET', names: ['product', 'customer', 'site'] },
  '/api/query/retail_price': { method: 'GET', names: ['Customer', 'Product'] },
  '/api/query/wholesale_price': { method: 'GET', names: ['Customer', 'Product'] },
  '/api/query/stale': { method: 'GET', names: ['product_Id', 'customer_Id'] },
  '/api/query/tray_order_unit': { method: 'GET', names: ['customer', 'product'] },
  '/api/query/facing': { method: 'GET', names: ['Customer', 'Product'] },
  '/api/query/lao_holiday': { method: 'GET', names: ['customer', 'product'] },
  '/api/query/gamble_value': { method: 'GET', names: ['customerId', 'productId'] },
  '/api/query/current_order': { method: 'GET', names: ['customerId', 'productId'] },
  '/api/query/customer_availability': {
    method: 'GET',
    names: ['date', 'site', 'customerId', 'productId'],
  },
  '/api/query/update_lock_order': {
    method: 'POST',
    names: ['customerId', 'productId', 'date_time', 'lock_flag'],
    integers: ['lock_flag'],
    isoDates: ['date_time'],
  },
  '/api/query/current_order_by_date': { method: 'GET', names: ['Customer', 'Product', 'Order_Date'], isoDates: ['Order_Date'] },
  '/api/query/previous_week_sold': { method: 'GET', names: ['Customer', 'Product', 'Order_Date'], isoDates: ['Order_Date'] },
  '/api/query/on_hand': { method: 'GET', names: ['Product', 'Customer', 'Order_Date'], isoDates: ['Order_Date'] },
  '/api/query/average_sold': { method: 'GET', names: ['orderDate', 'customerId', 'productId'], isoDates: ['orderDate'] },
  '/api/query/previous_adjustment': { method: 'GET', names: ['Product', 'Customer', 'Order_Date'], isoDates: ['Order_Date'] },
  '/api/query/tablet_adjustment': { method: 'GET', names: ['orderDate', 'customerId', 'productId'] },
  '/api/query/facing_value': { method: 'GET', names: ['Customer', 'Product'] },
  '/api/query/onhand_daywise': { method: 'GET', names: ['Customer', 'Product', 'Order_Date'], isoDates: ['Order_Date'] },
  '/api/query/suggested_order': { method: 'GET', names: ['customerId', 'productId', 'order_date'], isoDates: ['order_date'] },
  '/api/query/shipping_adjustment': {
    method: 'GET',
    names: ['Date', 'SiteId', 'customerId', 'productId'],
    isoDates: ['Date'],
  },
  '/api/queries': { method: 'GET', names: [] },
  '/health': { method: 'GET', names: [] },
};

/** True when the CSV text has the Sales Query layout (API_Name/Endpoint/Parameter). */
export function isSalesQueryCsv(text) {
  const header = (parseCsv(text)[0] ?? []).map(normaliseHeader);
  return header.includes('endpoint') && header.includes('parameter') && header.includes('apiname');
}

function withScheme(base) {
  const b = String(base).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(b) ? b : `https://${b}`;
}

/** MM/DD/YYYY (or already YYYY-MM-DD) -> YYYY-MM-DD, or null if not a real date. */
function toIsoDate(raw) {
  const v = String(raw).trim();
  let y;
  let m;
  let d;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (hit) {
    [, y, m, d] = hit;
  } else if ((hit = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) {
    [, m, d, y] = hit;
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toIntegerValue(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return 1;
  if (v === 'false') return 0;
  return /^-?\d+$/.test(v) ? Number(v) : null;
}

/**
 * Returns { ok, rows, names, skipped } - `rows` are canonical 20-column
 * records (no header), `names` one label per row, `skipped` the rows that were
 * emitted as SKIPPED with the reason.
 */
export function convertSalesQueryCsv(text) {
  const parsed = parseCsv(text);
  const header = (parsed[0] ?? []).map(normaliseHeader);
  const col = {
    base: header.indexOf('baseurl'),
    name: header.indexOf('apiname'),
    method: header.indexOf('httpmethod') >= 0 ? header.indexOf('httpmethod') : header.indexOf('method'),
    endpoint: header.indexOf('endpoint'),
    parameter: header.indexOf('parameter'),
  };
  if (col.endpoint < 0 || col.parameter < 0 || col.name < 0) {
    return { ok: false, message: 'The Sales Query CSV needs API_Name, Endpoint and Parameter columns.' };
  }
  if (col.base < 0) {
    return {
      ok: false,
      message: 'The Sales Query CSV needs a Base_URL column (e.g. pwa.lewisbakeries.com:8084).',
    };
  }

  const rows = [];
  const names = [];
  const skipped = [];

  parsed.slice(1).forEach((cells, i) => {
    const apiName = (cells[col.name] ?? '').trim();
    const endpoint = (cells[col.endpoint] ?? '').trim();
    const base = (cells[col.base] ?? '').trim();
    const def = QUERY_API_PARAMS[endpoint];
    const method = (
      (col.method >= 0 ? (cells[col.method] ?? '').trim() : '') ||
      def?.method ||
      'GET'
    ).toUpperCase();
    const label = apiName || endpoint || `row ${i + 2}`;

    const skip = (reason) => {
      const rec = new Array(CANONICAL_COLUMNS.length).fill('');
      rec[5] = endpoint; // shown as the sample label; Method/URL stay empty -> skip branch
      rows.push(rec);
      names.push(label);
      skipped.push(`${label}: ${reason}`);
    };

    if (!endpoint) return skip('no Endpoint');
    if (!base) return skip('no Base_URL');
    if (!def) return skip(`unknown endpoint "${endpoint}" (not in the API definition)`);

    const raw = (cells[col.parameter] ?? '').trim();
    const values = raw === '' ? [] : raw.split(',').map((v) => v.trim());
    if (values.length !== def.names.length) {
      return skip(
        `expected ${def.names.length} value(s) for ${def.names.join(', ') || 'no parameters'}, found ${values.length}`
      );
    }
    const bad = values.findIndex(
      (v, k) => v === '' || v.toLowerCase() === def.names[k].toLowerCase() || /^<.*>$/.test(v)
    );
    if (bad >= 0) {
      return skip(`value for ${def.names[bad]} is still empty / a placeholder ("${values[bad]}")`);
    }

    for (let k = 0; k < def.names.length; k += 1) {
      if (def.isoDates?.includes(def.names[k])) {
        const iso = toIsoDate(values[k]);
        if (iso === null) return skip(`${def.names[k]} must be a date (MM/DD/YYYY or YYYY-MM-DD); got "${values[k]}"`);
        values[k] = iso;
      }
    }

    let url = `${withScheme(base)}${endpoint}`;
    let body = '';
    if (method === 'POST') {
      const obj = {};
      for (let k = 0; k < def.names.length; k += 1) {
        if (def.integers?.includes(def.names[k])) {
          const n = toIntegerValue(values[k]);
          if (n === null) return skip(`${def.names[k]} must be an integer (or true/false); got "${values[k]}"`);
          obj[def.names[k]] = n;
        } else {
          obj[def.names[k]] = values[k];
        }
      }
      body = JSON.stringify(obj);
    } else if (def.names.length) {
      url += '?' + def.names.map((n, k) => `${n}=${encodeURIComponent(values[k])}`).join('&');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return skip(`could not form a valid URL from Base_URL "${base}"`);
    }

    const rec = new Array(CANONICAL_COLUMNS.length).fill('');
    rec[0] = method;
    rec[1] = url;
    rec[2] = parsedUrl.protocol.replace(':', '');
    rec[3] = parsedUrl.hostname;
    rec[4] = parsedUrl.port;
    rec[5] = `${parsedUrl.pathname}${parsedUrl.search}`;
    rec[8] = 'application/json'; // Content_Type
    rec[9] = 'application/json'; // Accept
    rec[13] = body; // Request_Body
    rec[18] = '200';
    rec[19] = 'application/json';
    rows.push(rec);
    names.push(label);
  });

  if (!rows.length) {
    return { ok: false, message: 'The Sales Query CSV has no API rows.' };
  }
  return { ok: true, rows, names, skipped };
}
