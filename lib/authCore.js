import crypto from 'node:crypto';

import { DbConfigError, query } from './db.js';

// Backend-only. Users live ONLY in the existing PostgreSQL table jmeter_user
// (id, username, password). Nothing else is stored in the database:
//  - sessions are signed, expiring cookies (HMAC with AUTH_SECRET), re-checked
//    against jmeter_user on every request, so deleting a user ends their session;
//  - login throttling is kept in server memory.
// No Next.js imports, so the create-user CLI can use it too.

export const SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS) > 0
  ? Number(process.env.AUTH_SESSION_HOURS)
  : 8;
export const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;

export const USERNAME_RULE = /^[A-Za-z0-9._@-]{3,64}$/;
export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 72;

const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 30;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- table

/** "schema.table" from DB_USER_TABLE (default public.jmeter_user), validated and quoted. */
function userTable() {
  const raw = (process.env.DB_USER_TABLE ?? '').trim() || 'public.jmeter_user';
  const parts = raw.split('.');
  if (parts.length > 2 || !parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) {
    throw new DbConfigError('DB_USER_TABLE must look like schema.table (letters, digits, _).');
  }
  return parts.map((p) => `"${p}"`).join('.');
}

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- users

export function validateNewCredentials(username, password) {
  if (!username || !username.trim()) return 'Username must not be empty.';
  if (!USERNAME_RULE.test(username.trim())) {
    return 'Username must be 3-64 characters: letters, numbers and . _ @ - only.';
  }
  if (!password) return 'Password must not be empty.';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (Buffer.byteLength(password) > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} bytes.`;
  }
  return null;
}

export async function findUserByUsername(username) {
  const { rows } = await query(
    `SELECT id, username, password FROM ${userTable()} WHERE lower(username) = lower($1) ORDER BY id LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

/** Returns { ok: true, id } or { ok: false, error }. Never overwrites an existing user. */
export async function createUser(username, password) {
  const invalid = validateNewCredentials(username, password);
  if (invalid) return { ok: false, error: invalid };
  const name = username.trim();
  if (await findUserByUsername(name)) {
    return { ok: false, error: `The username "${name}" already exists. Nothing was changed.` };
  }
  const { rows } = await query(
    `INSERT INTO ${userTable()} (username, password) VALUES ($1, $2) RETURNING id`,
    [name, password]
  );
  return { ok: true, id: Number(rows[0].id) };
}

export async function listUsers() {
  const { rows } = await query(`SELECT id, username FROM ${userTable()} ORDER BY id`);
  return rows;
}

/** True if a user was deleted. */
export async function deleteUser(username) {
  const { rowCount } = await query(`DELETE FROM ${userTable()} WHERE lower(username) = lower($1)`, [username]);
  return rowCount > 0;
}

/** The user when the credentials are valid, else null. */
export async function verifyCredentials(username, password) {
  const user = await findUserByUsername(username);
  // Always compare (against a dummy when the user is unknown) so timing does not reveal usernames.
  const ok = safeEqual(password, user ? user.password : crypto.randomBytes(16).toString('hex'));
  if (!user || !ok) return null;
  return { id: Number(user.id), username: user.username };
}

// ------------------------------------------------------------- sessions

function secret() {
  const value = (process.env.AUTH_SECRET ?? '').trim();
  if (value.length < 32) {
    throw new DbConfigError('AUTH_SECRET must be set to a random string of at least 32 characters.');
  }
  return value;
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

/** A signed, expiring session token for a user ({ id, username }). */
export function createSession(user) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, u: user.username, exp: expiresAt, n: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

/** The signed-in user for a cookie token, or null if missing/forged/expired/deleted. */
export async function getSessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 400) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, sign(payload))) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !Number.isInteger(data.id) || typeof data.exp !== 'number' || data.exp <= Date.now()) return null;

  // The user must still exist (and keep the same name).
  const { rows } = await query(`SELECT id, username FROM ${userTable()} WHERE id = $1`, [data.id]);
  const row = rows[0];
  return row && row.username === data.u ? { id: Number(row.id), username: row.username } : null;
}

// ----------------------------------------------------- login throttling
// In server memory: resets on restart, which is acceptable for brute-force damping.

const userKey = (username) => `u:${username.toLowerCase()}`;
const ipKey = (ip) => `ip:${ip}`;

function attempts() {
  return (globalThis[Symbol.for('lewisbakers.loginAttempts')] ||= new Map());
}

function recent(key, now) {
  const list = (attempts().get(key) || []).filter((t) => t > now - FAIL_WINDOW_MS);
  if (list.length) attempts().set(key, list);
  else attempts().delete(key);
  return list;
}

/** { limited: false } or { limited: true, retryAfterSeconds } */
export function checkLoginThrottle(username, ip) {
  const now = Date.now();
  let wait = 0;
  for (const [key, max] of [[userKey(username), MAX_FAILS_PER_USER], [ipKey(ip), MAX_FAILS_PER_IP]]) {
    const list = recent(key, now);
    if (list.length >= max) wait = Math.max(wait, list[0] + FAIL_WINDOW_MS - now);
  }
  return wait > 0 ? { limited: true, retryAfterSeconds: Math.ceil(wait / 1000) } : { limited: false };
}

export function recordLoginFailure(username, ip) {
  const now = Date.now();
  for (const key of [userKey(username), ipKey(ip)]) {
    attempts().set(key, [...recent(key, now), now]);
  }
}

export function clearLoginFailures(username) {
  attempts().delete(userKey(username));
}
