import { LIMITS, MAX_CSV_BYTES } from './config.js';

// Mirrors the .bat's own check: findstr /r "^[1-9][0-9]*$"
const WHOLE_NUMBER = /^[1-9][0-9]*$/;

const FIELD_MESSAGES = {
  threads: 'Please enter a valid number of threads.',
  rampup: 'Please enter a valid ramp-up time.',
  loops: 'Please enter a valid number of loops.',
};

/**
 * Validates one of the three numeric parameters. Returns the value as a
 * digits-only string so nothing but digits is ever handed to the .bat.
 */
export function validateNumber(field, raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!WHOLE_NUMBER.test(value)) {
    return { ok: false, message: FIELD_MESSAGES[field] };
  }
  if (Number(value) > LIMITS[field]) {
    return {
      ok: false,
      message: `${FIELD_MESSAGES[field]} Maximum allowed is ${LIMITS[field]}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Validates the uploaded CSV. The uploaded filename is never used as a path -
 * the file is always written to APIs.csv - so this only guards content shape.
 */
export function validateCsv(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) {
    return { ok: false, message: 'Please upload the CSV file.' };
  }
  const name = typeof file.name === 'string' ? file.name : '';
  if (!/\.csv$/i.test(name)) {
    return { ok: false, message: 'The uploaded file must be a .csv file.' };
  }
  if (file.size > MAX_CSV_BYTES) {
    return {
      ok: false,
      message: `The CSV file is too large (max ${Math.round(MAX_CSV_BYTES / 1024 / 1024)} MB).`,
    };
  }
  return { ok: true };
}

/** Free-text fields shown in the report - length-capped, no other constraint. */
export function validateText(field, raw, { required = true, max = 120, label }) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (!required) return { ok: true, value: '' };
    return { ok: false, message: `Please enter the ${label}.` };
  }
  if (value.length > max) {
    return { ok: false, message: `The ${label} must be ${max} characters or fewer.` };
  }
  return { ok: true, value };
}

/**
 * The Base URL the relative endpoints in an API-list CSV are resolved against.
 * Restricted to http/https with a host and no query or fragment - it is joined
 * onto CSV values, so anything stranger belongs in the CSV itself.
 */
export function validateBaseUrl(raw, { required }) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (!required) return { ok: true, value: '' };
    return { ok: false, message: 'Please enter a valid Base URL.' };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      message: 'Please enter a valid Base URL, for example https://host:8087/api',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'The Base URL must start with http:// or https://' };
  }
  if (!parsed.hostname) {
    return { ok: false, message: 'The Base URL must include a host name.' };
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      message: 'The Base URL must not contain a query string or fragment.',
    };
  }
  return { ok: true, value: value.replace(/\/+$/, '') };
}

/**
 * The API Type dropdown's value - decides which CSV schema, which test plan
 * (.jmx) and which .bat this request uses. Anything else is rejected outright
 * rather than silently defaulting, since guessing here would mean running the
 * wrong pipeline against the wrong CSV shape.
 */
export function validateApiKind(raw) {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value === 'REST' || value === 'SOAP') {
    return { ok: true, value };
  }
  return { ok: false, message: 'Please select an API Type (REST APIs or SOAP APIs).' };
}

export function validateCredentials(username, password) {
  if (!username || !String(username).trim()) {
    return { ok: false, message: 'Please enter the login username.' };
  }
  if (!password || !String(password)) {
    return { ok: false, message: 'Please enter the login password.' };
  }
  return { ok: true };
}
