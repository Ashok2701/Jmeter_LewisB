import { NextResponse } from 'next/server';

import { getBatch, toPublicBatch } from '@/lib/batches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;
  const batch = getBatch(id);

  if (!batch) {
    return NextResponse.json({ error: 'Unknown test batch.' }, { status: 404 });
  }

  return NextResponse.json(
    { batch: toPublicBatch(batch) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
