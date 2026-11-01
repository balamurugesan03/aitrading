import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Bot, Activity, AlertTriangle, ScrollText, Palette, ServerCog, BrainCircuit, OctagonX } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { Tabs, Field, Switch, Spinner, Empty, Seg } from '../components/ui.jsx';
import { fmtTime, fmtUsd, fmtCompact, ago, tone } from '../lib/format.js';

function Overview() {
  const [o] = usePoll('/admin/overview', 30000);
  if (!o) return <div className="empty"><Spinner /></div>;
  return (
    <>
      <div className="grid g-2">
        <div className="card stat"><span className="stat-icon violet"><Bot size={18} /></span><span className="stat-label">Bots running</span><span className="stat-value">{o.bots.running}<span className="muted" style={{ fontSize: 16 }}> / {o.bots.total}</span></span><span className="stat-sub muted">{o.bots.live} live · {o.bots.paused} paused · {o.bots.openPositions} positions</span></div>
        <div className="card stat"><span className="stat-icon warn"><AlertTriangle size={18} /></span><span className="stat-label">Errors (24h)</span><span className={`stat-value ${o.errors24h ? 'down' : ''}`}>{o.errors24h}</span><span className="stat-sub muted">{o.trades.today} trades today · ${fmtCompact(o.trades.volumeUsd)} volume</span></div>
      </div>
      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><span className="card-title"><ServerCog size={14} /> System health</span></div>
          <div className="kv">
            <span>Binance</span><span className={o.health.exchangeUp ? 'up' : 'down'}>{o.health.exchangeUp ? 'Online' : 'Down'} · {o.health.latencyMs} ms</span>
            <span>Uptime</span><span>{Math.floor(o.process.uptimeSec / 3600)}h {Math.floor((o.process.uptimeSec % 3600) / 60)}m</span>
            <span>Memory</span><span>{o.process.memoryMb} MB</span>
            <span>Node</span><span>{o.process.node}</span>
            <span>Platform halt</span><span className={o.platform.haltAll ? 'down' : 'up'}>{o.platform.haltAll ? 'HALTED' : 'Off'}</span>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><BrainCircuit size={14} /> AI models</span><Link className="small" to="/learning">Manage →</Link></div>
          <div className="table-wrap"><table><thead><tr><th>Model</th><th>Status</th><th className="num">Accuracy</th><th className="num">OOS P&amp;L</th></tr></thead>
            <tbody>{o.models.map((m) => <tr key={m._id}><td className="small">{m.name}</td><td><span className={`badge ${m.status === 'production' ? 'up' : m.status === 'retired' ? 'flat' : 'warn'}`}>{m.status}</span></td><td className="num">{m.accuracy ?? '—'}{m.accuracy != null && '%'}</td><td className={`num ${tone(m.oosReturnPct)}`}>{m.oosReturnPct ?? '—'}{m.oosReturnPct != null && '%'}</td></tr>)}</tbody></table></div>
        </div>
      </div>
    </>
  );
}

function SimpleTable({ url, title, icon: Icon, cols }) {
  const [rows] = usePoll(url, 30000);
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">{Icon && <Icon size={14} />} {title}</span></div>
      {!rows ? <Spinner /> : rows.length ? (
        <div className="table-wrap"><table>
          <thead><tr>{cols.map(([h, , cls]) => <th key={h} className={cls}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r._id}>{cols.map(([h, f, cls]) => <td key={h} className={cls}>{f(r)}</td>)}</tr>)}</tbody>
        </table></div>
      ) : <Empty title="Nothing here yet" />}
    </div>
  );
}

