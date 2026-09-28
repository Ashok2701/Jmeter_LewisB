import net from 'node:net';

// Query Testing's SQL Server connection comes from DB_HOST / DB_PORT /
// DB_NAME / DB_USER / DB_PASSWORD in .env (loaded into process.env by
// Next.js) - the same variables run_sql_test.bat and sql_test.jmx read. The
// form may override them for a single run; nothing typed there is saved.

/** The .env values, used for any Database Configuration field left empty. */
export function dbDefaults() {
  return {
    host: process.env.DB_HOST ?? '',
    port: process.env.DB_PORT ?? '',
    name: process.env.DB_NAME ?? '',
    user: process.env.DB_USER ?? '',
    password: process.env.DB_PASSWORD ?? '',
  };
}

/** What the browser may see: every default except the password itself. */
export function publicDbDefaults() {
  const { password, ...rest } = dbDefaults();
  return { ...rest, port: rest.port || '1433', passwordConfigured: Boolean(password) };
}

/**
 * Checks, before JMeter starts, that something is listening at host:port, so
 * an unknown host or closed port is reported in seconds with a clear message
 * instead of as a JDBC login timeout on every query. For HOST\INSTANCE only
 * the host part is resolved - the port given is the instance's own port.
 */
export function checkDbReachable(host, port, timeoutMs = 5000) {
  const hostname = host.split('\\')[0];
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      done({
        ok: false,
        message: `Could not connect to the SQL Server at ${hostname}:${port} (no response within ${timeoutMs / 1000} seconds). Check the Database Host and Port, and that this machine can reach the server's network.`,
      })
    );
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => {
      const reason =
        err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
          ? `the host name "${hostname}" could not be found (DNS). Check the Database Host, or use the server's full name or IP address`
          : err.code === 'ECONNREFUSED'
            ? `nothing is listening on port ${port}. Check the Database Port (for a named instance, use its TCP port)`
            : err.message;
      done({ ok: false, message: `Could not connect to the SQL Server at ${hostname}:${port}: ${reason}.` });
    });
  });
}
