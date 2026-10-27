// Paper Trading 2.0: fills simulated against the LIVE order book of the chosen exchange.
// Models: latency, bid/ask spread, walking the book (market impact), partial fills on thin books,
// random exchange rejections, taker fees. One crypto (USDT) and one forex (INR) paper wallet per user.
import { db } from '../db/index.js';
import { config } from '../config.js';
import { ex, accountOf } from '../exchange/index.js';

const FEE = 0.001; // 0.1% crypto taker fee; forex adapters bring their own costs
const REJECT_RATE = Number(process.env.PAPER_REJECT_RATE ?? 0.002);
const LATENCY_MS = [80, 350];
const BOOK_DEPTH = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WALLETS = {
  crypto: { kind: 'paper', quote: 'USDT', start: () => config.paperStartBalance },
  fx: { kind: 'paper-inr', quote: 'INR', start: () => config.paperFxStartBalance },
  stocks: { kind: 'paper-nse', quote: 'INR', start: () => config.paperStocksStartBalance },
  options: { kind: 'paper-nfo', quote: 'INR', start: () => config.paperOptionsStartBalance },
};
export const walletFor = (exchange) => WALLETS[accountOf(exchange)];

async function wallet(userId, exchange = 'binance') {
  const W = walletFor(exchange);
  let w = await db.wallet.findOne({ kind: W.kind, userId });
  if (!w) w = await db.wallet.insert({ kind: W.kind, userId, balances: { [W.quote]: W.start() } });
  return w;
}

export async function getPaperBalances(userId, exchange = 'binance') {
  return (await wallet(userId, exchange)).balances;
}

export async function resetPaperWallet(userId, amount, exchange = 'binance') {
  const W = walletFor(exchange);
  const w = await wallet(userId, exchange);
  return db.wallet.update(w._id, { balances: { [W.quote]: amount ?? W.start() } });
}

// Walks one side of the book. For BUY `amount` is quote to spend; for SELL it is base quantity.
function walkBook(levels, side, amount) {
  let filledQty = 0;
  let cost = 0;
  let remaining = amount;
  let levelsUsed = 0;
  for (const [p, q] of levels) {
    if (remaining <= 1e-12) break;
    levelsUsed++;
    if (side === 'BUY') {
      const spend = Math.min(remaining, p * q);
      filledQty += spend / p;
      cost += spend;
      remaining -= spend;
    } else {
      const take = Math.min(remaining, q);
      filledQty += take;
      cost += take * p;
      remaining -= take;
    }
  }
  return { filledQty, cost, remaining, levelsUsed };
}

export async function paperOrder({ userId, exchange = 'binance', side, symbol, base, quote, quoteAmount, quantity, short = false }) {
  const latency = Math.round(LATENCY_MS[0] + Math.random() * (LATENCY_MS[1] - LATENCY_MS[0]));
  await sleep(latency);
  if (Math.random() < REJECT_RATE) throw new Error('Simulated exchange rejection (paper trading realism) - retry later');

  const adapter = ex(exchange);
  let book;
  try {
    book = await adapter.getOrderBook(symbol, BOOK_DEPTH);
  } catch {
    const p = await adapter.getPrice(symbol);
    const half = adapter.paperSpread ?? 0.001;
    book = { bids: [[p * (1 - half), 1e12]], asks: [[p * (1 + half), 1e12]] };
  }
  const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
  const w = await wallet(userId, exchange);
  const b = { ...w.balances };
  if (short && !adapter.canShort) throw new Error(`${adapter.name} cannot be sold short`);
  if (adapter.lotUnits) return lotOrder({ adapter, w, b, book, mid, side, base, quote, quoteAmount, quantity, exchange, latency, short });

  if (side === 'BUY') {
    const spend = Math.min(quoteAmount, b[quote] || 0);
    if (spend < 5) throw new Error(`Insufficient ${quote} balance`);
    const net = spend / (1 + FEE);
    const walk = walkBook(book.asks, 'BUY', net);
    if (walk.filledQty <= 0) throw new Error('Order rejected: no liquidity');
    const fee = walk.cost * FEE;
    b[quote] = (b[quote] || 0) - walk.cost - fee;
    b[base] = (b[base] || 0) + walk.filledQty;
    await db.wallet.update(w._id, { balances: b });
    const price = walk.cost / walk.filledQty;
    return {
      qty: walk.filledQty, price, cost: walk.cost + fee, fee,
      sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((price - mid) / mid) * 10000).toFixed(2), levels: walk.levelsUsed, partial: walk.remaining > 1e-9, unfilledQuote: +walk.remaining.toFixed(4) },
    };
  }

  const qty = Math.min(quantity, b[base] || 0);
  if (qty <= 0) throw new Error(`Insufficient ${base} balance`);
  const walk = walkBook(book.bids, 'SELL', qty);
  if (walk.filledQty <= 0) throw new Error('Order rejected: no liquidity');
  const fee = walk.cost * FEE;
  b[base] = (b[base] || 0) - walk.filledQty;
  if (b[base] < 1e-12) delete b[base];
  b[quote] = (b[quote] || 0) + walk.cost - fee;
  await db.wallet.update(w._id, { balances: b });
  const price = walk.cost / walk.filledQty;
  return {
    qty: walk.filledQty, price, cost: walk.cost - fee, fee,
    sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((mid - price) / mid) * 10000).toFixed(2), levels: walk.levelsUsed, partial: walk.remaining > 1e-12, unfilledQty: walk.remaining },
  };
}

