// Technical indicators. Every function returns an array aligned with the input (null until warm).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null));
  const start = line.findIndex((v) => v !== null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    e.forEach((v, i) => (sig[start + i] = v));
  }
  const hist = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = [];
  const lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - mid[i]) ** 2, 0) / period);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

export function atr(candles, period = 14) {
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)),
  );
  const out = new Array(candles.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) continue;
    prev = prev === null ? tr.slice(0, period).reduce((a, b) => a + b, 0) / period : (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function stochastic(candles, period = 14, smooth = 3) {
  const k = candles.map((c, i) => {
    if (i < period - 1) return null;
    const win = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...win.map((x) => x.high));
    const lo = Math.min(...win.map((x) => x.low));
    return hi === lo ? 50 : ((c.close - lo) / (hi - lo)) * 100;
  });
  const start = k.findIndex((v) => v !== null);
  const d = new Array(candles.length).fill(null);
  if (start >= 0) sma(k.slice(start), smooth).forEach((v, i) => (d[start + i] = v));
  return { k, d };
}

export function obv(candles) {
  let v = 0;
  return candles.map((c, i) => {
    if (i > 0) v += c.close > candles[i - 1].close ? c.volume : c.close < candles[i - 1].close ? -c.volume : 0;
    return v;
  });
}

export function adx(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period * 2) return out;
  const plusDM = [0];
  const minusDM = [0];
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  let sTR = 0, sP = 0, sM = 0;
  const dx = [];
  for (let i = 1; i < candles.length; i++) {
    if (i <= period) {
      sTR += tr[i]; sP += plusDM[i]; sM += minusDM[i];
      if (i < period) continue;
    } else {
      sTR = sTR - sTR / period + tr[i];
      sP = sP - sP / period + plusDM[i];
      sM = sM - sM / period + minusDM[i];
    }
    const pDI = (100 * sP) / sTR;
    const mDI = (100 * sM) / sTR;
    dx.push({ i, v: pDI + mDI === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / (pDI + mDI) });
  }
  let prev = null;
  dx.forEach((d, j) => {
    if (j < period - 1) return;
    prev = prev === null ? dx.slice(0, period).reduce((s, x) => s + x.v, 0) / period : (prev * (period - 1) + d.v) / period;
    out[d.i] = prev;
  });
  return out;
}

// Computes the full indicator pack used by the AI engine and the chart overlays.
export function computeAll(candles) {
  const closes = candles.map((c) => c.close);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes),
    atr: atr(candles),
    stoch: stochastic(candles),
    obv: obv(candles),
    adx: adx(candles),
    volSma: sma(candles.map((c) => c.volume), 20),
  };
}

export const last = (arr, n = 1) => arr[arr.length - n];
