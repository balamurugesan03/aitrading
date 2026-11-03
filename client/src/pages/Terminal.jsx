import { useEffect, useMemo, useState } from 'react';
import { Search, Brain, Sparkles, BookOpen, ShoppingCart, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/AppContext.jsx';
import { usePoll, useBinanceStream } from '../lib/hooks.js';
import CandleChart, { OscillatorChart } from '../components/CandleChart.jsx';
import SignalPanel from '../components/SignalPanel.jsx';
import { OrderFlowPanel, FuturesPanel, NewsPanel } from '../components/IntelPanels.jsx';
import { Tabs, REGIME_STYLE } from '../components/ui.jsx';
import { CoinIcon, Seg, Switch, Spinner, Empty, Field } from '../components/ui.jsx';
import { fmtPrice, fmtPct, fmtCompact, fmtQty, tone, baseOf, quoteOf } from '../lib/format.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const OVERLAYS = [
  ['ema9', 'EMA 9', '#e8c872'], ['ema21', 'EMA 21', '#9b7bff'], ['ema50', 'EMA 50', '#2dd4bf'],
  ['ema200', 'EMA 200', '#ff5fa2'], ['bb', 'Bollinger', '#6ea8ff'], ['levels', 'S/R Levels', '#9aa5bd'], ['regime', 'Regime strip', '#e8c872'],
];

