'use client';

import { useEffect, useRef, useState } from 'react';

import ExecutionQueue from './ExecutionQueue';

// The Test Run's execution state, shown as a centred modal over the page
// instead of a permanent side panel: running -> completed / failed, all in the
// SAME dialog. It only presents the run the page already tracks (`run`, from
// /api/run and /api/run/<id>); it starts, changes and stores nothing.

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function ConfigList({ run }) {
  const isSql = run.apiType === 'SQL';
  const numUsers = run.numUsers;
  return (
    <ul className="params">
      <li><span>Application</span><b>{run.applicationName}</b></li>
      <li><span>API Type</span><b>{isSql ? 'Query Testing' : run.apiType}</b></li>
      {isSql && run.dbServer && <li><span>Database</span><b>{run.dbServer}</b></li>}
      <li><span>CSV File</span><b>{run.csvName}</b></li>
      <li><span>{isSql ? 'Total Queries' : 'Total APIs'}</span><b>{run.csvRows}</b></li>
      {!isSql && numUsers != null && <li><span>Number of Users</span><b>{numUsers}</b></li>}
      <li><span>Threads</span><b>{run.threads}</b></li>
      <li><span>Ramp-up Time</span><b>{run.rampup} seconds</b></li>
      <li><span>Loops</span><b>{run.loops}</b></li>
      {!isSql && numUsers != null && (
        <li><span>Number of Runs</span><b>{numUsers * Number(run.threads) * Number(run.loops)}</b></li>
      )}
    </ul>
  );
}

function ResultTiles({ summary, isSql }) {
  const { apiCalls, apiPassed, apiErrors, apiErrorPct } = summary;
  if (!apiCalls) return null;
  return (
    <div className="mini-stat-row">
      <div className="mini-stat">
        <span className="mini-stat-label">{isSql ? 'Queries' : 'API Calls'}</span>
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
  );
}

function passedPct(summary) {
  const failed = Number(summary.apiErrorPct);
  return Number.isFinite(failed) ? (Math.round((100 - failed) * 100) / 100).toString() : '';
}

// One line for the most common failure. Query Testing keeps its message as
// before; REST / SOAP add the HTTP status and the server's own explanation, so
// a bare "401 Unauthorized" shows why (e.g. a locked account).
function errorText(error, isSql) {
  if (isSql) return error.message || error.code;
  const status = [error.code, error.message].filter(Boolean).join(' ');
  return error.detail ? `${status} - ${error.detail}` : status;
}

