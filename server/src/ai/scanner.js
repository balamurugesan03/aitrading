// AI Scanner 2.0: 100+ coins -> liquidity filter -> volatility filter -> trend filter -> AI score
// -> risk filter -> top setups (with live order flow for the finalists).
import { ex, fetchCandles } from '../exchange/index.js';
import { analyze } from './analyzer.js';
import { analyzeOrderFlow } from './orderflow.js';
import { mapLimit, STABLES } from './util.js';

const EXCLUDE = /(UP|DOWN|BULL|BEAR)USDT$/;

export async function scanMarket({ interval = '1h', universe = 100, minVolumeUsd = 5e6, symbols = [], strategy = 'adaptive', exchange = 'binance' } = {}) {
  const adapter = ex(exchange);
  const t0 = Date.now();
  const funnel = [];
  let list;
  if (symbols.length) {
    list = (await adapter.getTickers(symbols)).map((t) => ({ ...t }));
    funnel.push({ stage: 'Custom list', count: list.length });
  } else {
    const all = await adapter.getTickers();
    // Crypto: USDT pairs minus leveraged tokens and stablecoins. NSE: the adapter's own list (NIFTY 50 / forex pairs).
    list = (adapter.market && adapter.market !== 'crypto' ? all : all.filter((t) => t.symbol.endsWith('USDT') && !EXCLUDE.test(t.symbol) && !STABLES.has(t.symbol.slice(0, -4))))
      .sort((a, b) => b.volume - a.volume).slice(0, universe);
    funnel.push({ stage: 'Universe (top by volume)', count: list.length });
  }
  const liquid = list.filter((t) => t.volume >= minVolumeUsd);
  const ccy = adapter.currency === "INR" ? "₹" : "$";
  funnel.push({ stage: `Liquidity (> ${ccy}${(minVolumeUsd / 1e6).toFixed(0)}M 24h)`, count: liquid.length });

  // Volatility filter needs candles: fetch them once and reuse for the analysis.
  const withCandles = await mapLimit(liquid, 8, async (t) => {
    try {
      const raw = await fetchCandles(exchange, t.symbol, interval, 500);
      const closed = raw.slice(0, -1);
      const tr = closed.slice(-14).map((c, k, arr) => (k ? Math.max(c.high - c.low, Math.abs(c.high - arr[k - 1].close), Math.abs(c.low - arr[k - 1].close)) : c.high - c.low));
      const atrPct = (tr.reduce((s, v) => s + v, 0) / tr.length / closed.at(-1).close) * 100;
      return { ...t, raw, closed, atrPct };
    } catch {
      return null;
    }
  });
  const volOk = withCandles.filter((x) => x && x.atrPct >= 0.15 && x.atrPct <= 8);
  funnel.push({ stage: 'Volatility (ATR 0.15% - 8%)', count: volOk.length });

  const analysed = await mapLimit(volOk, 6, async (x) => {
    try {
      const a = await analyze(x.symbol, interval, { candles: x.closed, price: x.raw.at(-1).close, strategy, live: false, exchange });
      return { x, a };
    } catch {
      return null;
    }
  });
  const ok = analysed.filter(Boolean);
  const trendOk = ok.filter(({ a }) => !['BEAR_TREND', 'BREAKDOWN', 'PANIC'].includes(a.regime?.name));
  funnel.push({ stage: 'Trend / regime (no bear, breakdown, panic)', count: trendOk.length });
  const scored = trendOk.filter(({ a }) => a.score > 0);
  funnel.push({ stage: 'AI score positive', count: scored.length });
  const riskOk = scored.filter(({ a }) => a.rr >= 1.2 && a.expectedReturnPct > 0 && a.quality !== 'D');
  funnel.push({ stage: 'Risk (R:R >= 1.2, E[r] > 0, grade A-C)', count: riskOk.length });

  const rank = (r) => r.a.expectedReturnPct / Math.max(0.1, r.a.expectedRiskPct) + r.a.score / 200;
  const top = riskOk.sort((p, q) => rank(q) - rank(p)).slice(0, 10);
  // Order flow only for finalists (two API calls per coin).
  const flows = await mapLimit(top, 4, ({ x }) => analyzeOrderFlow(x.symbol, exchange).catch(() => null));
  funnel.push({ stage: 'Top setups', count: top.length });

  const row = ({ x, a }, flow) => ({
    symbol: x.symbol, price: a.price, change24h: x.change, volumeUsd: x.volume, atrPct: +x.atrPct.toFixed(2),
    signal: a.signal, score: a.score, probability: a.probability, rr: a.rr, expectedReturnPct: a.expectedReturnPct,
    quality: a.quality, regime: a.regime?.label, regimeName: a.regime?.name, strategy: a.strategyName,
    probUp: a.ml.probUp, orderFlow: flow ? { score: flow.score, buyPressure: flow.buyPressure, bias: flow.bias } : null,
  });
  return {
    interval, exchange, time: Date.now(), durationMs: Date.now() - t0, funnel,
    top: top.map((r, k) => row(r, flows[k])),
    all: ok.map((r) => row(r, null)).sort((p, q) => q.score - p.score),
  };
}
