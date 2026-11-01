import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useLocation, Link } from 'react-router-dom';
import {
  LayoutDashboard, CandlestickChart, Radar, Bot, FlaskConical, MessageSquareText, History, Settings,
  PieChart, Globe2, Library, NotebookPen, BrainCircuit, ShieldCheck, OctagonX, Power, Bell, Users, Store,
  UserCircle, Code2, Crown, LogOut, Download, Layers, Menu, X,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { useBinanceStream } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { Seg, Spinner } from './ui.jsx';
import { fmtPrice, fmtPct, baseOf, ago } from '../lib/format.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { to: '/portfolio', label: 'Portfolio AI', icon: PieChart, group: 'Overview' },
  { to: '/terminal', label: 'AI Terminal', icon: CandlestickChart, group: 'Trade' },
  { to: '/scanner', label: 'AI Scanner', icon: Radar, group: 'Trade' },
  { to: '/options', label: 'Options (NSE)', icon: Layers, group: 'Trade' },
  { to: '/intel', label: 'Market Intel', icon: Globe2, group: 'Trade' },
  { to: '/bots', label: 'Bot Manager', icon: Bot, group: 'Automate' },
  { to: '/copy', label: 'Copy Trading', icon: Users, group: 'Automate' },
  { to: '/strategies', label: 'Strategy Library', icon: Library, group: 'Automate' },
  { to: '/marketplace', label: 'Marketplace', icon: Store, group: 'Automate' },
  { to: '/backtest', label: 'Backtest Lab', icon: FlaskConical, group: 'Automate' },
  { to: '/assistant', label: 'AI Assistant', icon: MessageSquareText, group: 'Intelligence' },
  { to: '/journal', label: 'Trade Journal', icon: NotebookPen, group: 'Intelligence' },
  { to: '/learning', label: 'Learning Loop', icon: BrainCircuit, group: 'Intelligence' },
  { to: '/risk', label: 'Risk Manager', icon: ShieldCheck, group: 'Account' },
  { to: '/history', label: 'Trade History', icon: History, group: 'Account' },
  { to: '/account', label: 'Account & Security', icon: UserCircle, group: 'Account' },
  { to: '/api-docs', label: 'Developer API', icon: Code2, group: 'Account' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'Account' },
  { to: '/admin', label: 'Admin Panel', icon: Crown, group: 'Admin', admin: true },
];

const STRIP = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TONUSDT'];

function TickerStrip() {
  const [t, setT] = useState({});
  useBinanceStream(STRIP.map((s) => `${s.toLowerCase()}@miniTicker`), (d) =>
    setT((prev) => ({ ...prev, [d.s]: { price: +d.c, change: ((+d.c - +d.o) / +d.o) * 100 } })),
  );
  return (
    <div className="ticker-strip">
      {STRIP.map((s) => (
        <span key={s}>
          <b>{baseOf(s)}</b>{' '}
          <span className="mono">{t[s] ? fmtPrice(t[s].price) : '…'}</span>{' '}
          <span className={`mono ${t[s]?.change >= 0 ? 'up' : 'down'}`}>{t[s] ? fmtPct(t[s].change) : ''}</span>
        </span>
      ))}
    </div>
  );
}

function useClickAway(onAway) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && onAway();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onAway]);
  return ref;
}

