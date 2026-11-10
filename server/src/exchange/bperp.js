// Binance USD-M perpetual futures (USDT-margined): market data, paper trading and live trading.
//
// How it maps onto the engine:
// - A symbol is the perpetual ("BTCUSDT"); its account asset is the symbol itself, so perp positions never mix
//   with spot coins. The perps account is separate from the spot crypto account (own equity, drawdown, P&L).
// - MARGIN account with leverage: a position blocks notional / leverage. Leverage is per bot (default 2x,
//   hard cap MAX_LEVERAGE), always ISOLATED margin, one-way position mode. Long and short.
// - Opening orders are MARKET orders sized by notional; closing orders are reduce-only, so a close can never
//   flip the position. The exchange-side stop is a reduce-only STOP_MARKET triggered on the MARK price
//   (what Binance liquidates on), so it survives this server being offline.
// - Funding is paid/received every 8 hours on Binance itself; paper accounts settle the real funding rates.
// - Liquidation: live, Binance liquidates. Paper, the broker liquidates at the isolated liquidation price
//   (losing the position's margin) when the mark price crosses it. The risk engine refuses entries whose stop
//   is not well inside the liquidation distance.
import crypto from 'crypto';
import { config } from '../config.js';
import { relayHeaders } from './binance.js';
import { fapiGet, FAPI_BASE } from './binanceFutures.js';

export const MAX_LEVERAGE = 5;
export const DEFAULT_LEVERAGE = 2;
export const TAKER_FEE = 0.0005; // Binance USD-M default taker fee (VIP 0)
const TESTNET_URL = () => process.env.BINANCE_FUTURES_TESTNET_URL || 'https://testnet.binancefuture.com';
export const clampLeverage = (lev) => Math.min(MAX_LEVERAGE, Math.max(1, Math.round(Number(lev) || DEFAULT_LEVERAGE)));

// Maintenance margin rate (first notional tier). Conservative: a higher rate puts the paper liquidation price
// closer, never further, than Binance would. Live positions use the liquidation price Binance reports.
const MMR = { BTCUSDT: 0.004, ETHUSDT: 0.005 };
export const mmrOf = (symbol) => MMR[symbol] ?? 0.01;

// Isolated, one-way liquidation price for a position opened at `entry` with leverage `lev`
// (wallet margin = notional / lev; liquidation when equity falls to maintenance margin).
export function liquidationPrice(entry, lev, side, symbol) {
  const mmr = mmrOf(symbol);
  return side === 'short' ? (entry * (1 + 1 / lev)) / (1 + mmr) : (entry * (1 - 1 / lev)) / (1 - mmr);
}
// Distance from entry to liquidation as a % of price.
export const liquidationDistancePct = (lev, side, symbol) => Math.abs(liquidationPrice(1, lev, side, symbol) - 1) * 100;

const roundStep = (qty, step) => {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return +(Math.floor(qty / step + 1e-9) * step).toFixed(decimals);
};
const fmtStep = (v, step) => v.toFixed(Math.max(0, Math.round(-Math.log10(step))));

// ---- Public market data ----
let symbolCache = null;
async function symbols() {
  if (symbolCache && Date.now() - symbolCache.at < 3600e3) return symbolCache.list;
  const info = await fapiGet('/fapi/v1/exchangeInfo');
  const list = info.symbols
    .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .map((s) => {
      const f = (t) => s.filters.find((x) => x.filterType === t);
      const lot = f('MARKET_LOT_SIZE') || f('LOT_SIZE');
      return {
        symbol: s.symbol, base: s.symbol, quote: 'USDT', coin: s.baseAsset,
        stepSize: +(lot?.stepSize || 0.001), minQty: +(lot?.minQty || 0), maxQty: +(lot?.maxQty || Infinity),
        minNotional: +(f('MIN_NOTIONAL')?.notional || 5), tickSize: +(f('PRICE_FILTER')?.tickSize || 0.01),
      };
    });
  symbolCache = { at: Date.now(), list };
  return list;
}
export const symbolOf = async (symbol) => (await symbols()).find((s) => s.symbol === symbol) || null;

export async function getMarkPrice(symbol) {
  const p = await fapiGet('/fapi/v1/premiumIndex', { symbol });
  return { mark: +p.markPrice, index: +p.indexPrice, fundingRate: +p.lastFundingRate, nextFundingTime: +p.nextFundingTime };
}

// Funding events after `sinceMs` ({ time, rate, markPrice }), oldest first.
export async function fundingSince(symbol, sinceMs) {
  const rows = await fapiGet('/fapi/v1/fundingRate', { symbol, startTime: Math.floor(sinceMs) + 1, limit: 100 });
  return (rows || []).map((r) => ({ time: +r.fundingTime, rate: +r.fundingRate, markPrice: +r.markPrice || 0 })).filter((r) => r.time > sinceMs);
}

