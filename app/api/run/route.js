import { requireAuth } from '@/lib/auth';
import fs from 'node:fs';
import path from 'node:path';
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
import { buildCodeThreadPlan, buildRolesPlan, buildThreadPlan, splitApiCsvByType } from '@/lib/rolePlan';
import { shuffleUserCodesCsv, usesRandomUserCodes } from '@/lib/userCodes';
import { USER_TYPES, supportsUserTypeThreads, validateTypeThreads } from '@/lib/userTypes';
import { PAGINATION, buildPaginationConfig, supportsPagination } from '@/lib/pagination';
import { API_TYPES, credentialGroupFor, isApiTypeAllowed, threadLimitMessage } from '@/lib/applications';
import { loadCredentials, writeRunUsersCsv, writeUsersCsv } from '@/lib/credentials';
import { checkDbReachable, dbDefaults } from '@/lib/dbConfig';
import { getActiveRun, startRun, toPublicRun } from '@/lib/runs';
import { getActiveBatch, startBatch, toPublicBatch } from '@/lib/batches';
import {
  validateApiKind,
  validateBaseUrl,
  validateDbConfig,
  validateNumber,
  validateNumUsers,
} from '@/lib/validate';

const apiTypeLabel = (value) => API_TYPES.find((t) => t.value === value)?.label ?? value;
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(message, status = 400, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function GET(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  // Lets the UI recover its state after a page refresh mid-test.
  const batch = getActiveBatch();
  if (batch) return NextResponse.json({ run: null, batch: toPublicBatch(batch) });
  const active = getActiveRun();
  return NextResponse.json({ run: active ? toPublicRun(active) : null, batch: null });
}

/**
 * The test configurations in this request. A client that sends `configurations`
 * (a JSON array of any length, entries of { applicationName, apiType,
 * numUsers }) gets one run per entry; a client that sends the older single set
 * of fields (applicationName / apiType / numUsers) gets exactly one, as before.
 */
function readConfigurations(form) {
  const raw = form.get('configurations');
  if (raw === null) {
    return {
      ok: true,
      list: [
        {
          applicationName: form.get('applicationName'),
          apiType: form.get('apiType'),
          numUsers: form.get('numUsers'),
          baseUrl: form.get('baseUrl'),
          // Older single-set clients send one set of load settings for the run.
          threads: form.get('threads'),
          rampup: form.get('rampup'),
          loops: form.get('loops'),
        },
      ],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { ok: false, message: 'The test configurations could not be read. Please try again.' };
  }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    return { ok: false, message: 'Please configure at least one test.' };
  }
  return {
    ok: true,
    list: parsed.map((c) => ({
      applicationName: c?.applicationName,
      apiType: c?.apiType,
      numUsers: c?.numUsers == null ? '' : String(c.numUsers),
      baseUrl: '',
      threads: c?.threads == null ? '' : String(c.threads),
      rampup: c?.rampup == null ? '' : String(c.rampup),
      loops: c?.loops == null ? '' : String(c.loops),
      // Merchandiser REST only: optional Threads per user type ({ key: '10', ... }).
      typeThreads: c?.typeThreads && typeof c.typeThreads === 'object' ? c.typeThreads : null,
    })),
  };
}

/**
 * Validates one configuration exactly as a single run always was - bat, CSV,
 * saved login, Number of Users, normalisation - and returns what is needed to
 * start it. Nothing is written for the run itself until materialize() is
 * called, so a batch can be rejected as a whole without leaving run folders
 * behind.
 */
async function prepareConfig(cfg, shared) {
  // Load Test Configuration: every Test Configuration has its own.
  const threadsCheck = validateNumber('threads', cfg.threads);
  if (!threadsCheck.ok) return { ok: false, message: threadsCheck.message };
  const rampupCheck = validateNumber('rampup', cfg.rampup);
  if (!rampupCheck.ok) return { ok: false, message: rampupCheck.message };
  const loopsCheck = validateNumber('loops', cfg.loops);
  if (!loopsCheck.ok) return { ok: false, message: loopsCheck.message };
  const load = { threads: threadsCheck.value, rampup: rampupCheck.value, loops: loopsCheck.value };

  const apiKindCheck = validateApiKind(cfg.apiType);
  if (!apiKindCheck.ok) return { ok: false, message: apiKindCheck.message };
  const apiKind = apiKindCheck.value; // 'REST', 'SOAP', or 'SQL'

  // Which .bat runs, and its display name in logs/errors - decided here, from
  // the validated apiKind, never from anything else client-supplied.
  const batName =
    apiKind === 'SOAP' ? SOAP_BAT_NAME : apiKind === 'SQL' ? SQL_BAT_NAME : BAT_NAME;
  const batPath =
    apiKind === 'SOAP' ? SOAP_BAT_PATH : apiKind === 'SQL' ? SQL_BAT_PATH : BAT_PATH;

  if (!fs.existsSync(batPath)) {
    return { ok: false, status: 500, message: `${batName} was not found in ${BAT_DIR}.` };
  }

  const appNameCheck = validateApplicationName(cfg.applicationName);
  if (!appNameCheck.ok) return { ok: false, message: appNameCheck.message };
  if (!isApiTypeAllowed(appNameCheck.value, apiKind)) {
    return {
      ok: false,
      message: `${apiTypeLabel(apiKind)} is not available for ${appNameCheck.value}.`,
    };
  }

  // Maximum Threads for this application + API Type (never trust the form's check).
  const threadLimit = threadLimitMessage(appNameCheck.value, apiKind, load.threads);
  if (threadLimit) return { ok: false, message: threadLimit };

  // The CSV is no longer uploaded: it is the file in csv files\ for this
  // Application Name + API Type, picked server-side by lib/appCsv.js. From
  // here on it goes through exactly the same normalisation and run-directory
  // steps an uploaded CSV did.
  const csv = await loadAppCsv(appNameCheck.value, apiKind);
  if (!csv.ok) return { ok: false, message: csv.message };

  // The login REST and SOAP runs authenticate with - a SOAP gateway (e.g. Sage
  // X3's Web Service) sits behind the same login as the REST API.
  // run_soap_test.bat passes it on to scripts\ApplyAuthHeader.groovy exactly as
  // run_jmeter_test.bat already does for a REST endpoint-list CSV with no login
  // step of its own. It is no longer typed on the Test Run form: it is the
  // login saved under Configuration for this application's credential group
  // (Merchandiser App and Route App share one; Sales Order Adjustment Web App
  // has its own), decrypted here and handed to startRun, which passes it
  // to JMeter as before. Anything a client sends as username/password is
  // ignored. Query Testing has no such login - it connects with the
  // Database Configuration instead (see run_sql_test.bat).
  let username = '';
  let password = '';
  let usersCsvPath = '';
  let numUsers = null; // REST / SOAP only - Query Testing has no login concept.
  let selectedUsers = [];
  if (apiKind !== 'SQL') {
    const group = credentialGroupFor(appNameCheck.value, apiKind);
    const saved = group ? await loadCredentials(group.id) : { ok: false, reason: 'missing' };
    if (!saved.ok) {
      const label = group?.label ?? appNameCheck.value;
      return {
        ok: false,
        message:
          saved.reason === 'unreadable'
            ? `The users file for ${label} (${group?.usersCsv ?? 'credentials folder'}) could not be read. It needs LOGIN_USERNAME and LOGIN_PASSWORD columns.`
            : `No users found for ${label}. Add them to credentials\\${group?.usersCsv ?? ''} (LOGIN_USERNAME, LOGIN_PASSWORD columns).`,
      };
    }
    ({ username, password } = saved);

    // Number of Users: the maximum number of the group's configured logins
    // this run may use, taken from the beginning of the list in order. Never
    // more than are actually configured - checked against saved.users.length,
    // the real count, not a guess.
    const numUsersCheck = validateNumUsers(cfg.numUsers, saved.users.length);
    if (!numUsersCheck.ok) return { ok: false, message: numUsersCheck.message };
    numUsers = numUsersCheck.value;
    selectedUsers = saved.users.slice(0, numUsers);

    // Keeps the group's persistent users CSV (webapp\credentials\<group>.csv)
    // in sync with Configuration, exactly as before - unrelated to Number of
    // Users, which is applied to a separate, run-scoped copy at materialize.
    // A file-backed group (credentials\Route_App_Users.csv, ...) is the source
    // itself and is never rewritten.
    try {
      if (!group.fileBacked) usersCsvPath = await writeUsersCsv(group, saved.users);
    } catch (err) {
      return {
        ok: false,
        status: 500,
        message: `The users CSV ${group.usersCsv} could not be written: ${err.message}`,
      };
    }
  }

  const csvText = csv.buffer.toString('utf8');

  let normalised;
  let baseUrlValue = '';

  if (apiKind === 'SOAP') {
    normalised = normaliseSoapCsv(csvText);
    if (!normalised.ok) return { ok: false, message: normalised.message };
  } else if (apiKind === 'SQL') {
    normalised = normaliseSqlCsv(csvText);
    if (!normalised.ok) return { ok: false, message: normalised.message };
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
      const baseUrlCheck = validateBaseUrl(cfg.baseUrl, {
        required: detected.schema === 'endpoint',
      });
      if (!baseUrlCheck.ok) return { ok: false, message: baseUrlCheck.message };

      normalised = normaliseCsv(csvText, { baseUrl: baseUrlCheck.value });
      if (!normalised.ok) return { ok: false, message: normalised.message };
      baseUrlValue = baseUrlCheck.value;
    }
  }

  const skippedRows = [...(normalised.skipped ?? []), ...(csv.skipped ?? [])];

  // Merchandiser REST only: Total Threads optionally split between user types.
  // Each type with threads gets its own API list (its own APIs only) and the
  // run uses a generated plan with one Thread Group per type (lib/rolePlan.js).
  let split = null; // [{ key, label, threads, csv, rows }] when the run is split
  if (supportsUserTypeThreads(appNameCheck.value, apiKind)) {
    const typeCheck = validateTypeThreads(cfg.typeThreads, load.threads);
    if (!typeCheck.ok) return { ok: false, message: typeCheck.message };
    if (typeCheck.value) {
      const parts = splitApiCsvByType(csvText);
      if (!parts.ok) return { ok: false, message: `${csv.fileName}: ${parts.message}` };

      const codeCounts = new Map();
      if (csv.userCodesCsv) {
        for (const [role, code] of parseCsv(csv.userCodesCsv).slice(1)) {
          if (role && code) codeCounts.set(role, (codeCounts.get(role) ?? 0) + 1);
        }
      }

      split = [];
      for (const type of USER_TYPES) {
        const threads = typeCheck.value[type.key];
        if (!threads) continue;
        const part = parts.byType[type.key];
        if (!part.apiNames.length) {
          return { ok: false, message: `${csv.fileName} has no ${type.label} APIs, so ${type.label} cannot be given threads.` };
        }
        // Every thread of a type uses a different user code of that type's
        // sheet, so a type cannot have more threads than the sheet has codes.
        for (const slug of part.roleSlugs) {
          const available = codeCounts.get(slug) ?? 0;
          if (threads > available) {
            return {
              ok: false,
              message:
                `${type.label}: ${threads} threads need ${threads} different user codes, but the ` +
                `${type.label} sheet has ${available}${process.env.USER_CODES_MAX_PER_ROLE ? ' (limited by USER_CODES_MAX_PER_ROLE)' : ''}. ` +
                `Reduce ${type.label} threads to ${available} or fewer, or add codes to the sheet.`,
            };
          }
        }
        const typeNormalised = normaliseCsv(part.csv, baseUrlValue ? { baseUrl: baseUrlValue } : {});
        if (!typeNormalised.ok) return { ok: false, message: `${type.label}: ${typeNormalised.message}` };
        split.push({ key: type.key, label: type.label, threads, csv: typeNormalised.csv, rows: typeNormalised.apiCount });
      }

      // Fail now, not mid-run, if the base plan cannot be split.
      try {
        buildRolesPlan(
          fs.readFileSync(path.join(BAT_DIR, 'JMeter_API_Automation.jmx'), 'utf8'),
          split.map((t) => ({ label: t.label, threads: t.threads, rows: t.rows, csvPath: 'x' }))
        );
      } catch (err) {
        return { ok: false, status: 500, message: `The user-type test plan could not be built: ${err.message}` };
      }
    }
  }
  // Pagination (Merchandiser REST only): always every page, 1,000 records per page, with no
  // page or record limit (lib/pagination.js PAGINATION; see Paginate.groovy). Every other
  // app / API type runs exactly as before.
  let pagination = null;
  let paginationConfigCsv = '';
  if (supportsPagination(appNameCheck.value, apiKind)) {
    pagination = PAGINATION;
    // Per-API settings (PAGINATION / PAGE_TYPE / PAGE_PARAM / SIZE_PARAM columns of the API list).
    const perApi = buildPaginationConfig(csvText, normalised);
    if (!perApi.ok) return { ok: false, message: `${csv.fileName}: ${perApi.message}` };
    paginationConfigCsv = perApi.csv;
  }

  // The user type and user code of every thread, for the Test Running popup. It
  // applies the same thread -> code rule scripts\PrepareRequest.groovy applies.
  // An API list that cannot be told apart by user type simply has no listing.
  let threadPlan = null;

  // The user codes this run hands to JMeter. Route App REST: a fresh random
  // order every run, so the first N threads get N random distinct drivers.
  let userCodesCsv = csv.userCodesCsv;
  if (usesRandomUserCodes(appNameCheck.value, apiKind) && userCodesCsv) {
    userCodesCsv = shuffleUserCodesCsv(userCodesCsv);
    const codes = parseCsv(userCodesCsv)
      .slice(1)
      .filter(([role, code]) => role && code)
      .map(([, code]) => code);
    threadPlan = buildCodeThreadPlan({
      userType: 'Driver',
      codes,
      totalThreads: load.threads,
      apiCount: normalised.apiCount,
    });
  }

  if (supportsUserTypeThreads(appNameCheck.value, apiKind)) {
    const all = splitApiCsvByType(csvText);
    if (all.ok) {
      const codesByRole = new Map();
      if (csv.userCodesCsv) {
        for (const [role, code] of parseCsv(csv.userCodesCsv).slice(1)) {
          if (!role || !code) continue;
          if (!codesByRole.has(role)) codesByRole.set(role, []);
          codesByRole.get(role).push(code);
        }
      }
      threadPlan = buildThreadPlan({ parts: all.byType, split, totalThreads: load.threads, codesByRole });
    }
  }
  // Threads per user type, every type listed (0 = none), for the report and run record.
  const typeThreads = split
    ? Object.fromEntries(USER_TYPES.map((t) => [t.key, split.find((s) => s.key === t.key)?.threads ?? 0]))
    : null;

  return {
    ok: true,
    apiKind,
    applicationName: appNameCheck.value,
    csvName: csv.fileName,
    materialize: async () => {
      const id = randomUUID();
      const runDir = await createRunDirectory(id);
      const { testDataPath } = await writeRunCsvFiles(runDir, {
        uploadedBuffer: csv.buffer,
        normalisedCsv: normalised.csv,
      });

      // A split run: one API list per user type and the generated plan that
      // runs them side by side. Written into the bat folder (the plan's scripts
      // are found relative to its own folder) and removed when the run ends.
      let testPlanFile = '';
      if (split) {
        const groups = [];
        for (const t of split) {
          const csvPath = path.join(runDir, `test-data-${t.key}.csv`);
          await fs.promises.writeFile(csvPath, t.csv, 'utf8');
          groups.push({ label: t.label, threads: t.threads, rows: t.rows, csvPath });
        }
        const base = await fs.promises.readFile(path.join(BAT_DIR, 'JMeter_API_Automation.jmx'), 'utf8');
        testPlanFile = path.join(BAT_DIR, `run-plan-${id}.jmx`);
        await fs.promises.writeFile(testPlanFile, buildRolesPlan(base, groups), 'utf8');
      }

      // The actual login data JMeter reads for this run: only the first
      // `numUsers` configured logins, written fresh into this run's own
      // directory. Overrides usersCsvPath (which so far points at the group's
      // full persistent CSV) so LOGIN_USERS_CSV can never carry more users
      // than were selected in the UI.
      let runUsersCsvPath = usersCsvPath;
      if (apiKind !== 'SQL') {
        runUsersCsvPath = await writeRunUsersCsv(runDir, selectedUsers);
      }

      // Workbook APIs only: the role -> user codes list PrepareRequest.groovy
      // reads, written into this run's own directory like the other run files.
      let userCodesCsvPath = '';
      if (userCodesCsv) {
        userCodesCsvPath = path.join(runDir, 'user-codes.csv');
        await fs.promises.writeFile(userCodesCsvPath, userCodesCsv, 'utf8');
      }

      // Per-API pagination settings JMeter reads (PAGINATION_CONFIG_CSV), when the API list has any.
      let paginationConfigPath = '';
      if (paginationConfigCsv) {
        paginationConfigPath = path.join(runDir, 'pagination-config.csv');
        await fs.promises.writeFile(paginationConfigPath, paginationConfigCsv, 'utf8');
      }

      await writeRunConfig(runDir, {
        runId: id,
        applicationName: appNameCheck.value,
        apiType: apiKind,
        baseUrl: baseUrlValue,
        csvName: csv.fileName,
        csvSchema: normalised.schema,
        totalApis: normalised.apiCount,
        apiNames: normalised.apiNames,
        skippedRows,
        threads: load.threads,
        rampup: load.rampup,
        loops: load.loops,
        typeThreads,
        threadPlan,
        pagination,
        numUsers,
        createdAt: new Date().toISOString(),
      });

      return {
        id,
        applicationName: appNameCheck.value,
        apiType: apiKind,
        baseUrl: baseUrlValue,
        threads: load.threads,
        rampup: load.rampup,
        loops: load.loops,
        username,
        password,
        usersCsvPath: runUsersCsvPath,
        userCodesCsvPath,
        testPlanFile,
        typeThreads,
        pagination,
        paginationConfigPath,
        numUsers,
        // Display only - never used to build a path.
        csvName: csv.fileName,
        csvRows: normalised.apiCount,
        csvSchema: normalised.schema,
        skippedRows,
        testDataPath,
        batName,
        batPath,
        dbConfig: apiKind === 'SQL' ? shared.dbConfig : null,
      };
    },
  };
}

