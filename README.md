<<<<<<< HEAD
# JMeter Performance Test — Web UI

A web UI around the existing JMeter setup. It contains no JMeter logic of its
own: it takes the run's configuration, prepares the CSV, and then runs the
existing `run_jmeter_test.bat`. Running that `.bat` by hand still works.

---

## What the client does

1. Open the app in a browser.
2. Select the **Application Name** (Merchandiser App, Route App or Sales Order
   Adjustment Web App), then the **API Type** (REST or SOAP — plus **Query
   Testing** for Sales Order Adjustment Web App).
3. The matching **CSV file** from `csv files\` is selected automatically, and
   Total APIs is counted and shown immediately. The table mapping each
   Application + API Type to its file is `APP_CSV_FILES` in `lib\appCsv.js`.
   A combination with no CSV (currently Sales Order Adjustment Web App → SOAP)
   shows a clear error and cannot be run.
4. Enter **Base URL** (only asked for when the CSV holds relative endpoints).
5. Enter **Threads**, **Ramp-up Time** and **Loops**. The REST / SOAP login is
   not entered here: it is the one saved under **Configuration** (below) for the
   selected application.
6. Click **Run Test**. The Test Run page is a single full-width form; the run's
   progress is shown in a centred dialog over it (elapsed time and the run's
   configuration). The same dialog then turns into the result - Test Completed
   with API Calls / Passed / Failed and **Open Report** (the report of that
   exact run), or Test Failed with **View Log** - and stays until you click
   **Close** (or press Esc). While a test is running the page behind it cannot
   be used; refreshing the browser brings the running dialog back.

---

## First-time setup

Requires Node.js 20.9+. On this machine that is the nvm-managed `v22.22.3`,
which both launchers put on `PATH` automatically — the system-wide Node version
is left alone.

```cmd
setup-webapp.bat      ← once (and after any code change)
start-webapp.bat      ← to run; open http://localhost:3100
```

Port 3000 is taken by Grafana here, hence 3100. `start-webapp.bat 8080` to
change it.

---

## How the selected CSV reaches JMeter

This is the part that was broken before, so it is worth stating precisely.

```
Client picks Application Name + API Type
   → server picks csv files\<file> from lib\appCsv.js (never a client path)
   → webapp\bat\test-runs\<run-id>\uploaded.csv     exact copy, untouched
   → normalised to the 20 columns the .jmx reads
   → webapp\bat\test-runs\<run-id>\test-data.csv    what JMeter actually reads
   → run_jmeter_test.bat <threads> <rampup> <loops> "<...\test-data.csv>"
   → -JCSV_FILE   → ${__P(CSV_FILE,APIs.csv)} in the CSV Data Set Config
   → -JCSV_ROW_COUNT → the Thread Group's loop count
```

Nothing is written to a shared location, so run N+1 cannot pick up run N's CSV.
`APIs.csv` in the project folder is no longer touched by the app at all — it is
only the fallback for a manual 3-argument `.bat` run.

### The two CSV layouts

The layout is detected from the header row:

| Header contains | Treated as | Handling |
| --- | --- | --- |
| `Method` + `URL` | the original 20-column export | passed through, each row padded to exactly 20 fields |
| `ENDPOINT` + `API_NAME`/`API_ID` | an API list with relative endpoints | needs a **Base URL**; each row becomes `GET <base>/<endpoint>`, with a `METHOD` column honoured if present |

Anything else is rejected with a message naming the columns it found, rather
than being silently misread.

**Why normalisation is needed:** the CSV Data Set Config in
`JMeter_API_Automation.jmx` declares a fixed list of 20 variable names and maps
columns to them *positionally* — the header row is skipped, not read. An
`API_ID,API_NAME,ENDPOINT` file therefore lands as `Method,URL,Protocol`, and
every request is built from nonsense. Normalising before the run fixes this
without changing how the test plan reads its CSV.

---

## Changes made to the existing JMeter setup

All originals are in `..\_pre-webapp-backup\`.

### `JMeter_API_Automation.jmx` — one line

```diff
- <stringProp name="filename">APIs.csv</stringProp>
+ <stringProp name="filename">${__P(CSV_FILE,APIs.csv)}</stringProp>
```

The default keeps the 3-argument `.bat` form behaving as before.

### `run_jmeter_test.bat`

- Accepts an **optional 4th argument**, the CSV to run. Omitted → `APIs.csv`,
  exactly as before.
- **Counts that CSV's rows and passes `-JCSV_ROW_COUNT`.** This is the fix for
  the "23 APIs but only 14 in the report" bug: the Thread Group's loop count is
  `LOOPS × __P(CSV_ROW_COUNT,14)`, and nothing ever passed that property, so
  every run did exactly 14 iterations and ignored every API past the 14th.
- Reads `APP_NAME` / `API_TYPE` from the environment, the same way it already
  reads credentials.
- Copies the CSV it used into its own output folder as `test-data.csv`.
- Writes `report-run-info.js` via `scripts\Write-ReportRunInfo.ps1` instead of
  a series of `echo … >>` lines — see below.

### `scripts\Write-ReportRunInfo.ps1` — new

Generates the report's per-run metadata. It replaces this line:

```bat
echo     rampUpSeconds: %RAMPUP%>> "%RUN_INFO_FILE%"
```

which was **silently broken for any single-digit ramp-up**: cmd reads the `1` in
`1>>` as a stream handle rather than as text, so the value vanished and the file
became invalid JavaScript — which blanked Total APIs, Threads *and* Ramp-up in
the report. The lines above it survived only because they end in a comma. The
helper also escapes values, so an application name containing `& < > | "` is
safe.

