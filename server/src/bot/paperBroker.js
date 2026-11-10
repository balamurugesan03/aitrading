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
  futures: { kind: 'paper-nfut', quote: 'INR', start: () => config.paperFuturesStartBalance },
  perps: { kind: 'paper-perp', quote: 'USDT', start: () => config.paperPerpsStartBalance },
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

// Margin blocked per symbol (rupees) in a margin paper account (futures); empty for fully funded accounts.
export async function getPaperMargin(userId, exchange) {
  return (await wallet(userId, exchange)).margin || {};
}

export async function resetPaperWallet(userId, amount, exchange = 'binance') {
  const W = walletFor(exchange);
  const w = await wallet(userId, exchange);
  return db.wallet.update(w._id, { balances: { [W.quote]: amount ?? W.start() }, margin: {}, perps: {} });
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

export async function paperOrder({ userId, exchange = 'binance', side, symbol, base, quote, quoteAmount, quantity, short = false, leverage }) {
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
  if (adapter.perp) return perpOrder({ adapter, w, b, book, mid, side, symbol, base, quote, quoteAmount, quantity, exchange, latency, short, leverage });
  if (adapter.margin) return marginOrder({ adapter, w, b, book, mid, side, symbol, base, quote, quoteAmount, quantity, exchange, latency, short });
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

// Margin instruments (NSE futures): whole lots of a per-contract lot size; a position blocks marginRate x notional
// instead of its full notional. Cash carries the signed flows exactly like the lot wallet (a long's purchase is
// paid from cash, which may go negative; a short's sale proceeds sit in cash), so equity is still
// cash + signed units x price. `margin` records what each open position blocks; free margin = equity - blocked.
// One direction per symbol: open the other side only after closing this one.
async function marginOrder({ adapter, w, b, book, mid, side, symbol, base, quote, quoteAmount, quantity, exchange, latency, short = false }) {
  const lot = await adapter.lotFor(symbol);
  const rate = adapter.marginRateOf(symbol);
  const levels = side === 'BUY' ? book.asks : book.bids;
  const margin = { ...(w.margin || {}) };
  const held = b[base] || 0; // signed units
  const opening = short ? side === 'SELL' : side === 'BUY';
  let units;
  let have = 0;
  if (opening) {
    if (short ? held > 0 : held < 0) throw new Error(`Close the ${base} ${held > 0 ? 'long' : 'short'} before opening a ${short ? 'short' : 'long'}`);
    const px = levels[0][0];
    const free = (await paperEquity(adapter, b, { [base]: mid })) - Object.values(margin).reduce((s, v) => s + v, 0);
    const lotNotional = px * lot;
    const wanted = Math.floor(quoteAmount / (lotNotional * 1.001));
    const affordable = Math.floor(free / (lotNotional * rate * 1.001 + adapter.feeFor(lotNotional, side)));
    const lots = Math.min(wanted, affordable);
    if (wanted < 1) throw new Error(`Order is smaller than 1 lot of ${base} futures (${lot} units, about ${quote} ${Math.round(lotNotional).toLocaleString('en-IN')} notional)`);
    if (lots < 1) throw new Error(`Not enough free margin for 1 lot of ${base}: needs about ${quote} ${Math.round(lotNotional * rate).toLocaleString('en-IN')}, free ${quote} ${Math.round(Math.max(0, free)).toLocaleString('en-IN')}`);
    units = lots * lot;
  } else {
    have = short ? Math.max(0, -held) : Math.max(0, held);
    units = Math.floor(Math.min(quantity, have) / lot + 1e-9) * lot;
    if (units < lot) throw new Error(`No ${base} ${short ? 'short' : 'long'} futures position to ${short ? 'cover' : 'sell'}`);
  }
  const walk = walkBook(levels, 'SELL', units); // quantity-based walk for both sides
  let gross = walk.cost;
  if (walk.remaining > 0) gross += walk.remaining * levels.at(-1)[0] * (side === 'BUY' ? 1.0001 : 0.9999); // beyond the 5 visible levels
  const fee = adapter.feeFor(gross, side);
  b[base] = held + (side === 'BUY' ? units : -units);
  if (Math.abs(b[base]) < 1e-9) delete b[base];
  b[quote] = (b[quote] || 0) + (side === 'SELL' ? gross - fee : -(gross + fee));
  if (opening) margin[base] = (margin[base] || 0) + gross * rate;
  else if (b[base] === undefined) delete margin[base];
  else margin[base] = (margin[base] || 0) * (1 - units / have);
  await db.wallet.update(w._id, { balances: b, margin });
  const price = gross / units;
  return {
    qty: units, price, cost: side === 'BUY' ? gross + fee : gross - fee, fee,
    sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((side === 'BUY' ? price - mid : mid - price) / mid) * 10000).toFixed(2), levels: walk.levelsUsed, partial: false, lots: units / lot, marginBlocked: opening ? +(gross * rate).toFixed(2) : 0 },
  };
}

