// Rule-based strategies: deterministic entry/exit rules on indicators instead of model weights.
// Their probability and expected return come from replaying the same rule over the coin's own history
// with the same stop, trailing stop and costs the bot uses - not from a formula.

// Score at candle i: +100 = enter, -100 = exit, 0 = nothing.
export const RULES = {
  // EMA 21/50 cross inside a 200-EMA uptrend. A cross within the last `lookback` closed candles still
  // counts, so a candle missed while the server was down does not skip the whole trend.
  emaCross: (candles, ind, i, { lookback = 2 } = {}) => {
    if (i < 201 || !ind.ema200[i]) return 0;
    if (ind.ema21[i] < ind.ema50[i]) return -100;
    for (let k = i; k > i - lookback && k > 0; k--) {
      const crossUp = ind.ema21[k] > ind.ema50[k] && ind.ema21[k - 1] <= ind.ema50[k - 1];
      if (crossUp && candles[i].close > ind.ema200[i]) return 100;
    }
    return 0;
  },
};

export const ruleScore = (strat, candles, ind, i) => (RULES[strat.rule] ? RULES[strat.rule](candles, ind, i) : 0);

// Replays the rule over history: enter at the next candle's open, exit on the stop (initial, then trailing),
// the take-profit, or the rule's exit signal (filled at the next open). Costs match the backtester defaults.
export function ruleHistory(strat, candles, ind, { feeRate = 0.001, slippageBps = 5, spreadBps = 2, until = candles.length - 1 } = {}) {
  const costIn = 1 + spreadBps / 20000 + slippageBps / 10000;
  const costOut = 1 - spreadBps / 20000 - slippageBps / 10000;
  const sl = strat.sl ?? 2;
  const tp = strat.tp ?? 3;
  const trail = strat.trail ?? null;
  const trades = [];
  let pos = null;
  const exit = (raw) => {
    const net = (raw * costOut * (1 - feeRate)) / (pos.entry / (1 - feeRate)) - 1;
    trades.push(net * 100);
    pos = null;
  };
  for (let i = 202; i < until; i++) {
    const c = candles[i];
    if (pos) {
      if (trail && ind.atr[i - 1]) {
        pos.highest = Math.max(pos.highest, candles[i - 1].high);
        pos.stop = Math.max(pos.stop, pos.highest - trail * ind.atr[i - 1]);
      }
      if (c.low <= pos.stop) exit(Math.min(c.open, pos.stop));
      else if (c.high >= pos.target) exit(Math.max(c.open, pos.target));
      else if (pos.exitNext) exit(c.open);
      if (pos && RULES[strat.rule](candles, ind, i) === -100) pos.exitNext = true;
      continue;
    }
    if (RULES[strat.rule](candles, ind, i) === 100 && ind.atr[i] && i + 1 < until) {
      const entry = candles[i + 1].open * costIn;
      pos = { entry, stop: entry - sl * ind.atr[i], target: entry + tp * ind.atr[i], highest: entry };
      i++; // filled at the next open; manage it from the candle after
      const n = candles[i];
      if (n.low <= pos.stop) exit(Math.min(n.open, pos.stop));
    }
  }
  const wins = trades.filter((t) => t > 0);
  const losses = trades.filter((t) => t <= 0);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    samples: trades.length,
    wins: wins.length,
    avgWinPct: avg(wins),
    avgLossPct: Math.abs(avg(losses)),
    expectancyPct: avg(trades),
  };
}
