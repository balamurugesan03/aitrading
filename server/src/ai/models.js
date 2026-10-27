// The candle-based model layer. Every model maps a market state at candle i to a score in [-100, 100]
// plus the reasons behind it. These run identically live and in the backtester (no look-ahead).
import { computeAll } from './indicators.js';
import { trendScore, momentumScore, meanReversionScore, clamp } from './technical.js';
import { regimeSeries } from './regime.js';
import { detectPatterns } from './patterns.js';
import { buildFeatures } from './mlModel.js';

export const HIGHER_TF = { '1m': '15m', '3m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '4h', '2h': '1d', '4h': '1d', '6h': '1d', '12h': '1w', '1d': '1w' };
export const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400, '1w': 604800 };

// Builds higher-timeframe candles from base candles. htfIndex[i] = the newest HTF candle that was fully
// closed when base candle i closed, so no bar ever sees an unfinished higher-timeframe candle.
export function resample(candles, baseSec, htfSec) {
  const htf = [];
  const htfIndex = new Array(candles.length).fill(-1);
  let cur = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.time / htfSec) * htfSec;
    if (cur && cur.time !== bucket) { htf.push(cur); cur = null; }
    if (!cur) {
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, takerBuy: c.takerBuy ?? c.volume / 2 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      cur.takerBuy += c.takerBuy ?? c.volume / 2;
    }
    if (c.time + baseSec >= bucket + htfSec) { htf.push(cur); cur = null; }
    htfIndex[i] = htf.length - 1;
  }
  return { htf, htfIndex };
}

// Precomputes everything the models need for a candle series.
export function buildContext(candles, interval = null) {
  const ind = computeAll(candles);
  const ctx = { candles, ind, regimes: regimeSeries(candles, ind), feats: buildFeatures(candles, ind), predict: null, interval };
  const higher = interval && HIGHER_TF[interval];
  if (higher) {
    const { htf, htfIndex } = resample(candles, TF_SEC[interval], TF_SEC[higher]);
    if (htf.length >= 30) {
      const hind = computeAll(htf);
      ctx.htf = { interval: higher, candles: htf, ind: hind, regimes: regimeSeries(htf, hind), index: htfIndex };
    }
  }
  return ctx;
}

function trendModel(ctx, i) {
  const t = trendScore(ctx.candles, ctx.ind, i);
  return { score: t.score, notes: t.reasons };
}

function momentumModel(ctx, i) {
  const m = momentumScore(ctx.candles, ctx.ind, i);
  return { score: m.score, notes: m.reasons };
}

function meanReversionModel(ctx, i) {
  const m = meanReversionScore(ctx.candles, ctx.ind, i);
  return { score: m.score, notes: m.reasons };
}

// Volatility model: rewards a volatility expansion out of a squeeze in the direction of the move.
function volatilityModel(ctx, i) {
  const { candles, ind } = ctx;
  const notes = [];
  const r = ctx.regimes[i];
  if (!r || i < 25) return { score: 0, notes };
  const c = candles[i];
  const bbw = (j) => (ind.bb.upper[j] - ind.bb.lower[j]) / ind.bb.mid[j];
  const expanding = ind.bb.upper[i - 5] ? bbw(i) / bbw(i - 5) : 1;
  const dir = c.close > ind.bb.mid[i] ? 1 : -1;
  let s = 0;
  if (r.metrics.bbWidthPercentile !== null && r.metrics.bbWidthPercentile < 25) {
    notes.push(`Volatility squeeze (BB width ${r.metrics.bbWidthPercentile}th pct)`);
    s += 10 * dir;
  }
  if (expanding > 1.25) {
    s += 45 * dir;
    notes.push(`Volatility expanding ${expanding.toFixed(2)}x ${dir > 0 ? 'upward' : 'downward'}`);
  }
  if (c.close > ind.bb.upper[i]) { s += 30; notes.push('Close outside upper band (breakout pressure)'); }
  if (c.close < ind.bb.lower[i]) { s -= 30; notes.push('Close outside lower band (breakdown pressure)'); }
  if (r.metrics.atrPercentile > 90) { s -= 15; notes.push('Extreme ATR - risk of whipsaw'); }
  return { score: clamp(s), notes };
}

