// NSE futures (index + stock futures, NFO-FUT) through Zerodha Kite Connect (same Kite login as forex/stocks/options).
//
// How it maps onto the engine:
// - A symbol is the underlying ("NIFTY", "BANKNIFTY", "RELIANCE"); orders go to the near-month contract, rolled
//   ROLL_DAYS before expiry. Closing orders act only on contracts actually held, whatever month they are.
// - Quantities are in units (Kite NFO quantities are units, multiples of the contract's lot size), so
//   units x price = rupee notional. Lot sizes differ per underlying and come from the instrument dump.
// - MARGIN account: unlike the forex adapter, a position blocks only its margin (SPAN + exposure), not its full
//   notional. Paper fills block `marginRate` x notional; live orders are checked against Kite's own order-margin
//   calculation before they are sent. The risk engine sizes by stop distance and caps total leverage.
// - Long and short (sell first) are both allowed. Orders are marketable LIMIT orders (NRML) inside the price band.
// - The exchange-side stop is an SL (stop-limit) DAY order, re-placed by the engine each trading day.
import { kite, marketCreds, kiteError, roundTick, loadCandles, parseCsv, sleep } from './zerodha.js';
import { marketOpen, NIFTY50 } from './nse.js';

export const INDEX_FUTURES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
// Used only before the first Kite login (the instrument dump is authoritative): NSE lot sizes from the Dec-2025 revision.
const FALLBACK_LOTS = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120 };
const FALLBACK_PRICE = { NIFTY: 25000, BANKNIFTY: 55000, FINNIFTY: 26000, MIDCPNIFTY: 13000 };
// Approximate NRML margin (SPAN + exposure) as a share of notional, for paper fills and sizing. Live orders use
// Kite's exact figure. Override with NFUT_INDEX_MARGIN / NFUT_STOCK_MARGIN (e.g. 0.12).
const INDEX_MARGIN = Number(process.env.NFUT_INDEX_MARGIN || 0.12);
const STOCK_MARGIN = Number(process.env.NFUT_STOCK_MARGIN || 0.2);
export const marginRateOf = (symbol) => (INDEX_FUTURES.includes(symbol) ? INDEX_MARGIN : STOCK_MARGIN);
const ROLL_DAYS = 2;
const SESSION_HOURS = 6.25; // 09:15-15:30 IST

// Zerodha F&O futures charges per executed order: brokerage min(Rs 20, 0.03%), STT 0.02% on sells,
// NSE transaction 0.00173%, SEBI Rs 10/crore, GST 18% on brokerage + exchange + SEBI, stamp 0.002% on buys.
export function futuresFee(turnover, side = 'BUY') {
  const brokerage = Math.min(20, turnover * 0.0003);
  const exchange = turnover * 0.0000173;
  const sebi = turnover * 0.000001;
  const fee = brokerage + exchange + sebi + 0.18 * (brokerage + exchange + sebi)
    + (side === 'SELL' ? turnover * 0.0002 : turnover * 0.00002);
  return +fee.toFixed(2);
}

// ---- Instruments: every NFO future, grouped by underlying, refreshed every 6 hours ----
let cache = null;
async function instruments(creds) {
  if (cache && Date.now() - cache.at < 6 * 3600e3) return cache.byName;
  const rows = parseCsv(await kite('GET', '/instruments/NFO', { creds, family: 'instruments', gap: 1000 }));
  const byName = new Map();
  for (const r of rows) {
    if (r.segment !== 'NFO-FUT' || r.instrument_type !== 'FUT' || !r.name) continue;
    const list = byName.get(r.name) || [];
    list.push({
      symbol: r.name, tradingsymbol: r.tradingsymbol, token: r.instrument_token, expiryDate: r.expiry,
      expiry: Date.parse(`${r.expiry}T15:30:00+05:30`), lotSize: Number(r.lot_size) || 1, tickSize: Number(r.tick_size) || 0.05,
      lastPrice: Number(r.last_price) || 0,
    });
    byName.set(r.name, list);
  }
  for (const list of byName.values()) list.sort((a, b) => a.expiry - b.expiry);
  cache = { at: Date.now(), byName };
  return byName;
}
const allContracts = async (creds) => [...(await instruments(creds)).values()].flat();

