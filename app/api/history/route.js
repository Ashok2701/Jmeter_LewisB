import { requireAuth } from '@/lib/auth';
import { NextResponse } from 'next/server';

import { listHistory } from '@/lib/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every saved test run, newest first, for the History page. */
export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  try {
    return NextResponse.json(
      { runs: await listHistory() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `The run history could not be loaded: ${err.message}` },
      { status: 500 }
    );
  }
}
