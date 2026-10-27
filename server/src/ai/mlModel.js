// On-the-fly machine learning: a neural network (MLP) + logistic regression ensemble trained on
// indicator features to predict whether price will be higher `horizon` candles ahead.
import { computeAll } from './indicators.js';

const FEATURE_NAMES = [
  'rsi', 'macdHist', 'emaFastSlow', 'priceVsEma50', 'bbPercent', 'stochK',
  'atrPct', 'volRatio', 'ret1', 'ret3', 'ret6', 'adx',
];

export function buildFeatures(candles, ind = computeAll(candles)) {
  const rows = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close;
    const vals = [
      ind.rsi[i], ind.macd.hist[i], ind.ema9[i], ind.ema21[i], ind.ema50[i],
      ind.bb.upper[i], ind.stoch.k[i], ind.atr[i], ind.volSma[i], ind.adx[i],
    ];
    if (i < 6 || vals.some((v) => v === null || Number.isNaN(v))) {
      rows.push(null);
      continue;
    }
    const bbW = ind.bb.upper[i] - ind.bb.lower[i] || 1e-9;
    rows.push([
      ind.rsi[i] / 100 - 0.5,
      (ind.macd.hist[i] / c) * 100,
      ((ind.ema9[i] - ind.ema21[i]) / c) * 100,
      ((c - ind.ema50[i]) / c) * 100,
      (c - ind.bb.lower[i]) / bbW - 0.5,
      ind.stoch.k[i] / 100 - 0.5,
      (ind.atr[i] / c) * 100,
      Math.log((candles[i].volume + 1) / (ind.volSma[i] + 1)),
      ((c - candles[i - 1].close) / candles[i - 1].close) * 100,
      ((c - candles[i - 3].close) / candles[i - 3].close) * 100,
      ((c - candles[i - 6].close) / candles[i - 6].close) * 100,
      ind.adx[i] / 100,
    ]);
  }
  return rows;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function standardize(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  X.forEach((r) => r.forEach((v, j) => (mean[j] += v / X.length)));
  X.forEach((r) => r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / X.length)));
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std, apply: (r) => r.map((v, j) => (v - mean[j]) / std[j]) };
}

// Seeded RNG so retraining on the same data gives the same model.
function rng(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

class Logistic {
  constructor(d) {
    this.w = new Array(d).fill(0);
    this.b = 0;
  }
  predict(x) {
    return sigmoid(x.reduce((s, v, j) => s + v * this.w[j], this.b));
  }
  fit(X, y, epochs = 300, lr = 0.05, l2 = 0.01) {
    for (let e = 0; e < epochs; e++) {
      const gw = new Array(this.w.length).fill(0);
      let gb = 0;
      X.forEach((x, i) => {
        const err = this.predict(x) - y[i];
        x.forEach((v, j) => (gw[j] += err * v));
        gb += err;
      });
      this.w = this.w.map((w, j) => w - lr * (gw[j] / X.length + l2 * w));
      this.b -= (lr * gb) / X.length;
    }
  }
}

class MLP {
  constructor(d, hidden = 16, seed = 7) {
    const r = rng(seed);
    const init = (n) => (r() - 0.5) * 2 * Math.sqrt(6 / (n + hidden));
    this.W1 = Array.from({ length: hidden }, () => Array.from({ length: d }, () => init(d)));
    this.b1 = new Array(hidden).fill(0);
    this.W2 = Array.from({ length: hidden }, () => init(hidden));
    this.b2 = 0;
  }
  forward(x) {
    const h = this.W1.map((row, k) => Math.tanh(row.reduce((s, w, j) => s + w * x[j], this.b1[k])));
    return { h, p: sigmoid(h.reduce((s, v, k) => s + v * this.W2[k], this.b2)) };
  }
  predict(x) {
    return this.forward(x).p;
  }
  fit(X, y, epochs = 60, lr = 0.01) {
    const r = rng(99);
    const idx = X.map((_, i) => i);
    for (let e = 0; e < epochs; e++) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      for (const i of idx) {
        const x = X[i];
        const { h, p } = this.forward(x);
        const dOut = p - y[i];
        for (let k = 0; k < h.length; k++) {
          const dh = dOut * this.W2[k] * (1 - h[k] * h[k]);
          this.W2[k] -= lr * (dOut * h[k] + 1e-4 * this.W2[k]);
          for (let j = 0; j < x.length; j++) this.W1[k][j] -= lr * (dh * x[j] + 1e-4 * this.W1[k][j]);
          this.b1[k] -= lr * dh;
        }
        this.b2 -= lr * dOut;
      }
    }
  }
}

