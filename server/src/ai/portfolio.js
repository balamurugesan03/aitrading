// Portfolio AI: valuation, exposure, correlation clusters, portfolio volatility and risk level.
import { db } from '../db/index.js';
import * as bn from '../exchange/binance.js';
import { getPaperBalances, getPaperMargin, getPaperPerps, settlePaperPerps } from '../bot/paperBroker.js';
import { EXCHANGES, tradingFor, credsFor, ex, isFx, isMargin, marginRateFor, accountOf, fetchCandles } from '../exchange/index.js';
import { STABLES, pearson, returns, mapLimit } from './util.js';

const retCache = new Map();

// 1h log returns over the last ~8 days, cached 10 minutes.
export async function hourlyReturns(asset) {
  const hit = retCache.get(asset);
  if (hit && Date.now() - hit.at < 600000) return hit.r;
  const candles = await bn.getKlines(`${asset}USDT`, '1h', 200);
  const r = returns(candles);
  retCache.set(asset, { at: Date.now(), r });
  return r;
}

// Forex pairs: correlation of 1h returns from the forex adapter's own candles (cached like the crypto ones).
export async function fxReturns(exchange, pair) {
  const k = `${exchange}:${pair}`;
  const hit = retCache.get(k);
  if (hit && Date.now() - hit.at < 600000) return hit.r;
  const r = returns(await fetchCandles(exchange, pair, '1h', 200));
  retCache.set(k, { at: Date.now(), r });
  return r;
}

export async function fxCorrelation(exchange, a, b) {
  if (a === b) return 1;
  const [x, y] = await Promise.all([fxReturns(exchange, a), fxReturns(exchange, b)]);
  return pearson(x, y);
}

export async function correlation(assetA, assetB) {
  if (assetA === assetB) return 1;
  const [a, b] = await Promise.all([hourlyReturns(assetA), hourlyReturns(assetB)]);
  return pearson(a, b);
}

// Live balances summed across every exchange the user has connected for trading.
export async function liveBalances(user) {
  const total = {};
  for (const e of Object.values(EXCHANGES).filter((x) => x.trading && !isFx(x.id) && !isMargin(x.id))) { // INR and margin (futures) accounts are valued separately
    if (!(await credsFor(user, e.id))) continue;
    const { client } = await tradingFor(user, e.id);
    for (const b of await client.getAccount()) total[b.asset] = (total[b.asset] || 0) + b.free + b.locked;
  }
  return total;
}