function regimeModel(ctx, i) {
  const r = ctx.regimes[i];
  if (!r) return { score: 0, notes: ['Regime unknown'] };
  return { score: clamp(r.bias * r.confidence), notes: [`${r.label} (confidence ${(r.confidence * 100).toFixed(0)}%)`] };
}

// Order-flow proxy from candles: taker-buy volume delta + OBV slope. Live trading blends in the real book.
function flowModel(ctx, i) {
  const { candles, ind } = ctx;
  const notes = [];
  if (i < 12) return { score: 0, notes };
  let buy = 0;
  let total = 0;
  for (let j = i - 9; j <= i; j++) {
    buy += candles[j].takerBuy ?? candles[j].volume / 2;
    total += candles[j].volume;
  }
  const buyShare = total ? buy / total : 0.5;
  let s = (buyShare - 0.5) * 400;
  notes.push(`Taker buy share ${(buyShare * 100).toFixed(1)}% (10 bars)`);
  const obvUp = ind.obv[i] > ind.obv[i - 10];
  s += obvUp ? 15 : -15;
  return { score: clamp(s), notes };
}

function patternModel(ctx, i) {
  if (i < 3) return { score: 0, notes: [] };
  const pats = detectPatterns(ctx.candles.slice(i - 2, i + 1));
  const s = pats.reduce((a, p) => a + (p.bias === 'bullish' ? 30 : p.bias === 'bearish' ? -30 : 0), 0);
  return { score: clamp(s), notes: pats.map((p) => p.name), patterns: pats };
}

// Multi-timeframe model: trend + regime of the higher timeframe (only fully closed HTF candles).
function htfModel(ctx, i) {
  const h = ctx.htf;
  if (!h) return { score: 0, notes: [], regime: null };
  const j = h.index[i];
  if (j === undefined || j < 25) return { score: 0, notes: [], regime: null };
  const t = trendScore(h.candles, h.ind, j);
  const r = h.regimes[j];
  const s = t.score * 0.7 + (r ? r.bias * r.confidence * 0.3 : 0);
  return { score: clamp(s), notes: [`${h.interval} trend ${t.score > 0 ? '+' : ''}${t.score}${r ? `, ${h.interval} regime ${r.label}` : ''}`], regime: r?.regime || null };
}

function mlModel(ctx, i) {
  if (!ctx.predict || !ctx.feats[i]) return { score: 0, notes: ['Model not trained'] };
  const p = ctx.predict(ctx.feats[i]);
  return { score: clamp((p - 0.5) * 200 * (ctx.mlTrust ?? 1)), notes: [`P(up) ${(p * 100).toFixed(1)}%`], prob: p };
}

export const MODEL_LABELS = {
  trend: 'Trend', momentum: 'Momentum', meanReversion: 'Mean Reversion', volatility: 'Volatility',
  regime: 'Regime', flow: 'Order Flow', pattern: 'Patterns', ml: 'Neural Net', sentiment: 'Sentiment', htf: 'Higher Timeframe',
};

// Runs every candle model at index i.
export function runModels(ctx, i, { withMl = true } = {}) {
  return {
    trend: trendModel(ctx, i),
    momentum: momentumModel(ctx, i),
    meanReversion: meanReversionModel(ctx, i),
    volatility: volatilityModel(ctx, i),
    regime: regimeModel(ctx, i),
    flow: flowModel(ctx, i),
    pattern: patternModel(ctx, i),
    htf: htfModel(ctx, i),
    ml: withMl ? mlModel(ctx, i) : { score: 0, notes: [] },
  };
}
