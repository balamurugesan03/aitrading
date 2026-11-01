import { useState } from 'react';
import { BrainCircuit, Play, RefreshCw, ChevronRight, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { Field, Spinner, Empty, RegimeChip } from '../components/ui.jsx';
import { fmtTime, tone } from '../lib/format.js';

const STATUS_BADGE = { production: 'up', paper: 'accent', candidate: 'warn', retired: 'flat' };

function Pipeline({ p }) {
  const steps = [
    ['Trades', p.trades], ['Journal analyses', p.journal], ['Signals tracked', p.signals], ['Outcomes evaluated', p.evaluated],
    ['Model candidates', p.candidates, 'gate'], ['Backtest + walk-forward', 'OOS', 'gate'], ['Paper trading', p.paper, 'gate'], ['Human approval', '✓', 'gate'], ['Production', p.production, 'prod'],
  ];
  return (
    <div className="pipeline">
      {steps.map(([label, v, kind], k) => (
        <div key={label} className="row" style={{ gap: 6, flex: '1 1 120px' }}>
          <div className={`pipe-step ${kind || ''}`} style={{ flex: 1 }}><small>{label}</small><b style={{ fontSize: typeof v === 'string' && v.length > 6 ? 12 : 18 }}>{v ?? 0}</b></div>
          {k < steps.length - 1 && <ChevronRight size={14} className="dim" />}
        </div>
      ))}
    </div>
  );
}

export default function Learning() {
  const { toast, refreshStatus } = useApp();
  const [rep, , reload] = usePoll('/learning', 60000);
  const [f, setF] = useState({ symbols: 'BTCUSDT,ETHUSDT,SOLUSDT', interval: '1h', candles: 3000, hidden: 16, epochs: 60, horizon: 3 });
  const [busy, setBusy] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const act = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      reload();
      refreshStatus();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(null);
  };
  const train = () => act('train', () => api.post('/models/train', { ...f, symbols: f.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }), 'Candidate trained and evaluated out-of-sample');
  const promote = (m, status) => act(m._id + status, async () => {
    try {
      await api.post(`/models/${m._id}/promote`, { status });
    } catch (e) {
      if (!e.message.startsWith('Promotion blocked')) throw e;
      if (!confirm(`${e.message}\n\nOverride the safety gates anyway? This is recorded in the model's audit history.`)) throw new Error('Promotion cancelled - gates not met');
      await api.post(`/models/${m._id}/promote`, { status, override: true, note: 'Manual override from Learning Loop' });
    }
  }, `Model v${m.version} → ${status}`);

  if (!rep) return <div className="empty"><Spinner /></div>;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <span className="card-title"><BrainCircuit size={14} /> AI Learning Loop</span>
          <button className="btn sm" onClick={() => act('eval', () => api.post('/signals/evaluate'), 'Signal outcomes updated')} disabled={busy === 'eval'}>{busy === 'eval' ? <Spinner /> : <RefreshCw size={13} />} Evaluate signals now</button>
        </div>
        <Pipeline p={rep.pipeline} />
        <div className="alert warn small" style={{ marginTop: 12 }}><ShieldAlert size={15} /> No self-learning goes straight to live trading. A new model must pass out-of-sample gates, at least 24 hours of paper trading, and your explicit approval.</div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><span className="card-title">Live calibration — predicted vs actual</span><span className="tiny dim">{rep.pipeline.evaluated} resolved signals</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Probability bucket</th><th className="num">Predicted</th><th className="num">Actual TP-first rate</th><th className="num">Signals</th></tr></thead>
            <tbody>{rep.calibration.map((c) => (
              <tr key={c.bucket}><td>{c.bucket}</td><td className="num">{c.predicted ?? '—'}{c.predicted != null && '%'}</td>
                <td className={`num ${c.actual != null && c.predicted != null ? (Math.abs(c.actual - c.predicted) <= 10 ? 'up' : 'down') : ''}`}>{c.actual ?? '—'}{c.actual != null && '%'}</td><td className="num">{c.n}</td></tr>
            ))}</tbody>
          </table></div>
          <div className="tiny dim" style={{ marginTop: 6 }}>Green = actual within 10 points of predicted. Needs time: every bot signal is checked against what price did next.</div>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">Feature performance</span><span className="tiny dim">correlation of each model's score with winning</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Model</th><th className="num">Correlation</th><th className="num">Signals</th></tr></thead>
            <tbody>{rep.featurePerformance.map((x) => (
              <tr key={x.model}><td>{x.model}</td><td className={`num ${tone(x.correlation)}`}>{x.correlation ?? '— (need 10+)'}</td><td className="num">{x.n}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      </div>

      <div className="grid g-3">
        {[['By quality grade', rep.byQuality, 'quality'], ['By regime', rep.byRegime, 'regime'], ['By strategy', rep.byStrategy, 'strategy']].map(([title, rows, key]) => (
          <div className="card" key={title}>
            <div className="card-head"><span className="card-title">{title}</span></div>
            {rows.length ? (
              <div className="table-wrap"><table><thead><tr><th>{key}</th><th className="num">Win rate</th><th className="num">n</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r[key]}><td>{key === 'regime' ? <RegimeChip regime={r[key]} /> : r[key]}</td><td className="num">{r.winRate}%</td><td className="num">{r.n}</td></tr>)}</tbody></table></div>
            ) : <div className="small dim">No evaluated signals yet.</div>}
          </div>
        ))}
      </div>

      {rep.canManageModels ? (<div className="grid g-side">
        <div className="card" style={{ alignSelf: 'start' }}>
          <div className="card-head"><span className="card-title"><Play size={14} /> Train New Model Candidate</span></div>
          <div className="col" style={{ gap: 10 }}>
            <Field label="Training markets"><input className="input mono" value={f.symbols} onChange={set('symbols')} /></Field>
            <div className="grid g-2" style={{ gap: 10 }}>
              <Field label="Timeframe"><input className="input mono" value={f.interval} onChange={set('interval')} /></Field>
              <Field label="Candles"><input className="input mono" type="number" value={f.candles} onChange={set('candles')} /></Field>
              <Field label="Hidden neurons"><input className="input mono" type="number" value={f.hidden} onChange={set('hidden')} /></Field>
              <Field label="Epochs"><input className="input mono" type="number" value={f.epochs} onChange={set('epochs')} /></Field>
              <Field label="Forecast horizon (bars)"><input className="input mono" type="number" value={f.horizon} onChange={set('horizon')} /></Field>
            </div>
            <button className="btn primary block" onClick={train} disabled={busy === 'train'}>{busy === 'train' ? <><Spinner /> Training &amp; evaluating…</> : <><BrainCircuit size={15} /> Train candidate</>}</button>
            <div className="tiny dim">Trained on 70% of each market, scored on the unseen 30%: accuracy, Brier calibration, trading P&amp;L after costs, drawdown and stability across markets.</div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">Model Registry</span><span className="tiny dim">accuracy alone never decides — P&amp;L, drawdown, calibration and stability do</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Model</th><th>Status</th><th className="num">Accuracy</th><th className="num">Brier</th><th className="num">OOS P&amp;L</th><th className="num">PF</th><th className="num">Max DD</th><th className="num">Stability σ</th><th>Actions</th></tr></thead>
              <tbody>
                {rep.models.map((m) => (
                  <tr key={m._id}>
                    <td><div className="bold small">{m.name}</div><div className="tiny dim">{fmtTime(m.createdAt)} · h{m.params.hidden} · {m.params.horizon}-bar</div></td>
                    <td><span className={`badge ${STATUS_BADGE[m.status]}`}>{m.status}</span></td>
                    <td className="num">{m.metrics ? `${m.metrics.accuracy}%` : '—'}</td>
                    <td className={`num ${m.metrics ? (m.metrics.brier < 0.25 ? 'up' : 'down') : ''}`}>{m.metrics?.brier ?? '—'}</td>
                    <td className={`num ${tone(m.metrics?.oosReturnPct)}`}>{m.metrics ? `${m.metrics.oosReturnPct}%` : '—'}</td>
                    <td className="num">{m.metrics?.profitFactor ?? '—'}</td>
                    <td className="num">{m.metrics ? `${m.metrics.maxDrawdownPct}%` : '—'}</td>
                    <td className="num">{m.metrics?.stability ?? '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {!m.metrics && <button className="btn sm" disabled={!!busy} onClick={() => act(m._id, () => api.post(`/models/${m._id}/evaluate`), 'Evaluated')}>Evaluate</button>}
                        {m.status === 'candidate' && <button className="btn sm" disabled={!!busy} onClick={() => promote(m, 'paper')}>→ Paper</button>}
                        {m.status === 'paper' && <button className="btn sm primary" disabled={!!busy} onClick={() => promote(m, 'production')}>Approve → Prod</button>}
                        {['candidate', 'paper'].includes(m.status) && <button className="btn sm ghost" disabled={!!busy} onClick={() => promote(m, 'retired')}>Retire</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rep.models.find((m) => m.history?.some((h) => h.note?.startsWith('OVERRIDE'))) && <div className="alert warn small" style={{ marginTop: 10 }}>At least one model was promoted with a gate override — see its history.</div>}
          <div className="col" style={{ gap: 6, marginTop: 12 }}>
            <div className="card-title">Promotion gates</div>
            <div className="small row" style={{ gap: 6 }}><CheckCircle2 size={13} className="up" /> Candidate → Paper: OOS return &gt; 0, profit factor ≥ 1.1, Brier &lt; 0.25, ≥ 30 OOS trades</div>
            <div className="small row" style={{ gap: 6 }}><CheckCircle2 size={13} className="up" /> Paper → Production: ≥ 24h in paper trading + your approval</div>
            <div className="small row" style={{ gap: 6 }}><XCircle size={13} className="down" /> A promoted model replaces the current production model, which is retired</div>
          </div>
          {!rep.models.length && <Empty title="No models" />}
        </div>
      </div>) : (
        <div className="card">
          <div className="card-head"><span className="card-title">Model registry</span><span className="tiny dim">managed by the platform admins</span></div>
          <div className="table-wrap"><table><thead><tr><th>Model</th><th>Status</th><th className="num">Accuracy</th><th className="num">OOS P&amp;L</th><th className="num">Brier</th></tr></thead>
            <tbody>{rep.models.map((m) => <tr key={m._id}><td className="small">{m.name}</td><td><span className={`badge ${STATUS_BADGE[m.status]}`}>{m.status}</span></td><td className="num">{m.metrics ? `${m.metrics.accuracy}%` : '—'}</td><td className={`num ${tone(m.metrics?.oosReturnPct)}`}>{m.metrics ? `${m.metrics.oosReturnPct}%` : '—'}</td><td className="num">{m.metrics?.brier ?? '—'}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </>
  );
}
