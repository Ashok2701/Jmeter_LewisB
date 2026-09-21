import { NextResponse } from 'next/server';

import { detectSchema, normaliseCsv, parseCsv } from '@/lib/csvSchema';
import { normaliseSoapCsv } from '@/lib/soapCsvSchema';
import { validateApiKind, validateBaseUrl, validateCsv } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inspects an uploaded CSV without running anything, so the UI can show the
 * real API count the moment the client picks a file. The count returned here is
 * produced by exactly the same normalisation the run itself uses, so what the
 * form shows is what JMeter will execute - never an independent guess.
 *
 * Which normaliser runs is decided by `apiType` (REST or SOAP), sent by the
 * client's API Type dropdown - not auto-detected from the CSV's own shape -
 * so a CSV uploaded for the wrong selection is rejected with a clear reason
 * instead of being silently misread by the other schema's rules. Missing or
 * unrecognised apiType defaults to REST, preserving this endpoint's original
 * (REST-only) behaviour for any caller that predates the SOAP dropdown.
 */
export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded file.' }, { status: 400 });
  }

  const file = form.get('csv');
  const csvCheck = validateCsv(file);
  if (!csvCheck.ok) {
    return NextResponse.json({ error: csvCheck.message }, { status: 400 });
  }

  const apiKindCheck = validateApiKind(form.get('apiType'));
  const apiKind = apiKindCheck.ok ? apiKindCheck.value : 'REST';

  const text = Buffer.from(await file.arrayBuffer()).toString('utf8');

  if (apiKind === 'SOAP') {
    const normalised = normaliseSoapCsv(text);
    if (!normalised.ok) {
      return NextResponse.json({ error: normalised.message }, { status: 400 });
    }
    return NextResponse.json({
      apiKind,
      schema: normalised.schema,
      needsBaseUrl: false,
      baseUrlFromCsv: null,
      totalApis: normalised.apiCount,
      apiNames: normalised.apiNames.slice(0, 8),
      skipped: normalised.skipped ?? [],
    });
  }

  const detected = detectSchema(parseCsv(text));

  if (detected.schema === 'unknown') {
    return NextResponse.json({ error: detected.reason }, { status: 400 });
  }

  // Try normalising with no externally supplied Base URL first. This succeeds
  // outright for a Method/URL export (which never needs one) and for an
  // endpoint list that carries its own BASE_URL column - in both cases the
  // client is never asked for a Base URL at all.
  let normalised = normaliseCsv(text, {});
  let needsBaseUrl = false;

  if (!normalised.ok) {
    needsBaseUrl = true;
    const baseUrlCheck = validateBaseUrl(form.get('baseUrl'), { required: false });
    // Without a Base URL an endpoint-style CSV still has a countable number of
    // rows, so report the count and let the UI ask for the Base URL separately.
    const effectiveBase = baseUrlCheck.ok && baseUrlCheck.value
      ? baseUrlCheck.value
      : 'https://placeholder.invalid';
    normalised = normaliseCsv(text, { baseUrl: effectiveBase });
    if (!normalised.ok) {
      return NextResponse.json({ error: normalised.message }, { status: 400 });
    }
  }

  return NextResponse.json({
    apiKind,
    schema: normalised.schema,
    needsBaseUrl,
    // Set only when the CSV supplied this value itself (baseUrlSource "csv"),
    // so the UI can show it as read-only information rather than as a field
    // asking the client to type it in again.
    baseUrlFromCsv:
      !needsBaseUrl && normalised.baseUrlSource === 'csv' ? normalised.baseUrl : null,
    totalApis: normalised.apiCount,
    // A short sample is enough for the client to confirm it is the right file.
    apiNames: normalised.apiNames.slice(0, 8),
    skipped: normalised.skipped ?? [],
  });
}
