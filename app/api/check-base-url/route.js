import { NextResponse } from 'next/server';

import { detectSchema, normaliseCsv, parseCsv } from '@/lib/csvSchema';
import { checkEndpoint } from '@/lib/preflight';
import { validateBaseUrl, validateCsv } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sends ONE request to the first endpoint in the uploaded CSV, using its Base
 * URL, and reports what came back. Used both by the "Check Base URL" button
 * and as a pre-flight when a run is submitted.
 */
export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 });
  }

  const file = form.get('csv');
  const csvCheck = validateCsv(file);
  if (!csvCheck.ok) {
    return NextResponse.json({ error: csvCheck.message }, { status: 400 });
  }

  const text = Buffer.from(await file.arrayBuffer()).toString('utf8');
  const detected = detectSchema(parseCsv(text));
  if (detected.schema === 'unknown') {
    return NextResponse.json({ error: detected.reason }, { status: 400 });
  }

  // Reuse the run's own normalisation so the URL checked here is byte-for-byte
  // the URL the test would request - not a separate guess at how they combine.
  // A CSV with its own BASE_URL column normalises with no form value at all;
  // only when it needs one and doesn't supply it is the form's `baseUrl`
  // required.
  let normalised = normaliseCsv(text, {});
  if (!normalised.ok) {
    const baseUrlCheck = validateBaseUrl(form.get('baseUrl'), { required: true });
    if (!baseUrlCheck.ok) {
      return NextResponse.json({ error: baseUrlCheck.message }, { status: 400 });
    }
    normalised = normaliseCsv(text, { baseUrl: baseUrlCheck.value });
    if (!normalised.ok) {
      return NextResponse.json({ error: normalised.message }, { status: 400 });
    }
  }

  const rows = parseCsv(normalised.csv);
  const firstUrl = rows[1]?.[1];
  if (!firstUrl) {
    return NextResponse.json({ error: 'No API rows to check.' }, { status: 400 });
  }

  const result = await checkEndpoint({
    baseUrl: '',
    endpoint: firstUrl,
    username: String(form.get('username') ?? '').trim(),
    password: String(form.get('password') ?? ''),
  });

  return NextResponse.json(result);
}
