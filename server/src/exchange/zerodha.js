// Zerodha Kite Connect adapter: NSE currency futures on the INR pairs (USDINR, EURINR, GBPINR, JPYINR) -
// the forex market Indian residents may trade under FEMA/RBI rules.
//
// How it maps onto the crypto-style engine:
// - A symbol is the pair ("USDINR"); orders go to the near-month futures contract, rolled ROLL_DAYS before expiry.
//   Sells close the contracts actually held, whatever month they are.
// - Quantities are in units: 1 lot = 1,000 units (1,000 USD/EUR/GBP, or 100,000 JPY since JPYINR is quoted
//   per 100 JPY), so units x price = rupee notional. Orders are whole lots.
// - "Market" orders are sent as marketable LIMIT orders a couple of ticks through the book (no unbounded fills).
// - Positions are fully funded by the engine (the bot never uses the futures leverage). Bots may also go short
//   (sell first) when the bot has "allow shorts" on - futures can be sold without holding anything.
// - Access tokens expire every morning (~6:00 IST), so the owner logs in to Kite once a day.
import crypto from 'crypto';
import { db } from '../db/index.js';
import { decrypt } from '../auth/crypto.js';

const API = 'https://api.kite.trade';
export const KITE_LOGIN_URL = 'https://kite.zerodha.com/connect/login';
export const FX_PAIRS = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR'];
export const UNITS_PER_LOT = 1000;
const ROLL_DAYS = 2;
export const IV = { '1m': 'minute', '3m': '3minute', '5m': '5minute', '15m': '15minute', '30m': '30minute', '1h': '60minute', '1d': 'day' };
const IV_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 };
const MAX_DAYS = { minute: 60, '3minute': 100, '5minute': 100, '15minute': 200, '30minute': 200, '60minute': 400, day: 2000 }; // Kite caps per request
const SESSION_HOURS = 8; // NSE currency futures trade 09:00-17:00 IST
export const IST_OFFSET_MS = 330 * 60e3;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const roundTick = (p, tick, dir = 0) => {
  const n = p / tick;
  return +((dir > 0 ? Math.ceil(n) : dir < 0 ? Math.floor(n) : Math.round(n)) * tick).toFixed(4);
};
export const kiteError = (msg, code, status = 400) => Object.assign(new Error(msg), { code, status }); // never 401: that signs the app user out

// ---- Market hours (IST). Holidays: list them in NSE_HOLIDAYS (YYYY-MM-DD, comma-separated); otherwise a holiday
// simply has no new candles and the stale-data guard keeps bots out. ----
const HOLIDAYS = new Set(String(process.env.NSE_HOLIDAYS || '').split(',').map((d) => d.trim()).filter(Boolean));
export const nseHoliday = (now = Date.now()) => HOLIDAYS.has(new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10));

export function marketOpen(now = Date.now()) {
  if (nseHoliday(now)) return false;
  const ist = new Date(now + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 && mins < 17 * 60;
}

// A Kite access token is valid until the next 06:00 IST.
export function sessionValid(sessionAt, now = Date.now()) {
  if (!sessionAt) return false;
  const ist = new Date(now + IST_OFFSET_MS);
  let lastReset = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0) - IST_OFFSET_MS;
  if (now < lastReset) lastReset -= 86400e3;
  return sessionAt >= lastReset;
}

// ---- Rate limits: Kite allows ~1 quote/s, 3 historical/s, 10 orders/s. One queue per family. ----
const queues = {};
function throttle(family, gapMs) {
  const q = (queues[family] ||= { last: 0, chain: Promise.resolve() });
  const run = q.chain.then(async () => {
    const wait = q.last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    q.last = Date.now();
  });
  q.chain = run.catch(() => {});
  return run;
}

