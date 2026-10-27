// Bot engine (orchestrator): every bot runs Signal Engine 2.0 -> central Risk Engine -> execution.
// Multi-user, multi-exchange. Safety guards: kill switch, platform halt, exchange health, stale data,
// abnormal price, duplicate orders, API-failure auto-pause, model-failure fallback.
import { EventEmitter } from 'events';
import { db } from '../db/index.js';
import { analyze } from '../ai/analyzer.js';
import { ex, fetchCandles, symbolInfo, tradingFor, credsFor } from '../exchange/index.js';
import { computeAll, last } from '../ai/indicators.js';
import { regimeSeries } from '../ai/regime.js';
import { STRATEGY_LIBRARY, getStrategy } from '../ai/strategies.js';
import { baseAsset } from '../ai/util.js';
import { entryContext, journalClosedTrade } from '../ai/journal.js';
import { snapshotEquity, valuePortfolio } from '../ai/portfolio.js';
import { paperOrder } from './paperBroker.js';
import { trailStop, trailStopShort } from './risk.js';
import { evaluateRisk } from './riskEngine.js';
import { buildGrid, gridActions, GRID_REGIMES, GRID_KILL_REGIMES } from './grid.js';
import { getSettings, updateSettings, health, abnormalPrice, staleData, orderCooldown, markOrder } from './safety.js';
import { notify } from '../notify.js';

export const events = new EventEmitter();
const TICK_MS = 15000;
const timers = new Map();
const busy = new Set();
const errorCount = new Map();
const lastWarn = new Map();
const lastPrice = new Map();

export const BOT_DEFAULTS = {
  exchange: 'binance',
  interval: '15m',
  strategy: 'adaptive',
  mode: 'paper',
  useClaude: false,
  threshold: 30,
  riskPct: 1,
  maxPositionPct: 25,
  trailingStop: true,
  trailAtr: 2.5,
  dailyLossLimitPct: 5,
};

const userCache = new Map();
async function getUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 10000) return hit.user;
  const user = await db.users.findOne({ _id: id });
  userCache.set(id, { at: Date.now(), user });
  return user;
}

async function log(bot, level, msg, data) {
  const row = await db.logs.insert({ userId: bot?.userId || null, botId: bot?._id || null, level, msg, data, time: Date.now() });
  events.emit('log', row);
}

async function warnOnce(bot, key, msg) {
  const k = `${bot._id}:${key}`;
  if (Date.now() - (lastWarn.get(k) || 0) < 600000) return;
  lastWarn.set(k, Date.now());
  await log(bot, 'warn', msg);
}

// Executes a market order (paper or live, any supported exchange) and records the trade.
// short=true: SELL opens a short (sized by quoteAmount), BUY covers it (by quantity). Only adapters with canShort.
export async function executeOrder({ user, bot, mode, exchange = 'binance', symbol, side, quoteAmount, quantity, reason, signal, clientOrderId, extra = {}, short = false }) {
  const info = (await symbolInfo(exchange, symbol)) || { base: baseAsset(symbol), quote: symbol.slice(baseAsset(symbol).length) };
  let fill;
  if (mode === 'live') {
    const { client } = await tradingFor(user, exchange);
    fill = await client.marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, short });
  } else {
    fill = await paperOrder({ userId: user._id, exchange, side, symbol, base: info.base, quote: info.quote, quoteAmount, quantity, short });
  }
  const trade = await recordTrade({ user, bot, mode, exchange, symbol, side, fill, reason, signal, extra: short ? { ...extra, positionSide: 'short' } : extra });
  if (fill.sim?.partial) await log(bot || { userId: user._id }, 'warn', `Partial fill on ${symbol}: the paper book ran out of liquidity`);
  return { trade, fill, info };
}

// Writes a fill to the trade history (market orders, and exchange-side stops that filled on their own).
async function recordTrade({ user, bot, mode, exchange, symbol, side, fill, reason, signal, extra = {} }) {
  const trade = await db.trades.insert({
    userId: user._id,
    botId: bot?._id || null,
    botName: bot?.name || extra.botName || 'Manual',
    mode, exchange, symbol, side,
    qty: fill.qty, price: fill.price, cost: fill.cost, fee: fill.fee,
    sim: fill.sim,
    reason,
    signal: signal ? { score: signal.score, action: signal.action, signal: signal.signal, strategy: signal.strategyUsed || signal.strategy, probability: signal.probability, quality: signal.quality, regime: signal.regime?.name } : null,
    time: Date.now(),
    ...extra,
  });
  events.emit('trade', trade);
  return trade;
}

const qtyText = (exchange, qty) => {
  const lot = ex(exchange).lotUnits;
  return lot > 1 ? `${+(qty / lot).toFixed(2)} lot(s)` : lot === 1 ? `${qty} share(s)` : qty.toFixed(6);
};