export async function frontContract(symbol, creds) {
  const list = (await instruments(creds)).get(symbol);
  if (!list?.length) throw kiteError(`${symbol} has no NSE futures contract (index: ${INDEX_FUTURES.join(', ')}; or an F&O stock)`, 'KITE');
  return list.find((c) => c.expiry - Date.now() > ROLL_DAYS * 86400e3) || list.at(-1);
}

async function quotes(symbols, creds) {
  const cs = (await Promise.all(symbols.map((s) => frontContract(s, creds).catch(() => null)))).filter(Boolean);
  const out = [];
  for (let k = 0; k < cs.length; k += 400) {
    const params = new URLSearchParams();
    cs.slice(k, k + 400).forEach((c) => params.append('i', `NFO:${c.tradingsymbol}`));
    const data = await kite('GET', '/quote', { creds, params, family: 'quote', gap: 1000 });
    for (const c of cs.slice(k, k + 400)) if (data[`NFO:${c.tradingsymbol}`]) out.push({ c, q: data[`NFO:${c.tradingsymbol}`] });
  }
  return out;
}

async function depth(symbol, creds) {
  const [x] = await quotes([symbol], creds);
  if (!x) throw kiteError(`No quote for ${symbol} futures`, 'KITE');
  const side = (levels) => (levels || []).filter((l) => l.price > 0 && l.quantity > 0).map((l) => [l.price, l.quantity]);
  return { c: x.c, q: x.q, bids: side(x.q.depth?.buy), asks: side(x.q.depth?.sell) };
}

// Keeps a limit price inside the day's price band (circuit limits) when Kite reports them.
const inBand = (price, q, side) => {
  if (side === 'BUY' && q.upper_circuit_limit) return Math.min(price, q.upper_circuit_limit);
  if (side === 'SELL' && q.lower_circuit_limit) return Math.max(price, q.lower_circuit_limit);
  return price;
};

const ORDER_DONE = ['COMPLETE', 'REJECTED', 'CANCELLED'];
const STATUS = { COMPLETE: 'FILLED', REJECTED: 'REJECTED', CANCELLED: 'CANCELED' };

