// Super Admin API client. Its token is stored separately from the trading session, so both can be signed in
// at once in the same browser and signing out of one never affects the other.
import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'nexus.sa.token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }

export const saEvents = new EventTarget();
export const getSaToken = () => token;
export function setSaToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
  saEvents.dispatchEvent(new Event('change'));
}

async function req(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/superadmin${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && url !== '/auth/login') setSaToken(null);
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

export const saApi = {
  get: (u) => req('GET', u),
  post: (u, b = {}) => req('POST', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};

export function useSa(url, ms = 0) {
  const [data, setData] = useState(null);
  const load = useCallback(() => saApi.get(url).then(setData).catch(() => {}), [url]);
  useEffect(() => {
    load();
    if (!ms) return undefined;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, ms]);
  return [data, load];
}
