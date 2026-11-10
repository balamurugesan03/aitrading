// Exchange-agnostic adapter registry. Strategy, risk and bot code talk only to this interface;
// exchange-specific code lives in each adapter.
import * as bn from './binance.js';
import { bybit } from './bybit.js';
import { okx } from './okx.js';
import { kraken } from './kraken.js';
import { coinbase } from './coinbase.js';
import { zerodha } from './zerodha.js';
import { nse } from './nse.js';
import { nfo } from './nfo.js';
import { nfut } from './nfut.js';
import { bperp } from './bperp.js';
import { db } from '../db/index.js';
import { decrypt } from '../auth/crypto.js';
import { config } from '../config.js';

const binance = {
  id: 'binance', name: 'Binance', trading: true,
  intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'],
  getKlines: bn.getKlines,
  getKlinesDeep: bn.getKlinesDeep,
  getTickers: bn.getTickers,
  getPrice: bn.getPrice,
  getOrderBook: bn.getOrderBook,
  getTrades: (symbol, limit) => bn.getAggTrades(symbol, limit),
  getSymbols: bn.getSymbols,
  tradingClient: (creds) => ({
    getAccount: () => bn.getAccount(creds),
    marketOrder: (o) => bn.marketOrder({ ...o, creds }),
    cancelOpenOrders: (symbol) => bn.cancelOpenOrders(symbol, creds),
    // Exchange-side stop-loss (the engine falls back to a bot-side stop on adapters without these).
    stopLossOrder: (o) => bn.stopLossOrder({ ...o, creds }),
    getOrder: (symbol, orderId) => bn.getOrder(symbol, orderId, creds),
    cancelOrder: (symbol, orderId) => bn.cancelOrder(symbol, orderId, creds),
  }),
};

export const EXCHANGES = { binance, bybit, okx, kraken, coinbase, zerodha, nse, nfo, nfut, bperp };

// INR-quoted adapters (NSE forex, stocks and futures) are valued in rupees, separately from the USDT crypto account.
export const isFx = (id) => EXCHANGES[id]?.currency === 'INR';
// Margin accounts (futures): a position blocks marginRate x notional instead of its full notional.
export const isMargin = (id) => Boolean(EXCHANGES[id]?.margin);
// Perpetuals: margin rate = 1 / leverage (the bot's leverage); NSE futures: the exchange margin share.
export const marginRateFor = (id, symbol, info, leverage) => info?.marginRate ?? EXCHANGES[id]?.marginRateOf?.(symbol, leverage) ?? 1;
// Units per lot for lot-traded adapters: a per-contract lot (futures) or one fixed lot (forex 1,000 units, stocks 1 share).
export const lotOf = async (id, symbol) => (EXCHANGES[id]?.lotFor ? EXCHANGES[id].lotFor(symbol) : EXCHANGES[id]?.lotUnits);
// Separate accounts (wallet, equity, drawdown, P&L): 'crypto' (every crypto exchange), 'fx' (NSE forex), 'stocks' (NSE stocks),
// 'futures' (NSE index and stock futures, a margin account), 'perps' (Binance USD-M perpetuals, a leveraged USDT margin account).
export const accountOf = (id) => EXCHANGES[id || 'binance']?.account || 'crypto';
export const EXCHANGE_IDS = Object.keys(EXCHANGES);

export function ex(id = 'binance') {
  const e = EXCHANGES[id || 'binance'];
  if (!e) throw Object.assign(new Error(`Unknown exchange ${id}`), { status: 400 });
  return e;
}

export const listExchanges = () => Object.values(EXCHANGES).map((e) => ({ id: e.id, name: e.name, trading: e.trading, intervals: e.intervals, currency: e.currency || 'USDT', market: e.market || 'crypto', account: e.account || 'crypto', connection: e.connection || null, canShort: Boolean(e.canShort), margin: Boolean(e.margin), perp: Boolean(e.perp), maxLeverage: e.maxLeverage || null, defaultLeverage: e.defaultLeverage || null }));

const symCache = new Map();
export async function symbolInfo(exchangeId, symbol) {
  const key = exchangeId || 'binance';
  const hit = symCache.get(key);
  // Refreshed hourly: futures adapters roll to a new contract month.
  if (!hit || Date.now() - hit.at > 3600e3) symCache.set(key, { at: Date.now(), list: ex(key).getSymbols().catch(() => []) });
  const list = await symCache.get(key).list;
  return list.find((s) => s.symbol === symbol) || null;
}

// Decrypted trading credentials for a user on an exchange (owner falls back to the .env Binance keys).
export async function credsFor(user, exchangeId = 'binance') {
  // Adapters that share a broker login (NSE stocks uses the Zerodha connection) look up that connection.
  const conn = await db.apiConnections.findOne({ userId: user._id, exchange: EXCHANGES[exchangeId]?.connection || exchangeId, active: true });
  if (conn) {
    return {
      apiKey: decrypt(conn.apiKey), apiSecret: decrypt(conn.apiSecret),
      passphrase: conn.passphrase ? decrypt(conn.passphrase) : undefined, testnet: Boolean(conn.testnet), connectionId: conn._id,
      accessToken: conn.accessToken ? decrypt(conn.accessToken) : undefined, sessionAt: conn.sessionAt || null, // Kite daily session
    };
  }
  if (user.role === 'admin' && exchangeId === 'binance' && config.binance.apiKey && config.binance.apiSecret) {
    return { apiKey: config.binance.apiKey, apiSecret: config.binance.apiSecret, testnet: config.binance.testnet, fromEnv: true };
  }
  const bf = config.binanceFutures;
  if (user.role === 'admin' && exchangeId === 'bperp' && bf.apiKey && bf.apiSecret) {
    return { apiKey: bf.apiKey, apiSecret: bf.apiSecret, testnet: bf.testnet, fromEnv: true };
  }
  return null;
}

export async function tradingFor(user, exchangeId = 'binance') {
  const e = ex(exchangeId);
  if (!e.trading) throw Object.assign(new Error(`${e.name} live trading is not supported yet - use paper mode`), { status: 400 });
  const creds = await credsFor(user, exchangeId);
  if (!creds) throw Object.assign(new Error(`No ${e.name} API keys connected. Add them under Account -> API connections.`), { status: 400 });
  return { client: e.tradingClient(creds), creds };
}

// Fetches `n` closed+forming candles from any exchange (pages through history where the API caps a request).
export async function fetchCandles(exchangeId, symbol, interval, n = 500) {
  const e = ex(exchangeId);
  if (!e.intervals.includes(interval)) throw Object.assign(new Error(`${e.name} does not support the ${interval} timeframe`), { status: 400 });
  return e.id === 'binance' || e.id === 'bybit' ? e.getKlines(symbol, interval, Math.min(1000, n)) : e.getKlinesDeep(symbol, interval, n);
}