async function openPosition(bot, user, signal, sizing, candles, candleTime) {
  const key = `bot:${bot._id}`;
  const settings = await getSettings(user._id);
  const dup = orderCooldown(key, settings.risk.orderCooldownSec);
  if (dup) return log(bot, 'warn', dup);
  markOrder(key);
  const short = signal.signal === 'SHORT';
  const { fill, info } = await executeOrder({
    user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: short ? 'SELL' : 'BUY', quoteAmount: sizing.notional, short,
    reason: `${signal.signal} p=${(signal.probability * 100).toFixed(0)}% ${signal.quality} (${signal.strategyName})`, signal,
    clientOrderId: `nx${bot._id.slice(0, 8)}${candleTime}${short ? 'X' : 'B'}`,
  });
  const slDist = Math.abs(signal.price - signal.stopLoss);
  const tpDist = Math.abs(signal.takeProfit - signal.price);
  const dir = short ? -1 : 1;
  // For a short, `cost` holds the net sale proceeds; P&L on cover = proceeds - cost to buy back.
  const position = {
    side: short ? 'short' : 'long',
    qty: fill.qty, entry: fill.price, cost: fill.cost,
    stopLoss: fill.price - dir * slDist, initialStop: fill.price - dir * slDist, takeProfit: fill.price + dir * tpDist,
    highest: fill.price, lowest: fill.price, openedAt: Date.now(),
    entryContext: entryContext(signal, candles),
    riskPct: sizing.riskPct,
    contract: fill.contract, contractExpiry: fill.contractExpiry || info.expiry, // futures only
  };
  await db.bots.update(bot._id, { position });
  await log(bot, 'trade', `${short ? 'SELL SHORT' : 'BUY'} ${qtyText(bot.exchange, fill.qty)} ${info.base} @ ${fill.price.toFixed(4)} | risk ${sizing.riskPct}% | SL ${position.stopLoss.toFixed(4)} TP ${position.takeProfit.toFixed(4)}`);
  notify(user._id, { type: 'trade', title: `${bot.name}: ${short ? 'sold short' : 'bought'} ${info.base}`, body: `${qtyText(bot.exchange, fill.qty)} @ ${fill.price.toFixed(4)} (${bot.mode})`, important: bot.mode === 'live' });
  if (bot.copyable && !short) events.emit('copy:open', { bot, user, notional: fill.cost, equity: sizing.equity });
  // Put the stop on the exchange straight away instead of waiting for the next tick.
  if (bot.mode === 'live') await syncExchangeStop(await db.bots.findOne({ _id: bot._id }), user, fill.price).catch((err) => log(bot, 'error', `Exchange stop: ${err.message}`));
}

// ---- Live position safety: exchange-side stop-loss + reconciliation with the real balance ----
const STOP_LIMIT_GAP = 0.01; // the stop's limit price sits 1% under its trigger so it fills in a fast drop
const STOP_MOVE_MIN = 0.003; // move the exchange stop only when the trailing stop rose >= 0.3% of price...
const STOP_MOVE_EVERY_MS = 60000; // ...and at most once a minute
const reconciled = new Set();

const heldOnExchange = async (client, bot) => {
  const base = (await symbolInfo(bot.exchange, bot.symbol))?.base || baseAsset(bot.symbol);
  const b = (await client.getAccount()).find((x) => x.asset === base);
  return { free: b?.free || 0, total: (b?.free || 0) + (b?.locked || 0) };
};