function tradingClient(creds) {
  const call = (method, pathname, opts = {}) => kite(method, pathname, { creds, family: 'orders', gap: 120, ...opts });
  const read = (method, pathname, opts = {}) => kite(method, pathname, { creds, family: 'portfolio', gap: 350, ...opts });
  const orderState = async (orderId) => (await read('GET', `/orders/${orderId}`)).at(-1);

  async function netPositions() {
    const pos = await read('GET', '/portfolio/positions');
    return (pos?.net || []).filter((p) => p.exchange === 'NFO');
  }

  // Futures held in one direction for an underlying, nearest expiry first.
  async function heldContracts(symbol, side = 'long') {
    const list = (await instruments(creds)).get(symbol) || [];
    return (await netPositions())
      .map((p) => ({ p, c: list.find((c) => c.tradingsymbol === p.tradingsymbol) }))
      .filter(({ p, c }) => c && (side === 'short' ? p.quantity < 0 : p.quantity > 0))
      .map(({ p, c }) => ({ c, p, lots: Math.floor(Math.abs(p.quantity) / c.lotSize) }))
      .sort((a, b) => a.c.expiry - b.c.expiry);
  }

  // Kite's own margin requirement for an order (SPAN + exposure), in rupees.
  async function requiredMargin(c, side, qty, price) {
    const r = await call('POST', '/margins/orders', {
      json: [{ exchange: 'NFO', tradingsymbol: c.tradingsymbol, transaction_type: side, variety: 'regular', product: 'NRML', order_type: 'LIMIT', quantity: qty, price, trigger_price: 0 }],
      family: 'portfolio', gap: 350,
    });
    return Number(r?.[0]?.total) || 0;
  }

  async function place(c, side, lots, tag, { checkMargin = false } = {}) {
    const { bids, asks, q } = await depth(c.symbol, creds);
    const ref = side === 'BUY' ? asks[0]?.[0] ?? q.last_price : bids[0]?.[0] ?? q.last_price;
    if (!(ref > 0)) throw kiteError(`No ${c.symbol} futures price available - is the market open?`, 'KITE');
    const price = inBand(roundTick(side === 'BUY' ? ref * 1.001 : ref * 0.999, c.tickSize, side === 'BUY' ? 1 : -1), q, side);
    const qty = lots * c.lotSize;
    if (checkMargin) {
      const [need, m] = await Promise.all([requiredMargin(c, side, qty, price), read('GET', '/user/margins/equity')]);
      const free = Number(m?.net) || 0;
      if (need > free) throw kiteError(`Not enough margin for ${lots} lot(s) of ${c.tradingsymbol}: needs Rs ${Math.round(need).toLocaleString('en-IN')}, available Rs ${Math.round(free).toLocaleString('en-IN')}`, 'KITE_MARGIN');
    }
    const r = await call('POST', '/orders/regular', {
      form: { tradingsymbol: c.tradingsymbol, exchange: 'NFO', transaction_type: side, order_type: 'LIMIT', quantity: qty, price, product: 'NRML', validity: 'DAY', tag: tag?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
    });
    let st;
    for (let k = 0; k < 10; k++) {
      await sleep(600);
      st = await orderState(r.order_id);
      if (ORDER_DONE.includes(st.status)) break;
    }
    if (!ORDER_DONE.includes(st.status)) {
      await call('DELETE', `/orders/regular/${r.order_id}`).catch(() => {});
      st = await orderState(r.order_id);
    }
    const units = Number(st.filled_quantity) || 0;
    if (!units) throw kiteError(`Zerodha order ${st.status.toLowerCase()}: ${st.status_message || 'not filled'}`, 'KITE_ORDER');
    const avg = Number(st.average_price);
    const gross = units * avg;
    return { orderId: r.order_id, units, price: avg, gross, fee: futuresFee(gross, side), contract: c.tradingsymbol };
  }

  async function closeHeld(symbol, side, units, tag) {
    let left = units;
    const fills = [];
    for (const { c, lots: have } of await heldContracts(symbol, side === 'SELL' ? 'long' : 'short')) {
      if (left <= 0) break;
      const lots = Math.min(Math.floor(left / c.lotSize + 1e-9), have);
      if (lots < 1) continue;
      fills.push(await place(c, side, lots, tag));
      left -= lots * c.lotSize;
    }
    return fills;
  }

  return {
    // Equity = opening balance + intraday pay-in + today's mark-to-market (futures settle daily). marginUsed is
    // what Zerodha has blocked (SPAN + exposure) on the shared F&O margin account.
    async fxAccount() {
      const [m, pos] = await Promise.all([read('GET', '/user/margins/equity'), read('GET', '/portfolio/positions')]);
      const allNet = pos?.net || [];
      const list = await allContracts(creds);
      const positions = allNet
        .filter((p) => p.exchange === 'NFO' && p.quantity !== 0)
        .map((p) => ({ p, c: list.find((c) => c.tradingsymbol === p.tradingsymbol) }))
        .filter(({ c }) => c)
        .map(({ p, c }) => ({ pair: c.symbol, contract: c.tradingsymbol, expiry: c.expiry, units: p.quantity, avgPrice: p.average_price, lastPrice: p.last_price, m2m: p.m2m, pnl: p.pnl }));
      const m2m = allNet.reduce((s, p) => s + (Number(p.m2m) || 0), 0);
      const equity = (Number(m.available?.opening_balance) || 0) + (Number(m.available?.intraday_payin) || 0) + m2m;
      const marginUsed = (Number(m.utilised?.span) || 0) + (Number(m.utilised?.exposure) || 0);
      return { equity, available: Number(m.net) || 0, marginUsed, positions };
    },
    async getAccount() {
      const a = await this.fxAccount();
      const longs = {};
      a.positions.filter((p) => p.units > 0).forEach((p) => (longs[p.pair] = (longs[p.pair] || 0) + p.units));
      return [{ asset: 'INR', free: a.available, locked: 0 }, ...Object.entries(longs).map(([asset, units]) => ({ asset, free: units, locked: 0 }))];
    },
    // Opening (BUY a long / SELL with short=true): front contract, whole lots sized by notional quoteAmount, after a
    // Kite margin check. Closing (SELL a long / BUY with short=true): only contracts actually held.
    async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, short = false }) {
      if (!marketOpen()) throw kiteError('NSE F&O market is closed (Mon-Fri 09:15-15:30 IST)', 'KITE_CLOSED');
      const opening = short ? side === 'SELL' : side === 'BUY';
      if (opening) {
        const c = await frontContract(symbol, creds);
        const { asks, bids, q } = await depth(symbol, creds);
        const px = (side === 'BUY' ? asks : bids)[0]?.[0] || q.last_price;
        const lots = Math.floor(quoteAmount / (px * c.lotSize * 1.001));
        if (lots < 1) throw kiteError(`Order is smaller than 1 lot of ${symbol} futures (${c.lotSize} units, about Rs ${Math.round(px * c.lotSize).toLocaleString('en-IN')} notional)`, 'KITE_SIZE');
        const f = await place(c, side, lots, clientOrderId, { checkMargin: true });
        return { orderId: f.orderId, qty: f.units, price: f.price, cost: side === 'BUY' ? f.gross + f.fee : f.gross - f.fee, fee: f.fee, contract: f.contract, contractExpiry: c.expiry };
      }
      const fills = await closeHeld(symbol, side, quantity, clientOrderId);
      if (!fills.length) throw kiteError(`No ${symbol} ${short ? 'short' : 'long'} futures position to ${short ? 'cover' : 'sell'} on Zerodha`, 'KITE_SIZE');
      const units = fills.reduce((s, f) => s + f.units, 0);
      const gross = fills.reduce((s, f) => s + f.gross, 0);
      const fee = fills.reduce((s, f) => s + f.fee, 0);
      return { orderId: fills.map((f) => f.orderId).join(','), qty: units, price: gross / units, cost: side === 'BUY' ? gross + fee : gross - fee, fee };
    },
    async shortUnits(symbol) {
      return (await heldContracts(symbol, 'short')).reduce((s, h) => s + h.lots * h.c.lotSize, 0);
    },
    // SL (stop-limit) DAY order on the held contract. side 'SELL' protects a long, 'BUY' protects a short.
    async stopLossOrder({ symbol, quantity, stopPrice, limitPrice, clientOrderId, side = 'SELL' }) {
      if (!marketOpen()) throw kiteError('NSE F&O market is closed', 'KITE_CLOSED');
      const held = (await heldContracts(symbol, side === 'BUY' ? 'short' : 'long'))[0];
      if (!held) throw kiteError(`No ${symbol} futures position to protect`, 'KITE_SIZE');
      const { c } = held;
      const lots = Math.min(Math.floor(quantity / c.lotSize + 1e-9), held.lots);
      if (lots < 1) throw kiteError('Stop size is below one lot', 'KITE_SIZE');
      const { q } = await depth(symbol, creds);
      const up = side === 'BUY';
      const trigger = roundTick(stopPrice, c.tickSize, up ? 1 : -1);
      const price = inBand(up ? roundTick(Math.min(limitPrice, trigger * 1.01), c.tickSize, 1) : roundTick(Math.max(limitPrice, trigger * 0.99), c.tickSize, -1), q, side);
      const r = await call('POST', '/orders/regular', {
        form: { tradingsymbol: c.tradingsymbol, exchange: 'NFO', transaction_type: side, order_type: 'SL', quantity: lots * c.lotSize, price, trigger_price: trigger, product: 'NRML', validity: 'DAY', tag: clientOrderId?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
      });
      return { orderId: r.order_id, qty: lots * c.lotSize, stopPrice: trigger, limitPrice: price };
    },
    async getOrder(_symbol, orderId) {
      const st = await orderState(orderId);
      const units = Number(st.filled_quantity) || 0;
      const gross = units * (Number(st.average_price) || 0);
      const fee = units ? futuresFee(gross, st.transaction_type) : 0;
      return { orderId, status: STATUS[st.status] || 'NEW', executedQty: units, price: Number(st.average_price) || 0, cost: st.transaction_type === 'BUY' ? gross + fee : gross - fee, fee };
    },
    async cancelOrder(_symbol, orderId) {
      try {
        await call('DELETE', `/orders/regular/${orderId}`);
        return true;
      } catch (err) {
        if (/complete|cancel|reject|not found/i.test(err.message)) return false;
        throw err;
      }
    },
    async cancelOpenOrders(symbol) {
      const list = (await instruments(creds)).get(symbol) || [];
      const mine = new Set(list.map((c) => c.tradingsymbol));
      const orders = await read('GET', '/orders');
      const open = (orders || []).filter((o) => o.exchange === 'NFO' && mine.has(o.tradingsymbol) && ['OPEN', 'TRIGGER PENDING'].includes(o.status));
      for (const o of open) await call('DELETE', `/orders/regular/${o.order_id}`).catch(() => {});
      return open.length;
    },
  };
}

