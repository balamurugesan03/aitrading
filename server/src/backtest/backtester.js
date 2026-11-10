// Backtesting Lab 2.0
// - Multi-coin x multi-timeframe
// - Train / validation / out-of-sample split (default 70 / 15 / 15)
// - Anchored walk-forward testing
// - Monte Carlo resampling of trade results
// - Parameter optimizer (picked on train, confirmed on validation, reported on out-of-sample)
// - Costs: taker fees, spread, slippage, latency (next-bar fills), funding
// The neural net is retrained walk-forward, so no bar ever sees its own future.
import { getKlinesDeep } from '../exchange/binance.js';
import { ex, fetchCandles } from '../exchange/index.js';
import { buildContext, runModels } from '../ai/models.js';
import { fitEnsemble } from '../ai/mlModel.js';
import { resolveStrategy, weightedScore, STRATEGY_LIBRARY, getStrategy, longBlocked, shortBlocked } from '../ai/strategies.js';
import { REGIMES } from '../ai/regime.js';
import { clamp } from '../ai/technical.js';
import { ruleScore } from '../ai/rules.js';

const HORIZON = 3;
const RETRAIN_MIN = 250;
const TRAIN_WINDOW = 1500;
const BARS_PER_YEAR = { '1m': 525600, '5m': 105120, '15m': 35040, '30m': 17520, '1h': 8760, '4h': 2190, '1d': 365 };
const HOURS_PER_BAR = { '1m': 1 / 60, '5m': 1 / 12, '15m': 0.25, '30m': 0.5, '1h': 1, '4h': 4, '1d': 24 };

const baseCache = new Map();

// Expensive part, shared by every strategy: candles, indicators, regimes and walk-forward ML predictions.
export async function prepareBase(symbol, interval, count, exchange = 'binance') {
  const key = `${exchange}:${symbol}:${interval}:${count}`;
  const hit = baseCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.base;
  // Binance pages through years of history; other exchanges (NSE forex: the current futures contract) give what they have.
  const candles = exchange === 'binance' ? await getKlinesDeep(symbol, interval, count) : await fetchCandles(exchange, symbol, interval, count);
  if (candles.length < 400) throw new Error(`Not enough history for ${symbol} ${interval} (${candles.length} candles)`);
  const ctx = buildContext(candles, interval);
  const RETRAIN_EVERY = Math.max(RETRAIN_MIN, Math.ceil(candles.length / 40)); // cap at ~40 retrains on long histories
  const mlProb = new Array(candles.length).fill(null);
  let predictor = null;
  for (let i = 300; i < candles.length; i++) {
    if ((i - 300) % RETRAIN_EVERY === 0) {
      const X = [];
      const y = [];
      for (let j = Math.max(0, i - HORIZON - TRAIN_WINDOW); j < i - HORIZON; j++) {
        if (!ctx.feats[j]) continue;
        X.push(ctx.feats[j]);
        y.push(candles[j + HORIZON].close > candles[j].close ? 1 : 0);
      }
      predictor = X.length >= 100 ? fitEnsemble(X, y) : null;
    }
    if (predictor && ctx.feats[i]) mlProb[i] = predictor(ctx.feats[i]);
  }
  // Candle models are strategy-independent: compute once.
  const models = candles.map((_, i) => (i >= 60 ? runModels(ctx, i, { withMl: false }) : null));
  const base = { symbol, interval, candles, ctx, mlProb, models };
  baseCache.set(key, { at: Date.now(), base });
  return base;
}

// Cheap part: per-bar strategy scores.
export function scoreSeries(base, strategyId) {
  const { candles, ctx, mlProb, models } = base;
  return candles.map((_, i) => {
    const m = models[i];
    const r = ctx.regimes[i];
    if (!m || !r) return null;
    const strat = resolveStrategy(strategyId, r.regime);
    const all = { ...m, ml: { score: mlProb[i] === null ? 0 : clamp((mlProb[i] - 0.5) * 200) } };
    return {
      score: strat.rule ? ruleScore(strat, candles, ctx.ind, i) : strat.weights ? weightedScore(all, strat.weights) : 0,
      regime: r.regime,
      atrPctile: r.metrics.atrPercentile,
      strategy: strat.id,
      sl: strat.sl ?? 2,
      tp: strat.tp ?? 3,
      trail: strat.trail ?? null,
      blocked: Boolean(longBlocked(strat, r.regime, m.htf?.regime)),
      shortBlocked: Boolean(shortBlocked(strat, r.regime, m.htf?.regime)),
    };
  });
}

export const DEFAULT_COSTS = { feeRate: 0.001, slippageBps: 5, spreadBps: 2, latencyBars: 1, fundingRatePct8h: 0 };
// Exchanges with their own cost model (NSE forex) override the crypto defaults; explicit request values still win.
const costsFor = (exchange) => (exchange && ex(exchange).costs) || {};

