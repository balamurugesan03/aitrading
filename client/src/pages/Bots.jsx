import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus, Play, Square, Trash2, X, Sparkles, Settings2, ScrollText, ShieldCheck, PauseCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { CoinIcon, SignalBadge, GradeBadge, DecisionBadge, RegimeChip, Seg, Switch, Field, Spinner, Empty } from '../components/ui.jsx';
import { fmtPrice, fmtMoney, fmtPct, fmtQty, ago, tone, baseOf, quoteOf, FX_PAIRS, INDEX_FUTURES, isCryptoSymbol, fmtDuration, durationLeft, openNetPnl } from '../lib/format.js';

const DEFAULTS = {
  // EMA Trend on 4h was the only strategy profitable on train, validation and out-of-sample data (2020-2026).
  name: '', autoStart: true, symbol: 'BTCUSDT', interval: '4h', strategy: 'ema_trend', mode: 'paper', useClaude: false,
  threshold: 30, riskPct: 1, maxPositionPct: 25, maxHoldMin: 0, forceTrade: false, stopAfterTrade: false, takeProfitPct: 0, onlyProfitExit: false, tradeAmount: 0, takeProfitUsd: 0, stopLossUsd: 0, trailingStop: true, trailAtr: 2.5, dailyLossLimitPct: 5,
  dcaEvery: 24, dcaTranchePct: 5, dcaMaxTranches: 6, dcaTakeProfitPct: 4, riskProfile: 'balanced',
};

// Auto mode risk levels (the server's bot/autoMode.js holds the actual settings).
const AUTO_PAPER_TRADES = 10;
const RISK_LEVELS = [
  { id: 'safe', icon: '🟢', label: 'Safe', text: 'Small trades, few trades. Follows big trends on the 4h chart. Best for beginners.', facts: '4h chart · trades held up to 3 days · stops for the day after a 2% loss', smallProfit: '+0.5%' },
  { id: 'balanced', icon: '🟡', label: 'Balanced', text: 'The AI picks the best strategy for the market every hour.', facts: '1h chart · trades held up to 1 day · stops for the day after a 4% loss', smallProfit: '+0.4%' },
  { id: 'aggressive', icon: '🔴', label: 'Aggressive', text: 'More trades and bigger size. Can also sell first when the market falls (where the exchange allows it).', facts: '15m chart · trades held up to 4 hours · stops for the day after a 6% loss', smallProfit: '+0.3%' },
];

function AutoSettings({ f, set, initial, quote }) {
  const paperDone = initial?._id && initial.mode === 'paper' ? initial.stats?.trades || 0 : 0;
  const liveUnlocked = initial?.mode === 'live' || paperDone >= AUTO_PAPER_TRADES;
  return (
    <>
      <Field label={`Amount per trade (${quote})`} hint="How much money each trade uses. 0 = the bot decides from your balance.">
        <input className="input mono" type="number" min="0" step="1" value={f.tradeAmount ?? 0} onChange={set('tradeAmount')} />
      </Field>
      <Field label="Risk level">
        <div className="col" style={{ gap: 8 }}>
          {RISK_LEVELS.map((r) => (
            <button key={r.id} type="button" className="card" onClick={() => set('riskProfile')(r.id)}
              style={{ padding: 12, textAlign: 'left', cursor: 'pointer', borderColor: f.riskProfile === r.id ? 'var(--accent)' : undefined, borderWidth: f.riskProfile === r.id ? 2 : undefined }}>
              <div className="bold small">{r.icon} {r.label}{r.id === 'safe' ? <span className="tiny muted"> · recommended to start</span> : null}</div>
              <div className="tiny muted">{r.text}</div>
              <div className="tiny dim" style={{ marginTop: 2 }}>{r.facts}</div>
            </button>
          ))}
        </div>
      </Field>
      <div className="alert info small">
        🤖 <b>The bot sets everything else by itself</b>: timeframe, strategy, stop-loss, profit target and trade size.
        Every candle it reads the market: no new trades when the market is crashing or falling, smaller trades when prices jump a lot.
        Every trade always has a stop-loss and a time limit, so it never gets stuck.
        It sells at the target price, and also takes a small profit (after fees) as soon as one is there: {RISK_LEVELS.find((r) => r.id === f.riskProfile)?.smallProfit}.
      </div>
      {liveUnlocked
        ? <Field label="Mode"><Seg className="mode" value={f.mode} onChange={set('mode')} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></Field>
        : <div className="alert small">📝 Auto bots start with <b>Paper money</b> (no real money). Live trading unlocks after {AUTO_PAPER_TRADES} closed paper trades{initial?._id ? ` (done: ${paperDone})` : ''}.</div>}
    </>
  );
}

