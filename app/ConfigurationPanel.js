'use client';

import { useCallback, useEffect, useState } from 'react';

import { MAX_USERS_PER_GROUP } from '@/lib/applications';

// One card per credential group. Each card holds up to MAX_USERS_PER_GROUP
// logins (User 1, User 2, ...): a multi-user run gives JMeter thread 1 the
// first, thread 2 the second. Usernames are shown so they can be checked and
// edited; the password fields are always empty - a saved password is never
// sent back to the browser, only the fact that one is saved.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatSaved(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hours = d.getHours();
  const h12 = String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, '0');
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

// The card's editable rows: one per slot, usernames from what is saved and
// every password empty.
function slotsFor(group) {
  return Array.from({ length: MAX_USERS_PER_GROUP }, (_, i) => ({
    username: group.users?.[i]?.username ?? '',
    password: '',
  }));
}

function CredentialCard({ group, onSaved }) {
  const [slots, setSlots] = useState(() => slotsFor(group));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }

  const savedCount = group.users?.length ?? 0;

  const update = (index, field, value) =>
    setSlots((current) => current.map((slot, i) => (i === index ? { ...slot, [field]: value } : slot)));

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setMessage(null);

      for (const [i, slot] of slots.entries()) {
        const blank = !slot.username.trim() && !slot.password;
        if (blank && i > 0) continue; // extra users are optional
        if (!slot.username.trim()) {
          setMessage({ kind: 'error', text: `Please enter the username for user ${i + 1}.` });
          return;
        }
        if (!slot.password && i >= savedCount) {
          setMessage({ kind: 'error', text: `Please enter the password for user ${i + 1}.` });
          return;
        }
      }

      setSaving(true);
      try {
        const res = await fetch('/api/credentials', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            groupId: group.id,
            users: slots.map((slot) => ({ username: slot.username.trim(), password: slot.password })),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setMessage({ kind: 'error', text: data.error || 'The credentials could not be saved.' });
          return;
        }
        // Never keep the typed passwords in the page once they are saved.
        setSlots(slotsFor(data.group));
        setMessage({
          kind: 'ok',
          text: `Credentials saved (${data.group.users.length} user${data.group.users.length === 1 ? '' : 's'}). They will be used automatically for ${group.applications.join(' and ')}.`,
        });
        onSaved(data.group);
      } catch (err) {
        setMessage({ kind: 'error', text: `The credentials could not be saved: ${err.message}` });
      } finally {
        setSaving(false);
      }
    },
    [group, slots, savedCount, onSaved]
  );

  return (
    <section className="panel credential-card">
      <div className="panel-header">
        <h2 className="panel-title">{group.label}</h2>
        <p className="panel-subtitle">
          Logins used for {group.usedFor ?? `${group.applications.join(' and ')} REST and SOAP test runs`}.
          Thread 1 uses user 1, thread 2 uses user 2.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate autoComplete="off">
        {slots.map((slot, i) => {
          const saved = i < savedCount;
          return (
            <fieldset key={i} className="credential-user" disabled={saving}>
              <legend>{i === 0 ? 'User 1' : `User ${i + 1} (optional)`}</legend>

              <div className="field">
                <label htmlFor={`cred-user-${group.id}-${i}`}>Username</label>
                <input
                  id={`cred-user-${group.id}-${i}`}
                  type="text"
                  autoComplete="off"
                  value={slot.username}
                  onChange={(e) => update(i, 'username', e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor={`cred-pass-${group.id}-${i}`}>Password</label>
                <input
                  id={`cred-pass-${group.id}-${i}`}
                  type="password"
                  autoComplete="new-password"
                  placeholder={saved ? 'Saved - leave empty to keep it' : ''}
                  value={slot.password}
                  onChange={(e) => update(i, 'password', e.target.value)}
                />
                <span className="field-desc">
                  {saved
                    ? `A password is saved${i === 0 && group.updatedAt ? ` (last saved ${formatSaved(group.updatedAt)})` : ''}. It is stored encrypted and never shown.`
                    : 'No login is saved yet.'}
                </span>
              </div>
            </fieldset>
          );
        })}

        <p className="hint credential-csv-note">
          Saving also updates <code>credentials\{group.usersCsv}</code>, the file JMeter reads the
          users from. It holds the passwords in plain text, so keep it out of version control and
          off shared drives.
        </p>

        {message && (
          <div
            className={message.kind === 'ok' ? 'success-banner' : 'error-banner'}
            role={message.kind === 'ok' ? 'status' : 'alert'}
          >
            {message.text}
          </div>
        )}

        <button type="submit" className="primary-action credential-save" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}

export default function ConfigurationPanel() {
  const [groups, setGroups] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/credentials', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'The saved credentials could not be loaded.');
        return;
      }
      setGroups(data.groups);
    } catch (err) {
      setLoadError(`The saved credentials could not be loaded: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = useCallback((saved) => {
    setGroups((current) => current?.map((g) => (g.id === saved.id ? saved : g)) ?? current);
  }, []);

  return (
    <div className="configuration-page">
      <div className="panel-header configuration-header">
        <h1 className="page-title">Configuration</h1>
        <p className="panel-subtitle">
          Save the logins each application uses for REST and SOAP test runs. They are used
          automatically on every run, so they are never entered on the Test Run page. With more than
          one user saved, each JMeter thread runs as its own user.
        </p>
      </div>

      {loadError && (
        <div className="error-banner" role="alert">
          {loadError}
        </div>
      )}
      {!groups && !loadError && <p className="hint">Loading…</p>}

      {groups && (
        <div className="credential-grid">
          {groups.map((group) => (
            <CredentialCard key={group.id} group={group} onSaved={handleSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
