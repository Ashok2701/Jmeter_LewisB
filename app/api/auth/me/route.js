import { NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;
  return NextResponse.json(
    { authenticated: true, user: { username: auth.user.username } },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
