// Dynamic Risk Engine 2.0
// Base risk -> volatility -> drawdown -> strategy performance -> regime -> news -> futures -> signal quality
// -> hard gates (kill switch, limits, exposure, correlation) -> final position size or REJECT.
import { db } from '../db/index.js';
import { getSettings, updateSettings } from './safety.js';
import { valuePortfolio, correlation, fxCorrelation } from '../ai/portfolio.js';
import { symbolInfo, isFx, accountOf } from '../exchange/index.js';
import { REGIMES } from '../ai/regime.js';
import { baseAsset } from '../ai/util.js';
import { startOfDay } from './risk.js';
import { macroEventRisk } from '../ai/news.js';

const QUALITY_RANK = { A: 4, B: 3, C: 2, D: 1 };
const QUALITY_FACTOR = { A: 1.25, B: 1, C: 0.5, D: 0 };

function profitFactor(trades) {
  const win = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return loss ? win / loss : win ? 99 : 1;
}

export async function strategyPerformance(bot, strategyId, userId) {
  const all = (await db.trades.find({ userId: bot?.userId || userId }, { sort: { time: -1 } })).filter((t) => t.pnl !== undefined);
  let rows = bot ? all.filter((t) => t.botId === bot._id) : [];
  let scope = 'bot';
  if (rows.length < 10) {
    rows = all.filter((t) => t.signal?.strategy === strategyId);
    scope = 'strategy';
  }
  rows = rows.slice(0, 20);
  let streak = 0;
  for (const t of rows) {
    if (t.pnl > 0) break;
    streak++;
  }
  return { trades: rows.length, profitFactor: +profitFactor(rows).toFixed(2), winRate: rows.length ? rows.filter((t) => t.pnl > 0).length / rows.length : null, losingStreak: streak, scope };
}

// Crypto (USDT), NSE forex and NSE stocks (INR) are separate accounts: equity, peak, drawdown and P&L per account.
export async function accountState(user, mode, exchange = 'binance') {
  const settings = await getSettings(user._id);
  const account = accountOf(exchange);
  const pf = await valuePortfolio(user, mode, exchange);
  const peakKey = { crypto: mode, fx: `${mode}Fx`, stocks: `${mode}Stocks` }[account];
  const peak = Math.max(settings.peakEquity[peakKey] || 0, pf.total);
  if (peak > (settings.peakEquity[peakKey] || 0)) await updateSettings(user._id, { peakEquity: { [peakKey]: peak } });
  const trades = (await db.trades.find({ mode, userId: user._id })).filter((t) => accountOf(t.exchange) === account);
  const realizedToday = trades.filter((t) => t.time >= startOfDay() && t.pnl !== undefined).reduce((s, t) => s + t.pnl, 0);
  const cash = pf.assets.filter((a) => a.stable).reduce((s, a) => s + a.value, 0);
  return {
    currency: pf.currency, equity: pf.total, cash, peak,
    drawdownPct: peak ? ((peak - pf.total) / peak) * 100 : 0,
    exposurePct: 100 - pf.stablePct,
    holdings: pf.assets.filter((a) => !a.stable && a.value > 5),
    realizedToday,
  };
}

/**
 * Evaluates a signal for execution. Returns the full decision trail.
 * @param signal  output of analyze()
 * @param opts    { bot, mode, account (optional precomputed) }
 */