// Several Test Configurations ran from one Run Test click. Each one keeps its
// own card, status, counts, error, JTL and report - nothing is merged.
function BatchDialog({ batch, dialogRef, primaryRef, running, onClose, onStop, stopMessage }) {
  const configs = batch.configs;
  const okCount = configs.filter((c) => c.status === 'completed').length;
  const doneCount = configs.filter((c) => ['completed', 'failed', 'stopped'].includes(c.status)).length;
  const variant = running ? 'running' : batch.status === 'completed' ? 'completed' : 'failed';
  const title = running
    ? `Running ${batch.total} Test Configurations in parallel (${doneCount} of ${batch.total} finished)…`
    : batch.status === 'completed'
      ? `All ${batch.total} Test Configurations Completed`
      : batch.status === 'stopped'
        ? 'Execution Stopped'
        : batch.status === 'partial'
          ? `${batch.total - okCount} of ${batch.total} Test Configurations Did Not Complete`
          : 'All Test Configurations Failed';

  return (
    <div className="run-modal-backdrop">
      <div
        ref={dialogRef}
        className={`run-modal run-modal-${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-modal-title"
        tabIndex={-1}
        style={{ maxHeight: '90vh', overflowY: 'auto' }}
      >
        {!running && (
          <button type="button" className="run-modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
        <div className="run-modal-head" aria-live="polite">
          <span className="run-modal-icon" aria-hidden="true">
            {running ? <span className="spinner-lg" /> : variant === 'completed' ? '✓' : '✕'}
          </span>
          <h2 id="run-modal-title">{title}</h2>
          <p className="run-modal-sub">
            {running
              ? 'All configurations run at the same time. Please wait.'
              : 'Each configuration has its own result and report below.'}
          </p>
          {running && <p className="run-modal-elapsed">Elapsed: {formatElapsed(batch.startedAt)}</p>}
        </div>

        {configs.map((c) => {
          const run = c.run;
          const summary = run?.summary;
          const isSql = c.apiType === 'SQL';
          const label = c.status === 'completed' ? 'Completed' : c.status === 'failed' ? 'Failed' : c.status === 'stopped' ? 'Stopped' : c.status === 'running' ? 'Running…' : c.status === 'starting' ? 'Starting…' : 'Pending';
          return (
            <div key={c.index} data-testid={`batch-config-${c.index}`} style={{ borderTop: '1px solid #ddd', marginTop: 12, paddingTop: 8 }}>
              <h3>
                Test Configuration {c.index}: {c.applicationName} — {isSql ? 'Query Testing' : c.apiType} — {label}
              </h3>
              {run ? (
                <ConfigList run={run} />
              ) : (
                <ul className="params">
                  <li><span>Application</span><b>{c.applicationName}</b></li>
                  <li><span>API Type</span><b>{isSql ? 'Query Testing' : c.apiType}</b></li>
                  <li><span>CSV File</span><b>{c.csvName}</b></li>
                </ul>
              )}
              {c.runId && (
                <ExecutionQueue runId={c.runId} running={c.status === 'running'} isSql={isSql} />
              )}
              {c.status === 'completed' && summary && <ResultTiles summary={summary} isSql={isSql} />}
              {c.status === 'completed' && summary && summary.apiCalls > 0 && (
                <p className="run-modal-foot">
                  Passed {passedPct(summary)}% · Failed {summary.apiErrorPct}%
                </p>
              )}
              {(c.status === 'failed' || c.status === 'stopped') && c.error && <p className="run-modal-error">{c.error}</p>}
              {c.status === 'completed' && summary?.apiErrors > 0 && summary.topErrors?.length > 0 && (
                <p className="run-modal-error">
                  Most common error ({summary.topErrors[0].count}×): {errorText(summary.topErrors[0], isSql)}
                </p>
              )}
              {run?.outputFolder && (
                <p className="run-modal-foot">
                  JTL: {`bat\\output\\${run.outputFolder}\\results.jtl`}<br />
                  Report: {`bat\\output\\${run.outputFolder}\\dashboard\\index.html`}
                </p>
              )}
              {run?.logTail && c.status === 'failed' && (
                <details>
                  <summary>Show the last part of the execution output</summary>
                  <pre>{run.logTail}</pre>
                </details>
              )}
              <div className="run-modal-actions">
                {c.status === 'running' && c.runId && (
                  <button
                    type="button"
                    className="modal-btn modal-btn-secondary"
                    onClick={() => onStop({ runId: c.runId })}
                  >
                    Stop Execution
                  </button>
                )}
                {c.status === 'completed' && run?.reportUrl && (
                  <a className="modal-btn modal-btn-primary" href={run.reportUrl} target="_blank" rel="noreferrer">
                    Open Report
                  </a>
                )}
                {c.runId && (c.status === 'failed' || c.status === 'completed' || c.status === 'stopped') && (
                  <a className="modal-btn modal-btn-secondary" href={`/api/run/${c.runId}/log`} target="_blank" rel="noreferrer">
                    View Log
                  </a>
                )}
              </div>
            </div>
          );
        })}

        <div className="run-modal-actions">
          {running && <p className="run-modal-foot">Tests are running…</p>}
          {running && configs.filter((c) => c.status === 'running').length > 1 && (
            <button type="button" className="modal-btn modal-btn-secondary" onClick={() => onStop({ all: true })}>
              Stop All Executions
            </button>
          )}
          {stopMessage && <p className="run-modal-foot" role="status">{stopMessage}</p>}
          {!running && (
            <button ref={primaryRef} type="button" className="modal-btn modal-btn-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RunModal({ run, batch = null, onClose, onStop, stopMessage = null }) {
  const dialogRef = useRef(null);
  const primaryRef = useRef(null);
  const [, tick] = useState(0);

  const status = batch ? batch.status : run?.status;
  const running = status === 'running';
  const finished = Boolean(run || batch) && !running;

  // Elapsed time: re-render once a second while the test is running.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Focus moves into the dialog when it opens, and to its main action (Open
  // Report / View Log) when the run finishes.
  const open = Boolean(run || batch);
  useEffect(() => {
    if (!open) return;
    const target = finished ? primaryRef.current : null;
    (target ?? dialogRef.current)?.focus();
  }, [open, finished]);

  // Escape closes a finished run's dialog - never a running one.
  useEffect(() => {
    if (!finished) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished, onClose]);

  if (batch) return <BatchDialog batch={batch} dialogRef={dialogRef} primaryRef={primaryRef} running={running} onClose={onClose} onStop={onStop} stopMessage={stopMessage} />;

  if (!run) return null;

  const isSql = run.apiType === 'SQL';
  const summary = run.summary;
  // The test plan ran, but that says nothing about whether the APIs answered.
  const allFailed = status === 'completed' && summary && summary.apiCalls > 0 && summary.apiErrors === summary.apiCalls;
  const variant = running ? 'running' : status === 'completed' && !allFailed ? 'completed' : 'failed';

  let title;
  let subtitle;
  if (running) {
    title = 'Test Running…';
    subtitle = 'JMeter performance test is currently executing. Please wait.';
  } else if (status === 'stopped') {
    title = 'Execution Stopped';
    subtitle = 'The test was stopped before it finished. No report was kept for this run.';
  } else if (status === 'completed' && !allFailed) {
    title = 'Test Completed Successfully';
  } else if (status === 'completed') {
    title = isSql ? 'Test ran, but every query failed' : 'Test ran, but every API call failed';
    subtitle = 'The test finished, but none of the requests succeeded. The report has the details.';
  } else {
    title = 'Test Failed';
    subtitle = 'The JMeter test could not be completed successfully.';
  }

  return (
    <div className="run-modal-backdrop">
      <div
        ref={dialogRef}
        className={`run-modal run-modal-${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-modal-title"
        tabIndex={-1}
      >
        {finished && (
          <button type="button" className="run-modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}

        <div className="run-modal-head" aria-live="polite">
          <span className="run-modal-icon" aria-hidden="true">
            {running ? <span className="spinner-lg" /> : variant === 'completed' ? '✓' : '✕'}
          </span>
          <h2 id="run-modal-title">{title}</h2>
          {subtitle && <p className="run-modal-sub">{subtitle}</p>}
          {running && <p className="run-modal-elapsed">Elapsed: {formatElapsed(run.startedAt)}</p>}
        </div>

        {status === 'failed' && run.error && <p className="run-modal-error">{run.error}</p>}

        <ConfigList run={run} />

        <ExecutionQueue runId={run.id} running={running} isSql={isSql} />

        {status === 'completed' && summary && <ResultTiles summary={summary} isSql={isSql} />}

        {/* Query Testing: the SQL Server's own error for the most common
            failure (e.g. a login or connection failure fails every query with
            the same message), straight from the .jtl. */}
        {status === 'completed' && summary?.apiErrors > 0 && summary.topErrors?.length > 0 && (
          <p className="run-modal-error">
            Most common error ({summary.topErrors[0].count}×):{' '}
            {errorText(summary.topErrors[0], isSql)}
          </p>
        )}

        {status === 'failed' && run.logTail && (
          <details>
            <summary>Show the last part of the execution output</summary>
            <pre>{run.logTail}</pre>
          </details>
        )}

        <div className="run-modal-actions">
          {running && <p className="run-modal-foot">Test is running…</p>}

          {status === 'completed' && (
            <a
              ref={primaryRef}
              className="modal-btn modal-btn-primary"
              href={run.reportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Report
            </a>
          )}

          {running && (
            <button type="button" className="modal-btn modal-btn-secondary" onClick={() => onStop({ runId: run.id })}>
              Stop Execution
            </button>
          )}
          {stopMessage && <p className="run-modal-foot" role="status">{stopMessage}</p>}

          {(status === 'failed' || status === 'stopped') && (
            <a
              ref={primaryRef}
              className="modal-btn modal-btn-primary"
              href={`/api/run/${run.id}/log`}
              target="_blank"
              rel="noreferrer"
            >
              View Log
            </a>
          )}

          {finished && (
            <button type="button" className="modal-btn modal-btn-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