### `report-template\`

- `report-config.js` no longer hardcodes `"Sales Order Adjustment web app"`. It
  is now only a generic fallback; per-run values take precedence.
- `dashboard-commons.js.fmkr` prefers the per-run values and appends **Loops**,
  **CSV File** and **Test Date/Time** rows to the info table. Values are set
  with `.text()`, never `.html()`, so nothing typed in the UI can inject markup.
- The panel is retitled **Test Configuration**, on all five report pages.
- The "Apache JMeter Dashboard" title is removed from the top-left of every page.
- **Statistics** gains **S.No**, **Method** and **Status Code** columns, and its
  **Total** row is highlighted. **Errors** gains a **Status Code** column. The
  dashboard's own data has no method or status code, so after the report is
  generated each `.bat` runs `scripts\Write-ReportSampleInfo.ps1`, which reads
  them from that run's `results.jtl` into
  `dashboard\content\js\report-sample-info.js`. If that step fails the report
  still opens, and those columns show `-`.
- **Statistics → Response**: each API row has a ▼ arrow; clicking it opens the
  response body JMeter received for that API in a scrollable box beneath the
  row, and clicking again (▲) closes it. JSON is re-indented without changing
  any value; XML, text and everything else is shown exactly as received, and
  is always inserted as text so a response can never alter the report. An API
  that returned different status codes shows the first response for each.
  - `results.jtl` did not store response bodies, so `RecordResult.groovy`,
    `RecordSoapResult.groovy` and `ValidateSqlResult.groovy` now record the
    **first response per API + status code** in a `REC_RESPONSE` column
    (added to `-Jsample_variables` in the three `.bat` files). That keeps a
    load test's `.jtl` small: a body is stored once, not once per sample. A
    body over 5,000,000 characters is cut, with a note saying so.
  - `Write-ReportSampleInfo.ps1` writes one file per API to
    `dashboard\content\responses\r<N>.js`, loaded only when its arrow is
    clicked, so the report page itself stays light.
  - For Query Testing the response is the result set (or the JDBC error) JMeter
    got; for an API with no HTTP response it is JMeter's own error text.
  - Reports of runs made before this change have no bodies and say so.
  - The template is read as Windows-1252, so `dashboard.js.fmkr` must stay
    ASCII-only (the arrows are built with `String.fromCharCode`).

The standard JMeter dashboard — statistics, APDEX, errors, charts, graphs, the
Over Time / Throughput / Response Times pages — is untouched.

### Behaviour change worth knowing

The 3-argument form now runs `LOOPS × (actual CSV rows)` iterations instead of
`LOOPS × 14`. With the original 29-row `APIs.csv` that means a full pass over
every row rather than the first 14. That is the bug fix, but it does mean a
manual run does more work than it used to.

---

## What ends up where

```
webapp\bat\test-runs\<run-id>\          uploaded.csv, test-data.csv, run-config.json
webapp\.runs\<run-id>.{json,log,csv}   run record and full console output
webapp\bat\output\<yyyy-MM-dd_HHmmss>\  results.jtl, jmeter.log, test-data.csv, dashboard\
```

