import { useEffect, useState } from 'react';
import { ShieldCheck, Save, OctagonX, Activity, Gauge, ServerCog } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { Field, Spinner, Seg } from '../components/ui.jsx';
import { fmtUsd, tone } from '../lib/format.js';

const LIMITS = [
  ['baseRiskPct', 'Base risk per trade (%)', 'Starting point before dynamic adjustments'],
  ['maxRiskPct', 'Max risk per trade (%)', 'Hard cap after all multipliers'],
  ['maxOpenPositions', 'Max open positions', 'Across all bots in a mode'],
  ['maxExposurePct', 'Max portfolio exposure (%)', 'Share of equity outside stablecoins (futures: share blocked as margin)'],
  ['maxLeverage', 'Max futures leverage (x)', 'NSE futures: total notional / equity'],
  ['maxCorrelatedPositions', 'Max correlated holdings', 'Holdings above the correlation limit'],
  ['correlationLimit', 'Correlation limit (0-1)', 'Pairs above this count as one bet'],
  ['maxDrawdownHaltPct', 'Drawdown halt (%)', 'Risk drops to zero below this'],
  ['dailyLossLimitPct', 'Daily loss limit (%)', 'No new entries after this'],
  ['minRR', 'Min reward : risk', 'Trades below are rejected'],
  ['abnormalMovePct', 'Abnormal price move (%)', 'Ticks beyond this are ignored'],
  ['maxConsecutiveErrors', 'Errors before auto-pause', 'API failure protection'],
  ['orderCooldownSec', 'Order cooldown (sec)', 'Duplicate-order protection'],
];

export default function Risk() {
  const { toast, refreshStatus, exchange, money } = useApp();
  const fmtUsd = money; // the account follows the top-bar exchange: INR for Zerodha forex
  const [mode, setMode] = useState('paper');
  const [ov, , reload] = usePoll(`/risk/overview?mode=${mode}&exchange=${exchange}`, 15000, [mode, exchange]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useServerEvents((t) => (t === 'trade' || t === 'killswitch' || t === 'settings') && reload());
  useEffect(() => { if (ov && !form) setForm(ov.settings.risk); }, [ov, form]);

  const save = async () => {
    setBusy(true);
    try {
      const s = await api.patch('/settings', { risk: form });
      setForm(s.risk);
      toast('Risk limits saved');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  const kill = async () => {
    if (!confirm('KILL SWITCH: stop all bots, cancel orders, close all bot positions, disable auto-trading?')) return;
    try {
      const r = await api.post('/killswitch', { reason: 'Kill switch from Risk Manager' });
      toast(`Stopped ${r.stopped} bots, closed ${r.closed.length} positions${r.failed.length ? `, ${r.failed.length} failures` : ''}`, r.failed.length ? 'err' : 'ok');
      refreshStatus();
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const a = ov?.account;
  const s = ov?.settings;
  return (
    <>
      <div className="grid g-4">
        <div className="card stat"><span className="stat-icon"><Gauge size={18} /></span><span className="stat-label">Equity ({mode})</span><span className="stat-value">{a ? fmtUsd(a.equity) : '…'}</span><span className="stat-sub muted">peak {a ? fmtUsd(a.peak) : '…'}</span></div>
        <div className="card stat"><span className="stat-icon warn"><Activity size={18} /></span><span className="stat-label">Drawdown from peak</span><span className={`stat-value ${a?.drawdownPct > 5 ? 'down' : ''}`}>{a ? `${a.drawdownPct.toFixed(2)}%` : '…'}</span><span className="stat-sub muted">halt at {s?.risk.maxDrawdownHaltPct}%</span></div>
        <div className="card stat"><span className="stat-icon violet"><ShieldCheck size={18} /></span><span className="stat-label">Exposure</span><span className="stat-value">{a ? `${a.exposurePct.toFixed(1)}%` : '…'}</span><span className="stat-sub muted">limit {s?.risk.maxExposurePct}% · {a?.holdings.length || 0} holdings</span></div>
        <div className="card stat"><span className="stat-icon green"><Activity size={18} /></span><span className="stat-label">Realized today</span><span className={`stat-value ${tone(a?.realizedToday)}`}>{a ? fmtUsd(a.realizedToday) : '…'}</span><span className="stat-sub muted">daily limit {s?.risk.dailyLossLimitPct}%</span></div>
      </div>

      <div className="grid g-wide">
        <div className="card">
          <div className="card-head">
            <span className="card-title"><ShieldCheck size={14} /> Risk Limits (central Risk Engine)</span>
            <Seg value={mode} onChange={setMode} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} />
          </div>
          {form ? (
            <div className="col" style={{ gap: 14 }}>
              <div className="grid g-3" style={{ gap: 12 }}>
                {LIMITS.map(([k, label, hint]) => (
                  <Field key={k} label={label} hint={hint}><input className="input mono" type="number" step="0.05" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
                ))}
                <Field label="Min signal quality" hint="Grades below are rejected">
                  <Seg value={form.minQuality} onChange={(v) => setForm({ ...form, minQuality: v })} options={['A', 'B', 'C', 'D']} />
                </Field>
              </div>
              <div className="alert info small">Dynamic sizing: base risk × volatility × drawdown × strategy performance × regime × news × futures × signal quality, then hard gates. Every decision is visible in the AI Terminal and bot logs.</div>
              <button className="btn primary" onClick={save} disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? <Spinner /> : <Save size={14} />} Save limits</button>
            </div>
          ) : <Spinner />}
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="card">
            <div className="card-head"><span className="card-title"><OctagonX size={14} /> Emergency Protection</span></div>
            <div className="col" style={{ gap: 10 }}>
              <div className="row between small"><span>Auto-trading</span><span className={s?.tradingEnabled ? 'up bold' : 'down bold'}>{s?.tradingEnabled ? 'ENABLED' : 'HALTED'}</span></div>
              <button className="btn kill block" onClick={kill}><OctagonX size={15} /> Kill Switch — stop everything</button>
              <ul className="list-reasons">
                <li>Stops all bots, cancels open orders, closes positions, disables auto-trading</li>
                <li>Daily loss limit + drawdown halt</li>
                <li>Exchange outage detection (pings Binance every 60s)</li>
                <li>Stale-data and abnormal-price guards</li>
                <li>Duplicate-order protection (cooldown + idempotent order IDs)</li>
                <li>API-failure auto-pause after repeated errors</li>
                <li>Model-failure fallback: a broken analysis never trades</li>
              </ul>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><span className="card-title"><ServerCog size={14} /> System Health</span></div>
            <div className="kv">
              <span>Binance</span><span className={ov?.health.exchangeUp ? 'up' : 'down'}>{ov?.health.exchangeUp ? 'Online' : 'Down'}</span>
              <span>Latency</span><span>{ov?.health.latencyMs ?? '—'} ms</span>
              <span>Last check</span><span>{ov?.health.lastCheck ? new Date(ov.health.lastCheck).toLocaleTimeString() : '—'}</span>
              <span>Running bots</span><span>{ov?.bots.filter((b) => b.status === 'running').length ?? '—'}</span>
              <span>Paused by safety</span><span className={ov?.bots.some((b) => b.status === 'paused') ? 'warn' : ''}>{ov?.bots.filter((b) => b.status === 'paused').length ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
