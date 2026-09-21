import fs from 'node:fs';
import { NextResponse } from 'next/server';

import { BAT_NAME, BAT_PATH, PROJECT_DIR, SOAP_BAT_NAME, SOAP_BAT_PATH } from '@/lib/config';
import { createRunDirectory, writeRunConfig, writeRunCsvFiles } from '@/lib/csv';
import { detectSchema, normaliseCsv, parseCsv } from '@/lib/csvSchema';
import { normaliseSoapCsv } from '@/lib/soapCsvSchema';
import { getActiveRun, startRun, toPublicRun } from '@/lib/runs';
import {
  validateApiKind,
  validateBaseUrl,
  validateCredentials,
  validateCsv,
  validateNumber,
  validateText,
} from '@/lib/validate';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(message, status = 400, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function GET() {
  // Lets the UI recover its state after a page refresh mid-test.
  const active = getActiveRun();
  return NextResponse.json({ run: active ? toPublicRun(active) : null });
}

export async function POST(request) {
  // One test at a time - two JMeter runs at once would compete for the machine
  // and make both sets of timings meaningless.
  const active = getActiveRun();
  if (active) {
    return fail(
      'A test is already running. Please wait for it to finish before starting another.',
      409,
      { run: toPublicRun(active) }
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('Could not read the submitted form. Please try again.');
  }

  const apiKindCheck = validateApiKind(form.get('apiType'));
  if (!apiKindCheck.ok) return fail(apiKindCheck.message);
  const apiKind = apiKindCheck.value; // 'REST' or 'SOAP'

  // Which .bat runs, and its display name in logs/errors - decided here, from
  // the validated apiKind, never from anything else client-supplied.
  const batName = apiKind === 'SOAP' ? SOAP_BAT_NAME : BAT_NAME;
  const batPath = apiKind === 'SOAP' ? SOAP_BAT_PATH : BAT_PATH;

  if (!fs.existsSync(batPath)) {
    return fail(
      `${batName} was not found in ${PROJECT_DIR}. Check the JMETER_PROJECT_DIR setting.`,
      500
    );
  }

  const file = form.get('csv');
  const csvCheck = validateCsv(file);
  if (!csvCheck.ok) return fail(csvCheck.message);

  const appNameCheck = validateText('applicationName', form.get('applicationName'), {
    label: 'Application Name',
  });
  if (!appNameCheck.ok) return fail(appNameCheck.message);

  const threadsCheck = validateNumber('threads', form.get('threads'));
  if (!threadsCheck.ok) return fail(threadsCheck.message);

  const rampupCheck = validateNumber('rampup', form.get('rampup'));
  if (!rampupCheck.ok) return fail(rampupCheck.message);

  const loopsCheck = validateNumber('loops', form.get('loops'));
  if (!loopsCheck.ok) return fail(loopsCheck.message);

  // Same login username/password the REST flow already requires - a SOAP
  // gateway (e.g. Sage X3's Web Service) sits behind the same login as the
  // REST API, so SOAP needs these credentials too. run_soap_test.bat passes
  // them on to scripts\ApplyAuthHeader.groovy exactly as run_jmeter_test.bat
  // already does for a REST endpoint-list CSV with no login step of its own.
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const credCheck = validateCredentials(username, password);
  if (!credCheck.ok) return fail(credCheck.message);

  const uploadedBuffer = Buffer.from(await file.arrayBuffer());
  const csvText = uploadedBuffer.toString('utf8');

  let normalised;
  let baseUrlValue = '';

  if (apiKind === 'SOAP') {
    normalised = normaliseSoapCsv(csvText);
    if (!normalised.ok) return fail(normalised.message);
  } else {
    // --- REST: unchanged from before the SOAP flow existed ---
    // A Base URL is only meaningful for the relative-endpoint CSV layout. Try
    // normalising with no externally supplied one first: this succeeds outright
    // for a Method/URL export, and for an endpoint list that carries its own
    // BASE_URL column - in both cases the form's `baseUrl` is never required,
    // and whatever the client sent there is ignored in favour of the CSV's own
    // value. Only when the CSV needs a Base URL and doesn't supply one itself is
    // the form field consulted (and required).
    const detected = detectSchema(parseCsv(csvText));
    normalised = normaliseCsv(csvText, {});
    baseUrlValue = normalised.ok ? normalised.baseUrl || '' : '';

    if (!normalised.ok) {
      const baseUrlCheck = validateBaseUrl(form.get('baseUrl'), {
        required: detected.schema === 'endpoint',
      });
      if (!baseUrlCheck.ok) return fail(baseUrlCheck.message);

      normalised = normaliseCsv(csvText, { baseUrl: baseUrlCheck.value });
      if (!normalised.ok) return fail(normalised.message);
      baseUrlValue = baseUrlCheck.value;
    }
  }

  const id = randomUUID();
  let testDataPath;
  try {
    const runDir = await createRunDirectory(id);
    ({ testDataPath } = await writeRunCsvFiles(runDir, {
      uploadedBuffer,
      normalisedCsv: normalised.csv,
    }));
    await writeRunConfig(runDir, {
      runId: id,
      applicationName: appNameCheck.value,
      apiType: apiKind,
      baseUrl: baseUrlValue,
      csvName: String(file.name),
      csvSchema: normalised.schema,
      totalApis: normalised.apiCount,
      apiNames: normalised.apiNames,
      skippedRows: normalised.skipped ?? [],
      threads: threadsCheck.value,
      rampup: rampupCheck.value,
      loops: loopsCheck.value,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    return fail(`Could not prepare the test run directory: ${err.message}`, 500);
  }

  let run;
  try {
    run = await startRun({
      id,
      applicationName: appNameCheck.value,
      apiType: apiKind,
      baseUrl: baseUrlValue,
      threads: threadsCheck.value,
      rampup: rampupCheck.value,
      loops: loopsCheck.value,
      username,
      password,
      // Display only - never used to build a path.
      csvName: String(file.name),
      csvRows: normalised.apiCount,
      csvSchema: normalised.schema,
      skippedRows: normalised.skipped ?? [],
      testDataPath,
      batName,
      batPath,
    });
  } catch (err) {
    return fail(`Could not start ${batName}: ${err.message}`, 500);
  }

  return NextResponse.json({ run: toPublicRun(run) }, { status: 202 });
}
