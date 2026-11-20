// Bot engine (orchestrator): every bot runs Signal Engine 2.0 -> central Risk Engine -> execution.
// Multi-user, multi-exchange. Safety guards: kill switch, platform halt, exchange health, stale data,
// abnormal price, duplicate orders, API-failure auto-pause, model-failure fallback.
import { EventEmitter } from 'events';
import { db } from '../db/index.js';
import { analyze } from '../ai/analyzer.js';
import { ex, fetchCandles, symbolInfo, tradingFor, credsFor, lotOf } from '../exchange/index.js';
import { computeAll, last } from '../ai/indicators.js';
import { regimeSeries } from '../ai/regime.js';
import { STRATEGY_LIBRARY, getStrategy } from '../ai/strategies.js';
import { baseAsset } from '../ai/util.js';
import { entryContext, journalClosedTrade } from '../ai/journal.js';
import { snapshotEquity, valuePortfolio } from '../ai/portfolio.js';
import { paperOrder, settlePaperPerps, getPaperBalances } from './paperBroker.js';
import { trailStop, trailStopShort } from './risk.js';
import { evaluateRisk } from './riskEngine.js';
import { buildGrid, gridActions, GRID_REGIMES, GRID_KILL_REGIMES } from './grid.js';
import { getSettings, updateSettings, health, abnormalPrice, staleData, orderCooldown, markOrder } from './safety.js';
import { notify } from '../notify.js';

export const events = new EventEmitter();
const TICK_MS = 5000; // candle loop: AI analysis once per closed candle, entries
// Position guard: an open trade's take-profit / stop-loss / max loss / max hold are checked against the live ticker
// price this often, on its own loop. It never waits for a candle to close or for the AI analysis, so it works the
// same on 1m, 15m, 1h or any other timeframe.
const GUARD_MS = 2000;
// Exchanges with trading hours (Zerodha / NSE quote API, rate-limited): the guard checks them at most this often.
const GUARD_SLOW_MS = 5000;
const QUOTE_TTL_MS = 1000; // bots on the same symbol share one quote per second
const timers = new Map();
const guardTimers = new Map();
const busy = new Set();
const guarding = new Map(); // botId -> the guard pass in progress (the candle loop waits for it instead of running a second one)
const lastGuardAt = new Map();
const marketCtx = new Map(); // botId -> { atr, lastClose, regime } from the latest candle tick (used by the guard)