function BotForm({ initial, onClose, onSaved }) {
  const { status, toast, exchange } = useApp();
  const [lib] = usePoll('/strategies');
  // New bots start in Auto mode; existing bots keep the mode they were created with.
  const [f, setF] = useState(() => ({ ...DEFAULTS, exchange, ...initial, autoMode: initial?._id ? Boolean(initial.autoMode) : initial?.autoMode ?? true }));
  const exInfo = (status?.exchanges || []).find((e) => e.id === f.exchange);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const strat = lib?.strategies.find((s) => s.id === f.strategy);
  const fx = exInfo?.market === 'forex';
  const stocks = exInfo?.market === 'stocks';
  const futures = exInfo?.market === 'futures';
  const perps = exInfo?.market === 'perps';
  const crypto = exInfo && !fx && !stocks && !futures && exInfo.market !== 'options';
  // Every USDT coin the selected exchange lists (spot, or USD-M perpetuals for Binance futures).
  const [coinList] = usePoll(crypto ? `/market/symbols?quote=USDT&exchange=${f.exchange}` : null, 0, [f.exchange, crypto]);
  const [coinQuery, setCoinQuery] = useState('');
  const nseSymbol = (s, fallback) => (FX_PAIRS.includes(s) || isCryptoSymbol(s) ? fallback : s);
  // Switching the bot's exchange between crypto and NSE forex resets the pair and an unsupported timeframe.
  useEffect(() => {
    if (!exInfo || initial?._id) return;
    setF((s) => ({
      ...s,
      symbol: fx ? (FX_PAIRS.includes(s.symbol) ? s.symbol : 'USDINR')
        : stocks ? (INDEX_FUTURES.includes(s.symbol) ? 'RELIANCE' : nseSymbol(s.symbol, 'RELIANCE'))
          : futures ? nseSymbol(s.symbol, 'NIFTY')
            : isCryptoSymbol(s.symbol) ? s.symbol : 'BTCUSDT',
      interval: exInfo.intervals.includes(s.interval) ? s.interval : '15m',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.exchange, exInfo?.id]);

  const save = async () => {
    setBusy(true);
    try {
      const sym = f.symbol.trim().toUpperCase();
      const full = fx || stocks || futures || sym.endsWith('USDT') ? sym : `${sym}USDT`;
      if (crypto && coinList?.length && !coinList.includes(full)) throw new Error(`${full} is not listed on ${exInfo.name}`);
      const body = { ...f, symbol: full };
      const saved = initial?._id ? await api.patch(`/bots/${initial._id}`, body) : await api.post('/bots', body);
      toast(initial?._id ? 'Bot updated' : `Bot "${saved.name}" created`);
      onSaved();
      onClose();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <div className="bold" style={{ fontSize: 17 }}>{initial?._id ? 'Edit AI Bot' : 'Create AI Trading Bot'}</div>
          <button className="btn ghost icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <Field label="Setup" hint={f.autoMode ? 'Auto: pick a coin, an amount and a risk level. The bot handles the rest.' : 'Manual: every setting is yours to set. For experienced traders.'}>
            <Seg value={f.autoMode ? 'auto' : 'manual'} onChange={(v) => set('autoMode')(v === 'auto')} options={[{ value: 'auto', label: '🤖 Auto (easy)' }, { value: 'manual', label: '⚙️ Manual (advanced)' }]} />
          </Field>
          <div className="grid g-2" style={{ gap: 12 }}>
            <Field label="Bot name"><input className="input" value={f.name} onChange={set('name')} placeholder="Auto-named if empty" /></Field>
            <Field label="Trading pair">{fx
              ? <select className="select" value={f.symbol} onChange={set('symbol')}>{['USDINR', 'EURINR', 'GBPINR', 'JPYINR'].map((p) => <option key={p} value={p}>{p}</option>)}</select>
              : futures
                ? <><input className="input mono" list="nfut-symbols" value={f.symbol} onChange={set('symbol')} placeholder="NIFTY" /><datalist id="nfut-symbols">{INDEX_FUTURES.map((s) => <option key={s} value={s} />)}</datalist></>
                : crypto && coinList?.length
                  ? (() => {
                    // Every coin of the exchange in a dropdown; the search box above it narrows the list.
                    const q = coinQuery.trim().toUpperCase();
                    const shown = coinList.filter((c) => !q || c.includes(q));
                    const opts = shown.includes(f.symbol) || !coinList.includes(f.symbol) ? shown : [f.symbol, ...shown];
                    return (
                      <div className="col" style={{ gap: 6 }}>
                        <input className="input" value={coinQuery} onChange={(e) => {
                          const v = e.target.value;
                          setCoinQuery(v);
                          // Typing a coin selects it: exact name first (ICP -> ICPUSDT), else the first coin that starts with it, else the first match.
                          const t = v.trim().toUpperCase();
                          const pick = t && (coinList.find((c) => c === t || c === `${t}USDT`) || coinList.find((c) => c.startsWith(t)) || coinList.find((c) => c.includes(t)));
                          if (pick) setF((s) => ({ ...s, symbol: pick }));
                        }} placeholder={`🔍 Search ${coinList.length} coins (e.g. ICP, PEPE)`} />
                        <select className="select mono" value={f.symbol} onChange={set('symbol')}>
                          {!coinList.includes(f.symbol) && <option value={f.symbol}>{f.symbol}</option>}
                          {opts.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <span className="tiny muted">{q ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : `All ${coinList.length} coins`} · selected: <b>{f.symbol}</b></span>
                      </div>
                    );
                  })()
                  : <input className="input mono" value={f.symbol} onChange={set('symbol')} placeholder={stocks ? 'RELIANCE' : 'BTCUSDT'} />}</Field>
          </div>
          {!f.autoMode && (
            <Field label="AI strategy" hint={strat ? `${strat.description}${strat.timeframes?.length ? ` Best on ${strat.timeframes.join(', ')}.` : ''}` : ''}>
              <select className="select" value={f.strategy} onChange={set('strategy')}>
                {(lib?.strategies || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          <Field label={`Exchange · ${perps || futures ? 'FUTURES' : fx ? 'FOREX' : stocks ? 'STOCKS' : 'SPOT'}`} hint={exInfo && !exInfo.trading ? `${exInfo.name}: paper trading only (live trading not supported yet)` : 'Live trading uses the API keys you connected for this exchange'}>
            <select className="select" value={f.exchange} onChange={set('exchange')}>
              {(status?.exchanges || []).map((e) => <option key={e.id} value={e.id}>{e.name}{e.trading ? '' : ' (paper only)'}</option>)}
            </select>
          </Field>
          {f.autoMode ? <AutoSettings f={f} set={set} initial={initial} quote={exInfo?.currency || 'USDT'} /> : (<>
          <div className="grid g-2" style={{ gap: 12 }}>
            <Field label="Timeframe"><Seg value={f.interval} onChange={set('interval')} options={['1m', '5m', '15m', '1h', '4h'].filter((i) => !exInfo || exInfo.intervals.includes(i))} /></Field>
            <Field label="Mode"><Seg className="mode" value={f.mode} onChange={set('mode')} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></Field>
          </div>
          {perps && (
            <Field label="Leverage (isolated margin)" hint={`Margin = notional / leverage. The Risk Engine refuses entries whose stop is more than half the distance to liquidation, and caps total leverage (Risk page). Max ${exInfo.maxLeverage}x.`}>
              <Seg value={f.leverage || exInfo.defaultLeverage || 2} onChange={set('leverage')} options={Array.from({ length: exInfo.maxLeverage || 5 }, (_, k) => ({ value: k + 1, label: `${k + 1}x` }))} />
            </Field>
          )}
          {f.strategy === 'grid' && <div className="alert info small">AI Grid builds a ladder of up to 10 levels inside the detected range (each step at least 0.8% so fees are covered), only while the regime is Sideways or Low Volatility, and sells everything if price breaks below the range. Max position % caps the capital the grid uses.</div>}
          {f.strategy === 'dca' ? (
            <div className="grid g-2" style={{ gap: 12 }}>
              <Field label="Buy every N candles"><input className="input mono" type="number" value={f.dcaEvery} onChange={set('dcaEvery')} /></Field>
              <Field label="Tranche size (% of equity)"><input className="input mono" type="number" value={f.dcaTranchePct} onChange={set('dcaTranchePct')} /></Field>
              <Field label="Max tranches"><input className="input mono" type="number" value={f.dcaMaxTranches} onChange={set('dcaMaxTranches')} /></Field>
              <Field label="Take profit on avg cost (%)"><input className="input mono" type="number" value={f.dcaTakeProfitPct} onChange={set('dcaTakeProfitPct')} /></Field>
            </div>
          ) : (
            <>
              <div className="row between card" style={{ padding: 12 }}>
                <div>
                  <div className="row bold small" style={{ gap: 6 }}><Sparkles size={14} color="#b3a1ff" /> Claude AI review + trade journal coaching</div>
                  <div className="tiny muted">Claude reviews strong signals and can veto entries; it also writes post-trade reviews. Uses API credits.</div>
                </div>
                <Switch checked={f.useClaude} onChange={set('useClaude')} />
              </div>
              <div className="row between card" style={{ padding: 12, borderColor: f.forceTrade ? 'rgba(245,165,36,0.6)' : undefined }}>
                <div>
                  <div className="row bold small" style={{ gap: 6 }}>⚡ Trade every candle</div>
                  <div className="tiny muted">Every {f.interval} candle the bot automatically sells the open trade and buys a new one (direction from the AI score), without waiting for an approved signal. Safety limits (kill switch, daily loss limit, exposure) still apply.</div>
                  {f.forceTrade && <div className="tiny" style={{ marginTop: 4, color: 'var(--warn)' }}>Many trades = many fees. On 1m this usually loses money to fees and spread. Test on Paper first{f.mode === 'live' ? ' - this bot is LIVE and will trade real money every candle' : ''}.</div>}
                </div>
                <Switch checked={Boolean(f.forceTrade)} onChange={set('forceTrade')} />
              </div>
              <div className="row between card" style={{ padding: 12 }}>
                <div>
                  <div className="row bold small" style={{ gap: 6 }}>Stop after one trade</div>
                  <div className="tiny muted">When the bot's trade closes (take-profit, stop-loss, trade duration, candle close or manual close), the bot stops itself and does not open the next trade. Start it again for another trade.</div>
                </div>
                <Switch checked={Boolean(f.stopAfterTrade)} onChange={set('stopAfterTrade')} />
              </div>
              <div className="row between card" style={{ padding: 12, borderColor: f.onlyProfitExit ? 'rgba(245,165,36,0.6)' : undefined }}>
                <div>
                  <div className="row bold small" style={{ gap: 6 }}>Close only in profit</div>
                  <div className="tiny muted">The bot closes a trade automatically only when it is in profit (take-profit, or a trailing stop that has moved into profit). In a loss it keeps holding: no stop-loss, candle-close or AI exit. The max loss amount and the trade duration still close the trade. Manual close still works.</div>
                  {f.onlyProfitExit && <div className="tiny" style={{ marginTop: 4, color: 'var(--warn)' }}>No stop-loss: if the price keeps falling, the loss keeps growing and the money stays stuck in the trade.{f.exchange === 'bperp' ? ' With leverage the position can still be liquidated.' : ''}</div>}
                </div>
                <Switch checked={Boolean(f.onlyProfitExit)} onChange={set('onlyProfitExit')} />
              </div>
              {exInfo?.canShort && (
                <div className="row between card" style={{ padding: 12 }}>
                  <div>
                    <div className="row bold small" style={{ gap: 6 }}>Allow shorts (sell first)</div>
                    <div className="tiny muted">The bot may also sell first when the AI is bearish and history shows a positive edge for shorts. Off = long only. Not available for DCA and Grid.</div>
                  </div>
                  <Switch checked={Boolean(f.allowShort) || Boolean(f.alternate)} onChange={set('allowShort')} />
                </div>
              )}
              {exInfo?.canShort && f.strategy !== 'grid' && (
                <div className="row between card" style={{ padding: 12, borderColor: f.alternate ? 'rgba(47,140,255,0.6)' : undefined }}>
                  <div>
                    <div className="row bold small" style={{ gap: 6 }}>⇄ Alternate BUY / SELL</div>
                    <div className="tiny muted">Strict sequence BUY → SELL → BUY → SELL. The next trade's direction comes only from the previous trade, never from the market trend; the AI analysis still picks the moment to enter (it waits for a setup in the required direction). TP, SL, trade duration and manual closes keep the sequence; switching this on starts it at BUY.{f.forceTrade ? ' With Trade every candle: a new trade every candle, always the opposite direction.' : ''}</div>
                  </div>
                  <Switch checked={Boolean(f.alternate)} onChange={set('alternate')} />
                </div>
              )}
              <div className="divider" />
              <div className="row small bold" style={{ gap: 6 }}><ShieldCheck size={15} className="up" /> Bot risk settings <span className="dim tiny">(the central Risk Engine adjusts these dynamically)</span></div>
              <div className="grid g-3" style={{ gap: 12 }}>
                <Field label="Signal threshold" hint="Meta score to enter"><input className="input mono" type="number" value={f.threshold} onChange={set('threshold')} /></Field>
                <Field label="Base risk %" hint="Before risk-engine scaling"><input className="input mono" type="number" step="0.1" value={f.riskPct} onChange={set('riskPct')} /></Field>
                <Field label="Max position %" hint="Cap per position"><input className="input mono" type="number" value={f.maxPositionPct} onChange={set('maxPositionPct')} /></Field>
                <Field label="Daily loss limit %" hint="Stops new entries"><input className="input mono" type="number" value={f.dailyLossLimitPct} onChange={set('dailyLossLimitPct')} /></Field>
                <Field label="Trailing ATR ×" hint="Trailing stop distance"><input className="input mono" type="number" step="0.1" value={f.trailAtr} onChange={set('trailAtr')} /></Field>
                <Field label="Trailing stop"><div style={{ paddingTop: 6 }}><Switch checked={f.trailingStop} onChange={set('trailingStop')} /></div></Field>
                <Field label="Trade amount" hint="Fixed size per trade, e.g. 100 · 0 = auto"><input className="input mono" type="number" min="0" step="1" value={f.tradeAmount ?? 0} onChange={set('tradeAmount')} /></Field>
                <Field label="Profit target (amount)" hint="Close at +N profit, e.g. 10 · 0 = off"><input className="input mono" type="number" min="0" step="0.1" value={f.takeProfitUsd ?? 0} onChange={set('takeProfitUsd')} /></Field>
                <Field label="Max loss (amount)" hint="Close at -N loss, e.g. 5 · 0 = off"><input className="input mono" type="number" min="0" step="0.1" value={f.stopLossUsd ?? 0} onChange={set('stopLossUsd')} /></Field>
                <Field label="Take profit %" hint="Sell at +N% profit · 0 = AI target"><input className="input mono" type="number" min="0" step="0.1" value={f.takeProfitPct ?? 0} onChange={set('takeProfitPct')} /></Field>
                <Field label="Small profit exit %" hint="Close as soon as the trade is +N% in profit after fees, even before the target · 0 = off"><input className="input mono" type="number" min="0" step="0.1" value={f.smallProfitPct ?? 0} onChange={set('smallProfitPct')} /></Field>
                <Field label="Trade duration (min)" hint={Number(f.maxHoldMin) > 0 ? `Max holding time ${fmtDuration(Number(f.maxHoldMin))}: closed at expiry, profit or loss, unless TP / SL closed it first` : 'Max holding time · 0 = off (no time limit)'}>
                  <input className="input mono" type="number" min="0" max="43200" step="1" value={f.maxHoldMin ?? 0} onChange={set('maxHoldMin')} />
                  <Seg value={Number(f.maxHoldMin) || 0} onChange={(v) => set('maxHoldMin')(v)} options={[{ value: 0, label: 'Off' }, { value: 15, label: '15m' }, { value: 60, label: '1h' }, { value: 240, label: '4h' }, { value: 1440, label: '1d' }]} />
                </Field>
              </div>
            </>
          )}
          </>)}
          {!initial?._id && (
            <div className="row between card" style={{ padding: 12 }}>
              <div>
                <div className="row bold small" style={{ gap: 6 }}><Play size={14} /> Start automatically</div>
                <div className="tiny muted">The bot starts as soon as it is created, then buys and sells on its own (paper or live): it enters when a signal passes the Risk Engine and exits on stop-loss, take-profit or an AI exit signal.</div>
              </div>
              <Switch checked={f.autoStart !== false} onChange={set('autoStart')} />
            </div>
          )}
          {f.mode === 'live' && <div className="alert warn">Live bots place real market orders on Binance{status?.binance?.testnet ? ' Testnet' : ''}. Backtest (out-of-sample) and paper-trade the strategy first.</div>}
          <button className="btn primary block" onClick={save} disabled={busy}>{busy ? <Spinner /> : <Bot size={15} />} {initial?._id ? 'Save changes' : 'Create bot'}</button>
        </div>
      </div>
    </div>
  );
}

function BotCard({ bot, price, live, onChange, onSelect, selected }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const act = async (path, method = 'post') => {
    setBusy(true);
    try {
      await api[method](`/bots/${bot._id}${path}`);
      onChange();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };
  const running = bot.status === 'running';
  const paused = bot.status === 'paused';
  const pos = bot.position;
  const short = pos?.side === 'short';
  // If closed now, after the exit fee: the same number take-profit / stop-loss trigger on.
  const { pnl: upnl, pct: upct } = openNetPnl(pos, price, live);
  const winRate = bot.stats?.trades ? (bot.stats.wins / bot.stats.trades) * 100 : 0;
  const ls = bot.lastSignal;

  return (
    <div className={`card bot-card ${running ? 'running' : ''}`} style={selected ? { borderColor: 'var(--accent)' } : paused ? { borderColor: 'rgba(245,165,36,0.5)' } : undefined}>
      <div className="row between">
        <div className="coin" style={{ cursor: 'pointer' }} onClick={onSelect}>
          <CoinIcon symbol={bot.symbol} size={34} />
          <div>
            <div className="bold">{bot.name}</div>
            <div className="tiny muted">{bot.exchange || 'binance'} · {baseOf(bot.symbol)}/{quoteOf(bot.symbol)} · {bot.interval} · {bot.strategy.replace('_', ' ')}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {bot.autoMode && <span className="badge accent" title="Auto mode: the bot sets its own settings and adapts to the market">🤖 Auto · {RISK_LEVELS.find((r) => r.id === bot.riskProfile)?.label || 'Balanced'}</span>}
          {bot.copyable && <span className="badge accent" title="Shared on the copy-trading leaderboard">Shared</span>}
          {bot.useClaude && <span className="badge ai"><Sparkles size={11} /> Claude</span>}
          {bot.allowShort && <span className="badge short">Shorts on</span>}
          {bot.onlyProfitExit && <span className="badge" style={{ color: 'var(--warn)' }} title="Closes automatically only in profit - no stop-loss">💰 Profit-only exit</span>}
          {bot.stopAfterTrade && <span className="badge" title="Stops after its trade closes">⏹ One trade</span>}
          {bot.alternate && <span className="badge" title="Alternating BUY / SELL">⇄ Next: {pos ? (short ? 'BUY' : 'SELL') : bot.lastSide === 'long' ? 'SELL' : 'BUY'}</span>}
          {bot.forceTrade && <span className="badge" style={{ color: 'var(--warn)' }} title="Buys and sells every candle">⚡ Every {bot.interval}</span>}
          <span className={`badge ${bot.mode === 'live' ? 'down' : 'accent'}`}>{bot.mode.toUpperCase()}</span>
          <span className="row tiny" style={{ gap: 6 }}><span className={`dot ${running ? 'live' : paused ? 'bad' : 'off'}`} />{running ? 'Running' : paused ? 'Paused' : 'Stopped'}</span>
        </div>
      </div>
      {paused && <div className="alert warn small"><PauseCircle size={14} /> {bot.pausedReason}</div>}
      {bot.autoMode && running && bot.autoStatus?.note && (
        <div className={`alert small ${bot.autoStatus.blocked ? 'warn' : 'info'}`}>🤖 {bot.autoStatus.note}{bot.autoStatus.sizeMult > 0 && bot.autoStatus.sizeMult < 1 ? ` (size x${bot.autoStatus.sizeMult})` : ''} <span className="dim tiny">{ago(bot.autoStatus.time)}</span></div>
      )}

      <div className="bot-metrics">
        <div><small>Total PnL</small><b className={tone(bot.stats?.pnl)}>{fmtMoney(bot.stats?.pnl || 0, quoteOf(bot.symbol))}</b></div>
        <div><small>Trades</small><b>{bot.stats?.trades || 0}</b></div>
        <div><small>Win rate</small><b>{winRate.toFixed(0)}%</b></div>
        <div><small>Last signal</small><b>{ls ? <SignalBadge signal={ls.signal || (ls.action === 'BUY' ? 'LONG' : ls.action === 'SELL' ? 'EXIT' : 'WAIT')} /> : '—'}</b></div>
      </div>

      {ls?.probability !== undefined && (
        <div className="row wrap small" style={{ gap: 8 }}>
          {ls.regime && <RegimeChip regime={ls.regime} />}
          <span className="muted">{ls.strategy}</span>
          <span className="mono">p={(ls.probability * 100).toFixed(0)}%</span>
          <GradeBadge grade={ls.quality} />
          <DecisionBadge decision={ls.decision} />
          <span className="dim tiny">{ago(ls.time)}</span>
        </div>
      )}

      {pos ? (
        <div className="position-box">
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="bold">{short ? <span className="badge short" style={{ marginRight: 6 }}>SHORT</span> : null}Open position{pos.tranches ? ` · ${pos.tranches} DCA tranches` : ''}{pos.gridLots ? ` · ${pos.gridLots} grid lots` : ''}</span>
            <span className={`mono bold ${tone(upnl)}`} title="If closed now, after fees - take-profit / stop-loss trigger on this number">{upnl == null ? '…' : <>{fmtMoney(upnl, quoteOf(bot.symbol))} ({fmtPct(upct)}) <span className="tiny muted">after fees</span></>}</span>
          </div>
          <div className="kv">
            <span>Size</span><span>{fmtQty(pos.qty)} {baseOf(bot.symbol)}</span>
            <span>Avg entry</span><span>{fmtPrice(pos.entry)}</span>
            {bot.stopLossUsd > 0 && <><span>Max loss</span><span className="down">-{bot.stopLossUsd} (closes here)</span></>}
            {bot.onlyProfitExit && !(bot.stopLossUsd > 0) && <><span>Stop-loss</span><span className="muted">Off at a loss (close only in profit)</span></>}
            {pos.stopLoss > 0 && <><span>Stop-loss {bot.trailingStop && '(trailing)'}</span><span className="down">{fmtPrice(pos.stopLoss)}</span></>}
            <span>Take-profit {bot.takeProfitUsd > 0 ? `(+${bot.takeProfitUsd})` : bot.takeProfitPct > 0 ? `(+${bot.takeProfitPct}%)` : '(AI target)'}</span><span className="up">{fmtPrice(pos.takeProfit)}</span>
            {bot.smallProfitPct > 0 && <><span>Small profit exit</span><span className="up">closes at +{bot.smallProfitPct}% after fees</span></>}
            {bot.maxHoldMin > 0 && pos.openedAt && <><span>Trade duration ({fmtDuration(bot.maxHoldMin)})</span><span>{durationLeft(pos.openedAt, bot.maxHoldMin)} left</span></>}
            {pos.riskPct && <><span>Risk engine size</span><span>{pos.riskPct}% risk</span></>}
          </div>
        </div>
      ) : (
        <div className="position-box muted small">{bot.grid ? `Grid active: ${bot.grid.levels.length} levels ${fmtPrice(bot.grid.lower)} – ${fmtPrice(bot.grid.upper)}, waiting for price to reach a level.` : running ? (bot.strategy === 'grid' ? 'Waiting for a sideways / low-volatility regime to build the grid.' : <>{bot.forceTrade ? <>⚡ Trade-every-candle: the bot buys at the next {bot.interval} candle close and sells at the one after.</> : <>AUTO mode: the bot will buy / sell by itself when a signal is approved (threshold {bot.threshold}). Checks once per {bot.interval} candle.</>}{ls ? <div style={{ marginTop: 4 }}>Last check: <b>{ls.signal || 'WAIT'}</b>{ls.rejectedBy?.length ? <> · not traded because: <span className="down">{ls.rejectedBy.join(', ')}</span></> : ls.signal === 'WAIT' ? ' · no setup yet' : ''}</div> : <div style={{ marginTop: 4 }}>Waiting for the first {bot.interval} candle to close…</div>}</>) : paused ? 'Paused by the safety system.' : 'Bot is stopped.'}</div>
      )}
      {ls?.claude && <div className="ai-reason small"><b className="row" style={{ gap: 6, marginBottom: 4 }}><Sparkles size={13} color="#b3a1ff" /> Claude</b>{ls.claude}</div>}

      <div className="row wrap" style={{ gap: 8 }}>
        {running
          ? <button className="btn sm" disabled={busy} onClick={() => act('/stop')}><Square size={13} /> Stop</button>
          : <button className="btn sm primary" disabled={busy} onClick={() => act('/start')}><Play size={13} /> {paused ? 'Resume' : 'Start'}</button>}
        {pos && <button className="btn sm sell" disabled={busy} onClick={() => act('/close')}>Close position</button>}
        <button className="btn sm ghost" onClick={onSelect}><ScrollText size={13} /> Logs</button>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost" disabled={running} onClick={() => onChange('edit')}><Settings2 size={13} /></button>
        <button className="btn sm ghost danger" disabled={busy || running || !!pos} onClick={() => confirm(`Delete ${bot.name}?`) && act('', 'del')}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

// Realized (closed trades) + unrealized (open position at the live price) P&L, split by paper / live.
function PnlSummary({ bots, priceOf }) {
  const rows = ['paper', 'live'].map((m) => {
    const list = bots.filter((b) => (b.mode || 'paper') === m);
    const byCcy = {};
    for (const b of list) {
      const ccy = quoteOf(b.symbol);
      const t = (byCcy[ccy] ||= { realized: 0, open: 0, trades: 0, wins: 0, openCount: 0 });
      t.realized += b.stats?.pnl || 0;
      t.trades += b.stats?.trades || 0;
      t.wins += b.stats?.wins || 0;
      const pos = b.position;
      const px = priceOf(b.symbol);
      if (pos?.qty > 0 && px) {
        t.open += pos.side === 'short' ? pos.cost - px * pos.qty : px * pos.qty - pos.cost;
        t.openCount++;
      }
    }
    return { m, count: list.length, byCcy };
  }).filter((r) => r.count);
  if (!rows.length) return null;
  return (
    <div className="pnl-summary">
      {rows.map(({ m, byCcy }) => Object.entries(byCcy).map(([ccy, t]) => (
        <div key={m + ccy} className="pnl-row">
          <span className={`badge ${m === 'live' ? 'short' : ''}`}>{m.toUpperCase()}</span>
          <span>Realized <b className={tone(t.realized)}>{fmtMoney(t.realized, ccy)}</b> <span className="dim">({t.trades} trades, {t.wins} wins)</span></span>
          <span>Open <b className={tone(t.open)}>{fmtMoney(t.open, ccy)}</b> <span className="dim">({t.openCount} open)</span></span>
          <span>Total <b className={tone(t.realized + t.open)}>{fmtMoney(t.realized + t.open, ccy)}</b></span>
        </div>
      )))}
    </div>
  );
}

export default function Bots() {
  const { mode, exchange, money } = useApp();
  const fmtUsd = money; // account strip follows the top-bar exchange (INR for forex)
  const [bots, , reload] = usePoll('/bots', 10000);
  const [risk, , reloadRisk] = usePoll(`/risk/overview?mode=${mode}&exchange=${exchange}`, 20000, [mode, exchange]);
  const [form, setForm] = useState(() => (new URLSearchParams(window.location.search).get('new') ? {} : null)); // /bots?new=1 opens the form
  const [selected, setSelected] = useState(null);
  const [logs, , reloadLogs] = usePoll(`/logs?limit=150${selected ? `&botId=${selected}` : ''}`, 0, [selected]);
  const [prices, setPrices] = useState({});
  const [lives, setLives] = useState({}); // botId -> net P&L from the server position guard

  const symbols = [...new Set((bots || []).map((b) => b.symbol))].join(',');
  const binanceSymbols = [...new Set((bots || []).filter((b) => (b.exchange || 'binance') === 'binance').map((b) => b.symbol))].join(',');
  const [tick] = usePoll(binanceSymbols ? `/market/tickers?symbols=${binanceSymbols}` : null, 5000, [binanceSymbols]);
  const priceOf = (s) => prices[s] ?? tick?.find((t) => t.symbol === s)?.price;

  useServerEvents((type, p) => {
    if (type === 'log') reloadLogs();
    if (type === 'trade' || type === 'signal' || type === 'bot' || type === 'killswitch') { reload(); reloadRisk(); }
    if (type === 'position') {
      const b = bots?.find((x) => x._id === p.botId);
      if (b) setPrices((s) => ({ ...s, [b.symbol]: p.price }));
      if (p.live) setLives((s) => ({ ...s, [p.botId]: p.live }));
    }
  });

  const running = (bots || []).filter((b) => b.status === 'running').length;
  const acct = risk?.account;

  return (
    <>
      <div className="card">
        <div className="row wrap between" style={{ gap: 12 }}>
          <div>
            <div className="bold" style={{ fontSize: 16 }}>Bot Manager</div>
            <div className="small muted">Every bot runs Signal Engine 2.0 and must pass the central Risk Engine before it can trade. Positions are protected every 15 seconds.</div>
          </div>
          <button className="btn primary" onClick={() => setForm({})}><Plus size={15} /> New Bot</button>
        </div>
        {acct && (
          <div className="row wrap" style={{ gap: 24, marginTop: 14 }}>
            <div><div className="tiny dim">BOTS RUNNING</div><div className="mono bold">{running} / {bots?.length || 0}</div></div>
            <div><div className="tiny dim">EQUITY ({mode})</div><div className="mono bold">{fmtUsd(acct.equity)}</div></div>
            <div><div className="tiny dim">DRAWDOWN</div><div className={`mono bold ${acct.drawdownPct > 5 ? 'down' : ''}`}>{acct.drawdownPct.toFixed(2)}%</div></div>
            <div><div className="tiny dim">EXPOSURE</div><div className="mono bold">{acct.exposurePct.toFixed(1)}% <span className="dim">/ {risk.settings.risk.maxExposurePct}%</span></div></div>
            <div><div className="tiny dim">TODAY REALIZED</div><div className={`mono bold ${tone(acct.realizedToday)}`}>{fmtUsd(acct.realizedToday)}</div></div>
            <Link to="/risk" className="btn sm ghost" style={{ alignSelf: 'center' }}><ShieldCheck size={13} /> Risk Manager</Link>
          </div>
        )}
      </div>

      <div className="grid g-wide">
        <div className="grid g-2" style={{ alignContent: 'start' }}>
          {(bots || []).map((b) => (
            <BotCard key={b._id} bot={b} price={priceOf(b.symbol)} live={lives[b._id]} selected={selected === b._id}
              onSelect={() => setSelected(selected === b._id ? null : b._id)}
              onChange={(x) => (x === 'edit' ? setForm(b) : (reload(), reloadRisk()))} />
          ))}
          {bots && !bots.length && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <Empty icon={Bot} title="No bots yet">
                <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setForm({})}><Plus size={15} /> Create your first AI bot</button>
              </Empty>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <span className="card-title"><ScrollText size={14} /> {selected ? `${bots?.find((b) => b._id === selected)?.name || ''} Logs` : 'All Bot Logs'}</span>
            {selected && <button className="btn sm ghost" onClick={() => setSelected(null)}>Show all</button>}
          </div>
          {bots && <PnlSummary bots={selected ? bots.filter((b) => b._id === selected) : bots} priceOf={priceOf} />}
          {logs?.length ? (
            <div className="log-feed" style={{ maxHeight: 640 }}>
              {logs.map((l) => (
                <div key={l._id} className="log-line">
                  <span className="dim">{new Date(l.time).toLocaleTimeString()}</span>
                  <span className={`lvl ${l.level}`}>{l.level}</span>
                  <span className={l.level === 'pnl' ? tone(l.data?.unrealized) : l.level === 'profit' ? 'up' : l.level === 'loss' ? 'down' : undefined}>{l.msg}</span>
                </div>
              ))}
            </div>
          ) : <Empty icon={ScrollText} title="No activity yet" />}
        </div>
      </div>
      {form && <BotForm initial={form} onClose={() => setForm(null)} onSaved={reload} />}
    </>
  );
}
