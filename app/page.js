'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3000;

function formatElapsed(startedAt, finishedAt) {
  console.log("testing");
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Display-only helper - no effect on what is uploaded or how it is processed.
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [applicationName, setApplicationName] = useState('');
  const [apiType, setApiType] = useState('REST');
  const [baseUrl, setBaseUrl] = useState('');
  const [threads, setThreads] = useState('');
  const [rampup, setRampup] = useState('');
  const [loops, setLoops] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [csvInfo, setCsvInfo] = useState(null);
  const [csvError, setCsvError] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [runAnyway, setRunAnyway] = useState(false);

  const [error, setError] = useState(null);
  const [run, setRun] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [, forceTick] = useState(0);
  const fileRef = useRef(null);

  const isRunning = submitting || run?.status === 'running';

  // Recover the in-flight run if the client refreshes the page mid-test.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/run')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.run) setRun(data.run);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (run?.status !== 'running') return undefined;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/run/${run.id}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.run) setRun(data.run);
      } catch {
        // Transient fetch failure - the next poll retries.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [run?.status, run?.id]);

  useEffect(() => {
    if (run?.status !== 'running') return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [run?.status]);

  // Reads the chosen CSV on the server so Total APIs is the real count that
  // JMeter will run - produced by the same normalisation the test itself uses.
  // Which schema that normalisation applies is `currentApiType` (REST/SOAP),
  // never guessed from the CSV's own shape - a CSV uploaded for the wrong
  // selection is rejected with a clear reason instead of being misread.
  const inspectCsv = useCallback(async (file, currentApiType, currentBaseUrl) => {
    if (!file) {
      setCsvInfo(null);
      setCsvError(null);
      return;
    }
    setInspecting(true);
    setCsvError(null);
    try {
      const body = new FormData();
      body.append('csv', file);
      body.append('apiType', currentApiType);
      if (currentBaseUrl) body.append('baseUrl', currentBaseUrl);
      const res = await fetch('/api/csv-preview', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) {
        setCsvInfo(null);
        setCsvError(data.error || 'The CSV file could not be read.');
        return;
      }
      // fileName/fileSize are read straight off the browser File object for
      // display only - they play no part in parsing or the API count.
      setCsvInfo({ ...data, fileName: file.name, fileSize: file.size });
    } catch (err) {
      setCsvInfo(null);
      setCsvError(`The CSV file could not be read: ${err.message}`);
    } finally {
      setInspecting(false);
    }
  }, []);

  // Shared entry point for both the native file picker and drag & drop -
  // both end up selecting a File object and running exactly the same check.
  const applyFile = useCallback(
    (file) => {
      setError(null);
      setCheck(null);
      inspectCsv(file, apiType, baseUrl);
    },
    [inspectCsv, apiType, baseUrl]
  );

  const handleFileChange = useCallback(
    (event) => {
      applyFile(event.target.files?.[0]);
    },
    [applyFile]
  );

  // Drag & drop is purely an alternate way to populate the same hidden file
  // input that the rest of the app already reads via fileRef.current.files -
  // runCheck() and handleSubmit() are untouched.
  const handleDragOver = useCallback(
    (event) => {
      event.preventDefault();
      if (!isRunning) setDragActive(true);
    },
    [isRunning]
  );

  const handleDragLeave = useCallback((event) => {
    event.preventDefault();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragActive(false);
      if (isRunning) return;
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      if (fileRef.current) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          fileRef.current.files = dt.files;
        } catch {
          // Older browsers without DataTransfer construction still get the
          // preview below; only the native input's file list is skipped.
        }
      }
      applyFile(file);
    },
    [applyFile, isRunning]
  );

  const handleDropzoneKeyDown = useCallback(
    (event) => {
      if (isRunning) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileRef.current?.click();
      }
    },
    [isRunning]
  );

  // Switching API Type changes which schema the already-selected file (if any)
  // is interpreted against, so it's re-inspected from scratch; a Base URL
  // typed for a REST CSV has no meaning for SOAP and is cleared too.
  const handleApiTypeChange = useCallback(
    (event) => {
      const nextApiType = event.target.value;
      setApiType(nextApiType);
      setBaseUrl('');
      setCheck(null);
      setRunAnyway(false);
      setError(null);
      inspectCsv(fileRef.current?.files?.[0], nextApiType, '');
    },
    [inspectCsv]
  );

  // Sends one request to the first endpoint, so a wrong Base URL is caught here
  // rather than after a full run has produced a report of nothing but 404s.
  // When the CSV supplies its own BASE_URL column, `baseUrl` (the typed field)
  // is empty and the server resolves the same value from the CSV itself - so
  // this still checks the real target without asking the client to retype it.
  // REST-only: a SOAP CSV row's SOAP_ENDPOINT is always complete on its own,
  // and a plain GET against a SOAP endpoint would not tell the client
  // anything useful anyway.
  const runCheck = useCallback(async () => {
    if (apiType !== 'REST') return null;
    const file = fileRef.current?.files?.[0];
    const typedBaseUrl = baseUrl.trim();
    if (!file || (!typedBaseUrl && !csvInfo?.baseUrlFromCsv)) return null;

    setChecking(true);
    setCheck(null);
    try {
      const body = new FormData();
      body.append('csv', file);
      if (typedBaseUrl) body.append('baseUrl', typedBaseUrl);
      if (username.trim()) body.append('username', username.trim());
      if (password) body.append('password', password);
      const res = await fetch('/api/check-base-url', { method: 'POST', body });
      const data = await res.json();
      const result = res.ok ? data : { ok: false, error: data.error };
      setCheck(result);
      return result;
    } catch (err) {
      const result = { ok: false, error: err.message };
      setCheck(result);
      return result;
    } finally {
      setChecking(false);
    }
  }, [apiType, baseUrl, username, password, csvInfo]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setError(null);

      const file = fileRef.current?.files?.[0];
      if (!applicationName.trim()) {
        setError('Please enter the Application Name.');
        return;
      }
      if (!file) {
        setError('Please upload the CSV file.');
        return;
      }
      if (apiType === 'REST' && csvInfo?.needsBaseUrl && !baseUrl.trim()) {
        setError('Please enter a valid Base URL.');
        return;
      }
      if (!/^[1-9][0-9]*$/.test(threads.trim())) {
        setError('Please enter a valid number of threads.');
        return;
      }
      if (!/^[1-9][0-9]*$/.test(rampup.trim())) {
        setError('Please enter a valid ramp-up time.');
        return;
      }
      if (!/^[1-9][0-9]*$/.test(loops.trim())) {
        setError('Please enter a valid number of loops.');
        return;
      }
      // Same login credentials for both API Types - a SOAP gateway sits
      // behind the same login as the REST API.
      if (!username.trim()) {
        setError('Please enter the login username.');
        return;
      }
      if (!password) {
        setError('Please enter the login password.');
        return;
      }

      // Pre-flight: one request before committing to a full run - using
      // whichever Base URL applies, typed or read straight from the CSV.
      // Skipped only when the client has explicitly chosen to run regardless.
      // REST only - see runCheck().
      if (apiType === 'REST' && (csvInfo?.needsBaseUrl || csvInfo?.baseUrlFromCsv) && !runAnyway) {
        const result = await runCheck();
        if (result && !result.ok) {
          setError(
            result.status
              ? `The Base URL check returned ${result.status} ${result.statusText}. The test was not started — see below, or tick "Run anyway".`
              : `The Base URL could not be reached. The test was not started — see below, or tick "Run anyway".`
          );
          return;
        }
      }

      const body = new FormData();
      body.append('csv', file);
      body.append('applicationName', applicationName.trim());
      body.append('apiType', apiType.trim());
      body.append('baseUrl', baseUrl.trim());
      body.append('threads', threads.trim());
      body.append('rampup', rampup.trim());
      body.append('loops', loops.trim());
      body.append('username', username.trim());
      body.append('password', password);

      setSubmitting(true);
      setRun(null);
      try {
        const res = await fetch('/api/run', { method: 'POST', body });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'The test could not be started.');
          if (data.run) setRun(data.run);
          return;
        }
        setRun(data.run);
      } catch (err) {
        setError(`The test could not be started: ${err.message}`);
      } finally {
        setSubmitting(false);
      }
    },
    [
      applicationName,
      apiType,
      baseUrl,
      threads,
      rampup,
      loops,
      username,
      password,
      csvInfo,
      runAnyway,
      runCheck,
    ]
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">⚡</span>
          <div className="brand-text">
            <span className="brand-name">JMeter Test Center</span>
            <span className="brand-tag">Performance Testing Platform</span>
          </div>
        </div>
        <div className={`header-status${isRunning ? ' busy' : ''}`}>
          <span className="status-dot" />
          {isRunning ? 'Test Running' : 'Engine Ready'}
        </div>
      </header>

      <div className="app-body">
        <nav className="sidebar" aria-label="Primary">
          <div className="sidebar-item active" title="New Test">
            <span className="sidebar-icon" aria-hidden="true">▶</span>
            <span className="sidebar-label">New Test</span>
          </div>
        </nav>

        <main className="main-content">
          <div className="content-inner">
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            <div className="layout-grid">
              <div className="config-col">
                <form onSubmit={handleSubmit} noValidate>
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Test Configuration</h2>
                      <p className="panel-subtitle">Configure your performance test</p>
                    </div>

                    <div className="field-grid-2">
                      <div className="field">
                        <label htmlFor="applicationName">Application Name</label>
                        <input
                          id="applicationName"
                          type="text"
                          placeholder="Lewis Bakeries"
                          value={applicationName}
                          onChange={(e) => setApplicationName(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>

                      <div className="field">
                        <label htmlFor="apiType">API Type</label>
                        <select
                          id="apiType"
                          value={apiType}
                          onChange={handleApiTypeChange}
                          disabled={isRunning}
                        >
                          <option value="REST">REST APIs</option>
                          <option value="SOAP">SOAP APIs</option>
                        </select>
                      </div>
                    </div>

                    <div className="field">
                      <span className="label-static">CSV File</span>
                      <div
                        className={[
                          'dropzone',
                          dragActive ? 'drag-active' : '',
                          csvInfo && !inspecting ? 'has-file' : '',
                          csvError ? 'has-error' : '',
                          isRunning ? 'disabled' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        onClick={() => !isRunning && fileRef.current?.click()}
                        onKeyDown={handleDropzoneKeyDown}
                        role="button"
                        tabIndex={isRunning ? -1 : 0}
                        aria-disabled={isRunning}
                      >
                        <input
                          id="csv"
                          name="csv"
                          type="file"
                          accept=".csv,text/csv"
                          ref={fileRef}
                          onChange={handleFileChange}
                          disabled={isRunning}
                          className="dropzone-input"
                          tabIndex={-1}
                        />

                        {inspecting && (
                          <div className="dropzone-loading">
                            <span className="spinner" />
                            Reading CSV…
                          </div>
                        )}

                        {!inspecting && csvInfo && (
                          <div className="dropzone-file">
                            <span className="file-icon" aria-hidden="true">📄</span>
                            <div className="file-meta">
                              <strong>{csvInfo.fileName}</strong>
                              <span>
                                {formatBytes(csvInfo.fileSize)} · File ready
                              </span>
                            </div>
                            <span className="file-check" aria-hidden="true">✓</span>
                          </div>
                        )}

                        {!inspecting && !csvInfo && (
                          <>
                            <div className="dropzone-icon" aria-hidden="true">📄</div>
                            <div className="dropzone-title">Upload API CSV</div>
                            <div className="dropzone-sub">
                              Drag &amp; drop your CSV here, or click to browse
                            </div>
                          </>
                        )}
                      </div>

                      {csvError && <span className="hint hint-error">{csvError}</span>}
                      {!csvError && !csvInfo && (
                        <span className="hint">
                          {apiType === 'SOAP'
                            ? 'Needs at least SERVICE_NAME/PUBLIC_NAME, SOAP_ENDPOINT and REQUEST_XML columns.'
                            : 'A Method/URL export, or an API_NAME/ENDPOINT list.'}
                        </span>
                      )}
                      {!csvError && csvInfo && (
                        <span className="hint">
                          {csvInfo.schema === 'soap'
                            ? 'SOAP API list format (PUBLIC_NAME / SOAP_ENDPOINT / REQUEST_XML).'
                            : csvInfo.schema === 'endpoint'
                              ? 'API list format (API_NAME / ENDPOINT).'
                              : 'Full request export format (Method / URL).'}
                          {csvInfo.apiNames?.length > 0 && (
                            <> First APIs: {csvInfo.apiNames.slice(0, 4).join(', ')}…</>
                          )}
                        </span>
                      )}
                    </div>
                  </section>

                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Target &amp; Coverage</h2>
                      <p className="panel-subtitle">Where the test points, and how much it covers</p>
                    </div>

                    <div className="target-grid">
                      <div className="target-main">
                        {/* No input field when the CSV itself carries a BASE_URL column -
                            that value is read straight from the file and used as-is, for
                            the connection check below, the run, and the report. The field
                            only appears when the CSV lists relative endpoints with no
                            Base URL of its own, and something has to supply one. Base URL
                            is a REST-only concept - a SOAP row's SOAP_ENDPOINT is always
                            complete on its own. */}
                        {apiType === 'REST' && csvInfo?.baseUrlFromCsv && (
                          <div className="field">
                            <span className="label-static">Base URL</span>
                            <div className="readout readout-filled">
                              <strong className="url-value">{csvInfo.baseUrlFromCsv}</strong>
                              <span className="readout-note">✓ Detected from {csvInfo.fileName}</span>
                            </div>

                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={runCheck}
                              disabled={isRunning || checking}
                            >
                              {checking ? 'Checking…' : 'Check Base URL'}
                            </button>

                            {check && (
                              <div className={`check-result ${check.ok ? 'ok' : 'bad'}`}>
                                <div className="check-line">
                                  {check.ok
                                    ? `✓ ${check.status} ${check.statusText} — this Base URL works`
                                    : check.status
                                      ? `✗ ${check.status} ${check.statusText}`
                                      : `✗ ${check.error}`}
                                </div>
                                {check.url && <code className="check-url">{check.url}</code>}
                                {check.hint && <div className="check-hint">{check.hint}</div>}
                              </div>
                            )}
                          </div>
                        )}

                        {apiType === 'REST' && csvInfo?.needsBaseUrl && (
                          <div className="field">
                            <label htmlFor="baseUrl">Base URL</label>
                            <input
                              id="baseUrl"
                              type="text"
                              placeholder="https://your-host:8087/api1/x3/erp/FOLDER"
                              value={baseUrl}
                              onChange={(e) => setBaseUrl(e.target.value)}
                              onBlur={() => inspectCsv(fileRef.current?.files?.[0], apiType, baseUrl)}
                              disabled={isRunning}
                            />
                            <span className="hint">
                              This CSV lists relative endpoints, so each one is appended to
                              this address. Include the full API path prefix, not just the
                              host — a missing prefix is what produces 404 on every call.
                            </span>

                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={runCheck}
                              disabled={isRunning || checking || !baseUrl.trim()}
                            >
                              {checking ? 'Checking…' : 'Check Base URL'}
                            </button>

                            {check && (
                              <div className={`check-result ${check.ok ? 'ok' : 'bad'}`}>
                                <div className="check-line">
                                  {check.ok
                                    ? `✓ ${check.status} ${check.statusText} — this Base URL works`
                                    : check.status
                                      ? `✗ ${check.status} ${check.statusText}`
                                      : `✗ ${check.error}`}
                                </div>
                                {check.url && <code className="check-url">{check.url}</code>}
                                {check.hint && <div className="check-hint">{check.hint}</div>}
                              </div>
                            )}
                          </div>
                        )}

                        {apiType !== 'REST' && (
                          <div className="field">
                            <span className="label-static">Base URL</span>
                            <p className="hint">
                              Not applicable for SOAP APIs — each row&apos;s SOAP_ENDPOINT
                              column is used directly.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Rendered as a read-out rather than an <input>: this value is always
                          counted from the uploaded CSV, and an input box invites the client
                          to type a number that would then be ignored. */}
                      <div className="stat-tile" aria-live="polite">
                        <span className="stat-label">Total APIs</span>
                        {inspecting ? (
                          <span className="stat-loading">
                            <span className="spinner" />
                            Counting…
                          </span>
                        ) : csvInfo ? (
                          <>
                            <span className="stat-value">{csvInfo.totalApis}</span>
                            <span className="stat-note">from {csvInfo.fileName}</span>
                          </>
                        ) : (
                          <span className="stat-empty">Upload a CSV to count APIs</span>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Load Test Configuration</h2>
                      <p className="panel-subtitle">Simulate concurrent user load</p>
                    </div>

                    <div className="row load-row">
                      <div className="field">
                        <label htmlFor="threads">Threads</label>
                        <input
                          id="threads"
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          placeholder="10"
                          value={threads}
                          onChange={(e) => setThreads(e.target.value)}
                          disabled={isRunning}
                        />
                        <span className="field-desc">Number of concurrent users</span>
                      </div>

                      <div className="field">
                        <label htmlFor="rampup">Ramp-up Time (s)</label>
                        <input
                          id="rampup"
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          placeholder="10"
                          value={rampup}
                          onChange={(e) => setRampup(e.target.value)}
                          disabled={isRunning}
                        />
                        <span className="field-desc">Time to start all users</span>
                      </div>

                      <div className="field">
                        <label htmlFor="loops">Loops</label>
                        <input
                          id="loops"
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          placeholder="2"
                          value={loops}
                          onChange={(e) => setLoops(e.target.value)}
                          disabled={isRunning}
                        />
                        <span className="field-desc">Iterations per user</span>
                      </div>
                    </div>
                  </section>

                  {/* Same login credentials for both API Types - a SOAP gateway
                      (e.g. Sage X3's Web Service) sits behind the same login as the
                      REST API, and scripts\ApplyAuthHeader.groovy applies them to
                      every SOAP call exactly as it already does for REST. */}
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Authentication</h2>
                      <p className="panel-subtitle">
                        Used only for this test run. Never saved to disk and never written to any log.
                      </p>
                    </div>

                    <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div className="field">
                        <label htmlFor="username">Login Username</label>
                        <input
                          id="username"
                          type="text"
                          autoComplete="username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>

                      <div className="field">
                        <label htmlFor="password">Login Password</label>
                        <input
                          id="password"
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>
                    </div>
                  </section>

                  {apiType === 'REST' && check && !check.ok && (
                    <label className="run-anyway">
                      <input
                        type="checkbox"
                        checked={runAnyway}
                        onChange={(e) => setRunAnyway(e.target.checked)}
                        disabled={isRunning}
                      />
                      Run anyway, even though the Base URL check failed
                    </label>
                  )}

                  <button type="submit" className="primary-action" disabled={isRunning}>
                    {isRunning ? (
                      <>
                        <span className="spinner" />
                        Running JMeter Test…
                      </>
                    ) : (
                      <>▶ Generate HTML Report</>
                    )}
                  </button>
                </form>
              </div>

              <div className="status-col">
                <StatusPanel run={run} submitting={submitting} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ConfigList({ run }) {
  return (
    <ul className="params">
      <li><span>Application Name</span><b>{run.applicationName}</b></li>
      <li><span>API Type</span><b>{run.apiType}</b></li>
      <li><span>CSV File</span><b>{run.csvName}</b></li>
      <li><span>Total APIs</span><b>{run.csvRows}</b></li>
      <li><span>Threads</span><b>{run.threads}</b></li>
      <li><span>Ramp-up Time</span><b>{run.rampup} seconds</b></li>
      <li><span>Loops</span><b>{run.loops}</b></li>
      {run.baseUrl && <li><span>Base URL</span><b>{run.baseUrl}</b></li>}
    </ul>
  );
}

function ResultSummary({ summary }) {
  const {
    apiCalls,
    apiPassed,
    apiErrors,
    apiErrorPct,
    topErrors,
    failingApis,
  } = summary;

  if (!apiCalls) return null;

  const topError = topErrors?.[0];

  return (
    <div className="result-summary">
      <div className="mini-stat-row">
        <div className="mini-stat">
          <span className="mini-stat-label">API Calls</span>
          <span className="mini-stat-value">{apiCalls}</span>
        </div>
        <div className="mini-stat mini-stat-ok">
          <span className="mini-stat-label">Passed</span>
          <span className="mini-stat-value">{apiPassed}</span>
        </div>
        <div className={`mini-stat${apiErrors > 0 ? ' mini-stat-bad' : ''}`}>
          <span className="mini-stat-label">Failed</span>
          <span className="mini-stat-value">
            {apiErrors} <small>({apiErrorPct}%)</small>
          </span>
        </div>
      </div>

      {topError && (
        <p className="summary-note">
          Most common failure: <b>{topError.code} {topError.message}</b>
          {topError.count > 1 ? ` — ${topError.count} times` : ''}.
        </p>
      )}

      {topError?.code === '404' && (
        <p className="summary-note summary-hint">
          A 404 means the server answered but there is nothing at that path — so
          this is the Base URL, not the credentials. Check that the Base URL
          includes the API path prefix, not just the host.
        </p>
      )}
      {(topError?.code === '401' || topError?.code === '403') && (
        <p className="summary-note summary-hint">
          A {topError.code} means the server rejected the request as
          unauthorised — check the login username and password.
        </p>
      )}

      {failingApis?.length > 0 && apiErrors < apiCalls && (
        <details>
          <summary>APIs that failed</summary>
          <ul className="params" style={{ marginTop: 8 }}>
            {failingApis.map((api) => (
              <li key={api.label}>
                <span>{api.label}</span>
                <b>{api.errorCount}/{api.sampleCount}</b>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function StatusPanel({ run, submitting }) {
  if (submitting && !run) {
    return (
      <div className="status-panel running">
        <h2>
          <span className="spinner" />
          Starting test…
        </h2>
        <p>Uploading the CSV file and launching JMeter.</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="status-panel idle">
        <h2>
          <span className="status-icon" aria-hidden="true">●</span>
          Ready to Run
        </h2>
        <p>Configure your test and click Generate HTML Report.</p>
      </div>
    );
  }

  if (run.status === 'running') {
    return (
      <div className="status-panel running">
        <h2>
          <span className="spinner" />
          Test Running…
        </h2>
        <p>JMeter performance test is currently executing. Please wait.</p>
        <p className="elapsed">Elapsed: {formatElapsed(run.startedAt, null)}</p>
        <ConfigList run={run} />
      </div>
    );
  }

  if (run.status === 'completed') {
    const s = run.summary;
    // The test plan ran, but that says nothing about whether the APIs answered.
    const allFailed = s && s.apiCalls > 0 && s.apiErrors === s.apiCalls;
    const someFailed = s && s.apiErrors > 0 && !allFailed;

    return (
      <div className={`status-panel ${allFailed ? 'failed' : 'completed'}`}>
        <h2>
          <span className="status-icon" aria-hidden="true">{allFailed ? '✕' : '✓'}</span>
          {allFailed
            ? 'Test ran, but every API call failed'
            : 'Test Completed Successfully'}
        </h2>
        <ConfigList run={run} />

        {s && <ResultSummary summary={s} />}

        <p style={{ marginTop: 10 }}>
          HTML Report Generated · took {formatElapsed(run.startedAt, run.finishedAt)}
        </p>
        <a className="report-link" href={run.reportUrl} target="_blank" rel="noreferrer">
          Open HTML Report
        </a>
        <p style={{ marginTop: 10, fontSize: 12.5 }}>
          Results folder: output\{run.outputFolder}
          {someFailed ? ' · see the report\'s Errors table for detail' : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="status-panel failed">
      <h2>
        <span className="status-icon" aria-hidden="true">✕</span>
        JMeter test execution failed.
      </h2>
      <p>{run.error || 'Please check the execution logs.'}</p>
      <ConfigList run={run} />
      <a
        className="log-link"
        href={`/api/run/${run.id}/log`}
        target="_blank"
        rel="noreferrer"
      >
        Download the full execution log →
      </a>
      {run.logTail && (
        <details>
          <summary>Show the last part of the execution output</summary>
          <pre>{run.logTail}</pre>
        </details>
      )}
    </div>
  );
}
