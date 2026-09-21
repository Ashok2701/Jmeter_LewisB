# JMeter Performance Test — Web UI

A web UI around the existing JMeter setup. It contains no JMeter logic of its
own: it takes the run's configuration, prepares the CSV, and then runs the
existing `run_jmeter_test.bat`. Running that `.bat` by hand still works.

---

## What the client does

1. Open the app in a browser.
2. Enter **Application Name** and **API Type**.
3. Upload the **CSV file** — Total APIs is counted and shown immediately.
4. Enter **Base URL** (only asked for when the CSV holds relative endpoints).
5. Enter **Threads**, **Ramp-up Time**, **Loops**, and the login credentials.
6. Click **Generate HTML Report**, wait, then click **Open HTML Report**.

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

## How the uploaded CSV reaches JMeter

This is the part that was broken before, so it is worth stating precisely.

```
Client picks CSV
   → uploaded to the server (multipart POST, never a local file path)
   → webapp\test-runs\<run-id>\uploaded.csv     exactly as sent, untouched
   → normalised to the 20 columns the .jmx reads
   → webapp\test-runs\<run-id>\test-data.csv    what JMeter actually reads
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
webapp\test-runs\<run-id>\      uploaded.csv, test-data.csv, run-config.json
webapp\.runs\<run-id>.{json,log,csv}   run record and full console output
output\<yyyy-MM-dd_HHmmss>\     results.jtl, jmeter.log, test-data.csv, dashboard\
```

Each `.bat` run still creates its own timestamped output folder, so reports
never overwrite each other and an old report can always be reopened.

---

## Error handling

| Situation | What the client sees |
| --- | --- |
| Missing Application Name / API Type | *Please enter the Application Name.* / *…the API Type.* |
| No CSV | *Please upload the CSV file.* |
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
  the client. The uploaded filename is never used to build a path.
- Application Name / API Type reach the `.bat` as environment variables, not as
  command-line arguments, and are JSON-escaped into the report.
- The report route serves only files inside that run's `dashboard` folder.
- `stdin` is closed for the spawned process, so the `.bat` can never block the
  server on a console prompt.
- Credentials are held only for the run, never written to disk or any log.

The app has no login of its own — anyone who can reach the port can start a
test. Keep it on a trusted network, or put an authenticating proxy in front.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | Port the UI listens on |
| `JMETER_PROJECT_DIR` | the parent folder | Where `run_jmeter_test.bat` lives |
| `JMETER_TEST_RUNS_DIR` | `webapp\test-runs` | Per-run CSV/config storage |
| `JMETER_RUN_TIMEOUT_MS` | `21600000` (6 h) | Hard limit on a single run |

---

## Deploying to a client machine

Copy the project folder (excluding `node_modules\`, `.next\`, `.runs\`,
`test-runs\`), then on the target machine install Node.js 20.9+ and JMeter,
point `PROJECT_DIR` and `JMETER_BAT` in `run_jmeter_test.bat` at their new
locations, and run `setup-webapp.bat` followed by `start-webapp.bat`.
