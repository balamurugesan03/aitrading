import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useLocation, Link } from 'react-router-dom';
import {
  Home as HomeIcon, LayoutDashboard, CandlestickChart, Radar, Bot, FlaskConical, MessageSquareText, History, Settings,
  PieChart, Globe2, Library, NotebookPen, BrainCircuit, ShieldCheck, OctagonX, Power, Bell, Users, Store,
  UserCircle, Code2, Crown, LogOut, Download, Layers, Menu, X, Eye, EyeOff, Info,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { useBinanceStream, useLocalState } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { Seg, Spinner } from './ui.jsx';
import { SidebarTradingStatus } from './TradingStatus.jsx';
import { fmtPrice, fmtPct, baseOf, ago } from '../lib/format.js';

// simple: shown in the "Simple view" sidebar (the default). help: the one-line "what is this page" shown above every page.
const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon, group: 'Overview', simple: true, tab: 'Home' },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview', simple: true, tab: 'Dashboard', help: 'Your control center: money, profit/loss, what is ON, and your bots at a glance.' },
  { to: '/history', label: 'P&L History', icon: History, group: 'Overview', simple: true, tab: 'P&L', help: 'How much you invested, how much came back, profit or loss - and why. Pick any time range.' },
  { to: '/portfolio', label: 'Portfolio AI', icon: PieChart, group: 'Overview', help: 'What you hold, how it is spread, and how risky the mix is.' },
  { to: '/bots', label: 'My AI Bots', icon: Bot, group: 'Trade', simple: true, tab: 'Bots', help: 'Create, start and stop the bots that trade for you. Start in Paper mode to practise with fake money.' },
  { to: '/terminal', label: 'AI Terminal', icon: CandlestickChart, group: 'Trade', simple: true, tab: 'Trade', help: 'Chart + AI signal for one coin. Buy or sell by hand here.' },
  { to: '/scanner', label: 'AI Scanner', icon: Radar, group: 'Trade', help: 'Scans many coins and lists the best setups right now.' },
  { to: '/options', label: 'Options (NSE)', icon: Layers, group: 'Trade', help: 'NSE index options as defined-risk strategies.' },
  { to: '/intel', label: 'Market Intel', icon: Globe2, group: 'Trade', help: 'News, futures data and market mood that feed the AI.' },
  { to: '/copy', label: 'Copy Trading', icon: Users, group: 'Automate', help: 'Copy another trader\'s bot, or share yours.' },
  { to: '/strategies', label: 'Strategy Library', icon: Library, group: 'Automate', help: 'All strategies with their tested results.' },
  { to: '/marketplace', label: 'Marketplace', icon: Store, group: 'Automate', help: 'Build, publish and install strategies.' },
  { to: '/backtest', label: 'Backtest Lab', icon: FlaskConical, group: 'Automate', help: 'Test a strategy on past prices before using real money.' },
  { to: '/assistant', label: 'AI Assistant', icon: MessageSquareText, group: 'Intelligence', help: 'Ask the AI anything about the market or your trades.' },
  { to: '/journal', label: 'Trade Journal', icon: NotebookPen, group: 'Intelligence', help: 'AI review of every closed trade and your repeat mistakes.' },
  { to: '/learning', label: 'Learning Loop', icon: BrainCircuit, group: 'Intelligence', help: 'How accurate the AI has been, and model upgrades waiting for approval.' },
  { to: '/risk', label: 'Risk & Safety', icon: ShieldCheck, group: 'Account', simple: true, help: 'Safety limits: max loss per day, position size, leverage. The bots never break these.' },
  { to: '/account', label: 'Account & Exchanges', icon: UserCircle, group: 'Account', simple: true, help: 'Connect Binance / Zerodha API keys (needed for live trading), password, 2FA and Telegram alerts.' },
  { to: '/api-docs', label: 'Developer API', icon: Code2, group: 'Account', help: 'API keys and docs for your own scripts.' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'Account', simple: true, help: 'Paper wallet reset and server settings.' },
  { to: '/admin', label: 'Admin Panel', icon: Crown, group: 'Admin', admin: true, simple: true, help: 'Whole-platform health, users and controls.' },
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

const TABS = ['/', '/terminal', '/bots', '/history'];

export default function Layout() {
  const { mode, setMode, status, user, branding, exchange, setExchange } = useApp();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    setDrawer(false);
    try { localStorage.setItem(`nexus.seen.${loc.pathname}`, '1'); } catch { /* storage unavailable */ } // ticks the Dashboard setup checklist
  }, [loc.pathname]);
  useEffect(() => {
    document.body.classList.toggle('no-scroll', drawer);
    const esc = (e) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drawer]);
  const [simple, setSimple] = useLocalState('nexus.simpleNav', true);
  const allNav = NAV.filter((n) => !n.admin || user?.role === 'admin');
  // Simple view: only the everyday pages (and the page you are on, if it is an advanced one).
  const current = allNav.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)));
  const nav = simple ? allNav.filter((n) => n.simple || n === current) : allNav;
  const groups = [...new Set(nav.map((n) => n.group))];
  const GROUP_LABEL = simple ? { Overview: 'Home', Trade: 'Trade', Account: 'Setup', Admin: 'Admin', Automate: 'More', Intelligence: 'More' } : {};
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
              <div className="nav-label">{GROUP_LABEL[g] || g}</div>
              {nav.filter((n) => n.group === g).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                  <n.icon size={17} /> {n.label}
                </NavLink>
              ))}
            </div>
          ))}
          <button type="button" className="nav-toggle" onClick={() => setSimple(!simple)} title={simple ? 'Show every page (scanner, backtest, journal, marketplace…)' : 'Show only the everyday pages'}>
            {simple ? <><Eye size={15} /> Show all features ({allNav.length - nav.length} more)</> : <><EyeOff size={15} /> Simple view</>}
          </button>
        </nav>
        <div className="sidebar-foot col" style={{ gap: 6, marginTop: 10 }}>
          <div className="row between"><span className="muted">Auto-trading</span><span className="row" style={{ gap: 6 }}><span className={`dot ${!halted ? 'live' : 'bad'}`} />{!halted ? 'On' : 'Halted'}</span></div>
          <SidebarTradingStatus />
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
          <span title="Paper = practice with fake money. Live = real orders on your connected exchange." style={{ display: 'contents' }}><Seg className="mode tb-mode" value={mode} onChange={setMode} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></span>
          <InstallButton />
          <Notifications />
          <UserMenu />
          <KillSwitch />
        </header>
        <nav className="tabbar">
          {TABS.map((to) => nav.find((n) => n.to === to)).filter(Boolean).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}><n.icon size={20} /><span>{n.tab || n.label}</span></NavLink>
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
            {mode === 'live' && <div className="alert warn">LIVE mode: orders use the exchange API keys you connected under Account &amp; Exchanges. Testnet connections trade fake funds; live connections trade REAL money.</div>}
          </div>
        )}
        <main className="content">
          {current?.help && <div className="page-help"><Info size={14} /> <span>{current.help}</span></div>}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