export async function evaluateRisk(signal, { user, bot = null, mode = 'paper', account, exchange = 'binance' } = {}) {
  const settings = await getSettings(user._id);
  const R = settings.risk;
  const acct = account || (await accountState(user, mode, exchange));
  const steps = [];
  const gates = [];
  const base = bot?.riskPct ?? R.baseRiskPct;
  let risk = base;
  const step = (name, factor, note) => {
    risk *= factor;
    steps.push({ name, factor: +factor.toFixed(2), riskAfter: +risk.toFixed(3), note });
  };
  steps.push({ name: 'Base risk', factor: 1, riskAfter: base, note: `${base}% of equity per trade` });

  // 1. Volatility
  const atrPctile = signal.regime?.metrics?.atrPercentile ?? 50;
  step('Volatility', atrPctile > 95 ? 0.25 : atrPctile > 80 ? 0.5 : 1, `ATR at the ${atrPctile}th percentile`);
  // 2. Drawdown
  const dd = acct.drawdownPct;
  step('Drawdown', dd >= R.maxDrawdownHaltPct ? 0 : dd > 15 ? 0.25 : dd > 10 ? 0.5 : dd > 5 ? 0.75 : 1, `Account ${dd.toFixed(1)}% below its peak`);
  // 3. Strategy performance
  const perf = await strategyPerformance(bot, signal.strategyUsed || signal.strategy, user._id);
  let perfFactor = 1;
  let perfNote = `${perf.trades} closed trades (${perf.scope}) - not enough history to judge`;
  if (perf.trades >= 10) {
    perfFactor = perf.profitFactor < 0.8 ? 0 : perf.profitFactor < 1 ? 0.5 : 1;
    perfNote = `Profit factor ${perf.profitFactor} over the last ${perf.trades} trades${perfFactor === 0 ? ' - strategy disabled until re-validated' : ''}`;
  }
  if (perf.losingStreak >= 3) {
    perfFactor *= 0.5;
    perfNote += `; ${perf.losingStreak} losses in a row`;
  }
  step('Strategy performance', perfFactor, perfNote);
  // 4. Regime
  const regimeName = signal.regime?.name || 'SIDEWAYS';
  step('Market regime', REGIMES[regimeName]?.risk ?? 0.75, `${REGIMES[regimeName]?.label || regimeName}`);
  // 5. News
  if (signal.news) step('News', signal.news.riskMultiplier ?? 1, `Sentiment ${signal.news.sentiment}, impact ${signal.news.impact}`);
  // 5b. Scheduled macro events (CPI, FOMC, NFP...)
  const macro = await macroEventRisk().catch(() => null);
  if (macro) step('Macro calendar', macro.multiplier, macro.note);
  // 6. Futures leverage
  if (signal.futures?.available) step('Futures leverage', signal.futures.squeezeRisk ? 0.75 : 1, signal.futures.squeezeRisk ? 'Squeeze risk detected' : signal.futures.relationship);
  // 7. Signal quality
  step('Signal quality', QUALITY_FACTOR[signal.quality] ?? 0, `Grade ${signal.quality} (edge ${signal.edgeR}R per trade)`);
  const capped = Math.min(risk, base * 1.25, R.maxRiskPct);
  if (capped < risk) steps.push({ name: 'Cap', factor: +(capped / risk).toFixed(2), riskAfter: +capped.toFixed(3), note: `Max ${Math.min(base * 1.25, R.maxRiskPct).toFixed(2)}%` });
  risk = capped;

  // ---- Hard gates ----
  const gate = (name, pass, note) => gates.push({ name, pass, note });
  gate('Kill switch', settings.tradingEnabled, settings.tradingEnabled ? 'Auto-trading enabled' : settings.platformHalt ? `Platform halt: ${settings.platformHalt}` : `Trading disabled${settings.killSwitchReason ? `: ${settings.killSwitchReason}` : ''}`);
  gate('Signal', signal.signal === 'LONG' || signal.signal === 'SHORT', `Signal is ${signal.signal}`);
  gate('Expected return', signal.expectedReturnPct > 0, `${signal.expectedReturnPct}% after costs`);
  gate('Reward : risk', signal.rr >= R.minRR, `${signal.rr} (min ${R.minRR})`);
  gate('Quality', (QUALITY_RANK[signal.quality] || 0) >= QUALITY_RANK[R.minQuality], `${signal.quality} (min ${R.minQuality})`);
  gate('Risk budget', risk > 0, risk > 0 ? `${risk.toFixed(2)}% risk` : 'Risk reduced to zero by the steps above');
  const dailyLimit = bot?.dailyLossLimitPct ?? R.dailyLossLimitPct;
  const lostPct = acct.realizedToday < 0 ? (Math.abs(acct.realizedToday) / acct.equity) * 100 : 0;
  gate('Daily loss limit', lostPct < dailyLimit, `${lostPct.toFixed(2)}% lost today (limit ${dailyLimit}%)`);
  const openBots = await db.bots.find({ mode, userId: user._id });
  const openCount = openBots.filter((b) => b.position).length;
  gate('Open positions', openCount < R.maxOpenPositions, `${openCount} open (max ${R.maxOpenPositions})`);

  // Correlation with what is already held
  const asset = baseAsset(signal.symbol);
  // A short only concentrates risk with other shorts (a long in a correlated pair is a hedge), and vice versa.
  const wantSide = signal.signal === 'SHORT' ? 'short' : 'long';
  const others = acct.holdings.filter((h) => h.asset !== asset && (h.side || 'long') === wantSide);
  const corrOf = isFx(exchange) ? (a, b) => fxCorrelation(exchange, a, b) : correlation;
  const corrs = await Promise.all(others.map(async (h) => ({ asset: h.asset, corr: await corrOf(asset, h.asset).catch(() => 0), value: h.value })));
  const correlated = corrs.filter((c) => c.corr >= R.correlationLimit);
  gate('Correlation', correlated.length < R.maxCorrelatedPositions,
    correlated.length ? `${asset} moves with ${correlated.map((c) => `${c.asset} (${c.corr.toFixed(2)})`).join(', ')}` : 'No highly correlated holdings');

  // ---- Position size ----
  const riskAmount = acct.equity * (risk / 100);
  let notional = signal.expectedRiskPct > 0 ? riskAmount / (signal.expectedRiskPct / 100) : 0;
  const maxPos = acct.equity * ((bot?.maxPositionPct ?? 25) / 100);
  const headroom = Math.max(0, acct.equity * (R.maxExposurePct / 100) - (acct.equity * acct.exposurePct) / 100);
  notional = Math.min(notional, maxPos, acct.cash * 0.995, headroom);
  const info = await symbolInfo(exchange, signal.symbol).catch(() => null);
  const minNotional = Math.max(10, info?.minNotional || 0);
  gate('Exposure', headroom >= minNotional, `Exposure ${acct.exposurePct.toFixed(1)}% (max ${R.maxExposurePct}%)`);
  gate('Position size', notional >= minNotional, `${notional.toFixed(2)} ${acct.currency || 'USDT'} (min ${minNotional.toFixed(2)}${info?.stepSize > 1 ? ' = 1 lot' : ''})`);

  const approved = gates.every((g) => g.pass);
  return {
    approved,
    decision: approved ? 'APPROVED' : 'REJECTED',
    rejectedBy: gates.filter((g) => !g.pass).map((g) => g.name),
    finalRiskPct: +risk.toFixed(3),
    steps, gates,
    position: approved ? { notional: +notional.toFixed(2), riskAmount: +riskAmount.toFixed(2), qty: notional / signal.price } : null,
    account: { currency: acct.currency || 'USDT', equity: +acct.equity.toFixed(2), drawdownPct: +acct.drawdownPct.toFixed(2), exposurePct: +acct.exposurePct.toFixed(1), openPositions: openCount },
    strategyPerformance: perf,
  };
}