// Keeps a resting stop order on the exchange in line with the bot's (trailing) stop. Runs every tick for live
// positions: places it if missing, moves it up as the trail rises, and notices when the exchange filled it.
async function syncExchangeStop(bot, user, price) {
  const pos = bot?.position;
  const short = pos?.side === 'short';
  if (!pos || bot.mode !== 'live' || bot.grid || !(pos.stopLoss > 0) || (short ? pos.stopLoss <= price : pos.stopLoss >= price) || pos.exchangeStop === 'unsupported') return;
  const { client } = await tradingFor(user, bot.exchange);
  if (!client.stopLossOrder) {
    await db.bots.update(bot._id, { position: { ...pos, exchangeStop: 'unsupported' } });
    return log(bot, 'warn', `${bot.exchange} exchange-side stops are not supported yet - this position's stop-loss is enforced by the bot only, so keep the server running`);
  }
  const so = pos.stopOrder;
  if (so) {
    const st = await client.getOrder(bot.symbol, so.orderId);
    if (st.status === 'FILLED') return closePosition(bot, user, price, 'Exchange stop-loss filled');
    const gone = ['CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(st.status) && st.executedQty === 0;
    const improved = short ? so.stopPrice - pos.stopLoss : pos.stopLoss - so.stopPrice; // trailing tightened
    const move = st.status === 'NEW' && improved >= price * STOP_MOVE_MIN && Date.now() - so.at >= STOP_MOVE_EVERY_MS;
    if (!gone && !move) return;
    if (move) {
      await client.cancelOrder(bot.symbol, so.orderId);
      // It may have filled between the status check and the cancel.
      if ((await client.getOrder(bot.symbol, so.orderId)).executedQty > 0) return closePosition(bot, user, price, 'Exchange stop-loss filled');
    }
    await db.bots.update(bot._id, { position: { ...pos, stopOrder: null } });
  }
  try {
    const o = await client.stopLossOrder({
      symbol: bot.symbol, quantity: pos.qty, stopPrice: pos.stopLoss, limitPrice: pos.stopLoss * (short ? 1 + STOP_LIMIT_GAP : 1 - STOP_LIMIT_GAP), side: short ? 'BUY' : 'SELL',
      clientOrderId: `nx${bot._id.slice(0, 8)}${Date.now()}L`,
    });
    await db.bots.update(bot._id, { position: { ...pos, stopOrder: { orderId: o.orderId, stopPrice: o.stopPrice, qty: o.qty, at: Date.now() } } });
    await log(bot, 'info', `${so ? `Exchange stop moved ${short ? 'down' : 'up'}` : 'Exchange stop-loss placed'}: ${short ? `buy ${o.qty} if price >= ${o.stopPrice}` : `sell ${o.qty} if price <= ${o.stopPrice}`} (limit ${o.limitPrice})`);
  } catch (err) {
    // Not enough coin to cover the stop usually means the balance changed outside the bot - re-check it next tick.
    if (err.code === -2010) reconciled.delete(bot._id);
    await warnOnce(bot, 'exchange-stop', `Could not place the exchange stop-loss (${err.message}) - the bot-side stop is still active and it will retry`);
    notify(user._id, { type: 'warn', title: `${bot.name}: exchange stop not placed`, body: err.message, important: true });
  }
}

// Checks a live position against the exchange after a (re)start: was it stopped out while the server was
// down, or was the coin sold / moved outside the bot?
async function reconcileLive(bot, user, price) {
  const pos = bot.position;
  const { client } = await tradingFor(user, bot.exchange);
  if (pos.stopOrder && client.getOrder) {
    const st = await client.getOrder(bot.symbol, pos.stopOrder.orderId);
    if (st.executedQty > 0) return closePosition(bot, user, price, 'Exchange stop-loss filled while the bot was offline');
  }
  const { total } = pos.side === 'short' ? { total: client.shortUnits ? await client.shortUnits(bot.symbol) : 0 } : await heldOnExchange(client, bot);
  if (total >= pos.qty * 0.99) return;
  if (total < pos.qty * 0.5) return closePosition(bot, user, price, 'Position no longer on the exchange');
  // Partly gone: shrink the position to what is really held and re-place the stop for that size.
  if (pos.stopOrder) await client.cancelOrder(bot.symbol, pos.stopOrder.orderId);
  await db.bots.update(bot._id, { position: { ...pos, qty: total, cost: pos.cost * (total / pos.qty), stopOrder: null } });
  await log(bot, 'warn', `Exchange holds ${total} but the bot expected ${pos.qty} - position resized to match the exchange`);
}

// Live exit: pull the exchange stop first (so its coins are free and it cannot fill after we sell), record any
// part it already filled, then market-sell the rest - never more than the exchange says is actually held.
async function liveSell(bot, user, pos, reason, signal) {
  const { client } = await tradingFor(user, bot.exchange);
  const out = [];
  let sold = 0;
  if (pos.stopOrder && client.cancelOrder) {
    await client.cancelOrder(bot.symbol, pos.stopOrder.orderId);
    const st = await client.getOrder(bot.symbol, pos.stopOrder.orderId);
    if (st.executedQty > 0) {
      const fill = { qty: st.executedQty, price: st.price, cost: st.cost, fee: st.fee };
      out.push({ fill, trade: await recordTrade({ user, bot, mode: 'live', exchange: bot.exchange, symbol: bot.symbol, side: 'SELL', fill, reason: 'Exchange stop-loss filled', signal }) });
      sold += st.executedQty;
    }
  }
  const info = await symbolInfo(bot.exchange, bot.symbol);
  const qty = Math.min(pos.qty - sold, (await heldOnExchange(client, bot)).free);
  const px = await ex(bot.exchange).getPrice(bot.symbol);
  if (qty > (info?.minQty || 0) && qty * px >= (info?.minNotional || 0)) {
    const { fill, trade } = await executeOrder({ user, bot, mode: 'live', exchange: bot.exchange, symbol: bot.symbol, side: 'SELL', quantity: qty, reason, signal, clientOrderId: `nx${bot._id.slice(0, 8)}${Date.now()}S` });
    out.push({ fill, trade });
  }
  return out;
}

// Live cover of a short: pull the exchange (buy) stop first, record any part it filled, then buy back the rest -
// never more than the exchange says is still short.
async function liveCover(bot, user, pos, reason, signal) {
  const { client } = await tradingFor(user, bot.exchange);
  const out = [];
  let covered = 0;
  if (pos.stopOrder && client.cancelOrder) {
    await client.cancelOrder(bot.symbol, pos.stopOrder.orderId);
    const st = await client.getOrder(bot.symbol, pos.stopOrder.orderId);
    if (st.executedQty > 0) {
      const fill = { qty: st.executedQty, price: st.price, cost: st.executedQty * st.price + st.fee, fee: st.fee };
      out.push({ fill, trade: await recordTrade({ user, bot, mode: 'live', exchange: bot.exchange, symbol: bot.symbol, side: 'BUY', fill, reason: 'Exchange stop-loss filled', signal, extra: { positionSide: 'short' } }) });
      covered += st.executedQty;
    }
  }
  const qty = Math.min(pos.qty - covered, client.shortUnits ? await client.shortUnits(bot.symbol) : 0);
  if (qty > 0) {
    const { fill, trade } = await executeOrder({ user, bot, mode: 'live', exchange: bot.exchange, symbol: bot.symbol, side: 'BUY', quantity: qty, short: true, reason, signal, clientOrderId: `nx${bot._id.slice(0, 8)}${Date.now()}C` });
    out.push({ fill, trade });
  }
  return out;
}

async function closePosition(bot, user, price, reason, signal, exitCtx = {}) {
  const pos = bot.position;
  const short = pos.side === 'short';
  const key = `bot:${bot._id}:close`;
  if (orderCooldown(key, 10)) return;
  markOrder(key);
  const fills = bot.mode === 'live'
    ? await (short ? liveCover : liveSell)(bot, user, pos, reason, signal)
    : [await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: short ? 'BUY' : 'SELL', quantity: pos.qty, short, reason, signal, clientOrderId: `nx${bot._id.slice(0, 8)}${Date.now()}${short ? 'C' : 'S'}` })];
  if (!fills.length) {
    await db.bots.update(bot._id, { position: null });
    await log(bot, 'warn', `Position closed in the bot only: there was no ${bot.symbol} left on the exchange to sell (${reason}). It was sold or moved outside the bot.`);
    notify(user._id, { type: 'warn', title: `${bot.name}: position not found on the exchange`, body: 'Closed in the bot without a trade - check your exchange account', important: true });
    return;
  }
  let pnl = 0;
  let soldQty = 0;
  let proceeds = 0;
  for (const { fill, trade } of fills) {
    const share = fill.qty / pos.qty;
    const p = short ? pos.cost * share - fill.cost : fill.cost - pos.cost * share;
    events.emit('trade', await db.trades.update(trade._id, { pnl: p, pnlPct: (p / (pos.cost * share)) * 100 }));
    pnl += p;
    soldQty += fill.qty;
    proceeds += fill.price * fill.qty;
  }
  const exitPrice = proceeds / soldQty;
  const soldShare = Math.min(1, soldQty / pos.qty);
  const pnlPct = (pnl / (pos.cost * soldShare)) * 100;
  const stats = bot.stats || { trades: 0, wins: 0, pnl: 0 };
  stats.trades++;
  if (pnl > 0) stats.wins++;
  stats.pnl += pnl;
  const remaining = pos.qty - soldQty;
  // A live exit sells everything the exchange holds, so whatever is left over does not exist (fee dust, sold elsewhere).
  const leftover = bot.mode !== 'live' && remaining > pos.qty * 0.001 ? { ...pos, qty: remaining, cost: pos.cost * (1 - soldShare) } : null;
  await db.bots.update(bot._id, { position: leftover, stats, grid: leftover ? bot.grid : bot.grid ? null : undefined });
  await log(bot, pnl >= 0 ? 'profit' : 'loss', `${short ? 'BUY TO COVER' : 'SELL'} @ ${exitPrice.toFixed(4)} (${reason}) PnL ${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)${leftover ? ' - partial, remainder still open' : ''}`);
  if (bot.mode === 'live' && remaining > pos.qty * 0.01) await log(bot, 'warn', `The exchange held ${remaining.toFixed(8)} less than the bot expected - only what was there was sold`);
  const ccy = (await symbolInfo(bot.exchange, bot.symbol).catch(() => null))?.quote || 'USDT';
  notify(user._id, { type: pnl >= 0 ? 'profit' : 'loss', title: `${bot.name}: ${pnl >= 0 ? 'profit' : 'loss'} ${pnl.toFixed(2)} ${ccy}`, body: `${reason} · ${pnlPct.toFixed(2)}%`, important: bot.mode === 'live' });
  if (bot.copyable) events.emit('copy:close', { bot, reason });
  const j = await journalClosedTrade({ bot, position: pos, exit: { price: exitPrice, pnl, reason, ...exitCtx } }).catch(() => null);
  if (j) events.emit('journal', j);
}

