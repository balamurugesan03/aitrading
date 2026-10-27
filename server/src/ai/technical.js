// Rule-based strategy scoring. Each strategy returns a score in [-100, 100] plus human-readable reasons.
import { last } from './indicators.js';

const at = (arr, i) => (i < 0 ? arr[arr.length + i] : arr[i]);

export function trendScore(c, ind, i = -1) {
  const reasons = [];
  let s = 0;
  const price = at(c, i).close;
  const e9 = at(ind.ema9, i), e21 = at(ind.ema21, i), e50 = at(ind.ema50, i), e200 = at(ind.ema200, i);
  const adx = at(ind.adx, i) ?? 0;
  if (e9 && e21) {
    if (e9 > e21) { s += 25; reasons.push('EMA9 above EMA21 (short-term uptrend)'); }
    else { s -= 25; reasons.push('EMA9 below EMA21 (short-term downtrend)'); }
    const p9 = at(ind.ema9, i - 1), p21 = at(ind.ema21, i - 1);
    if (p9 && p21 && p9 <= p21 && e9 > e21) { s += 20; reasons.push('Fresh golden cross EMA9/21'); }
    if (p9 && p21 && p9 >= p21 && e9 < e21) { s -= 20; reasons.push('Fresh death cross EMA9/21'); }
  }
  if (e50) { s += price > e50 ? 15 : -15; }
  if (e200) {
    s += price > e200 ? 15 : -15;
    reasons.push(price > e200 ? 'Price above EMA200 (bull regime)' : 'Price below EMA200 (bear regime)');
  }
  if (adx > 25) { s *= 1.25; reasons.push(`Strong trend (ADX ${adx.toFixed(0)})`); }
  else if (adx < 18) { s *= 0.6; reasons.push(`Weak/ranging market (ADX ${adx.toFixed(0)})`); }
  return { score: clamp(s), reasons };
}

export function meanReversionScore(c, ind, i = -1) {
  const reasons = [];
  let s = 0;
  const price = at(c, i).close;
  const r = at(ind.rsi, i);
  const up = at(ind.bb.upper, i), lo = at(ind.bb.lower, i);
  const k = at(ind.stoch.k, i);
  if (r !== null) {
    if (r < 30) { s += 40; reasons.push(`RSI oversold (${r.toFixed(1)})`); }
    else if (r > 70) { s -= 40; reasons.push(`RSI overbought (${r.toFixed(1)})`); }
    else s += (50 - r) * 0.5;
  }
  if (lo && price <= lo) { s += 35; reasons.push('Price at/below lower Bollinger Band'); }
  if (up && price >= up) { s -= 35; reasons.push('Price at/above upper Bollinger Band'); }
  if (k !== null) {
    if (k < 20) { s += 20; reasons.push('Stochastic oversold'); }
    if (k > 80) { s -= 20; reasons.push('Stochastic overbought'); }
  }
  return { score: clamp(s), reasons };
}

export function momentumScore(c, ind, i = -1) {
  const reasons = [];
  let s = 0;
  const h = at(ind.macd.hist, i), ph = at(ind.macd.hist, i - 1);
  const line = at(ind.macd.line, i), sig = at(ind.macd.signal, i);
  if (h !== null && ph !== null) {
    if (h > 0 && ph <= 0) { s += 45; reasons.push('MACD bullish crossover'); }
    else if (h < 0 && ph >= 0) { s -= 45; reasons.push('MACD bearish crossover'); }
    else if (h > ph) { s += 15; reasons.push('MACD momentum rising'); }
    else { s -= 15; reasons.push('MACD momentum falling'); }
  }
  if (line !== null && sig !== null) s += line > 0 ? 15 : -15;
  const vol = at(c, i).volume, vs = at(ind.volSma, i);
  if (vs && vol > vs * 1.8) {
    const dir = at(c, i).close > at(c, i).open ? 1 : -1;
    s += 20 * dir;
    reasons.push(`Volume spike ${(vol / vs).toFixed(1)}x (${dir > 0 ? 'buyers' : 'sellers'})`);
  }
  const ob = ind.obv;
  if (ob.length > 10) s += at(ob, i) > at(ob, i - 10) ? 10 : -10;
  return { score: clamp(s), reasons };
}

export function technicalSummary(c, ind, i = -1) {
  const t = trendScore(c, ind, i);
  const m = meanReversionScore(c, ind, i);
  const mo = momentumScore(c, ind, i);
  return {
    trend: t,
    meanReversion: m,
    momentum: mo,
    composite: clamp(t.score * 0.4 + mo.score * 0.35 + m.score * 0.25),
  };
}

export function snapshot(c, ind) {
  const n = (v, d = 2) => (v === null || v === undefined ? null : +v.toFixed(d));
  return {
    price: last(c).close,
    ema9: n(last(ind.ema9)), ema21: n(last(ind.ema21)), ema50: n(last(ind.ema50)), ema200: n(last(ind.ema200)),
    rsi: n(last(ind.rsi)),
    macd: n(last(ind.macd.line), 4), macdSignal: n(last(ind.macd.signal), 4), macdHist: n(last(ind.macd.hist), 4),
    bbUpper: n(last(ind.bb.upper)), bbMid: n(last(ind.bb.mid)), bbLower: n(last(ind.bb.lower)),
    atr: n(last(ind.atr), 4), stochK: n(last(ind.stoch.k)), stochD: n(last(ind.stoch.d)), adx: n(last(ind.adx)),
  };
}

export const clamp = (v, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, Math.round(v)));
