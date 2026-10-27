// NSE index options (NIFTY, BANKNIFTY) through Zerodha Kite Connect (same Kite login as forex and stocks).
// Market data: option chain with live quotes, implied volatility and greeks, plus index candles for the AI.
// Orders: each leg is a marketable LIMIT order (NRML). Multi-leg strategies are placed by the options service,
// bought legs first so a sold leg is never naked.
import { kite, marketCreds, kiteError, roundTick, loadCandles, parseCsv, sleep, IST_OFFSET_MS } from './zerodha.js';
import { marketOpen } from './nse.js';
import { yearsTo, impliedVol, blackScholes } from '../options/pricing.js';

// Kite instrument tokens of the underlying indices (stable for years; quote keys use the index names).
export const UNDERLYINGS = {
  NIFTY: { name: 'NIFTY', quoteKey: 'NSE:NIFTY 50', token: '256265', label: 'NIFTY 50' },
  BANKNIFTY: { name: 'BANKNIFTY', quoteKey: 'NSE:NIFTY BANK', token: '260105', label: 'NIFTY BANK' },
};
const SESSION_HOURS = 6.25;

// Zerodha F&O option charges per executed order: Rs 20 brokerage, exchange 0.03503% of premium, SEBI fee,
// GST 18% on brokerage + exchange, STT 0.1% of premium on sells, stamp 0.003% on buys.
export function optionFee(premium, side = 'BUY') {
  const exchange = premium * 0.0003503 + premium * 0.000001;
  const fee = 20 + exchange + 0.18 * (20 + exchange) + (side === 'SELL' ? premium * 0.001 : premium * 0.00003);
  return +fee.toFixed(2);
}

// ---- Instruments: index options per underlying, refreshed every 6 hours ----
let cache = null;
async function instruments(creds) {
  if (cache && Date.now() - cache.at < 6 * 3600e3) return cache.byUnderlying;
  const rows = parseCsv(await kite('GET', '/instruments/NFO', { creds, family: 'instruments', gap: 1000 }));
  const byUnderlying = {};
  for (const r of rows) {
    if (r.segment !== 'NFO-OPT' || !UNDERLYINGS[r.name] || !['CE', 'PE'].includes(r.instrument_type)) continue;
    (byUnderlying[r.name] ||= []).push({
      tradingsymbol: r.tradingsymbol, token: r.instrument_token, type: r.instrument_type, strike: Number(r.strike),
      expiryDate: r.expiry, expiry: Date.parse(`${r.expiry}T15:30:00+05:30`), lotSize: Number(r.lot_size) || 1, tickSize: Number(r.tick_size) || 0.05,
    });
  }
  cache = { at: Date.now(), byUnderlying };
  return byUnderlying;
}
const underlyingOf = (u) => {
  const x = UNDERLYINGS[String(u || '').toUpperCase()];
  if (!x) throw kiteError(`Options are available on ${Object.keys(UNDERLYINGS).join(' and ')}`, 'KITE');
  return x;
};

export async function expiries(u, creds) {
  const list = (await instruments(creds))[underlyingOf(u).name] || [];
  return [...new Set(list.filter((o) => o.expiry > Date.now()).map((o) => o.expiryDate))].sort();
}

export async function contract(tradingsymbol, creds) {
  for (const list of Object.values(await instruments(creds))) {
    const c = list.find((o) => o.tradingsymbol === tradingsymbol);
    if (c) return c;
  }
  throw kiteError(`Unknown option ${tradingsymbol}`, 'KITE');
}

export async function spot(u, creds) {
  const x = underlyingOf(u);
  const params = new URLSearchParams();
  params.append('i', x.quoteKey);
  const data = await kite('GET', '/quote', { creds, params, family: 'quote', gap: 1000 });
  const q = data[x.quoteKey];
  if (!q) throw kiteError(`No quote for ${x.label}`, 'KITE');
  return { price: q.last_price, change: q.ohlc?.close ? ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100 : 0, high: q.ohlc?.high, low: q.ohlc?.low };
}

// Live quotes for option contracts: last price, best bid/ask (and their sizes), OI, volume.
export async function optionQuotes(symbols, creds) {
  const out = {};
  for (let k = 0; k < symbols.length; k += 400) {
    const params = new URLSearchParams();
    symbols.slice(k, k + 400).forEach((s) => params.append('i', `NFO:${s}`));
    const data = await kite('GET', '/quote', { creds, params, family: 'quote', gap: 1000 });
    for (const s of symbols.slice(k, k + 400)) {
      const q = data[`NFO:${s}`];
      if (!q) continue;
      const bid = q.depth?.buy?.find((l) => l.price > 0);
      const ask = q.depth?.sell?.find((l) => l.price > 0);
      out[s] = { ltp: q.last_price, bid: bid?.price || 0, ask: ask?.price || 0, bidQty: bid?.quantity || 0, askQty: ask?.quantity || 0, oi: q.oi || 0, volume: q.volume || 0, depth: q.depth };
    }
  }
  return out;
}