// Simulates one parameter set over bars [from, to).
// allowShort: a strongly bearish score may open a short (stop above, target below, trailing stop moving down),
// covered on a bullish score. Shorts are fully funded like the live bots: the notional is reserved as collateral.
// leverage > 1 (perpetuals): a position reserves notional / leverage as isolated margin; with `liquidation` on, a bar
// that reaches the liquidation price closes the position and loses its margin, and entries whose stop is not well
// inside the liquidation distance are skipped (as the live risk engine does). Funding accrues on the notional.
export function simulate(base, scores, p) {
  const { candles, ctx } = base;
  const {
    from, to, threshold = 30, slMult = null, tpMult = null, riskPct = 1, maxPositionPct = 25,
    trailingStop = true, trailAtr = 2.5, dynamicRisk = true, startBalance = 10000, allowShort = false,
    feeRate, slippageBps, spreadBps, latencyBars, fundingRatePct8h, leverage = 1, liquidation = false, mmr = 0.01,
  } = { ...DEFAULT_COSTS, ...p };
  const lev = Math.max(1, leverage || 1);
  const liqPriceOf = (entry, dir) => (dir > 0 ? (entry * (1 - 1 / lev)) / (1 - mmr) : (entry * (1 + 1 / lev)) / (1 + mmr));
  const liqDistPct = (dir) => Math.abs(liqPriceOf(1, dir) - 1) * 100;
  let liquidations = 0;
  const costIn = 1 + spreadBps / 20000 + slippageBps / 10000; // buying pays the spread + slippage
  const costOut = 1 - spreadBps / 20000 - slippageBps / 10000; // selling receives less
  const hoursPerBar = HOURS_PER_BAR[base.interval] || 1;
  let cash = startBalance;
  let pos = null; // { dir: 1 long | -1 short, qty, cost (paid / collateral), proceeds (short sale, net of fee), ... }
  const trades = [];
  const equity = [];
  let barsInMarket = 0;
  let pending = null; // order placed at bar close, filled after latency

  // Value of the open position at a price (long: market value; short: collateral + sale proceeds - buy-back).
  // With leverage a long's market value is net of the borrowed part (notional - margin).
  const markValue = (price) => (pos.dir > 0 ? pos.qty * price - (pos.notional - pos.cost) : pos.cost + pos.proceeds - pos.qty * price);

  const open = (dir, rawPrice, order, i) => {
    const notional = Math.min(order.notional, cash * lev);
    if (notional < 10) return;
    const fill = rawPrice * (dir > 0 ? costIn : costOut);
    const margin = notional / lev;
    cash -= margin;
    const common = { dir, entry: fill, cost: margin, notional, liq: liquidation ? liqPriceOf(fill, dir) : null, highest: fill, lowest: fill, bar: i, regime: order.regime, strategy: order.strategy, equityBefore: order.equityBefore, trail: order.trail };
    if (dir > 0) pos = { ...common, qty: (notional - notional * feeRate) / fill, stopLoss: fill - order.slDist, takeProfit: fill + order.tpDist };
    else pos = { ...common, qty: notional / fill, proceeds: notional * (1 - feeRate), stopLoss: fill + order.slDist, takeProfit: fill - order.tpDist };
    trades.push({ side: dir > 0 ? 'BUY' : 'SHORT', direction: dir > 0 ? 'long' : 'short', time: candles[i].time, price: fill, qty: pos.qty, score: order.score, regime: order.regime });
  };

  const close = (rawPrice, reason, i) => {
    const funding = pos.notional * (fundingRatePct8h / 100) * ((i - pos.bar) * hoursPerBar / 8);
    let fill;
    let net;
    if (pos.dir > 0) {
      fill = rawPrice * costOut;
      const gross = pos.qty * fill;
      net = gross - gross * feeRate - funding - (pos.notional - pos.cost);
    } else {
      fill = rawPrice * costIn;
      const buyBack = pos.qty * fill;
      net = pos.cost + pos.proceeds - buyBack - buyBack * feeRate - funding;
    }
    cash += net;
    const pnl = net - pos.cost;
    trades.push({ side: pos.dir > 0 ? 'SELL' : 'COVER', exit: true, direction: pos.dir > 0 ? 'long' : 'short', time: candles[i].time, price: fill, pnl, pnlPct: (pnl / pos.cost) * 100, ret: pnl / pos.equityBefore, reason, regime: pos.regime, strategy: pos.strategy, bars: i - pos.bar });
    pos = null;
  };

  // Liquidation: the isolated margin is lost (the exchange keeps what is left of it).
  const liquidate = (i) => {
    liquidations++;
    trades.push({ side: pos.dir > 0 ? 'SELL' : 'COVER', exit: true, direction: pos.dir > 0 ? 'long' : 'short', time: candles[i].time, price: pos.liq, pnl: -pos.cost, pnlPct: -100, ret: -pos.cost / pos.equityBefore, reason: `Liquidated (${lev}x)`, regime: pos.regime, strategy: pos.strategy, bars: i - pos.bar });
    pos = null;
  };

  for (let i = from; i < to; i++) {
    const c = candles[i];
    // Fill orders queued on the previous bar at this bar's open (latency simulation).
    if (pending && pending.fillBar === i) {
      if (pending.side === 'OPEN' && !pos) open(pending.dir, c.open, pending, i);
      else if (pending.side === 'CLOSE' && pos) close(c.open, pending.reason, i);
      pending = null;
    }

    if (pos) {
      barsInMarket++;
      const prevAtr = ctx.ind.atr[i - 1];
      if (trailingStop && prevAtr) {
        const mult = pos.trail ?? trailAtr;
        if (pos.dir > 0) {
          pos.highest = Math.max(pos.highest, candles[i - 1].high);
          pos.stopLoss = Math.max(pos.stopLoss, pos.highest - mult * prevAtr);
        } else {
          pos.lowest = Math.min(pos.lowest, candles[i - 1].low);
          pos.stopLoss = Math.min(pos.stopLoss, pos.lowest + mult * prevAtr);
        }
      }
      const long = pos.dir > 0;
      const liqHit = pos.liq && (long ? c.low <= pos.liq : c.high >= pos.liq);
      const gapped = pos.liq && (long ? c.open <= pos.liq : c.open >= pos.liq);
      const stopFirst = long ? pos.stopLoss > pos.liq : pos.stopLoss < pos.liq;
      if (liqHit && (gapped || !stopFirst)) liquidate(i);
      else if (pos.dir > 0) {
        if (c.low <= pos.stopLoss) close(Math.min(c.open, pos.stopLoss), 'Stop-loss', i);
        else if (c.high >= pos.takeProfit) close(Math.max(c.open, pos.takeProfit), 'Take-profit', i);
      } else if (c.high >= pos.stopLoss) close(Math.max(c.open, pos.stopLoss), 'Stop-loss', i);
      else if (c.low <= pos.takeProfit) close(Math.min(c.open, pos.takeProfit), 'Take-profit', i);
    }

    const s = scores[i];
    if (s && !pending) {
      const atr = ctx.ind.atr[i] || c.close * 0.01;
      const wantLong = !pos && s.score >= threshold && !s.blocked;
      const wantShort = !pos && allowShort && s.score <= -threshold && !s.shortBlocked;
      if (wantLong || wantShort) {
        const slDist = (slMult ?? s.sl) * atr;
        const tpDist = (tpMult ?? s.tp) * atr;
        let r = riskPct;
        if (dynamicRisk) {
          r *= REGIMES[s.regime]?.risk ?? 0.75;
          r *= s.atrPctile > 95 ? 0.25 : s.atrPctile > 80 ? 0.5 : 1;
        }
        const eq = cash;
        // maxPositionPct and cash cap the margin, so with leverage they allow lev x the notional.
        const notional = Math.min((eq * (r / 100)) / (slDist / c.close), eq * (maxPositionPct / 100) * lev, cash * 0.995 * lev);
        const liqOk = !liquidation || liqDistPct(wantLong ? 1 : -1) >= 2 * (slDist / c.close) * 100;
        if (r > 0 && notional >= 10 && liqOk) {
          const order = { side: 'OPEN', dir: wantLong ? 1 : -1, notional, slDist, tpDist, regime: s.regime, strategy: s.strategy, score: s.score, equityBefore: eq, trail: s.trail };
          if (latencyBars > 0 && i + latencyBars < to) pending = { ...order, fillBar: i + latencyBars };
          else if (latencyBars === 0) open(order.dir, c.close, order, i);
        }
      } else if (pos && (pos.dir > 0 ? s.score <= -threshold : s.score >= threshold)) {
        if (latencyBars > 0 && i + latencyBars < to) pending = { side: 'CLOSE', reason: 'AI exit signal', fillBar: i + latencyBars };
        else close(c.close, 'AI exit signal', i);
      }
    }
    equity.push({ time: c.time, value: cash + (pos ? markValue(c.close) : 0), price: c.close });
  }
  if (pos) close(candles[to - 1].close, 'End of test', to - 1);
  if (equity.length) equity[equity.length - 1].value = cash;
  const metrics = computeMetrics(trades, equity, startBalance, base.interval, barsInMarket);
  if (lev > 1 || liquidation) Object.assign(metrics, { leverage: lev, liquidations });
  return { trades, equity, metrics };
}

