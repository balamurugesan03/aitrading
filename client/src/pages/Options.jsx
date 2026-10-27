import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Play, Square, Trash2, Plus, X, ShieldCheck, AlertTriangle, RefreshCw, Bot } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { Tabs, Field, Switch, Spinner, Empty, Seg } from '../components/ui.jsx';
import { fmtPrice, fmtPct, fmtTime, ago, tone } from '../lib/format.js';

const inr = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${v < 0 ? '-' : ''}₹${Math.abs(Number(v)).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d })}`);

// ---- Payoff at expiry: one P&L line over the underlying price, profit/loss areas, spot and breakevens ----
function PayoffChart({ analysis, height = 230 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const pts = analysis?.curve || [];
  if (pts.length < 2) return null;
  const W = 640;
  const H = height;
  const pad = { l: 64, r: 12, t: 12, b: 26 };
  const xs = pts.map((p) => p.S);
  const ys = pts.map((p) => p.pnl);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = Math.max(0, ...ys);
  const yMin = Math.min(0, ...ys);
  const span = yMax - yMin || 1;
  const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + ((yMax + span * 0.08 - v) / (span * 1.16)) * (H - pad.t - pad.b);
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join(' ');
  const area = (sign) => `M${X(x0)},${Y(0)} ${pts.map((p) => `L${X(p.S).toFixed(1)},${Y(sign > 0 ? Math.max(0, p.pnl) : Math.min(0, p.pnl)).toFixed(1)}`).join(' ')} L${X(x1)},${Y(0)} Z`;
  const ticksY = [yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i);
  const ticksX = [x0, analysis.spot, x1];
  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const S = x0 + ((sx - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    const near = pts.reduce((b, p) => (Math.abs(p.S - S) < Math.abs(b.S - S) ? p : b), pts[0]);
    setHover(near);
  };
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Profit and loss at expiry by underlying price">
        <path d={area(1)} fill="var(--up)" opacity="0.12" />
        <path d={area(-1)} fill="var(--down)" opacity="0.12" />
        {ticksY.map((v) => <g key={v}><line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? 'var(--text-3)' : 'var(--line)'} strokeWidth="1" strokeDasharray={v === 0 ? '' : '3 4'} /><text x={pad.l - 6} y={Y(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-3)">{inr(v)}</text></g>)}
        {ticksX.map((v, k) => <text key={k} x={X(v)} y={H - 8} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} fontSize="10" fill="var(--text-3)">{k === 1 ? `spot ${fmtPrice(v)}` : fmtPrice(v)}</text>)}
        <line x1={X(analysis.spot)} x2={X(analysis.spot)} y1={pad.t} y2={H - pad.b} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="2 3" />
        {(analysis.breakevens || []).map((b) => <g key={b}><circle cx={X(b)} cy={Y(0)} r="4" fill="var(--bg-2, #0b0f17)" stroke="var(--text-2)" strokeWidth="2" /><text x={X(b)} y={Y(0) - 8} textAnchor="middle" fontSize="10" fill="var(--text-2)">BE {fmtPrice(b)}</text></g>)}
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {hover && <g><line x1={X(hover.S)} x2={X(hover.S)} y1={pad.t} y2={H - pad.b} stroke="var(--text-3)" strokeWidth="1" /><circle cx={X(hover.S)} cy={Y(hover.pnl)} r="4" fill="var(--accent)" stroke="var(--bg-2, #0b0f17)" strokeWidth="2" /></g>}
      </svg>
      {hover && (
        <div className="card" style={{ position: 'absolute', top: 6, left: `${Math.min(70, Math.max(10, (X(hover.S) / W) * 100))}%`, padding: '6px 10px', pointerEvents: 'none', fontSize: 12 }}>
          <div className="muted">At expiry, index {fmtPrice(hover.S)}</div>
          <div className={`mono bold ${tone(hover.pnl)}`}>{inr(hover.pnl)}</div>
        </div>
      )}
    </div>
  );
}

function Gates({ gates }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      {gates.map((g) => (
        <div key={g.name} className="row small" style={{ gap: 8 }}>
          {g.pass ? <ShieldCheck size={14} className="up" /> : <AlertTriangle size={14} className="down" />}
          <span className="bold" style={{ minWidth: 120 }}>{g.name}</span><span className="muted">{g.note}</span>
        </div>
      ))}
    </div>
  );
}

function Analysis({ pv }) {
  const a = pv.analysis;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 18 }}>
        <div><div className="tiny dim">{a.type === 'debit' ? 'NET DEBIT' : 'NET CREDIT'}</div><div className="mono bold">{inr(Math.abs(a.netPremium))}</div></div>
        <div><div className="tiny dim">MAX PROFIT</div><div className="mono bold up">{a.maxProfit === null ? 'Unlimited' : inr(a.maxProfit)}</div></div>
        <div><div className="tiny dim">MAX LOSS</div><div className="mono bold down">{a.maxLoss === null ? 'UNLIMITED' : inr(a.maxLoss)}</div></div>
        <div><div className="tiny dim">BREAKEVEN</div><div className="mono">{a.breakevens.map(fmtPrice).join(' / ') || '—'}</div></div>
        <div><div className="tiny dim">PROB. OF PROFIT</div><div className="mono">{(a.pop * 100).toFixed(0)}%</div></div>
        <div><div className="tiny dim">REWARD : RISK</div><div className="mono">{a.rewardRisk ?? '—'}</div></div>
        <div><div className="tiny dim">CHARGES (round trip)</div><div className="mono">{inr(a.charges)}</div></div>
      </div>
      <div className="row wrap small muted" style={{ gap: 16 }}>
        <span>Delta {a.greeks.delta}</span><span>Theta {inr(a.greeks.theta)}/day</span><span>Vega {inr(a.greeks.vega)}/vol pt</span><span>{pv.lots} lot(s) x {pv.chain.lotSize}</span><span>{pv.chain.expiry} ({pv.chain.daysToExpiry} d)</span>
      </div>
      <PayoffChart analysis={a} />
      <table>
        <thead><tr><th>Leg</th><th>Option</th><th className="num">Qty</th><th className="num">Price</th><th className="num">IV</th></tr></thead>
        <tbody>{a.legs.map((l) => (
          <tr key={l.tradingsymbol}><td><span className={`badge ${l.side === 'BUY' ? 'buy' : 'sell'}`}>{l.side}</span></td><td className="mono small">{l.strike} {l.type}</td><td className="num">{l.qty}</td><td className="num">{fmtPrice(l.price)}</td><td className="num">{l.iv ?? '—'}%</td></tr>
        ))}</tbody>
      </table>
      <Gates gates={pv.gates} />
    </div>
  );
}

// ---- Chain + builder ----
function ChainAndBuilder({ meta, onTraded }) {
  const { mode, toast } = useApp();
  const [u, setU] = useState('NIFTY');
  const [expiry, setExpiry] = useState('');
  const [chain, chainErr, reloadChain] = usePoll(`/options/chain?underlying=${u}${expiry ? `&expiry=${expiry}` : ''}`, 15000, [u, expiry]);
  const [f, setF] = useState({ template: 'bull_call_spread', width: 2, distance: 4, lots: 'auto', riskPct: 2, tpPct: 50, slPct: 50 });
  const [custom, setCustom] = useState([]); // [{ tradingsymbol, side, lots, label }]
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  useEffect(() => { setPv(null); }, [u, expiry, f.template, f.width, f.distance, f.lots, custom.length, mode]);
  useEffect(() => { setCustom([]); setExpiry(''); }, [u]);

  const body = () => ({ mode, underlying: u, expiry: chain?.expiry, ...(custom.length ? { legs: custom } : { template: f.template, width: +f.width, distance: +f.distance }), lots: f.lots === 'auto' ? 'auto' : +f.lots, riskPct: +f.riskPct, tpPct: +f.tpPct, slPct: +f.slPct });
  const preview = async () => { setBusy(true); try { setPv(await api.post('/options/preview', body())); } catch (e) { toast(e.message, 'err'); } setBusy(false); };
  const trade = async () => {
    if (mode === 'live' && !confirm(`Place this LIVE options trade on Zerodha?\nMax loss ${inr(pv.analysis.maxLoss)}`)) return;
    setBusy(true);
    try { const p = await api.post('/options/trade', body()); toast(`Opened ${p.templateName} x${p.lots} (${mode})`); setPv(null); setCustom([]); onTraded(); } catch (e) { toast(e.message, 'err'); if (e.data?.preview) setPv(e.data.preview); }
    setBusy(false);
  };
  const addLeg = (q, type, strike, side) => setCustom((c) => [...c.filter((x) => x.tradingsymbol !== q.tradingsymbol), { tradingsymbol: q.tradingsymbol, side, lots: 1, label: `${strike} ${type}` }].slice(0, 4));

  const cell = (q, type, strike) => (q ? (
    <>
      <td className="num small dim">{q.oi ? (q.oi / 1e5).toFixed(1) + 'L' : '—'}</td>
      <td className="num small">{q.iv ?? '—'}</td>
      <td className="num small dim">{q.delta ?? '—'}</td>
      <td className="num mono">{fmtPrice(q.ltp)}<div className="tiny dim">{fmtPrice(q.bid)} / {fmtPrice(q.ask)}</div></td>
      <td><div className="row" style={{ gap: 2 }}><button className="btn sm" title="Buy" onClick={() => addLeg(q, type, strike, 'BUY')}>B</button><button className="btn sm" title="Sell (must be covered)" onClick={() => addLeg(q, type, strike, 'SELL')}>S</button></div></td>
    </>
  ) : <td colSpan={5} className="dim">—</td>);

  return (
    <div className="grid g-side" style={{ alignItems: 'start' }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="row wrap between" style={{ gap: 10, marginBottom: 10 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            <Seg value={u} onChange={setU} options={(meta?.underlyings || [{ id: 'NIFTY', label: 'NIFTY 50' }]).map((x) => ({ value: x.id, label: x.id }))} />
            <select className="select" style={{ width: 150 }} value={chain?.expiry || ''} onChange={(e) => setExpiry(e.target.value)}>{(chain?.expiries || []).map((d) => <option key={d} value={d}>{d}</option>)}</select>
            <button className="btn sm ghost" onClick={reloadChain}><RefreshCw size={13} /></button>
          </div>
          {chain && <div className="row wrap small" style={{ gap: 14 }}><span>{chain.label} <b className={`mono ${tone(chain.change)}`}>{fmtPrice(chain.spot)}</b> {fmtPct(chain.change)}</span><span className="muted">ATM IV {chain.atmIv ?? '—'}%</span><span className="muted">PCR {chain.pcr ?? '—'}</span><span className="muted">{chain.daysToExpiry} d to expiry · lot {chain.lotSize}</span></div>}
        </div>
        {chainErr && <div className="alert error">{chainErr}</div>}
        {!chain && !chainErr && <div className="empty"><Spinner /> Loading option chain…</div>}
        {chain && (
          <div className="table-wrap" style={{ maxHeight: 560 }}>
            <table className="chain">
              <thead><tr><th className="num">OI</th><th className="num">IV</th><th className="num">Δ</th><th className="num">CALL</th><th /><th className="num" style={{ textAlign: 'center' }}>STRIKE</th><th className="num">OI</th><th className="num">IV</th><th className="num">Δ</th><th className="num">PUT</th><th /></tr></thead>
              <tbody>{chain.rows.map((r) => (
                <tr key={r.strike} style={r.strike === chain.atmStrike ? { background: 'var(--accent-glow)' } : undefined}>
                  {cell(r.call, 'CE', r.strike)}
                  <td className="bold mono" style={{ textAlign: 'center', background: r.strike < chain.spot ? 'rgba(22,199,132,0.05)' : undefined }}>{r.strike}</td>
                  {cell(r.put, 'PE', r.strike)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="col" style={{ gap: 14 }}>
        <div className="card col" style={{ gap: 12 }}>
          <div className="card-title"><Layers size={14} /> Strategy builder · {mode.toUpperCase()}</div>
          {custom.length ? (
            <>
              <div className="small muted">Custom legs (from the chain). Sold legs must be covered by bought legs.</div>
              {custom.map((l, k) => (
                <div key={l.tradingsymbol} className="row between small">
                  <span><span className={`badge ${l.side === 'BUY' ? 'buy' : 'sell'}`}>{l.side}</span> <span className="mono">{l.label}</span></span>
                  <span className="row" style={{ gap: 6 }}><input className="input mono" style={{ width: 60, padding: 4 }} type="number" min={1} value={l.lots} onChange={(e) => setCustom((c) => c.map((x, j) => (j === k ? { ...x, lots: Math.max(1, +e.target.value || 1) } : x)))} /><button className="btn sm ghost" onClick={() => setCustom((c) => c.filter((_, j) => j !== k))}><X size={12} /></button></span>
                </div>
              ))}
              <button className="btn sm ghost" onClick={() => setCustom([])}>Use a template instead</button>
            </>
          ) : (
            <>
              <Field label="Strategy">
                <select className="select" value={f.template} onChange={set('template')}>{(meta?.templates || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.view})</option>)}</select>
              </Field>
              <div className="tiny muted">{meta?.templates?.find((t) => t.id === f.template)?.description}</div>
              <div className="grid g-2" style={{ gap: 10 }}>
                {f.template !== 'long_call' && f.template !== 'long_put' && <Field label="Width (strikes)"><input className="input mono" type="number" min={1} value={f.width} onChange={set('width')} /></Field>}
                {f.template === 'iron_condor' && <Field label="Distance (strikes)"><input className="input mono" type="number" min={1} value={f.distance} onChange={set('distance')} /></Field>}
              </div>
              <div className="tiny dim">Or click B / S in the chain to build custom legs.</div>
            </>
          )}
          <div className="grid g-2" style={{ gap: 10 }}>
            <Field label="Lots" hint="auto = largest size within the risk limit"><input className="input mono" value={f.lots} onChange={set('lots')} /></Field>
            <Field label="Max risk % of capital"><input className="input mono" type="number" step="0.5" value={f.riskPct} onChange={set('riskPct')} /></Field>
            <Field label="Take-profit (% of max)"><input className="input mono" type="number" value={f.tpPct} onChange={set('tpPct')} /></Field>
            <Field label="Stop (% of max loss)"><input className="input mono" type="number" value={f.slPct} onChange={set('slPct')} /></Field>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn block" onClick={preview} disabled={busy || !chain}>{busy ? <Spinner /> : null} Preview</button>
            <button className={`btn block ${mode === 'live' ? 'sell' : 'primary'}`} onClick={trade} disabled={busy || !pv?.approved}>Place {mode} trade</button>
          </div>
        </div>
        {pv && <div className="card"><div className="row between" style={{ marginBottom: 8 }}><span className="bold">{pv.templateName}</span><span className={`badge ${pv.approved ? 'up' : 'down'}`}>{pv.approved ? 'APPROVED' : 'REJECTED'}</span></div><Analysis pv={pv} /></div>}
      </div>
    </div>
  );
}

// ---- Positions ----
function Positions({ reloadKey }) {
  const { mode, toast } = useApp();
  const [rows, , reload] = usePoll(`/options/positions?mode=${mode}`, 15000, [mode, reloadKey]);
  const [acct, , reloadAcct] = usePoll(`/options/account?mode=${mode}`, 15000, [mode, reloadKey]);
  useServerEvents((t) => { if (t === 'options') { reload(); reloadAcct(); } });
  const close = async (p) => { if (!confirm(`Close ${p.templateName}${p.mode === 'live' ? ' on Zerodha (LIVE)' : ''}?`)) return; try { const c = await api.post(`/options/positions/${p._id}/close`); toast(`Closed: ${inr(c.pnl)}`); reload(); reloadAcct(); } catch (e) { toast(e.message, 'err'); } };
  const open = (rows || []).filter((p) => p.status !== 'closed');
  const closed = (rows || []).filter((p) => p.status === 'closed');
  return (
    <div className="col" style={{ gap: 14 }}>
      {acct && (
        <div className="grid g-4">
          <div className="card stat"><span className="stat-label">Options equity · {mode}</span><span className="stat-value">{inr(acct.equity)}</span><span className="stat-sub muted">free {inr(acct.free)}</span></div>
          <div className="card stat"><span className="stat-label">Open risk (max loss)</span><span className="stat-value down">{inr(acct.openRisk)}</span><span className="stat-sub muted">{acct.openPositions} position(s)</span></div>
          <div className="card stat"><span className="stat-label">Unrealized</span><span className={`stat-value ${tone(acct.unrealized)}`}>{inr(acct.unrealized)}</span><span className="stat-sub muted">at bid/ask, after charges</span></div>
          <div className="card stat"><span className="stat-label">Realized</span><span className={`stat-value ${tone(acct.realized)}`}>{inr(acct.realized)}</span><span className="stat-sub muted">today {inr(acct.realizedToday)}</span></div>
        </div>
      )}
      <div className="card">
        <div className="card-head"><span className="card-title">Open positions</span></div>
        {open.length ? open.map((p) => (
          <div key={p._id} className="position-box" style={{ marginBottom: 10 }}>
            <div className="row wrap between" style={{ gap: 8 }}>
              <span className="bold">{p.templateName} · {p.underlying} {p.expiry} · x{p.lots}{p.botId ? <span className="badge ai" style={{ marginLeft: 6 }}><Bot size={11} /> bot</span> : null}{p.status === 'closing' ? <span className="badge warn" style={{ marginLeft: 6 }}>closing…</span> : null}</span>
              <span className={`mono bold ${tone(p.live?.pnl)}`}>{p.live ? inr(p.live.pnl) : '—'}</span>
            </div>
            <div className="row wrap small muted" style={{ gap: 14, margin: '6px 0' }}>
              <span>Max profit {p.maxProfit === null ? 'open' : inr(p.maxProfit)}</span><span>Max loss {inr(p.maxLoss)}</span><span>BE {p.breakevens?.map(fmtPrice).join(' / ')}</span>
              <span>TP {p.tpPct}% · SL {p.slPct}% · {p.autoManage ? 'auto-managed' : 'manual'}</span><span>opened {ago(p.openedAt)}</span>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {(p.live?.legs || p.legs).map((l) => <span key={l.tradingsymbol} className="badge" title={`entry ${l.entryPrice}`}>{l.side} {l.strike}{l.type} @ {fmtPrice(l.entryPrice)}{l.mark !== undefined ? ` → ${fmtPrice(l.mark)}` : ''}</span>)}
            </div>
            {p.lastError && <div className="alert error small" style={{ marginTop: 6 }}>{p.lastError}</div>}
            <button className="btn sm danger" style={{ marginTop: 8 }} onClick={() => close(p)} disabled={p.status === 'closing'}>Close position</button>
          </div>
        )) : <Empty icon={Layers} title="No open option positions">Build a strategy from the chain, or start an option bot.</Empty>}
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">Closed</span></div>
        {closed.length ? (
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>Closed</th><th>Strategy</th><th>Expiry</th><th className="num">Lots</th><th className="num">PnL</th><th>Reason</th></tr></thead>
              <tbody>{closed.map((p) => <tr key={p._id}><td className="small muted">{fmtTime(p.closedAt)}</td><td>{p.templateName} {p.underlying}</td><td className="small">{p.expiry}</td><td className="num">{p.lots}</td><td className={`num ${tone(p.pnl)}`}>{inr(p.pnl)}</td><td className="small muted">{p.closeReason}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <div className="small dim">No closed trades yet.</div>}
      </div>
    </div>
  );
}

// ---- Option bots ----
function OptionBots({ meta }) {
  const { toast } = useApp();
  const [bots, , reload] = usePoll('/options/bots', 20000);
  const [form, setForm] = useState(null);
  useServerEvents((t) => t === 'options' && reload());
  const act = async (b, what) => { try { if (what === 'delete') { if (!confirm(`Delete ${b.name}?`)) return; await api.del(`/options/bots/${b._id}`); } else { if (what === 'start' && b.mode === 'live' && !confirm(`Start ${b.name} in LIVE mode? It will place real Zerodha orders.`)) return; await api.post(`/options/bots/${b._id}/${what}`); } reload(); } catch (e) { toast(e.message, 'err'); } };
  const save = async () => { try { await api.post('/options/bots', form); toast('Option bot created'); setForm(null); reload(); } catch (e) { toast(e.message, 'err'); } };
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card row wrap between">
        <div><div className="bold">Option bots</div><div className="small muted">The AI reads NIFTY / BANKNIFTY: bullish → bull call spread, bearish → bear put spread, quiet range → iron condor. Every entry passes the risk gates; exits at take-profit, stop, AI flip or the morning of expiry.</div></div>
        <button className="btn primary" onClick={() => setForm({ ...(meta?.botDefaults || {}) })}><Plus size={14} /> New option bot</button>
      </div>
      {form && (
        <div className="card col" style={{ gap: 12 }}>
          <div className="grid g-3" style={{ gap: 10 }}>
            <Field label="Name"><input className="input" value={form.name || ''} onChange={set('name')} placeholder="Auto-named" /></Field>
            <Field label="Underlying"><Seg value={form.underlying} onChange={set('underlying')} options={['NIFTY', 'BANKNIFTY']} /></Field>
            <Field label="Mode"><Seg className="mode" value={form.mode} onChange={set('mode')} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></Field>
            <Field label="Strategy"><select className="select" value={form.template} onChange={set('template')}><option value="auto">AI chooses (auto)</option>{(meta?.templates || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Directional trades"><Seg value={form.directional} onChange={set('directional')} options={[{ value: 'spread', label: 'Spreads' }, { value: 'single', label: 'Single options' }]} /></Field>
            <Field label="Timeframe"><Seg value={form.interval} onChange={set('interval')} options={['5m', '15m', '30m', '1h']} /></Field>
            <Field label="Max risk % per trade"><input className="input mono" type="number" step="0.5" value={form.riskPct} onChange={set('riskPct')} /></Field>
            <Field label="Take-profit % of max"><input className="input mono" type="number" value={form.tpPct} onChange={set('tpPct')} /></Field>
            <Field label="Stop % of max loss"><input className="input mono" type="number" value={form.slPct} onChange={set('slPct')} /></Field>
            <Field label="Days to expiry (min-max)"><div className="row" style={{ gap: 6 }}><input className="input mono" type="number" value={form.minDte} onChange={set('minDte')} /><input className="input mono" type="number" value={form.maxDte} onChange={set('maxDte')} /></div></Field>
            <Field label="Width / condor distance (strikes)"><div className="row" style={{ gap: 6 }}><input className="input mono" type="number" value={form.width} onChange={set('width')} /><input className="input mono" type="number" value={form.distance} onChange={set('distance')} /></div></Field>
            <Field label="Entry score threshold"><input className="input mono" type="number" value={form.threshold} onChange={set('threshold')} /></Field>
          </div>
          <div className="row between card" style={{ padding: 10 }}>
            <div><div className="small bold">Require proven edge</div><div className="tiny muted">On: trade a direction only when the AI's history-calibrated signal confirms it (fewer, better trades). Off: any score past the threshold.</div></div>
            <Switch checked={form.requireEdge !== false} onChange={set('requireEdge')} />
          </div>
          <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={save}>Create bot</button><button className="btn ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      {bots?.length ? (
        <div className="grid g-2">
          {bots.map((b) => (
            <div key={b._id} className={`card bot-card ${b.status === 'running' ? 'running' : ''}`}>
              <div className="row between"><span className="bold">{b.name}</span><span className={`badge ${b.mode === 'live' ? 'down' : 'accent'}`}>{b.mode.toUpperCase()}</span></div>
              <div className="tiny muted">{b.underlying} · {b.template === 'auto' ? 'AI auto' : b.template} · {b.interval} · risk {b.riskPct}% · TP {b.tpPct}% / SL {b.slPct}% · DTE {b.minDte}-{b.maxDte}</div>
              <div className="row small" style={{ gap: 14, margin: '8px 0' }}><span>Trades {b.stats?.trades || 0}</span><span>Wins {b.stats?.wins || 0}</span><span className={tone(b.stats?.pnl)}>PnL {inr(b.stats?.pnl || 0)}</span></div>
              {b.lastSignal && <div className="tiny dim">Last: {b.lastSignal.signal} · score {b.lastSignal.score} · {b.lastSignal.regime} · {ago(b.lastSignal.time)}</div>}
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                {b.status === 'running' ? <button className="btn sm" onClick={() => act(b, 'stop')}><Square size={12} /> Stop</button> : <button className="btn sm primary" onClick={() => act(b, 'start')}><Play size={12} /> Start</button>}
                <button className="btn sm ghost danger" onClick={() => act(b, 'delete')}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="card"><Empty icon={Bot} title="No option bots">Create one; start it in paper mode first.</Empty></div>}
    </div>
  );
}

export default function Options() {
  const [tab, setTab] = useState('trade');
  const [meta] = usePoll('/options/meta');
  const [k, setK] = useState(0);
  const traded = useMemo(() => () => { setK((x) => x + 1); setTab('positions'); }, []);
  return (
    <>
      <div className="alert warn small" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} /> <span>NSE index options (NIFTY, BANKNIFTY) via Zerodha. <b>Defined-risk only</b>: every sold option must be covered, so the maximum loss is known before entry. SEBI found ~9 in 10 individual F&amp;O traders lose money - start in paper mode. Options cannot be backtested here (Kite has no prices for expired contracts).</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'trade', label: 'Chain & builder' }, { value: 'positions', label: 'Positions' }, { value: 'bots', label: 'Option bots' }]} />
      {tab === 'trade' && <ChainAndBuilder meta={meta} onTraded={traded} />}
      {tab === 'positions' && <Positions reloadKey={k} />}
      {tab === 'bots' && <OptionBots meta={meta} />}
    </>
  );
}
