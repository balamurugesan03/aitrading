import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus, Play, Square, Trash2, X, Sparkles, Settings2, ScrollText, ShieldCheck, PauseCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll, useServerEvents } from '../lib/hooks.js';
import { CoinIcon, SignalBadge, GradeBadge, DecisionBadge, RegimeChip, Seg, Switch, Field, Spinner, Empty } from '../components/ui.jsx';
import { fmtPrice, fmtMoney, fmtPct, fmtQty, ago, tone, baseOf, quoteOf, FX_PAIRS, INDEX_FUTURES, isCryptoSymbol } from '../lib/format.js';

const DEFAULTS = {
  // EMA Trend on 4h was the only strategy profitable on train, validation and out-of-sample data (2020-2026).
  name: '', symbol: 'BTCUSDT', interval: '4h', strategy: 'ema_trend', mode: 'paper', useClaude: false,
  threshold: 30, riskPct: 1, maxPositionPct: 25, trailingStop: true, trailAtr: 2.5, dailyLossLimitPct: 5,
  dcaEvery: 24, dcaTranchePct: 5, dcaMaxTranches: 6, dcaTakeProfitPct: 4,
};

function BotForm({ initial, onClose, onSaved }) {
  const { status, toast, exchange } = useApp();
  const [lib] = usePoll('/strategies');
  const [f, setF] = useState({ ...DEFAULTS, exchange, ...initial });
  const exInfo = (status?.exchanges || []).find((e) => e.id === f.exchange);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const strat = lib?.strategies.find((s) => s.id === f.strategy);
  const fx = exInfo?.market === 'forex';
  const stocks = exInfo?.market === 'stocks';
  const futures = exInfo?.market === 'futures';
  const perps = exInfo?.market === 'perps';
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
      const sym = f.symbol.toUpperCase();
      const body = { ...f, symbol: fx || stocks || futures || sym.endsWith('USDT') ? sym : `${sym}USDT` };
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
          <div className="grid g-2" style={{ gap: 12 }}>
            <Field label="Bot name"><input className="input" value={f.name} onChange={set('name')} placeholder="Auto-named if empty" /></Field>
            <Field label="Trading pair">{fx
              ? <select className="select" value={f.symbol} onChange={set('symbol')}>{['USDINR', 'EURINR', 'GBPINR', 'JPYINR'].map((p) => <option key={p} value={p}>{p}</option>)}</select>
              : futures
                ? <><input className="input mono" list="nfut-symbols" value={f.symbol} onChange={set('symbol')} placeholder="NIFTY" /><datalist id="nfut-symbols">{INDEX_FUTURES.map((s) => <option key={s} value={s} />)}</datalist></>
                : <input className="input mono" value={f.symbol} onChange={set('symbol')} placeholder={stocks ? 'RELIANCE' : 'BTCUSDT'} />}</Field>
          </div>
          <Field label="AI strategy" hint={strat ? `${strat.description}${strat.timeframes?.length ? ` Best on ${strat.timeframes.join(', ')}.` : ''}` : ''}>
            <select className="select" value={f.strategy} onChange={set('strategy')}>
              {(lib?.strategies || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Exchange" hint={exInfo && !exInfo.trading ? `${exInfo.name}: paper trading only (live trading not supported yet)` : 'Live trading uses the API keys you connected for this exchange'}>
            <select className="select" value={f.exchange} onChange={set('exchange')}>
              {(status?.exchanges || []).map((e) => <option key={e.id} value={e.id}>{e.name}{e.trading ? '' : ' (paper only)'}</option>)}
            </select>
          </Field>
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
              {exInfo?.canShort && (
                <div className="row between card" style={{ padding: 12 }}>
                  <div>
                    <div className="row bold small" style={{ gap: 6 }}>Allow shorts (sell first)</div>
                    <div className="tiny muted">The bot may also sell first when the AI is bearish and history shows a positive edge for shorts. Off = long only. Not available for DCA and Grid.</div>
                  </div>
                  <Switch checked={Boolean(f.allowShort)} onChange={set('allowShort')} />
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
              </div>
            </>
          )}
          {f.mode === 'live' && <div className="alert warn">Live bots place real market orders on Binance{status?.binance?.testnet ? ' Testnet' : ''}. Backtest (out-of-sample) and paper-trade the strategy first.</div>}
          <button className="btn primary block" onClick={save} disabled={busy}>{busy ? <Spinner /> : <Bot size={15} />} {initial?._id ? 'Save changes' : 'Create bot'}</button>
        </div>
      </div>
    </div>
  );
}

function BotCard({ bot, price, onChange, onSelect, selected }) {
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
  // Long: market value - cost. Short: sale proceeds - cost to buy back.
  const upnl = pos && price ? (short ? pos.cost - price * pos.qty : price * pos.qty - pos.cost) : null;
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
          {bot.copyable && <span className="badge accent" title="Shared on the copy-trading leaderboard">Shared</span>}
          {bot.useClaude && <span className="badge ai"><Sparkles size={11} /> Claude</span>}
          {bot.allowShort && <span className="badge short">Shorts on</span>}
          <span className={`badge ${bot.mode === 'live' ? 'down' : 'accent'}`}>{bot.mode.toUpperCase()}</span>
          <span className="row tiny" style={{ gap: 6 }}><span className={`dot ${running ? 'live' : paused ? 'bad' : 'off'}`} />{running ? 'Running' : paused ? 'Paused' : 'Stopped'}</span>
        </div>
      </div>
      {paused && <div className="alert warn small"><PauseCircle size={14} /> {bot.pausedReason}</div>}

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
            <span className={`mono bold ${tone(upnl)}`}>{fmtMoney(upnl, quoteOf(bot.symbol))} ({fmtPct((((price - pos.entry) / pos.entry) * 100) * (short ? -1 : 1))})</span>
          </div>
          <div className="kv">
            <span>Size</span><span>{fmtQty(pos.qty)} {baseOf(bot.symbol)}</span>
            <span>Avg entry</span><span>{fmtPrice(pos.entry)}</span>
            {pos.stopLoss > 0 && <><span>Stop-loss {bot.trailingStop && '(trailing)'}</span><span className="down">{fmtPrice(pos.stopLoss)}</span></>}
            <span>Take-profit</span><span className="up">{fmtPrice(pos.takeProfit)}</span>
            {pos.riskPct && <><span>Risk engine size</span><span>{pos.riskPct}% risk</span></>}
          </div>
        </div>
      ) : (
        <div className="position-box muted small">{bot.grid ? `Grid active: ${bot.grid.levels.length} levels ${fmtPrice(bot.grid.lower)} – ${fmtPrice(bot.grid.upper)}, waiting for price to reach a level.` : running ? (bot.strategy === 'grid' ? 'Waiting for a sideways / low-volatility regime to build the grid.' : `Flat — waiting for an approved LONG signal (threshold ${bot.threshold}).`) : paused ? 'Paused by the safety system.' : 'Bot is stopped.'}</div>
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

export default function Bots() {
  const { mode, exchange, money } = useApp();
  const fmtUsd = money; // account strip follows the top-bar exchange (INR for forex)
  const [bots, , reload] = usePoll('/bots', 10000);
  const [risk, , reloadRisk] = usePoll(`/risk/overview?mode=${mode}&exchange=${exchange}`, 20000, [mode, exchange]);
  const [form, setForm] = useState(null);
  const [selected, setSelected] = useState(null);
  const [logs, , reloadLogs] = usePoll(`/logs?limit=150${selected ? `&botId=${selected}` : ''}`, 0, [selected]);
  const [prices, setPrices] = useState({});

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
            <BotCard key={b._id} bot={b} price={priceOf(b.symbol)} selected={selected === b._id}
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
          {logs?.length ? (
            <div className="log-feed" style={{ maxHeight: 640 }}>
              {logs.map((l) => (
                <div key={l._id} className="log-line">
                  <span className="dim">{new Date(l.time).toLocaleTimeString()}</span>
                  <span className={`lvl ${l.level}`}>{l.level}</span>
                  <span>{l.msg}</span>
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
