// AI Signal Engine 2.0
// Market data -> features -> 7 models -> regime-aware strategy selection -> meta score
// -> empirically calibrated probability -> expected return / risk / R:R -> quality grade.
// The risk engine (bot/riskEngine.js) then approves or rejects the trade.
import { fetchCandles, ex } from '../exchange/index.js';
import { getKlinesDeep } from '../exchange/binance.js';
import { last, computeAll } from './indicators.js';
import { ruleScore, ruleHistory } from './rules.js';
import { clamp, snapshot } from './technical.js';
import { trainAndPredict } from './mlModel.js';
import { supportResistance } from './patterns.js';
import { getFearGreed } from './sentiment.js';
import { claudeDecision } from './claude.js';
import { buildContext, runModels, MODEL_LABELS } from './models.js';
import { describeRegime } from './regime.js';
import { STRATEGY_LIBRARY, resolveStrategy, weightedScore, getStrategy, longBlocked, shortBlocked } from './strategies.js';
import { analyzeOrderFlow } from './orderflow.js';
import { analyzeFutures } from './futures.js';
import { newsForAsset } from './news.js';
import { baseAsset } from './util.js';

export const STRATEGIES = Object.fromEntries(Object.entries(STRATEGY_LIBRARY).map(([k, v]) => [k, v.name]));
export const ROUND_TRIP_COST_PCT = 0.3; // crypto: 2 x 0.1% fee + ~0.05% slippage each way
// Adapters with their own cost model (NSE forex) get a matching round-trip cost: fees + slippage both ways + spread.
export const roundTripCostPct = (exchange) => {
  const c = ex(exchange).costs;
  return c ? 2 * c.feeRate * 100 + (2 * c.slippageBps + c.spreadBps) / 100 : ROUND_TRIP_COST_PCT;
};

const OUTCOME_BARS = 48;
const calibCache = new Map();

// Did price hit TP before SL within `maxBars` after entering at the close of candle i?
export function tradeOutcome(candles, i, slDist, tpDist, maxBars = OUTCOME_BARS) {
  const entry = candles[i].close;
  for (let j = i + 1; j < Math.min(candles.length, i + 1 + maxBars); j++) {
    if (candles[j].low <= entry - slDist) return 0;
    if (candles[j].high >= entry + tpDist) return 1;
  }
  return null; // unresolved
}

// Mirror image for a short entered at the close of candle i: did price fall to the target before rising to the stop?
export function tradeOutcomeShort(candles, i, slDist, tpDist, maxBars = OUTCOME_BARS) {
  const entry = candles[i].close;
  for (let j = i + 1; j < Math.min(candles.length, i + 1 + maxBars); j++) {
    if (candles[j].high >= entry + slDist) return 0;
    if (candles[j].low <= entry - tpDist) return 1;
  }
  return null;
}

// Scores every past candle with the same strategy and records what happened next. This turns a raw
// score into an honest probability: "of the past setups that scored like this, how many reached TP first?"
function calibration(ctx, strategyId, key) {
  const lastTime = last(ctx.candles).time;
  const hit = calibCache.get(key);
  if (hit && hit.lastTime === lastTime) return hit.rows;
  const rows = [];
  for (let i = 60; i < ctx.candles.length - 1; i++) {
    const r = ctx.regimes[i];
    if (!r) continue;
    const strat = resolveStrategy(strategyId, r.regime);
    if (!strat.weights) continue;
    const m = runModels(ctx, i, { withMl: false });
    const atr = ctx.ind.atr[i];
    rows.push({
      score: weightedScore(m, { ...strat.weights, ml: 0, sentiment: 0 }),
      regime: r.regime,
      win: tradeOutcome(ctx.candles, i, (strat.sl ?? 2) * atr, (strat.tp ?? 3) * atr),
      winShort: tradeOutcomeShort(ctx.candles, i, (strat.sl ?? 2) * atr, (strat.tp ?? 3) * atr),
    });
  }
  calibCache.set(key, { lastTime, rows });
  return rows;
}