Each `.bat` run still creates its own timestamped output folder, so reports
never overwrite each other and an old report can always be reopened.

### Configuration (saved logins)

The **Configuration** item in the sidebar holds the login REST and SOAP runs
authenticate with - it is not typed on the Test Run page. There are two
separate logins:

| Login | Used by |
| --- | --- |
| Merchandiser App / Route App | Merchandiser App and Route App (they share it) |
| Sales Order Adjustment Web App | Sales Order Adjustment Web App |

Enter the username and password and click **Save**; from then on every run for
those applications uses it automatically, after refreshing the page and after
restarting the app. Leave the password empty to keep the saved one when
changing only the username. The Test Run page shows which login (username only)
the selected application will use, and refuses to start a REST / SOAP run if
none is saved. Query Testing does not use these - it uses its Database
Configuration.

Where and how it is stored:

- `webapp\.credentials.json` (git-ignored). The username is plain text; the
  **password is encrypted with Windows DPAPI for the current Windows user**, so
  a copy of the file - in a backup, a chat, a repository - reveals nothing, and
  it cannot be decrypted on another machine or by another Windows account. If
  the app is later run as a different Windows user the run says so, and the
  login just needs saving again.
- The password is never sent back to the browser (the API returns only the
  username and whether a password is saved) and travels to PowerShell as
  base64 on stdin, never on a command line.
- The saved login reaches JMeter exactly as a typed one did before:
  `LOGIN_USERNAME` / `LOGIN_PASSWORD` in the run's environment, read by
  `scripts\ApplyAuthHeader.groovy` and `PrepareRequest.groovy`. The
  authentication logic itself is unchanged.
- The app has no login of its own, so anyone who can reach its port can change
  the saved logins, as they can already start a test; keep it on a trusted
  network (see Security).

#### Multiple users

Each login above holds up to **two users** (User 1 is required, User 2 is
optional). A run gives every JMeter thread its own user: thread 1 runs as
user 1, thread 2 as user 2, and with more threads than users it wraps round. A
run with **Threads = 1** therefore only ever uses user 1, exactly as before.
Merchandiser App and Route App use the same two users; Sales Order Adjustment
Web App uses its own.

Clicking **Save** also writes the users to a CSV that JMeter reads, and every
run rewrites it again from the saved logins, so it can never be stale. Nothing
needs to be edited by hand:

