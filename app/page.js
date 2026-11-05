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

// Every section has a unique id, so adding and removing sections never mixes
// up their state or their in-flight CSV lookups.
const emptyConfig = (id) => ({
  id,
  applicationName: '',
  apiType: '',
  numUsers: '',
  // Load Test Configuration: each Test Configuration has its own.
  threads: '',
  rampup: '',
  loops: '',
  csvInfo: null,
  csvError: null,
  csvErrorFile: null,
  inspecting: false,
});

// A section the user has not touched is ignored; anything chosen in it makes it
// a configuration that must then be complete and valid.
const isConfigured = (c) => Boolean(c.applicationName || c.apiType);

export default function Home() {
  // Which sidebar page is showing: the test form ('test'), Run History
  // ('history') or Configuration ('configuration').
  const [view, setView] = useState('test');
  // Any number of independent Application Name / API Type / CSV selections
  // (at least one), run in parallel by a single Run Test click.
  const [configs, setConfigs] = useState(() => [emptyConfig(1)]);
  const nextConfigId = useRef(2);

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

  const [error, setError] = useState(null);
  const [run, setRun] = useState(null);
  // Set instead of `run` when Run Test started 2-3 configurations.
  const [batch, setBatch] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Only the latest CSV lookup of a section may update it, so quickly switching
  // Application / API Type can never leave an older answer on screen.
  const inspectSeq = useRef(new Map());
  // The Database Configuration defaults from .env, kept so a reset can put
  // them back (a blank form still starts with the configured connection).
  const dbDefaults = useRef({ host: '', port: '1433', name: '', user: '' });

  const isRunning = submitting || run?.status === 'running' || batch?.status === 'running';

  // The run's progress / result dialog is open whenever a run is being shown.
  // While it is, everything behind it (header, sidebar, form) is inert, so
  // nothing can be clicked or tabbed to and interfere with the run.
  const modalOpen = Boolean(run || batch);
  const closeRunModal = useCallback(() => {
    // A running test's dialog cannot be dismissed: it is the only place its
    // progress is shown. A finished one closes back to the blank Test Run page.
    if (run?.status === 'running' || batch?.status === 'running') return;
    setRun(null);
    setBatch(null);
  }, [run?.status, batch?.status]);

  // Stop Execution: one run (runId) or, from the batch dialog, every run still
  // going. The server kills the JMeter process tree and answers with the new
  // state; polling then carries on for any run that is still executing.
  const [stopMessage, setStopMessage] = useState(null);
  const stopExecution = useCallback(
    async ({ runId = null, all = false } = {}) => {
      setStopMessage('Stopping execution…');
      try {
        const url = batch
          ? `/api/batch/${batch.id}/stop`
          : `/api/run/${runId ?? run?.id}/stop`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch && !all ? { runId } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (data.batch) setBatch(data.batch);
        else if (data.run) setRun(data.run);
        setStopMessage(res.ok ? data.message : data.error || 'The execution could not be stopped.');
      } catch (err) {
        setStopMessage(`The execution could not be stopped: ${err.message}`);
      }
    },
    [batch, run?.id]
  );

  const updateConfig = useCallback((id, patch) => {
    setConfigs((current) => current.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const addConfig = useCallback(() => {
    const id = nextConfigId.current;
    nextConfigId.current += 1;
    setConfigs((current) => [...current, emptyConfig(id)]);
  }, []);

  // The saved login a configuration will use for a REST / SOAP run.
  const loginFor = (config) => {
    const group = credentialGroupFor(config.applicationName, config.apiType);
    const saved = credentialGroups?.find((g) => g.id === group?.id) ?? null;
    return { group, saved };
  };

  const hasSql = configs.some((c) => c.apiType === 'SQL');

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
        if (cancelled) return;
        if (data.batch) setBatch(data.batch);
        else if (data.run) setRun(data.run);
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

  useEffect(() => {
    if (batch?.status !== 'running') return undefined;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/batch/${batch.id}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.batch) setBatch(data.batch);
      } catch {
        // Transient fetch failure - the next poll retries.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [batch?.status, batch?.id]);

  // Once both Application Name and API Type are chosen in a section, the server
  // picks that combination's CSV from csv files\ and reads it, so the section
  // can name the file and show Total APIs - the real count JMeter will run,
  // produced by the same normalisation the test itself uses. Which schema that
  // normalisation applies is the API Type (REST/SOAP), never guessed from the CSV.
  const inspectCsv = useCallback(
    async (id, currentApplication, currentApiType) => {
      const seq = (inspectSeq.current.get(id) ?? 0) + 1;
      inspectSeq.current.set(id, seq);
      const stale = () => inspectSeq.current.get(id) !== seq;
      updateConfig(id, { csvInfo: null, csvError: null, csvErrorFile: null });
      if (!currentApplication || !currentApiType) {
        updateConfig(id, { inspecting: false });
        return;
      }
      updateConfig(id, { inspecting: true });
      try {
        const body = new FormData();
        body.append('applicationName', currentApplication);
        body.append('apiType', currentApiType);
        const res = await fetch('/api/csv-preview', { method: 'POST', body });
        const data = await res.json();
        if (stale()) return;
        if (!res.ok) {
          updateConfig(id, {
            csvError: data.error || 'The CSV file could not be read.',
            csvErrorFile: data.fileName || null,
          });
          return;
        }
        updateConfig(id, { csvInfo: data });
      } catch (err) {
        if (!stale()) {
          updateConfig(id, { csvError: `The CSV file could not be read: ${err.message}` });
        }
      } finally {
        if (!stale()) updateConfig(id, { inspecting: false });
      }
    },
    [updateConfig]
  );

  // Opening "New Test" from the sidebar always starts a blank form: every
  // field, the selected CSVs, any error, and the previous run's result panel
  // are cleared. Nothing is saved or restored - the previous run itself lives
  // on in History. Only a run that is still executing keeps its status panel,
  // since that is the only place its progress is shown (the form stays
  // disabled until it finishes).
  const resetTestForm = useCallback(() => {
    setConfigs([emptyConfig(nextConfigId.current)]);
    nextConfigId.current += 1;
    setDbHost(dbDefaults.current.host);
    setDbPort(dbDefaults.current.port);
    setDbName(dbDefaults.current.name);
    setDbUser(dbDefaults.current.user);
    setDbPassword('');

    // Invalidate any CSV lookup still in flight so a late answer cannot
    // repopulate the fresh form.
    inspectSeq.current = new Map();

    setError(null);
    if (!isRunning) {
      setRun(null);
      setBatch(null);
    }
  }, [isRunning]);

  const handleApplicationChange = useCallback(
    (id, nextApplication) => {
      const current = configs.find((c) => c.id === id);
      // Keep the chosen API Type only if the new application offers it and it
      // is one the dropdown shows (Query Testing is not offered in the UI).
      const nextApiType =
        current.apiType !== HIDDEN_API_TYPE && isApiTypeAllowed(nextApplication, current.apiType)
          ? current.apiType
          : '';
      updateConfig(id, { applicationName: nextApplication, apiType: nextApiType, numUsers: '' });
      setError(null);
      inspectCsv(id, nextApplication, nextApiType);
    },
    [configs, inspectCsv, updateConfig]
  );

  // Switching API Type selects a different CSV and schema, so the CSV is
  // looked up again from scratch.
  const handleApiTypeChange = useCallback(
    (id, nextApiType) => {
      updateConfig(id, { apiType: nextApiType, numUsers: '' });
      setError(null);
      inspectCsv(id, configs.find((c) => c.id === id)?.applicationName ?? '', nextApiType);
    },
    [configs, inspectCsv, updateConfig]
  );

  // Removes one section (the others are untouched; only the displayed numbers
  // shift). The last remaining section is emptied instead, so one is always
  // visible. The CSV files themselves are never touched.
  const removeConfig = useCallback(
    (id) => {
      inspectSeq.current.delete(id);
      setConfigs((current) =>
        current.length > 1 ? current.filter((c) => c.id !== id) : [emptyConfig(id)]
      );
      setError(null);
    },
    []
  );

  // Why a configured section cannot run yet (null = ready). Used for the
  // section's own status line and, in the same order, by Run Test.
  const configProblem = (config) => {
    const { group, saved } = loginFor(config);
    if (!config.applicationName) return 'Please select the Application Name.';
    if (!config.apiType) return 'Please select the API Type.';
    if (config.inspecting) return 'The CSV file is still being read.';
    if (config.csvError) return config.csvError;
    if (!config.csvInfo) {
      return `The CSV file for ${config.applicationName} (${config.apiType}) is not available.`;
    }
    if (config.apiType === 'REST' && config.csvInfo.needsBaseUrl) {
      return `${config.csvInfo.fileName} lists relative endpoints but has no BASE_URL column. Add a BASE_URL column to it in the "csv files" folder.`;
    }
    if (config.apiType !== 'SQL' && credentialGroups) {
      // REST and SOAP authenticate with the login saved under Configuration
      // for this application - the server looks it up and uses it, nothing is
      // typed or sent from here. Query Testing has no such login: it uses the
      // Database Configuration instead.
      if (!saved?.configured) {
        return `No users found for ${group?.label ?? config.applicationName}. Add them to credentials\\${group?.usersCsv ?? ''}.`;
      }
      // Number of Users: never more than are actually configured for this
      // application's credential group - checked against the real count,
      // not silently clamped.
      const maxUsers = saved.users?.length ?? 0;
      if (!/^[1-9][0-9]*$/.test(config.numUsers.trim())) return 'Please select the Number of Users.';
      if (Number(config.numUsers) > maxUsers) {
        return maxUsers === 1
          ? `Only 1 user is configured for ${group?.label ?? config.applicationName}. Reduce Number of Users to 1, or add more logins under Configuration.`
          : `Only ${maxUsers} users are configured for ${group?.label ?? config.applicationName}. Reduce Number of Users to ${maxUsers} or fewer, or add more logins under Configuration.`;
      }
    }
    return null;
  };

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setError(null);

      const selected = configs
        .map((config, index) => ({ config, index }))
        .filter(({ config }) => isConfigured(config));

      if (selected.length === 0) {
        setError('Please select the Application Name.');
        return;
      }

      // Every configured section must be valid before anything starts.
      for (const { config, index } of selected) {
        const problem = configProblem(config);
        if (problem) {
          setError(selected.length > 1 ? `Test Configuration ${index + 1}: ${problem}` : problem);
          return;
        }
      }

      for (const { config, index } of selected) {
        const prefix = selected.length > 1 ? `Test Configuration ${index + 1}: ` : '';
        if (!/^[1-9][0-9]*$/.test(config.threads.trim())) {
          setError(`${prefix}Please enter a valid number of threads.`);
          return;
        }
        if (!/^[1-9][0-9]*$/.test(config.rampup.trim())) {
          setError(`${prefix}Please enter a valid ramp-up time.`);
          return;
        }
        if (!/^[1-9][0-9]*$/.test(config.loops.trim())) {
          setError(`${prefix}Please enter a valid number of loops.`);
          return;
        }
      }
      if (selected.some(({ config }) => config.apiType === 'SQL')) {
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
      }

      // No CSV is sent: the server uses the file in csv files\ for each
      // Application Name + API Type, the same one previewed above.
      const body = new FormData();
      body.append(
        'configurations',
        JSON.stringify(
          selected.map(({ config }) => ({
            applicationName: config.applicationName,
            apiType: config.apiType.trim(),
            numUsers: config.apiType === 'SQL' ? '' : config.numUsers.trim(),
            threads: config.threads.trim(),
            rampup: config.rampup.trim(),
            loops: config.loops.trim(),
          }))
        )
      );
      if (selected.some(({ config }) => config.apiType === 'SQL')) {
        body.append('dbHost', dbHost.trim());
        body.append('dbPort', dbPort.trim());
        body.append('dbName', dbName.trim());
        body.append('dbUser', dbUser.trim());
        // Empty = use DB_PASSWORD from .env on the server.
        body.append('dbPassword', dbPassword);
      }

      setSubmitting(true);
      setStopMessage(null);
      setRun(null);
      setBatch(null);
      try {
        const res = await fetch('/api/run', { method: 'POST', body });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'The test could not be started.');
          if (data.run) setRun(data.run);
          if (data.batch) setBatch(data.batch);
          return;
        }
        if (data.batch) setBatch(data.batch);
        else setRun(data.run);
      } catch (err) {
        setError(`The test could not be started: ${err.message}`);
      } finally {
        setSubmitting(false);
      }
    },
    // configProblem reads these via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      configs,
      credentialGroups,
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
              // Coming back from History / Configuration keeps the form as it
              // was left; clicking New Test while already on it starts blank.
              if (view === 'test') resetTestForm();
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
                  {configs.map((config, index) => {
                    const { group, saved } = loginFor(config);
                    const idp = `config${config.id}`;
                    const configured = isConfigured(config);
                    const problem = configured ? configProblem(config) : null;
                    const ready = configured && !problem;
                    return (
                  <section className="panel" key={config.id} aria-labelledby={`${idp}-title`}>
                    <div className="panel-header">
                      <h2 className="panel-title" id={`${idp}-title`}>Test Configuration {index + 1}</h2>
                      <p className="panel-subtitle">
                        {index === 0
                          ? 'Configure your performance test'
                          : 'Optional - leave empty to skip'}
                      </p>
                      <p
                        className={`hint${problem ? ' hint-error' : ''}`}
                        data-testid={`${idp}-status`}
                        aria-live="polite"
                      >
                        {!configured
                          ? 'Not configured'
                          : ready
                            ? '✓ Ready for testing'
                            : config.inspecting
                              ? 'Checking…'
                              : `✕ ${problem}`}
                      </p>
                      {!isRunning && (configs.length > 1 || configured) && (
                        <button type="button" className="link-button" onClick={() => removeConfig(config.id)}>
                          {configs.length > 1 ? 'Remove' : 'Clear'}
                        </button>
                      )}
                    </div>

                    <div className="field-grid-2">
                      <div className="field">
                        <label htmlFor={`${idp}-applicationName`}>Application Name</label>
                        <select
                          id={`${idp}-applicationName`}
                          value={config.applicationName}
                          onChange={(e) => handleApplicationChange(config.id, e.target.value)}
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

                      {config.applicationName && (
                        <div className="field">
                          <label htmlFor={`${idp}-apiType`}>API Type</label>
                          <select
                            id={`${idp}-apiType`}
                            value={config.apiType}
                            onChange={(e) => handleApiTypeChange(config.id, e.target.value)}
                            disabled={isRunning}
                          >
                            <option value="" disabled>
                              Select API type
                            </option>
                            {selectableApiTypes(config.applicationName).map((type) => (
                              <option key={type.value} value={type.value}>
                                {type.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Which saved login this configuration will use (REST and
                        SOAP only). Only the username is shown - never the password. */}
                    {config.applicationName && config.apiType && config.apiType !== 'SQL' && group && credentialGroups && (
                      saved?.configured ? (
                        <p className="hint login-hint">
                          Login: using the {saved.users.length} user{saved.users.length === 1 ? '' : 's'} listed for {group.label} (
                          <b>{saved.users.slice(0, 3).map((u) => u.username).join(', ')}
                          {saved.users.length > 3 ? ', …' : ''}</b>). See them under{' '}
                          <button type="button" className="link-button" onClick={() => setView('configuration')}>
                            Configuration
                          </button>
                          .
                        </p>
                      ) : (
                        <p className="hint hint-error login-hint">
                          No saved login for {group.label}.{' '}
                          <button type="button" className="link-button" onClick={() => setView('configuration')}>
                            Open Configuration
                          </button>{' '}
                          and save the username and password before running.
                        </p>
                      )
                    )}

                    {/* Only meaningful for REST/SOAP, which authenticate with a
                        saved login (Query Testing has none). The choices are
                        exactly the logins configured for this application's
                        credential group - never more, taken from the start of
                        the list in order. */}
                    {config.apiType && config.apiType !== 'SQL' && saved?.configured && (
                      <div className="field" style={{ maxWidth: 220, marginBottom: 18 }}>
                        <label htmlFor={`${idp}-numUsers`}>Number of Users</label>
                        <select
                          id={`${idp}-numUsers`}
                          value={config.numUsers}
                          onChange={(e) => updateConfig(config.id, { numUsers: e.target.value })}
                          disabled={isRunning}
                        >
                          <option value="" disabled>
                            Select
                          </option>
                          {Array.from({ length: saved.users.length }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                        <span className="field-desc">
                          Only the first N configured users are used (
                          {saved.users.map((u) => u.username).join(', ')})
                        </span>
                      </div>
                    )}

                    {/* Read-only: the CSV is picked automatically from csv files\
                        for the selected Application Name + API Type. */}
                    <div className="field">
                      <span className="label-static">CSV File</span>
                      <div
                        className={[
                          'dropzone',
                          'auto',
                          config.csvInfo && !config.inspecting ? 'has-file' : '',
                          config.csvError ? 'has-error' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-live="polite"
                      >
                        {config.inspecting && (
                          <div className="dropzone-loading">
                            <span className="spinner" />
                            Reading CSV…
                          </div>
                        )}

                        {!config.inspecting && config.csvInfo && (
                          <div className="dropzone-file">
                            <span className="file-icon" aria-hidden="true">📄</span>
                            <div className="file-meta">
                              <strong>{config.csvInfo.fileName}</strong>
                              <span>
                                {formatBytes(config.csvInfo.fileSize)} · {config.csvInfo.totalApis}{' '}
                                {config.apiType === 'SQL' ? 'queries' : 'APIs'} · Selected automatically
                              </span>
                            </div>
                            <span className="file-check" aria-hidden="true">✓</span>
                          </div>
                        )}

                        {!config.inspecting && !config.csvInfo && (
                          <>
                            <div className="dropzone-icon" aria-hidden="true">📄</div>
                            <div className="dropzone-title">
                              {config.csvErrorFile
                                ? config.csvErrorFile
                                : config.csvError
                                  ? 'No CSV file available'
                                  : 'No CSV file selected yet'}
                            </div>
                            {config.csvErrorFile && (
                              <div className="dropzone-sub">
                                Selected automatically - but it cannot be run, see below.
                              </div>
                            )}
                            {!config.csvError && (
                              <div className="dropzone-sub">
                                Select the Application Name and API Type - the matching CSV
                                file is picked automatically.
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {config.csvError && (
                        <span className="hint hint-error" style={{ whiteSpace: 'pre-wrap' }}>
                          {config.csvError}
                        </span>
                      )}
                    </div>
                  </section>
                    );
                  })}

                  <div className="run-actions">
                    <button type="button" className="link-button" onClick={addConfig} disabled={isRunning}>
                      + Add Test Configuration
                    </button>
                  </div>

                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Target &amp; Coverage</h2>
                    </div>

                    {/* Rendered as a read-out rather than an <input>: this value is always
                        counted from the selected CSV, and an input box invites the client
                        to type a number that would then be ignored. One tile per
                        configured Test Configuration. */}
                    {configs.every((c) => !isConfigured(c)) && (
                      <div className="stat-tile" aria-live="polite">
                        <span className="stat-label">Total APIs</span>
                        <span className="stat-empty">Select an application and API type to count APIs</span>
                      </div>
                    )}
                    {configs.map((config, index) =>
                      isConfigured(config) ? (
                        <div className="stat-tile" aria-live="polite" key={config.id}>
                          <span className="stat-label">
                            Configuration {index + 1}: {config.apiType === 'SQL' ? 'Total Queries' : 'Total APIs'}
                          </span>
                          {config.inspecting ? (
                            <span className="stat-loading">
                              <span className="spinner" />
                              Counting…
                            </span>
                          ) : config.csvInfo ? (
                            <>
                              <span className="stat-value">{config.csvInfo.totalApis}</span>
                              <span className="stat-note">from {config.csvInfo.fileName}</span>
                            </>
                          ) : (
                            <span className="stat-empty">
                              {config.csvError
                                ? 'No CSV file available'
                                : 'Select an application and API type to count APIs'}
                            </span>
                          )}
                        </div>
                      ) : null
                    )}
                  </section>


                  {/* One Load Test Configuration per Test Configuration, so each
                      run has its own Threads / Ramp-up / Loops. */}
                  {configs.map((config, index) => (
                    <section className="panel" key={config.id} aria-labelledby={`load${config.id}-title`}>
                      <div className="panel-header">
                        <h2 className="panel-title" id={`load${config.id}-title`}>Load Test Configuration {index + 1}</h2>
                        <p className="panel-subtitle">Simulate concurrent user load</p>
                      </div>

                      <p className="hint">Applies to Test Configuration {index + 1}.</p>

                      <div className="row load-row">
                        {[
                          ['threads', 'Threads', '10', 'Number of concurrent users'],
                          ['rampup', 'Ramp-up Time (s)', '10', 'Time to start all users'],
                          ['loops', 'Loops', '2', 'Iterations per user'],
                        ].map(([key, label, placeholder, desc]) => (
                          <div className="field" key={key}>
                            <label htmlFor={`${key}${config.id}`}>{label}</label>
                            <input
                              id={`${key}${config.id}`}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              placeholder={placeholder}
                              value={config[key]}
                              onChange={(e) => updateConfig(config.id, { [key]: e.target.value })}
                              disabled={isRunning}
                            />
                            <span className="field-desc">{desc}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}

                  {/* The login for REST and SOAP runs is not entered here any more:
                      it is the one saved under Configuration for the selected
                      application (see the hint under Application Name / API
                      Type). */}

                  {/* Query Testing: the SQL Server that sql_test.jmx's JDBC
                      Connection Configuration connects to. Pre-filled from DB_* in
                      .env; values typed here are used for this run only and passed
                      to JMeter as environment variables - never saved or logged. */}
                  {hasSql && (
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

      <RunModal run={run} batch={batch} onClose={closeRunModal} onStop={stopExecution} stopMessage={stopMessage} />
    </div>
  );
}
