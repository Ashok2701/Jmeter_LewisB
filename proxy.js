import { NextResponse } from 'next/server';

import { SESSION_COOKIE } from '@/lib/auth';
import { getSessionUser } from '@/lib/authCore';

// Page protection (this file is "middleware" in older Next.js). Unauthenticated
// visitors are redirected to /login before any application page is served.
//
// It runs on pages only. The /api/* routes are NOT matched here: each of them
// calls requireAuth() itself (lib/auth.js) so a direct API call is rejected
// with 401 regardless of this file.
//
// Protected responses are marked no-store so the browser does not keep them for
// the Back button after logout.

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  let user = null;
  try {
    user = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (err) {
    console.error('[auth] page session check failed:', err);
  }

  if (pathname === '/login') {
    // Already signed in: skip the form.
    if (user) return NextResponse.redirect(new URL('/', request.url));
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  if (!user) {
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }

  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = {
  // Every page; not API routes, Next's own assets, or the favicon.
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
