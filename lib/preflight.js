/**
 * Single-request check of a Base URL before a whole test is run against it.
 *
 * A wrong Base URL is indistinguishable from a broken app once the run has
 * finished: the report just shows 404 on everything. Issuing one request first
 * turns a three-minute round trip into immediate feedback naming the exact URL
 * that was tried and what came back.
 */

const TIMEOUT_MS = 12000;

function hintFor(status) {
  if (status === 404) {
    return 'Nothing exists at that path. The host is reachable, so this is the Base URL — it is almost certainly missing the API path prefix (everything that comes before the endpoint name).';
  }
  if (status === 401 || status === 403) {
    return 'The path exists but the request was rejected as unauthorised. The Base URL looks right; check the username and password.';
  }
  if (status === 405) {
    return 'The path exists but does not accept GET. The Base URL looks right.';
  }
  if (status >= 500) {
    return 'The server returned an error. The path exists, but the server could not serve it.';
  }
  return null;
}

export async function checkEndpoint({ baseUrl, endpoint, username, password }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const path = String(endpoint).trim();
  const url = /^https?:\/\//i.test(path)
    ? path
    : `${base}/${path.replace(/^\/+/, '')}`;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, error: 'That Base URL and endpoint do not form a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url, error: 'Only http:// and https:// are supported.' };
  }

  const headers = { Accept: 'application/json' };
  // Sent only if supplied, so a 401 can be told apart from a 404.
  if (username) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${username}:${password ?? ''}`).toString('base64');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      url,
      status: res.status,
      statusText: res.statusText,
      hint: res.ok ? null : hintFor(res.status),
    };
  } catch (err) {
    const code = err.cause?.code;
    const byCode = {
      ENOTFOUND: 'That host name could not be resolved.',
      ECONNREFUSED: 'The connection was refused — check the host and port.',
      ECONNRESET: 'The server closed the connection.',
      ETIMEDOUT: 'The connection timed out.',
      EHOSTUNREACH: 'That host is unreachable from this machine.',
      CERT_HAS_EXPIRED: 'The server\'s TLS certificate has expired.',
      DEPTH_ZERO_SELF_SIGNED_CERT:
        'The server uses a self-signed TLS certificate, which this check rejects. JMeter itself accepts it, so the run may still work.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE:
        'The server\'s TLS certificate could not be verified. JMeter itself accepts it, so the run may still work.',
    };
    const reason =
      err.name === 'AbortError'
        ? `No response within ${TIMEOUT_MS / 1000} seconds.`
        : (byCode[code] ?? (code ? `${err.message} (${code})` : err.message));
    return { ok: false, url, error: `Could not reach the server: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}
