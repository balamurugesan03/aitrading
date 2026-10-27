// Kraken adapter (public market data; trading not yet supported).
import { baseAsset } from '../ai/util.js';

const BASE = 'https://api.kraken.com';
const MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };
const ALIAS = { BTC: 'XBT', DOGE: 'XDG' };
const pair = (symbol) => { const b = baseAsset(symbol); return `${ALIAS[b] || b}${symbol.slice(b.length)}`; };

async function pub(pathname, params) {
  const res = await fetch(`${BASE}${pathname}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.error?.length) throw new Error(`Kraken: ${j?.error?.join(', ') || res.status}`);
  const key = Object.keys(j.result).find((k) => k !== 'last');
  return { data: j.result[key], all: j.result };
}

export const kraken = {
  id: 'kraken', name: 'Kraken', trading: false, intervals: Object.keys(MIN),
  async getKlines(symbol, interval = '1h', limit = 500) {
    if (!MIN[interval]) throw new Error(`Interval ${interval} not supported on Kraken`);
    const { data } = await pub('/0/public/OHLC', { pair: pair(symbol), interval: MIN[interval] });
    return data.map((k) => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[6] })).slice(-limit);
  },
  async getKlinesDeep(symbol, interval, total) {
    return this.getKlines(symbol, interval, total); // Kraken serves the latest 720 candles only
  },
  async getTickers(symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT']) {
    const { all } = await pub('/0/public/Ticker', { pair: symbols.map(pair).join(',') });
    return symbols.map((s) => {
      const t = all[pair(s)] || Object.entries(all).find(([k]) => k.includes(pair(s).slice(0, 3)))?.[1];
      if (!t) return null;
      const last = +t.c[0];
      return { symbol: s, price: last, change: ((last - +t.o) / +t.o) * 100, high: +t.h[1], low: +t.l[1], volume: +t.v[1] * last };
    }).filter(Boolean);
  },
  async getPrice(symbol) {
    const { data } = await pub('/0/public/Ticker', { pair: pair(symbol) });
    return +data.c[0];
  },
  async getOrderBook(symbol, limit = 100) {
    const { data } = await pub('/0/public/Depth', { pair: pair(symbol), count: Math.min(500, limit) });
    return { bids: data.bids.map((l) => [+l[0], +l[1]]), asks: data.asks.map((l) => [+l[0], +l[1]]) };
  },
  async getTrades(symbol) {
    const { data } = await pub('/0/public/Trades', { pair: pair(symbol) });
    return data.map((t) => ({ price: +t[0], qty: +t[1], time: Math.floor(+t[2] * 1000), sellAggressor: t[3] === 's' }));
  },
  async getSymbols() {
    return ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'LINK', 'LTC', 'AVAX'].map((b) => ({ symbol: `${b}USDT`, base: b, quote: 'USDT', stepSize: 0.00000001, minQty: 0, minNotional: 5 }));
  },
};
