'use client';

import { useEffect, useRef, useState } from 'react';

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
  return (
    <ul className="params">
      <li><span>Application</span><b>{run.applicationName}</b></li>
      <li><span>API Type</span><b>{isSql ? 'Query Testing' : run.apiType}</b></li>
      {isSql && run.dbServer && <li><span>Database</span><b>{run.dbServer}</b></li>}
      <li><span>CSV File</span><b>{run.csvName}</b></li>
      <li><span>{isSql ? 'Total Queries' : 'Total APIs'}</span><b>{run.csvRows}</b></li>
      <li><span>Threads</span><b>{run.threads}</b></li>
      <li><span>Ramp-up Time</span><b>{run.rampup} seconds</b></li>
      <li><span>Loops</span><b>{run.loops}</b></li>
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

export default function RunModal({ run, onClose }) {
  const dialogRef = useRef(null);
  const primaryRef = useRef(null);
  const [, tick] = useState(0);

  const status = run?.status;
  const running = status === 'running';
  const finished = Boolean(run) && !running;

  // Elapsed time: re-render once a second while the test is running.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Focus moves into the dialog when it opens, and to its main action (Open
  // Report / View Log) when the run finishes.
  const open = Boolean(run);
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

        {status === 'completed' && summary && <ResultTiles summary={summary} isSql={isSql} />}

        {/* Query Testing: the SQL Server's own error for the most common
            failure (e.g. a login or connection failure fails every query with
            the same message), straight from the .jtl. */}
        {status === 'completed' && isSql && summary?.apiErrors > 0 && summary.topErrors?.length > 0 && (
          <p className="run-modal-error">
            Most common error ({summary.topErrors[0].count}×):{' '}
            {summary.topErrors[0].message || summary.topErrors[0].code}
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

          {status === 'failed' && (
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
