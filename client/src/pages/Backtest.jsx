import { useEffect, useState } from 'react';
import { FlaskConical, Play, Shuffle, Layers, SlidersHorizontal, AlertTriangle, Target } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll } from '../lib/hooks.js';
import { EquityChart } from '../components/CandleChart.jsx';
import { Field, Switch, Spinner, Empty, Histogram, RegimeChip, Tabs } from '../components/ui.jsx';
import CoinSearch from '../components/CoinSearch.jsx';
import { fmtUsd, fmtPct, fmtPrice, fmtTime, tone } from '../lib/format.js';

const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const TFS = ['5m', '15m', '1h', '4h', '1d'];
const FX_PAIRS = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
const FX_TFS = ['5m', '15m', '1h', '1d'];
// Defaults per market: NSE forex futures cost ~0.03% per side (Zerodha brokerage cap) with paisa-level spreads.
const CRYPTO_DEFAULTS = { symbols: ['BTCUSDT'], intervals: ['1h'], candles: 3000, startBalance: 10000, feePct: 0.1, slippageBps: 5, spreadBps: 2 };
const STOCKS = ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'];
const STOCK_DEFAULTS = { symbols: ['RELIANCE'], intervals: ['1h'], candles: 3000, startBalance: 1000000, feePct: 0.12, slippageBps: 3, spreadBps: 3 };
const FUTURES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'RELIANCE', 'HDFCBANK'];
// NSE futures: ~0.02% per side (brokerage cap + STT on sells), tight spreads. The backtest sizes by notional (no lots/margin).
const FUTURES_DEFAULTS = { symbols: ['NIFTY'], intervals: ['15m'], candles: 1500, startBalance: 2500000, feePct: 0.02, slippageBps: 1, spreadBps: 1 };
// Binance USD-M perpetuals: 0.05% taker, funding ~0.01% per 8h, 2x isolated leverage with liquidation simulated.
const PERP_DEFAULTS = { symbols: ['BTCUSDT'], intervals: ['1h'], candles: 3000, startBalance: 10000, feePct: 0.05, slippageBps: 2, spreadBps: 1, fundingRatePct8h: 0.01, leverage: 2 };
const FX_DEFAULTS = { symbols: ['USDINR'], intervals: ['1h'], candles: 1500, startBalance: 1000000, feePct: 0.03, slippageBps: 0.5, spreadBps: 0.5 };

function Toggles({ options, value, onChange, max }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" className={`chip-toggle ${on ? 'on' : ''}`}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : value.length < max ? [...value, o] : value)}>{o.replace('USDT', '')}</button>
        );
      })}
    </div>
  );
}

const SEGMENTS = [['train', 'Train'], ['validation', 'Validation'], ['outOfSample', 'Out-of-sample'], ['full', 'Full period']];

