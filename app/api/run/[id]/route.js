import { requireAuth } from '@/lib/auth';
import { NextResponse } from 'next/server';

import { loadRun, toPublicRun } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const { id } = await params;
  const run = await loadRun(id);

  if (!run) {
    return NextResponse.json({ error: 'Unknown test run.' }, { status: 404 });
  }

  return NextResponse.json(
    { run: toPublicRun(run) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
