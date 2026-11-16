import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Play, Square, Plus, CheckCircle2, Circle, X, ListChecks, Settings2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { useLocalState } from '../lib/hooks.js';
import { Spinner } from './ui.jsx';
import { segmentOf, currencyOf } from '../lib/markets.js';
import { fmtMoney, tone, baseOf } from '../lib/format.js';

// "Getting started" steps, ticked off from what the account already has. Hidden once done or dismissed.
export function SetupChecklist({ bots, trades }) {
  const { access } = useApp();
  const [hidden, setHidden] = useLocalState('nexus.setupHidden', false);
  if (hidden || !bots || !trades) return null;
  const seen = (path) => { try { return localStorage.getItem(`nexus.seen.${path}`) === '1'; } catch { return false; } };
  const steps = [
    { done: bots.length > 0, title: 'Create your first AI bot', hint: 'Pick a coin and a strategy. Keep it in Paper mode (fake money) first.', to: '/bots?new=1', cta: 'Create bot' },
    { done: bots.some((b) => b.status === 'running') || trades.length > 0, title: 'Start the bot', hint: 'Press Start. The bot watches the market and trades by itself.', to: '/bots', cta: 'Open bots' },
    { done: seen('/risk'), title: 'Check your safety limits', hint: 'Max loss per day, trade size and leverage. Bots never break these.', to: '/risk', cta: 'Set limits' },
    { done: trades.some((t) => t.pnl !== undefined) && seen('/history'), title: 'See your profit / loss', hint: 'Invested, got back, profit or loss - and why.', to: '/history', cta: 'Open P&L' },
    { done: (access?.connections || []).some((c) => c.active), title: 'Connect your exchange (for live trading)', hint: 'Only when paper results look good. Turn OFF withdrawals on the API key.', to: '/account?tab=connections', cta: 'Connect', optional: true },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><ListChecks size={14} /> Getting started · {doneCount}/{steps.length} done</span>
        <button className="btn ghost icon-btn" onClick={() => setHidden(true)} title="Hide this checklist"><X size={15} /></button>
      </div>
      <div className="meter" style={{ marginBottom: 12 }}><i style={{ left: 0, width: `${(doneCount / steps.length) * 100}%`, background: 'var(--up)' }} /></div>
      <div className="setup-steps">
        {steps.map((s, i) => (
          <div key={s.title} className={`setup-step ${s.done ? 'done' : ''}`}>
            {s.done ? <CheckCircle2 size={20} className="up" /> : <Circle size={20} className="dim" />}
            <div className="col" style={{ gap: 2, flex: 1 }}>
              <span className="bold small">{i + 1}. {s.title}{s.optional && <span className="tiny dim"> (optional)</span>}</span>
              <span className="tiny muted">{s.hint}</span>
            </div>
            {!s.done && <Link className="btn sm" to={s.to}>{s.cta}</Link>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Every bot on one card with a one-click Start / Stop.
export function BotQuickControl({ bots, reload }) {
  const { status, toast } = useApp();
  const [busy, setBusy] = useState(null);
  const exchanges = status?.exchanges;
  const act = async (b, what) => {
    if (what === 'stop' && b.position && !confirm(`"${b.name}" has an open trade.

Stopping keeps that trade open, but the bot will no longer watch its stop-loss / target. Close it from My AI Bots if you want out.

Stop the bot anyway?`)) return;
    if (what === 'start' && b.mode === 'live' && !confirm(`Start "${b.name}" in LIVE mode?\n\nIt will place REAL orders with your exchange account.`)) return;
    setBusy(b._id);
    try {
      await api.post(`/bots/${b._id}/${what}`);
      toast(`${b.name} ${what === 'start' ? 'started' : 'stopped'}`);
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(null);
  };
  const running = (bots || []).filter((b) => b.status === 'running').length;
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><Bot size={14} /> My bots · {running} running</span>
        <span className="row" style={{ gap: 6 }}>
          <Link className="btn sm ghost" to="/bots"><Settings2 size={13} /> Manage</Link>
          <Link className="btn sm primary" to="/bots?new=1"><Plus size={13} /> New bot</Link>
        </span>
      </div>
      {!bots ? <div className="skeleton" style={{ height: 80 }} />
        : !bots.length ? <div className="small muted">No bots yet. <Link to="/bots?new=1">Create one</Link> - it takes a minute.</div>
          : (
            <div className="bot-quick">
              {bots.map((b) => {
                const seg = segmentOf(exchanges, b.exchange);
                const st = b.status === 'running' ? 'running' : b.status === 'paused' ? 'paused' : 'stopped';
                const pnl = b.stats?.pnl || 0;
                return (
                  <div key={b._id} className={`bq-row ${st}`}>
                    <span className={`bq-dot ${st}`} title={st} />
                    <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                      <span className="bold small ellipsis">{b.name}</span>
                      <span className="tiny muted">
                        <span className={`mkt-tag ${seg?.id || 'spot'}`}>{seg?.tag || 'SPOT'}</span> {baseOf(b.symbol)} · <span className={b.mode === 'live' ? 'down bold' : ''}>{b.mode === 'live' ? 'LIVE' : 'paper'}</span>
                        {b.position && <> · <span className="warn">trade open</span></>}
                      </span>
                      {st === 'paused' && b.pausedReason && <span className="tiny down ellipsis" title={b.pausedReason}>Paused: {b.pausedReason}</span>}
                    </div>
                    <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
                      <b className={`mono small ${tone(pnl)}`}>{pnl ? `${pnl > 0 ? '+' : ''}${fmtMoney(pnl, currencyOf(exchanges, b.exchange))}` : '—'}</b>
                      <span className="tiny dim">{b.stats?.trades || 0} trades</span>
                    </div>
                    {st === 'running'
                      ? <button className="btn sm" onClick={() => act(b, 'stop')} disabled={busy === b._id} title="Stop looking for new trades (an open trade stays open)">{busy === b._id ? <Spinner size={13} /> : <Square size={13} />} Stop</button>
                      : <button className="btn sm primary" onClick={() => act(b, 'start')} disabled={busy === b._id}>{busy === b._id ? <Spinner size={13} /> : <Play size={13} />} Start</button>}
                  </div>
                );
              })}
            </div>
          )}
    </div>
  );
}