function ComboResult({ r }) {
  const { money } = useApp();
  const fmtUsd = money; // results are in the account currency (INR for NSE)
  const [tab, setTab] = useState('overview');
  if (r.error) return <div className="alert error">{r.symbol} {r.interval}: {r.error}</div>;
  const oos = r.segments.outOfSample;
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title"><Target size={14} /> {r.symbol} · {r.interval} · {r.strategy}</span>
        <span className="tiny dim">{r.candles} candles · {fmtTime(r.period.from * 1000)} → {fmtTime(r.period.to * 1000)}</span>
      </div>
      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {[
          ['OOS return', fmtPct(oos.totalReturnPct), tone(oos.totalReturnPct), `buy & hold ${fmtPct(oos.buyHoldReturnPct)}`],
          ['OOS win rate', `${oos.winRate}%`, '', `${oos.trades} trades · PF ${oos.profitFactor}`],
          ['OOS max drawdown', `-${oos.maxDrawdownPct}%`, 'down', `Sharpe ${oos.sharpe}`],
          ['Walk-forward', r.walkForward ? fmtPct(r.walkForward.oosReturnPct) : '—', tone(r.walkForward?.oosReturnPct), r.walkForward ? `${r.walkForward.profitableFolds}/${r.walkForward.folds.length} folds profitable` : 'disabled'],
        ].map(([l, v, cls, sub]) => (
          <div key={l} className="stat" style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
            <span className="stat-label">{l}</span><span className={`stat-value ${cls}`} style={{ fontSize: 21 }}>{v}</span><span className="stat-sub muted">{sub}</span>
          </div>
        ))}
      </div>
      {r.optimization?.overfitWarning && <div className="alert warn" style={{ marginBottom: 12 }}><AlertTriangle size={15} /> {r.optimization.overfitWarning}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Equity & segments' }, { value: 'wf', label: 'Walk-forward' }, { value: 'mc', label: 'Monte Carlo' },
        ...(r.optimization ? [{ value: 'opt', label: 'Optimizer' }] : []), { value: 'regime', label: 'By regime' }, { value: 'trades', label: 'Trades' },
      ]} />

      {tab === 'overview' && (
        <>
          <EquityChart points={r.equity} height={280} marker={r.oosStartTime ? { time: r.oosStartTime, text: 'Out-of-sample →' } : null} />
          <div className="tiny dim" style={{ margin: '6px 0 12px' }}>Solid = strategy equity · dashed = buy &amp; hold · arrow = start of the out-of-sample period. Params: threshold {r.params.threshold}{r.params.slMult ? `, SL ${r.params.slMult} ATR, TP ${r.params.tpMult} ATR` : ', strategy defaults'}</div>
          <div className="table-wrap">
            <table className="seg-table">
              <thead><tr><th>Segment</th><th className="num">Return</th><th className="num">Buy &amp; hold</th><th className="num">Trades</th><th className="num">Win</th><th className="num">PF</th><th className="num">Max DD</th><th className="num">Sharpe</th><th className="num">Time in market</th></tr></thead>
              <tbody>
                {SEGMENTS.map(([k, label]) => {
                  const m = r.segments[k];
                  return (
                    <tr key={k} className={k === 'outOfSample' ? 'oos' : ''}>
                      <td className="seg">{label}</td>
                      <td className={`num ${tone(m.totalReturnPct)}`}>{fmtPct(m.totalReturnPct)}</td>
                      <td className={`num ${tone(m.buyHoldReturnPct)}`}>{fmtPct(m.buyHoldReturnPct)}</td>
                      <td className="num">{m.trades}</td><td className="num">{m.winRate}%</td><td className="num">{m.profitFactor}</td>
                      <td className="num down">-{m.maxDrawdownPct}%</td><td className="num">{m.sharpe}</td><td className="num">{m.exposurePct ?? '—'}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'wf' && (r.walkForward ? (
        <>
          <div className="small muted" style={{ marginBottom: 10 }}>Anchored walk-forward: parameters are chosen on all data before each fold, then tested on the fold. Efficiency {r.walkForward.efficiency ?? 'n/a'} (out-of-sample return per bar ÷ in-sample return per bar; above 0.5 is healthy).</div>
          <div className="table-wrap"><table>
            <thead><tr><th>Fold</th><th>Test period</th><th>Params</th><th className="num">In-sample</th><th className="num">Out-of-sample</th><th className="num">OOS trades</th><th className="num">OOS win</th></tr></thead>
            <tbody>{r.walkForward.folds.map((f) => (
              <tr key={f.fold}><td>{f.fold}</td><td className="small muted">{fmtTime(f.from * 1000)} → {fmtTime(f.to * 1000)}</td><td className="small mono">t{f.params.threshold}{f.params.slMult ? ` sl${f.params.slMult} tp${f.params.tpMult}` : ''}</td>
                <td className={`num ${tone(f.inSample.totalReturnPct)}`}>{fmtPct(f.inSample.totalReturnPct)}</td><td className={`num bold ${tone(f.outOfSample.totalReturnPct)}`}>{fmtPct(f.outOfSample.totalReturnPct)}</td>
                <td className="num">{f.outOfSample.trades}</td><td className="num">{f.outOfSample.winRate}%</td></tr>
            ))}</tbody>
          </table></div>
        </>
      ) : <Empty title="Walk-forward disabled" />)}

      {tab === 'mc' && (r.monteCarlo ? (
        <>
          <div className="grid g-4" style={{ marginBottom: 12 }}>
            <div><div className="tiny dim">5th PERCENTILE</div><div className={`mono bold ${tone(r.monteCarlo.returnP5)}`}>{fmtPct(r.monteCarlo.returnP5)}</div></div>
            <div><div className="tiny dim">MEDIAN</div><div className={`mono bold ${tone(r.monteCarlo.returnP50)}`}>{fmtPct(r.monteCarlo.returnP50)}</div></div>
            <div><div className="tiny dim">95th PERCENTILE</div><div className={`mono bold ${tone(r.monteCarlo.returnP95)}`}>{fmtPct(r.monteCarlo.returnP95)}</div></div>
            <div><div className="tiny dim">PROBABILITY OF LOSS</div><div className="mono bold down">{r.monteCarlo.probLoss}%</div></div>
          </div>
          <Histogram bins={r.monteCarlo.histogram} />
          <div className="row between tiny dim" style={{ marginTop: 4 }}><span>{fmtPct(r.monteCarlo.histogram[0].from)}</span><span>Distribution of total return across {r.monteCarlo.runs} resampled trade sequences ({r.monteCarlo.trades} trades each)</span><span>{fmtPct(r.monteCarlo.histogram.at(-1).from)}</span></div>
          <div className="small muted" style={{ marginTop: 10 }}>Max drawdown: median {r.monteCarlo.maxDDP50}%, 95th percentile {r.monteCarlo.maxDDP95}%. Plan your risk around the 95th percentile, not the median.</div>
        </>
      ) : <Empty title="Fewer than 5 trades - not enough for Monte Carlo" />)}

      {tab === 'opt' && r.optimization && (
        <>
          <div className="small muted" style={{ marginBottom: 10 }}>Tested {r.optimization.tested} combinations on the training data. The top 5 were re-checked on validation; the best validation result was kept and reported out-of-sample.</div>
          <div className="table-wrap"><table>
            <thead><tr><th>Threshold</th><th>SL × ATR</th><th>TP × ATR</th><th className="num">Train return</th><th className="num">Train Sharpe</th><th className="num">Validation return</th><th className="num">Validation Sharpe</th></tr></thead>
            <tbody>{r.optimization.top.map((t, k) => (
              <tr key={k} className={k === 0 ? 'oos' : ''}><td>{t.params.threshold}</td><td>{t.params.slMult}</td><td>{t.params.tpMult}</td>
                <td className={`num ${tone(t.train.totalReturnPct)}`}>{fmtPct(t.train.totalReturnPct)}</td><td className="num">{t.train.sharpe}</td>
                <td className={`num ${tone(t.validation.totalReturnPct)}`}>{fmtPct(t.validation.totalReturnPct)}</td><td className="num">{t.validation.sharpe}</td></tr>
            ))}</tbody>
          </table></div>
        </>
      )}

      {tab === 'regime' && (
        <>
        {Object.keys(r.segments.full.byDirection || {}).length > 1 || r.segments.full.byDirection?.short ? (
          <div className="table-wrap"><table style={{ marginBottom: 14 }}>
            <thead><tr><th>Direction</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">PnL</th></tr></thead>
            <tbody>{Object.entries(r.segments.full.byDirection).map(([k, g]) => (
              <tr key={k}><td><span className={`badge ${k === 'short' ? 'short' : 'long'}`}>{k.toUpperCase()}</span></td><td className="num">{g.trades}</td><td className="num">{g.winRate}%</td><td className={`num ${tone(g.pnl)}`}>{fmtUsd(g.pnl)}</td></tr>
            ))}</tbody>
          </table></div>
        ) : null}
        <div className="table-wrap"><table>
          <thead><tr><th>Entry regime</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">PnL</th></tr></thead>
          <tbody>{Object.entries(r.segments.full.byRegime).map(([k, g]) => (
            <tr key={k}><td><RegimeChip regime={k} /></td><td className="num">{g.trades}</td><td className="num">{g.winRate}%</td><td className={`num ${tone(g.pnl)}`}>{fmtUsd(g.pnl)}</td></tr>
          ))}</tbody>
        </table></div>
        </>
      )}

      {tab === 'trades' && (
        <div className="table-wrap" style={{ maxHeight: 380 }}>
          <table>
            <thead><tr><th>Time</th><th>Side</th><th className="num">Price</th><th className="num">PnL</th><th>Regime</th><th>Exit</th></tr></thead>
            <tbody>{[...r.trades].reverse().map((t, k) => (
              <tr key={k}><td className="small muted">{fmtTime(t.time * 1000)}</td><td><span className={`badge ${t.side === 'BUY' || t.side === 'COVER' ? 'buy' : 'sell'}`}>{t.side}</span></td><td className="num">{fmtPrice(t.price)}</td>
                <td className={`num ${tone(t.pnl)}`}>{t.pnl !== undefined ? `${fmtUsd(t.pnl)} (${fmtPct(t.pnlPct)})` : ''}</td><td>{t.regime && <RegimeChip regime={t.regime} />}</td><td className="small muted">{t.reason || ''}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Backtest() {
  const { toast, exchange, market, money, exInfo } = useApp();
  const fmtUsd = money;
  const fx = market === 'forex';
  const stocks = market === 'stocks';
  const futures = market === 'futures';
  const perps = market === 'perps';
  const DEF = fx ? FX_DEFAULTS : stocks ? STOCK_DEFAULTS : futures ? FUTURES_DEFAULTS : perps ? PERP_DEFAULTS : CRYPTO_DEFAULTS;
  const [lib] = usePoll('/strategies');
  const [f, setF] = useState({
    strategy: 'adaptive', threshold: 30, riskPct: 1, maxPositionPct: 25,
    trailingStop: true, optimize: false, walkForwardFolds: 4, monteCarloRuns: 1000, trainPct: 70, validationPct: 15,
    latencyBars: 1, fundingRatePct8h: 0, ...DEF,
  });
  useEffect(() => setF((s) => ({ ...s, ...DEF })), [market]); // eslint-disable-line react-hooks/exhaustive-deps
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, , reloadHistory] = usePoll('/backtests');
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));

  const run = async () => {
    if (!f.symbols.length || !f.intervals.length) return toast('Pick at least one coin and one timeframe', 'err');
    setBusy(true);
    try {
      setRes(await api.post('/backtest', { ...f, exchange: fx || stocks || futures || perps ? exchange : 'binance', allowShort: Boolean(f.allowShort && exInfo?.canShort) }));
      reloadHistory();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  const strategies = (lib?.strategies || []).filter((s) => !s.liveOnly);
  const s = res?.summary;
  return (
    <div className="grid g-side">
      <div className="card" style={{ alignSelf: 'start' }}>
        <div className="card-head"><span className="card-title"><FlaskConical size={14} /> Backtest Lab 2.0</span></div>
        <div className="col" style={{ gap: 12 }}>
          <Field label={fx ? 'Pairs (NSE currency futures)' : stocks ? 'Stocks (NSE)' : futures ? 'Futures (NSE index / stock)' : 'Coins (up to 5)'}><Toggles options={fx ? FX_PAIRS : stocks ? STOCKS : futures ? FUTURES : [...new Set([...COINS, ...f.symbols])]} value={f.symbols} onChange={set('symbols')} max={5} />
            {!fx && !stocks && !futures && <div style={{ marginTop: 6 }}><CoinSearch onPick={(c) => !f.symbols.includes(c) && f.symbols.length < 5 && set('symbols')([...f.symbols, c])} /></div>}</Field>
          <Field label="Timeframes (up to 4)"><Toggles options={fx || stocks || futures ? FX_TFS : TFS} value={f.intervals} onChange={set('intervals')} max={4} /></Field>
          <Field label="Strategy">
            <select className="select" value={f.strategy} onChange={set('strategy')}>{strategies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          </Field>
          <Field label="History (candles per market)" hint={fx || futures ? 'Current near-month contract from Kite (needs a Kite login)' : stocks ? 'From Kite historical data (needs a Kite login)' : perps ? 'Perpetual candles from Binance Futures' : 'Up to 5000 from Binance'}><input className="input mono" type="number" value={f.candles} onChange={set('candles')} /></Field>
          <div className="divider" />
          <div className="row small bold" style={{ gap: 6 }}><Layers size={14} /> Validation</div>
          <div className="grid g-2" style={{ gap: 10 }}>
            <Field label="Train %"><input className="input mono" type="number" value={f.trainPct} onChange={set('trainPct')} /></Field>
            <Field label="Validation %"><input className="input mono" type="number" value={f.validationPct} onChange={set('validationPct')} /></Field>
            <Field label="Walk-forward folds"><input className="input mono" type="number" value={f.walkForwardFolds} onChange={set('walkForwardFolds')} /></Field>
            <Field label="Monte Carlo runs"><input className="input mono" type="number" value={f.monteCarloRuns} onChange={set('monteCarloRuns')} /></Field>
          </div>
          <div className="tiny dim">Out-of-sample = {100 - f.trainPct - f.validationPct}% (never used for any decision).</div>
          <div className="row between"><span className="small row" style={{ gap: 6 }}><SlidersHorizontal size={14} /> AI parameter optimizer</span><Switch checked={f.optimize} onChange={set('optimize')} /></div>
          <div className="divider" />
          <div className="row small bold" style={{ gap: 6 }}><Shuffle size={14} /> Costs &amp; execution realism</div>
          <div className="grid g-2" style={{ gap: 10 }}>
            <Field label="Fee % per side"><input className="input mono" type="number" step="0.01" value={f.feePct} onChange={set('feePct')} /></Field>
            <Field label="Slippage (bps)"><input className="input mono" type="number" value={f.slippageBps} onChange={set('slippageBps')} /></Field>
            <Field label="Spread (bps)"><input className="input mono" type="number" value={f.spreadBps} onChange={set('spreadBps')} /></Field>
            <Field label="Latency (bars)" hint="1 = fill next open"><input className="input mono" type="number" value={f.latencyBars} onChange={set('latencyBars')} /></Field>
            {perps && <Field label="Leverage (isolated)" hint="Liquidation is simulated"><input className="input mono" type="number" min="1" max="5" value={f.leverage ?? 2} onChange={set('leverage')} /></Field>}
            <Field label="Funding % per 8h" hint="0 for spot"><input className="input mono" type="number" step="0.001" value={f.fundingRatePct8h} onChange={set('fundingRatePct8h')} /></Field>
            <Field label="Threshold"><input className="input mono" type="number" value={f.threshold} onChange={set('threshold')} /></Field>
            <Field label="Start balance"><input className="input mono" type="number" value={f.startBalance} onChange={set('startBalance')} /></Field>
            <Field label="Base risk %"><input className="input mono" type="number" step="0.1" value={f.riskPct} onChange={set('riskPct')} /></Field>
          </div>
          <div className="row between"><span className="small">Trailing stop</span><Switch checked={f.trailingStop} onChange={set('trailingStop')} /></div>
          {exInfo?.canShort && <div className="row between"><span className="small" title="Strongly bearish scores open shorts (stop above, target below), covered on a bullish score. Blocked in Bull Trend / Breakout regimes.">Include shorts (sell first)</span><Switch checked={Boolean(f.allowShort)} onChange={set('allowShort')} /></div>}
          <button className="btn primary block" onClick={run} disabled={busy}>{busy ? <><Spinner /> Running {f.symbols.length * f.intervals.length} market(s)…</> : <><Play size={15} /> Run Backtest</>}</button>
        </div>
      </div>

      <div className="col" style={{ gap: 18, minWidth: 0 }}>
        {res ? (
          <>
            {s?.avgOosReturnPct !== undefined && (
              <div className="card">
                <div className="row wrap" style={{ gap: 28 }}>
                  <div><div className="tiny dim">MARKETS TESTED</div><div className="mono bold" style={{ fontSize: 20 }}>{s.combos}</div></div>
                  <div><div className="tiny dim">AVG OUT-OF-SAMPLE RETURN</div><div className={`mono bold ${tone(s.avgOosReturnPct)}`} style={{ fontSize: 20 }}>{fmtPct(s.avgOosReturnPct)}</div></div>
                  <div><div className="tiny dim">AVG OOS BUY &amp; HOLD</div><div className={`mono bold ${tone(s.avgOosBuyHoldPct)}`} style={{ fontSize: 20 }}>{fmtPct(s.avgOosBuyHoldPct)}</div></div>
                  <div><div className="tiny dim">PROFITABLE OUT-OF-SAMPLE</div><div className="mono bold" style={{ fontSize: 20 }}>{s.profitableOos}/{s.combos}</div></div>
                </div>
                <div className="tiny dim" style={{ marginTop: 10 }}>{res.note}</div>
              </div>
            )}
            {res.results.map((r) => <ComboResult key={`${r.symbol}${r.interval}`} r={r} />)}
          </>
        ) : (
          <div className="card"><Empty icon={FlaskConical} title={busy ? 'Simulating…' : 'Validate a strategy before it touches real money'}>Results are reported on out-of-sample data the model and optimizer never saw.</Empty></div>
        )}

        {history?.length > 0 && (
          <div className="card">
            <div className="card-head"><span className="card-title">Previous Runs</span></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Strategy</th><th>Markets</th><th className="num">Avg OOS return</th><th className="num">Profitable OOS</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h._id}>
                      <td className="small muted">{fmtTime(h.time)}</td>
                      <td className="small">{h.params.strategy}{h.params.optimize ? ' (optimised)' : ''}</td>
                      <td className="small">{(h.params.symbols || [h.params.symbol]).map((x) => x?.replace('USDT', '')).join(', ')} · {(h.params.intervals || [h.params.interval]).join(', ')}</td>
                      <td className={`num ${tone(h.summary?.avgOosReturnPct ?? h.metrics?.totalReturnPct)}`}>{fmtPct(h.summary?.avgOosReturnPct ?? h.metrics?.totalReturnPct)}</td>
                      <td className="num">{h.summary ? `${h.summary.profitableOos ?? '—'}/${h.summary.combos}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