// ---- DCA ----
async function dcaTick(bot, user, signal, price, candleTime) {
  const cfg = STRATEGY_LIBRARY.dca;
  const pos = bot.position;
  const tpPct = bot.dcaTakeProfitPct ?? cfg.takeProfitPct;
  if (pos && price >= pos.entry * (1 + tpPct / 100)) return closePosition(bot, user, price, `DCA take-profit +${tpPct}%`, signal);
  const every = bot.dcaEvery ?? cfg.every;
  const tranches = pos?.tranches || 0;
  const due = !bot.lastDcaCandle || (candleTime - bot.lastDcaCandle) / bot.intervalSec >= every;
  if (!due || tranches >= (bot.dcaMaxTranches ?? cfg.maxTranches)) return;
  if (signal.score < -20 || ['PANIC', 'BREAKDOWN'].includes(signal.regime?.name)) return log(bot, 'info', `DCA tranche skipped: score ${signal.score}, regime ${signal.regime?.label}`);
  if (!(await getSettings(user._id)).tradingEnabled) return;
  const pf = await valuePortfolio(user, bot.mode, bot.exchange);
  const amount = pf.total * ((bot.dcaTranchePct ?? cfg.tranchePct) / 100);
  const { fill } = await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: 'BUY', quoteAmount: amount, reason: `DCA tranche ${tranches + 1}`, signal, clientOrderId: `nx${bot._id.slice(0, 8)}${candleTime}D` });
  const qty = (pos?.qty || 0) + fill.qty;
  const cost = (pos?.cost || 0) + fill.cost;
  const avg = cost / qty;
  const position = { qty, cost, entry: avg, stopLoss: 0, initialStop: avg * 0.9, takeProfit: avg * (1 + tpPct / 100), highest: Math.max(pos?.highest || 0, price), lowest: Math.min(pos?.lowest || price, price), openedAt: pos?.openedAt || Date.now(), tranches: tranches + 1, entryContext: pos?.entryContext || entryContext(signal, []) };
  await db.bots.update(bot._id, { position, lastDcaCandle: candleTime });
  await log(bot, 'trade', `DCA tranche ${tranches + 1}: bought ${fill.qty.toFixed(6)} @ ${fill.price.toFixed(4)} | avg cost ${avg.toFixed(4)}`);
}

