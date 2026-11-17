import { requireAuth } from '@/lib/auth';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

import { loadRun, runLogPath } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The full console output of one run_jmeter_test.bat execution, for
 * troubleshooting a failure. The UI links here from its error state.
 */
export async function GET(request, { params }) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  const { id } = await params;

  const run = await loadRun(id);
  if (!run) {
    return new Response('Unknown test run.', { status: 404 });
  }

  const logPath = runLogPath(id);
  let stat;
  try {
    stat = await fsp.stat(logPath);
  } catch {
    return new Response('No execution log was recorded for this run.', {
      status: 404,
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(logPath)), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    },
  });
}