// Lot-based instruments (NSE currency futures): whole lots only, filled through the visible depth; the exchange shows
// just 5 levels, so anything beyond them fills one tick past the last level instead of being left unfilled.
// short=true: SELL opens a short sized by quoteAmount (units go negative), BUY covers up to the open short.
async function lotOrder({ adapter, w, b, book, mid, side, base, quote, quoteAmount, quantity, exchange, latency, short = false }) {
  const lot = adapter.lotUnits;
  const feeRate = adapter.costs?.feeRate ?? FEE;
  const levels = side === 'BUY' ? book.asks : book.bids;
  let units;
  const shortHeld = Math.max(0, -(b[base] || 0));
  if (short && side === 'SELL') {
    // Fully funded: the short's notional must be covered by free cash (cash minus what other shorts reserve).
    units = Math.floor(Math.min(quoteAmount, b[quote] || 0) / (levels[0][0] * lot * (1 + feeRate) * 1.001)) * lot;
    if (units < lot) throw new Error(`Short is smaller than 1 lot (${lot} units) or the ${quote} balance is too low`);
  } else if (short && side === 'BUY') {
    units = Math.floor(Math.min(quantity, shortHeld) / lot + 1e-9) * lot;
    if (units < lot) throw new Error(`No ${base} short position to cover`);
  } else if (side === 'BUY') {
    const spend = Math.min(quoteAmount, b[quote] || 0);
    units = Math.floor(spend / (levels[0][0] * lot * (1 + feeRate) * 1.001)) * lot;
    if (units < lot) throw new Error(lot === 1 ? `Amount is below the price of one share (${quote} ${levels[0][0]}) or the ${quote} balance is too low` : `Order is smaller than 1 lot (${lot} units, about ${quote} ${Math.round(levels[0][0] * lot).toLocaleString('en-IN')}) or the ${quote} balance is too low`);
  } else {
    units = Math.floor(Math.min(quantity, b[base] || 0) / lot + 1e-9) * lot;
    if (units < lot) throw new Error(`Insufficient ${base} ${lot === 1 ? 'shares' : 'position'}`);
  }
  const walk = walkBook(levels, 'SELL', units); // quantity-based walk for both sides
  let gross = walk.cost;
  if (walk.remaining > 0) {
    const worst = levels.at(-1)[0] * (side === 'BUY' ? 1.0001 : 0.9999);
    gross += walk.remaining * worst;
  }
  const fee = adapter.feeFor ? adapter.feeFor(gross, side) : gross * feeRate;
  if (short) {
    b[base] = (b[base] || 0) + (side === 'SELL' ? -units : units);
    if (Math.abs(b[base]) < 1e-9) delete b[base];
    b[quote] = (b[quote] || 0) + (side === 'SELL' ? gross - fee : -(gross + fee));
  } else if (side === 'BUY') {
    if (gross + fee > (b[quote] || 0)) throw new Error(`Insufficient ${quote} balance`);
    b[quote] -= gross + fee;
    b[base] = (b[base] || 0) + units;
  } else {
    b[base] -= units;
    if (b[base] < 1e-9) delete b[base];
    b[quote] = (b[quote] || 0) + gross - fee;
  }
  await db.wallet.update(w._id, { balances: b });
  const price = gross / units;
  return {
    qty: units, price, cost: side === 'BUY' ? gross + fee : gross - fee, fee,
    sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((side === 'BUY' ? price - mid : mid - price) / mid) * 10000).toFixed(2), levels: walk.levelsUsed, partial: false, lots: units / lot },
  };
}
