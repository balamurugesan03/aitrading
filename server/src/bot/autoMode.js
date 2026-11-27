// Auto mode: for users who do not know the trading settings. They choose only the coin, the amount and a risk level
// (Safe / Balanced / Aggressive); every other setting comes from the profile, and each candle the bot adapts to the
// market regime (no new trades in a crash, smaller trades when volatile). Auto bots always keep a stop-loss and a
// maximum holding time, so a trade can never stay open forever, and take a small profit (after fees) as soon as it is
// there, without waiting for the full target.

export const RISK_PROFILES = {
  safe: {
    label: 'Safe',
    // EMA Trend on 4h: the only strategy that was profitable on train, validation and out-of-sample data (2020-2026).
    strategy: 'ema_trend', interval: '4h', fallbackIntervals: ['1h', '15m'],
    threshold: 35, riskPct: 0.5, maxPositionPct: 15, dailyLossLimitPct: 2, trailAtr: 3, maxHoldMin: 4320, smallProfitPct: 0.5, leverage: 1, shorts: false,
  },
  balanced: {
    label: 'Balanced',
    // Adaptive: the AI picks the best strategy for the current market regime, each with its own ATR stop / target.
    strategy: 'adaptive', interval: '1h', fallbackIntervals: ['15m', '4h'],
    threshold: 30, riskPct: 1, maxPositionPct: 25, dailyLossLimitPct: 4, trailAtr: 2.5, maxHoldMin: 1440, smallProfitPct: 0.4, leverage: 2, shorts: false,
  },
  aggressive: {
    label: 'Aggressive',
    strategy: 'adaptive', interval: '15m', fallbackIntervals: ['5m', '1h'],
    threshold: 25, riskPct: 1.5, maxPositionPct: 35, dailyLossLimitPct: 6, trailAtr: 2, maxHoldMin: 240, smallProfitPct: 0.3, leverage: 2, shorts: true,
  },
};
export const DEFAULT_PROFILE = 'balanced';
// An auto bot trades on paper first: live trading unlocks after this many closed paper trades.
export const AUTO_PAPER_TRADES = 10;

export const profileOf = (bot) => RISK_PROFILES[bot?.riskProfile] || RISK_PROFILES[DEFAULT_PROFILE];

// The bot settings an auto bot runs with. `exchange` is the adapter info ({ intervals, canShort, perp }).
// Overrides every advanced setting the user may have sent, so an auto bot never has a risky combination.
export function autoBotConfig(riskProfile, exchange = {}) {
  const key = RISK_PROFILES[riskProfile] ? riskProfile : DEFAULT_PROFILE;
  const p = RISK_PROFILES[key];
  const intervals = exchange.intervals || [];
  const interval = [p.interval, ...p.fallbackIntervals].find((i) => !intervals.length || intervals.includes(i)) || intervals[0] || p.interval;
  return {
    autoMode: true, riskProfile: key,
    strategy: p.strategy, interval, threshold: p.threshold, riskPct: p.riskPct, maxPositionPct: p.maxPositionPct,
    dailyLossLimitPct: p.dailyLossLimitPct, trailingStop: true, trailAtr: p.trailAtr, maxHoldMin: p.maxHoldMin, smallProfitPct: p.smallProfitPct,
    allowShort: Boolean(p.shorts && exchange.canShort), leverage: p.leverage,
    // Off in auto mode: these are the settings that confuse beginners or can leave a trade stuck.
    useClaude: false, forceTrade: false, stopAfterTrade: false, onlyProfitExit: false, alternate: false,
    takeProfitPct: 0, takeProfitUsd: 0, stopLossUsd: 0,
  };
}

// Per candle: how the bot adapts to the market right now. Returns
//   blockEntry - no new trades this candle (open trades are still managed: stop-loss, target, AI exit)
//   sizeMult   - multiplier on the trade size / risk (0.5 = half size)
//   note       - a plain-language explanation for the user
export function autoTune(bot, regime) {
  const safe = bot.riskProfile === 'safe';
  switch (regime) {
    case 'PANIC':
      return { blockEntry: true, sizeMult: 0, note: 'Market is crashing - no new trades. An open trade is closed by its stop-loss or the AI exit.' };
    case 'BREAKDOWN':
      return { blockEntry: true, sizeMult: 0, note: 'Price broke down hard - no new trades until the market calms.' };
    case 'BEAR_TREND':
      return bot.allowShort
        ? { blockEntry: false, sizeMult: 0.75, note: 'Market is falling - the bot only sells first (short), with a smaller size.' }
        : { blockEntry: true, sizeMult: 0, note: 'Market is falling - waiting. The bot buys again when the trend turns up.' };
    case 'HIGH_VOLATILITY':
      return { blockEntry: false, sizeMult: 0.5, note: 'Price is jumping a lot - trades are half size to limit the risk.' };
    case 'SIDEWAYS':
    case 'LOW_VOLATILITY':
      return { blockEntry: false, sizeMult: safe ? 0.5 : 0.75, note: 'Market is moving sideways - smaller trades, quicker profits.' };
    case 'BULL_TREND':
    case 'BREAKOUT':
      return { blockEntry: false, sizeMult: 1, note: 'Market is going up - normal trade size.' };
    default:
      return { blockEntry: false, sizeMult: 1, note: 'Reading the market.' };
  }
}
