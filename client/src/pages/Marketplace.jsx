import { useState } from 'react';
import { Store, Plus, Download, Upload, Trash2, X, Wrench } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { Field, Spinner, Empty, RegimeChip, Tabs } from '../components/ui.jsx';
import { fmtTime, tone } from '../lib/format.js';

function Builder({ initial, onClose, onSaved }) {
  const { toast } = useApp();
  const [meta] = usePoll('/strategies/models');
  const [f, setF] = useState(initial || { name: 'My strategy', description: '', weights: { trend: 0.4, momentum: 0.2, htf: 0.2, ml: 0.2 }, sl: 2, tp: 3, regimes: [], timeframes: ['1h'] });
  const [busy, setBusy] = useState(false);
  const setW = (k, v) => setF((s) => ({ ...s, weights: { ...s.weights, [k]: Number(v) } }));
  const toggle = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));
  const save = async () => {
    setBusy(true);
    try { const r = initial?.id ? await api.put(`/strategies/custom/${initial.id}`, f) : await api.post('/strategies/custom', f); toast(`Saved "${r.name}" - use it in bots and the Backtest Lab`); onSaved(); onClose(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const total = Object.values(f.weights).reduce((a, b) => a + (b || 0), 0) || 1;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 14 }}><b className="row" style={{ gap: 8 }}><Wrench size={16} /> Strategy builder</b><button className="btn ghost icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="col" style={{ gap: 12 }}>
          <div className="grid g-2" style={{ gap: 12 }}>
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          </div>
          <div className="card-title">Model weights <span className="tiny dim">(normalised to 100%)</span></div>
          {(meta?.models || []).map((m) => (
            <div key={m.id} className="weight-row">
              <span className="muted">{m.label}</span>
              <input type="range" min="0" max="1" step="0.05" value={f.weights[m.id] || 0} onChange={(e) => setW(m.id, e.target.value)} />
              <span className="mono num small">{Math.round(((f.weights[m.id] || 0) / total) * 100)}%</span>
            </div>
          ))}
          <div className="grid g-2" style={{ gap: 12 }}>
            <Field label="Stop-loss (× ATR)"><input className="input mono" type="number" step="0.1" value={f.sl} onChange={(e) => setF({ ...f, sl: e.target.value })} /></Field>
            <Field label="Take-profit (× ATR)"><input className="input mono" type="number" step="0.1" value={f.tp} onChange={(e) => setF({ ...f, tp: e.target.value })} /></Field>
          </div>
          <Field label="Best regimes (informational)">
            <div className="row wrap" style={{ gap: 6 }}>{(meta?.regimes || []).map((r) => <button type="button" key={r.id} className={`chip-toggle ${f.regimes.includes(r.id) ? 'on' : ''}`} onClick={() => toggle('regimes', r.id)}>{r.label}</button>)}</div>
          </Field>
          <Field label="Timeframes">
            <div className="row wrap" style={{ gap: 6 }}>{['5m', '15m', '1h', '4h', '1d'].map((t) => <button type="button" key={t} className={`chip-toggle ${f.timeframes.includes(t) ? 'on' : ''}`} onClick={() => toggle('timeframes', t)}>{t}</button>)}</div>
          </Field>
          <div className="tiny dim">New longs are always blocked in Bear Trend, Breakdown and Panic regimes (spot long-only safety).</div>
          <button className="btn primary block" onClick={save} disabled={busy}>{busy ? <Spinner /> : null} Save strategy</button>
        </div>
      </div>
    </div>
  );
}

function Stars({ value, onRate }) {
  return <span className="stars">{[1, 2, 3, 4, 5].map((s) => <button key={s} className={value >= s ? 'on' : ''} onClick={() => onRate(s)} aria-label={`${s} stars`}>★</button>)}</span>;
}

