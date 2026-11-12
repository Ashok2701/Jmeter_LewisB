/**
 * User types for the Merchandiser App REST test, and the optional split of a
 * run's Total Threads between them.
 *
 * Each user type owns the APIs whose API_NAME starts "<prefix> - " (the same
 * convention the report's per-API grouping uses). Plain data and pure
 * functions only - this file is imported by both the browser form and the
 * server, so it must not touch node modules.
 */
export const USER_TYPES = [
  { key: 'merchandiser', label: 'Merchandisers', reportLabel: 'Merchandiser', prefix: 'Merchandiser' },
  { key: 'manager', label: 'Managers', reportLabel: 'Manager', prefix: 'Sales Manager' },
  { key: 'dsm', label: 'DSMs', reportLabel: 'DSM', prefix: 'DSM' },
  { key: 'salco', label: 'Sales Coordinators', reportLabel: 'Sales Coordinator', prefix: 'SALCO' },
  { key: 'vp', label: 'VPs', reportLabel: 'VP', prefix: 'VP' },
  { key: 'admin', label: 'Admins', reportLabel: 'Admin', prefix: 'Admin' },
];

/** Only the Merchandiser App's REST test can be split by user type. */
export function supportsUserTypeThreads(applicationName, apiType) {
  return applicationName === 'Merchandiser App' && apiType === 'REST';
}

const normalise = (s) => String(s ?? '').trim().toLowerCase();

/** The user type an API_NAME belongs to ("DSM - Orders" -> dsm), or null. */
export function userTypeOfApiName(apiName) {
  const name = normalise(apiName);
  for (const type of USER_TYPES) {
    if (name.startsWith(`${normalise(type.prefix)} - `)) return type.key;
  }
  return null;
}

/**
 * Checks the per-type thread boxes against the run's Total Threads.
 *
 * `raw` is { merchandiser: '10', manager: '5', ... }; every box is optional.
 * Returns { ok: true, value: null } when no box is filled (the run is not
 * split), { ok: true, value: { merchandiser: 10, manager: 5 } } (types with
 * threads only, in USER_TYPES order) when they add up to `total`, or
 * { ok: false, message }.
 */
export function validateTypeThreads(raw, total) {
  const given = [];
  for (const type of USER_TYPES) {
    const text = raw && raw[type.key] != null ? String(raw[type.key]).trim() : '';
    if (text === '') continue;
    if (!/^(0|[1-9][0-9]{0,6})$/.test(text)) {
      return { ok: false, message: `${type.label} threads must be a whole number (0 or more).` };
    }
    given.push([type, Number(text)]);
  }
  if (given.length === 0) return { ok: true, value: null };

  const sum = given.reduce((n, [, count]) => n + count, 0);
  if (sum !== Number(total)) {
    return {
      ok: false,
      message: `The user-type threads add up to ${sum}, but Total Threads is ${Number(total)}. They must be equal.`,
    };
  }
  const value = {};
  for (const [type, count] of given) if (count > 0) value[type.key] = count;
  return { ok: true, value };
}
