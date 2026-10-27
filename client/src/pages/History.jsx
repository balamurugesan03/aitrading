import { useState } from 'react';
import { History as HistoryIcon, Download } from 'lucide-react';
import { usePoll } from '../lib/hooks.js';
import { CoinIcon, Seg, Empty } from '../components/ui.jsx';
import { fmtPrice, fmtUsd, fmtPct, fmtQty, fmtTime, tone, baseOf } from '../lib/format.js';

export default function HistoryPage() {
  const [mode, setMode] = useState('all');
  const [trades] = usePoll(`/trades?limit=1000${mode !== 'all' ? `&mode=${mode}` : ''}`, 15000, [mode]);
  const closed = (trades || []).filter((t) => t.pnl !== undefined);
  const total = closed.reduce((s, t) => s + t.pnl, 0);
  const fees = (trades || []).reduce((s, t) => s + (t.fee || 0), 0);

  const exportCsv = () => {
    const head = 'time,mode,bot,symbol,side,qty,price,value,fee,pnl,reason';
    const rows = (trades || []).map((t) => [new Date(t.time).toISOString(), t.mode, t.botName, t.symbol, t.side, t.qty, t.price, t.cost, t.fee, t.pnl ?? '', `"${t.reason || ''}"`].join(','));
    const url = URL.createObjectURL(new Blob([[head, ...rows].join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'velocityx-trades.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="grid g-4">
        <div className="card stat"><span className="stat-label">Total trades</span><span className="stat-value">{trades?.length ?? '…'}</span></div>
        <div className="card stat"><span className="stat-label">Realized PnL</span><span className={`stat-value ${tone(total)}`}>{fmtUsd(total)}</span></div>
        <div className="card stat"><span className="stat-label">Win rate</span><span className="stat-value">{closed.length ? `${((closed.filter((t) => t.pnl > 0).length / closed.length) * 100).toFixed(1)}%` : '—'}</span></div>
        <div className="card stat"><span className="stat-label">Fees paid</span><span className="stat-value">{fmtUsd(fees)}</span></div>
      </div>
      <div className="card">
        <div className="card-head">
          <span className="card-title"><HistoryIcon size={14} /> Trade Ledger</span>
          <div className="row" style={{ gap: 10 }}>
            <Seg value={mode} onChange={setMode} options={[{ value: 'all', label: 'All' }, { value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} />
            <button className="btn sm" onClick={exportCsv} disabled={!trades?.length}><Download size={13} /> CSV</button>
          </div>
        </div>
        {trades?.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Source</th><th>Pair</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Value</th><th className="num">Fee</th><th className="num">PnL</th><th>Reason</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id}>
                    <td className="small muted">{fmtTime(t.time)}</td>
                    <td><span className={`badge ${t.mode === 'live' ? 'down' : 'accent'}`}>{t.mode}</span> <span className="small">{t.botName}</span></td>
                    <td><div className="coin"><CoinIcon symbol={t.symbol} size={22} />{baseOf(t.symbol)}</div></td>
                    <td><span className={`badge ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                    <td className="num">{fmtQty(t.qty)}</td>
                    <td className="num">{fmtPrice(t.price)}</td>
                    <td className="num">{fmtUsd(t.cost)}</td>
                    <td className="num muted">{fmtUsd(t.fee, 4)}</td>
                    <td className={`num ${tone(t.pnl)}`}>{t.pnl !== undefined ? `${fmtUsd(t.pnl)} (${fmtPct(t.pnlPct)})` : '—'}</td>
                    <td className="small muted">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={HistoryIcon} title="No trades recorded yet" />}
      </div>
    </>
  );
}