// ---- AI Grid (runs every tick on price) ----
const gridPosition = (grid) => {
  if (!grid?.lots?.length) return null;
  const qty = grid.lots.reduce((s, l) => s + l.qty, 0);
  const cost = grid.lots.reduce((s, l) => s + l.cost, 0);
  return { qty, cost, entry: cost / qty, stopLoss: grid.lower - grid.atr, initialStop: grid.lower - grid.atr, takeProfit: grid.upper, highest: grid.upper, lowest: grid.lower, openedAt: grid.builtAt * 1000, gridLots: grid.lots.length };
};

async function gridTick(bot, user, price, closed, ind, regime, htfRegime) {
  const settings = await getSettings(user._id);
  let grid = bot.grid;
  const prev = lastPrice.get(bot._id) ?? price;
  lastPrice.set(bot._id, price);
  const atr = last(ind.atr) || price * 0.01;
  const sellAll = async (reason) => {
    for (const lot of grid.lots) {
      const { fill } = await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: 'SELL', quantity: lot.qty, reason });
      const pnl = fill.cost - lot.cost;
      await db.trades.update((await db.trades.find({ botId: bot._id }, { sort: { time: -1 }, limit: 1 }))[0]._id, { pnl, pnlPct: (pnl / lot.cost) * 100 });
      bot.stats = { trades: (bot.stats?.trades || 0) + 1, wins: (bot.stats?.wins || 0) + (pnl > 0 ? 1 : 0), pnl: (bot.stats?.pnl || 0) + pnl };
    }
    await db.bots.update(bot._id, { grid: null, position: null, stats: bot.stats });
    await log(bot, 'warn', `Grid closed: ${reason}`);
    notify(user._id, { type: 'warn', title: `${bot.name}: grid closed`, body: reason, important: bot.mode === 'live' });
  };

  if (grid && grid.lots.length && (price < grid.lower - grid.atr || GRID_KILL_REGIMES.includes(regime) || GRID_KILL_REGIMES.includes(htfRegime))) {
    return sellAll(price < grid.lower - grid.atr ? 'range breakdown' : `regime turned ${regime}`);
  }
  if (!grid) {
    if (!settings.tradingEnabled || !GRID_REGIMES.includes(regime) || GRID_KILL_REGIMES.includes(htfRegime)) return;
    const g = buildGrid(closed, STRATEGY_LIBRARY.grid.levels);
    if (!g) return warnOnce(bot, 'grid-range', 'Range too narrow for a profitable grid - waiting');
    const pf = await valuePortfolio(user, bot.mode, bot.exchange);
    g.perLevel = (pf.total * ((bot.maxPositionPct ?? 25) / 100)) / g.levels.length;
    g.atr = atr;
    await db.bots.update(bot._id, { grid: g });
    return log(bot, 'info', `Grid built: ${g.levels.length} levels ${g.lower.toFixed(4)} - ${g.upper.toFixed(4)} (step ${((g.step / g.lower) * 100).toFixed(2)}%), ${g.perLevel.toFixed(2)} USDT per level`);
  }
  const { sells, buys } = gridActions(grid, prev, price);
  let changed = false;
  for (const lot of sells) {
    const { fill } = await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: 'SELL', quantity: lot.qty, reason: `Grid take-profit level ${lot.level.toFixed(4)}` });
    const pnl = fill.cost - lot.cost;
    const t = (await db.trades.find({ botId: bot._id }, { sort: { time: -1 }, limit: 1 }))[0];
    await db.trades.update(t._id, { pnl, pnlPct: (pnl / lot.cost) * 100 });
    grid.lots = grid.lots.filter((l) => l !== lot);
    bot.stats = { trades: (bot.stats?.trades || 0) + 1, wins: (bot.stats?.wins || 0) + (pnl > 0 ? 1 : 0), pnl: (bot.stats?.pnl || 0) + pnl };
    await log(bot, pnl >= 0 ? 'profit' : 'loss', `Grid sell @ ${fill.price.toFixed(4)} PnL ${pnl.toFixed(2)}`);
    changed = true;
  }
  if (settings.tradingEnabled && GRID_REGIMES.includes(regime)) {
    for (const lv of buys) {
      const { fill } = await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: 'BUY', quoteAmount: grid.perLevel, reason: `Grid buy level ${lv.toFixed(4)}` });
      grid.lots.push({ level: lv, qty: fill.qty, cost: fill.cost });
      await log(bot, 'trade', `Grid buy @ ${fill.price.toFixed(4)} (level ${lv.toFixed(4)})`);
      changed = true;
    }
  }
  if (!grid.lots.length && !GRID_REGIMES.includes(regime)) {
    await db.bots.update(bot._id, { grid: null, position: null });
    return log(bot, 'info', `Grid retired: regime is ${regime}`);
  }
  if (changed) await db.bots.update(bot._id, { grid, position: gridPosition(grid), stats: bot.stats });
}

