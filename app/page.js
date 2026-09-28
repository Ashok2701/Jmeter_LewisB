'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  APPLICATIONS,
  apiTypesFor,
  credentialGroupFor,
  isApiTypeAllowed,
} from '@/lib/applications';

import ConfigurationPanel from './ConfigurationPanel';
import HistoryPanel from './HistoryPanel';
import RunModal from './RunModal';

const POLL_INTERVAL_MS = 3000;

// Query Testing is not offered in the API Type dropdown. This only hides the
// option: the Query Testing mapping, backend and JMeter plan are unchanged.
const HIDDEN_API_TYPE = 'SQL';
const selectableApiTypes = (applicationName) =>
  apiTypesFor(applicationName).filter((type) => type.value !== HIDDEN_API_TYPE);

// Display-only helper - no effect on which CSV is used or how it is processed.
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  // Which sidebar page is showing: the test form ('test'), Run History
  // ('history') or Configuration ('configuration').
  const [view, setView] = useState('test');
  const [applicationName, setApplicationName] = useState('');
  const [apiType, setApiType] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [threads, setThreads] = useState('');
  const [rampup, setRampup] = useState('');
  const [loops, setLoops] = useState('');

  // The saved logins (username + whether a password is saved - never the
  // password), managed under Configuration. Re-read whenever the Test Run
  // page is shown, so a login just saved there is picked up straight away.
  const [credentialGroups, setCredentialGroups] = useState(null);

  // Query Testing: SQL Server connection. Pre-filled from DB_* in .env (via
  // /api/db-config, which never returns the password itself); a value typed
  // here is used for that run only.
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState('');
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [dbPasswordConfigured, setDbPasswordConfigured] = useState(false);

  const [csvInfo, setCsvInfo] = useState(null);
  const [csvError, setCsvError] = useState(null);
  const [csvErrorFile, setCsvErrorFile] = useState(null);
  const [inspecting, setInspecting] = useState(false);

  const [error, setError] = useState(null);
  const [run, setRun] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Only the latest CSV lookup may update the form, so quickly switching
  // Application / API Type can never leave an older answer on screen.
  const inspectSeq = useRef(0);
  // The Database Configuration defaults from .env, kept so a reset can put
  // them back (a blank form still starts with the configured connection).
  const dbDefaults = useRef({ host: '', port: '1433', name: '', user: '' });

  const isRunning = submitting || run?.status === 'running';

  // The run's progress / result dialog is open whenever a run is being shown.
  // While it is, everything behind it (header, sidebar, form) is inert, so
  // nothing can be clicked or tabbed to and interfere with the run.
  const modalOpen = Boolean(run);
  const closeRunModal = useCallback(() => {
    // A running test's dialog cannot be dismissed: it is the only place its
    // progress is shown. A finished one closes back to the blank Test Run page.
    if (run?.status === 'running') return;
    setRun(null);
  }, [run?.status]);

  // The saved login the selected application will use for a REST / SOAP run.
  const credentialGroup = credentialGroupFor(applicationName, apiType);
  const savedLogin = credentialGroups?.find((g) => g.id === credentialGroup?.id) ?? null;

  useEffect(() => {
    if (view !== 'test') return undefined;
    let cancelled = false;
    fetch('/api/credentials', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.groups) setCredentialGroups(data.groups);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [view]);

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
    let cancelled = false;
    fetch('/api/db-config')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        dbDefaults.current = {
          host: data.host || '',
          port: data.port || '1433',
          name: data.name || '',
          user: data.user || '',
        };
        setDbHost((v) => v || dbDefaults.current.host);
        setDbPort((v) => v || dbDefaults.current.port);
        setDbName((v) => v || dbDefaults.current.name);
        setDbUser((v) => v || dbDefaults.current.user);
        setDbPasswordConfigured(Boolean(data.passwordConfigured));
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

  // Once both Application Name and API Type are chosen, the server picks that
  // combination's CSV from csv files\ and reads it, so the form can name the
  // file and show Total APIs - the real count JMeter will run, produced by the
  // same normalisation the test itself uses. Which schema that normalisation
  // applies is `currentApiType` (REST/SOAP), never guessed from the CSV.
  const inspectCsv = useCallback(async (currentApplication, currentApiType) => {
    const seq = ++inspectSeq.current;
    setCsvInfo(null);
    setCsvError(null);
    setCsvErrorFile(null);
    if (!currentApplication || !currentApiType) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    try {
      const body = new FormData();
      body.append('applicationName', currentApplication);
      body.append('apiType', currentApiType);
      const res = await fetch('/api/csv-preview', { method: 'POST', body });
      const data = await res.json();
      if (seq !== inspectSeq.current) return;
      if (!res.ok) {
        setCsvError(data.error || 'The CSV file could not be read.');
        setCsvErrorFile(data.fileName || null);
        return;
      }
      setCsvInfo(data);
    } catch (err) {
      if (seq === inspectSeq.current) {
        setCsvError(`The CSV file could not be read: ${err.message}`);
      }
    } finally {
      if (seq === inspectSeq.current) setInspecting(false);
    }
  }, []);

  // Opening "New Test" from the sidebar always starts a blank form: every
  // field, the selected CSV, any error, and the previous run's result panel
  // are cleared. Nothing is saved or restored - the previous run itself lives
  // on in History. Only a run that is still executing keeps its status panel,
  // since that is the only place its progress is shown (the form stays
  // disabled until it finishes).
  const resetTestForm = useCallback(() => {
    setApplicationName('');
    setApiType('');
    setBaseUrl('');
    setThreads('');
    setRampup('');
    setLoops('');

    setDbHost(dbDefaults.current.host);
    setDbPort(dbDefaults.current.port);
    setDbName(dbDefaults.current.name);
    setDbUser(dbDefaults.current.user);
    setDbPassword('');

    // Invalidate any CSV lookup still in flight so a late answer cannot
    // repopulate the fresh form.
    inspectSeq.current += 1;
    setCsvInfo(null);
    setCsvError(null);
    setCsvErrorFile(null);
    setInspecting(false);

    setError(null);
    if (!isRunning) setRun(null);
  }, [isRunning]);

  const handleApplicationChange = useCallback(
    (event) => {
      const nextApplication = event.target.value;
      // Keep the chosen API Type only if the new application offers it and it
      // is one the dropdown shows (Query Testing is not offered in the UI).
      const nextApiType =
        apiType !== HIDDEN_API_TYPE && isApiTypeAllowed(nextApplication, apiType) ? apiType : '';
      setApplicationName(nextApplication);
      setApiType(nextApiType);
      setBaseUrl('');
      setError(null);
      inspectCsv(nextApplication, nextApiType);
    },
    [inspectCsv, apiType]
  );

  // Switching API Type selects a different CSV and schema, so the CSV is
  // looked up again from scratch; a Base URL for a REST CSV has no meaning
  // for SOAP and is cleared too.
  const handleApiTypeChange = useCallback(
    (event) => {
      const nextApiType = event.target.value;
      setApiType(nextApiType);
      setBaseUrl('');
      setError(null);
      inspectCsv(applicationName, nextApiType);
    },
    [inspectCsv, applicationName]
  );

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setError(null);

      if (!applicationName) {
        setError('Please select the Application Name.');
        return;
      }
      if (!apiType) {
        setError('Please select the API Type.');
        return;
      }
      if (inspecting) {
        setError('Please wait - the CSV file is still being read.');
        return;
      }
      if (csvError) {
        setError(csvError);
        return;
      }
      if (!csvInfo) {
        setError(`The CSV file for ${applicationName} (${apiType}) is not available.`);
        return;
      }
      if (apiType === 'REST' && csvInfo.needsBaseUrl && !baseUrl.trim()) {
        setError(
          `${csvInfo.fileName} lists relative endpoints but has no BASE_URL column. Add a BASE_URL column to it in the "csv files" folder.`
        );
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
      // REST and SOAP authenticate with the login saved under Configuration
      // for this application - the server looks it up and uses it, nothing is
      // typed or sent from here. Query Testing has no such login: it uses the
      // Database Configuration instead.
      if (apiType === 'SQL') {
        if (!dbHost.trim()) {
          setError('Please enter the Database Host.');
          return;
        }
        if (!/^\d{1,5}$/.test(dbPort.trim()) || Number(dbPort) < 1 || Number(dbPort) > 65535) {
          setError('The Database Port must be a number between 1 and 65535.');
          return;
        }
        if (!dbName.trim()) {
          setError('Please enter the Database Name.');
          return;
        }
        if (!dbUser.trim()) {
          setError('Please enter the Database Username.');
          return;
        }
        if (!dbPassword && !dbPasswordConfigured) {
          setError('Please enter the Database Password.');
          return;
        }
      } else if (credentialGroups && !savedLogin?.configured) {
        setError(
          `No saved login for ${credentialGroup?.label ?? applicationName}. Open Configuration in the sidebar, enter the username and password, and click Save.`
        );
        return;
      }

      // No CSV is sent: the server uses the file in csv files\ for this
      // Application Name + API Type, the same one previewed above.
      const body = new FormData();
      body.append('applicationName', applicationName);
      body.append('apiType', apiType.trim());
      body.append('baseUrl', baseUrl.trim());
      body.append('threads', threads.trim());
      body.append('rampup', rampup.trim());
      body.append('loops', loops.trim());
      if (apiType === 'SQL') {
        body.append('dbHost', dbHost.trim());
        body.append('dbPort', dbPort.trim());
        body.append('dbName', dbName.trim());
        body.append('dbUser', dbUser.trim());
        // Empty = use DB_PASSWORD from .env on the server.
        body.append('dbPassword', dbPassword);
      }

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
      credentialGroups,
      credentialGroup,
      savedLogin,
      csvInfo,
      csvError,
      inspecting,
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPassword,
      dbPasswordConfigured,
    ]
  );

  return (
    <div className="app-shell">
      <header className="app-header" inert={modalOpen}>
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">⚡</span>
          <div className="brand-text">
            <span className="brand-name">Lewis Bakers - Tema App</span>
            <span className="brand-tag">Performance Testing Platform</span>
          </div>
        </div>
      </header>

      <div className="app-body" inert={modalOpen}>
        <nav className="sidebar" aria-label="Primary">
          <button
            type="button"
            className={`sidebar-item${view === 'test' ? ' active' : ''}`}
            title="New Test"
            aria-current={view === 'test' ? 'page' : undefined}
            onClick={() => {
              resetTestForm();
              setView('test');
            }}
          >
            <span className="sidebar-icon" aria-hidden="true">▶</span>
            <span className="sidebar-label">New Test</span>
          </button>
          <button
            type="button"
            className={`sidebar-item${view === 'history' ? ' active' : ''}`}
            title="History"
            aria-current={view === 'history' ? 'page' : undefined}
            onClick={() => setView('history')}
          >
            <span className="sidebar-icon" aria-hidden="true">🕘</span>
            <span className="sidebar-label">History</span>
          </button>
          <button
            type="button"
            className={`sidebar-item${view === 'configuration' ? ' active' : ''}`}
            title="Configuration"
            aria-current={view === 'configuration' ? 'page' : undefined}
            onClick={() => setView('configuration')}
          >
            <span className="sidebar-icon" aria-hidden="true">⚙</span>
            <span className="sidebar-label">Configuration</span>
          </button>
        </nav>

        <main className="main-content">
          <div className="content-inner">
            {/* History is a separate view of the same page. The test form below is
                hidden, never unmounted, when History is open, so a run in progress
                and everything typed into the form are still there on return. */}
            {view === 'history' && <HistoryPanel />}
            {view === 'configuration' && <ConfigurationPanel />}

            <div hidden={view !== 'test'}>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            {/* The Test Run page is one full-width column. The run's progress and
                result are not shown beside it: they appear in the modal below. */}
            <div className="test-run">
                <form onSubmit={handleSubmit} noValidate>
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Test Configuration</h2>
                      <p className="panel-subtitle">Configure your performance test</p>
                    </div>

                    <div className="field-grid-2">
                      <div className="field">
                        <label htmlFor="applicationName">Application Name</label>
                        <select
                          id="applicationName"
                          value={applicationName}
                          onChange={handleApplicationChange}
                          disabled={isRunning}
                        >
                          <option value="" disabled>
                            Select application
                          </option>
                          {APPLICATIONS.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {applicationName && (
                        <div className="field">
                          <label htmlFor="apiType">API Type</label>
                          <select
                            id="apiType"
                            value={apiType}
                            onChange={handleApiTypeChange}
                            disabled={isRunning}
                          >
                            <option value="" disabled>
                              Select API type
                            </option>
                            {selectableApiTypes(applicationName).map((type) => (
                              <option key={type.value} value={type.value}>
                                {type.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Which saved login this run will use (REST and SOAP only).
                        Only the username is shown - never the password. */}
                    {applicationName && apiType && apiType !== 'SQL' && credentialGroup && credentialGroups && (
                      savedLogin?.configured ? (
                        <p className="hint login-hint">
                          Login: using the saved credentials for {credentialGroup.label} (
                          {savedLogin.users.length > 1 ? 'users' : 'user'}{' '}
                          <b>{savedLogin.users.map((u) => u.username).join(', ')}</b>). Change them under{' '}
                          <button type="button" className="link-button" onClick={() => setView('configuration')}>
                            Configuration
                          </button>
                          .
                        </p>
                      ) : (
                        <p className="hint hint-error login-hint">
                          No saved login for {credentialGroup.label}.{' '}
                          <button type="button" className="link-button" onClick={() => setView('configuration')}>
                            Open Configuration
                          </button>{' '}
                          and save the username and password before running.
                        </p>
                      )
                    )}

                    {/* Read-only: the CSV is picked automatically from csv files\
                        for the selected Application Name + API Type. */}
                    <div className="field">
                      <span className="label-static">CSV File</span>
                      <div
                        className={[
                          'dropzone',
                          'auto',
                          csvInfo && !inspecting ? 'has-file' : '',
                          csvError ? 'has-error' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-live="polite"
                      >
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
                                {formatBytes(csvInfo.fileSize)} · Selected automatically
                              </span>
                            </div>
                            <span className="file-check" aria-hidden="true">✓</span>
                          </div>
                        )}

                        {!inspecting && !csvInfo && (
                          <>
                            <div className="dropzone-icon" aria-hidden="true">📄</div>
                            <div className="dropzone-title">
                              {csvErrorFile
                                ? csvErrorFile
                                : csvError
                                  ? 'No CSV file available'
                                  : 'No CSV file selected yet'}
                            </div>
                            {csvErrorFile && (
                              <div className="dropzone-sub">
                                Selected automatically - but it cannot be run, see below.
                              </div>
                            )}
                            {!csvError && (
                              <div className="dropzone-sub">
                                Select the Application Name and API Type - the matching CSV
                                file is picked automatically.
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {csvError && (
                        <span className="hint hint-error" style={{ whiteSpace: 'pre-wrap' }}>
                          {csvError}
                        </span>
                      )}
                    </div>
                  </section>

                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Target &amp; Coverage</h2>
                    </div>

                    {/* Rendered as a read-out rather than an <input>: this value is always
                        counted from the selected CSV, and an input box invites the client
                        to type a number that would then be ignored. Base URL is configured
                        separately below - this section is API coverage only. */}
                    <div className="stat-tile" aria-live="polite">
                      <span className="stat-label">
                        {apiType === 'SQL' ? 'Total Queries' : 'Total APIs'}
                      </span>
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
                        <span className="stat-empty">
                          {csvError
                            ? 'No CSV file available'
                            : 'Select an application and API type to count APIs'}
                        </span>
                      )}
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

                  {/* The login for REST and SOAP runs is not entered here any more:
                      it is the one saved under Configuration for the selected
                      application (see the hint under Application Name / API
                      Type). */}

                  {/* Query Testing: the SQL Server that sql_test.jmx's JDBC
                      Connection Configuration connects to. Pre-filled from DB_* in
                      .env; values typed here are used for this run only and passed
                      to JMeter as environment variables - never saved or logged. */}
                  {apiType === 'SQL' && (
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Database Configuration</h2>
                      <p className="panel-subtitle">
                        SQL Server the queries run against. Defaults come from .env; changes apply to
                        this test run only and are never saved to disk or written to any log.
                      </p>
                    </div>

                    <div className="row" style={{ gridTemplateColumns: '2fr 1fr' }}>
                      <div className="field">
                        <label htmlFor="dbHost">Database Host</label>
                        <input
                          id="dbHost"
                          type="text"
                          placeholder="SERVER or SERVER\INSTANCE"
                          value={dbHost}
                          onChange={(e) => setDbHost(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>

                      <div className="field">
                        <label htmlFor="dbPort">Database Port</label>
                        <input
                          id="dbPort"
                          type="number"
                          min="1"
                          max="65535"
                          step="1"
                          inputMode="numeric"
                          placeholder="1433"
                          value={dbPort}
                          onChange={(e) => setDbPort(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>
                    </div>

                    <div className="field">
                      <label htmlFor="dbName">Database Name</label>
                      <input
                        id="dbName"
                        type="text"
                        value={dbName}
                        onChange={(e) => setDbName(e.target.value)}
                        disabled={isRunning}
                      />
                    </div>

                    <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div className="field">
                        <label htmlFor="dbUser">Database Username</label>
                        <input
                          id="dbUser"
                          type="text"
                          autoComplete="off"
                          value={dbUser}
                          onChange={(e) => setDbUser(e.target.value)}
                          disabled={isRunning}
                        />
                      </div>

                      <div className="field">
                        <label htmlFor="dbPassword">Database Password</label>
                        <input
                          id="dbPassword"
                          type="password"
                          autoComplete="new-password"
                          placeholder={dbPasswordConfigured ? 'Configured in .env' : ''}
                          value={dbPassword}
                          onChange={(e) => setDbPassword(e.target.value)}
                          disabled={isRunning}
                        />
                        {dbPasswordConfigured && (
                          <span className="field-desc">Leave empty to use DB_PASSWORD from .env</span>
                        )}
                      </div>
                    </div>
                  </section>
                  )}

                  <div className="run-actions">
                    <button type="submit" className="primary-action" disabled={isRunning}>
                      {isRunning ? (
                        <>
                          <span className="spinner" />
                          Test Running…
                        </>
                      ) : (
                        <>▶ Run Test</>
                      )}
                    </button>
                  </div>
                </form>
            </div>
            </div>
          </div>
        </main>
      </div>

      <RunModal run={run} onClose={closeRunModal} />
    </div>
  );
}
