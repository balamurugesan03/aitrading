// NSE stocks through Zerodha Kite Connect (same Kite login as the forex adapter).
//
// - Delivery (CNC) only: long-only, fully paid, no leverage - the same buy-then-sell model as the rest of the engine.
// - Quantities are whole shares; prices and P&L are in INR.
// - Entries/exits are marketable LIMIT orders a little through the touch, kept inside the circuit limits.
// - The exchange-side stop-loss is a GTT (good-till-triggered) order: unlike a day order it survives the close and
//   server restarts, so a held stock stays protected overnight.
// - Selling delivered shares through the API needs DDPI (or a fresh CDSL eDIS authorisation) on the Zerodha account.
import { kite, marketCreds, kiteError, roundTick, loadCandles, parseCsv, sleep, IST_OFFSET_MS, nseHoliday } from './zerodha.js';

// Default watch list (NIFTY 50 constituents); any NSE equity symbol can be traded.
export const NIFTY50 = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'ITC', 'LT', 'SBIN', 'KOTAKBANK',
  'AXISBANK', 'HINDUNILVR', 'BAJFINANCE', 'M&M', 'MARUTI', 'SUNPHARMA', 'HCLTECH', 'NTPC', 'TITAN', 'ULTRACEMCO',
  'POWERGRID', 'TATASTEEL', 'ASIANPAINT', 'BAJAJFINSV', 'ONGC', 'ADANIPORTS', 'COALINDIA', 'NESTLEIND', 'JSWSTEEL', 'TECHM',
  'GRASIM', 'WIPRO', 'HINDALCO', 'BEL', 'CIPLA', 'DRREDDY', 'BAJAJ-AUTO', 'EICHERMOT', 'SBILIFE', 'HDFCLIFE',
  'TRENT', 'ADANIENT', 'TATACONSUM', 'APOLLOHOSP', 'SHRIRAMFIN', 'HEROMOTOCO', 'INDUSINDBK', 'JIOFIN', 'ETERNAL', 'TATAMOTORS',
];
const SESSION_HOURS = 6.25; // 09:15-15:30 IST