export default function Marketplace() {
  const { toast } = useApp();
  const [tab, setTab] = useState('browse');
  const [listings, , reloadListings] = usePoll('/marketplace');
  const [mine, , reloadMine] = usePoll('/strategies/custom');
  const [builder, setBuilder] = useState(null);
  const [busy, setBusy] = useState(null);

  const install = async (l) => { setBusy(l._id); try { await api.post(`/marketplace/${l._id}/install`); toast(`Installed "${l.name}" - find it in My strategies`); reloadListings(); reloadMine(); } catch (e) { toast(e.message, 'err'); } setBusy(null); };
  const rate = async (l, stars) => { try { await api.post(`/marketplace/${l._id}/rate`, { stars }); reloadListings(); } catch (e) { toast(e.message, 'err'); } };
  const publish = async (s) => {
    setBusy(s.id);
    try { await api.post('/marketplace/publish', { strategyId: s.id, description: s.description }); toast('Published - benchmarked on out-of-sample data'); reloadListings(); setTab('browse'); } catch (e) { toast(e.message, 'err'); }
    setBusy(null);
  };
  const remove = async (s) => { if (confirm(`Delete "${s.name}"?`)) { try { await api.del(`/strategies/custom/${s.id}`); reloadMine(); } catch (e) { toast(e.message, 'err'); } } };
  const unlist = async (l) => { if (confirm('Remove this listing?')) { await api.del(`/marketplace/${l._id}`); reloadListings(); } };

  return (
    <>
      <div className="row between wrap" style={{ gap: 10 }}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'browse', label: `Marketplace (${listings?.length ?? '…'})`, icon: Store }, { value: 'mine', label: `My strategies (${mine?.length ?? '…'})`, icon: Wrench }]} />
        <button className="btn primary" onClick={() => setBuilder({})}><Plus size={14} /> New strategy</button>
      </div>

      {tab === 'browse' && (!listings ? <Spinner /> : listings.length ? (
        <div className="grid g-3">
          {listings.map((l) => (
            <div key={l._id} className="card strategy-card">
              <div className="row between"><b>{l.name}</b><span className="tiny dim">by {l.authorName}</span></div>
              <div className="small muted" style={{ minHeight: 36 }}>{l.description || 'No description'}</div>
              <div className="metric-grid">
                <div><small>OOS return</small><b className={tone(l.stats.oosReturnPct)}>{l.stats.oosReturnPct}%</b></div>
                <div><small>Win rate</small><b>{l.stats.winRate}%</b></div>
                <div><small>Profit factor</small><b className={l.stats.profitFactor >= 1 ? 'up' : 'down'}>{l.stats.profitFactor}</b></div>
                <div><small>Max DD</small><b className="down">-{l.stats.maxDrawdownPct}%</b></div>
                <div><small>Sharpe</small><b className={tone(l.stats.sharpe)}>{l.stats.sharpe}</b></div>
                <div><small>Trades</small><b>{l.stats.trades}</b></div>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>{(l.config.regimes || []).map((r) => <RegimeChip key={r} regime={r} />)}{(l.config.timeframes || []).map((t) => <span key={t} className="badge flat">{t}</span>)}</div>
              <div className="row between">
                <span className="row small" style={{ gap: 6 }}><Stars value={l.myRating || Math.round(l.rating || 0)} onRate={(s) => rate(l, s)} /><span className="dim">{l.rating ?? '–'} ({l.ratingCount})</span></span>
                <span className="tiny dim">{l.installs} installs</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm primary" style={{ flex: 1 }} onClick={() => install(l)} disabled={busy === l._id}>{busy === l._id ? <Spinner size={12} /> : <Download size={13} />} Install</button>
                {l.mine && <button className="btn sm ghost danger" onClick={() => unlist(l)}><Trash2 size={13} /></button>}
              </div>
              <div className="tiny dim">Stats: out-of-sample backtest on BTC + ETH 1h, measured {fmtTime(l.stats.time)}. Not a promise of future results.</div>
            </div>
          ))}
        </div>
      ) : <div className="card"><Empty icon={Store} title="No strategies published yet">Build one, then publish it from "My strategies".</Empty></div>)}

      {tab === 'mine' && (!mine ? <Spinner /> : mine.length ? (
        <div className="grid g-3">
          {mine.map((s) => (
            <div key={s.id} className="card strategy-card">
              <div className="row between"><b>{s.name}</b>{s.installedFrom && <span className="badge flat">installed</span>}</div>
              <div className="small muted">{s.description || '—'}</div>
              <div className="col" style={{ gap: 4 }}>
                {Object.entries(s.weights).map(([k, v]) => <div key={k} className="weight-row" style={{ gridTemplateColumns: '110px 1fr 40px' }}><span className="muted small">{k}</span><div className="meter"><i style={{ left: 0, width: `${v * 100}%`, background: 'var(--accent)' }} /></div><span className="mono tiny">{v}</span></div>)}
              </div>
              <div className="tiny muted">SL {s.sl} ATR · TP {s.tp} ATR · id <span className="mono">{s.id}</span></div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => setBuilder(s)}>Edit</button>
                {!s.installedFrom && <button className="btn sm" onClick={() => publish(s)} disabled={busy === s.id}>{busy === s.id ? <Spinner size={12} /> : <Upload size={13} />} Publish</button>}
                <button className="btn sm ghost danger" onClick={() => remove(s)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="card"><Empty icon={Wrench} title="No custom strategies yet"><button className="btn primary" style={{ marginTop: 8 }} onClick={() => setBuilder({})}><Plus size={14} /> Build one</button></Empty></div>)}
      {builder && <Builder initial={builder.id ? builder : null} onClose={() => setBuilder(null)} onSaved={reloadMine} />}
    </>
  );
}
