'use client';

import { useRef, useState } from 'react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);

  async function onSubmit(event) {
    event.preventDefault();
    if (submitting.current) return;

    const errors = {};
    if (!username.trim()) errors.username = 'Enter your username.';
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    setError('');
    if (Object.keys(errors).length) return;

    submitting.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.ok) {
        window.location.replace('/');
        return; // keep the button disabled while the page navigates
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Sign-in failed. Please try again.');
      setPassword('');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    }
    submitting.current = false;
    setLoading(false);
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <div className="login-brand">
          <span className="brand-icon" aria-hidden="true">⚡</span>
          <div className="brand-text">
            <h1 className="login-title">Lewis Bakers - Tema App</h1>
            <span className="brand-tag">Performance Testing Platform</span>
          </div>
        </div>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <label className="login-field">
          <span>Username</span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            aria-invalid={Boolean(fieldErrors.username)}
          />
          {fieldErrors.username && <small className="login-field-error">{fieldErrors.username}</small>}
        </label>

        <label className="login-field">
          <span>Password</span>
          <div className="login-password">
            <input
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              aria-invalid={Boolean(fieldErrors.password)}
            />
            <button
              type="button"
              className="login-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          {fieldErrors.password && <small className="login-field-error">{fieldErrors.password}</small>}
        </label>

        <button type="submit" className="login-submit" disabled={loading}>
          {loading ? (
            <>
              <span className="login-spinner" aria-hidden="true" /> Signing in…
            </>
          ) : (
            'Login'
          )}
        </button>
      </form>
    </main>
  );
}