export function marketOpen(now = Date.now()) {
  if (nseHoliday(now)) return false;
  const ist = new Date(now + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// Delivery charges (Zerodha): no brokerage; STT 0.1% each side, stamp duty 0.015% on buys, NSE + SEBI fees with GST,
// and the DP charge (~Rs 15.34) on each sell.
export function equityFee(turnover, side = 'BUY') {
  const exchangeFees = turnover * (0.0000297 + 0.000001);
  const fee = turnover * 0.001 + exchangeFees * 1.18 + (side === 'BUY' ? turnover * 0.00015 : 15.34);
  return +fee.toFixed(2);
}

// ---- Instruments (NSE equities), refreshed every 12 hours ----
let instrumentCache = null;
async function instruments(creds) {
  if (instrumentCache && Date.now() - instrumentCache.at < 12 * 3600e3) return instrumentCache.map;
  const rows = parseCsv(await kite('GET', '/instruments/NSE', { creds, family: 'instruments', gap: 1000 }));
  const map = new Map();
  for (const r of rows) {
    if (r.instrument_type !== 'EQ' || r.segment !== 'NSE') continue;
    map.set(r.tradingsymbol, { symbol: r.tradingsymbol, token: r.instrument_token, name: r.name, tickSize: Number(r.tick_size) || 0.05, lastPrice: Number(r.last_price) || 0 });
  }
  instrumentCache = { at: Date.now(), map };
  return map;
}
async function instrument(symbol, creds) {
  const i = (await instruments(creds)).get(symbol);
  if (!i) throw kiteError(`${symbol} is not an NSE equity symbol`, 'KITE');
  return i;
}

async function quotes(symbols, creds) {
  const out = [];
  for (let k = 0; k < symbols.length; k += 400) {
    const params = new URLSearchParams();
    symbols.slice(k, k + 400).forEach((s) => params.append('i', `NSE:${s}`));
    const data = await kite('GET', '/quote', { creds, params, family: 'quote', gap: 1000 });
    for (const s of symbols.slice(k, k + 400)) if (data[`NSE:${s}`]) out.push({ symbol: s, q: data[`NSE:${s}`] });
  }
  return out;
}

async function depth(symbol, creds) {
  const [x] = await quotes([symbol], creds);
  if (!x) throw kiteError(`No quote for ${symbol}`, 'KITE');
  const side = (levels) => (levels || []).filter((l) => l.price > 0 && l.quantity > 0).map((l) => [l.price, l.quantity]);
  return { q: x.q, bids: side(x.q.depth?.buy), asks: side(x.q.depth?.sell) };
}

const ORDER_DONE = ['COMPLETE', 'REJECTED', 'CANCELLED'];
const STATUS = { COMPLETE: 'FILLED', REJECTED: 'REJECTED', CANCELLED: 'CANCELED' };
const GTT_GONE = ['disabled', 'expired', 'cancelled', 'rejected', 'deleted'];

function tradingClient(creds) {
  const call = (method, pathname, opts = {}) => kite(method, pathname, { creds, family: 'orders', gap: 120, ...opts });
  const read = (method, pathname, opts = {}) => kite(method, pathname, { creds, family: 'portfolio', gap: 350, ...opts });
  const orderState = async (orderId) => (await read('GET', `/orders/${orderId}`)).at(-1);

  // Shares held per symbol: settled + T1 holdings plus today's delivery trades (which only show up in positions).
  async function holdings() {
    const [h, pos] = await Promise.all([read('GET', '/portfolio/holdings'), read('GET', '/portfolio/positions')]);
    const rows = new Map();
    const add = (sym, units, lastPrice, avg, pnl) => {
      const r = rows.get(sym) || { pair: sym, units: 0, lastPrice, avgPrice: avg, pnl: 0 };
      r.units += units;
      r.lastPrice = lastPrice || r.lastPrice;
      r.pnl += pnl || 0;
      rows.set(sym, r);
    };
    for (const x of h || []) if (x.exchange === 'NSE' || x.exchange === 'BSE') add(x.tradingsymbol, (x.quantity || 0) + (x.t1_quantity || 0), x.last_price, x.average_price, x.pnl);
    for (const p of pos?.net || []) if (p.exchange === 'NSE' && p.product === 'CNC') add(p.tradingsymbol, p.quantity || 0, p.last_price, p.average_price, p.pnl);
    return [...rows.values()].filter((r) => r.units > 0);
  }

  async function place(symbol, side, qty, tag) {
    const i = await instrument(symbol, creds);
    const { q, bids, asks } = await depth(symbol, creds);
    const ref = side === 'BUY' ? asks[0]?.[0] ?? q.last_price : bids[0]?.[0] ?? q.last_price;
    if (!(ref > 0)) throw kiteError(`No ${symbol} price available - is the market open?`, 'KITE');
    let price = roundTick(side === 'BUY' ? ref * 1.002 : ref * 0.998, i.tickSize, side === 'BUY' ? 1 : -1);
    if (side === 'BUY' && q.upper_circuit_limit) price = Math.min(price, q.upper_circuit_limit);
    if (side === 'SELL' && q.lower_circuit_limit) price = Math.max(price, q.lower_circuit_limit);
    const r = await call('POST', '/orders/regular', {
      form: { tradingsymbol: symbol, exchange: 'NSE', transaction_type: side, order_type: 'LIMIT', quantity: qty, price, product: 'CNC', validity: 'DAY', tag: tag?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
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
    const filled = Number(st.filled_quantity) || 0;
    if (!filled) {
      const hint = /edis|ddpi|authori[sz]/i.test(st.status_message || '') ? ' - enable DDPI on your Zerodha account so the bot can sell delivered shares' : '';
      throw kiteError(`Zerodha order ${st.status.toLowerCase()}: ${st.status_message || 'not filled'}${hint}`, 'KITE_ORDER');
    }
    const avg = Number(st.average_price);
    const gross = filled * avg;
    return { orderId: r.order_id, qty: filled, price: avg, gross, fee: equityFee(gross, side) };
  }

  return {
    // Same shape as the forex account so the INR valuation code serves both: cash + shares at market.
    async fxAccount() {
      const [m, rows] = await Promise.all([read('GET', '/user/margins/equity'), holdings()]);
      const cash = Number(m.available?.live_balance ?? m.net) || 0;
      const positions = rows.map((r) => ({ ...r, contract: null }));
      return { equity: cash + positions.reduce((s, p) => s + p.units * p.lastPrice, 0), available: cash, positions };
    },
    async getAccount() {
      const a = await this.fxAccount();
      return [{ asset: 'INR', free: a.available, locked: 0 }, ...a.positions.map((p) => ({ asset: p.pair, free: p.units, locked: 0 }))];
    },
    async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId }) {
      if (!nse.marketOpen()) throw kiteError('NSE equity market is closed (Mon-Fri 09:15-15:30 IST)', 'KITE_CLOSED');
      if (side === 'BUY') {
        const { asks, q } = await depth(symbol, creds);
        const px = asks[0]?.[0] || q.last_price;
        const qty = Math.floor(quoteAmount / (px * 1.0035)); // room for the price buffer and charges
        if (qty < 1) throw kiteError(`Amount is below the price of one ${symbol} share (Rs ${px})`, 'KITE_SIZE');
        const f = await place(symbol, 'BUY', qty, clientOrderId);
        return { orderId: f.orderId, qty: f.qty, price: f.price, cost: f.gross + f.fee, fee: f.fee };
      }
      const held = (await holdings()).find((h) => h.pair === symbol)?.units || 0;
      const qty = Math.min(Math.floor(quantity + 1e-9), held);
      if (qty < 1) throw kiteError(`No ${symbol} shares to sell on Zerodha`, 'KITE_SIZE');
      const f = await place(symbol, 'SELL', qty, clientOrderId);
      return { orderId: f.orderId, qty: f.qty, price: f.price, cost: f.gross - f.fee, fee: f.fee };
    },
    // Exchange-side stop as a single-leg GTT: when the last price falls to the trigger, Zerodha places a LIMIT sell.
    async stopLossOrder({ symbol, quantity, stopPrice, limitPrice }) {
      const i = await instrument(symbol, creds);
      const { q } = await depth(symbol, creds);
      const trigger = roundTick(stopPrice, i.tickSize, -1);
      if (!(trigger < q.last_price)) throw kiteError('Stop is not below the current price', 'KITE');
      let price = roundTick(Math.max(limitPrice, trigger * 0.98), i.tickSize, -1);
      if (q.lower_circuit_limit) price = Math.max(price, q.lower_circuit_limit);
      const qty = Math.floor(quantity + 1e-9);
      const r = await call('POST', '/gtt/triggers', {
        form: {
          type: 'single',
          condition: JSON.stringify({ exchange: 'NSE', tradingsymbol: symbol, trigger_values: [trigger], last_price: q.last_price }),
          orders: JSON.stringify([{ exchange: 'NSE', tradingsymbol: symbol, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product: 'CNC', price }]),
        },
      });
      return { orderId: `gtt:${r.trigger_id}`, qty, stopPrice: trigger, limitPrice: price };
    },
    async getOrder(_symbol, orderId) {
      if (String(orderId).startsWith('gtt:')) {
        const g = await read('GET', `/gtt/triggers/${String(orderId).slice(4)}`);
        const placed = g.orders?.[0]?.result?.order_result?.order_id;
        if (g.status === 'triggered' && placed) {
          const st = await orderState(placed);
          const filled = Number(st.filled_quantity) || 0;
          const gross = filled * (Number(st.average_price) || 0);
          const fee = filled ? equityFee(gross, 'SELL') : 0;
          return { orderId, status: STATUS[st.status] || 'NEW', executedQty: filled, price: Number(st.average_price) || 0, cost: gross - fee, fee };
        }
        return { orderId, status: GTT_GONE.includes(g.status) ? 'CANCELED' : 'NEW', executedQty: 0, price: 0, cost: 0, fee: 0 };
      }
      const st = await orderState(orderId);
      const filled = Number(st.filled_quantity) || 0;
      const gross = filled * (Number(st.average_price) || 0);
      const fee = filled ? equityFee(gross, st.transaction_type) : 0;
      return { orderId, status: STATUS[st.status] || 'NEW', executedQty: filled, price: Number(st.average_price) || 0, cost: st.transaction_type === 'BUY' ? gross + fee : gross - fee, fee };
    },
    async cancelOrder(_symbol, orderId) {
      try {
        if (String(orderId).startsWith('gtt:')) await call('DELETE', `/gtt/triggers/${String(orderId).slice(4)}`);
        else await call('DELETE', `/orders/regular/${orderId}`);
        return true;
      } catch (err) {
        if (/complete|cancel|reject|not found|triggered|deleted|does not exist/i.test(err.message)) return false;
        throw err;
      }
    },
    async cancelOpenOrders(symbol) {
      const [orders, gtts] = await Promise.all([read('GET', '/orders'), read('GET', '/gtt/triggers')]);
      const open = (orders || []).filter((o) => o.exchange === 'NSE' && o.tradingsymbol === symbol && ['OPEN', 'TRIGGER PENDING'].includes(o.status));
      for (const o of open) await call('DELETE', `/orders/regular/${o.order_id}`).catch(() => {});
      const active = (gtts || []).filter((g) => g.status === 'active' && g.condition?.tradingsymbol === symbol);
      for (const g of active) await call('DELETE', `/gtt/triggers/${g.id}`).catch(() => {});
      return open.length + active.length;
    },
  };
}

export const nse = {
  id: 'nse', name: 'Zerodha (NSE stocks)', trading: true, currency: 'INR', market: 'stocks', account: 'stocks',
  connection: 'zerodha', // uses the Zerodha Kite login
  intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '1d'],
  lotUnits: 1, // whole shares
  feeFor: equityFee,
  costs: { feeRate: 0.0012, slippageBps: 3, spreadBps: 3 }, // STT-dominated delivery costs per side
  paperSpread: 0.0005,
  sessionHours: SESSION_HOURS,
  marketOpen,
  async getKlines(symbol, interval, limit = 500) { return nse.getKlinesDeep(symbol, interval, limit); },
  async getKlinesDeep(symbol, interval = '1h', total = 500) {
    const creds = await marketCreds();
    return loadCandles(await instrument(symbol, creds), interval, total, { creds, sessionHours: SESSION_HOURS });
  },
  async getTickers(symbols = NIFTY50) {
    const creds = await marketCreds();
    return (await quotes(symbols, creds)).map(({ symbol, q }) => {
      const prev = q.ohlc?.close || q.last_price;
      return { symbol, price: q.last_price, change: prev ? ((q.last_price - prev) / prev) * 100 : 0, high: q.ohlc?.high, low: q.ohlc?.low, volume: (q.volume || 0) * q.last_price };
    });
  },
  async getPrice(symbol) {
    const [x] = await quotes([symbol], await marketCreds());
    if (!x) throw kiteError(`No quote for ${symbol}`, 'KITE');
    return x.q.last_price;
  },
  async getOrderBook(symbol) {
    const { q, bids, asks } = await depth(symbol, await marketCreds());
    const p = q.last_price;
    return { bids: bids.length ? bids : [[p * 0.9995, 1e9]], asks: asks.length ? asks : [[p * 1.0005, 1e9]] };
  },
  async getTrades() {
    throw new Error('Zerodha does not publish a trade tape'); // order flow uses depth only
  },
  async getSymbols() {
    let map = null;
    try { map = await instruments(await marketCreds()); } catch { /* not logged in: the watch list only */ }
    const list = map ? [...map.values()] : NIFTY50.map((symbol) => ({ symbol, tickSize: 0.05, lastPrice: 0 }));
    return list.map((i) => ({ symbol: i.symbol, base: i.symbol, quote: 'INR', stepSize: 1, minQty: 1, minNotional: i.lastPrice || 1, tickSize: i.tickSize, name: i.name }));
  },
  tradingClient,
};
