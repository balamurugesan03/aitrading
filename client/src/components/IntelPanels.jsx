// Order Flow, Futures and News panels (used on the Terminal and the Market Intel page).
import { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { ExternalLink } from 'lucide-react';
import { usePoll } from '../lib/hooks.js';
import { Empty, Spinner, ScoreBar } from './ui.jsx';
import { fmtCompact, fmtPrice, ago } from '../lib/format.js';

const chartTheme = {
  layout: { background: { color: 'transparent' }, textColor: '#8792ab', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
  grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(148,163,199,0.06)' } },
  rightPriceScale: { borderColor: 'rgba(148,163,199,0.15)' },
  timeScale: { borderColor: 'rgba(148,163,199,0.15)', timeVisible: true },
};

function MiniSeries({ data, kind = 'line', color = '#3987e5', height = 130, format }) {
  const box = useRef(null);
  useEffect(() => {
    if (!data?.length) return undefined;
    const c = createChart(box.current, { ...chartTheme, autoSize: true, height });
    const s = kind === 'hist'
      ? c.addHistogramSeries({ priceLineVisible: false, priceFormat: format })
      : c.addAreaSeries({ lineColor: color, topColor: `${color}55`, bottomColor: `${color}00`, lineWidth: 2, priceLineVisible: false, priceFormat: format });
    s.setData(kind === 'hist' ? data.map((d) => ({ ...d, color: d.value >= 0 ? 'rgba(22,199,132,0.7)' : 'rgba(234,57,67,0.7)' })) : data);
    c.timeScale().fitContent();
    return () => c.remove();
  }, [data, kind, color, height, format]);
  return <div ref={box} style={{ height }} />;
}

export function OrderFlowPanel({ symbol, exchange = 'binance' }) {
  const [of, err] = usePoll(`/market/orderflow?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}`, 10000, [symbol, exchange]);
  if (err) return <div className="alert error">{err}</div>;
  if (!of) return <div className="empty"><Spinner /> Reading the order book…</div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between">
        <div>
          <div className="tiny dim">AI ORDER FLOW SCORE</div>
          <div className={`mono bold ${of.score > 0 ? 'up' : of.score < 0 ? 'down' : ''}`} style={{ fontSize: 28 }}>{of.score > 0 ? '+' : ''}{of.score}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`badge ${of.bias === 'Bullish' ? 'up' : of.bias === 'Bearish' ? 'down' : 'flat'}`}>{of.bias}</div>
          <div className="tiny dim" style={{ marginTop: 4 }}>Liquidity: {of.liquidity}</div>
        </div>
      </div>
      <div>
        <div className="row between small"><span className="up">Buy pressure {of.buyPressure}%</span><span className="down">Sell {of.sellPressure}%</span></div>
        <div className="meter" style={{ height: 10, marginTop: 6 }}><i style={{ left: 0, width: `${of.buyPressure}%`, background: 'var(--up)' }} /><i style={{ left: `${of.buyPressure}%`, right: 0, background: 'var(--down)', opacity: 0.8 }} /></div>
      </div>
      <div className="kv">
        <span>Book imbalance (±1%)</span><span>{of.imbalance}% bids</span>
        <span>Spread</span><span>{of.spreadBps} bps</span>
        <span>Depth ±0.5% bid / ask</span><span>${fmtCompact(of.depth.bid05)} / ${fmtCompact(of.depth.ask05)}</span>
        <span>Depth ±1% bid / ask</span><span>${fmtCompact(of.depth.bid1)} / ${fmtCompact(of.depth.ask1)}</span>
        <span>Volume delta</span><span className={of.volumeDeltaUsd >= 0 ? 'up' : 'down'}>{of.volumeDeltaUsd >= 0 ? '+' : '-'}${fmtCompact(Math.abs(of.volumeDeltaUsd))}</span>
        <span>Large trades</span><span>{of.largeTrades.count} · buys ${fmtCompact(of.largeTrades.buysUsd)} / sells ${fmtCompact(of.largeTrades.sellsUsd)}</span>
      </div>
      {of.absorption && <div className={`alert ${of.absorption.side === 'bullish' ? 'info' : 'warn'}`}>Absorption: {of.absorption.text}</div>}
      {of.spoofSuspects.length > 0 && <div className="alert warn">Possible spoofing: {of.spoofSuspects.length} large wall(s) pulled before price reached them.</div>}
      <div>
        <div className="card-title" style={{ marginBottom: 8 }}>Liquidity zones (large resting orders)</div>
        {of.liquidityZones.length ? (
          <table>
            <thead><tr><th>Side</th><th className="num">Price</th><th className="num">Size</th><th className="num">Distance</th></tr></thead>
            <tbody>{of.liquidityZones.map((z) => (
              <tr key={`${z.side}${z.price}`}><td className={z.side === 'bid' ? 'up' : 'down'}>{z.side === 'bid' ? 'Bid wall' : 'Ask wall'}</td><td className="num">{fmtPrice(z.price)}</td><td className="num">${fmtCompact(z.usd)}</td><td className="num muted">{z.distPct}%</td></tr>
            ))}</tbody>
          </table>
        ) : <div className="small dim">No unusual walls in the visible book.</div>}
      </div>
    </div>
  );
}

const pctFmt = { type: 'custom', formatter: (v) => `${v.toFixed(4)}%` };
const usdFmt = { type: 'custom', formatter: (v) => `$${fmtCompact(v)}` };

