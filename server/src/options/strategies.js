// Defined-risk option strategies: templates, leg building from the live chain, validation and analysis.
// "Defined risk" is checked on the payoff itself: a position is accepted only if its worst case at expiry is finite,
// so any sold option must be covered by a bought one (spreads / condors), never naked.
import { analyzePayoff, probabilityOfProfit, positionGreeks, yearsTo } from './pricing.js';
import { optionFee } from '../exchange/nfo.js';

export const TEMPLATES = {
  long_call: { name: 'Long Call', view: 'bullish', legs: 1, description: 'Buy an at-the-money call. Loss limited to the premium paid.' },
  long_put: { name: 'Long Put', view: 'bearish', legs: 1, description: 'Buy an at-the-money put. Loss limited to the premium paid.' },
  bull_call_spread: { name: 'Bull Call Spread', view: 'bullish', legs: 2, description: 'Buy an ATM call, sell a higher call. Cheaper than a call; profit capped at the width.' },
  bear_put_spread: { name: 'Bear Put Spread', view: 'bearish', legs: 2, description: 'Buy an ATM put, sell a lower put. Cheaper than a put; profit capped at the width.' },
  iron_condor: { name: 'Iron Condor', view: 'neutral', legs: 4, description: 'Sell an OTM put and call, buy further wings. Profits if the index stays in a range; loss capped by the wings.' },
};

// Builds the legs of a template from the chain. width = strikes between bought and sold legs; distance = strikes
// from ATM to the sold legs of a condor. Prices are what the trade would really pay: ask for buys, bid for sells.
export function buildLegs(chain, { template, width = 2, distance = 4, lots = 1 }) {
  const t = TEMPLATES[template];
  if (!t) throw Object.assign(new Error(`Unknown strategy ${template}`), { status: 400 });
  const strikes = chain.rows.map((r) => r.strike);
  const atm = strikes.indexOf(chain.atmStrike);
  const at = (offset) => chain.rows[Math.max(0, Math.min(strikes.length - 1, atm + offset))];
  const leg = (row, type, side) => {
    const q = type === 'CE' ? row.call : row.put;
    if (!q) throw Object.assign(new Error(`No ${type} at strike ${row.strike}`), { status: 400 });
    const price = side === 'BUY' ? q.ask || q.ltp : q.bid || q.ltp;
    return { tradingsymbol: q.tradingsymbol, type, strike: row.strike, side, lots, qty: lots * chain.lotSize, price, mid: q.mid, iv: q.iv, spreadPct: q.spreadPct, bid: q.bid, ask: q.ask };
  };
  const w = Math.max(1, Math.round(width));
  const d = Math.max(1, Math.round(distance));
  switch (template) {
    case 'long_call': return [leg(at(0), 'CE', 'BUY')];
    case 'long_put': return [leg(at(0), 'PE', 'BUY')];
    case 'bull_call_spread': return [leg(at(0), 'CE', 'BUY'), leg(at(w), 'CE', 'SELL')];
    case 'bear_put_spread': return [leg(at(0), 'PE', 'BUY'), leg(at(-w), 'PE', 'SELL')];
    case 'iron_condor': return [leg(at(-d - w), 'PE', 'BUY'), leg(at(-d), 'PE', 'SELL'), leg(at(d), 'CE', 'SELL'), leg(at(d + w), 'CE', 'BUY')];
    default: throw Object.assign(new Error('Unknown strategy'), { status: 400 });
  }
}

