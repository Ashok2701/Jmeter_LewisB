'use client';

import { useEffect, useState } from 'react';

// Header widget: who is signed in + Sign out. It also keeps the signed-in page
// honest: any /api response of 401 (session expired or signed out in another
// tab) sends the browser to the login page, and a page restored from the
// back/forward cache re-checks the session first.
export default function SessionControls() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const toLogin = () => window.location.replace('/login');
    const originalFetch = window.fetch;

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.status === 401) {
        const input = args[0];
        const raw = typeof input === 'string' ? input : input?.url || '';
        const apiPath = new URL(raw, window.location.href).pathname;
        if (apiPath.startsWith('/api/') && !apiPath.startsWith('/api/auth/login')) toLogin();
      }
      return response;
    };

    const check = () =>
      originalFetch('/api/auth/me', { cache: 'no-store' })
        .then(async (res) => {
          if (res.status === 401) return toLogin();
          const data = await res.json();
          setUsername(data?.user?.username || '');
        })
        .catch(() => {});

    check();
    const onPageShow = (event) => {
      if (event.persisted) check();
    };
    window.addEventListener('pageshow', onPageShow);

    return () => {
      window.fetch = originalFetch;
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.replace('/login');
    }
  }

  return (
    <div className="session-controls">
      {username && <span className="session-user">{username}</span>}
      <button type="button" className="session-logout" onClick={signOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
