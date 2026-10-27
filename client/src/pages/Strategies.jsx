import { useState } from 'react';
import { Library, Play, Trophy } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { RegimeChip, Spinner, Empty } from '../components/ui.jsx';
import { fmtTime, tone } from '../lib/format.js';

export default function Strategies() {
  const { toast } = useApp();
  const [data, , reload] = usePoll('/strategies');
  const [busy, setBusy] = useState(false);

  const bench = async () => {
    setBusy(true);
    try {
      await api.post('/strategies/benchmark', { symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], intervals: ['15m', '1h', '4h'], candles: 3000 });
      reload();
      toast('Benchmark complete');
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  const stats = Object.fromEntries((data?.benchmark?.strategies || []).map((s) => [s.id, s]));
  return (
    <>
      <div className="card">
        <div className="row wrap between" style={{ gap: 12 }}>
          <div>
            <div className="bold" style={{ fontSize: 16 }}>Strategy Library</div>
            <div className="small muted">
              {data?.benchmark ? <>Out-of-sample benchmark on {data.benchmark.symbols.join(', ')} × {data.benchmark.intervals.join(', ')} · {fmtTime(data.benchmark.time)}</> : 'Run the benchmark to measure every strategy on the same markets (last 30% of history, unseen by any optimisation).'}
            </div>
          </div>
          <button className="btn primary" onClick={bench} disabled={busy}>{busy ? <><Spinner /> Benchmarking…</> : <><Play size={15} /> Run Benchmark</>}</button>
        </div>
      </div>

      {!data ? <div className="empty"><Spinner /></div> : (
        <div className="grid g-3">
          {data.strategies.map((s) => {
            const b = stats[s.id];
            return (
              <div key={s.id} className="card strategy-card">
                <div className="row between">
                  <span className="bold" style={{ fontSize: 15 }}>{s.name}</span>
                  {b && b === data.benchmark.strategies[0] && <span className="badge up"><Trophy size={11} /> Top ranked</span>}
                  {s.liveOnly && <span className="badge ai">Live only</span>}
                </div>
                <div className="small muted" style={{ minHeight: 40 }}>{s.description}</div>
                {b ? (
                  <>
                    <div className="metric-grid">
                      <div><small>Win rate</small><b>{b.winRate}%</b></div>
                      <div><small>Profit factor</small><b className={b.profitFactor >= 1 ? 'up' : 'down'}>{b.profitFactor}</b></div>
                      <div><small>Max DD</small><b className="down">-{b.maxDrawdownPct}%</b></div>
                      <div><small>Sharpe</small><b className={tone(b.sharpe)}>{b.sharpe}</b></div>
                      <div><small>OOS return</small><b className={tone(b.oosReturnPct)}>{b.oosReturnPct}%</b></div>
                      <div><small>Trades</small><b>{b.trades}</b></div>
                    </div>
                    <div className="row wrap small" style={{ gap: 8 }}>
                      <span className="muted">Best timeframe</span><b>{b.bestTimeframe || '—'}</b>
                      <span className="muted">· Best regime</span>{b.bestRegime ? <RegimeChip regime={b.bestRegime} /> : <b>—</b>}
                    </div>
                    <div className="tiny dim">Profitable on {b.profitableMarkets}/{b.markets} markets</div>
                  </>
                ) : (
                  <div className="small dim">{s.liveOnly ? 'Not backtestable (needs live Claude reasoning).' : s.id === 'dca' ? 'Backtest DCA in the Backtest Lab.' : 'No benchmark yet.'}</div>
                )}
                <div className="row wrap" style={{ gap: 6 }}>
                  {s.timeframes?.map((t) => <span key={t} className="badge flat">{t}</span>)}
                  {s.regimes?.map((r) => <RegimeChip key={r} regime={r} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data && !data.benchmark && !busy && <div className="card"><Empty icon={Library} title="No benchmark yet">Takes about 10–20 seconds.</Empty></div>}
    </>
  );
}
