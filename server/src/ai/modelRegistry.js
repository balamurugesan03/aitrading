// Model registry + AI learning loop.
// Trade -> result -> reason analysis (journal) -> feature performance -> strategy performance -> model evaluation
// -> new model candidate -> backtest / walk-forward -> paper trading -> human approval -> production.
// Nothing self-promotes to live trading: every stage has a gate and production needs an explicit approval.
import { db } from '../db/index.js';
import { getKlinesDeep } from '../exchange/binance.js';
import { fetchCandles } from '../exchange/index.js';
import { buildContext } from './models.js';
import { fitEnsemble, activeParams, setActiveParams } from './mlModel.js';
import { pearson, mapLimit } from './util.js';

const COST = 0.003; // round trip

export async function getActiveModel() {
  return db.models.findOne({ status: 'production' });
}

export async function initModelRegistry() {
  let prod = await getActiveModel();
  if (!prod) {
    prod = await db.models.insert({
      version: 1, name: 'NN v1 (baseline)', params: { hidden: 16, epochs: 60, lr: 0.01, horizon: 3 },
      status: 'production', metrics: null, history: [{ status: 'production', time: Date.now(), note: 'Initial baseline' }],
    });
  }
  setActiveParams({ ...prod.params, version: prod.version });
}

// Evaluates a parameter set on several markets: train on 70%, test on the last 30% (never seen).
async function evaluateParams(params, symbols, interval, count) {
  const per = await mapLimit(symbols, 2, async (symbol) => {
    const candles = await getKlinesDeep(symbol, interval, count);
    const ctx = buildContext(candles);
    const h = params.horizon;
    const rows = [];
    for (let i = 0; i < candles.length - h; i++) if (ctx.feats[i]) rows.push({ i, x: ctx.feats[i], y: candles[i + h].close > candles[i].close ? 1 : 0 });
    const split = Math.floor(rows.length * 0.7);
    const predict = fitEnsemble(rows.slice(0, split).map((r) => r.x), rows.slice(0, split).map((r) => r.y), params);
    const test = rows.slice(split).map((r) => ({ ...r, p: predict(r.x) }));
    const acc = test.filter((r) => (r.p > 0.5) === (r.y === 1)).length / test.length;
    const brier = test.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / test.length;
    const buckets = [0.4, 0.45, 0.5, 0.55, 0.6].map((lo) => {
      const inB = test.filter((r) => r.p >= lo && r.p < lo + 0.05);
      return { from: lo, to: lo + 0.05, n: inB.length, predicted: inB.length ? +(inB.reduce((s, r) => s + r.p, 0) / inB.length).toFixed(3) : null, actual: inB.length ? +(inB.filter((r) => r.y).length / inB.length).toFixed(3) : null };
    });
    // Trading P&L of the forecast alone: long for `h` bars when p > 0.55, after costs, non-overlapping.
    let eq = 1; let peak = 1; let dd = 0; let trades = 0; let wins = 0; let gw = 0; let gl = 0;
    for (let k = 0; k < test.length; k++) {
      const r = test[k];
      if (r.p <= 0.55) continue;
      const ret = candles[r.i + h].close / candles[r.i].close - 1 - COST;
      eq *= 1 + ret * 0.25; trades++;
      if (ret > 0) { wins++; gw += ret; } else gl -= ret;
      peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
      k += h - 1;
    }
    return { symbol, accuracy: acc, brier, buckets, returnPct: (eq - 1) * 100, trades, winRate: trades ? wins / trades : 0, profitFactor: gl ? gw / gl : gw ? 99 : 0, maxDDPct: dd * 100 };
  });
  const avg = (f) => per.reduce((s, x) => s + f(x), 0) / per.length;
  const accs = per.map((x) => x.accuracy);
  const mean = avg((x) => x.accuracy);
  return {
    symbols, interval, candles: count,
    accuracy: +(mean * 100).toFixed(2),
    brier: +avg((x) => x.brier).toFixed(4),
    oosReturnPct: +avg((x) => x.returnPct).toFixed(2),
    profitFactor: +avg((x) => Math.min(x.profitFactor, 10)).toFixed(2),
    maxDrawdownPct: +avg((x) => x.maxDDPct).toFixed(2),
    trades: per.reduce((s, x) => s + x.trades, 0),
    stability: +(Math.sqrt(accs.reduce((s, a) => s + (a - mean) ** 2, 0) / accs.length) * 100).toFixed(2),
    calibration: per[0].buckets,
    perMarket: per.map((x) => ({ symbol: x.symbol, accuracy: +(x.accuracy * 100).toFixed(2), returnPct: +x.returnPct.toFixed(2), trades: x.trades, profitFactor: +Math.min(x.profitFactor, 10).toFixed(2) })),
  };
}