// INR accounts (NSE forex, stocks, futures) and margin accounts (NSE futures, Binance perps), in the account currency. Paper: a fully funded wallet (cash + units x price).
// Live: Zerodha equity (opening balance + pay-in + today's mark-to-market); positions are listed at notional and
// cash is what remains, so exposure above 100% means the account is leveraged beyond what the bot would do itself.
async function valueFxPortfolio(user, mode, exchange) {
  const adapter = ex(exchange);
  const Q = adapter.currency || 'USDT';
  let perpMeta = {};
  let rows;
  let total;
  let liveMarginUsed = 0;
  if (mode === 'live') {
    const { client } = await tradingFor(user, exchange);
    const a = await client.fxAccount();
    liveMarginUsed = a.marginUsed || 0;
    const pos = a.positions.map((p) => ({ asset: p.pair, amount: p.units, side: p.units < 0 ? 'short' : 'long', price: p.lastPrice, value: Math.abs(p.units) * p.lastPrice, change: 0, stable: false, contract: p.contract, pnl: p.pnl, ...(p.liqPrice && { liqPrice: p.liqPrice, leverage: p.leverage, entry: p.avgPrice }), ...(p.margin != null && { margin: p.margin }) }));
    const notional = pos.reduce((s, p) => s + p.value, 0);
    rows = [{ asset: Q, amount: a.equity - notional, price: 1, value: a.equity - notional, change: 0, stable: true }, ...pos];
    total = a.equity;
  } else {
    if (adapter.perp) {
      await settlePaperPerps(user._id, exchange).catch(() => null); // funding + liquidations first
      perpMeta = await getPaperPerps(user._id, exchange);
    }
    const balances = await getPaperBalances(user._id, exchange);
    const held = Object.keys(balances).filter((k) => k !== Q && balances[k] !== 0);
    const tickers = held.length ? await adapter.getTickers(held).catch(() => []) : [];
    // Equity = cash + signed units x price (a short's sale proceeds sit in cash). Positions are shown at notional and
    // the cash row is what is left after reserving that notional, so exposure counts shorts too.
    const held2 = Object.entries(balances).filter(([k, v]) => k !== Q && v !== 0).map(([asset, amount]) => {
      const t = tickers.find((x) => x.symbol === asset);
      const price = t?.price || 0;
      const pm = perpMeta[asset];
      return { asset, amount, side: amount < 0 ? 'short' : 'long', price, value: Math.abs(amount) * price, signed: amount * price, change: t?.change ?? 0, stable: false, ...(pm && { entry: pm.entry, leverage: pm.leverage, liqPrice: pm.liqPrice, fundingPaid: pm.fundingPaid }) };
    });
    total = (balances[Q] || 0) + held2.reduce((s, x) => s + x.signed, 0);
    const notional = held2.reduce((s, x) => s + x.value, 0);
    rows = [{ asset: Q, amount: total - notional, price: 1, value: total - notional, change: 0, stable: true }, ...held2];
  }
  // Margin accounts (NSE futures, perps): a position "uses" the margin it blocks, not its notional. Position rows carry
  // value = blocked margin (with the notional alongside), and the cash row is the free margin, so the rows still
  // sum to equity and exposure means "share of equity blocked as margin". Leverage = notional / equity.
  let marginInfo = null;
  if (isMargin(exchange)) {
    const pos = rows.filter((x) => !x.stable);
    const notional = pos.reduce((s, x) => s + x.value, 0);
    let blocked;
    if (mode === 'live') {
      blocked = (x) => x.margin ?? (notional ? liveMarginUsed * (x.value / notional) : 0); // Zerodha reports one total: split by notional
    } else {
      const m = await getPaperMargin(user._id, exchange);
      blocked = (x) => m[x.asset] ?? x.value * marginRateFor(exchange, x.asset);
    }
    pos.forEach((x) => { x.notional = x.value; x.value = blocked(x); delete x.margin; });
    const marginUsed = pos.reduce((s, x) => s + x.value, 0);
    rows = [{ asset: Q, amount: total - marginUsed, price: 1, value: total - marginUsed, change: 0, stable: true }, ...pos];
    marginInfo = { marginUsed, notional, freeMargin: total - marginUsed, leverage: total > 0 ? notional / total : 0 };
  }
  rows = rows.filter((x) => x.amount !== 0 || x.stable).sort((a, b) => b.value - a.value);
  rows.forEach((x) => (x.weightPct = total ? (x.value / total) * 100 : 0));
  return { mode, exchange, currency: Q, total, assets: rows, stablePct: rows.filter((x) => x.stable).reduce((s, x) => s + x.weightPct, 0), ...(marginInfo && { margin: marginInfo }) };
}

export async function valuePortfolio(user, mode = 'paper', exchange = 'binance') {
  if (isFx(exchange) || isMargin(exchange)) return valueFxPortfolio(user, mode, exchange);
  const balances = mode === 'live' ? await liveBalances(user) : await getPaperBalances(user._id);
  const assets = Object.keys(balances).filter((a) => !STABLES.has(a));
  const tickers = assets.length ? await bn.getTickers(assets.map((a) => `${a}USDT`)).catch(() => []) : [];
  const t = (a) => tickers.find((x) => x.symbol === `${a}USDT`);
  const priceOf = (a) => (STABLES.has(a) ? 1 : t(a)?.price || 0);
  const rows = Object.entries(balances)
    .map(([asset, amount]) => ({ asset, amount, price: priceOf(asset), value: amount * priceOf(asset), change: t(asset)?.change ?? 0, stable: STABLES.has(asset) }))
    .filter((x) => x.amount > 0 && (x.value > 0.01 || x.stable))
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, x) => s + x.value, 0);
  rows.forEach((x) => (x.weightPct = total ? (x.value / total) * 100 : 0));
  return { mode, currency: 'USDT', total, assets: rows, stablePct: rows.filter((x) => x.stable).reduce((s, x) => s + x.weightPct, 0) };
}