| Group | File (in `webapp\credentials\`) |
| --- | --- |
| Merchandiser App / Route App | `merchandiser_route_users.csv` |
| Sales Order Adjustment Web App | `sales_order_adjustment_users.csv` |

```csv
LOGIN_USERNAME,LOGIN_PASSWORD
"user1","password1"
"user2","password2"
```

- The columns use the names the JMeter scripts already use. Values are always
  quoted, so a password containing a comma or a quote is safe.
- **These files hold the passwords in plain text** - JMeter cannot read the
  DPAPI-encrypted store. The folder is git-ignored; keep it that way, and off
  shared drives and backups. The encrypted `.credentials.json` stays the source
  of truth.
- The run passes the file's path to JMeter as the `LOGIN_USERS_CSV`
  environment variable (a path, never a credential).
  `scripts\AssignLoginUser.groovy`, a pre-processor added to
  `JMeter_API_Automation.jmx` and `JMeter_SOAP_Automation.jmx` (it produces no
  sample), reads the file once per thread and sets that thread's
  `LOGIN_USERNAME` / `LOGIN_PASSWORD` JMeter variables. `ApplyAuthHeader.groovy`
  and `PrepareRequest.groovy` prefer those over the environment variables of the
  same name. Without `LOGIN_USERS_CSV` (a `.bat` started by hand) or with a
  missing file, they fall back to the environment as before.
- Only the row number is logged (`thread 2 uses login 2 of 2`), never a
  username or password, and neither reaches the JTL or the report.
### Run History

The **History** item in the sidebar lists every run, newest first: date, time,
application, API type, threads, loops, status and a **View Report** link
(**View Log** for a run with no report). Click a row for the full details -
run ID, CSV, ramp-up, total APIs/queries, result counts, duration, and the
report and log locations. It can be filtered by application name, API type,
status and date.

There is no separate history database and nothing to save by hand: History
reads the `webapp\.runs\<run-id>.json` record that every run writes when it
starts and again when it finishes (status, configuration, report folder, log),
so it survives page refreshes, browser restarts and app restarts, and each run
has its own file. The start time shown is when the test was launched.

- **Failed runs** are listed as Failed, with their log and no report link.
- **A run cut short** (the app was stopped while it was running) is listed as
  Failed with an explanation, instead of staying "Running" forever.
- **A deleted report folder** shows *Report file is no longer available.* -
  the record and log remain. Deleting `.runs\` empties the history.
- `GET /api/history` returns the list (no credentials, no log text).

---

## Error handling

| Situation | What the client sees |
| --- | --- |
| Missing Application Name / API Type | *Please enter the Application Name.* / *…the API Type.* |
| No CSV for the selected Application + API Type | *No SOAP API CSV file is available for …* / *The CSV file "…" … was not found in the "csv files" folder.* |
| Unrecognised CSV columns | A message naming the columns found |
| Relative-endpoint CSV with no Base URL | *Please enter a valid Base URL.* |
| Base URL not http/https, or carrying a query | A specific message |
| Threads / Ramp-up / Loops missing, zero, or non-numeric | *Please enter a valid number of threads.* etc. |
| A test is already running | *A test is already running…* (the button is disabled anyway) |
| JMeter exits non-zero | *JMeter test execution failed…* plus output tail and a log download |
| `.bat` succeeds but no `dashboard\index.html` | *…the HTML report was not generated…* — no broken link is offered |

---

## Security

- Only ever executes one fixed command: `run_jmeter_test.bat`. Nothing the
  client types reaches the command name.
- Threads / ramp-up / loops must match `^[1-9][0-9]*$` and are capped
  (10000 / 86400 / 100000). `1 & calc.exe` is rejected as an invalid number.
- Spawned with `shell: false`, so no shell metacharacter can be interpreted.
- The CSV path passed as argument 4 is generated by the app, never supplied by
  the client. The CSV itself is chosen from a fixed server-side table; nothing
  the client sends is used to build its path.
- Application Name / API Type reach the `.bat` as environment variables, not as
  command-line arguments, and are JSON-escaped into the report.
- The report route serves only files inside that run's `dashboard` folder.
- `stdin` is closed for the spawned process, so the `.bat` can never block the
  server on a console prompt.
- The REST / SOAP login is saved once under Configuration (see below), stored
  with its password **encrypted by Windows DPAPI**, and never returned by any
  API, shown in the UI, or written to a log, report, run record or History.
  It is decrypted only when a run starts, to pass to JMeter as `LOGIN_PASSWORD`.

The app has no login of its own — anyone who can reach the port can start a
test. Keep it on a trusted network, or put an authenticating proxy in front.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | Port the UI listens on |
| `ENVIRONMENT` | `LOCAL` | `LOCAL` or `DEPLOYMENT` - selects which block below both the webapp and `bat\run_jmeter_test.bat` / `bat\run_soap_test.bat` use |
| `LOCAL_PROJECT_DIR` | `webapp\bat` | Folder holding `JMeter_API_Automation.jmx`, `JMeter_SOAP_Automation.jmx`, `sql_test.jmx`, `SQL_Queries.csv`, `scripts\`, `report-template\` and `output\`, when `ENVIRONMENT=LOCAL`. Leave unset to use the copy inside the webapp |
| `LOCAL_JMETER_BAT` | *(none - must be set)* | Path to the local JMeter install's `bin\jmeter.bat` |
| `DEPLOY_PROJECT_DIR` | `webapp\bat` | Same as `LOCAL_PROJECT_DIR`, used when `ENVIRONMENT=DEPLOYMENT` |
| `DEPLOY_JMETER_BAT` | *(none - must be set)* | Same as `LOCAL_JMETER_BAT`, used when `ENVIRONMENT=DEPLOYMENT` |
| `JMETER_TEST_RUNS_DIR` | `<selected PROJECT_DIR>\test-runs` | Per-run CSV/config storage - only set this to use a different location than the selected environment's project folder |
| `JMETER_RUN_TIMEOUT_MS` | `21600000` (6 h) | Hard limit on a single run |
| `DB_HOST` | *(none)* | Query Testing: SQL Server host, or `HOST\INSTANCE` |
| `DB_PORT` | `1433` | Query Testing: SQL Server TCP port (required for a named instance) |
| `DB_NAME` | *(none)* | Query Testing: database name |
| `DB_USER` / `DB_PASSWORD` | *(none)* | Query Testing: SQL login. Never shown in the UI, logs, JTL or report |

A SOAP CSV's `SOAP_ENDPOINT` may be a full URL or the name of the Sage X3 pool
(e.g. `Pilot`). A pool name that matches `SOAP_POOL_ALIAS` resolves to
`SOAP_HOST` + the service path, the same URL the URL-style CSVs spell out; any
other name is still rejected.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOAP_HOST` | *(none)* | Base URL of the Sage X3 server a pool name resolves to, e.g. `https://sage.lewisbakeries.com` |
| `SOAP_POOL_ALIAS` | *(none)* | The pool name a `SOAP_ENDPOINT` cell may use, e.g. `PILOT` (case-insensitive) |
| `SOAP_SERVICE_PATH` | `/soap-generic/syracuse/collaboration/syracuse/CAdxWebServiceXmlCC` | Path of the SOAP web service, appended to `SOAP_HOST` |

Every SOAP run authenticates with the **Merchandiser App / Route App** login
under Configuration, whichever application it is for: the Sage SOAP gateway
accepts those users and answers `401 Unauthorized` to the Sales Order Adjustment
web-app users. REST runs keep each application's own login.

### Query Testing

Sales Order Adjustment Web App → **Query Testing** runs `csv files\Sales Order
Queries.csv` (`TestName,Query,Parameters,ExpectedRows,Enabled,Description`)
through `bat\run_sql_test.bat` → `sql_test.jmx` (JMeter JDBC, SQL Server
driver from JMeter's `lib\`). The form's **Database Configuration** is
pre-filled from the `DB_*` values above; anything typed there is used for that
run only. Before JMeter starts, the app checks the server is reachable and
reports an unknown host or closed port straight away.

- `Query` uses JDBC `?` placeholders; `Parameters` is `Name=Value|Name=Value`,
  bound in order (as VARCHAR). No credentials belong in this CSV.
- `Enabled=false` rows are recorded as SKIPPED, not executed.
- `ExpectedRows` empty = pass whenever the query runs without a SQL error;
  a number = the query must return exactly that many rows.
- A failing query (SQL error or wrong row count) is recorded as FAIL and the
  run continues with the next row.
- `scripts\PrepareSqlRequest.groovy`, `ValidateSqlResult.groovy` and
  `SkipSqlSampler.groovy` implement the above.

`run_jmeter_test.bat` / `run_soap_test.bat` / `run_sql_test.bat` live in
`webapp\bat\` and are always found there. Everything they depend on
(`scripts\`, `report-template\`, the `.jmx` files, `SQL_Queries.csv`,
`output\`, `test-runs\`) lives under `PROJECT_DIR`, which defaults to that same
`webapp\bat\` folder - so the project is self-contained and moving the `webapp`
folder as a whole never breaks it. The `.jmx`'s own JSR223 samplers reference
their Groovy scripts as a plain relative `scripts/...` path, resolved against
JMeter's working directory, so `scripts\` must physically sit beside the
`.jmx` files for that to work.

Because `.bat` files don't read `.env` on their own, `run_jmeter_test.bat` /
`run_soap_test.bat` parse `webapp\.env` themselves at startup (via a small
PowerShell one-liner - already a hard dependency of this script) and load
every `KEY=VALUE` line into their own process environment, without overriding
a variable the caller already set.

---

## Deploying to a client machine

Copy the `webapp` folder (excluding `node_modules\`, `.next\`, `.runs\`,
`bat\output\`, `bat\test-runs\`), then on the target machine install Node.js
20.9+ and JMeter, set `DEPLOY_JMETER_BAT` in `.env` to that machine's
`bin\jmeter.bat` (`DEPLOY_PROJECT_DIR` can stay unset - it defaults to
`webapp\bat\`), set `ENVIRONMENT=DEPLOYMENT`, and run
`setup-webapp.bat` followed by `start-webapp.bat`. No `.bat`/`.jmx`/code edits
are needed - only `.env`.
=======
# JMeter-UI
>>>>>>> 43a769b93b9f82e06e30cdfd096b135a64d8d251