export async function POST(request) {
  const auth = await requireAuth(request);
  if (auth.response) return auth.response;

  // One test (or one batch of tests) at a time - two JMeter runs at once would
  // compete for the machine and make both sets of timings meaningless.
  const activeBatch = getActiveBatch();
  if (activeBatch) {
    return fail(
      'A test is already running. Please wait for it to finish before starting another.',
      409,
      { batch: toPublicBatch(activeBatch) }
    );
  }
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

  const parsed = readConfigurations(form);
  if (!parsed.ok) return fail(parsed.message);
  const multi = parsed.list.length > 1;
  const where = (index, message) => (multi ? `Test Configuration ${index + 1}: ${message}` : message);

  // Query Testing: the SQL Server connection. Empty fields fall back to DB_*
  // in .env; the result reaches run_sql_test.bat only as environment
  // variables (see startRun), never as arguments, and is never persisted.
  let dbConfig = null;
  if (parsed.list.some((c) => c.apiType === 'SQL')) {
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

  const shared = { dbConfig };

  // Validate every configuration before anything starts.
  const prepared = [];
  for (let i = 0; i < parsed.list.length; i += 1) {
    const result = await prepareConfig(parsed.list[i], shared);
    if (!result.ok) return fail(where(i, result.message), result.status ?? 400);
    prepared.push(result);
  }

  if (dbConfig) {
    const reachable = await checkDbReachable(dbConfig.host, dbConfig.port);
    if (!reachable.ok) return fail(reachable.message);
  }

  if (multi) {
    const batch = startBatch(
      prepared.map((p) => ({
        applicationName: p.applicationName,
        apiType: p.apiKind,
        csvName: p.csvName,
        materialize: p.materialize,
      }))
    );
    return NextResponse.json({ batch: toPublicBatch(batch) }, { status: 202 });
  }

  // A single configuration: started directly, exactly as before.
  const [only] = prepared;
  let startArgs;
  try {
    startArgs = await only.materialize();
  } catch (err) {
    return fail(`Could not prepare the test run directory: ${err.message}`, 500);
  }

  let run;
  try {
    run = await startRun(startArgs);
  } catch (err) {
    return fail(`Could not start ${startArgs.batName}: ${err.message}`, 500);
  }

  return NextResponse.json({ run: toPublicRun(run) }, { status: 202 });
}