// Fits the logistic + MLP ensemble on raw feature rows; returns a predictor for raw rows.
export function fitEnsemble(X, y, params = activeParams) {
  const scaler = standardize(X);
  const Xs = X.map(scaler.apply);
  const models = [new Logistic(Xs[0].length), new MLP(Xs[0].length, params.hidden)];
  models[0].fit(Xs, y);
  models[1].fit(Xs, y, params.epochs, params.lr);
  return (row) => {
    const x = scaler.apply(row);
    return (models[0].predict(x) + models[1].predict(x)) / 2;
  };
}

const cache = new Map();

// Hyper-parameters of the production model (set by the model registry).
export let activeParams = { version: 1, hidden: 16, epochs: 60, lr: 0.01, horizon: 3 };
export function setActiveParams(p) {
  activeParams = { ...activeParams, ...p };
  cache.clear();
}

// Trains (or reuses a cached model) and predicts the probability of an up-move.
export function trainAndPredict(candles, { horizon = activeParams.horizon, key } = {}) {
  const feats = buildFeatures(candles);
  const X = [];
  const y = [];
  for (let i = 0; i < candles.length - horizon; i++) {
    if (!feats[i]) continue;
    X.push(feats[i]);
    y.push(candles[i + horizon].close > candles[i].close ? 1 : 0);
  }
  const latest = feats[feats.length - 1];
  if (X.length < 80 || !latest) {
    return { probUp: 0.5, accuracy: null, samples: X.length, note: 'Not enough data to train' };
  }

  const lastTime = candles[candles.length - 1].time;
  const cached = key && cache.get(key);
  let model = cached && cached.lastTime === lastTime ? cached.model : null;

  if (!model) {
    // Walk-forward validation: train on the first 80%, measure on the last 20%.
    const split = Math.floor(X.length * 0.8);
    const scaler = standardize(X.slice(0, split));
    const Xs = X.map(scaler.apply);
    const evalModels = [new Logistic(Xs[0].length), new MLP(Xs[0].length, activeParams.hidden)];
    evalModels[0].fit(Xs.slice(0, split), y.slice(0, split));
    evalModels[1].fit(Xs.slice(0, split), y.slice(0, split), activeParams.epochs, activeParams.lr);
    let correct = 0;
    for (let i = split; i < Xs.length; i++) {
      const p = (evalModels[0].predict(Xs[i]) + evalModels[1].predict(Xs[i])) / 2;
      if ((p > 0.5 ? 1 : 0) === y[i]) correct++;
    }
    const accuracy = correct / (Xs.length - split);

    // Final model trained on everything.
    const fullScaler = standardize(X);
    const Xf = X.map(fullScaler.apply);
    const models = [new Logistic(Xf[0].length), new MLP(Xf[0].length, activeParams.hidden)];
    models[0].fit(Xf, y);
    models[1].fit(Xf, y, activeParams.epochs, activeParams.lr);
    const baseRate = y.reduce((a, b) => a + b, 0) / y.length;
    model = { models, scaler: fullScaler, accuracy, samples: X.length, baseRate };
    if (key) cache.set(key, { model, lastTime });
  }

  const x = model.scaler.apply(latest);
  const pLog = model.models[0].predict(x);
  const pNet = model.models[1].predict(x);
  const importance = FEATURE_NAMES.map((name, j) => ({ name, weight: +model.models[0].w[j].toFixed(3) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 5);

  return {
    probUp: +((pLog + pNet) / 2).toFixed(4),
    logistic: +pLog.toFixed(4),
    neuralNet: +pNet.toFixed(4),
    accuracy: +model.accuracy.toFixed(4),
    baseRate: +model.baseRate.toFixed(4),
    samples: model.samples,
    horizon,
    modelVersion: activeParams.version,
    topFeatures: importance,
  };
}