// `key` is 'win' for longs and 'winShort' for shorts: each side is calibrated on its own outcomes.
function probabilityFor(rows, score, regime, key = 'win') {
  const resolved = rows.filter((r) => r[key] !== null && r[key] !== undefined).map((r) => ({ ...r, win: r[key] }));
  if (resolved.length < 30) return { probability: null, samples: resolved.length, baseRate: null };
  const baseRate = resolved.reduce((s, r) => s + r.win, 0) / resolved.length;
  let similar = resolved.filter((r) => Math.abs(r.score - score) <= 12 && r.regime === regime);
  if (similar.length < 15) similar = resolved.filter((r) => Math.abs(r.score - score) <= 15);
  const wins = similar.reduce((s, r) => s + r.win, 0);
  const K = 10; // shrink toward the base rate when few similar setups exist
  return {
    probability: (wins + K * baseRate) / (similar.length + K),
    samples: similar.length,
    baseRate,
    rawHitRate: similar.length ? wins / similar.length : null,
  };
}

// Rule strategies: replay the rule over up to 3,000 closed candles of this coin (Binance) to measure
// its real win rate and expectancy after costs. Cached per closed candle.
const ruleCache = new Map();
async function ruleHistoryFor(strat, symbol, interval, exchange, candles) {
  const lastTime = last(candles).time;
  const key = `${exchange}:${symbol}:${interval}:${strat.rule}`;
  const hit = ruleCache.get(key);
  if (hit && hit.lastTime === lastTime) return hit.stats;
  let hist = candles;
  if (exchange === 'binance') {
    const deep = await getKlinesDeep(symbol, interval, 3000).catch(() => null);
    if (deep && deep.length > candles.length) hist = deep.filter((c) => c.time <= lastTime);
  }
  const stats = ruleHistory(strat, hist, computeAll(hist), ex(exchange).costs || {});
  ruleCache.set(key, { lastTime, stats });
  return stats;
}

function grade(edgeR, samples, regimeAligned) {
  if (edgeR >= 0.35 && samples >= 20 && regimeAligned) return 'A';
  if (edgeR >= 0.15) return 'B';
  if (edgeR > 0) return 'C';
  return 'D';
}

const settle = (p) => p.then((v) => v).catch(() => null);

