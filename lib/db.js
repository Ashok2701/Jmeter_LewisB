import pg from 'pg';

// Backend-only. The single PostgreSQL connection pool for the whole app.
//
// Every setting comes from environment variables (.env locally, the real
// environment in production) - nothing is hard-coded and nothing is exposed to
// the browser. The pool lives on globalThis so Next's dev-mode module reloads
// do not open extra pools; connections are reused across requests.

export class DbConfigError extends Error {}

// BIGINT (OID 20) / COUNT(*) arrive as strings by default; ids and counts here fit a JS number.
const typeParser = {
  getTypeParser: (oid, format) =>
    oid === 20 ? (v) => Number(v) : pg.types.getTypeParser(oid, format),
};

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new DbConfigError(`${name} is not set. Add it to the .env file (see .env.example).`);
  }
  return value;
}

export function getDbConfig(env = process.env) {
  const port = Number(required('DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DbConfigError('DB_PORT must be a valid port number.');
  }
  const intOr = (name, fallback) => (Number(env[name]) > 0 ? Number(env[name]) : fallback);
  const useSsl = /^(1|true|require)$/i.test((env.DB_SSL ?? '').trim());
  return {
    host: required('DB_HOST'),
    port,
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ssl: useSsl
      ? { rejectUnauthorized: !/^(0|false|no)$/i.test((env.DB_SSL_REJECT_UNAUTHORIZED ?? '').trim()) }
      : false,
    max: intOr('DB_POOL_MAX', 10),
    idleTimeoutMillis: intOr('DB_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: intOr('DB_CONNECT_TIMEOUT_MS', 8_000),
    statement_timeout: intOr('DB_STATEMENT_TIMEOUT_MS', 15_000),
    application_name: 'jmeter-test-launcher',
    types: typeParser,
  };
}

const GLOBAL_KEY = Symbol.for('lewisbakers.pgPool');

export function getPool() {
  let pool = globalThis[GLOBAL_KEY];
  if (pool) return pool;

  pool = new pg.Pool(getDbConfig());
  // An error on an idle client must not crash the process; the pool discards
  // the broken client and opens a new one on demand. Never log the config.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.code || err.message);
  });
  globalThis[GLOBAL_KEY] = pool;
  return pool;
}

/** Parameterised query: query('SELECT ... WHERE id = $1', [id]). Returns the pg result. */
export function query(text, params = []) {
  return getPool().query(text, params);
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on any error. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection already broken; release below discards it
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Drains the pool. Call at the end of CLI scripts so the process can exit. */
export async function closePool() {
  const pool = globalThis[GLOBAL_KEY];
  globalThis[GLOBAL_KEY] = undefined;
  if (pool) await pool.end();
}
