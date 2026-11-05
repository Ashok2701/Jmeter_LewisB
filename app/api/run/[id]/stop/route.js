import { NextResponse } from 'next/server';

import { getRun, stopRun, toPublicRun } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stops this one execution (its JMeter process tree). Other runs are untouched.
export async function POST(request, { params }) {
  const { id } = await params;
  if (!getRun(id)) {
    return NextResponse.json({ error: 'Unknown test run.' }, { status: 404 });
  }

  const result = await stopRun(id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, run: toPublicRun(result.run) },
      { status: result.status }
    );
  }
  return NextResponse.json(
    { run: toPublicRun(result.run), message: 'Execution stopped.' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}