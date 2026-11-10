import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, authEvents, getToken, setToken } from './api.js';
import { fmtMoney, FX_PAIRS, INDEX_FUTURES, isCryptoSymbol } from './format.js';
import { useLocalState, useServerEvents } from './hooks.js';

const Ctx = createContext(null);

const DEFAULT_BRANDING = { appName: 'VelocityX', tagline: 'Crypto Trading', logoText: 'VX', primary: '#2f8cff', accent: '#ff9a3c', poweredBy: true };

function applyBranding(b) {
  const root = document.documentElement;
  root.style.setProperty('--accent', b.primary);
  root.style.setProperty('--accent-2', b.accent);
  const hex = b.primary.replace('#', '');
  const [r, g, bl] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  root.style.setProperty('--accent-glow', `rgba(${r},${g},${bl},0.25)`);
  document.title = `${b.appName}${b.tagline ? ` · ${b.tagline}` : ''}`;
}

export function AppProvider({ children }) {
  const navigate = useNavigate();
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState(null);
  const [branding, setBranding] = useState(DEFAULT_BRANDING);
  const [mode, setMode] = useLocalState('nexus.mode', 'paper');
  const [exchange, setExchange] = useLocalState('nexus.exchange', 'binance');
  const [symbol, setSymbol] = useLocalState('nexus.symbol', 'BTCUSDT');
  const [interval, setInterval_] = useLocalState('nexus.interval', '1h');
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4800);
  }, []);

  const refreshMe = useCallback(() => api.get('/auth/me').then(setMe).catch(() => {}), []);
  const refreshStatus = useCallback(() => api.get('/status').then(setStatus).catch((e) => e.status !== 401 && setStatus({ offline: true })), []);

  useEffect(() => {
    fetch('/api/branding').then((r) => r.json()).then((b) => { setBranding(b); applyBranding(b); }).catch(() => applyBranding(DEFAULT_BRANDING));
    const onChange = () => setAuthed(Boolean(getToken()));
    authEvents.addEventListener('change', onChange);
    return () => authEvents.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!authed) { setMe(null); setStatus(null); return undefined; }
    refreshMe();
    refreshStatus();
    const id = setInterval(() => { refreshStatus(); refreshMe(); }, 30000);
    return () => clearInterval(id);
  }, [authed, refreshMe, refreshStatus]);

  useServerEvents((type, p) => {
    if (type === 'settings' || type === 'killswitch' || type === 'platform') refreshStatus();
    if (type === 'platform' && p.branding) { setBranding(p.branding); applyBranding(p.branding); }
    if (type === 'health') setStatus((s) => (s ? { ...s, health: p } : s));
    if (type === 'killswitch') toast(`Kill switch: ${p.stopped} bots stopped, ${p.closed.length} positions closed`, 'err');
    if (type === 'notification') {
      setMe((m) => (m ? { ...m, unread: (m.unread || 0) + 1 } : m));
      toast(p.title, p.type === 'loss' || p.type === 'warn' ? 'err' : 'ok');
      try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(p.title, { body: p.body, icon: '/icon-192.png' });
      } catch { /* notifications unavailable */ }
    }
  });

  // The top-bar exchange decides the market and account: crypto (USDT), NSE forex or NSE stocks (INR, via Zerodha).
  const exInfo = status?.exchanges?.find((e) => e.id === exchange) || null;
  const market = exInfo?.market || 'crypto';
  const currency = exInfo?.currency || 'USDT';
  useEffect(() => {
    if (!exInfo) return;
    if (market === 'forex' && !FX_PAIRS.includes(symbol)) setSymbol('USDINR');
    if (market === 'stocks' && (FX_PAIRS.includes(symbol) || INDEX_FUTURES.includes(symbol) || isCryptoSymbol(symbol))) setSymbol('RELIANCE');
    if (market === 'futures' && (FX_PAIRS.includes(symbol) || isCryptoSymbol(symbol))) setSymbol('NIFTY');
    if ((market === 'crypto' || market === 'perps') && !isCryptoSymbol(symbol)) setSymbol('BTCUSDT');
    if (!exInfo.intervals.includes(interval)) setInterval_(exInfo.intervals.includes('15m') ? '15m' : exInfo.intervals[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exInfo?.id]);
  const money = useCallback((v, d) => fmtMoney(v, currency, d), [currency]);

  const login = (session) => { setToken(session.token); setMe((m) => ({ ...(m || {}), user: session.user })); navigate('/'); };
  const logout = () => { setToken(null); navigate('/'); };
  const user = me?.user;

  return (
    <Ctx.Provider value={{
      authed, me, user, refreshMe, login, logout, branding, setBranding,
      status, refreshStatus, mode, setMode, exchange, setExchange, exInfo, market, currency, money, symbol, setSymbol, interval, setInterval: setInterval_, toast,
    }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' ? <CheckCircle2 size={16} className="up" /> : <AlertTriangle size={16} className="down" />}
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useApp = () => useContext(Ctx);