export async function analyze(symbol, interval = '1h', opts = {}) {
  const {
    strategy: strategyId = 'adaptive', useClaude = false, forceClaude = false, position = null,
    threshold = 30, live = true, exchange = 'binance', allowShort = false,
  } = opts;
  const canShort = Boolean(allowShort && ex(exchange).canShort);
  const raw = opts.candles || (await fetchCandles(exchange, symbol, interval, 500));
  // Analysis always runs on closed candles; the live price comes from the forming one.
  const candles = opts.candles ? raw : raw.slice(0, -1);
  const price = opts.price ?? last(raw).close;
  const ctx = buildContext(candles, interval);
  const i = candles.length - 1;
  const atr = ctx.ind.atr[i] || price * 0.01;
  const regime = ctx.regimes[i];
  const regimeName = regime?.regime || 'SIDEWAYS';
  const strat = resolveStrategy(getStrategy(strategyId) ? strategyId : 'adaptive', regimeName);

  // ---- Models ----
  const ml = trainAndPredict(candles, { key: `${exchange}:${symbol}:${interval}` });
  const models = runModels(ctx, i, { withMl: false });
  const mlTrust = ml.accuracy === null ? 0 : Math.max(0.2, Math.min(1, (ml.accuracy - 0.45) * 10));
  models.ml = { score: clamp((ml.probUp - 0.5) * 200 * mlTrust), notes: [`P(up in ${ml.horizon || 3} bars) ${(ml.probUp * 100).toFixed(1)}%, validated accuracy ${ml.accuracy != null ? (ml.accuracy * 100).toFixed(1) + '%' : 'n/a'}`] };

  // ---- Live intelligence: order book, futures, news, fear & greed ----
  // Crypto-only inputs (Binance futures positioning, crypto news, crypto fear & greed) are skipped for forex.
  const asset = baseAsset(symbol);
  const crypto = ['crypto', 'perps'].includes(ex(exchange).market || 'crypto'); // perps: same coins, same positioning data
  const [orderFlow, futures, news, fng] = live
    ? await Promise.all([settle(analyzeOrderFlow(symbol, exchange)), crypto ? settle(analyzeFutures(symbol)) : null, crypto ? settle(newsForAsset(asset)) : null, crypto ? settle(getFearGreed()) : null])
    : [null, null, null, null];
  if (orderFlow) {
    const proxy = models.flow.score;
    models.flow = { score: clamp(proxy * 0.4 + orderFlow.score * 0.6), notes: [...orderFlow.notes, ...models.flow.notes] };
  }
  if (live) {
    const parts = [];
    const notes = [];
    if (news) { parts.push([news.sentiment, 0.4]); notes.push(`News sentiment ${news.sentiment} (${news.impact} impact, ${news.count} stories)`); }
    if (futures?.available) { parts.push([futures.score, 0.35]); notes.push(`Futures positioning ${futures.score > 0 ? '+' : ''}${futures.score}`); }
    if (fng) { parts.push([clamp((50 - fng.value) * 1.2), 0.25]); notes.push(`Fear & Greed ${fng.value} (${fng.label})`); }
    const w = parts.reduce((s, [, x]) => s + x, 0);
    models.sentiment = { score: w ? clamp(parts.reduce((s, [v, x]) => s + v * x, 0) / w) : 0, notes };
  }

  const weights = strat.weights || STRATEGY_LIBRARY.trend.weights;
  let score = strategyId === 'claude' ? 0 : strat.rule ? ruleScore(strat, candles, ctx.ind, i) : weightedScore(models, weights);

  // ---- Claude (optional meta-reviewer) ----
  let claude = null;
  const levels = supportResistance(candles);
  const wantClaude = strategyId === 'claude' || useClaude;
  if (wantClaude && (forceClaude || strategyId === 'claude' || Math.abs(score) >= threshold * 0.6 || position)) {
    claude = await claudeDecision({
      symbol, interval, price, regime: regime && { name: regime.label, confidence: regime.confidence, metrics: regime.metrics },
      strategy: strat.name, indicators: snapshot(candles, ctx.ind),
      models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { score: v.score, notes: v.notes }])),
      metaScore: score, mlForecast: { probUp: ml.probUp, accuracy: ml.accuracy },
      orderFlow: orderFlow && { score: orderFlow.score, buyPressure: orderFlow.buyPressure, imbalance: orderFlow.imbalance, spreadBps: orderFlow.spreadBps, absorption: orderFlow.absorption, spoofSuspects: orderFlow.spoofSuspects.length },
      futures: futures?.available ? { fundingRatePct: futures.fundingRatePct, oiChange24hPct: futures.oiChange24hPct, longShortRatio: futures.longShortRatio, relationship: futures.relationship, risks: futures.risks } : null,
      news: news && { sentiment: news.sentiment, impact: news.impact, headlines: news.headlines.slice(0, 5).map((h) => h.title) },
      supportResistance: levels, openPosition: position,
      recentCandles: candles.slice(-24).map((c) => [c.time, c.open, c.high, c.low, c.close, Math.round(c.volume)]),
    });
    if (claude.decision) {
      const d = claude.decision;
      models.claude = { score: d.action === 'BUY' ? d.confidence : d.action === 'SELL' ? -d.confidence : 0, notes: [d.reasoning] };
      // A rule's score is an on/off trigger, so Claude can veto it (below) but not blend into it.
      if (!strat.rule) score = strategyId === 'claude' ? models.claude.score : clamp(score * 0.6 + models.claude.score * 0.4);
    }
  }

  // ---- Trade geometry ----
  const slMult = strat.sl ?? 2;
  const tpMult = strat.tp ?? 3;
  // Pure ATR geometry - identical to what the calibration measured, so the probability applies to this exact trade.
  // (Support/resistance and Claude levels are shown separately as context.)
  const stopLoss = price - slMult * atr;
  const takeProfit = price + tpMult * atr;
  const claudeD = claude?.decision;
  const riskPct = ((price - stopLoss) / price) * 100;
  let rewardPct = ((takeProfit - price) / price) * 100;
  let rr = rewardPct / riskPct;

  // ---- Probability (empirical calibration on this coin's own history) ----
  let prob;
  let probability;
  let expectedReturnPct;
  if (strat.rule) {
    // Rule strategies exit on a trailing stop, not a fixed target, so the odds and payoff come from
    // replaying the rule itself. Both shrink toward a cautious prior when the history holds few trades.
    const hist = await ruleHistoryFor(strat, symbol, interval, exchange, candles);
    const n = hist.samples;
    const K = 5;
    prob = { probability: n ? (hist.wins + K * 0.35) / (n + K) : null, samples: n, baseRate: n ? hist.wins / n : null, rawHitRate: n ? hist.wins / n : null };
    probability = prob.probability ?? 0.35;
    if (n) {
      rewardPct = hist.avgWinPct;
      rr = hist.avgLossPct ? hist.avgWinPct / hist.avgLossPct : hist.avgWinPct ? 99 : 0;
    }
    expectedReturnPct = n ? (hist.expectancyPct * n) / (n + K) : 0; // already net of costs
  } else {
    const calibRows = calibration(ctx, getStrategy(strategyId) ? strategyId : 'adaptive', `${exchange}:${symbol}:${interval}:${strategyId}`);
    const coreScore = weightedScore(models, { ...weights, ml: 0, sentiment: 0, claude: 0 });
    prob = probabilityFor(calibRows, coreScore, regimeName);
    probability = prob.probability ?? 0.5;
    // Small, bounded adjustment from information the history cannot see (ML, live flow, news, Claude).
    const liveEdge = (score - coreScore) / 100;
    probability = Math.max(0.05, Math.min(0.95, probability + clamp(liveEdge * 15, -8, 8) / 100));
    expectedReturnPct = probability * rewardPct - (1 - probability) * riskPct - roundTripCostPct(exchange);
  }
  const edgeR = expectedReturnPct / riskPct;

  // ---- Decision ----
  const blockReason = longBlocked(strat, regimeName, models.htf?.regime);
  const blocked = Boolean(blockReason);
  let signal = 'WAIT';
  const reasons = [];
  const shortPos = position?.side === 'short';
  if (shortPos) {
    // An open short is covered when the model turns bullish or the market breaks out.
    if (score >= threshold || ['BREAKOUT', 'BULL_TREND'].includes(regimeName)) signal = 'EXIT';
  } else if (score <= -threshold || (position && ['BREAKDOWN', 'PANIC'].includes(regimeName))) signal = 'EXIT';
  else if (score >= threshold && !blocked && expectedReturnPct > 0) signal = 'LONG';
  if (score >= threshold && blocked) reasons.push(`Score ${score} is bullish but the ${blockReason} blocks new spot longs for ${strat.name}`);
  if (signal === 'WAIT' && Math.abs(score) < threshold) reasons.push(`Meta score ${score} is inside the no-trade zone (entry needs ${threshold}+)`);
  if (score >= threshold && expectedReturnPct <= 0) reasons.push(`Expected return ${expectedReturnPct.toFixed(2)}% after costs is not positive`);
  if (claudeD && signal === 'LONG' && claudeD.action !== 'BUY' && claudeD.confidence >= 70) {
    signal = 'WAIT';
    reasons.push(`Claude vetoed the entry (${claudeD.action}, ${claudeD.confidence}% confidence)`);
  }
  // ---- Short side (adapters that can sell first, bot opted in): same models, mirrored geometry and calibration ----
  let side = 'long';
  let short = null;
  if (canShort && !position && !strat.rule && score <= -threshold) {
    const sStop = price + slMult * atr;
    const sTake = price - tpMult * atr;
    const sRisk = ((sStop - price) / price) * 100;
    const sReward = ((price - sTake) / price) * 100;
    const calibRows = calibration(ctx, getStrategy(strategyId) ? strategyId : 'adaptive', `${exchange}:${symbol}:${interval}:${strategyId}`);
    const coreScore = weightedScore(models, { ...weights, ml: 0, sentiment: 0, claude: 0 });
    const sProb = probabilityFor(calibRows, coreScore, regimeName, 'winShort');
    let p = sProb.probability ?? 0.5;
    p = Math.max(0.05, Math.min(0.95, p + clamp(((coreScore - score) / 100) * 15, -8, 8) / 100)); // bearish live edge raises it
    const sExp = p * sReward - (1 - p) * sRisk - roundTripCostPct(exchange);
    const sBlock = shortBlocked(strat, regimeName, models.htf?.regime);
    short = { stopLoss: sStop, takeProfit: sTake, riskPct: sRisk, rewardPct: sReward, rr: sReward / sRisk, probability: p, prob: sProb, expectedReturnPct: sExp };
    if (sBlock) reasons.push(`Score ${score} is bearish but the ${sBlock} blocks new shorts`);
    else if (sExp <= 0) reasons.push(`Short expected return ${sExp.toFixed(2)}% after costs is not positive`);
    else if (claudeD && claudeD.action !== 'SELL' && claudeD.confidence >= 70) reasons.push(`Claude vetoed the short (${claudeD.action}, ${claudeD.confidence}% confidence)`);
    else signal = 'SHORT';
    if (signal === 'SHORT') side = 'short';
  }
  const sh = side === 'short' ? short : null;
  const outStop = sh ? sh.stopLoss : stopLoss;
  const outTake = sh ? sh.takeProfit : takeProfit;
  const outProb = sh ? sh.probability : probability;
  const outExp = sh ? sh.expectedReturnPct : expectedReturnPct;
  const outRisk = sh ? sh.riskPct : riskPct;
  const outReward = sh ? sh.rewardPct : rewardPct;
  const outRr = sh ? sh.rr : rr;
  const outEdgeR = sh ? sh.expectedReturnPct / sh.riskPct : edgeR;
  const outSamples = sh ? sh.prob.samples : prob.samples;
  const outBase = sh ? sh.prob.baseRate : prob.baseRate;

  const regimeAligned = !strat.regimes?.length || strat.regimes.includes(regimeName) || Boolean(strat.adaptiveFrom);
  const quality = grade(outEdgeR, outSamples, regimeAligned);

  const drivers = Object.entries(models)
    .flatMap(([k, v]) => (v.notes || []).slice(0, 2).map((n) => ({ model: MODEL_LABELS[k] || 'Claude', note: n, score: v.score })))
    .filter((d) => Math.abs(d.score) >= 15)
    .slice(0, 10);

  return {
    symbol, interval, exchange, time: Date.now(), price,
    strategy: strategyId, strategyUsed: strat.id, strategyName: strat.name,
    signal, side,
    action: signal === 'LONG' ? 'BUY' : signal === 'SHORT' ? 'SELL' : signal === 'EXIT' ? (shortPos ? 'BUY' : 'SELL') : 'HOLD', // v1 compatibility
    score, confidence: Math.abs(score),
    probability: +outProb.toFixed(4),
    probabilitySamples: outSamples,
    baseRate: outBase !== null && outBase !== undefined ? +outBase.toFixed(4) : null,
    expectedReturnPct: +outExp.toFixed(3),
    expectedRiskPct: +outRisk.toFixed(3),
    rewardPct: +outReward.toFixed(3),
    rr: +outRr.toFixed(2),
    edgeR: +outEdgeR.toFixed(3),
    quality,
    stopLoss: +outStop.toFixed(8),
    takeProfit: +outTake.toFixed(8),
    short: short && { probability: +short.probability.toFixed(4), expectedReturnPct: +short.expectedReturnPct.toFixed(3), rr: +short.rr.toFixed(2) },
    atr,
    regime: regime ? { name: regimeName, label: regime.label, confidence: regime.confidence, metrics: regime.metrics, description: describeRegime(regime), recommended: strat.name } : null,
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { label: MODEL_LABELS[k] || 'Claude AI', score: v.score, notes: v.notes }])),
    components: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.score])),
    weights,
    drivers, reasons,
    indicators: snapshot(candles, ctx.ind),
    ml, levels,
    patterns: models.pattern?.patterns || [],
    orderFlow, futures, news,
    sentiment: fng ? { value: fng.value, label: fng.label } : null,
    claude,
  };
}
