// Browser API client — relative URLs only (preview/proxy safe).
let csrfToken = null;
export const setCsrf = (t) => { csrfToken = t; };

// Header-session fallback (only used when the server returns a sessionToken, i.e. HEADER_SESSIONS=true).
const TOKEN_KEY = 'cs_session_token';
let sessionToken = null;
try { sessionToken = sessionStorage.getItem(TOKEN_KEY); } catch { /* storage blocked in sandboxed frame */ }
export function setSessionToken(t) {
  sessionToken = t || null;
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* memory only */ }
}

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body || {}; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (sessionToken) headers['X-Session-Token'] = sessionToken;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(navigator.onLine === false ? 'You appear to be offline. Check your connection and retry.' : 'Could not reach the server. Retry in a moment.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (data && data.sessionToken) setSessionToken(data.sessionToken);
  if (res.status === 401 && sessionToken && path !== '/api/auth/login') setSessionToken(null);
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

/** GET a text/file response (exports) with the same auth headers as api(). */
export async function apiText(path) {
  const headers = {};
  if (sessionToken) headers['X-Session-Token'] = sessionToken;
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json()).error || m; } catch { /* */ } throw new ApiError(m, res.status); }
  return res.text();
}