export async function trainCandidate({ symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], interval = '1h', candles = 3000, hidden = 16, epochs = 60, lr = 0.01, horizon = 3, name } = {}) {
  const params = { hidden: Number(hidden), epochs: Number(epochs), lr: Number(lr), horizon: Number(horizon) };
  const metrics = await evaluateParams(params, symbols, interval, candles);
  const last = await db.models.find({}, { sort: { version: -1 }, limit: 1 });
  const version = (last[0]?.version || 0) + 1;
  return db.models.insert({
    version, name: name || `NN v${version} (h${params.hidden}, ${params.horizon}-bar)`, params, metrics, status: 'candidate',
    history: [{ status: 'candidate', time: Date.now(), note: 'Trained and evaluated out-of-sample' }],
  });
}

// Re-evaluates the production model on the same footing, so candidates can be compared fairly.
export async function evaluateModel(id, opts = {}) {
  const m = await db.models.findOne({ _id: id });
  if (!m) throw new Error('Model not found');
  const metrics = await evaluateParams(m.params, opts.symbols || m.metrics?.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], opts.interval || m.metrics?.interval || '1h', opts.candles || m.metrics?.candles || 3000);
  return db.models.update(m._id, { metrics });
}

const GATES = {
  paper: (m) => [
    [m.metrics?.oosReturnPct > 0, `Out-of-sample return > 0 (${m.metrics?.oosReturnPct}%)`],
    [m.metrics?.profitFactor >= 1.1, `Profit factor >= 1.1 (${m.metrics?.profitFactor})`],
    [m.metrics?.brier < 0.25, `Brier score < 0.25 - better calibrated than a coin flip (${m.metrics?.brier})`],
    [m.metrics?.trades >= 30, `At least 30 out-of-sample trades (${m.metrics?.trades})`],
  ],
  production: (m) => {
    const since = m.history?.findLast?.((h) => h.status === 'paper')?.time || 0;
    const hours = (Date.now() - since) / 3600000;
    return [
      [m.status === 'paper', 'Model must pass through paper trading first'],
      [hours >= 24, `At least 24h in paper trading (${hours.toFixed(1)}h)`],
    ];
  },
};

export async function promoteModel(id, status, { approvedBy = 'user', override = false, note = '' } = {}) {
  const m = await db.models.findOne({ _id: id });
  if (!m) throw new Error('Model not found');
  if (!['paper', 'production', 'retired', 'candidate'].includes(status)) throw new Error('Invalid status');
  const checks = GATES[status] ? GATES[status](m).map(([pass, text]) => ({ pass: Boolean(pass), text })) : [];
  const failed = checks.filter((c) => !c.pass);
  if (failed.length && !override) {
    const err = new Error(`Promotion blocked: ${failed.map((f) => f.text).join('; ')}`);
    err.status = 400;
    err.checks = checks;
    throw err;
  }
  const entry = { status, time: Date.now(), approvedBy, note: note || (failed.length ? `OVERRIDE of failed gates: ${failed.map((f) => f.text).join('; ')}` : 'All gates passed') };
  if (status === 'production') {
    const current = await getActiveModel();
    if (current && current._id !== m._id) await db.models.update(current._id, { status: 'retired', history: [...(current.history || []), { status: 'retired', time: Date.now(), note: `Replaced by v${m.version}` }] });
    setActiveParams({ ...m.params, version: m.version });
  }
  return db.models.update(m._id, { status, history: [...(m.history || []), entry] });
}

