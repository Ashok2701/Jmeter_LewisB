import fs from 'node:fs';
import { NextResponse } from 'next/server';

import {
  BAT_DIR,
  BAT_NAME,
  BAT_PATH,
  SOAP_BAT_NAME,
  SOAP_BAT_PATH,
  SQL_BAT_NAME,
  SQL_BAT_PATH,
} from '@/lib/config';
import { createRunDirectory, writeRunConfig, writeRunCsvFiles } from '@/lib/csv';
import { detectSchema, normaliseCsv, parseCsv } from '@/lib/csvSchema';
import { normaliseSoapCsv } from '@/lib/soapCsvSchema';
import { normaliseSqlCsv } from '@/lib/sqlCsvSchema';
import { loadAppCsv, validateApplicationName } from '@/lib/appCsv';
import { API_TYPES, credentialGroupFor, isApiTypeAllowed } from '@/lib/applications';
import { loadCredentials, writeUsersCsv } from '@/lib/credentials';
import { checkDbReachable, dbDefaults } from '@/lib/dbConfig';
import { getActiveRun, startRun, toPublicRun } from '@/lib/runs';
import {
  validateApiKind,
  validateBaseUrl,
  validateDbConfig,
  validateNumber,
} from '@/lib/validate';

const apiTypeLabel = (value) => API_TYPES.find((t) => t.value === value)?.label ?? value;
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
  const apiKind = apiKindCheck.value; // 'REST', 'SOAP', or 'SQL'

  // Which .bat runs, and its display name in logs/errors - decided here, from
  // the validated apiKind, never from anything else client-supplied.
  const batName =
    apiKind === 'SOAP' ? SOAP_BAT_NAME : apiKind === 'SQL' ? SQL_BAT_NAME : BAT_NAME;
  const batPath =
    apiKind === 'SOAP' ? SOAP_BAT_PATH : apiKind === 'SQL' ? SQL_BAT_PATH : BAT_PATH;

  if (!fs.existsSync(batPath)) {
    return fail(
      `${batName} was not found in ${BAT_DIR}.`,
      500
    );
  }

  const appNameCheck = validateApplicationName(form.get('applicationName'));
  if (!appNameCheck.ok) return fail(appNameCheck.message);
  if (!isApiTypeAllowed(appNameCheck.value, apiKind)) {
    return fail(`${apiTypeLabel(apiKind)} is not available for ${appNameCheck.value}.`);
  }

  // Query Testing: the SQL Server connection. Empty fields fall back to DB_*
  // in .env; the result reaches run_sql_test.bat only as environment
  // variables (see startRun), never as arguments, and is never persisted.
  let dbConfig = null;
  if (apiKind === 'SQL') {
    const dbCheck = validateDbConfig(
      {
        host: form.get('dbHost'),
        port: form.get('dbPort'),
        name: form.get('dbName'),
        user: form.get('dbUser'),
        password: form.get('dbPassword'),
      },
      dbDefaults()
    );
    if (!dbCheck.ok) return fail(dbCheck.message);
    dbConfig = dbCheck.value;
  }

  // The CSV is no longer uploaded: it is the file in csv files\ for this
  // Application Name + API Type, picked server-side by lib/appCsv.js. From
  // here on it goes through exactly the same normalisation and run-directory
  // steps an uploaded CSV did.
  const csv = await loadAppCsv(appNameCheck.value, apiKind);
  if (!csv.ok) return fail(csv.message);

  const threadsCheck = validateNumber('threads', form.get('threads'));
  if (!threadsCheck.ok) return fail(threadsCheck.message);

  const rampupCheck = validateNumber('rampup', form.get('rampup'));
  if (!rampupCheck.ok) return fail(rampupCheck.message);

  const loopsCheck = validateNumber('loops', form.get('loops'));
  if (!loopsCheck.ok) return fail(loopsCheck.message);

  // The login REST and SOAP runs authenticate with - a SOAP gateway (e.g. Sage
  // X3's Web Service) sits behind the same login as the REST API.
  // run_soap_test.bat passes it on to scripts\ApplyAuthHeader.groovy exactly as
  // run_jmeter_test.bat already does for a REST endpoint-list CSV with no login
  // step of its own. It is no longer typed on the Test Run form: it is the
  // login saved under Configuration for this application's credential group
  // (Merchandiser App and Route App share one; Sales Order Adjustment Web App
  // has its own), decrypted here and handed to startRun below, which passes it
  // to JMeter as before. Anything a client sends as username/password is
  // ignored. Query Testing has no such login - it connects with the Database
  // Configuration above (see run_sql_test.bat).
  let username = '';
  let password = '';
  let usersCsvPath = '';
  if (apiKind !== 'SQL') {
    const group = credentialGroupFor(appNameCheck.value, apiKind);
    const saved = group ? await loadCredentials(group.id) : { ok: false, reason: 'missing' };
    if (!saved.ok) {
      const label = group?.label ?? appNameCheck.value;
      return fail(
        saved.reason === 'unreadable'
          ? `The saved login for ${label} could not be read (it was saved by a different Windows user, or is damaged). Open Configuration in the sidebar and save the username and password again.`
          : `No saved login for ${label}. Open Configuration in the sidebar, enter the username and password, and click Save.`
      );
    }
    ({ username, password } = saved);

    // Multi-user runs: JMeter reads every saved login from this group's users
    // CSV (scripts\AssignLoginUser.groovy), one per thread. It is rewritten
    // from the saved logins right now, so it is always current. username /
    // password above stay user 1, exactly as for a single-user run.
    try {
      usersCsvPath = await writeUsersCsv(group, saved.users);
    } catch (err) {
      return fail(`The users CSV ${group.usersCsv} could not be written: ${err.message}`, 500);
    }
  }

  const uploadedBuffer = csv.buffer;
  const csvText = uploadedBuffer.toString('utf8');

  let normalised;
  let baseUrlValue = '';

  if (apiKind === 'SOAP') {
    normalised = normaliseSoapCsv(csvText);
    if (!normalised.ok) return fail(normalised.message);
  } else if (apiKind === 'SQL') {
    normalised = normaliseSqlCsv(csvText);
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

  if (dbConfig) {
    const reachable = await checkDbReachable(dbConfig.host, dbConfig.port);
    if (!reachable.ok) return fail(reachable.message);
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
      csvName: csv.fileName,
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
      usersCsvPath,
      // Display only - never used to build a path.
      csvName: csv.fileName,
      csvRows: normalised.apiCount,
      csvSchema: normalised.schema,
      skippedRows: normalised.skipped ?? [],
      testDataPath,
      batName,
      batPath,
      dbConfig,
    });
  } catch (err) {
    return fail(`Could not start ${batName}: ${err.message}`, 500);
  }

  return NextResponse.json({ run: toPublicRun(run) }, { status: 202 });
}
