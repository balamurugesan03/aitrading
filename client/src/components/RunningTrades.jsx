import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { api } from '../lib/api.js';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { CoinIcon, Empty } from './ui.jsx';
import { fmtMoney, fmtPct, fmtPrice, fmtQty, ago, tone, quoteOf, durationLeft, openNetPnl } from '../lib/format.js';

// Every bot trade that is open right now (paper and live), with its live profit / loss.
// Prices refresh every 5 s per exchange; positions refresh when a trade happens.
export default function RunningTrades() {
  const [bots, , reload] = usePoll('/bots', 15000);
  const [prices, setPrices] = useState({});
  const [lives, setLives] = useState({}); // botId -> net P&L from the server position guard (~2 s)
  const open = (bots || []).filter((b) => b.position?.qty > 0);
  const key = open.map((b) => `${b.exchange || 'binance'}:${b.symbol}`).sort().join(',');

  useEffect(() => {
    if (!key) return undefined;
    const byEx = {};
    open.forEach((b) => { (byEx[b.exchange || 'binance'] ||= new Set()).add(b.symbol); });
    const load = () => Object.entries(byEx).forEach(([ex, syms]) => {
      api.get(`/market/tickers?symbols=${encodeURIComponent([...syms].join(','))}&exchange=${ex}`)
        .then((rows) => setPrices((p) => ({ ...p, ...Object.fromEntries(rows.map((t) => [`${ex}:${t.symbol}`, t.price])) })))
        .catch(() => {});
    });
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useServerEvents((type, p) => {
    if (type === 'trade' || type === 'bot') reload();
    if (type === 'position' && p?.price) {
      const b = (bots || []).find((x) => x._id === p.botId);
      if (b) setPrices((s) => ({ ...s, [`${b.exchange || 'binance'}:${b.symbol}`]: p.price }));
      if (p.live) setLives((s) => ({ ...s, [p.botId]: p.live }));
    }
  });

  const rows = open.map((b) => {
    const pos = b.position;
    const short = pos.side === 'short';
    const price = prices[`${b.exchange || 'binance'}:${b.symbol}`];
    // If closed now, after the exit fee: the same number take-profit / stop-loss trigger on.
    const { pnl, pct } = openNetPnl(pos, price, lives[b._id]);
    return { b, pos, short, price, pnl, pct, ccy: quoteOf(b.symbol) };
  });
  // Totals per mode and currency (USDT and INR are never added together).
  const totals = {};
  rows.forEach((r) => {
    const k = `${r.b.mode}|${r.ccy}`;
    (totals[k] ||= { mode: r.b.mode, ccy: r.ccy, pnl: 0, n: 0 });
    totals[k].pnl += r.pnl || 0;
    totals[k].n++;
  });

  return (
    <div className="card">
      <div className="card-head row wrap between" style={{ gap: 8 }}>
        <span className="card-title"><Activity size={14} /> Running Trades · live P&amp;L</span>
        <div className="row wrap" style={{ gap: 12 }}>
          {Object.values(totals).map((t) => (
            <span key={t.mode + t.ccy} className="mono small">
              <span className={`badge ${t.mode === 'live' ? 'down' : 'accent'}`}>{t.mode.toUpperCase()}</span>{' '}
              <b className={tone(t.pnl)}>{t.pnl >= 0 ? '+' : ''}{fmtMoney(t.pnl, t.ccy)}</b> <span className="dim">({t.n} open)</span>
            </span>
          ))}
        </div>
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Bot</th><th>Mode</th><th>Side</th><th>Entry</th><th>Now</th><th>Size</th><th title="If closed now, after fees">Profit / Loss (after fees)</th><th>SL · TP</th><th>Open for</th></tr>
            </thead>
            <tbody>
              {rows.map(({ b, pos, short, price, pnl, pct, ccy }) => (
                <tr key={b._id}>
                  <td><div className="row" style={{ gap: 8 }}><CoinIcon symbol={b.symbol} size={22} /><div><div className="bold">{b.symbol}</div><div className="tiny dim">{b.name}</div></div></div></td>
                  <td><span className={`badge ${b.mode === 'live' ? 'down' : 'accent'}`}>{b.mode.toUpperCase()}</span></td>
                  <td><b className={short ? 'down' : 'up'}>{short ? 'SHORT' : 'LONG'}</b>{pos.leverage ? <span className="dim"> {pos.leverage}x</span> : null}</td>
                  <td className="mono">{fmtPrice(pos.entry)}</td>
                  <td className="mono">{price ? fmtPrice(price) : '…'}</td>
                  <td className="mono">{fmtQty(pos.qty)}</td>
                  <td className={`mono bold ${tone(pnl)}`}>{pnl == null ? '…' : <>{pnl >= 0 ? '+' : ''}{fmtMoney(pnl, ccy)} <span className="small">({fmtPct(pct)})</span></>}</td>
                  <td className="mono small"><span className="down">{pos.stopLoss > 0 ? fmtPrice(pos.stopLoss) : '—'}</span> · <span className="up">{fmtPrice(pos.takeProfit)}</span></td>
                  <td className="small muted">{pos.openedAt ? ago(pos.openedAt) : '—'}{b.maxHoldMin > 0 && pos.openedAt ? <div className="tiny">duration ends in {durationLeft(pos.openedAt, b.maxHoldMin)}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty icon={Activity} title="No running trades">When a bot opens a trade (paper or live) it shows here with its live profit / loss.</Empty>}
    </div>
  );
}
