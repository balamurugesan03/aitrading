// AI Trade Journal: captures the full context at entry and exit, explains every closed trade,
// and mines the history for recurring mistakes ("your biggest losses happen when...").
import { db } from '../db/index.js';
import { reviewTrade } from './claude.js';

// Snapshot of the decision context stored with the position at entry.
export function entryContext(signal, candles) {
  const c = candles.at(-1);
  const atr = signal.atr || c.close * 0.01;
  const ema21 = signal.indicators?.ema21;
  return {
    time: Date.now(),
    regime: signal.regime?.name,
    strategy: signal.strategyUsed,
    score: signal.score,
    probability: signal.probability,
    quality: signal.quality,
    expectedReturnPct: signal.expectedReturnPct,
    rr: signal.rr,
    atr,
    atrPercentile: signal.regime?.metrics?.atrPercentile,
    volRatio: signal.regime?.metrics?.volRatio,
    extensionAtr: ema21 ? +((c.close - ema21) / atr).toFixed(2) : null,
    run6Atr: candles.length > 6 ? +((c.close - candles.at(-7).close) / atr).toFixed(2) : null,
    orderFlow: signal.orderFlow?.score ?? null,
    news: signal.news?.sentiment ?? null,
    hourUtc: new Date().getUTCHours(),
  };
}

const RULES = {
  entryLate: 'Do not enter when price is more than 2 ATR above EMA21 - wait for a pullback.',
  volatility: 'Cut size or skip entries when volatility expands (ATR percentile above 80).',
  gaveBack: 'Tighten the trailing stop once a trade reaches +1R so winners do not turn into losers.',
  regimeFlip: 'Exit or tighten stops as soon as the regime flips away from the entry regime.',
  lowVolume: 'Avoid entries when volume is below 80% of its 20-bar average.',
  lowQuality: 'Raise the minimum signal quality to B.',
  wrongDirection: 'The thesis was wrong from the start - review which model drove the entry.',
};

export async function journalClosedTrade({ bot, position, exit }) {
  const e = position.entryContext || {};
  const dir = position.side === 'short' ? -1 : 1; // shorts profit when price falls
  const R = dir * (position.entry - position.initialStop) || position.entry * 0.01;
  const mfeR = (dir > 0 ? (position.highest ?? position.entry) - position.entry : position.entry - (position.lowest ?? position.entry)) / R;
  const maeR = (dir > 0 ? position.entry - (position.lowest ?? position.entry) : (position.highest ?? position.entry) - position.entry) / R;
  const pnlPct = ((dir * (exit.price - position.entry)) / position.entry) * 100;
  const resultR = (dir * (exit.price - position.entry)) / R;

  const checks = [];
  const check = (key, ok, text) => checks.push({ key, ok, text });
  check('wrongDirection', mfeR >= 0.5, mfeR >= 0.5 ? `Direction correct (reached +${mfeR.toFixed(2)}R)` : `Direction wrong (best +${mfeR.toFixed(2)}R)`);
  if (e.extensionAtr !== null && e.extensionAtr !== undefined) check('entryLate', e.extensionAtr <= 2, e.extensionAtr <= 2 ? 'Entry timing fine' : `Entry late: ${e.extensionAtr} ATR above EMA21`);
  if (exit.atr && e.atr) check('volatility', exit.atr / e.atr <= 1.3, exit.atr / e.atr <= 1.3 ? 'Volatility stable' : `Volatility rose ${((exit.atr / e.atr - 1) * 100).toFixed(0)}% during the trade`);
  check('gaveBack', !(mfeR >= 1 && resultR < 0), mfeR >= 1 && resultR < 0 ? `Gave back a +${mfeR.toFixed(2)}R open profit` : 'Profit management fine');
  if (e.regime && exit.regime) check('regimeFlip', e.regime === exit.regime, e.regime === exit.regime ? `Regime held (${e.regime})` : `Regime changed ${e.regime} -> ${exit.regime}`);
  if (e.volRatio !== undefined && e.volRatio !== null) check('lowVolume', e.volRatio >= 0.8, e.volRatio >= 0.8 ? 'Entry volume adequate' : `Entered on low volume (${e.volRatio}x average)`);
  if (e.quality) check('lowQuality', ['A', 'B'].includes(e.quality), `Signal quality ${e.quality}`);

  const failed = checks.filter((c) => !c.ok);
  const manual = /^(Kill switch|Manual)/.test(exit.reason || '');
  const recommendation = manual ? 'Closed manually - not a strategy outcome, excluded from rule mining.' : pnlPct < 0 && failed.length ? RULES[failed[0].key] : pnlPct >= 0 ? 'Setup worked - keep the rules that produced it.' : 'Loss within plan - stop did its job.';
  const tags = manual ? ['manual-exit'] : [
    e.regime && `regime:${e.regime}`, e.strategy && `strategy:${e.strategy}`, e.quality && `quality:${e.quality}`,
    e.volRatio < 0.8 && 'low-volume', e.atrPercentile > 80 && 'high-volatility', e.extensionAtr > 2 && 'extended-entry',
    e.hourUtc !== undefined && `session:${e.hourUtc < 8 ? 'asia' : e.hourUtc < 14 ? 'europe' : 'us'}`,
  ].filter(Boolean);

  const entry = {
    userId: bot?.userId, botId: bot?._id, botName: bot?.name, symbol: bot?.symbol, mode: bot?.mode, exchange: bot?.exchange || 'binance',
    entryPrice: position.entry, exitPrice: exit.price, openedAt: position.openedAt, closedAt: Date.now(),
    pnl: exit.pnl, pnlPct: +pnlPct.toFixed(3), resultR: +resultR.toFixed(2), mfeR: +mfeR.toFixed(2), maeR: +maeR.toFixed(2),
    exitReason: exit.reason, entryContext: e, exitContext: { regime: exit.regime, atr: exit.atr },
    checks, recommendation, tags, time: Date.now(),
  };
  if (bot?.useClaude) entry.aiReview = await reviewTrade(entry);
  return db.journal.insert(entry);
}

