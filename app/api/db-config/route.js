import { requireAuth } from '@/lib/auth';
import { NextResponse } from 'next/server';

import { publicDbDefaults } from '@/lib/dbConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Query Testing's Database Configuration defaults, from DB_* in .env, so the
 * form can pre-fill Host / Port / Name / Username. The password itself is
 * never sent - only whether one is configured.
 */
export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  return NextResponse.json(publicDbDefaults());
}
