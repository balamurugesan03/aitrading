// Coinbase Exchange adapter (public market data; trading not yet supported).
import { baseAsset } from '../ai/util.js';

const BASE = 'https://api.exchange.coinbase.com';
const GRAN = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
const productCache = new Map();

async function get(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${pathname}${qs ? `?${qs}` : ''}`, { headers: { 'User-Agent': 'VelocityX-AI' }, signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`Coinbase: ${j?.message || res.status}`), { status: res.status });
  return j;
}

// Prefers the USDT market, falls back to USD.
async function product(symbol) {
  if (productCache.has(symbol)) return productCache.get(symbol);
  const b = baseAsset(symbol);
  for (const id of [`${b}-USDT`, `${b}-USD`]) {
    try {
      await get(`/products/${id}`);
      productCache.set(symbol, id);
      return id;
    } catch { /* try next */ }
  }
  throw new Error(`Coinbase has no ${b}-USDT or ${b}-USD market`);
}

const mapCandle = (k) => ({ time: k[0], low: k[1], high: k[2], open: k[3], close: k[4], volume: k[5] });

export const coinbase = {
  id: 'coinbase', name: 'Coinbase', trading: false, intervals: Object.keys(GRAN),
  async getKlines(symbol, interval = '1h', limit = 300) {
    if (!GRAN[interval]) throw new Error(`Interval ${interval} not supported on Coinbase`);
    if (limit > 300) return this.getKlinesDeep(symbol, interval, limit);
    const rows = await get(`/products/${await product(symbol)}/candles`, { granularity: GRAN[interval] });
    return rows.map(mapCandle).reverse().slice(-limit);
  },
  async getKlinesDeep(symbol, interval, total) {
    const id = await product(symbol);
    const g = GRAN[interval];
    let end = Math.floor(Date.now() / 1000);
    let out = [];
    while (out.length < total) {
      const start = end - g * 300;
      const rows = await get(`/products/${id}/candles`, { granularity: g, start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() });
      if (!rows.length) break;
      out = [...rows.map(mapCandle).reverse(), ...out];
      end = start;
    }
    return [...new Map(out.map((c) => [c.time, c])).values()].sort((a, b) => a.time - b.time).slice(-total);
  },
  async getTickers(symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT']) {
    const rows = await Promise.all(symbols.map(async (s) => {
      try {
        const st = await get(`/products/${await product(s)}/stats`);
        return { symbol: s, price: +st.last, change: ((+st.last - +st.open) / +st.open) * 100, high: +st.high, low: +st.low, volume: +st.volume * +st.last };
      } catch {
        return null;
      }
    }));
    return rows.filter(Boolean);
  },
  async getPrice(symbol) {
    return +(await get(`/products/${await product(symbol)}/ticker`)).price;
  },
  async getOrderBook(symbol, limit = 50) {
    const b = await get(`/products/${await product(symbol)}/book`, { level: 2 });
    return { bids: b.bids.slice(0, limit).map((l) => [+l[0], +l[1]]), asks: b.asks.slice(0, limit).map((l) => [+l[0], +l[1]]) };
  },
  async getTrades(symbol) {
    const rows = await get(`/products/${await product(symbol)}/trades`, { limit: 1000 });
    // Coinbase reports the MAKER side: a "buy" maker means the aggressor sold.
    return rows.map((t) => ({ price: +t.price, qty: +t.size, time: Date.parse(t.time), sellAggressor: t.side === 'buy' })).reverse();
  },
  async getSymbols() {
    const rows = await get('/products');
    return rows.filter((p) => ['USDT', 'USD'].includes(p.quote_currency) && !p.trading_disabled)
      .map((p) => ({ symbol: `${p.base_currency}USDT`, base: p.base_currency, quote: 'USDT', stepSize: +p.base_increment, minQty: 0, minNotional: +(p.min_market_funds || 1) }));
  },
};