// Per-bot lock: every order and every position write of a bot runs one at a time, so the guard and the candle loop
// can never sell the same position twice, open two positions, or bring a closed position back.
const locks = new Map();
function withLock(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

// Alternating BUY/SELL mode: the next trade's direction comes only from the bot's previous trade (first trade BUY),
// never from the AI or the market trend. Returns the signal name the next entry must have: 'LONG' (BUY) or 'SHORT' (SELL).
export const requiredSide = (bot) => (bot.lastSide === 'long' ? 'SHORT' : 'LONG');
const sideWord = (s) => (s === 'SHORT' || s === 'short' ? 'SELL' : 'BUY');
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
  leverage: 2, // perpetuals only (1-5x, isolated)
  forceTrade: false, // true = trade every candle: close the open trade and open a new one at each candle close
  maxHoldMin: 0, // trade duration: 0 = off; otherwise the maximum holding time - the trade is closed (profit or loss) after this many minutes
  stopAfterTrade: false, // true = the bot stops itself once its trade is fully closed (one trade, then stop)
  takeProfitPct: 0, // 0 = the AI's ATR-based target; otherwise sell (or cover) once the trade is this many % in profit
  tradeAmount: 0, // 0 = risk-engine sizing; otherwise a fixed trade size (notional) in the quote currency, e.g. 100 USDT
  takeProfitUsd: 0, // 0 = off; otherwise close once the trade's profit reaches this amount (quote currency)
  stopLossUsd: 0, // 0 = off; otherwise close once the trade's loss reaches this amount - always, even with onlyProfitExit
  alternate: false, // true = strict BUY -> SELL -> BUY ... : the next trade's direction comes from the previous trade (shorting exchanges only)
  onlyProfitExit: false, // true = automatic exits only in profit: no stop-loss, candle-close or AI exit at a loss (max loss amount and trade duration still close)
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

// ---- P&L text for the bot log (paper and live) ----
const signed = (n) => `${n >= 0 ? '+' : ''}${(+n || 0).toFixed(2)}`;
const modeTag = (bot) => (bot?.mode === 'live' ? '[LIVE]' : '[PAPER]');
async function quoteOf(bot) {
  return (await symbolInfo(bot.exchange, bot.symbol).catch(() => null))?.quote || bot.symbol.slice(baseAsset(bot.symbol).length) || 'USDT';
}
// Unrealized P&L of an open position at the given price. Long: value - cost. Short: proceeds - cost to buy back.
function openPnl(pos, price) {
  const pnl = pos.side === 'short' ? pos.cost - price * pos.qty : price * pos.qty - pos.cost;
  return { pnl, pct: pos.cost ? (pnl / pos.cost) * 100 : 0 };
}
// ---- Execution-side P&L (what a close would really book) ----
// Exit fee of a closing order, same model as the paper broker: the adapter's own fee schedule, else its fee rate.
const PAPER_FEE = 0.001;
function exitFee(exchange, notional, side) {
  const a = ex(exchange);
  return typeof a.feeFor === 'function' ? a.feeFor(notional, side) : notional * (a.costs?.feeRate ?? PAPER_FEE);
}
// Fee as a share of notional, estimated at the entry price (stable, so the targets below do not drift every pass).
function exitFeeRate(bot, pos) {
  const notional = pos.entry * pos.qty;
  return notional > 0 ? exitFee(bot.exchange, notional, pos.side === 'short' ? 'BUY' : 'SELL') / notional : 0;
}
// Net P&L if the position were closed now at `px` (the bid for a long, the ask for a short), after the exit fee.
// pos.cost already holds the entry fee (long: paid incl. fee; short: net sale proceeds).
function netPnl(bot, pos, px) {
  const short = pos.side === 'short';
  const notional = px * pos.qty;
  const fee = exitFee(bot.exchange, notional, short ? 'BUY' : 'SELL');
  return short ? pos.cost - notional - fee : notional - fee - pos.cost;
}
// Exit price at which the net P&L equals `amount` (positive = profit target, negative = max loss).
function priceForNetPnl(bot, pos, amount) {
  const f = exitFeeRate(bot, pos);
  return pos.side === 'short' ? (pos.cost - amount) / (pos.qty * (1 + f)) : (pos.cost + amount) / (pos.qty * (1 - f));
}

// "Close only in profit": an automatic exit needs the trade this far in profit, so the exit fee and spread still leave a gain.
const MIN_EXIT_PROFIT_PCT = 0.2;
const inProfit = (pos, price) => openPnl(pos, price).pct > MIN_EXIT_PROFIT_PCT;
// true = the bot must keep holding: "Close only in profit" is on and the trade is not (enough) in profit at this price.
const holdAtLoss = (bot, price) => Boolean(bot.onlyProfitExit && bot.position && !inProfit(bot.position, price));
// "Total P&L +12.34 USDT (3 trades, 2 wins)" from the bot's realized stats.
function totalsText(stats, ccy) {
  const s = stats || { trades: 0, wins: 0, pnl: 0 };
  return `Total realized P&L ${signed(s.pnl)} ${ccy} (${s.trades} trade${s.trades === 1 ? '' : 's'}, ${s.wins} win${s.wins === 1 ? '' : 's'})`;
}

async function warnOnce(bot, key, msg) {
  const k = `${bot._id}:${key}`;
  if (Date.now() - (lastWarn.get(k) || 0) < 600000) return;
  lastWarn.set(k, Date.now());
  await log(bot, 'warn', msg);
}

// Executes a market order (paper or live, any supported exchange) and records the trade.
// short=true: SELL opens a short (sized by quoteAmount), BUY covers it (by quantity). Only adapters with canShort.
// leverage: perpetuals only (opening orders); other adapters ignore it.
export async function executeOrder({ user, bot, mode, exchange = 'binance', symbol, side, quoteAmount, quantity, reason, signal, clientOrderId, extra = {}, short = false, leverage }) {
  const info = (await symbolInfo(exchange, symbol)) || { base: baseAsset(symbol), quote: symbol.slice(baseAsset(symbol).length) };
  let fill;
  if (mode === 'live') {
    const { client } = await tradingFor(user, exchange);
    fill = await client.marketOrder({ symbol, side, quoteAmount, quantity, clientOrderId, short, leverage });
    // Only a confirmed execution counts: an order the exchange accepted but did not fill (expired, no liquidity)
    // must not open or close a position in the bot. The caller keeps the old state and retries.
    if (!(Number(fill?.qty) > 0) || !(Number(fill?.price) > 0)) {
      throw Object.assign(new Error(`${exchange} ${side} ${symbol}: order ${fill?.orderId ?? ''} was not filled (status ${fill?.raw?.status || fill?.status || 'unknown'})`), { code: 'NOT_FILLED' });
    }
  } else {
    fill = await paperOrder({ userId: user._id, exchange, side, symbol, base: info.base, quote: info.quote, quoteAmount, quantity, short, leverage });
  }
  const perpExtra = fill.leverage ? { leverage: fill.leverage, liqPrice: fill.liqPrice } : {};
  const trade = await recordTrade({ user, bot, mode, exchange, symbol, side, fill, reason, signal, extra: { ...extra, ...perpExtra, ...(short && { positionSide: 'short' }) } });
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

const qtyText = async (exchange, symbol, qty) => {
  const lot = await lotOf(exchange, symbol); // futures: the contract's own lot size
  return lot > 1 ? `${+(qty / lot).toFixed(2)} lot(s)` : lot === 1 ? `${qty} share(s)` : qty.toFixed(6);
};

// Opens a trade under the bot's lock, re-checking the bot's latest state first.
async function openPosition(bot, user, signal, sizing, candles, candleTime) {
  return withLock(bot._id, async () => {
    const fresh = await db.bots.findOne({ _id: bot._id });
    if (!fresh || fresh.status !== 'running') return;
    if (fresh.position) return log(bot, 'warn', `${modeTag(bot)} Skipped a new ${signal.signal} on ${bot.symbol}: this bot already holds an open position`);
    // Alternating BUY/SELL: the last gate before the order - any entry in the wrong direction is rejected.
    if (fresh.alternate && signal.signal !== requiredSide(fresh)) {
      return log(bot, 'warn', `${modeTag(bot)} Alternating BUY/SELL: rejected a ${sideWord(signal.signal)} - the previous trade was ${sideWord(fresh.lastSide)}, so the next trade must be ${sideWord(requiredSide(fresh))}`);
    }
    return openPositionNow({ ...fresh, intervalSec: bot.intervalSec }, user, signal, sizing, candles, candleTime);
  });
}

async function openPositionNow(bot, user, signal, sizing, candles, candleTime) {
  const key = `bot:${bot._id}`;
  const settings = await getSettings(user._id);
  const dup = orderCooldown(key, settings.risk.orderCooldownSec);
  if (dup) return log(bot, 'warn', dup);
  markOrder(key);
  const short = signal.signal === 'SHORT';
  const { fill, info } = await executeOrder({
    user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: short ? 'SELL' : 'BUY', quoteAmount: Number(bot.tradeAmount) > 0 ? Number(bot.tradeAmount) : sizing.notional, short, leverage: bot.leverage,
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
    stopLoss: fill.price - dir * slDist, initialStop: fill.price - dir * slDist,
    takeProfit: Number(bot.takeProfitPct) > 0 ? fill.price * (1 + (dir * Number(bot.takeProfitPct)) / 100) : fill.price + dir * tpDist,
    highest: fill.price, lowest: fill.price, openedAt: Date.now(),
    entryContext: entryContext(signal, candles),
    riskPct: sizing.riskPct,
    contract: fill.contract, contractExpiry: fill.contractExpiry || info.expiry, // futures only
    ...(fill.leverage && { leverage: fill.leverage, liqPrice: fill.liqPrice }), // perpetuals
  };
  // Fixed profit / loss amounts -> trigger prices right away (net of the exit fee), so the first log line and the
  // screens show where the trade will close; the guard keeps them current from here on.
  const tpUsd = Number(bot.takeProfitUsd) || 0;
  const slUsd = Number(bot.stopLossUsd) || 0;
  if (tpUsd > 0) position.takeProfit = +priceForNetPnl(bot, position, tpUsd).toPrecision(10);
  if (slUsd > 0) Object.assign(position, { stopLoss: +priceForNetPnl(bot, position, -slUsd).toPrecision(10), slUsd, slUsdNet: slUsd }, { initialStop: +priceForNetPnl(bot, position, -slUsd).toPrecision(10) });
  await db.bots.update(bot._id, { position, lastSide: position.side, ...(bot.alternate && { tradeSeq: (bot.tradeSeq || 0) + 1 }) });
  const qtyLabel = await qtyText(bot.exchange, bot.symbol, fill.qty);
  const marginNote = (fill.sim?.marginBlocked ? ` | margin ${fill.sim.marginBlocked.toFixed(0)}` : '') + (fill.leverage ? ` | ${fill.leverage}x, liquidation ${(+fill.liqPrice).toFixed(4)}` : '');
  await log(bot, 'trade', `${modeTag(bot)} ${short ? 'SELL SHORT' : 'BUY'} ${qtyLabel} ${info.base} @ ${fill.price.toFixed(4)} | risk ${sizing.riskPct}%${marginNote} | SL ${position.stopLoss.toFixed(4)}${slUsd > 0 ? ` (max loss -${slUsd} net)` : ''} TP ${position.takeProfit.toFixed(4)}${tpUsd > 0 ? ` (profit +${tpUsd} net, after fees)` : ''}${bot.alternate ? ` | alternating trade #${(bot.tradeSeq || 0) + 1}, next must be ${sideWord(short ? 'long' : 'short')}` : ''}`);
  notify(user._id, { type: 'trade', title: `${bot.name}: ${short ? 'sold short' : 'bought'} ${info.base}`, body: `${qtyLabel} @ ${fill.price.toFixed(4)} (${bot.mode})`, important: bot.mode === 'live' });
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
  // "Close only in profit": no resting stop on the exchange until the (trailing) stop itself sits in profit.
  if (pos && bot.mode === 'live' && bot.onlyProfitExit && !(Number(bot.stopLossUsd) > 0) && !(pos.stopLoss > 0 && inProfit(pos, pos.stopLoss))) {
    if (pos.stopOrder) {
      const { client } = await tradingFor(user, bot.exchange);
      await client.cancelOrder(bot.symbol, pos.stopOrder.orderId);
      if ((await client.getOrder(bot.symbol, pos.stopOrder.orderId)).executedQty > 0) return closePositionNow(bot, user, price, 'Exchange stop-loss filled');
      await db.bots.update(bot._id, { position: { ...pos, stopOrder: null } });
      await log(bot, 'info', 'Exchange stop-loss removed: "Close only in profit" is on');
    }
    return;
  }
  if (!pos || bot.mode !== 'live' || bot.grid || !(pos.stopLoss > 0) || (short ? pos.stopLoss <= price : pos.stopLoss >= price) || pos.exchangeStop === 'unsupported') return;
  const { client } = await tradingFor(user, bot.exchange);
  if (!client.stopLossOrder) {
    await db.bots.update(bot._id, { position: { ...pos, exchangeStop: 'unsupported' } });
    return log(bot, 'warn', `${bot.exchange} exchange-side stops are not supported yet - this position's stop-loss is enforced by the bot only, so keep the server running`);
  }
  const so = pos.stopOrder;
  if (so) {
    const st = await client.getOrder(bot.symbol, so.orderId);
    if (st.status === 'FILLED') return closePositionNow(bot, user, price, 'Exchange stop-loss filled');
    const gone = ['CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(st.status) && st.executedQty === 0;
    const improved = short ? so.stopPrice - pos.stopLoss : pos.stopLoss - so.stopPrice; // trailing tightened
    const move = st.status === 'NEW' && improved >= price * STOP_MOVE_MIN && Date.now() - so.at >= STOP_MOVE_EVERY_MS;
    if (!gone && !move) return;
    if (move) {
      await client.cancelOrder(bot.symbol, so.orderId);
      // It may have filled between the status check and the cancel.
      if ((await client.getOrder(bot.symbol, so.orderId)).executedQty > 0) return closePositionNow(bot, user, price, 'Exchange stop-loss filled');
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
    if (st.executedQty > 0) return closePositionNow(bot, user, price, 'Exchange stop-loss filled while the bot was offline');
  }
  const { total } = pos.side === 'short' ? { total: client.shortUnits ? await client.shortUnits(bot.symbol) : 0 } : await heldOnExchange(client, bot);
  if (total >= pos.qty * 0.99) return;
  if (total < pos.qty * 0.5) return closePositionNow(bot, user, price, 'Position no longer on the exchange');
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

// What the exchange still holds of this position after a close attempt (base units long, short units short).
async function liveStillHeld(bot, user, pos) {
  const { client } = await tradingFor(user, bot.exchange);
  if (pos.side === 'short') return client.shortUnits ? client.shortUnits(bot.symbol) : 0;
  return (await heldOnExchange(client, bot)).total;
}

// Closes a trade under the bot's lock. Does nothing when the position was already closed (or replaced) by another path.
async function closePosition(bot, user, price, reason, signal, exitCtx = {}) {
  return withLock(bot._id, async () => {
    const fresh = await db.bots.findOne({ _id: bot._id });
    if (!fresh?.position || (bot.position?.openedAt && fresh.position.openedAt !== bot.position.openedAt)) return;
    return closePositionNow({ ...fresh, intervalSec: bot.intervalSec }, user, price, reason, signal, exitCtx);
  });
}

// Callers must hold the bot's lock (closePosition, the position guard, exchange-stop sync, reconciliation).
async function closePositionNow(bot, user, price, reason, signal, exitCtx = {}) {
  const pos = bot.position;
  const short = pos.side === 'short';
  // Per position: paces retries after a failed close, without delaying the close of the NEXT trade (fast re-entry,
  // alternating BUY/SELL). Duplicate closes of one position are prevented by the bot lock + fresh-state check.
  const key = `bot:${bot._id}:close:${pos.openedAt || 0}:${pos.qty}`;
  if (orderCooldown(key, 10)) return;
  markOrder(key);
  const fills = (bot.mode === 'live'
    ? await (short ? liveCover : liveSell)(bot, user, pos, reason, signal)
    : [await executeOrder({ user, bot, mode: bot.mode, exchange: bot.exchange, symbol: bot.symbol, side: short ? 'BUY' : 'SELL', quantity: pos.qty, short, reason, signal, clientOrderId: `nx${bot._id.slice(0, 8)}${Date.now()}${short ? 'C' : 'S'}` })]
  ).filter((f) => f.fill?.qty > 0);
  if (!fills.length) {
    await db.bots.update(bot._id, { position: null, lastSide: pos.side || 'long' });
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
  // Partial fill: the unfilled part stays an open position, so take-profit / stop-loss keep guarding it and the next
  // pass closes the rest. Live: only what the exchange really still holds (fee dust and coins sold elsewhere are not
  // a position); if the exchange cannot be asked, keep it - the next close attempt or reconciliation settles it.
  let leftover = null;
  if (remaining > pos.qty * 0.001) {
    // pendingExit: the exit already fired, so the guard closes the remainder on its next pass even though the
    // smaller remainder alone no longer reaches the profit / loss amount.
    if (bot.mode !== 'live') leftover = { ...pos, qty: remaining, cost: pos.cost * (1 - soldShare), pendingExit: reason };
    else {
      const held = await liveStillHeld(bot, user, pos).catch(() => remaining);
      const keep = Math.min(remaining, held);
      const info = await symbolInfo(bot.exchange, bot.symbol).catch(() => null);
      if (keep > (info?.minQty || 0) && keep * exitPrice >= (info?.minNotional || 0) && keep > pos.qty * 0.001) {
        leftover = { ...pos, qty: keep, cost: pos.cost * (keep / pos.qty), stopOrder: null, pendingExit: reason };
      }
    }
  }
  await db.bots.update(bot._id, { position: leftover, stats, grid: leftover ? bot.grid : bot.grid ? null : undefined, ...(!leftover && { lastSide: pos.side || 'long' }) });
  const ccyLog = await quoteOf(bot);
  await log(bot, pnl >= 0 ? 'profit' : 'loss', `${modeTag(bot)} ${short ? 'BUY TO COVER' : 'SELL'} @ ${exitPrice.toFixed(4)} (${reason}) | ${pnl >= 0 ? 'PROFIT' : 'LOSS'} ${signed(pnl)} ${ccyLog} (${signed(pnlPct)}%)${leftover ? ' - partial, remainder still open' : ''} | ${totalsText(stats, ccyLog)}`, { pnl, pnlPct, mode: bot.mode, totalPnl: stats.pnl, trades: stats.trades, wins: stats.wins });
  if (bot.mode === 'live' && leftover) await log(bot, 'warn', `Partial fill: ${leftover.qty.toFixed(8)} ${bot.symbol} is still open on the exchange - take-profit / stop-loss keep guarding it and the bot closes the rest next`);
  else if (bot.mode === 'live' && remaining > pos.qty * 0.01) await log(bot, 'warn', `The exchange held ${remaining.toFixed(8)} less than the bot expected - only what was there was sold`);
  const ccy = (await symbolInfo(bot.exchange, bot.symbol).catch(() => null))?.quote || 'USDT';
  notify(user._id, { type: pnl >= 0 ? 'profit' : 'loss', title: `${bot.name}: ${pnl >= 0 ? 'profit' : 'loss'} ${pnl.toFixed(2)} ${ccy}`, body: `${reason} · ${pnlPct.toFixed(2)}%`, important: bot.mode === 'live' });
  if (bot.copyable) events.emit('copy:close', { bot, reason });
  const j = await journalClosedTrade({ bot, position: pos, exit: { price: exitPrice, pnl, reason, ...exitCtx } }).catch(() => null);
  if (j) events.emit('journal', j);
  // "Stop after one trade": once the position is fully closed, the bot stops instead of looking for the next trade.
  if (bot.stopAfterTrade && !leftover) {
    stopTimer(bot._id);
    await db.bots.update(bot._id, { status: 'stopped' });
    await log(bot, 'info', `Bot stopped: trade closed (${reason}) and "Stop after one trade" is on`);
    notify(user._id, { type: 'info', title: `${bot.name} stopped`, body: 'One trade done - start the bot again for the next trade', important: bot.mode === 'live' });
    events.emit('bot', { botId: bot._id, userId: bot.userId, status: 'stopped' });
  }
}

// Paper perpetuals: the broker liquidated this bot's position (mark crossed the liquidation price). Attribute the
// liquidation trade to the bot, book the loss and clear the position. Returns true when that happened.
async function perpLiquidated(bot, user) {
  const pos = bot.position;
  const held = (await getPaperBalances(user._id, bot.exchange))[bot.symbol] || 0;
  if (pos.side === 'short' ? held < 0 : held > 0) return false;
  const liq = (await db.trades.find({ userId: user._id, mode: 'paper', exchange: bot.exchange, symbol: bot.symbol }, { sort: { time: -1 }, limit: 5 }))
    .find((t) => t.liquidation && t.time >= (pos.openedAt || 0));
  const pnl = liq?.pnl ?? -(pos.cost / (pos.leverage || 1));
  if (liq) events.emit('trade', await db.trades.update(liq._id, { botId: bot._id, botName: bot.name }));
  const stats = bot.stats || { trades: 0, wins: 0, pnl: 0 };
  stats.trades++;
  stats.pnl += pnl;
  await db.bots.update(bot._id, { position: null, stats, lastSide: pos.side || 'long' });
  await log(bot, 'loss', `${modeTag(bot)} LIQUIDATED: ${bot.symbol} ${pos.side || 'long'} at ${(liq?.price ?? pos.liqPrice ?? 0).toFixed(4)} (${pos.leverage || '?'}x) - isolated margin lost, LOSS ${signed(pnl)} | ${totalsText(stats, await quoteOf(bot))}`, { pnl, mode: bot.mode, totalPnl: stats.pnl, trades: stats.trades, wins: stats.wins });
  notify(user._id, { type: 'loss', title: `${bot.name}: position liquidated`, body: `${bot.symbol} ${pos.side || 'long'} at ${pos.leverage || '?'}x - PnL ${pnl.toFixed(2)} USDT`, important: true });
  return true;
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
  await log(bot, 'trade', `${modeTag(bot)} DCA tranche ${tranches + 1}: bought ${fill.qty.toFixed(6)} @ ${fill.price.toFixed(4)} | avg cost ${avg.toFixed(4)}`);
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
    await log(bot, pnl >= 0 ? 'profit' : 'loss', `${modeTag(bot)} Grid sell @ ${fill.price.toFixed(4)} | ${pnl >= 0 ? 'PROFIT' : 'LOSS'} ${signed(pnl)} ${await quoteOf(bot)} | ${totalsText(bot.stats, await quoteOf(bot))}`, { pnl, mode: bot.mode, totalPnl: bot.stats.pnl, trades: bot.stats.trades, wins: bot.stats.wins });
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

// ---- Position guard: take-profit / stop-loss / max hold, independent of the timeframe and the AI ----
// Live quote for exit decisions: the bid (what a long sells at) and ask (what a short buys back at), from the top of
// the book where the adapter has one, else the last price. Shared by bots on the same symbol for QUOTE_TTL_MS.
const quoteCache = new Map();
function exitQuote(exchange, symbol) {
  const k = `${exchange}:${symbol}`;
  const hit = quoteCache.get(k);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.p;
  const p = (async () => {
    const a = ex(exchange);
    if (typeof a.getOrderBook === 'function') {
      try {
        const b = await a.getOrderBook(symbol, 5);
        const bid = +b?.bids?.[0]?.[0];
        const ask = +b?.asks?.[0]?.[0];
        if (bid > 0 && ask > 0 && ask >= bid) return { bid, ask, last: (bid + ask) / 2 };
      } catch { /* fall back to the last price */ }
    }
    const last = +(await a.getPrice(symbol));
    if (!(last > 0)) throw new Error(`No live price for ${symbol}`);
    return { bid: last, ask: last, last };
  })();
  quoteCache.set(k, { at: Date.now(), p });
  p.catch(() => quoteCache.get(k)?.p === p && quoteCache.delete(k));
  return p;
}

// Keeps an open position's bookkeeping current at `last`: highest / lowest, fixed profit / loss targets -> prices
// (net of the exit fee) and the trailing stop. Returns the patch, or null when nothing changed.
function positionPatch(bot, last, atr) {
  const p = bot.position;
  const patch = { highest: Math.max(p.highest ?? p.entry, last), lowest: Math.min(p.lowest ?? p.entry, last) };
  if (!p.gridLots && p.qty > 0) {
    // Fixed take-profit %: also applies to a trade that was already open when the setting was changed.
    const tpPct = Number(bot.takeProfitPct) || 0;
    if (tpPct > 0) {
      const tp = +(p.entry * (1 + ((p.side === 'short' ? -1 : 1) * tpPct) / 100)).toPrecision(10);
      if (tp !== p.takeProfit) patch.takeProfit = tp;
    }
    // Fixed profit / loss amounts (quote currency, net of the exit fee) -> prices.
    const tpUsd = Number(bot.takeProfitUsd) || 0;
    const slUsd = Number(bot.stopLossUsd) || 0;
    if (tpUsd > 0) {
      const tp = +priceForNetPnl(bot, p, tpUsd).toPrecision(10);
      if (tp !== p.takeProfit) patch.takeProfit = tp;
    }
    // The fixed stop is set once per value; after that the trailing stop may only tighten it.
    if (slUsd > 0 && p.slUsdNet !== slUsd) {
      const sl = +priceForNetPnl(bot, p, -slUsd).toPrecision(10);
      // A position opened before net (fee-aware) stops existed: convert its stop, but never loosen a trailed stop.
      const migrate = p.slUsd === slUsd && p.stopLoss > 0;
      patch.stopLoss = migrate ? (p.side === 'short' ? Math.min(p.stopLoss, sl) : Math.max(p.stopLoss, sl)) : sl;
      if (!migrate) patch.initialStop = patch.stopLoss;
      patch.slUsd = slUsd;
      patch.slUsdNet = slUsd;
    }
  }
  // A strategy that defines its own trailing width (rule strategies) uses it; others use the bot's setting.
  if (bot.trailingStop && atr > 0) {
    const trailFn = p.side === 'short' ? trailStopShort : trailStop;
    Object.assign(patch, trailFn({ ...p, ...patch }, last, getStrategy(bot.strategy)?.trail ?? bot.trailAtr, atr));
  }
  const changed = Object.keys(patch).some((k) => patch[k] !== p[k]);
  return changed ? patch : null;
}

// Which exit is due at the execution-side price `px`, in priority order: 1. take-profit, 2. stop-loss,
// 3. trade duration (max hold time). Returns the close reason, or null to keep holding.
function exitDue(bot, px) {
  const pos = bot.position;
  const short = pos.side === 'short';
  // The rest of a partly filled close: finish the exit that already fired.
  if (pos.pendingExit) return pos.pendingExit;
  if (bot.strategy === 'dca') {
    const tpPct = bot.dcaTakeProfitPct ?? STRATEGY_LIBRARY.dca.takeProfitPct;
    return px >= pos.entry * (1 + tpPct / 100) ? `DCA take-profit +${tpPct}%` : null;
  }
  const tpUsd = Number(bot.takeProfitUsd) || 0;
  const slUsd = Number(bot.stopLossUsd) || 0;
  const net = netPnl(bot, pos, px);
  // 1. Take profit: the fixed amount (net, after the exit fee), else the price target (% or the AI's ATR target).
  if (tpUsd > 0 && net >= tpUsd) return `Profit target +${tpUsd} reached (net ${signed(net)})`;
  if (pos.takeProfit > 0 && (short ? px <= pos.takeProfit : px >= pos.takeProfit)) return 'Take-profit hit';
  // 2. Stop loss: the fixed max loss always applies (even with "Close only in profit"); the price / trailing stop
  // respects "Close only in profit".
  if (slUsd > 0 && net <= -slUsd) return `Max loss ${slUsd} reached (net ${signed(net)})`;
  if (pos.stopLoss > 0 && !holdAtLoss(bot, px) && (short ? px >= pos.stopLoss : px <= pos.stopLoss)) return bot.onlyProfitExit ? 'Trailing stop (profit locked)' : 'Stop-loss hit';
  // Futures: exit a day before the contract expires; the next entry uses the new front month.
  if (pos.contractExpiry && Date.now() > pos.contractExpiry - 86400e3) return 'Futures contract expiry (rolled out)';
  // 3. Trade duration = the maximum holding time: if take-profit / stop-loss did not end the trade first, it is
  // closed when the duration expires - in profit or at a loss, also with "Close only in profit" (a trade never
  // stays open indefinitely).
  const holdMin = Number(bot.maxHoldMin) || 0;
  if (holdMin > 0 && pos.openedAt && Date.now() - pos.openedAt >= holdMin * 60000) {
    return `Trade duration ${durationText(holdMin)} expired${net < 0 ? ` (closed at a loss, net ${signed(net)})` : ''}`;
  }
  return null;
}

// 15 -> "15 min", 60 -> "1 h", 1440 -> "1 day", 90 -> "1 h 30 min".
function durationText(min) {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min >= 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${min} min`;
}

const samePosition = (a, b) => Boolean(a && b && a.openedAt === b.openedAt && a.side === b.side);

// One guard pass for a bot: live quote -> update the position -> close it the moment an exit is due.
// Resolves true when it closed (part of) the position. Never throws: failures are logged and retried next pass.
function guardPass(botId, opts) {
  if (guarding.has(botId)) return guarding.get(botId);
  const run = guardPosition(botId, opts)
    .catch(async (err) => {
      const k = `${botId}:guard-error`;
      if (Date.now() - (lastWarn.get(k) || 0) < 30000) return false;
      lastWarn.set(k, Date.now());
      const bot = await db.bots.findOne({ _id: botId }).catch(() => null);
      if (!bot) return false;
      await log(bot, 'error', `Position guard: ${err.message} - the position stays open and take-profit / stop-loss are retried every ${GUARD_MS / 1000}s`);
      if (bot.mode === 'live' && bot.position && Date.now() - (lastWarn.get(`${k}:notify`) || 0) > 600000) {
        lastWarn.set(`${k}:notify`, Date.now());
        notify(bot.userId, { type: 'warn', title: `${bot.name}: could not close the position`, body: err.message, important: true });
      }
      return false;
    })
    .finally(() => guarding.get(botId) === run && guarding.delete(botId));
  guarding.set(botId, run);
  return run;
}

async function guardPosition(botId, { throttle = false } = {}) {
  const bot = await db.bots.findOne({ _id: botId });
  if (!bot || bot.status !== 'running' || !bot.position || bot.grid || bot.strategy === 'grid') return false;
  // Live: the candle loop first checks the position against the exchange after a (re)start (reconcileLive).
  if (bot.mode === 'live' && !reconciled.has(botId)) return false;
  bot.exchange ||= 'binance';
  const adapter = ex(bot.exchange);
  if (adapter.marketOpen && !adapter.marketOpen()) return false;
  if (throttle && adapter.marketOpen && Date.now() - (lastGuardAt.get(botId) || 0) < GUARD_SLOW_MS) return false;
  lastGuardAt.set(botId, Date.now());
  const user = await getUser(bot.userId);
  if (!user || user.status === 'suspended') return false;
  const q = await exitQuote(bot.exchange, bot.symbol);
  const ctx = marketCtx.get(botId);
  // A bad tick must not trigger a stop: same abnormal-price protection as the candle loop.
  if (ctx?.lastClose && ctx.atr) {
    const settings = await getSettings(user._id);
    const abnormal = abnormalPrice(q.last, ctx.lastClose, ctx.atr, settings.risk.abnormalMovePct);
    if (abnormal) { await warnOnce(bot, 'guard-abnormal', `Abnormal price protection: ${abnormal} - exits paused for this quote`); return false; }
  }

  // Bookkeeping + exit decision under the bot's lock, on its latest state: a position the candle loop just closed
  // or replaced is never touched, and two closing orders can never be sent for the same position.
  return withLock(botId, async () => {
    let fresh = await db.bots.findOne({ _id: botId });
    if (!fresh || fresh.status !== 'running' || !samePosition(fresh.position, bot.position)) return false;
    fresh.exchange ||= 'binance';
    if (fresh.strategy !== 'dca') {
      const patch = positionPatch(fresh, q.last, ctx?.atr);
      if (patch) fresh = await db.bots.update(botId, { position: { ...fresh.position, ...patch } });
    }
    const px = fresh.position.side === 'short' ? q.ask : q.bid;
    // The same net P&L the take-profit / stop-loss decision below uses, so the screens show exactly what triggers.
    const livePnl = fresh.strategy === 'dca' ? null : netPnl(fresh, fresh.position, px);
    const live = livePnl === null ? null : { exitPrice: px, netPnl: livePnl, netPct: fresh.position.cost ? (livePnl / fresh.position.cost) * 100 : 0, at: Date.now() };
    events.emit('position', { botId, userId: fresh.userId, price: q.last, position: fresh.position, live });
    const reason = exitDue(fresh, px);
    if (!reason) return false;
    const exitCtx = { atr: ctx?.atr, regime: ctx?.regime };
    await closePositionNow({ ...fresh, intervalSec: INTERVAL_SEC[fresh.interval] || 3600 }, user, px, reason, null, exitCtx);
    const after = await db.bots.findOne({ _id: botId });
    return !samePosition(after?.position, fresh.position) || after.position.qty < fresh.position.qty;
  });
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

    if (!health.exchangeUp && ['binance', 'bperp'].includes(bot.exchange)) return warnOnce(bot, 'exchange', 'Exchange unreachable - trading paused until it recovers');
    // Exchanges with trading hours (NSE forex): nothing can be traded while closed; positions are held overnight.
    const adapter = ex(bot.exchange);
    if (adapter.marketOpen && !adapter.marketOpen()) return;

    const candlesAll = await fetchCandles(bot.exchange, bot.symbol, bot.interval, 500);
    const closed = candlesAll.slice(0, -1);
    const price = last(candlesAll).close;
    const lastClosed = last(closed);
    const ind = computeAll(closed);
    const atr = last(ind.atr) || price * 0.01;
    // Market context for the position guard: trailing-stop width, abnormal-price reference, exit regime for the journal.
    marketCtx.set(botId, { atr, lastClose: lastClosed.close, regime: bot.position && bot.strategy !== 'grid' ? last(regimeSeries(closed, ind))?.regime : marketCtx.get(botId)?.regime });

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

    // 1. Protect the open position (runs even when auto-trading is disabled).
    // Live: on the first tick after a (re)start, check the position against the real exchange balance.
    // Perpetuals, paper: settle funding and liquidations; a liquidated position is gone from the wallet.
    if (adapter.perp && bot.mode === 'paper') {
      await settlePaperPerps(user._id, bot.exchange);
      if (bot.position && (await withLock(botId, async () => {
        const fresh = await db.bots.findOne({ _id: botId });
        return fresh?.position ? perpLiquidated(fresh, user) : false;
      }))) return;
    }
    // Perpetuals, live: Binance can liquidate at any time, so the position is checked against the exchange every tick.
    if (bot.position && bot.mode === 'live' && !bot.grid && (!reconciled.has(botId) || adapter.perp)) {
      reconciled.add(botId);
      await withLock(botId, async () => {
        const fresh = await db.bots.findOne({ _id: botId });
        if (fresh?.position) await reconcileLive({ ...fresh, exchange: bot.exchange }, user, price);
      });
      bot = await db.bots.findOne({ _id: botId });
      if (!bot?.position) return;
    }
    // Take-profit, stop-loss and max hold time are enforced by the position guard (its own 2 s loop on the live
    // quote, see guardPosition). The candle loop runs one pass too - or waits for the one in progress - so the
    // AI below always sees the position as it is now.
    if (bot.position) {
      const closedNow = await guardPass(botId);
      bot = await db.bots.findOne({ _id: botId });
      if (!bot || bot.status !== 'running') return;
      bot.intervalSec = INTERVAL_SEC[bot.interval] || 3600;
      bot.exchange ||= 'binance';
      if (closedNow && !bot.position) return;
      if (bot.position && bot.mode === 'live' && bot.strategy !== 'dca') {
        await withLock(botId, async () => {
          const fresh = await db.bots.findOne({ _id: botId });
          if (fresh?.position && fresh.status === 'running') await syncExchangeStop({ ...fresh, exchange: bot.exchange }, user, price);
        });
        bot = await db.bots.findOne({ _id: botId });
        if (!bot?.position) return;
        bot.intervalSec = INTERVAL_SEC[bot.interval] || 3600;
        bot.exchange ||= 'binance';
      }
    }

    // 2. AI analysis once per closed candle.
    // Alternating BUY/SELL: the direction of the next trade comes only from the previous trade (BUY, SELL, BUY ...);
    // the analysis still decides WHEN to enter (an entry needs an approved signal in exactly that direction).
    const alt = Boolean(bot.alternate) && adapter.canShort && bot.strategy !== 'dca' && bot.strategy !== 'grid';
    const needSide = alt ? requiredSide(bot) : null;
    if (bot.lastCandleTime === lastClosed.time) return;
    let signal;
    try {
      signal = await analyze(bot.symbol, bot.interval, {
        candles: closed, price, exchange: bot.exchange, strategy: bot.strategy === 'dca' ? 'adaptive' : bot.strategy,
        useClaude: bot.useClaude, threshold: bot.threshold, allowShort: (Boolean(bot.allowShort) || alt) && bot.strategy !== 'dca' && bot.strategy !== 'grid',
        position: bot.position ? { side: bot.position.side || 'long', entry: bot.position.entry, stopLoss: bot.position.stopLoss, takeProfit: bot.position.takeProfit, unrealizedPct: +((((price - bot.position.entry) / bot.position.entry) * 100) * (bot.position.side === 'short' ? -1 : 1)).toFixed(2) } : null,
      });
      if (!Number.isFinite(signal.score) || !Number.isFinite(signal.probability)) throw new Error('Model produced an invalid output');
    } catch (err) {
      await db.bots.update(bot._id, { lastCandleTime: lastClosed.time });
      return log(bot, 'error', `Analysis failed - no trade this candle (${err.message})`);
    }

    let risk = null;
    const wrongSide = alt && (signal.signal === 'LONG' || signal.signal === 'SHORT') && signal.signal !== needSide;
    if ((signal.signal === 'LONG' || signal.signal === 'SHORT') && !bot.position && bot.strategy !== 'dca' && !wrongSide) risk = await evaluateRisk(signal, { user, bot, mode: bot.mode, exchange: bot.exchange });
    const saved = await db.signals.insert({
      userId: bot.userId, botId, exchange: bot.exchange, symbol: bot.symbol, interval: bot.interval, time: signal.time, price, signal: signal.signal, score: signal.score,
      probability: signal.probability, expectedReturnPct: signal.expectedReturnPct, rr: signal.rr, quality: signal.quality,
      regime: signal.regime?.name, strategy: signal.strategyUsed, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
      decision: risk?.decision || null, rejectedBy: risk?.rejectedBy || [], outcome: null, components: signal.components,
    });
    await db.bots.update(bot._id, {
      lastCandleTime: lastClosed.time,
      lastSignal: { signal: signal.signal, action: signal.action, score: signal.score, probability: signal.probability, quality: signal.quality, regime: signal.regime?.label, strategy: signal.strategyName, decision: risk?.decision, rejectedBy: risk?.rejectedBy || [], time: signal.time, claude: signal.claude?.decision?.reasoning },
    });
    events.emit('signal', saved);
    errorCount.set(botId, 0);
    await log(bot, 'info', `${signal.signal} | ${signal.regime?.label} -> ${signal.strategyName} | score ${signal.score} | p=${(signal.probability * 100).toFixed(0)}% | E[r] ${signal.expectedReturnPct}% | R:R ${signal.rr} | ${signal.quality}${risk ? ` | ${risk.decision}${risk.rejectedBy.length ? ` (${risk.rejectedBy.join(', ')})` : ''}` : ''}`);

    // While a trade is open, write its running profit / loss to the log once per candle.
    if (bot.position?.qty > 0) {
      // Net of the exit fee: the same number take-profit / stop-loss trigger on.
      const pnl = bot.strategy === 'dca' ? openPnl(bot.position, price).pnl : netPnl(bot, bot.position, price);
      const pct = bot.position.cost ? (pnl / bot.position.cost) * 100 : 0;
      const ccy = await quoteOf(bot);
      await log(bot, 'pnl', `${modeTag(bot)} OPEN ${(bot.position.side || 'long').toUpperCase()} ${bot.symbol}: entry ${bot.position.entry.toFixed(4)} -> now ${price.toFixed(4)} | if closed now (after fees) ${pnl >= 0 ? 'PROFIT' : 'LOSS'} ${signed(pnl)} ${ccy} (${signed(pct)}%) | ${totalsText(bot.stats, ccy)}`, { unrealized: pnl, pct, mode: bot.mode, totalPnl: bot.stats?.pnl || 0 });
    }
    if (bot.strategy === 'dca') return await dcaTick(bot, user, signal, price, lastClosed.time);
    // "Trade every candle" mode: at each candle close, sell (or cover) the open trade, then open a new one in the
    // direction the AI leans (score >= 0 long, < 0 short when shorts are allowed). Signal-quality gates are skipped;
    // the safety gates (kill switch, daily loss limit, open positions, exposure, leverage, liquidation) still apply.
    if (bot.forceTrade && bot.strategy !== 'grid') {
      if (bot.position) {
        if (holdAtLoss(bot, price)) return log(bot, 'info', `${modeTag(bot)} Candle closed but the trade is not in profit - holding ("Close only in profit" is on)`);
        await closePosition(bot, user, price, 'Trade-every-candle: candle closed', signal, { atr, regime: signal.regime?.name });
        bot = await db.bots.findOne({ _id: botId });
        if (bot.position || bot.status !== 'running') return;
      }
      const dir = alt ? needSide : signal.score < 0 && bot.allowShort && adapter.canShort ? 'SHORT' : 'LONG';
      const d = dir === 'SHORT' ? -1 : 1;
      const slDist = Math.abs(price - signal.stopLoss) || 1.5 * atr;
      const tpDist = Math.abs(signal.takeProfit - price) || 2 * atr;
      const forced = { ...signal, signal: dir, price, stopLoss: price - d * slDist, takeProfit: price + d * tpDist };
      const r = await evaluateRisk(forced, { user, bot, mode: bot.mode, exchange: bot.exchange });
      const HARD = ['Kill switch', 'Daily loss limit', 'Open positions', 'Exposure', 'Leverage', 'Liquidation buffer'];
      const blocked = r.gates.filter((g) => !g.pass && HARD.includes(g.name)).map((g) => g.name);
      if (blocked.length) return log(bot, 'warn', `${modeTag(bot)} Trade-every-candle: no new trade - blocked by safety (${blocked.join(', ')})`);
      const notional = r.approved ? r.position.notional : +((r.account.equity * (bot.maxPositionPct || 25)) / 100).toFixed(2);
      return await openPosition(bot, user, forced, { notional, riskPct: r.finalRiskPct, equity: r.account.equity }, closed, lastClosed.time);
    }
    if (alt && !bot.position && !risk?.approved) {
      await log(bot, 'info', `${modeTag(bot)} Alternating BUY/SELL: next trade must be ${sideWord(needSide)} (previous ${bot.lastSide ? sideWord(bot.lastSide) : 'none - first trade'}) - ${wrongSide ? `the analysis says ${sideWord(signal.signal)}, so no trade; waiting for a ${sideWord(needSide)} setup` : `waiting for an approved ${sideWord(needSide)} setup`}`);
    }
    if (risk?.approved) {
      await openPosition(bot, user, signal, { notional: risk.position.notional, riskPct: risk.finalRiskPct, equity: risk.account.equity }, closed, lastClosed.time);
    } else if (signal.signal === 'EXIT' && bot.position && !holdAtLoss(bot, price)) {
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
  clearInterval(guardTimers.get(botId));
  guardTimers.delete(botId);
  lastGuardAt.delete(botId);
}

export function startBot(botId) {
  stopTimer(botId);
  errorCount.set(botId, 0);
  lastPrice.delete(botId);
  reconciled.delete(botId);
  marketCtx.delete(botId);
  timers.set(botId, setInterval(() => tick(botId), TICK_MS));
  // Position guard: take-profit / stop-loss / max hold on the live quote every GUARD_MS, on any timeframe.
  guardTimers.set(botId, setInterval(() => guardPass(botId, { throttle: true }), GUARD_MS));
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
  while ((busy.size || guarding.size) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return busy.size === 0 && guarding.size === 0;
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
      if (await db.wallet.findOne({ kind: 'paper-nfut', userId: u._id })) await snapshotEquity(u, 'paper', 'nfut').catch(() => {});
      // Perps: valuing the account also settles funding and liquidates positions whose mark crossed liquidation.
      if (await db.wallet.findOne({ kind: 'paper-perp', userId: u._id })) await snapshotEquity(u, 'paper', 'bperp').catch(() => {});
    }
  };
  snap();
  setInterval(snap, 5 * 60 * 1000);
}

export { getUser, getStrategy };
