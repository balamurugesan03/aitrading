// Strategy library. A strategy = model weights + stop/target geometry + the regimes it is allowed to trade.

const NO_LONG = ['BEAR_TREND', 'BREAKDOWN', 'PANIC'];

export const STRATEGY_LIBRARY = {
  adaptive: {
    name: 'AI Adaptive',
    description: 'Detects the market regime first, then switches to the strategy that fits it (trend, mean reversion or breakout). The default.',
    timeframes: ['15m', '1h', '4h'],
    adaptive: true,
  },
  ema_trend: {
    name: 'EMA Trend',
    description: 'Rule-based trend follower: buys when EMA 21 crosses above EMA 50 while price is above EMA 200, rides the trend with a 3.5x ATR trailing stop and exits when EMA 21 falls back below EMA 50. Trades rarely. Built for 4h.',
    rule: 'emaCross', sl: 2.5, tp: 50, trail: 3.5, timeframes: ['4h'], regimes: [], blocked: [],
  },
  trend: {
    name: 'AI Trend',
    description: 'Rides established uptrends: EMA alignment, ADX strength and rising momentum.',
    weights: { trend: 0.4, momentum: 0.2, regime: 0.1, flow: 0.1, ml: 0.15, sentiment: 0.05 },
    sl: 2, tp: 4, timeframes: ['1h', '4h'], regimes: ['BULL_TREND', 'BREAKOUT'], blocked: NO_LONG,
  },
  momentum: {
    name: 'AI Momentum',
    description: 'MACD crossovers, volume spikes and taker-buy pressure.',
    weights: { momentum: 0.45, flow: 0.2, trend: 0.1, ml: 0.2, sentiment: 0.05 },
    sl: 1.5, tp: 3, timeframes: ['15m', '1h'], regimes: ['BULL_TREND', 'BREAKOUT', 'HIGH_VOLATILITY'], blocked: NO_LONG,
  },
  mean_reversion: {
    name: 'AI Mean Reversion',
    description: 'Buys oversold dips inside ranges (RSI, Bollinger, Stochastic) and targets the mean.',
    weights: { meanReversion: 0.5, pattern: 0.15, flow: 0.1, ml: 0.2, sentiment: 0.05 },
    sl: 1.5, tp: 2, timeframes: ['15m', '1h'], regimes: ['SIDEWAYS', 'LOW_VOLATILITY'], blocked: [...NO_LONG, 'HIGH_VOLATILITY'],
  },
  breakout: {
    name: 'AI Breakout',
    description: 'Enters on volatility expansion out of a range with volume confirmation.',
    weights: { volatility: 0.45, momentum: 0.2, flow: 0.2, ml: 0.1, sentiment: 0.05 },
    sl: 1.5, tp: 3.5, timeframes: ['15m', '1h', '4h'], regimes: ['BREAKOUT', 'HIGH_VOLATILITY', 'LOW_VOLATILITY'], blocked: NO_LONG,
  },
  scalping: {
    name: 'AI Scalping',
    description: 'Short-timeframe momentum + order flow with tight stops. Very sensitive to fees and slippage.',
    weights: { momentum: 0.35, flow: 0.35, meanReversion: 0.1, ml: 0.2 },
    sl: 1, tp: 1.5, timeframes: ['1m', '5m'], regimes: ['BULL_TREND', 'SIDEWAYS', 'BREAKOUT'], blocked: [...NO_LONG, 'HIGH_VOLATILITY'],
  },
  volatility: {
    name: 'AI Volatility',
    description: 'Waits for a Bollinger squeeze and trades the expansion in the trend direction.',
    weights: { volatility: 0.55, trend: 0.2, ml: 0.2, sentiment: 0.05 },
    sl: 2, tp: 4, timeframes: ['1h', '4h'], regimes: ['LOW_VOLATILITY', 'BREAKOUT'], blocked: NO_LONG,
  },
  order_flow: {
    name: 'AI Order Flow',
    description: 'Trades buy/sell pressure, book imbalance and absorption. Live uses the real order book; backtests use taker volume delta.',
    weights: { flow: 0.65, momentum: 0.15, ml: 0.15, sentiment: 0.05 },
    sl: 1.2, tp: 2, timeframes: ['5m', '15m'], regimes: ['BULL_TREND', 'SIDEWAYS', 'BREAKOUT'], blocked: NO_LONG,
  },
  ml: {
    name: 'AI Neural Net',
    description: 'Pure machine-learning signal from the neural network + logistic ensemble.',
    weights: { ml: 1 },
    sl: 2, tp: 3, timeframes: ['1h'], regimes: [], blocked: ['PANIC'],
  },
  dca: {
    name: 'AI DCA',
    description: 'Dollar-cost averages into a position every N candles while the AI score is not bearish, and sells the whole stack at a profit target.',
    dca: true, every: 24, tranchePct: 5, maxTranches: 6, takeProfitPct: 4, timeframes: ['1h', '4h'], blocked: ['PANIC', 'BREAKDOWN'],
  },
  grid: {
    name: 'AI Grid',
    description: 'Places a ladder of buy levels inside the detected range and sells each lot one level higher. The AI only runs the grid in sideways / low-volatility regimes and shuts it down (selling everything) if price breaks below the range.',
    grid: true, levels: 10, timeframes: ['15m', '1h'], regimes: ['SIDEWAYS', 'LOW_VOLATILITY'], blocked: ['BEAR_TREND', 'BREAKDOWN', 'PANIC'],
  },
  claude: {
    name: 'Claude AI only',
    description: 'Claude reads the full dossier and decides alone. Live only (not backtestable).',
    weights: { claude: 1 }, sl: 2, tp: 3, timeframes: ['1h', '4h'], liveOnly: true, blocked: ['PANIC'],
  },
};

