import { NextResponse } from 'next/server';

import { deleteHistoryRecord } from '@/lib/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Deletes one run from History (its saved record and log - not its report). */
export async function DELETE(request, { params }) {
  const { id } = await params;

  try {
    const result = await deleteHistoryRecord(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }
    return NextResponse.json({ deleted: id }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { error: `The run could not be deleted: ${err.message}` },
      { status: 500 }
    );
  }
}