export async function portfolioIntelligence(user, mode = 'paper', exchange = 'binance') {
  const fx = isFx(exchange);
  const pf = await valuePortfolio(user, mode, exchange);
  const ownCandles = fx || isMargin(exchange); // positions keyed by the adapter's own symbols (pairs, contracts, perps)
  const cashName = pf.margin ? 'free margin' : fx ? 'INR cash' : 'stablecoins';
  const risky = pf.assets.filter((a) => !a.stable && a.value > 1).slice(0, 10);
  const series = await mapLimit(risky, 4, (a) => (ownCandles ? fxReturns(exchange, a.asset) : hourlyReturns(a.asset)).catch(() => []));
  const matrix = risky.map((a, i) => risky.map((b, j) => +(i === j ? 1 : pearson(series[i], series[j])).toFixed(2)));

  // Portfolio volatility from the covariance of hourly returns (annualised).
  const w = risky.map((a) => (a.notional ?? a.value) / (pf.total || 1)); // futures: price risk scales with notional, not margin
  const sd = (r) => {
    const m = r.reduce((s, v) => s + v, 0) / (r.length || 1);
    return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length || 1));
  };
  const sds = series.map(sd);
  let variance = 0;
  for (let i = 0; i < risky.length; i++) for (let j = 0; j < risky.length; j++) variance += w[i] * w[j] * sds[i] * sds[j] * matrix[i][j];
  const annualVolPct = Math.sqrt(variance) * Math.sqrt(fx ? (ex(exchange).sessionHours || 8) * 250 : 8760) * 100; // NSE trades its session hours x ~250 days a year

  const warnings = [];
  const recommendations = [];
  risky.forEach((a) => {
    if (a.weightPct > 40) warnings.push(`${a.asset} is ${a.weightPct.toFixed(0)}% of the portfolio (concentration above 40%)`);
  });
  const pairs = [];
  for (let i = 0; i < risky.length; i++) for (let j = i + 1; j < risky.length; j++) if (matrix[i][j] > 0.8) pairs.push(`${risky[i].asset}/${risky[j].asset}`);
  if (pairs.length) warnings.push(`Highly correlated holdings (>0.8): ${pairs.join(', ')} - they behave like one bet`);
  if (pf.stablePct < 20 && risky.length) recommendations.push(`Keep at least 20% in ${cashName} as dry powder and a volatility buffer.`);
  if (annualVolPct > 80) recommendations.push(`Portfolio volatility is very high - reduce position sizes or hold more ${cashName}.`);
  if (!risky.length) recommendations.push(`Portfolio is fully in ${cashName} - no market risk.`);

  const riskLevel = !risky.length ? 'NONE' : annualVolPct > 80 || warnings.length >= 2 ? 'HIGH' : annualVolPct > 40 || warnings.length ? 'MEDIUM' : 'LOW';
  const bots = await db.bots.find({ mode, userId: user._id });
  return {
    ...pf,
    exposurePct: 100 - pf.stablePct,
    annualVolPct: +annualVolPct.toFixed(1),
    riskLevel, warnings, recommendations,
    correlation: { assets: risky.map((a) => a.asset), matrix },
    openPositions: bots.filter((b) => b.position).map((b) => ({ bot: b.name, symbol: b.symbol, qty: b.position.qty, entry: b.position.entry, stopLoss: b.position.stopLoss })),
  };
}

// Records an equity snapshot (used for drawdown and the equity curve).
export async function snapshotEquity(user, mode = 'paper', exchange = 'binance') {
  const pf = await valuePortfolio(user, mode, exchange);
  await db.equity.insert({ userId: user._id, mode, account: accountOf(exchange), value: pf.total, time: Date.now() });
  return pf.total;
}