export function computeMetrics(trades, equity, startBalance, interval, barsInMarket = 0) {
  const sells = trades.filter((t) => t.exit || t.side === 'SELL'); // closed round trips (long SELL, short COVER; DCA/grid sells)
  const wins = sells.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(sells.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  let peak = startBalance;
  let maxDD = 0;
  const rets = [];
  equity.forEach((e, k) => {
    peak = Math.max(peak, e.value);
    maxDD = Math.max(maxDD, (peak - e.value) / peak);
    if (k) rets.push(e.value / equity[k - 1].value - 1);
  });
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  const final = equity.length ? equity[equity.length - 1].value : startBalance;
  const firstPrice = equity[0]?.price || 1;
  const lastPrice = equity[equity.length - 1]?.price || 1;
  const byRegime = {};
  sells.forEach((t) => {
    const g = (byRegime[t.regime || 'n/a'] ||= { trades: 0, wins: 0, pnl: 0 });
    g.trades++;
    if (t.pnl > 0) g.wins++;
    g.pnl += t.pnl;
  });
  Object.values(byRegime).forEach((g) => { g.pnl = +g.pnl.toFixed(2); g.winRate = +((g.wins / g.trades) * 100).toFixed(1); });
  const byDirection = {};
  sells.forEach((t) => {
    const g = (byDirection[t.direction || 'long'] ||= { trades: 0, wins: 0, pnl: 0 });
    g.trades++;
    if (t.pnl > 0) g.wins++;
    g.pnl += t.pnl;
  });
  Object.values(byDirection).forEach((g) => { g.pnl = +g.pnl.toFixed(2); g.winRate = +((g.wins / g.trades) * 100).toFixed(1); });
  const totalReturnPct = ((final - startBalance) / startBalance) * 100;
  return {
    finalValue: +final.toFixed(2),
    totalReturnPct: +totalReturnPct.toFixed(2),
    buyHoldReturnPct: +(((lastPrice - firstPrice) / firstPrice) * 100).toFixed(2),
    trades: sells.length,
    winRate: sells.length ? +((wins.length / sells.length) * 100).toFixed(1) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : grossWin ? 99 : 0,
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    sharpe: sd ? +((mean / sd) * Math.sqrt(BARS_PER_YEAR[interval] || 8760)).toFixed(2) : 0,
    avgTradePct: sells.length ? +(sells.reduce((s, t) => s + t.pnlPct, 0) / sells.length).toFixed(2) : 0,
    exposurePct: equity.length ? +((barsInMarket / equity.length) * 100).toFixed(1) : 0,
    returnToDD: maxDD ? +(totalReturnPct / (maxDD * 100)).toFixed(2) : totalReturnPct > 0 ? 99 : 0,
    byRegime, byDirection,
  };
}

// Objective for optimisation: risk-adjusted return, penalising too few trades.
const objective = (m) => (m.trades < 5 ? -999 : m.sharpe * Math.min(1, m.trades / 20));

export const OPT_GRID = { threshold: [20, 25, 30, 40, 50], slMult: [1.5, 2, 2.5], tpMult: [2, 3, 4] };

export function optimize(base, scores, range, fixed) {
  const results = [];
  for (const threshold of OPT_GRID.threshold) {
    for (const slMult of OPT_GRID.slMult) {
      for (const tpMult of OPT_GRID.tpMult) {
        const params = { threshold, slMult, tpMult };
        const r = simulate(base, scores, { ...fixed, ...params, from: range.from, to: range.to });
        results.push({ params, metrics: r.metrics, objective: objective(r.metrics) });
      }
    }
  }
  return results.sort((a, b) => b.objective - a.objective);
}

// Monte Carlo: resample per-trade returns with replacement to estimate the range of outcomes.
export function monteCarlo(trades, runs = 1000) {
  const rets = trades.filter((t) => t.exit || t.side === 'SELL').map((t) => t.ret);
  if (rets.length < 5) return null;
  const finals = [];
  const dds = [];
  for (let r = 0; r < runs; r++) {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    for (let k = 0; k < rets.length; k++) {
      eq *= 1 + rets[Math.floor(Math.random() * rets.length)];
      peak = Math.max(peak, eq);
      dd = Math.max(dd, (peak - eq) / peak);
    }
    finals.push((eq - 1) * 100);
    dds.push(dd * 100);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const pct = (arr, q) => +arr[Math.min(arr.length - 1, Math.floor(arr.length * q))].toFixed(2);
  const lo = finals[0];
  const hi = finals[finals.length - 1];
  const bins = 24;
  const hist = Array.from({ length: bins }, (_, b) => ({ from: +(lo + ((hi - lo) * b) / bins).toFixed(2), count: 0 }));
  finals.forEach((f) => { hist[Math.min(bins - 1, Math.floor(((f - lo) / (hi - lo || 1)) * bins))].count++; });
  return {
    runs, trades: rets.length,
    returnP5: pct(finals, 0.05), returnP50: pct(finals, 0.5), returnP95: pct(finals, 0.95),
    maxDDP50: pct(dds, 0.5), maxDDP95: pct(dds, 0.95),
    probLoss: +((finals.filter((f) => f < 0).length / runs) * 100).toFixed(1),
    histogram: hist,
  };
}

function downsample(arr, n = 400) {
  const step = Math.max(1, Math.floor(arr.length / n));
  return arr.filter((_, k) => k % step === 0 || k === arr.length - 1).map((e) => ({ time: e.time, value: +e.value.toFixed(2), price: e.price }));
}

async function runCombo(symbol, interval, opts) {
  const { candles: count, strategy, split, optimize: doOpt, walkForwardFolds, monteCarloRuns } = opts;
  const base = await prepareBase(symbol, interval, count, opts.exchange);
  const scores = scoreSeries(base, strategy);
  const n = base.candles.length;
  const start = 320;
  const usable = n - start;
  const trainEnd = start + Math.floor(usable * (split.train / 100));
  const valEnd = trainEnd + Math.floor(usable * (split.validation / 100));
  const fixed = {
    riskPct: opts.riskPct, maxPositionPct: opts.maxPositionPct, trailingStop: opts.trailingStop, trailAtr: 2.5,
    startBalance: opts.startBalance, feeRate: opts.feeRate, slippageBps: opts.slippageBps, spreadBps: opts.spreadBps,
    latencyBars: opts.latencyBars, fundingRatePct8h: opts.fundingRatePct8h, dynamicRisk: true,
    allowShort: Boolean(opts.allowShort && opts.exchange && ex(opts.exchange).canShort),
    leverage: opts.leverage || 1, liquidation: Boolean(opts.liquidation), mmr: ex(opts.exchange || 'binance').mmrOf?.(symbol) ?? 0.01,
  };
  let chosen = { threshold: opts.threshold, slMult: null, tpMult: null };
  let optimization = null;
  if (doOpt) {
    const ranked = optimize(base, scores, { from: start, to: trainEnd }, fixed);
    const top = ranked.slice(0, 5).map((r) => ({ ...r, validation: simulate(base, scores, { ...fixed, ...r.params, from: trainEnd, to: valEnd }).metrics }));
    top.sort((a, b) => objective(b.validation) - objective(a.validation));
    chosen = top[0].params;
    optimization = {
      tested: ranked.length,
      top: top.map((t) => ({ params: t.params, train: pick(t.metrics), validation: pick(t.validation) })),
    };
  }
  const seg = (from, to) => simulate(base, scores, { ...fixed, ...chosen, from, to });
  const train = seg(start, trainEnd);
  const validation = seg(trainEnd, valEnd);
  const oos = seg(valEnd, n);
  const full = seg(start, n);
  if (optimization) {
    const tr = train.metrics.totalReturnPct;
    const os = oos.metrics.totalReturnPct;
    optimization.overfitWarning = tr > 0 && (os < 0 || os < tr * 0.25 * ((n - valEnd) / (trainEnd - start)))
      ? 'Out-of-sample results are much weaker than in-sample - the optimised parameters are likely overfit.' : null;
    if (optimization.top[0].train.totalReturnPct <= 0) optimization.overfitWarning = 'No parameter combination was profitable in-sample - this strategy shows no edge on this market and timeframe.';
  }

  // Anchored walk-forward: optimise on everything before each fold, test on the fold.
  const wf = [];
  if (walkForwardFolds > 1) {
    const chunk = Math.floor(usable / (walkForwardFolds + 1));
    for (let k = 1; k <= walkForwardFolds; k++) {
      const isFrom = start;
      const isTo = start + chunk * k;
      const osTo = Math.min(n, isTo + chunk);
      const params = doOpt ? optimize(base, scores, { from: isFrom, to: isTo }, fixed)[0].params : chosen;
      const is = simulate(base, scores, { ...fixed, ...params, from: isFrom, to: isTo }).metrics;
      const os = simulate(base, scores, { ...fixed, ...params, from: isTo, to: osTo }).metrics;
      wf.push({ fold: k, from: base.candles[isTo].time, to: base.candles[osTo - 1].time, params, inSample: pick(is), outOfSample: pick(os), isPerBar: is.totalReturnPct / (isTo - isFrom), osPerBar: os.totalReturnPct / (osTo - isTo) });
    }
  }
  const wfOosReturn = wf.reduce((s, f) => s + f.outOfSample.totalReturnPct, 0);
  const isRate = wf.reduce((s, f) => s + f.isPerBar, 0);
  const osRate = wf.reduce((s, f) => s + f.osPerBar, 0);
  return {
    symbol, interval, strategy, candles: n,
    period: { from: base.candles[start].time, to: base.candles[n - 1].time, trainEnd: base.candles[trainEnd].time, valEnd: base.candles[valEnd].time },
    params: chosen,
    segments: { train: train.metrics, validation: validation.metrics, outOfSample: oos.metrics, full: full.metrics },
    optimization,
    walkForward: wf.length ? { folds: wf, oosReturnPct: +wfOosReturn.toFixed(2), efficiency: isRate > 0 ? +(osRate / isRate).toFixed(2) : null, profitableFolds: wf.filter((f) => f.outOfSample.totalReturnPct > 0).length } : null,
    monteCarlo: monteCarlo(full.trades, monteCarloRuns),
    equity: downsample(full.equity),
    oosStartTime: base.candles[valEnd].time,
    trades: full.trades.slice(-200),
  };
}

const pick = (m) => ({ totalReturnPct: m.totalReturnPct, trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor, maxDrawdownPct: m.maxDrawdownPct, sharpe: m.sharpe });

export async function runBacktest(input) {
  const opts = {
    symbols: ['BTCUSDT'], intervals: ['1h'], candles: 3000, strategy: 'adaptive', threshold: 30,
    split: { train: 70, validation: 15, oos: 15 }, optimize: false, walkForwardFolds: 4, monteCarloRuns: 1000,
    startBalance: 10000, riskPct: 1, maxPositionPct: 25, trailingStop: true, exchange: 'binance', ...DEFAULT_COSTS, ...costsFor(input.exchange), ...input,
  };
  const st = getStrategy(opts.strategy);
  if (!st || st.liveOnly) throw new Error('This strategy cannot be backtested');
  if (opts.strategy === 'dca') return runDcaBacktest(opts);
  if (opts.strategy === 'grid') return runGridBacktest(opts);
  const combos = [];
  for (const s of opts.symbols.slice(0, 5)) for (const iv of opts.intervals.slice(0, 4)) combos.push([s, iv]);
  const results = [];
  for (const [s, iv] of combos) {
    try {
      results.push(await runCombo(s, iv, opts));
    } catch (err) {
      results.push({ symbol: s, interval: iv, error: err.message });
    }
  }
  const ok = results.filter((r) => !r.error);
  const avg = (f) => (ok.length ? +(ok.reduce((s, r) => s + f(r), 0) / ok.length).toFixed(2) : 0);
  return {
    params: { ...opts },
    results,
    summary: {
      combos: results.length,
      avgOosReturnPct: avg((r) => r.segments.outOfSample.totalReturnPct),
      avgOosBuyHoldPct: avg((r) => r.segments.outOfSample.buyHoldReturnPct),
      avgFullReturnPct: avg((r) => r.segments.full.totalReturnPct),
      profitableOos: ok.filter((r) => r.segments.outOfSample.totalReturnPct > 0).length,
      best: ok.length ? ok.reduce((b, r) => (r.segments.outOfSample.sharpe > b.segments.outOfSample.sharpe ? r : b)) : null,
    },
    note: 'Headline numbers are OUT-OF-SAMPLE. Claude, live order books, futures and news are not available historically, so backtests use the candle-based models (order flow = taker volume delta).',
  };
}

// DCA backtest: buy a tranche every N bars unless the score is bearish, sell the stack at +X%.
async function runDcaBacktest(opts) {
  const cfg = STRATEGY_LIBRARY.dca;
  const results = [];
  for (const s of opts.symbols.slice(0, 5)) {
    for (const iv of opts.intervals.slice(0, 4)) {
      try {
        const base = await prepareBase(s, iv, opts.candles, opts.exchange);
        const scores = scoreSeries(base, 'adaptive');
        const { candles } = base;
        let cash = opts.startBalance;
        let qty = 0;
        let cost = 0;
        let tranches = 0;
        let lastBuy = -Infinity;
        const trades = [];
        const equity = [];
        for (let i = 320; i < candles.length; i++) {
          const c = candles[i];
          const avg = qty ? cost / qty : 0;
          if (qty && c.high >= avg * (1 + cfg.takeProfitPct / 100)) {
            const fill = avg * (1 + cfg.takeProfitPct / 100) * (1 - opts.slippageBps / 10000);
            const net = qty * fill * (1 - opts.feeRate);
            trades.push({ side: 'SELL', time: c.time, price: fill, pnl: net - cost, pnlPct: ((net - cost) / cost) * 100, ret: (net - cost) / (cash + cost), reason: 'DCA take-profit', regime: scores[i]?.regime });
            cash += net;
            qty = 0; cost = 0; tranches = 0;
          }
          const sc = scores[i];
          if (sc && i - lastBuy >= cfg.every && tranches < cfg.maxTranches && sc.score >= -20 && !['PANIC', 'BREAKDOWN'].includes(sc.regime)) {
            const amount = Math.min(cash, (cash + qty * c.close) * (cfg.tranchePct / 100));
            if (amount >= 10) {
              const fill = c.close * (1 + opts.slippageBps / 10000);
              qty += (amount * (1 - opts.feeRate)) / fill;
              cost += amount;
              cash -= amount;
              tranches++;
              lastBuy = i;
              trades.push({ side: 'BUY', time: c.time, price: fill, qty: amount / fill, regime: sc.regime });
            }
          }
          equity.push({ time: c.time, value: cash + qty * c.close, price: c.close });
        }
        const m = computeMetrics(trades, equity, opts.startBalance, iv);
        results.push({ symbol: s, interval: iv, strategy: 'dca', candles: candles.length, segments: { full: m, outOfSample: m, train: m, validation: m }, monteCarlo: monteCarlo(trades, opts.monteCarloRuns), equity: downsample(equity), trades: trades.slice(-200), params: { every: cfg.every, tranchePct: cfg.tranchePct, takeProfitPct: cfg.takeProfitPct } });
      } catch (err) {
        results.push({ symbol: s, interval: iv, error: err.message });
      }
    }
  }
  return { params: opts, results, summary: { combos: results.length }, note: 'DCA has no fitted parameters, so the whole period is reported (no train/test split).' };
}

// Strategy Library benchmark: every backtestable strategy on the same markets, reported out-of-sample.
export async function benchmarkStrategies({ symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], intervals = ['15m', '1h', '4h'], candles = 3000 } = {}) {
  const ids = Object.entries(STRATEGY_LIBRARY).filter(([, s]) => !s.liveOnly && !s.dca && !s.grid).map(([id]) => id);
  const bases = [];
  for (const s of symbols.slice(0, 4)) for (const iv of intervals.slice(0, 4)) {
    try { bases.push(await prepareBase(s, iv, candles)); } catch { /* skip markets without history */ }
  }
  const out = [];
  for (const id of ids) {
    const runs = bases.map((base) => {
      const scores = scoreSeries(base, id);
      const n = base.candles.length;
      const oosFrom = 320 + Math.floor((n - 320) * 0.7);
      const r = simulate(base, scores, { ...DEFAULT_COSTS, from: oosFrom, to: n, threshold: 30 });
      return { symbol: base.symbol, interval: base.interval, m: r.metrics };
    });
    const valid = runs.filter((r) => r.m.trades > 0);
    const agg = (f) => (valid.length ? valid.reduce((s, r) => s + f(r.m), 0) / valid.length : 0);
    const byTf = {};
    runs.forEach((r) => { (byTf[r.interval] ||= []).push(r.m.sharpe); });
    const bestTf = Object.entries(byTf).map(([tf, v]) => [tf, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => b[1] - a[1])[0]?.[0];
    const regimes = {};
    runs.forEach((r) => Object.entries(r.m.byRegime).forEach(([k, g]) => { const x = (regimes[k] ||= { pnl: 0, trades: 0 }); x.pnl += g.pnl; x.trades += g.trades; }));
    const bestRegime = Object.entries(regimes).filter(([, g]) => g.trades >= 3).sort((a, b) => b[1].pnl - a[1].pnl)[0]?.[0] || null;
    out.push({
      id, name: STRATEGY_LIBRARY[id].name,
      markets: runs.length, trades: runs.reduce((s, r) => s + r.m.trades, 0),
      winRate: +agg((m) => m.winRate).toFixed(1), profitFactor: +agg((m) => Math.min(m.profitFactor, 10)).toFixed(2),
      maxDrawdownPct: +agg((m) => m.maxDrawdownPct).toFixed(2), sharpe: +agg((m) => m.sharpe).toFixed(2),
      oosReturnPct: +agg((m) => m.totalReturnPct).toFixed(2), bestTimeframe: bestTf, bestRegime,
      profitableMarkets: runs.filter((r) => r.m.totalReturnPct > 0).length,
    });
  }
  return { time: Date.now(), symbols, intervals, candles, strategies: out.sort((a, b) => b.sharpe - a.sharpe) };
}

// Grid backtest: the grid only runs in sideways / low-volatility regimes and is closed on a breakdown.
async function runGridBacktest(opts) {
  const { buildGrid, GRID_REGIMES, GRID_KILL_REGIMES } = await import('../bot/grid.js');
  const levelsCount = STRATEGY_LIBRARY.grid.levels;
  const results = [];
  for (const s of opts.symbols.slice(0, 5)) {
    for (const iv of opts.intervals.slice(0, 4)) {
      try {
        const base = await prepareBase(s, iv, opts.candles, opts.exchange);
        const { candles, ctx } = base;
        const n = candles.length;
        const start = 320;
        const oosFrom = start + Math.floor((n - start) * ((opts.split.train + opts.split.validation) / 100));
        const costIn = 1 + opts.spreadBps / 20000 + opts.slippageBps / 10000;
        const costOut = 1 - opts.spreadBps / 20000 - opts.slippageBps / 10000;
        let cash = opts.startBalance;
        let grid = null;
        const trades = [];
        const equity = [];
        const sellLot = (lot, price, time, reason, regime) => {
          const net = lot.qty * price * costOut * (1 - opts.feeRate);
          cash += net;
          const pnl = net - lot.cost;
          trades.push({ side: 'SELL', time, price, pnl, pnlPct: (pnl / lot.cost) * 100, ret: pnl / opts.startBalance, reason, regime });
        };
        for (let i = start; i < n; i++) {
          const c = candles[i];
          const r = ctx.regimes[i]?.regime;
          const htfR = ctx.htf?.regimes[ctx.htf.index[i]]?.regime;
          const atr = ctx.ind.atr[i] || c.close * 0.01;
          const kill = GRID_KILL_REGIMES.includes(r) || GRID_KILL_REGIMES.includes(htfR);
          if (grid && (c.low < grid.lower - atr || kill)) {
            const exitPrice = c.low < grid.lower - atr ? Math.min(c.open, grid.lower - atr) : c.close;
            grid.lots.forEach((l) => sellLot(l, exitPrice, c.time, kill ? 'Regime kill' : 'Range breakdown', r));
            grid = null;
          }
          if (grid) {
            for (const lot of [...grid.lots]) {
              if (c.high >= lot.level + grid.step) {
                sellLot(lot, lot.level + grid.step, c.time, 'Grid take-profit', r);
                grid.lots = grid.lots.filter((x) => x !== lot);
              }
            }
            const held = new Set(grid.lots.map((l) => l.level));
            for (const lv of grid.levels) {
              if (held.has(lv) || c.low > lv || candles[i - 1].close <= lv) continue;
              const amount = Math.min(cash, grid.perLevel);
              if (amount < 10) continue;
              const fill = lv * costIn;
              grid.lots.push({ level: lv, qty: (amount * (1 - opts.feeRate)) / fill, cost: amount });
              cash -= amount;
              trades.push({ side: 'BUY', time: c.time, price: fill, regime: r });
            }
            if (!grid.lots.length && !GRID_REGIMES.includes(r)) grid = null;
          } else if (GRID_REGIMES.includes(r) && !kill) {
            grid = buildGrid(candles.slice(0, i + 1), levelsCount);
            if (grid) grid.perLevel = (cash * 0.9) / grid.levels.length;
          }
          const held = grid ? grid.lots.reduce((sum, l) => sum + l.qty * c.close, 0) : 0;
          equity.push({ time: c.time, value: cash + held, price: c.close });
        }
        if (grid) grid.lots.forEach((l) => sellLot(l, candles[n - 1].close, candles[n - 1].time, 'End of test', null));
        if (equity.length) equity[equity.length - 1].value = cash;
        const oosIdx = oosFrom - start;
        const full = computeMetrics(trades, equity, opts.startBalance, iv);
        const oosEq = equity.slice(oosIdx);
        const oosTrades = trades.filter((t) => t.time >= candles[oosFrom].time);
        const oos = computeMetrics(oosTrades, oosEq.map((e) => ({ ...e, value: (e.value / oosEq[0].value) * opts.startBalance })), opts.startBalance, iv);
        results.push({
          symbol: s, interval: iv, strategy: 'grid', candles: n,
          period: { from: candles[start].time, to: candles[n - 1].time },
          segments: { full, outOfSample: oos, train: full, validation: full },
          monteCarlo: monteCarlo(trades, opts.monteCarloRuns), equity: downsample(equity), oosStartTime: candles[oosFrom].time,
          trades: trades.slice(-200), params: { levels: levelsCount, threshold: '-' },
        });
      } catch (err) {
        results.push({ symbol: s, interval: iv, error: err.message });
      }
    }
  }
  const ok = results.filter((r) => !r.error);
  const avg = (f) => (ok.length ? +(ok.reduce((a, r) => a + f(r), 0) / ok.length).toFixed(2) : 0);
  return {
    params: opts, results,
    summary: { combos: results.length, avgOosReturnPct: avg((r) => r.segments.outOfSample.totalReturnPct), avgOosBuyHoldPct: avg((r) => r.segments.outOfSample.buyHoldReturnPct), profitableOos: ok.filter((r) => r.segments.outOfSample.totalReturnPct > 0).length, avgFullReturnPct: avg((r) => r.segments.full.totalReturnPct) },
    note: 'Grid has no fitted parameters; "out-of-sample" is the final 15% of the period for comparison with other strategies.',
  };
}

// Out-of-sample benchmark of one strategy (used when a strategy is published to the marketplace).
export async function benchmarkStrategy(id, { symbols = ['BTCUSDT', 'ETHUSDT'], intervals = ['1h'], candles = 3000 } = {}) {
  const runs = [];
  for (const s of symbols) for (const iv of intervals) {
    try {
      const base = await prepareBase(s, iv, candles);
      const n = base.candles.length;
      const r = simulate(base, scoreSeries(base, id), { ...DEFAULT_COSTS, from: 320 + Math.floor((n - 320) * 0.7), to: n, threshold: 30 });
      runs.push({ symbol: s, interval: iv, ...r.metrics });
    } catch { /* skip */ }
  }
  const avg = (f) => (runs.length ? +(runs.reduce((a, x) => a + f(x), 0) / runs.length).toFixed(2) : 0);
  return {
    markets: runs.length, trades: runs.reduce((a, x) => a + x.trades, 0), winRate: avg((x) => x.winRate), profitFactor: avg((x) => Math.min(x.profitFactor, 10)),
    maxDrawdownPct: avg((x) => x.maxDrawdownPct), sharpe: avg((x) => x.sharpe), oosReturnPct: avg((x) => x.totalReturnPct), time: Date.now(),
    perMarket: runs.map((x) => ({ symbol: x.symbol, interval: x.interval, totalReturnPct: x.totalReturnPct, trades: x.trades })),
  };
}