// The adaptive strategy picks a concrete strategy per regime.
export const REGIME_PLAYBOOK = {
  BULL_TREND: 'trend',
  BREAKOUT: 'breakout',
  HIGH_VOLATILITY: 'breakout',
  SIDEWAYS: 'mean_reversion',
  LOW_VOLATILITY: 'mean_reversion',
  BEAR_TREND: null,
  BREAKDOWN: null,
  PANIC: null,
};

// ---- Custom strategies (strategy builder + marketplace installs), loaded into memory at startup ----
const customStrategies = new Map();
export function registerCustomStrategy(doc) {
  customStrategies.set(doc.id, {
    name: doc.name, description: doc.description || 'Custom strategy', custom: true, ownerId: doc.userId,
    weights: doc.weights, sl: Number(doc.sl) || 2, tp: Number(doc.tp) || 3, timeframes: doc.timeframes || [], regimes: doc.regimes || [],
    blocked: doc.blocked?.length ? doc.blocked : NO_LONG,
  });
}
export const unregisterCustomStrategy = (id) => customStrategies.delete(id);
export const getStrategy = (id) => STRATEGY_LIBRARY[id] || customStrategies.get(id) || null;
export const isKnownStrategy = (id) => Boolean(getStrategy(id));

// Every signal strategy also listens to the higher timeframe (multi-timeframe fusion).
const HTF_WEIGHT = 0.15;
const withHtf = (weights) => (weights && !weights.ml && !weights.claude ? { ...weights, htf: HTF_WEIGHT } : weights);

// Resolves which concrete strategy runs at this candle.
export function resolveStrategy(strategyId, regime) {
  const base = getStrategy(strategyId) || STRATEGY_LIBRARY.adaptive;
  if (!base.adaptive) return { id: strategyId, ...base, weights: withHtf(base.weights) };
  const picked = REGIME_PLAYBOOK[regime] ?? null;
  if (!picked) return { id: 'none', name: 'Stand aside', weights: withHtf(STRATEGY_LIBRARY.trend.weights), sl: 2, tp: 4, blocked: NO_LONG, standAside: true };
  return { id: picked, ...STRATEGY_LIBRARY[picked], weights: withHtf(STRATEGY_LIBRARY[picked].weights), adaptiveFrom: 'adaptive' };
}

// A long is blocked by the strategy's own regime rules, or when the higher timeframe is clearly bearish.
export function longBlocked(strat, regime, htfRegime) {
  if (strat.standAside || (strat.blocked || []).includes(regime)) return `${regime.replace('_', ' ').toLowerCase()} regime`;
  if (strat.weights?.htf && ['BEAR_TREND', 'BREAKDOWN', 'PANIC'].includes(htfRegime)) return `higher timeframe in ${htfRegime.replace('_', ' ').toLowerCase()}`;
  return null;
}

// Shorts (only on adapters that can sell first, e.g. NSE currency futures) are blocked in rising markets.
export function shortBlocked(strat, regime, htfRegime) {
  if (strat.standAside || strat.rule || strat.dca || strat.grid) return `${strat.name} is long-only`;
  if (['BULL_TREND', 'BREAKOUT'].includes(regime)) return `${regime.replace('_', ' ').toLowerCase()} regime`;
  if (strat.weights?.htf && ['BULL_TREND', 'BREAKOUT'].includes(htfRegime)) return `higher timeframe in ${htfRegime.replace('_', ' ').toLowerCase()}`;
  return null;
}

export function weightedScore(models, weights) {
  let s = 0;
  let w = 0;
  for (const [k, wt] of Object.entries(weights)) {
    if (models[k] === undefined) continue;
    s += (models[k].score ?? models[k]) * wt;
    w += wt;
  }
  return w ? Math.max(-100, Math.min(100, Math.round(s / w))) : 0;
}

export const listStrategies = (userId = null) => [
  ...Object.entries(STRATEGY_LIBRARY).map(([id, s]) => ({ id, name: s.name, description: s.description, timeframes: s.timeframes, regimes: s.regimes || [], liveOnly: !!s.liveOnly })),
  ...[...customStrategies.entries()].filter(([, s]) => !userId || s.ownerId === userId).map(([id, s]) => ({ id, name: s.name, description: s.description, timeframes: s.timeframes, regimes: s.regimes, custom: true, weights: s.weights, sl: s.sl, tp: s.tp })),
];