function Platform() {
  const { branding, setBranding, toast } = useApp();
  const [b, setB] = useState(branding);
  const [o, , reload] = usePoll('/admin/overview');
  const [reason, setReason] = useState('Scheduled maintenance');
  useEffect(() => setB(branding), [branding]);
  const save = async () => { try { const nb = await api.put('/admin/branding', b); setBranding(nb); toast('Branding saved - applied for every user'); } catch (e) { toast(e.message, 'err'); } };
  const halt = async (on) => { if (on && !confirm('Halt new trades for ALL users?')) return; try { await api.post('/admin/halt', { haltAll: on, reason }); reload(); toast(on ? 'Platform halted' : 'Platform resumed', on ? 'err' : 'ok'); } catch (e) { toast(e.message, 'err'); } };
  const set = (k) => (v) => setB((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  return (
    <div className="grid g-2">
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title"><Palette size={14} /> White-label branding</div>
        <div className="grid g-2" style={{ gap: 12 }}>
          <Field label="App name"><input className="input" value={b.appName} onChange={set('appName')} /></Field>
          <Field label="Tagline"><input className="input" value={b.tagline} onChange={set('tagline')} /></Field>
          <Field label="Logo text (1-3 chars)"><input className="input" maxLength={3} value={b.logoText} onChange={set('logoText')} /></Field>
          <Field label="Support email"><input className="input" value={b.supportEmail || ''} onChange={set('supportEmail')} /></Field>
          <Field label="Primary colour"><input type="color" value={b.primary} onChange={set('primary')} style={{ width: '100%', height: 38, background: 'none', border: 'none' }} /></Field>
          <Field label="Accent colour"><input type="color" value={b.accent} onChange={set('accent')} style={{ width: '100%', height: 38, background: 'none', border: 'none' }} /></Field>
        </div>
        <div className="row between"><span className="small">Show “Powered by VelocityX”</span><Switch checked={b.poweredBy} onChange={set('poweredBy')} /></div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <img className="brand-img" src="/logo.png" alt={b.appName} />
          <div><div className="brand-name">{b.appName}</div><div className="brand-sub">{b.tagline}</div></div>
          <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={save}>Save branding</button>
        </div>
      </div>
      <div className="card col" style={{ gap: 12 }}>
        <div className="card-title"><OctagonX size={14} /> Platform-wide trading halt</div>
        <div className="small muted">Blocks new entries for every user (open positions stay protected by their stops). Use during exchange incidents or maintenance.</div>
        <Field label="Reason shown to users"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {o?.platform.haltAll
          ? <button className="btn primary" onClick={() => halt(false)}>Resume platform trading</button>
          : <button className="btn kill" onClick={() => halt(true)}>Halt all trading</button>}
        {o?.platform.haltAll && <div className="alert error small">Halted: {o.platform.haltReason}</div>}
      </div>
    </div>
  );
}

export default function Admin() {
  const { user } = useApp();
  const [tab, setTab] = useState('overview');
  const [errScope, setErrScope] = useState('errors');
  if (user?.role !== 'admin') return <div className="alert error">Admins only.</div>;
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview', icon: Crown },
        { value: 'bots', label: 'Bots', icon: Bot }, { value: 'trades', label: 'Trades', icon: Activity }, { value: 'logs', label: 'Errors & audit', icon: ScrollText }, { value: 'platform', label: 'Platform & branding', icon: Palette },
      ]} />
      {tab === 'overview' && <Overview />}
      {tab === 'bots' && <SimpleTable url="/admin/bots" title="All bots" icon={Bot} cols={[
        ['Bot', (b) => b.name], ['Owner', (b) => b.owner, 'small muted'], ['Market', (b) => `${b.exchange} · ${b.symbol}`, 'small'], ['Strategy', (b) => b.strategy, 'small'],
        ['Mode', (b) => <span className={`badge ${b.mode === 'live' ? 'down' : 'accent'}`}>{b.mode}</span>], ['Status', (b) => <span title={b.pausedReason}>{b.status}</span>], ['Position', (b) => (b.position ? 'open' : '—')],
        ['PnL', (b) => <span className={tone(b.pnl)}>{fmtUsd(b.pnl)}</span>, 'num'], ['Copyable', (b) => (b.copyable ? 'yes' : '')],
      ]} />}
      {tab === 'trades' && <SimpleTable url="/admin/trades" title="Latest trades (all users)" icon={Activity} cols={[
        ['Time', (t) => fmtTime(t.time), 'small muted'], ['User', (t) => t.owner, 'small'], ['Source', (t) => t.botName, 'small'], ['Market', (t) => `${t.exchange || 'binance'} · ${t.symbol}`, 'small'],
        ['Side', (t) => <span className={`badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span>], ['Mode', (t) => t.mode], ['Value', (t) => fmtUsd(t.cost), 'num'], ['PnL', (t) => (t.pnl !== undefined ? <span className={tone(t.pnl)}>{fmtUsd(t.pnl)}</span> : '—'), 'num'],
      ]} />}
      {tab === 'logs' && (
        <>
          <Seg value={errScope} onChange={setErrScope} options={[{ value: 'errors', label: 'Bot errors' }, { value: 'audit', label: 'Audit log' }]} />
          {errScope === 'errors'
            ? <SimpleTable url="/admin/errors" title="Errors" icon={AlertTriangle} cols={[['Time', (l) => fmtTime(l.time), 'small muted'], ['User', (l) => l.userId?.slice(0, 8) || 'system', 'mono small'], ['Message', (l) => l.msg, 'small']]} />
            : <SimpleTable url="/admin/audit" title="Audit log (all users)" icon={ScrollText} cols={[['Time', (a) => fmtTime(a.time), 'small muted'], ['User', (a) => a.email || '—', 'small'], ['Action', (a) => a.action, 'small bold'], ['Details', (a) => JSON.stringify(a.details).slice(0, 120), 'small muted'], ['Via', (a) => a.via, 'small'], ['IP', (a) => a.ip || '—', 'small mono dim']]} />}
        </>
      )}
      {tab === 'platform' && <Platform />}
    </>
  );
}