// Full picture of a set of legs: payoff, max profit/loss, breakevens, probability of profit, greeks, net premium,
// round-trip charges, liquidity. Money values are in rupees for the whole quantity.
export function analyzeLegs(legs, chain) {
  const t = yearsTo(chain.expiryMs);
  const payoff = analyzePayoff(legs, chain.spot);
  const atmIv = (chain.atmIv || 15) / 100;
  const greeks = positionGreeks(legs, chain.spot, t, (l) => (l.iv || chain.atmIv || 15) / 100);
  const netPremium = legs.reduce((s, l) => s + (l.side === 'BUY' ? -1 : 1) * l.price * l.qty, 0); // < 0 debit, > 0 credit
  const charges = legs.reduce((s, l) => s + optionFee(l.price * l.qty, l.side) + optionFee(l.price * l.qty, l.side === 'BUY' ? 'SELL' : 'BUY'), 0);
  // Covered: per option type, at least as many bought as sold (a short put's loss is finite on paper - the index
  // cannot go below zero - but it is still naked, so the payoff test alone is not enough).
  const covered = ['CE', 'PE'].every((ty) => legs.filter((l) => l.type === ty && l.side === 'BUY').reduce((s, l) => s + l.qty, 0) >= legs.filter((l) => l.type === ty && l.side === 'SELL').reduce((s, l) => s + l.qty, 0));
  const definedRisk = covered && Number.isFinite(payoff.maxLoss);
  const maxLoss = definedRisk ? Math.abs(Math.min(0, payoff.maxLoss)) + charges : Infinity;
  const maxProfit = Number.isFinite(payoff.maxProfit) ? payoff.maxProfit - charges : Infinity;
  const worstSpread = Math.max(0, ...legs.map((l) => l.spreadPct ?? 100));
  // Cheap far-out options always look wide in percent; a spread of a few ticks is still fine to trade.
  const worstSpreadAbs = Math.max(0, ...legs.map((l) => (l.bid > 0 && l.ask > 0 ? l.ask - l.bid : Infinity)));
  return {
    legs, definedRisk, covered, netPremium: +netPremium.toFixed(2), type: netPremium < 0 ? 'debit' : 'credit',
    maxProfit: Number.isFinite(maxProfit) ? +maxProfit.toFixed(2) : null, maxLoss: Number.isFinite(maxLoss) ? +maxLoss.toFixed(2) : null,
    breakevens: payoff.breakevens, charges: +charges.toFixed(2),
    rewardRisk: Number.isFinite(maxProfit) && Number.isFinite(maxLoss) && maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : null,
    pop: +probabilityOfProfit(legs, chain.spot, t, atmIv).toFixed(3),
    greeks: { delta: +greeks.delta.toFixed(2), gamma: +greeks.gamma.toFixed(4), theta: +greeks.theta.toFixed(2), vega: +greeks.vega.toFixed(2) },
    worstSpreadPct: +worstSpread.toFixed(2), worstSpreadAbs: Number.isFinite(worstSpreadAbs) ? +worstSpreadAbs.toFixed(2) : null, curve: payoff.curve, spot: chain.spot, daysToExpiry: chain.daysToExpiry,
  };
}

// Manual legs from the builder: same underlying/expiry, whole lots, at most 4 legs. Prices come from the chain.
export function legsFromRequest(chain, reqLegs = []) {
  if (!Array.isArray(reqLegs) || !reqLegs.length || reqLegs.length > 4) throw Object.assign(new Error('Give 1 to 4 legs'), { status: 400 });
  const bySym = new Map();
  chain.rows.forEach((r) => { if (r.call) bySym.set(r.call.tradingsymbol, { ...r.call, type: 'CE', strike: r.strike }); if (r.put) bySym.set(r.put.tradingsymbol, { ...r.put, type: 'PE', strike: r.strike }); });
  return reqLegs.map((l) => {
    const q = bySym.get(l.tradingsymbol);
    if (!q) throw Object.assign(new Error(`${l.tradingsymbol} is not in the ${chain.underlying} ${chain.expiry} chain shown`), { status: 400 });
    if (!['BUY', 'SELL'].includes(l.side)) throw Object.assign(new Error('Leg side must be BUY or SELL'), { status: 400 });
    const lots = Math.max(1, Math.floor(Number(l.lots) || 1));
    const price = l.side === 'BUY' ? q.ask || q.ltp : q.bid || q.ltp;
    return { tradingsymbol: q.tradingsymbol, type: q.type, strike: q.strike, side: l.side, lots, qty: lots * chain.lotSize, price, mid: q.mid, iv: q.iv, spreadPct: q.spreadPct, bid: q.bid, ask: q.ask };
  });
}

export const scaleLegs = (legs, lots, lotSize) => legs.map((l) => ({ ...l, lots: l.lots * lots, qty: l.lots * lots * lotSize }));
