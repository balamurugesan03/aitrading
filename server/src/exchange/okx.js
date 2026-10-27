// OKX v5 spot adapter (market data + signed spot trading; testnet = OKX demo trading).
import crypto from 'crypto';
import { baseAsset } from '../ai/util.js';

const BASE = 'https://www.okx.com';
const BAR = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W' };
const inst = (symbol) => `${baseAsset(symbol)}-${symbol.slice(baseAsset(symbol).length)}`;
const canon = (instId) => instId.replace('-', '');

async function call(pathname, { method = 'GET', params = {}, body = null, headers = {} } = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${pathname}${qs ? `?${qs}` : ''}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.code !== '0') throw Object.assign(new Error(`OKX: ${j?.msg || j?.data?.[0]?.sMsg || res.status}`), { status: res.status });
  return j.data;
}
const mapCandle = (k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });

export const okx = {
  id: 'okx', name: 'OKX', trading: true, intervals: Object.keys(BAR),
  async getKlines(symbol, interval = '1h', limit = 300) {
    if (!BAR[interval]) throw new Error(`Interval ${interval} not supported on OKX`);
    const rows = await call('/api/v5/market/candles', { params: { instId: inst(symbol), bar: BAR[interval], limit: Math.min(300, limit) } });
    return rows.map(mapCandle).reverse();
  },
  async getKlinesDeep(symbol, interval, total) {
    let out = await this.getKlines(symbol, interval, 300);
    while (out.length < total) {
      const rows = await call('/api/v5/market/history-candles', { params: { instId: inst(symbol), bar: BAR[interval], after: out[0].time * 1000, limit: 100 } });
      if (!rows.length) break;
      out = [...rows.map(mapCandle).reverse(), ...out];
    }
    return out.slice(-total);
  },
  async getTickers(symbols) {
    const rows = await call('/api/v5/market/tickers', { params: { instType: 'SPOT' } });
    const out = rows.map((t) => ({ symbol: canon(t.instId), price: +t.last, change: ((+t.last - +t.open24h) / +t.open24h) * 100, high: +t.high24h, low: +t.low24h, volume: +t.volCcy24h }));
    return symbols ? out.filter((t) => symbols.includes(t.symbol)) : out;
  },
  async getPrice(symbol) {
    const [t] = await call('/api/v5/market/ticker', { params: { instId: inst(symbol) } });
    return +t.last;
  },
  async getOrderBook(symbol, limit = 50) {
    const [b] = await call('/api/v5/market/books', { params: { instId: inst(symbol), sz: Math.min(400, limit) } });
    return { bids: b.bids.map((l) => [+l[0], +l[1]]), asks: b.asks.map((l) => [+l[0], +l[1]]) };
  },
  async getTrades(symbol, limit = 500) {
    const rows = await call('/api/v5/market/trades', { params: { instId: inst(symbol), limit: Math.min(500, limit) } });
    return rows.map((t) => ({ price: +t.px, qty: +t.sz, time: +t.ts, sellAggressor: t.side === 'sell' })).reverse();
  },
  async getSymbols() {
    const rows = await call('/api/v5/public/instruments', { params: { instType: 'SPOT' } });
    return rows.filter((s) => s.state === 'live').map((s) => ({ symbol: canon(s.instId), base: s.baseCcy, quote: s.quoteCcy, stepSize: +s.lotSz, minQty: +s.minSz, minNotional: 1 }));
  },
  tradingClient(creds) {
    const signedCall = (method, pathname, payload = {}) => {
      const ts = new Date().toISOString();
      const isGet = method === 'GET';
      const qs = isGet && Object.keys(payload).length ? `?${new URLSearchParams(payload)}` : '';
      const body = isGet ? '' : JSON.stringify(payload);
      const sign = crypto.createHmac('sha256', creds.apiSecret).update(ts + method + pathname + qs + body).digest('base64');
      const headers = { 'OK-ACCESS-KEY': creds.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': creds.passphrase || '' };
      if (creds.testnet) headers['x-simulated-trading'] = '1';
      return call(pathname, { method, params: isGet ? payload : {}, body: isGet ? null : body, headers });
    };
    return {
      async getAccount() {
        const [r] = await signedCall('GET', '/api/v5/account/balance');
        return (r?.details || []).map((d) => ({ asset: d.ccy, free: +d.availBal, locked: +d.frozenBal })).filter((b) => b.free + b.locked > 0);
      },
      async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId }) {
        const body = { instId: inst(symbol), tdMode: 'cash', side: side.toLowerCase(), ordType: 'market', clOrdId: clientOrderId?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) };
        if (side === 'BUY') { body.sz = (+quoteAmount).toFixed(2); body.tgtCcy = 'quote_ccy'; } else { body.sz = String(+quantity.toFixed(8)); body.tgtCcy = 'base_ccy'; }
        const [o] = await signedCall('POST', '/api/v5/trade/order', body);
        for (let k = 0; k < 6; k++) {
          await new Promise((r) => setTimeout(r, 400));
          const [d] = await signedCall('GET', '/api/v5/trade/order', { instId: inst(symbol), ordId: o.ordId });
          if (d && ['filled', 'canceled'].includes(d.state)) {
            const qty = +d.accFillSz;
            const price = +d.avgPx;
            return { orderId: o.ordId, qty, price, cost: qty * price, fee: Math.abs(+d.fee) * (d.feeCcy === baseAsset(symbol) ? price : 1) };
          }
        }
        throw new Error('OKX order not confirmed in time - check the exchange');
      },
      async cancelOpenOrders(symbol) {
        const pending = await signedCall('GET', '/api/v5/trade/orders-pending', { instId: inst(symbol) });
        if (!pending.length) return [];
        return signedCall('POST', '/api/v5/trade/cancel-batch-orders', pending.map((p) => ({ instId: p.instId, ordId: p.ordId })));
      },
    };
  },
};