const midOf = (q) => (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.ltp);

// Option chain around the money: strikes, quotes, IV and greeks for calls and puts of one expiry.
export async function chain(u, expiryDate, { strikes = 15 } = {}) {
  const creds = await marketCreds();
  const x = underlyingOf(u);
  const all = (await instruments(creds))[x.name] || [];
  const exps = await expiries(u, creds);
  const exp = expiryDate && exps.includes(expiryDate) ? expiryDate : exps[0];
  if (!exp) throw kiteError(`No ${x.name} option expiries found`, 'KITE');
  const list = all.filter((o) => o.expiryDate === exp);
  const s = await spot(u, creds);
  const allStrikes = [...new Set(list.map((o) => o.strike))].sort((a, b) => a - b);
  const atmIdx = allStrikes.reduce((best, k, i) => (Math.abs(k - s.price) < Math.abs(allStrikes[best] - s.price) ? i : best), 0);
  const chosen = allStrikes.slice(Math.max(0, atmIdx - strikes), atmIdx + strikes + 1);
  const legs = list.filter((o) => chosen.includes(o.strike));
  const quotes = await optionQuotes(legs.map((o) => o.tradingsymbol), creds);
  const t = yearsTo(legs[0]?.expiry || Date.now());
  const row = (o) => {
    if (!o) return null;
    const q = quotes[o.tradingsymbol] || { ltp: 0, bid: 0, ask: 0, oi: 0, volume: 0 };
    const mid = midOf(q);
    const iv = mid > 0 ? impliedVol(o.type, mid, s.price, o.strike, t) : null;
    const g = iv ? blackScholes(o.type, s.price, o.strike, t, iv) : null;
    return { tradingsymbol: o.tradingsymbol, ...q, depth: undefined, mid: +mid.toFixed(2), iv: iv ? +(iv * 100).toFixed(2) : null, delta: g ? +g.delta.toFixed(3) : null, theta: g ? +g.theta.toFixed(2) : null, vega: g ? +g.vega.toFixed(2) : null, spreadPct: q.bid > 0 && q.ask > 0 ? +(((q.ask - q.bid) / mid) * 100).toFixed(2) : null };
  };
  const rows = chosen.map((k) => ({ strike: k, call: row(legs.find((o) => o.strike === k && o.type === 'CE')), put: row(legs.find((o) => o.strike === k && o.type === 'PE')) }));
  const atm = rows.reduce((b, r) => (Math.abs(r.strike - s.price) < Math.abs(b.strike - s.price) ? r : b), rows[0]);
  const atmIv = [atm?.call?.iv, atm?.put?.iv].filter(Boolean);
  return {
    underlying: x.name, label: x.label, spot: s.price, change: s.change, expiry: exp, expiries: exps, expiryMs: legs[0]?.expiry,
    daysToExpiry: +((legs[0]?.expiry - Date.now()) / 86400e3).toFixed(2), lotSize: legs[0]?.lotSize, atmStrike: atm?.strike,
    atmIv: atmIv.length ? +(atmIv.reduce((a, b) => a + b, 0) / atmIv.length).toFixed(2) : null,
    pcr: (() => { const ce = rows.reduce((a, r) => a + (r.call?.oi || 0), 0); const pe = rows.reduce((a, r) => a + (r.put?.oi || 0), 0); return ce ? +(pe / ce).toFixed(2) : null; })(),
    rows,
  };
}