// ---- Forward evaluation of live signals: did each signal actually reach TP before SL? ----
const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

export async function evaluatePendingSignals() {
  const pending = (await db.signals.find({ outcome: null }, { sort: { time: 1 }, limit: 200 })).filter((s) => s.stopLoss && s.takeProfit && s.price);
  const bySeries = new Map();
  for (const s of pending) {
    const key = `${s.exchange || 'binance'}:${s.symbol}:${s.interval}`;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(s);
  }
  let resolved = 0;
  for (const [key, sigs] of bySeries) {
    const [exchange, symbol, interval] = key.split(':');
    const candles = await fetchCandles(exchange, symbol, interval, 1000).catch(() => null);
    if (!candles) continue;
    for (const s of sigs) {
      const after = candles.filter((c) => c.time * 1000 > s.time);
      let outcome = null;
      for (const c of after.slice(0, 48)) {
        if (c.low <= s.stopLoss) { outcome = 'loss'; break; }
        if (c.high >= s.takeProfit) { outcome = 'win'; break; }
      }
      if (!outcome && after.length >= 48) outcome = 'expired';
      if (!outcome && Date.now() - s.time > 60 * (INTERVAL_SEC[interval] || 3600) * 1000) outcome = 'expired';
      if (outcome) {
        await db.signals.update(s._id, { outcome, evaluatedAt: Date.now() });
        resolved++;
      }
    }
  }
  return resolved;
}

// Live model evaluation: calibration of the predicted probability vs what actually happened,
// win rate per quality grade / regime, and which models' scores actually predicted outcomes.
export async function learningReport(userId) {
  const all = await db.signals.find({ userId }, { sort: { time: -1 }, limit: 3000 });
  const done = all.filter((s) => s.outcome === 'win' || s.outcome === 'loss');
  const rate = (rows) => (rows.length ? +((rows.filter((r) => r.outcome === 'win').length / rows.length) * 100).toFixed(1) : null);
  const calibration = [0.3, 0.4, 0.5, 0.6, 0.7].map((lo) => {
    const rows = done.filter((s) => s.probability >= lo && s.probability < lo + 0.1);
    return { bucket: `${lo * 100}-${(lo + 0.1) * 100}%`, predicted: rows.length ? +((rows.reduce((a, r) => a + r.probability, 0) / rows.length) * 100).toFixed(1) : null, actual: rate(rows), n: rows.length };
  });
  const group = (key) => Object.entries(done.reduce((g, s) => ((g[s[key] || 'n/a'] ||= []).push(s), g), {})).map(([k, rows]) => ({ [key]: k, n: rows.length, winRate: rate(rows) }));
  const featurePerformance = ['trend', 'momentum', 'meanReversion', 'volatility', 'regime', 'flow', 'pattern', 'ml', 'sentiment']
    .map((k) => {
      const rows = done.filter((s) => s.components && s.components[k] !== undefined);
      return { model: k, n: rows.length, correlation: rows.length >= 10 ? +pearson(rows.map((r) => r.components[k]), rows.map((r) => (r.outcome === 'win' ? 1 : 0))).toFixed(3) : null };
    });
  const journal = await db.journal.count({ userId });
  const trades = (await db.trades.find({ userId })).filter((t) => t.pnl !== undefined).length;
  const models = await db.models.find({}, { sort: { version: -1 } });
  return {
    pipeline: {
      trades, journal, signals: all.length, evaluated: done.length, pending: all.filter((s) => !s.outcome).length,
      candidates: models.filter((m) => m.status === 'candidate').length, paper: models.filter((m) => m.status === 'paper').length,
      production: models.find((m) => m.status === 'production')?.name || null,
    },
    calibration, byQuality: group('quality'), byRegime: group('regime'), byStrategy: group('strategy'), featurePerformance,
    models,
    activeParams,
  };
}