export async function kite(method, pathname, { creds, params, form, json, family = 'other', gap = 120 } = {}) {
  if (!creds?.apiKey || !creds?.accessToken || !sessionValid(creds.sessionAt)) {
    throw kiteError('Zerodha session expired - open Account > Exchange connections and click "Log in to Kite"', 'KITE_LOGIN');
  }
  await throttle(family, gap);
  let url = `${API}${pathname}`;
  if (params) url += `?${params instanceof URLSearchParams ? params : new URLSearchParams(params)}`;
  const headers = { 'X-Kite-Version': '3', Authorization: `token ${creds.apiKey}:${creds.accessToken}` };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* CSV endpoints */ }
  if (!res.ok || j?.status === 'error') {
    if (j?.error_type === 'TokenException' || res.status === 403) {
      markSessionExpired(creds).catch(() => {});
      throw kiteError('Zerodha session expired - log in to Kite again (Account > Exchange connections)', 'KITE_LOGIN');
    }
    throw kiteError(`Zerodha: ${j?.message || `HTTP ${res.status}`}`, j?.error_type || 'KITE', res.status === 429 ? 429 : 400);
  }
  return j ? j.data : text;
}

// ---- Login (request_token -> access_token) ----
export const loginUrl = (apiKey, state) => `${KITE_LOGIN_URL}?v=3&api_key=${encodeURIComponent(apiKey)}&redirect_params=${encodeURIComponent(`state=${state}`)}`;

export async function createSession(apiKey, apiSecret, requestToken) {
  const checksum = crypto.createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
  const res = await fetch(`${API}/session/token`, {
    method: 'POST',
    headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status !== 'success') throw kiteError(`Zerodha login failed: ${j?.message || res.status}`, 'KITE');
  return { accessToken: j.data.access_token, kiteUserId: j.data.user_id, userName: j.data.user_name };
}

async function markSessionExpired(creds) {
  if (creds.connectionId) await db.apiConnections.update(creds.connectionId, { sessionAt: null, lastTestOk: false, lastTestMsg: 'Session expired - log in to Kite again' });
  sessionCache = null;
}

// Market data has no user context; this is a single-owner install, so it uses the owner's active Kite session.
let sessionCache = null;
export async function marketCreds() {
  if (sessionCache && Date.now() - sessionCache.at < 30000) return sessionCache.creds;
  const conn = (await db.apiConnections.find({ exchange: 'zerodha', active: true }, { sort: { sessionAt: -1 } }))[0];
  const creds = conn?.accessToken ? { apiKey: decrypt(conn.apiKey), accessToken: decrypt(conn.accessToken), sessionAt: conn.sessionAt, connectionId: conn._id } : null;
  sessionCache = { at: Date.now(), creds };
  if (!creds) throw kiteError('Connect Zerodha and log in to Kite to load NSE currency data (Account > Exchange connections)', 'KITE_LOGIN');
  return creds;
}
export const resetSessionCache = () => { sessionCache = null; };

// ---- Instruments: near-month currency futures per pair (instrument dump refreshed every 6 hours) ----
let instrumentCache = null;
export function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((line) => {
    const vals = line.split(',').map((v) => v.replace(/^"|"$/g, ''));
    return Object.fromEntries(cols.map((c, k) => [c, vals[k]]));
  });
}
async function contracts(creds) {
  if (instrumentCache && Date.now() - instrumentCache.at < 6 * 3600e3) return instrumentCache.list;
  const rows = parseCsv(await kite('GET', '/instruments/CDS', { creds, family: 'instruments', gap: 1000 }));
  const list = rows
    .filter((r) => r.instrument_type === 'FUT' && FX_PAIRS.includes(r.name) && r.segment === 'CDS-FUT')
    .map((r) => ({
      pair: r.name, tradingsymbol: r.tradingsymbol, token: r.instrument_token, expiryDate: r.expiry,
      expiry: Date.parse(`${r.expiry}T12:15:00+05:30`), // last trading time on expiry day
      lotSize: Number(r.lot_size) || 1, tickSize: Number(r.tick_size) || 0.0025, lastPrice: Number(r.last_price) || 0,
    }))
    .sort((a, b) => a.expiry - b.expiry);
  instrumentCache = { at: Date.now(), list };
  return list;
}
export async function frontContract(pair, creds) {
  if (!FX_PAIRS.includes(pair)) throw kiteError(`${pair} is not an NSE currency pair (use ${FX_PAIRS.join(', ')})`, 'KITE');
  const list = (await contracts(creds)).filter((c) => c.pair === pair);
  const c = list.find((x) => x.expiry - Date.now() > ROLL_DAYS * 86400e3) || list.at(-1);
  if (!c) throw kiteError(`No ${pair} futures contract found`, 'KITE');
  return c;
}
const unitsPerQty = (c) => UNITS_PER_LOT / c.lotSize; // Kite quantities are in multiples of lot_size