const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

async function pauseBot(bot, reason) {
  stopTimer(bot._id);
  await db.bots.update(bot._id, { status: 'paused', pausedReason: reason });
  await log(bot, 'warn', `Bot paused: ${reason}`);
  notify(bot.userId, { type: 'warn', title: `${bot.name} paused`, body: reason, important: true });
  events.emit('bot', { botId: bot._id, userId: bot.userId, status: 'paused' });
}

async function tick(botId) {
  if (busy.has(botId)) return;
  busy.add(botId);
  let bot;
  try {
    bot = await db.bots.findOne({ _id: botId });
    if (!bot || bot.status !== 'running') return stopTimer(botId);
    const user = await getUser(bot.userId);
    if (!user || user.status === 'suspended') return pauseBot(bot, 'Account suspended');
    bot.intervalSec = INTERVAL_SEC[bot.interval] || 3600;
    bot.exchange ||= 'binance';
    const settings = await getSettings(user._id);

    if (!health.exchangeUp && bot.exchange === 'binance') return warnOnce(bot, 'exchange', 'Exchange unreachable - trading paused until it recovers');
    // Exchanges with trading hours (NSE forex): nothing can be traded while closed; positions are held overnight.
    const adapter = ex(bot.exchange);
    if (adapter.marketOpen && !adapter.marketOpen()) return;

    const candlesAll = await fetchCandles(bot.exchange, bot.symbol, bot.interval, 500);
    const closed = candlesAll.slice(0, -1);
    const price = last(candlesAll).close;
    const lastClosed = last(closed);
    const ind = computeAll(closed);
    const atr = last(ind.atr) || price * 0.01;

    const stale = staleData(lastClosed.time, bot.interval);
    if (stale) return warnOnce(bot, 'stale', stale);
    const abnormal = abnormalPrice(price, lastClosed.close, atr, settings.risk.abnormalMovePct);
    if (abnormal) return warnOnce(bot, 'abnormal', `Abnormal price protection: ${abnormal} - skipping this tick`);

    // Grid bots trade on price every tick.
    if (bot.strategy === 'grid') {
      const regimes = regimeSeries(closed, ind);
      const { buildContext } = await import('../ai/models.js');
      const ctx = buildContext(closed, bot.interval);
      const htfRegime = ctx.htf?.regimes[ctx.htf.index[closed.length - 1]]?.regime || null;
      await gridTick(bot, user, price, closed, ind, last(regimes)?.regime, htfRegime);
      errorCount.set(botId, 0);
      if (bot.position || bot.grid) events.emit('position', { botId, userId: bot.userId, price, position: (await db.bots.findOne({ _id: botId })).position });
      return;
    }

    // 1. Protect the open position on every tick (runs even when auto-trading is disabled).
    // Live: on the first tick after a (re)start, check the position against the real exchange balance.
    if (bot.position && bot.mode === 'live' && !bot.grid && !reconciled.has(botId)) {
      reconciled.add(botId);
      await reconcileLive(bot, user, price);
      bot = await db.bots.findOne({ _id: botId });
      if (!bot.position) return;
    }
    if (bot.position && bot.strategy !== 'dca') {
      const p = bot.position;
      const patch = { highest: Math.max(p.highest ?? p.entry, price), lowest: Math.min(p.lowest ?? p.entry, price) };
      // A strategy that defines its own trailing width (rule strategies) uses it; others use the bot's setting.
      const trailFn = p.side === 'short' ? trailStopShort : trailStop;
      if (bot.trailingStop) Object.assign(patch, trailFn({ ...p, ...patch }, price, getStrategy(bot.strategy)?.trail ?? bot.trailAtr, atr));
      if (patch.highest !== p.highest || patch.lowest !== p.lowest || patch.stopLoss !== p.stopLoss) {
        bot = await db.bots.update(bot._id, { position: { ...p, ...patch } });
      }
      events.emit('position', { botId, userId: bot.userId, price, position: bot.position });
      const regimeNow = last(regimeSeries(closed, ind));
      const exitCtx = { atr, regime: regimeNow?.regime };
      const isShort = bot.position.side === 'short';
      if (isShort ? price >= bot.position.stopLoss : price <= bot.position.stopLoss) return await closePosition(bot, user, price, 'Stop-loss hit', null, exitCtx);
      // Futures: exit a day before the contract expires; the next entry uses the new front month.
      if (bot.position.contractExpiry && Date.now() > bot.position.contractExpiry - 86400e3) return await closePosition(bot, user, price, 'Futures contract expiry (rolled out)', null, exitCtx);
      if (isShort ? price <= bot.position.takeProfit : price >= bot.position.takeProfit) return await closePosition(bot, user, price, 'Take-profit hit', null, exitCtx);
      if (bot.mode === 'live') {
        await syncExchangeStop(bot, user, price);
        bot = await db.bots.findOne({ _id: botId });
        if (!bot.position) return;
      }
    } else if (bot.position) {
      events.emit('position', { botId, userId: bot.userId, price, position: bot.position });
    }

    // 2. AI analysis once per closed candle.
    if (bot.lastCandleTime === lastClosed.time) return;
    let signal;
    try {
      signal = await analyze(bot.symbol, bot.interval, {
        candles: closed, price, exchange: bot.exchange, strategy: bot.strategy === 'dca' ? 'adaptive' : bot.strategy,
        useClaude: bot.useClaude, threshold: bot.threshold, allowShort: Boolean(bot.allowShort) && bot.strategy !== 'dca' && bot.strategy !== 'grid',
        position: bot.position ? { side: bot.position.side || 'long', entry: bot.position.entry, stopLoss: bot.position.stopLoss, takeProfit: bot.position.takeProfit, unrealizedPct: +((((price - bot.position.entry) / bot.position.entry) * 100) * (bot.position.side === 'short' ? -1 : 1)).toFixed(2) } : null,
      });
      if (!Number.isFinite(signal.score) || !Number.isFinite(signal.probability)) throw new Error('Model produced an invalid output');
    } catch (err) {
      await db.bots.update(bot._id, { lastCandleTime: lastClosed.time });
      return log(bot, 'error', `Analysis failed - no trade this candle (${err.message})`);
    }

    let risk = null;
    if ((signal.signal === 'LONG' || signal.signal === 'SHORT') && !bot.position && bot.strategy !== 'dca') risk = await evaluateRisk(signal, { user, bot, mode: bot.mode, exchange: bot.exchange });
    const saved = await db.signals.insert({
      userId: bot.userId, botId, exchange: bot.exchange, symbol: bot.symbol, interval: bot.interval, time: signal.time, price, signal: signal.signal, score: signal.score,
      probability: signal.probability, expectedReturnPct: signal.expectedReturnPct, rr: signal.rr, quality: signal.quality,
      regime: signal.regime?.name, strategy: signal.strategyUsed, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
      decision: risk?.decision || null, rejectedBy: risk?.rejectedBy || [], outcome: null, components: signal.components,
    });
    await db.bots.update(bot._id, {
      lastCandleTime: lastClosed.time,
      lastSignal: { signal: signal.signal, action: signal.action, score: signal.score, probability: signal.probability, quality: signal.quality, regime: signal.regime?.label, strategy: signal.strategyName, decision: risk?.decision, time: signal.time, claude: signal.claude?.decision?.reasoning },
    });
    events.emit('signal', saved);
    errorCount.set(botId, 0);
    await log(bot, 'info', `${signal.signal} | ${signal.regime?.label} -> ${signal.strategyName} | score ${signal.score} | p=${(signal.probability * 100).toFixed(0)}% | E[r] ${signal.expectedReturnPct}% | R:R ${signal.rr} | ${signal.quality}${risk ? ` | ${risk.decision}${risk.rejectedBy.length ? ` (${risk.rejectedBy.join(', ')})` : ''}` : ''}`);

    if (bot.strategy === 'dca') return await dcaTick(bot, user, signal, price, lastClosed.time);
    if (risk?.approved) {
      await openPosition(bot, user, signal, { notional: risk.position.notional, riskPct: risk.finalRiskPct, equity: risk.account.equity }, closed, lastClosed.time);
    } else if (signal.signal === 'EXIT' && bot.position) {
      await closePosition(bot, user, price, `AI exit (score ${signal.score}, ${signal.regime?.label})`, signal, { atr, regime: signal.regime?.name });
    }
  } catch (err) {
    if (err.code === 'KITE_LOGIN' && bot) {
      // Zerodha sessions end every morning: not a bot fault, so it does not count towards auto-pause.
      await warnOnce(bot, 'kite-login', `${err.message} - the bot is waiting`);
      if (Date.now() - (lastWarn.get(`kite-notify:${bot.userId}`) || 0) > 6 * 3600e3) {
        lastWarn.set(`kite-notify:${bot.userId}`, Date.now());
        notify(bot.userId, { type: 'warn', title: 'Log in to Zerodha', body: 'Your Kite session has expired, so forex bots are waiting. Open Account > Exchange connections and click "Log in to Kite".', important: true });
      }
      return;
    }
    const n = (errorCount.get(botId) || 0) + 1;
    errorCount.set(botId, n);
    if (bot) await log(bot, 'error', `${err.message} (${n} in a row)`);
    const settings = bot?.userId ? await getSettings(bot.userId).catch(() => null) : null;
    if (bot && n >= (settings?.risk.maxConsecutiveErrors || 5)) await pauseBot(bot, `Auto-paused after ${n} consecutive errors: ${err.message}`);
  } finally {
    busy.delete(botId);
  }
}