// Paper equity of a lot/margin wallet: cash + signed units x price (`known` supplies prices already at hand).
async function paperEquity(adapter, balances, known = {}, quote = 'INR') {
  const held = Object.keys(balances).filter((k) => k !== quote && balances[k] !== 0 && known[k] === undefined);
  const tickers = held.length ? await adapter.getTickers(held) : [];
  const px = (a) => known[a] ?? tickers.find((t) => t.symbol === a)?.price;
  let equity = balances[quote] || 0;
  for (const [a, u] of Object.entries(balances)) {
    if (a === quote || !u) continue;
    const p = px(a);
    if (!(p > 0)) throw new Error(`No price for ${a} - cannot value the margin account`);
    equity += u * p;
  }
  return equity;
}

// ---- Perpetual futures (Binance USD-M): leveraged, isolated margin, funding, liquidation ----
// Wallet: balances { USDT, SYMBOL: signed qty }, margin { SYMBOL: isolated margin }, and perps { SYMBOL: { side,
// entry, leverage, liqPrice, cost, fundingAt, fundingPaid } }. Cash carries the signed flows like the NSE futures
// wallet (equity = cash + signed qty x price). Leverage is fixed per symbol while a position is open (as on
// Binance); adding to a position averages the entry and moves the liquidation price.
const floorStep = (qty, step) => Math.floor(qty / step + 1e-9) * step;

async function perpOrder({ adapter, w, b, book, mid, side, symbol, base, quote, quoteAmount, quantity, exchange, latency, short = false, leverage }) {
  const info = (await adapter.getSymbols()).find((x) => x.symbol === symbol);
  if (!info) throw new Error(`${symbol} is not a perpetual on ${adapter.name}`);
  const levels = side === 'BUY' ? book.asks : book.bids;
  const margin = { ...(w.margin || {}) };
  const perps = { ...(w.perps || {}) };
  const m = perps[base];
  const held = b[base] || 0;
  const opening = short ? side === 'SELL' : side === 'BUY';
  const feeRate = adapter.costs.feeRate;
  let qty;
  if (opening) {
    if (short ? held > 0 : held < 0) throw new Error(`Close the ${base} ${held > 0 ? 'long' : 'short'} before opening a ${short ? 'short' : 'long'}`);
    const lev = m?.leverage ?? adapter.clampLeverage(leverage);
    const px = levels[0][0];
    const free = (await paperEquity(adapter, b, { [base]: mid }, quote)) - Object.values(margin).reduce((s, v) => s + v, 0);
    const maxQty = free / (px * (1 / lev + feeRate) * 1.002);
    qty = floorStep(Math.min(quoteAmount / px, maxQty), info.stepSize);
    if (quoteAmount < info.minNotional) throw new Error(`Order is below the ${symbol} minimum (${info.minNotional} ${quote} notional)`);
    if (qty * px < info.minNotional || qty < info.minQty) throw new Error(`Not enough free margin: ${info.minNotional} ${quote} notional at ${lev}x needs about ${(info.minNotional / lev).toFixed(2)} ${quote}, free ${Math.max(0, free).toFixed(2)} ${quote}`);
    const fill = fillQty(levels, qty, side);
    const fee = fill.gross * feeRate;
    const total = Math.abs(held) + qty;
    const entry = m ? (Math.abs(held) * m.entry + fill.gross) / total : fill.gross / qty;
    const pSide = short ? 'short' : 'long';
    b[base] = held + (side === 'BUY' ? qty : -qty);
    b[quote] = (b[quote] || 0) + (side === 'SELL' ? fill.gross - fee : -(fill.gross + fee));
    margin[base] = (margin[base] || 0) + fill.gross / lev;
    perps[base] = {
      side: pSide, entry, leverage: lev, liqPrice: adapter.liquidationPrice(entry, lev, pSide, symbol),
      cost: (m?.cost || 0) + (side === 'BUY' ? fill.gross + fee : fill.gross - fee),
      fundingAt: m?.fundingAt ?? Date.now(), fundingPaid: m?.fundingPaid || 0, openedAt: m?.openedAt || Date.now(),
    };
    await db.wallet.update(w._id, { balances: b, margin, perps });
    const price = fill.gross / qty;
    return {
      qty, price, cost: side === 'BUY' ? fill.gross + fee : fill.gross - fee, fee, leverage: lev, liqPrice: perps[base].liqPrice,
      sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((side === 'BUY' ? price - mid : mid - price) / mid) * 10000).toFixed(2), levels: fill.levelsUsed, partial: false, marginBlocked: +(fill.gross / lev).toFixed(2), leverage: lev, liqPrice: +perps[base].liqPrice.toFixed(6) },
    };
  }
  const have = short ? Math.max(0, -held) : Math.max(0, held);
  qty = quantity >= have * 0.999 ? have : floorStep(Math.min(quantity, have), info.stepSize); // a full close takes the dust too
  if (!(qty > 0)) throw new Error(`No ${base} ${short ? 'short' : 'long'} futures position to ${short ? 'cover' : 'sell'}`);
  const fill = fillQty(levels, qty, side);
  const fee = fill.gross * feeRate;
  closePerpBooks({ b, margin, perps, base, quote, qty, have, side, gross: fill.gross, fee });
  await db.wallet.update(w._id, { balances: b, margin, perps });
  const price = fill.gross / qty;
  return {
    qty, price, cost: side === 'BUY' ? fill.gross + fee : fill.gross - fee, fee,
    sim: { exchange, latencyMs: latency, midPrice: mid, slippageBps: +(((side === 'BUY' ? price - mid : mid - price) / mid) * 10000).toFixed(2), levels: fill.levelsUsed, partial: false },
  };
}

