// Candlestick pattern recognition + support/resistance detection.

export function detectPatterns(candles) {
  const found = [];
  const n = candles.length;
  if (n < 3) return found;
  const [a, b, c] = candles.slice(-3);
  const body = (x) => Math.abs(x.close - x.open);
  const range = (x) => x.high - x.low || 1e-9;
  const bull = (x) => x.close > x.open;
  const bear = (x) => x.close < x.open;
  const upperWick = (x) => x.high - Math.max(x.open, x.close);
  const lowerWick = (x) => Math.min(x.open, x.close) - x.low;

  if (body(c) / range(c) < 0.1) found.push({ name: 'Doji', bias: 'neutral' });
  if (lowerWick(c) > body(c) * 2 && upperWick(c) < body(c) * 0.5 && bear(b))
    found.push({ name: 'Hammer', bias: 'bullish' });
  if (upperWick(c) > body(c) * 2 && lowerWick(c) < body(c) * 0.5 && bull(b))
    found.push({ name: 'Shooting Star', bias: 'bearish' });
  if (bear(b) && bull(c) && c.close > b.open && c.open < b.close)
    found.push({ name: 'Bullish Engulfing', bias: 'bullish' });
  if (bull(b) && bear(c) && c.close < b.open && c.open > b.close)
    found.push({ name: 'Bearish Engulfing', bias: 'bearish' });
  if (bear(a) && body(b) / range(b) < 0.3 && bull(c) && c.close > (a.open + a.close) / 2)
    found.push({ name: 'Morning Star', bias: 'bullish' });
  if (bull(a) && body(b) / range(b) < 0.3 && bear(c) && c.close < (a.open + a.close) / 2)
    found.push({ name: 'Evening Star', bias: 'bearish' });
  if ([a, b, c].every(bull) && b.close > a.close && c.close > b.close)
    found.push({ name: 'Three White Soldiers', bias: 'bullish' });
  if ([a, b, c].every(bear) && b.close < a.close && c.close < b.close)
    found.push({ name: 'Three Black Crows', bias: 'bearish' });
  return found;
}

// Pivot-based support / resistance levels clustered within 0.5%.
export function supportResistance(candles, lookback = 200, wing = 5) {
  const data = candles.slice(-lookback);
  const pivots = [];
  for (let i = wing; i < data.length - wing; i++) {
    const win = data.slice(i - wing, i + wing + 1);
    if (data[i].high === Math.max(...win.map((x) => x.high))) pivots.push(data[i].high);
    if (data[i].low === Math.min(...win.map((x) => x.low))) pivots.push(data[i].low);
  }
  pivots.sort((x, y) => x - y);
  const clusters = [];
  for (const p of pivots) {
    const cl = clusters.find((c) => Math.abs(c.price - p) / p < 0.005);
    if (cl) {
      cl.price = (cl.price * cl.touches + p) / (cl.touches + 1);
      cl.touches++;
    } else clusters.push({ price: p, touches: 1 });
  }
  const price = data[data.length - 1].close;
  const strong = clusters.filter((c) => c.touches >= 2);
  return {
    supports: strong.filter((c) => c.price < price).sort((x, y) => y.price - x.price).slice(0, 3),
    resistances: strong.filter((c) => c.price > price).sort((x, y) => x.price - y.price).slice(0, 3),
  };
}