function stopTimer(botId) {
  clearInterval(timers.get(botId));
  timers.delete(botId);
}

export function startBot(botId) {
  stopTimer(botId);
  errorCount.set(botId, 0);
  lastPrice.delete(botId);
  reconciled.delete(botId);
  timers.set(botId, setInterval(() => tick(botId), TICK_MS));
  tick(botId);
}

export function stopBot(botId) {
  stopTimer(botId);
}

// Shutdown: stops every tick timer (bots stay "running" in the DB, so they resume on the next start) and waits
// for ticks already in progress, so an order is never cut off between the exchange call and the DB write.
export async function stopAllBots(timeoutMs = 10000) {
  for (const id of [...timers.keys()]) stopTimer(id);
  const until = Date.now() + timeoutMs;
  while (busy.size && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return busy.size === 0;
}

export async function closeBotPosition(botId, userId) {
  const bot = await db.bots.findOne({ _id: botId });
  if (!bot || bot.userId !== userId) throw Object.assign(new Error('Bot not found'), { status: 404 });
  if (!bot.position) throw Object.assign(new Error('No open position'), { status: 400 });
  const user = await getUser(bot.userId);
  if (bot.grid?.lots?.length) {
    await gridSellAllExternal(bot, user, 'Manual close');
    return;
  }
  await closePosition(bot, user, await ex(bot.exchange).getPrice(bot.symbol), 'Manual close');
}

async function gridSellAllExternal(bot, user, reason) {
  for (const lot of bot.grid.lots) {
    const { fill } = await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: 'SELL', quantity: lot.qty, reason });
    const t = (await db.trades.find({ botId: bot._id }, { sort: { time: -1 }, limit: 1 }))[0];
    await db.trades.update(t._id, { pnl: fill.cost - lot.cost, pnlPct: ((fill.cost - lot.cost) / lot.cost) * 100 });
  }
  await db.bots.update(bot._id, { grid: null, position: null });
}