export function FuturesPanel({ symbol }) {
  const [f, err] = usePoll(`/market/futures?symbol=${encodeURIComponent(symbol)}`, 60000, [symbol]);
  if (err) return <div className="alert error">{err}</div>;
  if (!f) return <div className="empty"><Spinner /> Loading futures data…</div>;
  if (!f.available) return <Empty title="No futures data">{f.error}</Empty>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between">
        <div>
          <div className="tiny dim">FUTURES POSITIONING SCORE</div>
          <div className={`mono bold ${f.score > 0 ? 'up' : f.score < 0 ? 'down' : ''}`} style={{ fontSize: 28 }}>{f.score > 0 ? '+' : ''}{f.score}</div>
        </div>
        {f.squeezeRisk && <span className="badge warn">Squeeze risk</span>}
      </div>
      <div className="insight">{f.relationship}</div>
      {f.risks.map((r) => <div key={r} className="alert warn small">{r}</div>)}
      <div className="kv">
        <span>Funding rate (8h)</span><span className={f.fundingRatePct > 0.03 ? 'down' : ''}>{f.fundingRatePct}%</span>
        <span>Funding 30-period avg</span><span>{f.fundingAvg30Pct}%</span>
        <span>Open interest</span><span>${fmtCompact(f.openInterestUsd)} ({f.oiChange24hPct > 0 ? '+' : ''}{f.oiChange24hPct}% 24h)</span>
        <span>Price change 24h</span><span className={f.priceChange24hPct >= 0 ? 'up' : 'down'}>{f.priceChange24hPct}%</span>
        <span>Long/short accounts</span><span>{f.longShortRatio} ({f.longShortChange > 0 ? '+' : ''}{f.longShortChange})</span>
        <span>Top trader L/S</span><span>{f.topTraderRatio ?? '—'}</span>
        <span>Taker buy/sell</span><span>{f.takerBuySellRatio ?? '—'}</span>
        <span>Basis (mark vs index)</span><span>{f.basisPct}%</span>
        <span>Futures volume 24h</span><span>${fmtCompact(f.futuresVolumeUsd)}</span>
        <span>Liquidations 24h</span><span>{f.liquidations.streamConnected ? <>longs ${fmtCompact(f.liquidations.longsUsd)} · shorts ${fmtCompact(f.liquidations.shortsUsd)}</> : 'stream connecting…'}</span>
      </div>
      <div>
        <div className="card-title" style={{ marginBottom: 4 }}>Open interest (USD, 1h)</div>
        <MiniSeries data={f.oiSeries} color="#3987e5" format={usdFmt} />
      </div>
      <div>
        <div className="card-title" style={{ marginBottom: 4 }}>Funding rate history (% per 8h)</div>
        <MiniSeries data={f.fundingSeries} kind="hist" format={pctFmt} height={110} />
      </div>
      <div className="tiny dim">Analytics only - VelocityX does not place futures orders. Validate on paper/testnet before any futures automation.</div>
    </div>
  );
}

export function NewsPanel({ asset, limit = 12 }) {
  const [n, err] = usePoll(`/market/news${asset ? `?asset=${asset}` : ''}`, 300000, [asset]);
  if (err) return <div className="alert error">{err}</div>;
  if (!n) return <div className="empty"><Spinner /> Reading the news…</div>;
  const s = n.summary;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between">
        <div>
          <div className="tiny dim">NEWS SENTIMENT · {s.asset || 'MARKET'} · 24h</div>
          <div className={`mono bold ${s.sentiment > 0 ? 'up' : s.sentiment < 0 ? 'down' : ''}`} style={{ fontSize: 28 }}>{s.sentiment > 0 ? '+' : ''}{s.sentiment}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${s.impact === 'HIGH' ? 'warn' : 'flat'}`}>Impact {s.impact}</span>
          <div className="tiny dim" style={{ marginTop: 4 }}>Risk engine: {s.riskAction === 'none' ? 'no change' : s.riskAction === 'block' ? 'blocks entries' : `size × ${s.riskMultiplier}`}</div>
        </div>
      </div>
      <div className="tiny dim">Scored by {s.method === 'claude' ? 'Claude NLP' : 'keyword NLP (add ANTHROPIC_API_KEY for Claude)'} · {n.items.length} stories</div>
      <div className="col" style={{ gap: 2 }}>
        {n.items.slice(0, limit).map((x) => (
          <a key={x.id} href={x.link} target="_blank" rel="noreferrer" className="row" style={{ gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
            <span className={`mono small bold ${x.sentiment > 0 ? 'up' : x.sentiment < 0 ? 'down' : 'flat'}`} style={{ width: 36, flexShrink: 0, textAlign: 'right' }}>{x.sentiment > 0 ? '+' : ''}{x.sentiment}</span>
            <span style={{ flex: 1 }}>
              <span className="small">{x.title}</span>
              <span className="row wrap tiny dim" style={{ gap: 6, marginTop: 3 }}>
                {x.source} · {ago(x.time)} · {x.category}{x.impact === 'HIGH' && <span className="badge warn" style={{ padding: '0 6px' }}>HIGH</span>}
                {x.assets.map((a) => <span key={a} className="badge flat" style={{ padding: '0 6px' }}>{a}</span>)}
              </span>
            </span>
            <ExternalLink size={12} className="dim" />
          </a>
        ))}
        {!n.items.length && <Empty title="No stories" />}
      </div>
    </div>
  );
}

export { ScoreBar };
