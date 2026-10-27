import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Play, Filter } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { CoinIcon, SignalBadge, GradeBadge, RegimeChip, Seg, Spinner, Empty, ScoreBar } from '../components/ui.jsx';
import { fmtPrice, fmtPct, fmtCompact, baseOf, tone } from '../lib/format.js';

export default function Scanner() {
  const { setSymbol, setInterval, toast, exchange, market } = useApp();
  const nav = useNavigate();
  const [interval, setIv] = useState('1h');
  const [universe, setUniverse] = useState(100);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const [showAll, setShowAll] = useState(false);

  const scan = async () => {
    setBusy(true);
    try {
      const symbols = custom.split(/[\s,]+/).filter(Boolean).map((s) => (market !== 'crypto' || s.toUpperCase().endsWith('USDT') ? s.toUpperCase() : `${s.toUpperCase()}USDT`));
      setRes(await api.post('/ai/scan', { interval, symbols, universe, exchange }));
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  const open = (s) => { setSymbol(s); setInterval(interval); nav('/terminal'); };
  const maxFunnel = res?.funnel?.[0]?.count || 1;

  return (
    <>
      <div className="card">
        <div className="row wrap between" style={{ gap: 12 }}>
          <div>
            <div className="bold" style={{ fontSize: 16 }}>AI Scanner 2.0 <span className="badge flat">{exchange}</span></div>
            <div className="small muted">100+ coins → liquidity → volatility → regime → AI score → risk filter → top 10 setups (with live order flow).</div>
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            <input className="input" style={{ width: 230 }} placeholder="Optional: BTC, ETH, SOL…" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Seg value={String(universe)} onChange={(v) => setUniverse(+v)} options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '150', label: '150' }]} />
            <Seg value={interval} onChange={setIv} options={['15m', '1h', '4h', '1d']} />
            <button className="btn primary" onClick={scan} disabled={busy}>{busy ? <><Spinner /> Scanning…</> : <><Play size={15} /> Scan Market</>}</button>
          </div>
        </div>
      </div>

      {res && (
        <div className="grid g-wide">
          <div className="card">
            <div className="card-head"><span className="card-title"><Radar size={14} /> Top Setups</span><span className="tiny dim">{res.durationMs} ms · ranked by expected return per unit of risk</span></div>
            {res.top.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Coin</th><th>Signal</th><th className="num">Confidence</th><th className="num">R:R</th><th className="num">E[return]</th><th>Regime</th><th>Quality</th><th className="num">Order flow</th></tr></thead>
                  <tbody>
                    {res.top.map((r) => (
                      <tr key={r.symbol} className="clickable" onClick={() => open(r.symbol)}>
                        <td><div className="coin"><CoinIcon symbol={r.symbol} />{baseOf(r.symbol)}<span className="dim small mono">{fmtPrice(r.price)}</span></div></td>
                        <td><SignalBadge signal={r.signal} /></td>
                        <td className="num">{(r.probability * 100).toFixed(0)}%</td>
                        <td className="num">{r.rr.toFixed(2)}</td>
                        <td className={`num ${tone(r.expectedReturnPct)}`}>{fmtPct(r.expectedReturnPct)}</td>
                        <td><RegimeChip regime={r.regimeName} /></td>
                        <td><GradeBadge grade={r.quality} /></td>
                        <td className={`num ${tone(r.orderFlow?.score)}`}>{r.orderFlow ? `${r.orderFlow.score > 0 ? '+' : ''}${r.orderFlow.score}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={Radar} title="No coin passed every filter">That is a valid answer: no trade is a position too.</Empty>}
          </div>
          <div className="card">
            <div className="card-head"><span className="card-title"><Filter size={14} /> Filter Funnel</span></div>
            <div className="funnel">
              {res.funnel.map((f) => (
                <div key={f.stage} className="col" style={{ gap: 4 }}>
                  <div className="row between small"><span className="muted">{f.stage}</span><span className="mono bold">{f.count}</span></div>
                  <div className="funnel-bar" style={{ width: `${Math.max(2, (f.count / maxFunnel) * 100)}%` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        {res ? (
          <>
            <div className="card-head">
              <span className="card-title">All analysed coins ({res.all.length})</span>
              <button className="btn sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show top 25' : 'Show all'}</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Coin</th><th className="num">24h</th><th className="num">Volume</th><th>Signal</th><th style={{ width: 150 }}>Score</th><th className="num">Prob.</th><th className="num">R:R</th><th>Regime</th><th>Strategy</th><th>Grade</th></tr></thead>
                <tbody>
                  {res.all.slice(0, showAll ? 999 : 25).map((r) => (
                    <tr key={r.symbol} className="clickable" onClick={() => open(r.symbol)}>
                      <td><div className="coin"><CoinIcon symbol={r.symbol} size={22} />{baseOf(r.symbol)}</div></td>
                      <td className={`num ${tone(r.change24h)}`}>{fmtPct(r.change24h)}</td>
                      <td className="num muted">${fmtCompact(r.volumeUsd)}</td>
                      <td><SignalBadge signal={r.signal} /></td>
                      <td><div className="row" style={{ gap: 8 }}><div style={{ flex: 1 }}><ScoreBar value={r.score} /></div><span className={`mono small ${tone(r.score)}`}>{r.score}</span></div></td>
                      <td className="num">{(r.probability * 100).toFixed(0)}%</td>
                      <td className="num">{r.rr.toFixed(2)}</td>
                      <td><RegimeChip regime={r.regimeName} /></td>
                      <td className="small muted">{r.strategy}</td>
                      <td><GradeBadge grade={r.quality} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : busy ? <Empty icon={Radar} title="Scanning the market…">Training a neural net and calibrating probabilities per coin — about 10 seconds.</Empty>
          : <Empty icon={Radar} title="Run a scan to find the best setups" />}
      </div>
    </>
  );
}
