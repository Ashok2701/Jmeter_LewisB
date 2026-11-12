'use client';

import { useEffect, useRef, useState } from 'react';

// The live API execution queue of one run. It presents what the server reads
// from JMeter's own results (/api/run/<id>/queue -> lib/queue.js); nothing here
// decides or simulates a status. Polls while the run is running, then once more
// after it ends so the final statuses are shown.

const QUEUE_POLL_MS = 1000;

const STATUS_LABEL = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
};

const THREAD_STATUS_LABEL = {
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  notrun: 'Not run',
};

export default function ExecutionQueue({ runId, running, isSql = false }) {
  const [queue, setQueue] = useState(null);
  const listRef = useRef(null);
  const noun = isSql ? 'Queries' : 'APIs';

  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/run/${runId}/queue`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.queue) setQueue(data.queue);
      } catch {
        // Transient fetch failure - the next poll retries.
      }
    };

    load();
    if (!running) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(load, QUEUE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId, running]);

  // Keep the API being executed in view inside the list.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector('[data-status="running"]');
    if (!list || !active) return;
    list.scrollTop = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
  }, [queue]);

  if (!queue?.available) return null;

  const { counts, progress, current, items } = queue;
  const stats = [
    ['Total', queue.total, ''],
    ['Pending', counts.pending, ''],
    ['Running', counts.running, 'queue-stat-run'],
    ['Passed', counts.passed, 'queue-stat-ok'],
    ['Failed', counts.failed, counts.failed > 0 ? 'queue-stat-bad' : ''],
  ];
  if (counts.skipped > 0) stats.push(['Skipped', counts.skipped, '']);

  const multiRun = progress.executions.total > progress.total - counts.skipped;

  return (
    <section className="queue" aria-label={`${noun} execution queue`}>
      <h3 className="queue-title">{isSql ? 'Query' : 'API'} Execution Queue</h3>

      <div className="queue-stats" style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
        {stats.map(([label, value, tone]) => (
          <div key={label} className={`queue-stat ${tone}`}>
            <span className="queue-stat-label">{label}</span>
            <span className="queue-stat-value">{value}</span>
          </div>
        ))}
      </div>

      <div
        className="queue-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <div className="queue-bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="queue-progress-text">
        {progress.completed} of {progress.total} {noun} completed · {progress.percent}%
        {multiRun && ` · ${progress.executions.done} of ${progress.executions.total} executions`}
      </p>

      {queue.running && (
        <p className="queue-current" aria-live="polite">
          {current.length > 0
            ? `Now executing: ${current.join(', ')}`
            : queue.started
              ? 'Moving to the next one…'
              : 'Starting JMeter…'}
        </p>
      )}

      {/* Which user type and user code every thread of the run uses (the same
          assignment the threads follow - see lib/rolePlan.js buildThreadPlan),
          and what each is doing now. Only runs that have such a listing. */}
      {queue.threads?.length > 0 && (
        <>
          <h4 className="queue-subtitle">Threads · User Type &amp; User Code</h4>
          <div className="queue-threads">
            <table>
              <thead>
                <tr>
                  <th>Thread</th>
                  <th>User Type</th>
                  <th>User Code</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.threads.map((thread, i) => (
                  <tr key={i} data-status={thread.status}>
                    <td>{thread.label}</td>
                    <td>{thread.userType}</td>
                    <td className="queue-code">
                      {thread.codes?.length ? (
                        thread.codes.map((c) => (
                          <span key={c.userType} className="queue-code-line">
                            {c.userType}: <b>{c.userCode}</b>
                          </span>
                        ))
                      ) : thread.userCode ? (
                        <b>{thread.userCode}</b>
                      ) : (
                        <span title="This user type's APIs use fixed values, not a user code">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`queue-badge ${
                          thread.status === 'running'
                            ? 'queue-badge-running'
                            : thread.status === 'done'
                              ? 'queue-badge-passed'
                              : ''
                        }`}
                      >
                        {thread.status === 'running' && <span className="queue-dot" aria-hidden="true" />}
                        {THREAD_STATUS_LABEL[thread.status]}
                      </span>
                      {thread.status === 'running' && thread.current && (
                        <small className="queue-thread-api" title={thread.current}>
                          {thread.current}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ol className="queue-list" ref={listRef}>
        {items.map((item) => (
          <li key={item.order} className="queue-item" data-status={item.status}>
            <span className="queue-order">{item.order}</span>
            <span className="queue-name" title={item.error || item.name}>
              {item.name}
              {item.error && <small className="queue-error">{item.error}</small>}
            </span>
            {item.expected > 1 && (
              <span className="queue-runs">
                {item.executed}/{item.expected}
              </span>
            )}
            <span className={`queue-badge queue-badge-${item.status}`}>
              {item.status === 'running' && <span className="queue-dot" aria-hidden="true" />}
              {STATUS_LABEL[item.status]}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
