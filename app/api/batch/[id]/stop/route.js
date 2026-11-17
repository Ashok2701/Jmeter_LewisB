import { requireAuth } from '@/lib/auth';
import { NextResponse } from 'next/server';

import { getBatch, stopBatch, toPublicBatch } from '@/lib/batches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body { runId } stops only that configuration; an empty body stops every
// configuration still running in the batch.
export async function POST(request, { params }) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const { id } = await params;
  const batch = getBatch(id);
  if (!batch) {
    return NextResponse.json({ error: 'Unknown test batch.' }, { status: 404 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // No body: stop all.
  }
  const runId = typeof body?.runId === 'string' ? body.runId : null;

  const result = await stopBatch(batch, runId);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
  return NextResponse.json(
    { batch: toPublicBatch(batch), message: runId ? 'Execution stopped.' : 'All executions stopped.' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}