// Mines the journal for the conditions that cost (or made) the most.
export async function journalInsights(userId) {
  const rows = await db.journal.find({ userId }, { sort: { time: -1 }, limit: 500 });
  const groups = new Map();
  for (const r of rows) {
    for (const t of r.tags || []) {
      const g = groups.get(t) || { tag: t, trades: 0, wins: 0, pnlPct: 0 };
      g.trades++;
      if (r.pnlPct > 0) g.wins++;
      g.pnlPct += r.pnlPct;
      groups.set(t, g);
    }
  }
  const stats = [...groups.values()].map((g) => ({ ...g, pnlPct: +g.pnlPct.toFixed(2), winRate: +((g.wins / g.trades) * 100).toFixed(1) }));
  const describe = (tag) => {
    const [k, v] = tag.split(':');
    return {
      regime: `entering in a ${v?.replace('_', ' ').toLowerCase()} regime`, strategy: `using the ${v} strategy`, quality: `taking grade ${v} signals`,
      session: `trading the ${v} session`, 'low-volume': 'entering on low volume', 'high-volatility': 'entering during high volatility', 'extended-entry': 'entering after price has run far above EMA21',
    }[k] || tag;
  };
  const worst = stats.filter((s) => s.trades >= 3 && s.pnlPct < 0).sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 3);
  const best = stats.filter((s) => s.trades >= 3 && s.pnlPct > 0).sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 3);
  const mistakes = new Map();
  rows.filter((r) => r.pnlPct < 0).forEach((r) => r.checks.filter((c) => !c.ok).forEach((c) => mistakes.set(c.key, (mistakes.get(c.key) || 0) + 1)));
  const losses = rows.filter((r) => r.pnlPct < 0).length;
  return {
    totalTrades: rows.length,
    insights: [
      ...worst.map((w) => `Your biggest losses happen when ${describe(w.tag)} (${w.trades} trades, ${w.pnlPct}% total, ${w.winRate}% win rate).`),
      ...best.map((b) => `Your best results come from ${describe(b.tag)} (${b.trades} trades, +${b.pnlPct}% total).`),
    ],
    commonMistakes: [...mistakes.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, count: n, pctOfLosses: losses ? +((n / losses) * 100).toFixed(0) : 0, rule: RULES[key] })),
    byTag: stats.sort((a, b) => b.trades - a.trades),
  };
}
