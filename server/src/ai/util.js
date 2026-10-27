export const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB'];
export const STABLES = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI', 'TUSD', 'USD1', 'USDP', 'USDE', 'RLUSD']);

export const baseAsset = (symbol) => {
  const q = QUOTES.find((x) => symbol.endsWith(x) && symbol.length > x.length);
  return q ? symbol.slice(0, -q.length) : symbol;
};

export const pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (x[k] - mx) * (y[k] - my);
    sxx += (x[k] - mx) ** 2;
    syy += (y[k] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
};

export const returns = (candles) => candles.slice(1).map((c, k) => Math.log(c.close / candles[k].close));

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}