// ---- Orders (one leg). Marketable limit: a little through the touch, polled, the rest cancelled. ----
export async function placeLeg(creds, { tradingsymbol, side, qty, tag }) {
  if (!nfo.marketOpen()) throw kiteError('NSE F&O market is closed (Mon-Fri 09:15-15:30 IST)', 'KITE_CLOSED');
  const c = await contract(tradingsymbol, creds);
  const q = (await optionQuotes([tradingsymbol], creds))[tradingsymbol];
  if (!q) throw kiteError(`No quote for ${tradingsymbol}`, 'KITE');
  const ref = side === 'BUY' ? q.ask || q.ltp : q.bid || q.ltp;
  if (!(ref > 0)) throw kiteError(`No ${side === 'BUY' ? 'sellers' : 'buyers'} for ${tradingsymbol}`, 'KITE');
  const buffer = Math.max(c.tickSize * 2, ref * 0.01); // at most ~1% through the touch
  const price = Math.max(c.tickSize, roundTick(side === 'BUY' ? ref + buffer : ref - buffer, c.tickSize, side === 'BUY' ? 1 : -1));
  const r = await kite('POST', '/orders/regular', {
    creds, family: 'orders', gap: 120,
    form: { tradingsymbol, exchange: 'NFO', transaction_type: side, order_type: 'LIMIT', quantity: qty, price, product: 'NRML', validity: 'DAY', tag: tag?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
  });
  const state = async () => (await kite('GET', `/orders/${r.order_id}`, { creds, family: 'portfolio', gap: 350 })).at(-1);
  let st;
  for (let k = 0; k < 10; k++) {
    await sleep(600);
    st = await state();
    if (['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) break;
  }
  if (!['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) {
    await kite('DELETE', `/orders/regular/${r.order_id}`, { creds, family: 'orders', gap: 120 }).catch(() => {});
    st = await state();
  }
  const filled = Number(st.filled_quantity) || 0;
  const avg = Number(st.average_price) || 0;
  return { orderId: r.order_id, filled, price: avg, fee: filled ? optionFee(filled * avg, side) : 0, status: st.status, message: st.status_message };
}

// Net NFO option positions on the account (quantity > 0 long, < 0 short).
export async function optionPositions(creds) {
  const pos = await kite('GET', '/portfolio/positions', { creds, family: 'portfolio', gap: 350 });
  return (pos?.net || []).filter((p) => p.exchange === 'NFO' && p.quantity !== 0).map((p) => ({ tradingsymbol: p.tradingsymbol, qty: p.quantity, avg: p.average_price, ltp: p.last_price, pnl: p.pnl, m2m: p.m2m }));
}

export async function marginAvailable(creds) {
  const m = await kite('GET', '/user/margins/equity', { creds, family: 'portfolio', gap: 350 });
  return Number(m.net) || 0;
}

// Margin Zerodha would block for a basket of legs (hedges included). Null when the call is not available.
export async function basketMargin(creds, legs) {
  try {
    const data = await kite('POST', '/margins/basket?consider_positions=true', {
      creds, family: 'portfolio', gap: 350,
      json: legs.map((l) => ({ exchange: 'NFO', tradingsymbol: l.tradingsymbol, transaction_type: l.side, variety: 'regular', product: 'NRML', order_type: 'MARKET', quantity: l.qty, price: 0, trigger_price: 0 })),
    });
    return Number(data?.final?.total ?? data?.initial?.total) || null;
  } catch {
    return null;
  }
}

// Registry entry: market data for the options module (index candles for the AI). Generic spot trading is refused:
// options go through /api/options, which enforces defined-risk strategies.
export const nfo = {
  id: 'nfo', name: 'Zerodha (NSE options)', trading: false, optionsOnly: true, canShort: true, // canShort: the AI may read the index as bearish (-> puts) currency: 'INR', market: 'options', account: 'options',
  connection: 'zerodha', intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '1d'], sessionHours: SESSION_HOURS,
  costs: { feeRate: 0.0005, slippageBps: 2, spreadBps: 2 },
  marketOpen,
  async getKlines(symbol, interval, limit = 500) { return nfo.getKlinesDeep(symbol, interval, limit); },
  async getKlinesDeep(symbol, interval = '15m', total = 500) {
    const x = underlyingOf(symbol);
    const creds = await marketCreds();
    return loadCandles({ token: x.token, tradingsymbol: x.label }, interval, total, { creds, sessionHours: SESSION_HOURS });
  },
  async getTickers(symbols = Object.keys(UNDERLYINGS)) {
    const creds = await marketCreds();
    const out = [];
    for (const s of symbols.filter((x) => UNDERLYINGS[x])) {
      const q = await spot(s, creds);
      out.push({ symbol: s, price: q.price, change: q.change, high: q.high, low: q.low, volume: 0 });
    }
    return out;
  },
  async getPrice(symbol) { return (await spot(symbol, await marketCreds())).price; },
  async getOrderBook() { throw new Error('Indices have no order book'); },
  async getTrades() { throw new Error('Zerodha does not publish a trade tape'); },
  async getSymbols() { return Object.keys(UNDERLYINGS).map((s) => ({ symbol: s, base: s, quote: 'INR', stepSize: 1, minQty: 1, minNotional: 1, tickSize: 0.05 })); },
  tradingClient() { throw kiteError('Use the Options page: options are traded as defined-risk strategies', 'KITE'); },
};
