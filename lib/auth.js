import { NextResponse } from 'next/server';

import { getSessionUser, SESSION_TTL_MS } from './authCore.js';

// Backend-only. The one shared guard every API route calls first.
//
//   const auth = requireAuth(request);
//   if (auth.response) return auth.response;
//
// Sessions are signed expiring cookies checked against jmeter_user; the browser holds an
// httpOnly token. There are no roles: a valid session means full access.

export const SESSION_COOKIE = 'lb_session';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function isHttps(request) {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  return request.nextUrl?.protocol === 'https:';
}

export function sessionCookieOptions(request) {
  return {
    httpOnly: true,
    secure: isHttps(request),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function clearSessionCookie(response, request) {
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(request), maxAge: 0 });
}

/**
 * CSRF defence for state-changing requests, on top of the SameSite cookie: a
 * browser-sent Origin must be this site. (Browsers always send Origin on POST
 * and DELETE; clients that send neither Origin nor Sec-Fetch-Site are not
 * browsers and carry no ambient cookie to abuse.)
 */
export function isSameOrigin(request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function unauthorized(message = 'Not signed in.') {
  return NextResponse.json({ error: message, authenticated: false }, { status: 401, headers: NO_STORE });
}

/** { user } when signed in, otherwise { response } to return straight away. */
export async function requireAuth(request) {
  try {
    if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return {
        response: NextResponse.json({ error: 'Cross-site request blocked.' }, { status: 403, headers: NO_STORE }),
      };
    }
    const user = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return { response: unauthorized() };
    return { user };
  } catch (err) {
    // Never leak database details or internals to the browser.
    console.error('[auth] session check failed:', err);
    return {
      response: NextResponse.json({ error: 'Authentication is unavailable.' }, { status: 503, headers: NO_STORE }),
    };
  }
}
