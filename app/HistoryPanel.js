'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const API_TYPE_LABELS = { REST: 'REST', SOAP: 'SOAP', SQL: 'Query Testing' };
const STATUS_LABELS = { completed: 'Completed', failed: 'Failed', stopped: 'Stopped', running: 'Running' };
const REPORT_MISSING = 'Report file is no longer available.';

// Dates and times are shown in the browser's own time zone, from the run's
// recorded start time (ISO, UTC) - the moment the test was launched, not when
// its report was written.
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hours = d.getHours();
  const h12 = String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${h12}:${mm} ${hours < 12 ? 'AM' : 'PM'}`;
}

// yyyy-mm-dd in local time, the value format of <input type="date">.
function localDateKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function StatusBadge({ run }) {
  const label = STATUS_LABELS[run.status] ?? run.status;
  return (
    <span className={`history-badge history-badge-${run.status}`} title={run.interrupted ? run.error : undefined}>
      {label}
    </span>
  );
}

// The "Report" cell: a link when the report exists, a clear message when it
// was deleted, and a log link for a run that never produced a report.
function ReportActions({ run }) {
  return (
    <span className="history-actions">
      {run.reportState === 'available' && (
        <a className="history-link" href={run.reportUrl} target="_blank" rel="noreferrer">
          View Report
        </a>
      )}
      {run.reportState === 'missing' && <span className="history-muted">{REPORT_MISSING}</span>}
      {run.reportState === 'none' && !run.logUrl && <span className="history-muted">—</span>}
      {run.logUrl && run.reportState !== 'available' && (
        <a className="history-link" href={run.logUrl} target="_blank" rel="noreferrer">
          View Log
        </a>
      )}
    </span>
  );
}

// Asks before a run is removed from History. Same dialog look as the Test Run
// result (run-modal); Escape or Cancel keeps the run.
function DeleteDialog({ run, busy, error, onCancel, onConfirm }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="run-modal-backdrop">
      <div
        className="run-modal run-modal-failed"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="history-delete-title"
        aria-describedby="history-delete-desc"
      >
        <div className="run-modal-head">
          <h2 id="history-delete-title">Delete this run?</h2>
          <p id="history-delete-desc" className="run-modal-sub">
            It is removed from History together with its saved record and execution log. The
            generated report folder is not deleted.
          </p>
        </div>

        <ul className="params">
          <li><span>Date</span><b>{formatDate(run.startedAt)}</b></li>
          <li><span>Time</span><b>{formatTime(run.startedAt)}</b></li>
          <li><span>Application</span><b>{run.applicationName || '—'}</b></li>
          {run.batchId && (
            <li><span>Test Configuration</span><b>{run.batchIndex} of {run.batchSize} (batch {run.batchId.slice(0, 8)})</b></li>
          )}
          <li><span>API Type</span><b>{API_TYPE_LABELS[run.apiType] ?? run.apiType}</b></li>
        </ul>

        {error && <p className="run-modal-error">{error}</p>}

        <div className="run-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="modal-btn modal-btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="button" className="modal-btn modal-btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HistoryPanel() {
  const [runs, setRuns] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/history', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'The run history could not be loaded.');
        return;
      }
      setRuns(data.runs);
    } catch (err) {
      setLoadError(`The run history could not be loaded: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancelDelete = useCallback(() => {
    setToDelete(null);
    setDeleteError(null);
  }, []);

  // Deletes only the chosen run. A run the server no longer has (404) is
  // simply dropped from the list too.
  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/history/${toDelete.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || 'The run could not be deleted.');
        return;
      }
      setRuns((current) => current?.filter((run) => run.id !== toDelete.id) ?? current);
      setToDelete(null);
    } catch (err) {
      setDeleteError(`The run could not be deleted: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  }, [toDelete]);

  const filtered = useMemo(() => {
    if (!runs) return [];
    const needle = search.trim().toLowerCase();
    return runs.filter(
      (run) =>
        (!needle || run.applicationName.toLowerCase().includes(needle)) &&
        (!typeFilter || run.apiType === typeFilter) &&
        (!statusFilter || run.status === statusFilter) &&
        (!dateFilter || localDateKey(run.startedAt) === dateFilter)
    );
  }, [runs, search, typeFilter, statusFilter, dateFilter]);

  const filtersActive = Boolean(search || typeFilter || statusFilter || dateFilter);

  const clearFilters = () => {
    setSearch('');
    setTypeFilter('');
    setStatusFilter('');
    setDateFilter('');
  };

  return (
    <section className="panel history-panel">
      <div className="panel-header history-header">
        <div>
          <h2 className="panel-title">Run History</h2>
          <p className="panel-subtitle">
            Every test run is saved automatically, with its report and execution log.
          </p>
        </div>
        <button type="button" className="secondary-btn history-refresh" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="history-filters">
        <div className="field">
          <label htmlFor="historySearch">Application</label>
          <input
            id="historySearch"
            type="text"
            placeholder="Search by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="historyType">API Type</label>
          <select id="historyType" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All</option>
            <option value="REST">REST</option>
            <option value="SOAP">SOAP</option>
            <option value="SQL">Query Testing</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="historyStatus">Status</label>
          <select id="historyStatus" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="stopped">Stopped</option>
            <option value="running">Running</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="historyDate">Date</label>
          <input
            id="historyDate"
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
        </div>
      </div>

      {loadError && (
        <div className="error-banner" role="alert">
          {loadError}
        </div>
      )}

      {runs && (
        <p className="hint history-count" aria-live="polite">
          Showing {filtered.length} of {runs.length} run{runs.length === 1 ? '' : 's'}
          {filtersActive && (
            <>
              {' · '}
              <button type="button" className="history-clear" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          )}
        </p>
      )}

      {!runs && !loadError && <p className="hint">Loading history…</p>}

      {runs && runs.length === 0 && (
        <p className="hint">No runs yet. Run a test and it will appear here automatically.</p>
      )}

      {runs && runs.length > 0 && filtered.length === 0 && (
        <p className="hint">No runs match these filters.</p>
      )}

      {filtered.length > 0 && (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Application</th>
                <th>API Type</th>
                <th className="num">Threads</th>
                <th className="num">Loops</th>
                <th>Status</th>
                <th>Report</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => (
                <tr key={run.id}>
                  <td>{formatDate(run.startedAt)}</td>
                  <td>{formatTime(run.startedAt)}</td>
                  <td className="wrap">
                    {run.applicationName || '—'}
                    {run.batchId && (
                      <small title={`Batch ${run.batchId}`}> · Config {run.batchIndex}/{run.batchSize}</small>
                    )}
                  </td>
                  <td>{API_TYPE_LABELS[run.apiType] ?? run.apiType}</td>
                  <td className="num">{run.threads || '—'}</td>
                  <td className="num">{run.loops || '—'}</td>
                  <td>
                    <StatusBadge run={run} />
                  </td>
                  <td className="wrap report-cell">
                    <ReportActions run={run} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="history-delete"
                      onClick={() => setToDelete(run)}
                      disabled={run.status === 'running'}
                      title={run.status === 'running' ? 'A running test cannot be deleted' : undefined}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toDelete && (
        <DeleteDialog
          run={toDelete}
          busy={deleting}
          error={deleteError}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}
