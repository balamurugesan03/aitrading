// Market regime detection: classifies every candle into one of 8 regimes and recommends a strategy.

export const REGIMES = {
  BULL_TREND: { label: 'Bull Trend', strategy: 'trend', risk: 1, bias: 60, color: 'up' },
  BEAR_TREND: { label: 'Bear Trend', strategy: 'none', risk: 0.25, bias: -60, color: 'down' },
  SIDEWAYS: { label: 'Sideways', strategy: 'mean_reversion', risk: 0.75, bias: 0, color: 'flat' },
  HIGH_VOLATILITY: { label: 'High Volatility', strategy: 'breakout', risk: 0.5, bias: -10, color: 'warn' },
  LOW_VOLATILITY: { label: 'Low Volatility', strategy: 'range', risk: 0.75, bias: 0, color: 'flat' },
  BREAKOUT: { label: 'Breakout', strategy: 'breakout', risk: 0.75, bias: 50, color: 'up' },
  BREAKDOWN: { label: 'Breakdown', strategy: 'none', risk: 0, bias: -70, color: 'down' },
  PANIC: { label: 'Panic', strategy: 'none', risk: 0, bias: -90, color: 'down' },
};

// Rolling percentile rank of values[i] within the previous `window` values (0-100).
export function rollingPercentile(values, window = 200) {
  return values.map((v, i) => {
    if (v === null || i < 20) return null;
    const start = Math.max(0, i - window);
    let below = 0;
    let n = 0;
    for (let j = start; j < i; j++) {
      if (values[j] === null) continue;
      n++;
      if (values[j] < v) below++;
    }
    return n ? (below / n) * 100 : null;
  });
}

// Precomputes the per-candle regime series (used live and by the backtester).
export function regimeSeries(candles, ind) {
  const n = candles.length;
  const atrPct = candles.map((c, i) => (ind.atr[i] ? ind.atr[i] / c.close : null));
  const bbWidth = candles.map((c, i) => (ind.bb.upper[i] ? (ind.bb.upper[i] - ind.bb.lower[i]) / ind.bb.mid[i] : null));
  const atrRank = rollingPercentile(atrPct);
  const bbRank = rollingPercentile(bbWidth);
  const out = new Array(n).fill(null);

  for (let i = 60; i < n; i++) {
    const c = candles[i];
    const atr = ind.atr[i];
    if (!atr || ind.ema50[i] === null || atrRank[i] === null) continue;
    const win = candles.slice(i - 20, i);
    const donHigh = Math.max(...win.map((x) => x.high));
    const donLow = Math.min(...win.map((x) => x.low));
    const volRatio = ind.volSma[i] ? c.volume / ind.volSma[i] : 1;
    const back = Math.min(12, i);
    const z = (c.close - candles[i - back].close) / (atr * Math.sqrt(back));
    const slope50 = (ind.ema50[i] - ind.ema50[i - 10]) / ind.ema50[i - 10];
    const adx = ind.adx[i] ?? 0;
    const metrics = {
      adx: +adx.toFixed(1), atrPct: +(atrPct[i] * 100).toFixed(3), atrPercentile: Math.round(atrRank[i]),
      bbWidthPercentile: bbRank[i] === null ? null : Math.round(bbRank[i]), volRatio: +volRatio.toFixed(2),
      moveZ: +z.toFixed(2), ema50Slope: +(slope50 * 100).toFixed(3),
    };

    let regime;
    if (z < -2.5 && atrRank[i] > 85 && volRatio > 1.8) regime = 'PANIC';
    else if (c.close > donHigh && volRatio > 1.5) regime = 'BREAKOUT';
    else if (c.close < donLow && volRatio > 1.5) regime = 'BREAKDOWN';
    else if (atrRank[i] > 85) regime = 'HIGH_VOLATILITY';
    else if (adx > 22 && ind.ema21[i] > ind.ema50[i] && c.close > ind.ema50[i] && slope50 > 0) regime = 'BULL_TREND';
    else if (adx > 22 && ind.ema21[i] < ind.ema50[i] && c.close < ind.ema50[i] && slope50 < 0) regime = 'BEAR_TREND';
    else if (bbRank[i] !== null && bbRank[i] < 20) regime = 'LOW_VOLATILITY';
    else regime = 'SIDEWAYS';

    // Confidence: how far the deciding metrics sit past their thresholds.
    let confidence = 0.6;
    if (regime === 'BULL_TREND' || regime === 'BEAR_TREND') confidence = Math.min(0.95, 0.5 + (adx - 22) / 40 + Math.abs(slope50) * 20);
    else if (regime === 'SIDEWAYS') confidence = Math.min(0.9, 0.5 + (22 - Math.min(adx, 22)) / 30);
    else if (regime === 'HIGH_VOLATILITY') confidence = Math.min(0.95, 0.5 + (atrRank[i] - 85) / 30);
    else if (regime === 'BREAKOUT' || regime === 'BREAKDOWN') confidence = Math.min(0.95, 0.5 + (volRatio - 1.5) / 3);
    else if (regime === 'PANIC') confidence = 0.9;

    out[i] = { regime, ...REGIMES[regime], confidence: +confidence.toFixed(2), metrics };
  }
  return out;
}

export function describeRegime(r) {
  if (!r) return 'Not enough data to classify the market.';
  const m = r.metrics;
  switch (r.regime) {
    case 'BULL_TREND': return `Uptrend: EMA21 above EMA50, ADX ${m.adx}, EMA50 rising ${m.ema50Slope}% over 10 bars.`;
    case 'BEAR_TREND': return `Downtrend: EMA21 below EMA50, ADX ${m.adx}. Spot longs are avoided.`;
    case 'SIDEWAYS': return `Range-bound: ADX ${m.adx} shows no directional trend. Mean reversion is preferred.`;
    case 'HIGH_VOLATILITY': return `ATR is in the ${m.atrPercentile}th percentile of the last 200 bars. Position size is reduced.`;
    case 'LOW_VOLATILITY': return `Bollinger width in the ${m.bbWidthPercentile}th percentile - a squeeze that often precedes a big move.`;
    case 'BREAKOUT': return `Close above the 20-bar high on ${m.volRatio}x volume.`;
    case 'BREAKDOWN': return `Close below the 20-bar low on ${m.volRatio}x volume. No new longs.`;
    case 'PANIC': return `Sharp sell-off (${m.moveZ} sigma) on ${m.volRatio}x volume with extreme volatility. Trading halted.`;
    default: return '';
  }
}
