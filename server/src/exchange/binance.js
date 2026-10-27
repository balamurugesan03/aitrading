// Binance Spot REST client. Public market data needs no keys; account/order endpoints are HMAC-signed.
import crypto from 'crypto';
import { config, hasBinanceKeys } from '../config.js';

const LIVE_URL = 'https://api.binance.com';
const TESTNET_URL = 'https://testnet.binance.vision';

const tradeBase = () => config.binance.baseUrl || (config.binance.testnet ? TESTNET_URL : LIVE_URL);
const dataBases = () => [...new Set([config.binance.baseUrl || LIVE_URL, config.binance.dataUrl])];

async function http(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.msg || `Binance HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.code;
    throw err;
  }
  return body;
}

// Public GET with automatic fallback to the market-data mirror.
async function publicGet(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  let lastErr;
  for (const base of dataBases()) {
    try {
      return await http(`${base}${pathname}${qs ? `?${qs}` : ''}`);
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500 && err.status !== 451 && err.status !== 403) throw err;
    }
  }
  throw lastErr;
}

// creds = { apiKey, apiSecret, testnet }. Defaults to the server .env keys (owner account).
const envCreds = () => ({ apiKey: config.binance.apiKey, apiSecret: config.binance.apiSecret, testnet: config.binance.testnet });

async function signed(method, pathname, params = {}, creds = envCreds()) {
  if (!creds?.apiKey || !creds?.apiSecret) throw new Error('No Binance API keys connected. Add them under Account -> API connections.');
  const base = creds.testnet ? TESTNET_URL : config.binance.baseUrl || LIVE_URL;
  const qs = new URLSearchParams({ ...params, recvWindow: 5000, timestamp: Date.now() }).toString();
  const signature = crypto.createHmac('sha256', creds.apiSecret).update(qs).digest('hex');
  return http(`${base}${pathname}?${qs}&signature=${signature}`, {
    method,
    headers: { 'X-MBX-APIKEY': creds.apiKey },
  });
}

export async function getKlines(symbol, interval = '1h', limit = 500) {
  const rows = await publicGet('/api/v3/klines', { symbol, interval, limit });
  return rows.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    takerBuy: +k[9],
  }));
}

// Pages backwards to fetch more than 1000 candles (used by the backtester).
export async function getKlinesDeep(symbol, interval, total) {
  let out = [];
  let endTime;
  while (out.length < total) {
    const params = { symbol, interval, limit: Math.min(1000, total - out.length) };
    if (endTime) params.endTime = endTime;
    const rows = await publicGet('/api/v3/klines', params);
    if (!rows.length) break;
    const batch = rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuy: +k[9] }));
    out = [...batch, ...out];
    endTime = rows[0][0] - 1;
    if (rows.length < params.limit) break;
  }
  return out;
}

export async function getTickers(symbols) {
  const params = symbols ? { symbols: JSON.stringify(symbols) } : {};
  const rows = await publicGet('/api/v3/ticker/24hr', params);
  return rows.map((t) => ({
    symbol: t.symbol,
    price: +t.lastPrice,
    change: +t.priceChangePercent,
    high: +t.highPrice,
    low: +t.lowPrice,
    volume: +t.quoteVolume,
  }));
}

export async function getPrice(symbol) {
  const t = await publicGet('/api/v3/ticker/price', { symbol });
  return +t.price;
}

export async function getOrderBook(symbol, limit = 20) {
  const d = await publicGet('/api/v3/depth', { symbol, limit });
  return {
    bids: d.bids.map(([p, q]) => [+p, +q]),
    asks: d.asks.map(([p, q]) => [+p, +q]),
  };
}

let symbolCache = null;
export async function getSymbols() {
  if (symbolCache) return symbolCache;
  const info = await publicGet('/api/v3/exchangeInfo', { permissions: 'SPOT' });
  symbolCache = info.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => {
      const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const notional = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
      const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        stepSize: lot ? +lot.stepSize : 0.000001,
        minQty: lot ? +lot.minQty : 0,
        minNotional: notional ? +(notional.minNotional ?? notional.notional ?? 0) : 0,
        tickSize: priceFilter ? +priceFilter.tickSize : 0.01,
      };
    });
  return symbolCache;
}

export async function getSymbolInfo(symbol) {
  return (await getSymbols()).find((s) => s.symbol === symbol);
}

const roundStep = (qty, step) => {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return (Math.floor(qty / step) * step).toFixed(decimals);
};

export async function getAccount(creds) {
  const acc = await signed('GET', '/api/v3/account', {}, creds);
  return acc.balances
    .map((b) => ({ asset: b.asset, free: +b.free, locked: +b.locked }))
    .filter((b) => b.free + b.locked > 0);
}

// Recent aggregated trades. isBuyerMaker=true means the aggressor was a seller.
export async function getAggTrades(symbol, limit = 1000) {
  const rows = await publicGet('/api/v3/aggTrades', { symbol, limit });
  return rows.map((t) => ({ price: +t.p, qty: +t.q, time: t.T, sellAggressor: t.m }));
}

export async function ping() {
  const t0 = Date.now();
  await publicGet('/api/v3/ping');
  return Date.now() - t0;
}

export async function cancelOpenOrders(symbol, creds) {
  try {
    return await signed('DELETE', '/api/v3/openOrders', { symbol }, creds);
  } catch (err) {
    if (err.code === -2011) return []; // no open orders
    throw err;
  }
}

// side BUY spends `quoteAmount` (e.g. USDT); side SELL sells `quantity` of base asset.
// clientOrderId makes retries idempotent: Binance rejects a duplicate id instead of filling twice.
// Returns what actually landed in the account, like the paper broker: a BUY's qty is net of any fee paid in
// the coin itself and its cost includes a fee paid in the quote; a SELL's cost is net of the quote fee.
// (Fees paid in BNB come out of the BNB balance and touch neither.)
export async function marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, creds }) {
  const info = await getSymbolInfo(symbol);
  const params = { symbol, side, type: 'MARKET', newOrderRespType: 'FULL' };
  if (clientOrderId) params.newClientOrderId = clientOrderId.slice(0, 36);
  if (side === 'BUY') {
    params.quoteOrderQty = (+quoteAmount).toFixed(2);
  } else {
    params.quantity = roundStep(quantity, info?.stepSize || 0.000001);
  }
  const r = await signed('POST', '/api/v3/order', params, creds);
  const executed = +r.executedQty;
  const gross = +r.cummulativeQuoteQty;
  const { baseFee, quoteFee, fee } = splitFees((r.fills || []).map((f) => ({ commission: +f.commission, commissionAsset: f.commissionAsset })), info);
  return {
    orderId: r.orderId,
    qty: side === 'BUY' ? executed - baseFee : executed,
    price: executed ? gross / executed : 0,
    cost: side === 'BUY' ? gross + quoteFee : gross - quoteFee,
    fee, raw: r,
  };
}

const splitFees = (fills, info) => {
  const sum = (asset) => fills.filter((f) => f.commissionAsset === asset).reduce((s, f) => s + f.commission, 0);
  return { baseFee: info ? sum(info.base) : 0, quoteFee: info ? sum(info.quote) : 0, fee: fills.reduce((s, f) => s + f.commission, 0) };
};

// Exchange-side stop-loss: a resting STOP_LOSS_LIMIT sell that Binance triggers itself, so the position stays
// protected while this server is offline. The limit sits below the trigger so it still fills in a fast drop.
export async function stopLossOrder({ symbol, quantity, stopPrice, limitPrice, clientOrderId, creds }) {
  const info = await getSymbolInfo(symbol);
  const params = {
    symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT', timeInForce: 'GTC',
    quantity: roundStep(quantity, info?.stepSize || 0.000001),
    stopPrice: roundStep(stopPrice, info?.tickSize || 0.01),
    price: roundStep(limitPrice, info?.tickSize || 0.01),
  };
  if (clientOrderId) params.newClientOrderId = clientOrderId.slice(0, 36);
  const r = await signed('POST', '/api/v3/order', params, creds);
  return { orderId: r.orderId, qty: +params.quantity, stopPrice: +params.stopPrice, limitPrice: +params.price };
}

// Order status; for anything that filled, the real fees come from the account's trade list.
export async function getOrder(symbol, orderId, creds) {
  const r = await signed('GET', '/api/v3/order', { symbol, orderId }, creds);
  const executed = +r.executedQty;
  const gross = +r.cummulativeQuoteQty;
  let quoteFee = 0;
  let fee = 0;
  if (executed > 0) {
    const trades = await signed('GET', '/api/v3/myTrades', { symbol, orderId }, creds);
    ({ quoteFee, fee } = splitFees(trades.map((t) => ({ commission: +t.commission, commissionAsset: t.commissionAsset })), await getSymbolInfo(symbol)));
  }
  return { orderId: r.orderId, status: r.status, executedQty: executed, price: executed ? gross / executed : 0, cost: gross - quoteFee, fee };
}

// Returns false when the order no longer exists or is already closed (filled / cancelled).
export async function cancelOrder(symbol, orderId, creds) {
  try {
    await signed('DELETE', '/api/v3/order', { symbol, orderId }, creds);
    return true;
  } catch (err) {
    if (err.code === -2011) return false;
    throw err;
  }
}

export const binanceMode = () => ({
  keys: hasBinanceKeys(),
  testnet: config.binance.testnet,
  tradeUrl: tradeBase(),
});