// Default watch list: the index futures plus the NIFTY 50 stocks that have futures.
async function watchList(creds) {
  const byName = await instruments(creds);
  return [...INDEX_FUTURES, ...NIFTY50].filter((s) => byName.has(s));
}

export const nfut = {
  id: 'nfut', name: 'Zerodha (NSE futures)', trading: true, canShort: true, currency: 'INR', market: 'futures', account: 'futures',
  connection: 'zerodha', // uses the Zerodha Kite login
  intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '1d'],
  margin: true, // positions block margin, not their full notional
  marginRateOf,
  // Units per lot differ per underlying; the paper broker and the engine ask for the contract's lot.
  async lotFor(symbol) {
    try { return (await frontContract(symbol, await marketCreds())).lotSize; } catch { return FALLBACK_LOTS[symbol] || 1; }
  },
  feeFor: futuresFee,
  costs: { feeRate: 0.0002, slippageBps: 1, spreadBps: 1 }, // per side; used by paper fills, analysis and backtests
  paperSpread: 0.0001,
  sessionHours: SESSION_HOURS,
  marketOpen,
  async getKlines(symbol, interval, limit = 500) { return nfut.getKlinesDeep(symbol, interval, limit); },
  async getKlinesDeep(symbol, interval = '1h', total = 500) {
    const creds = await marketCreds();
    return loadCandles(await frontContract(symbol, creds), interval, total, { creds, sessionHours: SESSION_HOURS });
  },
  async getTickers(symbols) {
    const creds = await marketCreds();
    const list = symbols || (await watchList(creds));
    return (await quotes(list, creds)).map(({ c, q }) => {
      const prev = q.ohlc?.close || q.last_price;
      return {
        symbol: c.symbol, price: q.last_price, change: prev ? ((q.last_price - prev) / prev) * 100 : 0, high: q.ohlc?.high, low: q.ohlc?.low,
        volume: (q.volume || 0) * q.last_price, contract: c.tradingsymbol, expiry: c.expiryDate, oi: q.oi, lotSize: c.lotSize, marginRate: marginRateOf(c.symbol),
      };
    });
  },
  async getPrice(symbol) {
    const [x] = await quotes([symbol], await marketCreds());
    if (!x) throw kiteError(`No quote for ${symbol} futures`, 'KITE');
    return x.q.last_price;
  },
  async getOrderBook(symbol) {
    const { q, bids, asks } = await depth(symbol, await marketCreds());
    const p = q.last_price;
    return { bids: bids.length ? bids : [[p * 0.9999, 1e9]], asks: asks.length ? asks : [[p * 1.0001, 1e9]] };
  },
  async getTrades() {
    throw new Error('Zerodha does not publish a trade tape'); // order flow uses depth only
  },
  async getSymbols() {
    let byName = null;
    try { byName = await instruments(await marketCreds()); } catch { /* not logged in: index futures only */ }
    if (!byName) {
      return INDEX_FUTURES.map((symbol) => ({
        symbol, base: symbol, quote: 'INR', stepSize: FALLBACK_LOTS[symbol], minQty: FALLBACK_LOTS[symbol],
        minNotional: FALLBACK_LOTS[symbol] * FALLBACK_PRICE[symbol], tickSize: 0.05, marginRate: marginRateOf(symbol), lotSize: FALLBACK_LOTS[symbol],
      }));
    }
    return [...byName.keys()].map((symbol) => {
      const list = byName.get(symbol);
      const c = list.find((x) => x.expiry - Date.now() > ROLL_DAYS * 86400e3) || list.at(-1);
      return {
        symbol, base: symbol, quote: 'INR', stepSize: c.lotSize, minQty: c.lotSize, minNotional: c.lotSize * (c.lastPrice || FALLBACK_PRICE[symbol] || 1),
        tickSize: c.tickSize, contract: c.tradingsymbol, expiry: c.expiry, marginRate: marginRateOf(symbol), lotSize: c.lotSize,
      };
    });
  },
  tradingClient,
};
