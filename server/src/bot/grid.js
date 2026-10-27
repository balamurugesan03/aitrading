// AI Grid: a ladder of buy levels inside the detected range; each filled level is sold one step higher.
// The AI decides WHEN a grid may run (sideways / low-volatility regimes) and kills it on a range breakdown.

export const GRID_REGIMES = ['SIDEWAYS', 'LOW_VOLATILITY'];
export const GRID_KILL_REGIMES = ['BEAR_TREND', 'BREAKDOWN', 'PANIC'];

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

// Each grid step must earn well over the round-trip cost (2 x 0.1% fee + spread/slippage ~0.35%).
export const MIN_STEP_PCT = 0.8;

// Range = 10th..90th percentile of the last `lookback` closes, split into up to `maxLevels` steps.
export function buildGrid(candles, maxLevels = 10, lookback = 120) {
  const closes = candles.slice(-lookback).map((c) => c.close);
  const lower = quantile(closes, 0.1);
  const upper = quantile(closes, 0.9);
  const rangePct = ((upper - lower) / lower) * 100;
  const levels = Math.min(maxLevels, Math.floor(rangePct / MIN_STEP_PCT));
  if (levels < 3) return null; // range too narrow for a grid to beat fees
  const step = (upper - lower) / levels;
  return { lower, upper, step, levels: Array.from({ length: levels }, (_, k) => lower + k * step), lots: [], builtAt: candles.at(-1).time };
}

// Given the previous and current price, which levels should buy and which lots should sell.
export function gridActions(grid, prevPrice, price) {
  const sells = grid.lots.filter((l) => price >= l.level + grid.step);
  const held = new Set(grid.lots.map((l) => l.level));
  const buys = grid.levels.filter((lv) => !held.has(lv) && price <= lv && prevPrice > lv);
  return { sells, buys };
}