function KillSwitch() {
  const { status, refreshStatus, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const enabled = status?.tradingEnabled !== false || status?.platformHalt;
  const run = async () => {
    if (enabled && !confirm('KILL SWITCH\n\nStop ALL your bots, cancel open orders, close ALL bot positions and disable auto-trading?')) return;
    setBusy(true);
    try {
      if (enabled) await api.post('/killswitch', { reason: 'Manual kill switch' });
      else {
        await api.post('/trading/resume');
        toast('Auto-trading re-enabled. Start bots manually.');
      }
      refreshStatus();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };
  return enabled ? (
    <button className="btn kill tb-kill" onClick={run} disabled={busy} title="Stop all bots, cancel orders, close positions, disable auto-trading">
      {busy ? <Spinner /> : <OctagonX size={15} />} <span className="hide-sm">Kill Switch</span>
    </button>
  ) : (
    <button className="btn primary tb-kill" onClick={run} disabled={busy}>{busy ? <Spinner /> : <Power size={15} />} <span className="hide-sm">Resume</span></button>
  );
}

function Notifications() {
  const { me, refreshMe } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const ref = useClickAway(() => setOpen(false));
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setItems(await api.get('/notifications').catch(() => []));
      if (me?.unread) { await api.post('/notifications/read-all').catch(() => {}); refreshMe(); }
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    }
  };
  return (
    <div className="tb-notif" style={{ position: 'relative' }} ref={ref}>
      <button className="btn ghost icon-btn icon-bubble" onClick={toggle} aria-label="Notifications">
        <Bell size={17} />{me?.unread > 0 && <span className="count">{me.unread > 99 ? '99+' : me.unread}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="card-title" style={{ padding: '6px 10px' }}>Notifications</div>
          {items.length ? items.map((n) => (
            <div key={n._id} className={`item ${n.read ? '' : 'unread'}`}>
              <span className={`small bold ${n.type === 'loss' || n.type === 'warn' ? 'down' : n.type === 'profit' ? 'up' : ''}`}>{n.title}</span>
              {n.body && <span className="tiny muted">{n.body}</span>}
              <span className="tiny dim">{ago(n.time)}</span>
            </div>
          )) : <div className="empty small">No notifications yet</div>}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <div className="tb-user" style={{ position: 'relative' }} ref={ref}>
      <button className="btn ghost" onClick={() => setOpen(!open)} style={{ padding: '5px 8px' }}>
        <span className="coin-icon" style={{ width: 28, height: 28, background: 'linear-gradient(135deg,var(--accent),var(--accent-2))' }}>{(user?.name || '?').slice(0, 1).toUpperCase()}</span>
      </button>
      {open && (
        <div className="dropdown" style={{ width: 260 }}>
          <div className="item"><span className="bold">{user?.name}</span><span className="tiny muted">{user?.email}</span></div>
          <div className="divider" />
          <Link className="item" to="/account" onClick={() => setOpen(false)}>Account &amp; security</Link>
          {user?.role === 'admin' && <Link className="item" to="/admin" onClick={() => setOpen(false)}>Admin panel</Link>}
          <button className="item down" onClick={logout}><span className="row" style={{ gap: 8 }}><LogOut size={14} /> Sign out</span></button>
        </div>
      )}
    </div>
  );
}

function InstallButton() {
  const [prompt, setPrompt] = useState(null);
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (!prompt) return null;
  return <button className="btn sm ghost tb-install" onClick={() => { prompt.prompt(); setPrompt(null); }} title="Install as an app"><Download size={14} /> <span className="hide-sm">Install app</span></button>;
}

const TABS = ['/', '/terminal', '/bots', '/portfolio'];

export default function Layout() {
  const { mode, setMode, status, user, branding, exchange, setExchange } = useApp();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    document.body.classList.toggle('no-scroll', drawer);
    const esc = (e) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drawer]);
  const nav = NAV.filter((n) => !n.admin || user?.role === 'admin');
  const current = nav.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)));
  const groups = [...new Set(nav.map((n) => n.group))];
  const exchangeDown = status?.health && status.health.exchangeUp === false;
  const halted = status?.tradingEnabled === false;

  return (
    <div className="app">
      {drawer && <div className="drawer-bg" onClick={() => setDrawer(false)} />}
      <aside className={`sidebar ${drawer ? 'open' : ''}`}>
        <button className="btn ghost icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu"><X size={18} /></button>
        <div className="brand">
          <img className="brand-img" src="/logo.png" alt={branding.appName} />
          <div>
            <div className="brand-name">{branding.appName}</div>
            <div className="brand-sub">{branding.tagline}</div>
          </div>
        </div>
        <nav className="nav" style={{ overflowY: 'auto', flex: 1 }}>
          {groups.map((g) => (
            <div key={g}>
              <div className="nav-label">{g}</div>
              {nav.filter((n) => n.group === g).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                  <n.icon size={17} /> {n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot col" style={{ gap: 6, marginTop: 10 }}>
          <div className="row between"><span className="muted">Auto-trading</span><span className="row" style={{ gap: 6 }}><span className={`dot ${!halted ? 'live' : 'bad'}`} />{!halted ? 'On' : 'Halted'}</span></div>
          <div className="row between"><span className="muted">Binance</span><span className="row" style={{ gap: 6 }}><span className={`dot ${exchangeDown ? 'bad' : 'live'}`} />{exchangeDown ? 'Down' : status?.health?.latencyMs ? `${status.health.latencyMs} ms` : 'OK'}</span></div>
          <div className="row between"><span className="muted">Claude AI</span><span className="row" style={{ gap: 6 }}><span className={`dot ${status?.claude ? 'live' : 'off'}`} />{status?.claude ? 'Online' : 'Off'}</span></div>
          <div className="row between"><span className="muted">Model</span><span>NN v{status?.modelVersion ?? '…'}</span></div>
          {branding.poweredBy && branding.appName !== 'VelocityX' && <div className="tiny dim">Powered by VelocityX</div>}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu size={20} /></button>
          <h1>{current?.label || branding.appName}</h1>
          <TickerStrip />
          <select className="select exchange-pick" style={{ width: 160, padding: '7px 28px 7px 10px' }} value={exchange} onChange={(e) => setExchange(e.target.value)} title="Exchange for market data, scanner and new bots">
            {(status?.exchanges || [{ id: 'binance', name: 'Binance' }]).filter((e) => e.market !== 'options').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <Seg className="mode tb-mode" value={mode} onChange={setMode} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} />
          <InstallButton />
          <Notifications />
          <UserMenu />
          <KillSwitch />
        </header>
        <nav className="tabbar">
          {TABS.map((to) => nav.find((n) => n.to === to)).filter(Boolean).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}><n.icon size={20} /><span>{n.label.replace(/^AI /, '').replace(' Manager', 's').replace(' AI', '')}</span></NavLink>
          ))}
          <button className={drawer ? 'active' : ''} onClick={() => setDrawer(true)}><Menu size={20} /><span>More</span></button>
        </nav>
        {(status?.offline || halted || exchangeDown || mode === 'live') && (
          <div className="content" style={{ paddingBottom: 0, gap: 10 }}>
            {status?.offline && <div className="alert error">Cannot reach the server. Start it with <code>npm run dev</code> in the server folder.</div>}
            {halted && (
              <div className="alert error"><OctagonX size={16} /> <span>
                <b>Auto-trading halted</b>{status.platformHalt ? ` by the platform — ${status.platformHalt}` : status.killSwitchReason ? ` — ${status.killSwitchReason}` : ''}. No new positions will open.{!status.platformHalt && ' Use “Resume” to re-enable.'}
              </span></div>
            )}
            {exchangeDown && <div className="alert warn">Binance is not responding. Bots skip trading until the exchange recovers.</div>}
            {mode === 'live' && <div className="alert warn">LIVE mode: orders use the exchange API keys you connected under Account &amp; Security. Testnet connections trade fake funds; live connections trade REAL money.</div>}
          </div>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
