import { NextResponse } from 'next/server';

import {
  clearSessionCookie,
  isSameOrigin,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth';
import {
  checkLoginThrottle,
  clearLoginFailures,
  createSession,
  PASSWORD_MAX,
  recordLoginFailure,
  verifyCredentials,
} from '@/lib/authCore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error, status, extra = {}) =>
  NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...extra } });

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return (forwarded ? forwarded.split(',')[0].trim() : '') || 'local';
}

export async function POST(request) {
  if (!isSameOrigin(request)) return fail('Cross-site request blocked.', 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('Enter your username and password.', 400);
  }
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return fail('Enter your username and password.', 400);
  if (username.length > 64 || Buffer.byteLength(password) > PASSWORD_MAX) {
    return fail('Invalid username or password.', 401);
  }

  try {
    const ip = clientIp(request);
    const throttle = checkLoginThrottle(username, ip);
    if (throttle.limited) {
      return fail('Too many failed attempts. Please wait before trying again.', 429, {
        'Retry-After': String(throttle.retryAfterSeconds),
      });
    }

    const user = await verifyCredentials(username, password);
    if (!user) {
      recordLoginFailure(username, ip);
      return fail('Invalid username or password.', 401);
    }

    clearLoginFailures(username);
    const { token } = createSession(user);

    const response = NextResponse.json({ user: { username: user.username } }, { headers: NO_STORE });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(request));
    return response;
  } catch (err) {
    console.error('[auth] login failed:', err);
    const response = fail('Sign-in is temporarily unavailable. Contact the administrator.', 503);
    clearSessionCookie(response, request);
    return response;
  }
}
