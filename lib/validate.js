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
  if (value === 'REST' || value === 'SOAP' || value === 'SQL') {
    return { ok: true, value };
  }
  return {
    ok: false,
    message: 'Please select an API Type (REST APIs, SOAP APIs, or Query Testing).',
  };
}

// Host and database name are placed inside the JDBC URL
// (jdbc:sqlserver://HOST:PORT;databaseName=NAME;...), so anything that could
// end a URL segment or add a connection property (";", "=", quotes, spaces,
// control characters) is rejected. A named instance (HOST\INSTANCE) is fine.
const DB_HOST_PATTERN = /^[A-Za-z0-9._\-\\]+$/;
const DB_NAME_FORBIDDEN = /[;={}"'\x00-\x1f]/;

/**
 * Query Testing's Database Configuration. Every field falls back to the
 * matching DB_* value in .env when left empty, so the form can be submitted
 * as-is once .env holds the connection. The password is never echoed back in
 * any message.
 */
export function validateDbConfig(raw, defaults) {
  const pick = (name) => {
    const value = typeof raw[name] === 'string' ? raw[name].trim() : '';
    return value || (defaults[name] ?? '').trim();
  };
  const host = pick('host');
  const port = pick('port') || '1433';
  const name = pick('name');
  const user = pick('user');
  // Not trimmed: a password may legitimately start or end with a space.
  const password = (typeof raw.password === 'string' && raw.password) || defaults.password || '';

  if (!host) return { ok: false, message: 'Please enter the Database Host.' };
  if (host.length > 255 || !DB_HOST_PATTERN.test(host)) {
    return {
      ok: false,
      message:
        'The Database Host may contain only letters, digits, ".", "-", "_" and "\\" (for HOST\\INSTANCE).',
    };
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { ok: false, message: 'The Database Port must be a number between 1 and 65535.' };
  }
  if (!name) return { ok: false, message: 'Please enter the Database Name.' };
  if (name.length > 128 || DB_NAME_FORBIDDEN.test(name)) {
    return {
      ok: false,
      message: 'The Database Name must not contain ; = { } quotes or control characters.',
    };
  }
  if (!user) return { ok: false, message: 'Please enter the Database Username.' };
  if (user.length > 128 || /[\x00-\x1f]/.test(user)) {
    return { ok: false, message: 'The Database Username is not valid.' };
  }
  if (!password) {
    return {
      ok: false,
      message: 'Please enter the Database Password (or set DB_PASSWORD in .env).',
    };
  }
  if (/[\r\n\0]/.test(password)) {
    return { ok: false, message: 'The Database Password contains an invalid character.' };
  }
  return { ok: true, value: { host, port, name, user, password } };
}

/**
 * A login being saved under Configuration. The password may be empty when one
 * is already saved (the username can then be changed on its own).
 */
export function validateCredentialInput(rawUsername, rawPassword, { passwordRequired }) {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';

  if (!username) return { ok: false, message: 'Please enter the username.' };
  if (username.length > 200 || /[\x00-\x1f]/.test(username)) {
    return { ok: false, message: 'The username is not valid (at most 200 characters, no control characters).' };
  }
  if (!password && passwordRequired) return { ok: false, message: 'Please enter the password.' };
  // The password reaches JMeter in an environment variable, which cannot hold a line break.
  if (password.length > 500 || /[\r\n\0]/.test(password)) {
    return { ok: false, message: 'The password is not valid (at most 500 characters, no line breaks).' };
  }
  return { ok: true, value: { username, password } };
}

/**
 * A group's logins being saved under Configuration: an array of
 * { username, password }, user 1 first. User 1 is required; the others may be
 * left completely blank (a blank one is dropped, and so is anything after it).
 * `savedCount` is how many logins already have a saved password, so those can
 * be saved again with the password field left empty.
 */
export function validateCredentialUsers(rawUsers, { savedCount, max }) {
  if (!Array.isArray(rawUsers) || rawUsers.length === 0 || rawUsers.length > max) {
    return { ok: false, message: `Expected between 1 and ${max} users.` };
  }

  const users = [];
  let ended = false;
  for (const [i, raw] of rawUsers.entries()) {
    const blank = !(typeof raw?.username === 'string' && raw.username.trim()) && !raw?.password;
    if (blank && i > 0) {
      ended = true;
      continue;
    }
    if (ended) return { ok: false, message: `Fill in user ${i} before user ${i + 1}.` };

    const check = validateCredentialInput(raw?.username, raw?.password, { passwordRequired: i >= savedCount });
    if (!check.ok) return { ok: false, message: `User ${i + 1}: ${check.message}` };
    users.push(check.value);
  }
  return { ok: true, value: users };
}
