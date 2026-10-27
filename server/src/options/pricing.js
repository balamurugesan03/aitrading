// Option maths: Black-Scholes prices and greeks, implied volatility, strategy payoff at expiry and probability of
// profit. European options on an index (NIFTY / BANKNIFTY are cash-settled European options).
const RATE = 0.065; // annual risk-free rate (Indian T-bill ballpark)
const YEAR_MS = 365 * 86400e3;

// Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 7.5e-8) and PDF.
export function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
export const npdf = (x) => 0.3989422804014327 * Math.exp((-x * x) / 2);

export const yearsTo = (expiryMs, now = Date.now()) => Math.max((expiryMs - now) / YEAR_MS, 1 / (365 * 24 * 12)); // floor: 5 minutes

// Price and greeks of one option. type 'CE' (call) or 'PE' (put); t in years; iv as a fraction (0.15 = 15%).
export function blackScholes(type, spot, strike, t, iv, r = RATE) {
  const sig = Math.max(iv, 0.0001);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r + (sig * sig) / 2) * t) / (sig * sqrtT);
  const d2 = d1 - sig * sqrtT;
  const disc = Math.exp(-r * t);
  const call = type === 'CE';
  const price = call ? spot * ncdf(d1) - strike * disc * ncdf(d2) : strike * disc * ncdf(-d2) - spot * ncdf(-d1);
  const delta = call ? ncdf(d1) : ncdf(d1) - 1;
  const gamma = npdf(d1) / (spot * sig * sqrtT);
  const vega = (spot * npdf(d1) * sqrtT) / 100; // per 1 vol point
  const thetaYear = call
    ? (-spot * npdf(d1) * sig) / (2 * sqrtT) - r * strike * disc * ncdf(d2)
    : (-spot * npdf(d1) * sig) / (2 * sqrtT) + r * strike * disc * ncdf(-d2);
  return { price: Math.max(price, 0), delta, gamma, vega, theta: thetaYear / 365 }; // theta per calendar day
}

// Implied volatility by bisection; null when the price is below intrinsic value or no solution exists.
export function impliedVol(type, price, spot, strike, t, r = RATE) {
  const intrinsic = type === 'CE' ? Math.max(spot - strike * Math.exp(-r * t), 0) : Math.max(strike * Math.exp(-r * t) - spot, 0);
  if (!(price > intrinsic + 1e-6)) return null;
  let lo = 0.001;
  let hi = 5;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (blackScholes(type, spot, strike, t, mid, r).price > price) hi = mid;
    else lo = mid;
  }
  const iv = (lo + hi) / 2;
  return iv > 4.9 ? null : iv;
}

// Value of the legs at expiry for an underlying price S. leg: { type, strike, side: 'BUY'|'SELL', qty, price }.
// Returns P&L in rupees (premiums included, charges excluded).
export function payoffAt(legs, S) {
  return legs.reduce((sum, l) => {
    const intrinsic = l.type === 'CE' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    const sign = l.side === 'BUY' ? 1 : -1;
    return sum + sign * (intrinsic - l.price) * l.qty;
  }, 0);
}

// Max profit / loss, breakevens and a payoff curve over a price range around spot.
export function analyzePayoff(legs, spot) {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const lo = Math.min(spot, strikes[0]) * 0.85;
  const hi = Math.max(spot, strikes.at(-1)) * 1.15;
  const points = [];
  const N = 240;
  for (let k = 0; k <= N; k++) {
    const S = lo + ((hi - lo) * k) / N;
    points.push({ S, pnl: payoffAt(legs, S) });
  }
  // Exact values at the kinks (strikes) and the far ends decide the extremes of a piecewise-linear payoff.
  const keyPrices = [0, ...strikes, hi * 4];
  const keyVals = keyPrices.map((S) => payoffAt(legs, S));
  // Slope beyond the highest strike: positive = unlimited upside (long calls), negative = unlimited loss.
  const slopeUp = payoffAt(legs, hi * 4 + 1) - payoffAt(legs, hi * 4);
  const maxProfit = slopeUp > 1e-9 ? Infinity : Math.max(...keyVals);
  const maxLoss = slopeUp < -1e-9 ? -Infinity : Math.min(...keyVals);
  const breakevens = [];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if ((a.pnl < 0 && b.pnl >= 0) || (a.pnl >= 0 && b.pnl < 0)) breakevens.push(+(a.S + ((b.S - a.S) * (0 - a.pnl)) / (b.pnl - a.pnl)).toFixed(2));
  }
  return { maxProfit, maxLoss, breakevens, curve: points.filter((_, k) => k % 4 === 0).map((p) => ({ S: +p.S.toFixed(2), pnl: +p.pnl.toFixed(2) })) };
}

// Probability that the position ends in profit at expiry, assuming a lognormal price with volatility `iv`
// (risk-neutral drift). Integrated numerically over the price distribution.
export function probabilityOfProfit(legs, spot, t, iv, r = RATE) {
  const sig = Math.max(iv, 0.01);
  const mu = Math.log(spot) + (r - (sig * sig) / 2) * t;
  const sd = sig * Math.sqrt(t);
  let p = 0;
  const N = 400;
  for (let k = 0; k < N; k++) {
    const z = -5 + (10 * (k + 0.5)) / N;
    const S = Math.exp(mu + sd * z);
    if (payoffAt(legs, S) > 0) p += npdf(z) * (10 / N);
  }
  return Math.min(1, p);
}

// Net greeks of the position (per the whole quantity).
export function positionGreeks(legs, spot, t, ivOf) {
  return legs.reduce((g, l) => {
    const bs = blackScholes(l.type, spot, l.strike, t, ivOf(l));
    const sign = (l.side === 'BUY' ? 1 : -1) * l.qty;
    return { delta: g.delta + bs.delta * sign, gamma: g.gamma + bs.gamma * sign, theta: g.theta + bs.theta * sign, vega: g.vega + bs.vega * sign };
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 });
}