const kline = (k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuy: +k[9] });
async function getKlinesDeep(symbol, interval = '1h', total = 500) {
  let out = [];
  let endTime;
  while (out.length < total) {
    const params = { symbol, interval, limit: Math.min(1500, total - out.length) };
    if (endTime) params.endTime = endTime;
    const rows = await fapiGet('/fapi/v1/klines', params);
    if (!rows.length) break;
    out = [...rows.map(kline), ...out];
    endTime = rows[0][0] - 1;
    if (rows.length < params.limit) break;
  }
  return out;
}

// ---- Signed trading ----
function tradingClient(creds) {
  const base = () => (creds.testnet ? TESTNET_URL() : FAPI_BASE());
  async function signed(method, pathname, params = {}) {
    if (!creds?.apiKey || !creds?.apiSecret) throw new Error('No Binance Futures API keys connected. Add them under Account -> Exchange connections.');
    const qs = new URLSearchParams({ ...params, recvWindow: 5000, timestamp: Date.now() }).toString();
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(qs).digest('hex');
    const url = `${base()}${pathname}?${qs}&signature=${signature}`;
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': creds.apiKey, ...relayHeaders(url) }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok || (body && body.code && body.code < 0 && body.code !== 200)) {
      const err = new Error(`Binance Futures: ${body?.msg || `HTTP ${res.status}`}`);
      err.status = res.status === 401 ? 400 : res.status; // never 401: that signs the app user out
      err.code = body?.code;
      throw err;
    }
    return body;
  }

  // Mark price from the venue the order goes to (testnet prices drift from mainnet).
  async function markOf(symbol) {
    if (!creds.testnet) return (await getMarkPrice(symbol)).mark;
    const res = await fetch(`${base()}/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(10000) });
    const p = await res.json();
    if (!(+p?.markPrice > 0)) throw new Error(`Binance Futures testnet: no mark price for ${symbol}`);
    return +p.markPrice;
  }

  const positionRisk = async (symbol) => (await signed('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {})).filter((p) => !symbol || p.symbol === symbol);
  const positionAmt = async (symbol) => (await positionRisk(symbol)).reduce((s, p) => s + +p.positionAmt, 0);

  // One-way mode, isolated margin and the bot's leverage, set once per symbol and leverage.
  const prepared = new Map();
  async function prepare(symbol, lev) {
    if (prepared.get(symbol) === lev) return;
    if (!prepared.has('mode')) {
      const m = await signed('GET', '/fapi/v1/positionSide/dual');
      if (m?.dualSidePosition) throw new Error('Binance Futures is in Hedge mode - switch it to One-way mode (Futures > Preferences > Position mode)');
      prepared.set('mode', true);
    }
    try {
      await signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (err) {
      if (err.code !== -4046) throw err; // -4046: already isolated
    }
    await signed('POST', '/fapi/v1/leverage', { symbol, leverage: lev });
    prepared.set(symbol, lev);
  }

  async function fees(symbol, orderId, gross) {
    try {
      const trades = await signed('GET', '/fapi/v1/userTrades', { symbol, orderId });
      if (trades?.length) return trades.reduce((s, t) => s + (t.commissionAsset === 'USDT' ? +t.commission : 0), 0);
    } catch { /* fall back to the fee schedule */ }
    return gross * TAKER_FEE;
  }

  async function filled(symbol, r, side) {
    let o = r;
    for (let k = 0; k < 5 && o.status !== 'FILLED' && +o.executedQty === 0; k++) {
      await new Promise((ok) => setTimeout(ok, 400));
      o = await signed('GET', '/fapi/v1/order', { symbol, orderId: r.orderId });
    }
    const qty = +o.executedQty;
    if (!qty) throw new Error(`Binance Futures order ${String(o.status).toLowerCase()}: not filled`);
    const gross = +o.cumQuote || qty * +o.avgPrice;
    const fee = await fees(symbol, o.orderId, gross);
    return { orderId: o.orderId, qty, price: gross / qty, gross, fee, cost: side === 'BUY' ? gross + fee : gross - fee };
  }

  // Conditional (stop) orders moved to Binance's Algo order service; older accounts still take them on /order.
  async function placeStop(params) {
    try {
      const r = await signed('POST', '/fapi/v1/order', params);
      return String(r.orderId);
    } catch (err) {
      if (err.code !== -4120 && !/algo/i.test(err.message)) throw err;
      const { type, side, symbol, quantity, stopPrice, workingType, newClientOrderId } = params;
      const r = await signed('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol, side, type, quantity, triggerPrice: stopPrice, workingType, reduceOnly: 'true', priceProtect: 'TRUE',
        ...(newClientOrderId && { clientAlgoId: newClientOrderId }),
      });
      return `algo:${r.algoId}`;
    }
  }

  return {
    async positionInfo(symbol) {
      const [p] = await positionRisk(symbol);
      return p ? { qty: +p.positionAmt, entry: +p.entryPrice, liqPrice: +p.liquidationPrice || null, leverage: +p.leverage, mark: +p.markPrice, isolatedMargin: +p.isolatedMargin } : null;
    },
    // Margin account view (same shape as the NSE futures account): equity = wallet + unrealised P&L.
    async fxAccount() {
      const [a, pos] = await Promise.all([signed('GET', '/fapi/v2/account'), positionRisk()]);
      const open = pos.filter((p) => +p.positionAmt !== 0);
      const positions = open.map((p) => ({
        pair: p.symbol, contract: null, units: +p.positionAmt, avgPrice: +p.entryPrice, lastPrice: +p.markPrice, pnl: +p.unRealizedProfit,
        liqPrice: +p.liquidationPrice || null, leverage: +p.leverage,
        margin: +p.isolatedMargin > 0 ? +p.isolatedMargin : Math.abs(+p.notional) / (+p.leverage || 1),
      }));
      const marginUsed = open.reduce((s, p) => s + (+p.isolatedMargin > 0 ? +p.isolatedMargin : Math.abs(+p.notional) / (+p.leverage || 1)), 0);
      return { equity: +a.totalMarginBalance, available: +a.availableBalance, marginUsed, positions };
    },
    async getAccount() {
      const a = await this.fxAccount();
      return [{ asset: 'USDT', free: a.available, locked: 0 }, ...a.positions.filter((p) => p.units > 0).map((p) => ({ asset: p.pair, free: p.units, locked: 0 }))];
    },
    // Opening (BUY a long / SELL with short=true): market order for quoteAmount of notional at `leverage`.
    // Closing (SELL a long / BUY with short=true): reduce-only, never more than the open position.
    async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, short = false, leverage }) {
      const info = await symbolOf(symbol);
      if (!info) throw new Error(`${symbol} is not a Binance USD-M perpetual`);
      const opening = short ? side === 'SELL' : side === 'BUY';
      const params = { symbol, side, type: 'MARKET', newOrderRespType: 'RESULT' };
      if (clientOrderId) params.newClientOrderId = clientOrderId.slice(0, 36);
      if (opening) {
        const lev = clampLeverage(leverage);
        const held = await positionAmt(symbol);
        if (short ? held > 0 : held < 0) throw new Error(`Close the ${symbol} ${held > 0 ? 'long' : 'short'} before opening a ${short ? 'short' : 'long'}`);
        await prepare(symbol, lev);
        const mark = await markOf(symbol);
        const qty = roundStep(quoteAmount / mark, info.stepSize);
        if (!(qty >= info.minQty) || qty * mark < info.minNotional) throw new Error(`Order is below the ${symbol} minimum (${info.minNotional} USDT notional)`);
        const a = await signed('GET', '/fapi/v2/account');
        const need = (qty * mark) / lev + qty * mark * TAKER_FEE;
        if (need > +a.availableBalance) throw new Error(`Not enough futures margin: needs ${need.toFixed(2)} USDT at ${lev}x, available ${(+a.availableBalance).toFixed(2)} USDT`);
        params.quantity = fmtStep(qty, info.stepSize);
        const f = await filled(symbol, await signed('POST', '/fapi/v1/order', params), side);
        const p = await this.positionInfo(symbol).catch(() => null);
        return { ...f, leverage: lev, liqPrice: p?.liqPrice || liquidationPrice(f.price, lev, short ? 'short' : 'long', symbol) };
      }
      const held = await positionAmt(symbol);
      const have = short ? Math.max(0, -held) : Math.max(0, held);
      const qty = roundStep(Math.min(quantity, have), info.stepSize);
      if (!(qty > 0)) throw new Error(`No ${symbol} ${short ? 'short' : 'long'} futures position to ${short ? 'cover' : 'sell'} on Binance`);
      params.quantity = fmtStep(qty, info.stepSize);
      params.reduceOnly = 'true';
      return filled(symbol, await signed('POST', '/fapi/v1/order', params), side);
    },
    async shortUnits(symbol) {
      return Math.max(0, -(await positionAmt(symbol)));
    },
    // Reduce-only STOP_MARKET on the mark price. side 'SELL' protects a long, 'BUY' protects a short.
    async stopLossOrder({ symbol, quantity, stopPrice, clientOrderId, side = 'SELL' }) {
      const info = await symbolOf(symbol);
      const qty = roundStep(quantity, info.stepSize);
      const stop = side === 'BUY' ? Math.ceil(stopPrice / info.tickSize) * info.tickSize : Math.floor(stopPrice / info.tickSize) * info.tickSize;
      const orderId = await placeStop({
        symbol, side, type: 'STOP_MARKET', quantity: fmtStep(qty, info.stepSize), stopPrice: fmtStep(stop, info.tickSize),
        workingType: 'MARK_PRICE', reduceOnly: 'true', priceProtect: 'TRUE', ...(clientOrderId && { newClientOrderId: clientOrderId.slice(0, 36) }),
      });
      return { orderId, qty, stopPrice: +fmtStep(stop, info.tickSize), limitPrice: +fmtStep(stop, info.tickSize) };
    },
    async getOrder(symbol, orderId) {
      let id = String(orderId);
      if (id.startsWith('algo:')) {
        const a = await signed('GET', '/fapi/v1/algoOrder', { algoId: id.slice(5) });
        const actual = a?.actualOrderId && +a.actualOrderId > 0 ? String(a.actualOrderId) : null;
        if (!actual) return { orderId, status: /CANCEL|EXPIRE|REJECT/i.test(a?.algoStatus || '') ? 'CANCELED' : 'NEW', executedQty: 0, price: 0, cost: 0, fee: 0 };
        id = actual;
      }
      const o = await signed('GET', '/fapi/v1/order', { symbol, orderId: id });
      const qty = +o.executedQty;
      const gross = +o.cumQuote || qty * +o.avgPrice;
      const fee = qty ? await fees(symbol, o.orderId, gross) : 0;
      return { orderId, status: o.status === 'EXPIRED' ? 'CANCELED' : o.status, executedQty: qty, price: qty ? gross / qty : 0, cost: o.side === 'BUY' ? gross + fee : gross - fee, fee };
    },
    async cancelOrder(symbol, orderId) {
      try {
        const id = String(orderId);
        if (id.startsWith('algo:')) await signed('DELETE', '/fapi/v1/algoOrder', { algoId: id.slice(5) });
        else await signed('DELETE', '/fapi/v1/order', { symbol, orderId: id });
        return true;
      } catch (err) {
        if (err.code === -2011 || err.code === -2013 || /unknown order|not exist|not found/i.test(err.message)) return false;
        throw err;
      }
    },
    async cancelOpenOrders(symbol) {
      await signed('DELETE', '/fapi/v1/allOpenOrders', { symbol }).catch(() => {});
      await signed('DELETE', '/fapi/v1/algoOpenOrders', { symbol }).catch(() => {});
      return 0;
    },
  };
}

export const bperp = {
  id: 'bperp', name: 'Binance (USD-M futures)', trading: true, canShort: true, currency: 'USDT', market: 'perps', account: 'perps',
  intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'],
  margin: true, perp: true,
  maxLeverage: MAX_LEVERAGE, defaultLeverage: DEFAULT_LEVERAGE,
  marginRateOf: (_symbol, leverage) => 1 / clampLeverage(leverage),
  mmrOf, liquidationPrice, liquidationDistancePct, clampLeverage,
  feeFor: (turnover) => turnover * TAKER_FEE,
  costs: { feeRate: TAKER_FEE, slippageBps: 2, spreadBps: 1 },
  paperSpread: 0.0001,
  getMarkPrice, fundingSince,
  getKlines: (symbol, interval, limit = 500) => getKlinesDeep(symbol, interval, limit),
  getKlinesDeep,
  async getTickers(list) {
    const rows = await fapiGet('/fapi/v1/ticker/24hr');
    const want = list ? new Set(list) : null;
    return rows.filter((t) => !want || want.has(t.symbol)).map((t) => ({
      symbol: t.symbol, price: +t.lastPrice, change: +t.priceChangePercent, high: +t.highPrice, low: +t.lowPrice, volume: +t.quoteVolume,
    }));
  },
  async getPrice(symbol) {
    return +(await fapiGet('/fapi/v1/ticker/price', { symbol })).price;
  },
  async getOrderBook(symbol, limit = 20) {
    const ok = [5, 10, 20, 50, 100, 500, 1000];
    const d = await fapiGet('/fapi/v1/depth', { symbol, limit: ok.find((x) => x >= limit) || 100 });
    return { bids: d.bids.map(([p, q]) => [+p, +q]), asks: d.asks.map(([p, q]) => [+p, +q]) };
  },
  async getTrades(symbol, limit = 1000) {
    const rows = await fapiGet('/fapi/v1/aggTrades', { symbol, limit });
    return rows.map((t) => ({ price: +t.p, qty: +t.q, time: t.T, sellAggressor: t.m }));
  },
  getSymbols: symbols,
  tradingClient,
};
