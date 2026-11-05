import { NextResponse } from 'next/server';

import { readRunQueue } from '@/lib/queue';
import { loadRun } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live execution queue of one run, read from the results JMeter is writing.
export async function GET(request, { params }) {
  const { id } = await params;
  const run = await loadRun(id);

  if (!run) {
    return NextResponse.json({ error: 'Unknown test run.' }, { status: 404 });
  }

  const queue = await readRunQueue(run);
  return NextResponse.json({ queue }, { headers: { 'Cache-Control': 'no-store' } });
}