function SymbolPicker({ symbol, onPick, exchange }) {
  const { currency } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [symbols] = usePoll(open ? `/market/symbols?quote=${currency}&exchange=${exchange}` : null, 0, [exchange, currency]);
  const list = useMemo(() => (symbols || []).filter((s) => s.includes(q.toUpperCase())).slice(0, 60), [symbols, q]);
  return (
    <div className="symbol-pick">
      <button className="btn ghost" onClick={() => setOpen(!open)} style={{ padding: '6px 10px' }}>
        <CoinIcon symbol={symbol} size={30} />
        <span style={{ fontSize: 18, fontWeight: 800 }}>{baseOf(symbol)}<span className="dim" style={{ fontWeight: 500 }}>/{quoteOf(symbol)}</span></span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="symbol-menu">
          <div className="row" style={{ padding: 4 }}>
            <Search size={14} className="dim" />
            <input autoFocus className="input" placeholder="Search pair…" value={q} onChange={(e) => setQ(e.target.value)} style={{ border: 'none', background: 'transparent', padding: 6 }} />
          </div>
          {!symbols && <div className="empty"><Spinner /></div>}
          {list.map((s) => (
            <button key={s} onClick={() => { onPick(s); setOpen(false); setQ(''); }}>
              <span className="coin"><CoinIcon symbol={s} size={20} />{baseOf(s)}</span><span className="dim small">{quoteOf(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OrderBook({ symbol, exchange }) {
  const [book] = usePoll(`/market/orderbook?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}`, 3000, [symbol, exchange]);
  if (!book) return <div className="skeleton" style={{ height: 300 }} />;
  const asks = book.asks.slice(0, 10).reverse();
  const bids = book.bids.slice(0, 10);
  const max = Math.max(...[...asks, ...bids].map(([p, q]) => p * q));
  const spread = book.asks[0][0] - book.bids[0][0];
  return (
    <div className="book">
      <div className="book-row dim tiny"><span>PRICE</span><span>SIZE</span></div>
      {asks.map(([p, q]) => (
        <div className="book-row" key={`a${p}`}><i className="bar" style={{ width: `${((p * q) / max) * 100}%`, background: 'var(--down)' }} /><span className="down">{fmtPrice(p)}</span><span>{fmtQty(q)}</span></div>
      ))}
      <div className="book-mid row between"><span>{fmtPrice((book.asks[0][0] + book.bids[0][0]) / 2)}</span><span className="tiny dim">spread {fmtPrice(spread)}</span></div>
      {bids.map(([p, q]) => (
        <div className="book-row" key={`b${p}`}><i className="bar" style={{ width: `${((p * q) / max) * 100}%`, background: 'var(--up)' }} /><span className="up">{fmtPrice(p)}</span><span>{fmtQty(q)}</span></div>
      ))}
    </div>
  );
}

function OrderPanel({ symbol, price, onDone, exchange }) {
  const { mode, toast, exInfo, money } = useApp();
  const fx = exInfo?.market === 'forex';
  const stocks = exInfo?.market === 'stocks';
  const inr = fx || stocks;
  const quote = quoteOf(symbol);
  const LOT = fx ? 1000 : 1; // NSE currency futures: 1 lot = 1,000 units; stocks: whole shares
  const [side, setSide] = useState('BUY'); // BUY | SELL | SHORT | COVER (the last two: forex futures only)
  const [amount, setAmount] = useState(inr ? '100000' : '100');
  const [busy, setBusy] = useState(false);
  const [portfolio, , reload] = usePoll(`/portfolio?mode=${mode}&exchange=${exchange}`, 0, [mode, exchange]);
  useEffect(() => { setSide('BUY'); setAmount(inr ? '100000' : '100'); }, [inr]);
  const base = baseOf(symbol);
  const heldAsset = inr ? symbol : base; // NSE accounts hold the pair / stock itself (units / shares)
  const usdt = portfolio?.assets.find((a) => a.asset === quote)?.amount || 0;
  const heldRow = portfolio?.assets.find((a) => a.asset === heldAsset);
  const held = Math.max(0, heldRow?.amount || 0);
  const shortHeld = Math.max(0, -(heldRow?.amount || 0));
  const opening = side === 'BUY' || side === 'SHORT';
  const lotsFor = (rupees) => (price ? Math.floor(rupees / (price * LOT * (fx ? 1.001 : 1.0035))) : 0);

  const submit = async () => {
    setBusy(true);
    try {
      const short = side === 'SHORT' || side === 'COVER';
      const apiSide = side === 'SHORT' ? 'SELL' : side === 'COVER' ? 'BUY' : side;
      const body = opening ? { symbol, side: apiSide, mode, exchange, short, quoteAmount: +amount } : { symbol, side: apiSide, mode, exchange, short, quantity: +amount };
      const t = await api.post('/trade', body);
      toast(`${side} ${fx ? `${t.qty / LOT} lot(s)` : stocks ? `${t.qty} share(s)` : fmtQty(t.qty)} ${inr ? symbol : base} @ ${fmtPrice(t.price)} (${mode})`);
      reload();
      onDone?.();
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <Seg value={side} onChange={(s) => { setSide(s); setAmount(s === 'BUY' || s === 'SHORT' ? (inr ? '100000' : '100') : String(s === 'COVER' ? shortHeld : held ? +held.toFixed(6) : '')); }} options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }, ...(exInfo?.canShort ? [{ value: 'SHORT', label: 'Short' }, { value: 'COVER', label: 'Cover' }] : [])]} />
      <Field label={opening ? `Amount (${quote})` : fx ? `Quantity (units, 1 lot = ${LOT})` : stocks ? 'Quantity (shares)' : `Quantity (${base})`} hint={opening ? `Available: ${money(usdt)}` : side === 'COVER' ? `Short: ${fmtQty(shortHeld)} units (${shortHeld / LOT} lots)` : `Holding: ${fmtQty(held)} ${fx ? `units (${held / LOT} lots)` : stocks ? 'shares' : base}`}>
        <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </Field>
      <div className="row" style={{ gap: 6 }}>
        {[25, 50, 75, 100].map((p) => (
          <button key={p} className="btn sm" style={{ flex: 1 }} onClick={() => setAmount(opening ? String(Math.floor(usdt * p) / 100) : String(+(((side === 'COVER' ? shortHeld : held) * p) / 100).toFixed(6)))}>{p}%</button>
        ))}
      </div>
      <div className="kv small">
        <span>Est. {opening ? 'quantity' : 'value'}</span>
        <span>{price ? (opening ? (inr ? `${lotsFor(+amount)} ${fx ? 'lot(s)' : 'share(s)'} · ${money(lotsFor(+amount) * LOT * price)}` : `${fmtQty(+amount / price)} ${base}`) : money(+amount * price)) : '—'}</span>
        <span>Mode</span><span className={mode === 'live' ? 'down' : 'up'}>{mode.toUpperCase()}</span>
      </div>
      <button className={`btn block ${side === 'BUY' || side === 'COVER' ? 'buy' : 'sell'}`} disabled={busy || !(+amount > 0)} onClick={submit}>
        {busy ? <Spinner /> : <ShoppingCart size={15} />} {side} {inr ? symbol : base} · {inr ? 'Marketable limit' : 'Market'}
      </button>
      {fx && <div className="tiny dim">NSE currency futures (near month), whole lots only, Mon-Fri 09:00-17:00 IST. The bot never uses leverage: a lot needs its full notional in the account.</div>}
      {stocks && <div className="tiny dim">NSE delivery (CNC), whole shares, Mon-Fri 09:15-15:30 IST. Selling shares you hold needs DDPI enabled on your Zerodha account.</div>}
    </div>
  );
}

export default function Terminal() {
  const { symbol, setSymbol, interval, setInterval, status, toast, mode, exchange, exInfo, market } = useApp();
  const intervals = INTERVALS.filter((i) => !exInfo || exInfo.intervals.includes(i));
  const [data, setData] = useState(null);
  const [live, setLive] = useState(null);
  const [ticker, setTicker] = useState(null);
  const [show, setShow] = useState({ ema21: true, ema50: true, ema200: true, bb: false, levels: true, regime: true });
  const [intelTab, setIntelTab] = useState('book');
  const [osc, setOsc] = useState('rsi');
  const [signal, setSignal] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [useClaude, setUseClaude] = useState(true);
  const [strategy, setStrategy] = useState('adaptive');
  const [trades, , reloadTrades] = usePoll(`/trades?limit=200`, 0);

  const load = () => api.get(`/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500&exchange=${exchange}`).then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { setData(null); setLive(null); setSignal(null); load(); /* eslint-disable-next-line */ }, [symbol, interval, exchange]);
  // Non-Binance exchanges: refresh the forming candle and ticker by polling.
  useEffect(() => {
    if (exchange === 'binance') return undefined;
    const id = setInterval(() => {
      api.get(`/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=2&exchange=${exchange}`).then((d) => d.candles?.length && setLive(d.candles.at(-1))).catch(() => {});
      api.get(`/market/tickers?symbols=${encodeURIComponent(symbol)}&exchange=${exchange}`).then(([t]) => t && setTicker(t)).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [symbol, interval, exchange]);
  useEffect(() => {
    setTicker(null);
    api.get(`/market/tickers?symbols=${encodeURIComponent(symbol)}&exchange=${exchange}`).then(([t]) => t && setTicker((cur) => cur || t)).catch(() => {});
  }, [symbol, exchange]);

  useBinanceStream(exchange === 'binance' ? [`${symbol.toLowerCase()}@kline_${interval}`, `${symbol.toLowerCase()}@ticker`] : [], (d) => {
    if (d.e === 'kline') setLive({ time: Math.floor(d.k.t / 1000), open: +d.k.o, high: +d.k.h, low: +d.k.l, close: +d.k.c, volume: +d.k.v });
    if (d.e === '24hrTicker') setTicker({ price: +d.c, change: +d.P, high: +d.h, low: +d.l, volume: +d.q });
  });

  const price = live?.close ?? ticker?.price ?? data?.candles?.at(-1)?.close;
  const markers = useMemo(() => {
    if (!data?.candles?.length) return [];
    const first = data.candles[0].time;
    const step = data.candles.length > 1 ? data.candles[1].time - first : 60;
    return (trades || []).filter((t) => t.symbol === symbol && t.time / 1000 >= first).map((t) => ({
      time: first + Math.floor((Math.floor(t.time / 1000) - first) / step) * step,
      position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
      color: t.side === 'BUY' ? '#16c784' : '#ea3943',
      shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: `${t.side}${t.botName && t.botName !== 'Manual' ? ' 🤖' : ''}`,
    }));
  }, [trades, data, symbol]);

  const runAI = async () => {
    setAnalyzing(true);
    try {
      setSignal(await api.post('/ai/analyze', { symbol, interval, strategy, mode, exchange, allowShort: Boolean(exInfo?.canShort), useClaude: useClaude && status?.claude }));
    } catch (e) {
      toast(e.message, 'err');
    }
    setAnalyzing(false);
  };

  return (
    <div className="grid g-main">
      <div className="col" style={{ gap: 18, minWidth: 0 }}>
        <div className="card" style={{ padding: 14 }}>
          <div className="row wrap between" style={{ gap: 14 }}>
            <div className="row wrap" style={{ gap: 18 }}>
              <SymbolPicker symbol={symbol} onPick={setSymbol} exchange={exchange} />
              <div>
                <div className={`price-big ${tone(ticker?.change)}`}>{fmtPrice(price)}</div>
              </div>
              <div className="row" style={{ gap: 18 }}>
                <div><div className="tiny dim">24h Change</div><div className={`mono bold ${tone(ticker?.change)}`}>{fmtPct(ticker?.change)}</div></div>
                <div><div className="tiny dim">24h High</div><div className="mono">{fmtPrice(ticker?.high)}</div></div>
                <div><div className="tiny dim">24h Low</div><div className="mono">{fmtPrice(ticker?.low)}</div></div>
                <div><div className="tiny dim">24h Volume</div><div className="mono">{market === 'crypto' ? '$' : '₹'}{fmtCompact(ticker?.volume)}</div></div>
              </div>
            </div>
            <Seg value={interval} onChange={setInterval} options={intervals} />
          </div>
        </div>

        <div className="card" style={{ padding: 12 }}>
          <div className="row wrap between" style={{ marginBottom: 8, gap: 8 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              {OVERLAYS.map(([k, label, color]) => (
                <button key={k} className="btn sm" onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))}
                  style={{ borderColor: show[k] ? color : undefined, color: show[k] ? color : 'var(--text-3)' }}>{label}</button>
              ))}
            </div>
            <button className="btn sm ghost" onClick={load}><RefreshCw size={13} /></button>
          </div>
          {data ? <CandleChart data={data} show={show} live={live} markers={markers} signalLevels={signal && signal.symbol === symbol ? { stopLoss: signal.stopLoss, takeProfit: signal.takeProfit } : null} /> : <div className="skeleton" style={{ height: 470 }} />}
        </div>

        {show.regime && data?.regimes && (
          <div className="legend" style={{ marginTop: -8 }}>
            {Object.entries(REGIME_STYLE).map(([k, v]) => <span key={k}><i style={{ background: v.color }} />{v.label}</span>)}
            <span className="dim">· strip under the candles = detected regime per candle</span>
          </div>
        )}

        <div className="card" style={{ padding: 12 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <Seg value={osc} onChange={setOsc} options={[{ value: 'rsi', label: 'RSI 14' }, { value: 'macd', label: 'MACD 12/26/9' }]} />
          </div>
          {data && <OscillatorChart data={data} kind={osc} />}
        </div>

        <div className="card">
          <Tabs value={intelTab} onChange={setIntelTab} tabs={market !== 'crypto' ? [{ value: 'book', label: 'Market Depth' }, { value: 'flow', label: 'Order Flow AI' }] : [{ value: 'book', label: 'Order Book' }, { value: 'flow', label: 'Order Flow AI' }, { value: 'futures', label: 'Futures Intelligence' }, { value: 'news', label: 'News AI' }]} />
          {intelTab === 'flow' && <OrderFlowPanel symbol={symbol} exchange={exchange} />}
          {intelTab === 'futures' && market === 'crypto' && <FuturesPanel symbol={symbol} />}
          {intelTab === 'news' && market === 'crypto' && <NewsPanel asset={baseOf(symbol)} />}
          {intelTab === 'book' && <OrderBook symbol={symbol} exchange={exchange} />}
        </div>

      </div>

      <div className="col" style={{ gap: 18 }}>
        <div className="card">
          <div className="card-head"><span className="card-title"><Brain size={14} /> AI Analysis</span></div>
          <div className="col" style={{ gap: 12 }}>
            <Field label="Strategy">
              <select className="select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                {Object.entries(status?.strategies || { ai_ensemble: 'AI Ensemble' }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <div className="row between">
              <span className="row small" style={{ gap: 8 }}><Sparkles size={14} color="#b3a1ff" /> Ask Claude AI {!status?.claude && <span className="badge warn">no key</span>}</span>
              <Switch checked={useClaude && status?.claude} onChange={setUseClaude} />
            </div>
            <button className="btn violet block" onClick={runAI} disabled={analyzing}>
              {analyzing ? <><Spinner /> Analyzing {baseOf(symbol)}…</> : <><Brain size={15} /> Run AI Analysis</>}
            </button>
          </div>
        </div>
        <div className="card">
          {signal ? <SignalPanel signal={signal} /> : (
            <Empty icon={Brain} title="No analysis yet">
              Detects the market regime, picks the matching strategy, runs 7 models + order flow, futures, news and Claude, then returns a calibrated probability, expected return, risk and a risk-engine decision.
            </Empty>
          )}
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title"><ShoppingCart size={14} /> Place Order</span></div>
          <OrderPanel symbol={symbol} price={price} onDone={reloadTrades} exchange={exchange} />
        </div>
      </div>
    </div>
  );
}