// ---- Candles (cached; refreshed incrementally so a bot ticking every 15s costs one small request) ----
const candleCache = new Map();
const fmt = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

async function historical(c, interval, fromMs, toMs, creds) {
  const data = await kite('GET', `/instruments/historical/${c.token}/${IV[interval]}`, {
    creds, params: { from: fmt(fromMs), to: fmt(toMs), continuous: 0, oi: 0 }, family: 'historical', gap: 350,
  });
  return (data?.candles || []).map((k) => ({ time: Math.floor(Date.parse(k[0]) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

// Shared by the forex and stock adapters: `instrument` is { token, tradingsymbol }, sessionHours the trading day length.
export async function loadCandles(instrument, interval, total, { creds, sessionHours = SESSION_HOURS } = {}) {
  if (!IV[interval]) throw kiteError(`Zerodha does not support the ${interval} timeframe`, 'KITE');
  const c = instrument;
  const key = `${c.token}:${interval}`;
  const hit = candleCache.get(key);
  const now = Date.now();
  if (hit && hit.total >= total && now - hit.at < 15000) return hit.candles.slice(-total);
  let candles;
  if (hit && hit.total >= total && now - hit.at < 6 * 3600e3) {
    // Incremental: re-read the last 3 days and merge over the cached series.
    const fresh = await historical(c, interval, now - 3 * 86400e3, now, creds);
    const cut = fresh.length ? fresh[0].time : Infinity;
    candles = [...hit.candles.filter((k) => k.time < cut), ...fresh];
  } else {
    const perDay = interval === '1d' ? 1 : (sessionHours * 3600) / IV_SEC[interval];
    let daysNeeded = Math.ceil((total / perDay) * (7 / 5)) + 7; // weekends + holidays
    const chunk = MAX_DAYS[IV[interval]];
    candles = [];
    let to = now;
    for (let k = 0; k < 12 && daysNeeded > 0; k++) {
      const span = Math.min(chunk, daysNeeded);
      const from = to - span * 86400e3;
      const part = await historical(c, interval, from, to, creds);
      if (!part.length && k > 0) break; // before the contract was listed
      candles = [...part, ...candles.filter((x) => !part.length || x.time > part.at(-1).time)];
      daysNeeded -= span;
      to = from - 1000;
    }
  }
  const seen = new Set();
  candles = candles.filter((k) => (seen.has(k.time) ? false : seen.add(k.time))).sort((a, b) => a.time - b.time);
  candleCache.set(key, { at: now, total: Math.max(total, hit?.total || 0), candles: candles.slice(-Math.max(total, 3000)) });
  return candles.slice(-total);
}

async function getKlinesDeep(symbol, interval = '1h', total = 500) {
  const creds = await marketCreds();
  return loadCandles(await frontContract(symbol, creds), interval, total, { creds });
}

// ---- Quotes ----
async function quotes(pairs, creds) {
  const cs = await Promise.all(pairs.map((p) => frontContract(p, creds)));
  const params = new URLSearchParams();
  cs.forEach((c) => params.append('i', `CDS:${c.tradingsymbol}`));
  const data = await kite('GET', '/quote', { creds, params, family: 'quote', gap: 1000 });
  return cs.map((c) => ({ c, q: data[`CDS:${c.tradingsymbol}`] })).filter((x) => x.q);
}

async function orderBook(pair, creds) {
  const [{ c, q }] = await quotes([pair], creds);
  const u = unitsPerQty(c);
  const side = (levels) => (levels || []).filter((l) => l.price > 0 && l.quantity > 0).map((l) => [l.price, l.quantity * u]);
  return { c, q, bids: side(q.depth?.buy), asks: side(q.depth?.sell) };
}

// Zerodha charges: brokerage min(Rs 20, 0.03%) + GST, plus small exchange/SEBI/stamp charges (estimate).
export const kiteFee = (turnover) => Math.min(20, turnover * 0.0003) * 1.18 + turnover * 0.0000045;

// ---- Trading client ----
const STATUS = { COMPLETE: 'FILLED', REJECTED: 'REJECTED', CANCELLED: 'CANCELED' }; // anything else is still working -> NEW

function tradingClient(creds) {
  const call = (method, pathname, opts = {}) => kite(method, pathname, { creds, family: 'orders', gap: 120, ...opts });

  async function netPositions() {
    const pos = await call('GET', '/portfolio/positions', { family: 'portfolio', gap: 350 });
    return (pos?.net || []).filter((p) => p.exchange === 'CDS');
  }

  // Contracts held in one direction for a pair, nearest expiry first. side 'long' = quantity > 0, 'short' = < 0.
  async function heldContracts(pair, side = 'long') {
    const list = await contracts(creds);
    return (await netPositions())
      .map((p) => ({ p, c: list.find((c) => c.tradingsymbol === p.tradingsymbol) }))
      .filter(({ p, c }) => c && c.pair === pair && (side === 'short' ? p.quantity < 0 : p.quantity > 0))
      .map(({ p, c }) => ({ c, p, lots: Math.floor(Math.abs(p.quantity) / c.lotSize) }))
      .sort((a, b) => a.c.expiry - b.c.expiry);
  }

  // Closes up to `lots` of the pair's held contracts in one direction (SELL closes longs, BUY covers shorts).
  async function closeHeld(pair, side, lotsWanted, tag) {
    let lotsLeft = lotsWanted;
    const fills = [];
    for (const { c, lots: have } of await heldContracts(pair, side === 'SELL' ? 'long' : 'short')) {
      if (lotsLeft <= 0) break;
      const lots = Math.min(lotsLeft, have);
      if (lots < 1) continue;
      fills.push(await place(c, side, lots, tag));
      lotsLeft -= lots;
    }
    return fills;
  }
  const merge = (fills, side) => {
    const units = fills.reduce((s, f) => s + f.units, 0);
    const gross = fills.reduce((s, f) => s + f.gross, 0);
    const fee = fills.reduce((s, f) => s + f.fee, 0);
    return { orderId: fills.map((f) => f.orderId).join(','), qty: units, price: gross / units, cost: side === 'BUY' ? gross + fee : gross - fee, fee };
  };

  async function orderState(orderId) {
    const hist = await call('GET', `/orders/${orderId}`, { family: 'portfolio', gap: 350 });
    return hist.at(-1);
  }

  // Marketable limit order: a few ticks through the touch, polled until it completes; the rest is cancelled.
  async function place(c, side, lots, tag) {
    const { bids, asks, q } = await orderBook(c.pair, creds);
    const ref = side === 'BUY' ? asks[0]?.[0] ?? q.last_price : bids[0]?.[0] ?? q.last_price;
    if (!(ref > 0)) throw kiteError(`No ${c.pair} price available - is the market open?`, 'KITE');
    const price = roundTick(side === 'BUY' ? ref + 2 * c.tickSize : ref - 2 * c.tickSize, c.tickSize, side === 'BUY' ? 1 : -1);
    const r = await call('POST', '/orders/regular', {
      form: { tradingsymbol: c.tradingsymbol, exchange: 'CDS', transaction_type: side, order_type: 'LIMIT', quantity: lots * c.lotSize, price, product: 'NRML', validity: 'DAY', tag: tag?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
    });
    let st;
    for (let k = 0; k < 10; k++) {
      await sleep(600);
      st = await orderState(r.order_id);
      if (['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) break;
    }
    if (!['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) {
      await call('DELETE', `/orders/regular/${r.order_id}`).catch(() => {});
      st = await orderState(r.order_id);
    }
    const units = (Number(st.filled_quantity) || 0) * unitsPerQty(c);
    if (!units) throw kiteError(`Zerodha order ${st.status.toLowerCase()}: ${st.status_message || 'not filled'}`, 'KITE_ORDER');
    const avg = Number(st.average_price);
    const gross = units * avg;
    return { orderId: r.order_id, units, price: avg, gross, fee: kiteFee(gross), contract: c.tradingsymbol };
  }

  return {
    // Equity = opening balance + intraday pay-in + today's mark-to-market of every position (futures settle daily).
    async fxAccount() {
      const m = await call('GET', '/user/margins/equity', { family: 'portfolio', gap: 350 });
      const allNet = (await call('GET', '/portfolio/positions', { family: 'portfolio', gap: 350 }))?.net || [];
      const list = await contracts(creds);
      const positions = allNet
        .filter((p) => p.exchange === 'CDS')
        .map((p) => ({ p, c: list.find((c) => c.tradingsymbol === p.tradingsymbol) }))
        .filter(({ p, c }) => c && p.quantity !== 0)
        .map(({ p, c }) => ({ pair: c.pair, contract: c.tradingsymbol, expiry: c.expiry, units: p.quantity * unitsPerQty(c), avgPrice: p.average_price, lastPrice: p.last_price, m2m: p.m2m, pnl: p.pnl }));
      const m2m = allNet.reduce((s, p) => s + (Number(p.m2m) || 0), 0); // every segment: the margin account is shared
      const equity = (Number(m.available?.opening_balance) || 0) + (Number(m.available?.intraday_payin) || 0) + m2m;
      return { equity, available: Number(m.net) || 0, positions };
    },
    async getAccount() {
      const a = await this.fxAccount();
      const longs = {};
      a.positions.filter((p) => p.units > 0).forEach((p) => (longs[p.pair] = (longs[p.pair] || 0) + p.units));
      return [{ asset: 'INR', free: a.available, locked: 0 }, ...Object.entries(longs).map(([asset, units]) => ({ asset, free: units, locked: 0 }))];
    },
    // Opening orders (BUY a long, or SELL with short=true) go to the front contract, sized by quoteAmount.
    // Closing orders (SELL a long, BUY with short=true) act only on contracts actually held, never more.
    async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, short = false }) {
      if (!zerodha.marketOpen()) throw kiteError('NSE currency market is closed (Mon-Fri 09:00-17:00 IST)', 'KITE_CLOSED');
      const opening = short ? side === 'SELL' : side === 'BUY';
      if (opening) {
        const c = await frontContract(symbol, creds);
        const { asks, bids, q } = await orderBook(symbol, creds);
        const px = (side === 'BUY' ? asks : bids)[0]?.[0] || q.last_price;
        const lots = Math.floor(quoteAmount / (px * UNITS_PER_LOT * 1.001));
        if (lots < 1) throw kiteError(`Order is smaller than 1 lot of ${symbol} (about Rs ${Math.round(px * UNITS_PER_LOT).toLocaleString('en-IN')} notional)`, 'KITE_SIZE');
        const f = await place(c, side, lots, clientOrderId);
        return { orderId: f.orderId, qty: f.units, price: f.price, cost: side === 'BUY' ? f.gross + f.fee : f.gross - f.fee, fee: f.fee, contract: f.contract, contractExpiry: c.expiry };
      }
      const fills = await closeHeld(symbol, side, Math.floor(quantity / UNITS_PER_LOT + 1e-9), clientOrderId);
      if (!fills.length) throw kiteError(`No ${symbol} ${short ? 'short' : 'long'} futures position to ${short ? 'cover' : 'sell'} on Zerodha`, 'KITE_SIZE');
      return merge(fills, side);
    },
    // Units currently short on the pair (all months).
    async shortUnits(symbol) {
      return (await heldContracts(symbol, 'short')).reduce((s, h) => s + h.lots * UNITS_PER_LOT, 0);
    },
    // Exchange-side stop: an SL (stop-limit) sell on the held contract. Kite orders are DAY orders, so it lapses
    // at the close and the engine re-places it on the next day's first tick.
    // side 'SELL' protects a long (triggers on a fall), side 'BUY' protects a short (triggers on a rise).
    async stopLossOrder({ symbol, quantity, stopPrice, limitPrice, clientOrderId, side = 'SELL' }) {
      if (!zerodha.marketOpen()) throw kiteError('NSE currency market is closed', 'KITE_CLOSED');
      const held = (await heldContracts(symbol, side === 'BUY' ? 'short' : 'long'))[0];
      if (!held) throw kiteError(`No ${symbol} futures position to protect`, 'KITE_SIZE');
      const { c } = held;
      const lots = Math.min(Math.floor(quantity / UNITS_PER_LOT + 1e-9), held.lots);
      if (lots < 1) throw kiteError('Stop size is below one lot', 'KITE_SIZE');
      const up = side === 'BUY';
      const trigger = roundTick(stopPrice, c.tickSize, up ? 1 : -1);
      // Limit a little past the trigger, but inside the exchange price band.
      const price = up ? roundTick(Math.min(limitPrice, trigger * 1.005), c.tickSize, 1) : roundTick(Math.max(limitPrice, trigger * 0.995), c.tickSize, -1);
      const r = await call('POST', '/orders/regular', {
        form: { tradingsymbol: c.tradingsymbol, exchange: 'CDS', transaction_type: side, order_type: 'SL', quantity: lots * c.lotSize, price, trigger_price: trigger, product: 'NRML', validity: 'DAY', tag: clientOrderId?.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) },
      });
      return { orderId: r.order_id, qty: lots * UNITS_PER_LOT, stopPrice: trigger, limitPrice: price };
    },
    async getOrder(_symbol, orderId) {
      const st = await orderState(orderId);
      const c = (await contracts(creds)).find((x) => x.tradingsymbol === st.tradingsymbol);
      const units = (Number(st.filled_quantity) || 0) * (c ? unitsPerQty(c) : UNITS_PER_LOT);
      const gross = units * (Number(st.average_price) || 0);
      const fee = units ? kiteFee(gross) : 0;
      return { orderId, status: STATUS[st.status] || 'NEW', executedQty: units, price: Number(st.average_price) || 0, cost: gross - fee, fee };
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
      const orders = await call('GET', '/orders', { family: 'portfolio', gap: 350 });
      const open = (orders || []).filter((o) => o.exchange === 'CDS' && o.tradingsymbol.startsWith(symbol) && ['OPEN', 'TRIGGER PENDING'].includes(o.status));
      for (const o of open) await call('DELETE', `/orders/regular/${o.order_id}`).catch(() => {});
      return open.length;
    },
  };
}

export const zerodha = {
  id: 'zerodha', name: 'Zerodha (NSE forex)', trading: true, canShort: true, currency: 'INR', market: 'forex', account: 'fx', sessionHours: SESSION_HOURS,
  intervals: Object.keys(IV),
  lotUnits: UNITS_PER_LOT,
  feeFor: kiteFee, // rupee charges for a fill of this turnover
  costs: { feeRate: 0.0003, slippageBps: 0.5, spreadBps: 0.5 }, // per side; used by paper fills, analysis and backtests
  paperSpread: 0.00005,
  marketOpen,
  getKlines: (symbol, interval, limit = 500) => getKlinesDeep(symbol, interval, limit),
  getKlinesDeep,
  async getTickers(symbols = FX_PAIRS) {
    const creds = await marketCreds();
    return (await quotes(symbols.filter((s) => FX_PAIRS.includes(s)), creds)).map(({ c, q }) => {
      const prev = q.ohlc?.close || q.last_price;
      return { symbol: c.pair, price: q.last_price, change: prev ? ((q.last_price - prev) / prev) * 100 : 0, high: q.ohlc?.high, low: q.ohlc?.low, volume: (q.volume || 0) * unitsPerQty(c) * q.last_price, contract: c.tradingsymbol, expiry: c.expiryDate, oi: q.oi };
    });
  },
  async getPrice(symbol) {
    const [{ q }] = await quotes([symbol], await marketCreds());
    return q.last_price;
  },
  async getOrderBook(symbol) {
    const { bids, asks, q } = await orderBook(symbol, await marketCreds());
    if (!bids.length || !asks.length) {
      const p = q.last_price;
      return { bids: bids.length ? bids : [[p * 0.99995, 1e9]], asks: asks.length ? asks : [[p * 1.00005, 1e9]] };
    }
    return { bids, asks };
  },
  async getTrades() {
    throw new Error('Zerodha does not publish a trade tape'); // order flow falls back to depth only
  },
  async getSymbols() {
    let list = [];
    try { list = await contracts(await marketCreds()); } catch { /* not logged in: static info */ }
    return FX_PAIRS.map((pair) => {
      const c = list.filter((x) => x.pair === pair).find((x) => x.expiry - Date.now() > ROLL_DAYS * 86400e3);
      const px = c?.lastPrice || { USDINR: 85, EURINR: 95, GBPINR: 110, JPYINR: 57 }[pair];
      return { symbol: pair, base: pair, quote: 'INR', stepSize: UNITS_PER_LOT, minQty: UNITS_PER_LOT, minNotional: px * UNITS_PER_LOT, tickSize: c?.tickSize || 0.0025, contract: c?.tradingsymbol, expiry: c?.expiry };
    });
  },
  tradingClient,
};