// Fills `qty` through the book; anything beyond the fetched depth fills 5 bps past the last level.
function fillQty(levels, qty, side) {
  const walk = walkBook(levels, 'SELL', qty);
  let gross = walk.cost;
  if (walk.remaining > 0) gross += walk.remaining * levels.at(-1)[0] * (side === 'BUY' ? 1.0005 : 0.9995);
  return { gross, levelsUsed: walk.levelsUsed };
}

// Books a (partial) close of `qty` out of `have`: cash flow, released margin, remaining cost basis.
function closePerpBooks({ b, margin, perps, base, quote, qty, have, side, gross, fee }) {
  const share = qty / have;
  b[base] = (b[base] || 0) + (side === 'BUY' ? qty : -qty);
  if (Math.abs(b[base]) < 1e-12) delete b[base];
  b[quote] = (b[quote] || 0) + (side === 'SELL' ? gross - fee : -(gross + fee));
  if (b[base] === undefined) {
    delete margin[base];
    delete perps[base];
  } else {
    margin[base] = (margin[base] || 0) * (1 - share);
    perps[base] = { ...perps[base], cost: perps[base].cost * (1 - share) };
  }
}

export async function getPaperPerps(userId, exchange) {
  return (await wallet(userId, exchange)).perps || {};
}

// Settles a paper perps account: credits/debits every funding payment since the last settlement (real Binance
// funding rates) and liquidates any position whose mark price crossed its liquidation price. A liquidation fills
// at the liquidation price and the rest of the isolated margin goes as the liquidation fee, so the position loses
// its whole margin, as on Binance. Each liquidation is written to the trade history. Throttled to every 30 s.
const lastSettle = new Map();
export async function settlePaperPerps(userId, exchange, { force = false } = {}) {
  const adapter = ex(exchange);
  const none = { liquidated: [], funding: [] };
  if (!adapter.perp) return none;
  const key = `${userId}:${exchange}`;
  if (!force && Date.now() - (lastSettle.get(key) || 0) < 30000) return none;
  lastSettle.set(key, Date.now());
  const w = await wallet(userId, exchange);
  const quote = walletFor(exchange).quote;
  const b = { ...w.balances };
  const margin = { ...(w.margin || {}) };
  const perps = { ...(w.perps || {}) };
  const out = { liquidated: [], funding: [] };
  for (const [sym, m0] of Object.entries(perps)) {
    const m = { ...m0 };
    perps[sym] = m;
    const qty = b[sym] || 0;
    if (!qty) { delete perps[sym]; delete margin[sym]; continue; }
    for (const f of await adapter.fundingSince(sym, m.fundingAt).catch(() => [])) {
      const mark = f.markPrice || (await adapter.getPrice(sym));
      const pay = qty * mark * f.rate; // longs pay a positive rate, shorts receive it
      b[quote] = (b[quote] || 0) - pay;
      m.fundingPaid = (m.fundingPaid || 0) + pay;
      m.fundingAt = f.time;
      out.funding.push({ symbol: sym, amount: -pay, rate: f.rate, time: f.time });
    }
    const { mark } = await adapter.getMarkPrice(sym);
    const hit = m.side === 'short' ? mark >= m.liqPrice : mark <= m.liqPrice;
    if (!hit) continue;
    const have = Math.abs(qty);
    const side = m.side === 'short' ? 'BUY' : 'SELL';
    const gross = have * m.liqPrice;
    const moveLoss = m.side === 'short' ? gross - have * m.entry : have * m.entry - gross;
    const fee = Math.max(0, (margin[sym] || 0) - moveLoss); // what is left of the isolated margin
    const cost = m.cost;
    closePerpBooks({ b, margin, perps, base: sym, quote, qty: have, have, side, gross, fee });
    const proceeds = side === 'SELL' ? gross - fee : gross + fee;
    const pnl = side === 'SELL' ? proceeds - cost : cost - proceeds;
    const trade = await db.trades.insert({
      userId, botId: null, botName: 'Liquidation', mode: 'paper', exchange, symbol: sym, side, qty: have, price: m.liqPrice, cost: proceeds, fee,
      pnl, pnlPct: (pnl / Math.abs(cost)) * 100, reason: `Liquidated at ${m.leverage}x (mark ${mark})`, positionSide: m.side, liquidation: true, time: Date.now(),
    });
    out.liquidated.push({ symbol: sym, side: m.side, qty: have, price: m.liqPrice, pnl, trade });
  }
  await db.wallet.update(w._id, { balances: b, margin, perps });
  return out;
}
