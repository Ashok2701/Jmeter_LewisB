import { NextResponse } from 'next/server';

import { detectSchema, normaliseCsv, parseCsv } from '@/lib/csvSchema';
import { normaliseSoapCsv } from '@/lib/soapCsvSchema';
import { normaliseSqlCsv } from '@/lib/sqlCsvSchema';
import { loadAppCsv, validateApplicationName } from '@/lib/appCsv';
import { API_TYPES, isApiTypeAllowed } from '@/lib/applications';
import { validateApiKind, validateBaseUrl } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inspects the CSV for the selected Application Name + API Type without
 * running anything, so the UI can name the file and show the real API count
 * the moment both are chosen. The file is picked from csv files\ by
 * lib/appCsv.js, and the count returned here is produced by exactly the same
 * normalisation the run itself uses, so what the form shows is what JMeter
 * will execute - never an independent guess.
 *
 * Which normaliser runs is decided by `apiType` (REST or SOAP), sent by the
 * client's API Type dropdown - not auto-detected from the CSV's own shape.
 */
export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 });
  }

  const appNameCheck = validateApplicationName(form.get('applicationName'));
  if (!appNameCheck.ok) {
    return NextResponse.json({ error: appNameCheck.message }, { status: 400 });
  }

  const apiKindCheck = validateApiKind(form.get('apiType'));
  if (!apiKindCheck.ok) {
    return NextResponse.json({ error: apiKindCheck.message }, { status: 400 });
  }
  const apiKind = apiKindCheck.value;
  if (!isApiTypeAllowed(appNameCheck.value, apiKind)) {
    const label = API_TYPES.find((t) => t.value === apiKind)?.label ?? apiKind;
    return NextResponse.json(
      { error: `${label} is not available for ${appNameCheck.value}.` },
      { status: 400 }
    );
  }

  const csv = await loadAppCsv(appNameCheck.value, apiKind);
  if (!csv.ok) {
    return NextResponse.json({ error: csv.message }, { status: 400 });
  }
  const fileInfo = { fileName: csv.fileName, fileSize: csv.buffer.length };
  // The file was found and selected but may still be unusable (e.g. no rows the
  // test can run); the error names it so the form can show which file it is.
  const unusable = (message) =>
    NextResponse.json({ error: message, fileName: csv.fileName }, { status: 400 });

  const text = csv.buffer.toString('utf8');

  if (apiKind === 'SOAP') {
    const normalised = normaliseSoapCsv(text);
    if (!normalised.ok) {
      return unusable(normalised.message);
    }
    return NextResponse.json({
      ...fileInfo,
      apiKind,
      schema: normalised.schema,
      needsBaseUrl: false,
      baseUrlFromCsv: null,
      totalApis: normalised.apiCount,
      apiNames: normalised.apiNames.slice(0, 8),
      skipped: normalised.skipped ?? [],
    });
  }

  if (apiKind === 'SQL') {
    const normalised = normaliseSqlCsv(text);
    if (!normalised.ok) {
      return unusable(normalised.message);
    }
    return NextResponse.json({
      ...fileInfo,
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
    return unusable(detected.reason);
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
      return unusable(normalised.message);
    }
  }

  return NextResponse.json({
    ...fileInfo,
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
    skipped: [...(normalised.skipped ?? []), ...(csv.skipped ?? [])],
  });
}
