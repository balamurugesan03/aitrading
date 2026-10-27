// Bybit v5 spot adapter (market data + signed spot trading).
import crypto from 'crypto';

const LIVE = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';
const IV = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' };

async function call(base, pathname, { method = 'GET', params = {}, body = null, headers = {} } = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}${pathname}${qs ? `?${qs}` : ''}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.retCode !== 0) throw Object.assign(new Error(`Bybit: ${j?.retMsg || res.status}`), { status: res.status });
  return j.result;
}
const pub = (p, params) => call(LIVE, p, { params });

const mapCandle = (k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });

export const bybit = {
  id: 'bybit', name: 'Bybit', trading: true, intervals: Object.keys(IV),
  async getKlines(symbol, interval = '1h', limit = 500) {
    if (!IV[interval]) throw new Error(`Interval ${interval} not supported on Bybit`);
    const r = await pub('/v5/market/kline', { category: 'spot', symbol, interval: IV[interval], limit: Math.min(1000, limit) });
    return r.list.map(mapCandle).reverse();
  },
  async getKlinesDeep(symbol, interval, total) {
    let out = [];
    let end;
    while (out.length < total) {
      const params = { category: 'spot', symbol, interval: IV[interval], limit: Math.min(1000, total - out.length) };
      if (end) params.end = end;
      const r = await pub('/v5/market/kline', params);
      if (!r.list.length) break;
      const batch = r.list.map(mapCandle).reverse();
      out = [...batch, ...out];
      end = batch[0].time * 1000 - 1;
      if (r.list.length < params.limit) break;
    }
    return out;
  },
  async getTickers(symbols) {
    const r = await pub('/v5/market/tickers', { category: 'spot' });
    const rows = r.list.map((t) => ({ symbol: t.symbol, price: +t.lastPrice, change: +t.price24hPcnt * 100, high: +t.highPrice24h, low: +t.lowPrice24h, volume: +t.turnover24h }));
    return symbols ? rows.filter((t) => symbols.includes(t.symbol)) : rows;
  },
  async getPrice(symbol) {
    const r = await pub('/v5/market/tickers', { category: 'spot', symbol });
    return +r.list[0].lastPrice;
  },
  async getOrderBook(symbol, limit = 50) {
    const r = await pub('/v5/market/orderbook', { category: 'spot', symbol, limit: Math.min(200, limit) });
    return { bids: r.b.map(([p, q]) => [+p, +q]), asks: r.a.map(([p, q]) => [+p, +q]) };
  },
  async getTrades(symbol, limit = 1000) {
    const r = await pub('/v5/market/recent-trade', { category: 'spot', symbol, limit: Math.min(1000, limit) });
    return r.list.map((t) => ({ price: +t.price, qty: +t.size, time: +t.time, sellAggressor: t.side === 'Sell' })).reverse();
  },
  async getSymbols() {
    const r = await pub('/v5/market/instruments-info', { category: 'spot' });
    return r.list.filter((s) => s.status === 'Trading').map((s) => ({
      symbol: s.symbol, base: s.baseCoin, quote: s.quoteCoin,
      stepSize: +s.lotSizeFilter.basePrecision, minQty: +s.lotSizeFilter.minOrderQty, minNotional: +(s.lotSizeFilter.minOrderAmt || 1),
    }));
  },
  tradingClient(creds) {
    const base = creds.testnet ? TESTNET : LIVE;
    const signedCall = (method, pathname, payload = {}) => {
      const ts = Date.now().toString();
      const recv = '5000';
      const isGet = method === 'GET';
      const qs = isGet ? new URLSearchParams(payload).toString() : '';
      const body = isGet ? '' : JSON.stringify(payload);
      const sign = crypto.createHmac('sha256', creds.apiSecret).update(ts + creds.apiKey + recv + (isGet ? qs : body)).digest('hex');
      return call(base, pathname, {
        method, params: isGet ? payload : {}, body: isGet ? null : body,
        headers: { 'X-BAPI-API-KEY': creds.apiKey, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN': sign },
      });
    };
    return {
      async getAccount() {
        const r = await signedCall('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
        return (r.list[0]?.coin || []).map((c) => ({ asset: c.coin, free: +c.walletBalance - +(c.locked || 0), locked: +(c.locked || 0) })).filter((b) => b.free + b.locked > 0);
      },
      async marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId }) {
        const body = { category: 'spot', symbol, side: side === 'BUY' ? 'Buy' : 'Sell', orderType: 'Market', orderLinkId: clientOrderId?.slice(0, 36) };
        if (side === 'BUY') { body.qty = (+quoteAmount).toFixed(2); body.marketUnit = 'quoteCoin'; } else { body.qty = String(+quantity.toFixed(6)); body.marketUnit = 'baseCoin'; }
        const { orderId } = await signedCall('POST', '/v5/order/create', body);
        for (let k = 0; k < 6; k++) {
          await new Promise((r) => setTimeout(r, 400));
          const h = await signedCall('GET', '/v5/order/history', { category: 'spot', orderId });
          const o = h.list[0];
          if (o && ['Filled', 'PartiallyFilledCanceled', 'Cancelled'].includes(o.orderStatus)) {
            const qty = +o.cumExecQty;
            return { orderId, qty, price: +o.avgPrice || +o.cumExecValue / qty, cost: +o.cumExecValue, fee: +o.cumExecFee || 0 };
          }
        }
        throw new Error('Bybit order not confirmed in time - check the exchange');
      },
      cancelOpenOrders: (symbol) => signedCall('POST', '/v5/order/cancel-all', { category: 'spot', symbol }),
    };
  },
};