// ---- Kill switch (per user): stop bots, cancel orders, close positions, disable auto-trading ----
export async function killSwitch(userId, reason = 'Manual kill switch') {
  await updateSettings(userId, { tradingEnabled: false, killSwitchAt: Date.now(), killSwitchReason: reason });
  const user = await getUser(userId);
  const report = { stopped: 0, closed: [], failed: [], cancelled: [] };
  const bots = await db.bots.find({ userId });
  for (const b of bots) {
    if (b.status === 'running' || b.status === 'paused') {
      stopTimer(b._id);
      await db.bots.update(b._id, { status: 'stopped' });
      report.stopped++;
    }
  }
  for (const [exchange, symbols] of Object.entries(bots.filter((b) => b.mode === 'live').reduce((m, b) => ((m[b.exchange || 'binance'] ||= new Set()).add(b.symbol), m), {}))) {
    if (!(await credsFor(user, exchange).catch(() => null))) continue;
    for (const s of symbols) {
      try {
        const { client } = await tradingFor(user, exchange);
        await client.cancelOpenOrders(s);
        report.cancelled.push(`${exchange}:${s}`);
      } catch (err) {
        report.failed.push(`${exchange}:${s} cancel: ${err.message}`);
      }
    }
  }
  for (const b of await db.bots.find({ userId })) {
    if (!b.position) continue;
    try {
      if (b.grid?.lots?.length) await gridSellAllExternal(b, user, `Kill switch: ${reason}`);
      else await closePosition(b, user, await ex(b.exchange).getPrice(b.symbol), `Kill switch: ${reason}`);
      report.closed.push(b.name);
    } catch (err) {
      report.failed.push(`${b.name}: ${err.message}`);
    }
  }
  await log({ userId }, 'warn', `KILL SWITCH: ${reason} - ${report.stopped} bots stopped, ${report.closed.length} positions closed${report.failed.length ? `, ${report.failed.length} failures` : ''}`);
  events.emit('killswitch', { userId, ...report });
  notify(userId, { type: 'warn', title: 'Kill switch activated', body: `${report.stopped} bots stopped, ${report.closed.length} positions closed`, important: true });
  return report;
}

export async function resumeTrading(userId) {
  await updateSettings(userId, { tradingEnabled: true, killSwitchAt: null, killSwitchReason: null });
  await log({ userId }, 'info', 'Auto-trading re-enabled. Bots must be started again manually.');
}

export async function resumeRunningBots() {
  const running = await db.bots.find({ status: 'running' });
  running.forEach((b) => startBot(b._id));
  if (running.length) console.log(`[engine] resumed ${running.length} bot(s)`);
  // Equity snapshots every 5 minutes for every user (drawdown tracking + equity curve).
  const snap = async () => {
    for (const u of await db.users.find({})) {
      await snapshotEquity(u, 'paper').catch(() => {});
      // Forex equity curve once there is a forex paper wallet (needs a Kite session for prices).
      if (await db.wallet.findOne({ kind: 'paper-inr', userId: u._id })) await snapshotEquity(u, 'paper', 'zerodha').catch(() => {});
      if (await db.wallet.findOne({ kind: 'paper-nse', userId: u._id })) await snapshotEquity(u, 'paper', 'nse').catch(() => {});
    }
  };
  snap();
  setInterval(snap, 5 * 60 * 1000);
}

export { getUser, getStrategy };
