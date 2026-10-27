// Position sizing and risk guards.

// Risk-based sizing: lose at most `riskPct` of equity if the stop is hit, capped by `maxPositionPct`.
export function positionSize({ equity, available, entry, stopLoss, riskPct = 1, maxPositionPct = 25, minNotional = 10 }) {
  const stopDist = Math.max(entry - stopLoss, entry * 0.002);
  const riskAmount = equity * (riskPct / 100);
  let notional = (riskAmount / stopDist) * entry;
  notional = Math.min(notional, equity * (maxPositionPct / 100), available * 0.995);
  if (notional < minNotional) return { notional: 0, reason: `Position below minimum notional (${minNotional})` };
  return { notional, riskAmount, stopDist };
}

// Ratchets the stop up as price makes new highs (never moves it down).
export function trailStop(position, price, atrMult, atr) {
  const highest = Math.max(position.highest || position.entry, price);
  const trailed = highest - atrMult * atr;
  return { highest, stopLoss: Math.max(position.stopLoss, trailed) };
}

// Short positions: ratchets the stop down as price makes new lows (never moves it up).
export function trailStopShort(position, price, atrMult, atr) {
  const lowest = Math.min(position.lowest || position.entry, price);
  const trailed = lowest + atrMult * atr;
  return { lowest, stopLoss: Math.min(position.stopLoss, trailed) };
}

export function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
