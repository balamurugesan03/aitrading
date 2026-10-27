// Options trading service: account, pre-trade risk gates, execution (paper or live), marking and exits.
//
// Execution order protects against ever being naked: opening places the BOUGHT legs first, then the sold legs;
// closing buys back the SOLD legs first, then sells the bought ones. If a later leg fails, the legs already filled
// are unwound in reverse, so the account never keeps a half-built (possibly unhedged) structure.
import { EventEmitter } from 'events';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { marketCreds } from '../exchange/zerodha.js';
import { credsFor } from '../exchange/index.js';
import { chain as loadChain, optionQuotes, placeLeg, optionFee, marginAvailable, basketMargin, nfo } from '../exchange/nfo.js';
import { buildLegs, analyzeLegs, legsFromRequest, scaleLegs, TEMPLATES } from './strategies.js';
import { getSettings } from '../bot/safety.js';
import { notify, audit } from '../notify.js';

export const optionEvents = new EventEmitter();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const OPTION_DEFAULTS = { riskPct: 2, maxOpen: 3, minDte: 1, maxSpreadPct: 10, dailyLossLimitPct: 5, tpPct: 50, slPct: 50 };

// ---- Paper wallet (INR) ----
async function paperWallet(userId) {
  let w = await db.wallet.findOne({ kind: 'paper-nfo', userId });
  if (!w) w = await db.wallet.insert({ kind: 'paper-nfo', userId, balances: { INR: config.paperOptionsStartBalance } });
  return w;
}
export async function resetOptionsPaper(userId, amount = config.paperOptionsStartBalance) {
  if ((await db.optionPositions.find({ userId, mode: 'paper', status: 'open' })).length) throw bad('Close the open paper option positions first');
  const w = await paperWallet(userId);
  return db.wallet.update(w._id, { balances: { INR: amount } });
}

// Cash flow of legs at given prices: + received, - paid.
const cashflow = (legs, priceOf, closing = false) => legs.reduce((s, l) => {
  const side = closing ? (l.side === 'BUY' ? 'SELL' : 'BUY') : l.side;
  return s + (side === 'SELL' ? 1 : -1) * priceOf(l) * l.qty;
}, 0);

// Current exit value of an open position from live quotes (conservative: sell at bid, buy back at ask).
export async function markPosition(pos, quotes) {
  const q = quotes || (await optionQuotes(pos.legs.map((l) => l.tradingsymbol), await marketCreds()));
  const exitPrice = (l) => {
    const x = q[l.tradingsymbol];
    if (!x) return l.lastMark ?? l.entryPrice;
    return l.side === 'BUY' ? x.bid || x.ltp : x.ask || x.ltp;
  };
  const exitCash = cashflow(pos.legs, exitPrice, true);
  const exitFees = pos.legs.reduce((s, l) => s + optionFee(exitPrice(l) * l.qty, l.side === 'BUY' ? 'SELL' : 'BUY'), 0);
  const pnl = pos.entryCash + exitCash - exitFees;
  return { pnl: +pnl.toFixed(2), exitValue: +exitCash.toFixed(2), legs: pos.legs.map((l) => ({ ...l, mark: exitPrice(l), ltp: q[l.tradingsymbol]?.ltp })) };
}

// ---- Account: equity, free capital, open risk, P&L ----
export async function optionsAccount(user, mode = 'paper') {
  const open = await db.optionPositions.find({ userId: user._id, mode, status: 'open' });
  const all = await db.optionPositions.find({ userId: user._id, mode });
  const quotes = open.length ? await marketCreds().then((c) => optionQuotes([...new Set(open.flatMap((p) => p.legs.map((l) => l.tradingsymbol)))], c)).catch(() => null) : {};
  const marks = await Promise.all(open.map((p) => (quotes ? markPosition(p, quotes) : { pnl: 0, exitValue: 0 })));
  const openRisk = open.reduce((s, p) => s + (p.maxLoss || 0), 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const realizedToday = all.filter((p) => p.status === 'closed' && p.closedAt >= today.getTime()).reduce((s, p) => s + (p.pnl || 0), 0);
  const realized = all.filter((p) => p.status === 'closed').reduce((s, p) => s + (p.pnl || 0), 0);
  let cash;
  let equity;
  let free;
  if (mode === 'paper') {
    cash = (await paperWallet(user._id)).balances.INR || 0;
    equity = cash + marks.reduce((s, m) => s + m.exitValue, 0);
    // Credit positions keep their worst case reserved; debit positions already paid theirs.
    free = cash - open.reduce((s, p) => s + (p.netPremium > 0 ? p.maxLoss + p.netPremium : 0), 0);
  } else {
    const creds = await credsFor(user, 'nfo');
    if (!creds) throw bad('Connect Zerodha (Account > Exchange connections) for live options');
    free = await marginAvailable(creds);
    cash = free;
    equity = free + openRisk; // capital base for sizing: available margin + what open positions can still lose
  }
  return { mode, currency: 'INR', equity: +equity.toFixed(2), cash: +cash.toFixed(2), free: +free.toFixed(2), openRisk: +openRisk.toFixed(2), openPositions: open.length, unrealized: +marks.reduce((s, m) => s + m.pnl, 0).toFixed(2), realized: +realized.toFixed(2), realizedToday: +realizedToday.toFixed(2), startBalance: mode === 'paper' ? config.paperOptionsStartBalance : null };
}

// ---- Preview: legs + analysis + risk gates (+ auto lot sizing) ----
export async function previewTrade(user, req) {
  const mode = req.mode === 'live' ? 'live' : 'paper';
  const chain = req.chain || (await loadChain(req.underlying, req.expiry));
  const settings = await getSettings(user._id);
  const R = { ...OPTION_DEFAULTS, ...(req.risk || {}) };
  const unit = req.legs?.length ? legsFromRequest(chain, req.legs) : buildLegs(chain, { template: req.template, width: req.width, distance: req.distance, lots: 1 });
  const unitA = analyzeLegs(unit, chain);
  const acct = await optionsAccount(user, mode);
  // Lots: as requested, or (auto) as many as the risk budget allows.
  const budget = acct.equity * (Math.min(R.riskPct, 5) / 100);
  const autoLots = unitA.maxLoss ? Math.floor(budget / unitA.maxLoss) : 0;
  const lots = req.lots === 'auto' || req.lots === undefined ? Math.max(0, autoLots) : Math.max(1, Math.floor(Number(req.lots)));
  const legs = scaleLegs(unit, Math.max(lots, 1), chain.lotSize);
  const a = analyzeLegs(legs, chain);
  const gates = [];
  const gate = (name, pass, note) => gates.push({ name, pass: Boolean(pass), note });
  gate('Kill switch', settings.tradingEnabled, settings.tradingEnabled ? 'Trading enabled' : 'Trading is disabled');
  gate('Market hours', nfo.marketOpen(), nfo.marketOpen() ? 'NSE F&O open' : 'NSE F&O is closed (Mon-Fri 09:15-15:30 IST)');
  gate('Defined risk', a.definedRisk, a.definedRisk ? `Worst case Rs ${a.maxLoss}` : 'More options sold than bought (per calls / puts) - naked selling is not allowed');
  if (a.definedRisk) {
    gate('Size', lots >= 1, lots >= 1 ? `${lots} lot(s) x ${chain.lotSize}` : `1 lot risks Rs ${unitA.maxLoss}, more than ${R.riskPct}% of equity (Rs ${budget.toFixed(0)})`);
    gate('Risk per trade', a.maxLoss <= acct.equity * (Math.min(R.riskPct, 5) / 100) + 1, `Max loss Rs ${a.maxLoss} vs limit Rs ${(acct.equity * (Math.min(R.riskPct, 5) / 100)).toFixed(0)} (${R.riskPct}% of equity)`);
  }
  gate('Open positions', acct.openPositions < R.maxOpen, `${acct.openPositions} open (max ${R.maxOpen})`);
  gate('Days to expiry', chain.daysToExpiry >= R.minDte, `${chain.daysToExpiry} days (min ${R.minDte}) - avoids expiry-day gamma risk`);
  const liquid = a.worstSpreadPct <= R.maxSpreadPct || (a.worstSpreadAbs !== null && a.worstSpreadAbs <= 0.5);
  gate('Liquidity', liquid, a.worstSpreadAbs === null ? 'A leg has no bid or no ask' : `Widest bid/ask spread Rs ${a.worstSpreadAbs} (${a.worstSpreadPct}% of price; ok if <= ${R.maxSpreadPct}% or <= Rs 0.50)`);
  const lostPct = acct.realizedToday < 0 ? (Math.abs(acct.realizedToday) / Math.max(acct.equity, 1)) * 100 : 0;
  gate('Daily loss limit', lostPct < R.dailyLossLimitPct, `${lostPct.toFixed(2)}% lost today (limit ${R.dailyLossLimitPct}%)`);
  const needed = a.netPremium < 0 ? -a.netPremium + a.charges / 2 : a.maxLoss; // debit paid, or a credit trade's worst case
  let marginNote = needed !== null && Number.isFinite(needed) ? `Needs about Rs ${needed.toFixed(0)} of Rs ${acct.free.toFixed(0)} free` : 'Unlimited worst case - cannot be funded';
  let marginOk = needed !== null && Number.isFinite(needed) && needed <= acct.free;
  if (mode === 'live' && a.definedRisk) {
    const creds = await credsFor(user, 'nfo');
    const m = creds ? await basketMargin(creds, legs) : null;
    if (m !== null) { marginOk = m <= acct.free; marginNote = `Zerodha basket margin Rs ${m.toFixed(0)} of Rs ${acct.free.toFixed(0)} available`; }
  }
  gate('Capital / margin', marginOk, marginNote);
  const approved = gates.every((g) => g.pass);
  return { mode, chain: { underlying: chain.underlying, spot: chain.spot, expiry: chain.expiry, expiryMs: chain.expiryMs, daysToExpiry: chain.daysToExpiry, lotSize: chain.lotSize, atmIv: chain.atmIv }, template: req.template || 'custom', templateName: TEMPLATES[req.template]?.name || 'Custom', lots, analysis: a, account: acct, gates, approved, rejectedBy: gates.filter((g) => !g.pass).map((g) => g.name) };
}

// ---- Execution ----
async function fillPaper(user, legs, closing) {
  const quotes = await optionQuotes(legs.map((l) => l.tradingsymbol), await marketCreds());
  await sleep(150 + Math.random() * 250);
  return legs.map((l) => {
    const side = closing ? (l.side === 'BUY' ? 'SELL' : 'BUY') : l.side;
    const q = quotes[l.tradingsymbol];
    if (!q) throw bad(`No quote for ${l.tradingsymbol}`);
    const price = side === 'BUY' ? q.ask || q.ltp * 1.01 : q.bid || q.ltp * 0.99;
    if (!(price > 0)) throw bad(`No ${side === 'BUY' ? 'sellers' : 'buyers'} for ${l.tradingsymbol}`);
    return { ...l, execSide: side, price, fee: optionFee(price * l.qty, side), filled: l.qty };
  });
}

// Live: legs one by one in the safe order; on failure, unwind what was filled (reverse order) and stop.
async function fillLive(user, legs, closing, tag) {
  const creds = await credsFor(user, 'nfo');
  if (!creds) throw bad('Connect Zerodha for live options');
  const order = closing ? [...legs].sort((a, b) => (a.side === 'SELL' ? -1 : 1) - (b.side === 'SELL' ? -1 : 1)) : [...legs].sort((a, b) => (a.side === 'BUY' ? -1 : 1) - (b.side === 'BUY' ? -1 : 1));
  const done = [];
  for (const l of order) {
    const side = closing ? (l.side === 'BUY' ? 'SELL' : 'BUY') : l.side;
    const f = await placeLeg(creds, { tradingsymbol: l.tradingsymbol, side, qty: l.qty, tag }).catch((err) => ({ error: err.message, filled: 0 }));
    if (f.filled === l.qty) { done.push({ ...l, execSide: side, price: f.price, fee: f.fee, filled: f.filled, orderId: f.orderId }); continue; }
    // Failed or partial: undo everything done so far (including a partial fill of this leg).
    const partial = f.filled ? [{ ...l, qty: f.filled, execSide: side }] : [];
    const undo = [...partial, ...done].reverse();
    const undoErrors = [];
    for (const u of undo) {
      const back = u.execSide === 'BUY' ? 'SELL' : 'BUY';
      const r = await placeLeg(creds, { tradingsymbol: u.tradingsymbol, side: back, qty: u.filled ?? u.qty, tag: `${tag}U` }).catch((err) => ({ error: err.message, filled: 0 }));
      if (r.filled !== (u.filled ?? u.qty)) undoErrors.push(`${u.tradingsymbol}: ${r.error || r.message || 'not fully filled'}`);
    }
    const why = f.error || f.message || `${l.tradingsymbol} filled ${f.filled}/${l.qty}`;
    if (undoErrors.length) {
      notify(user._id, { type: 'warn', title: 'Options: unwind incomplete - check Zerodha now', body: `${why}. Unwind problems: ${undoErrors.join('; ')}`, important: true });
      throw bad(`Leg failed (${why}) and the unwind was incomplete: ${undoErrors.join('; ')} - check your Zerodha positions`);
    }
    throw bad(`Leg ${l.tradingsymbol} failed (${why}); legs already filled were reversed`);
  }
  return done;
}

export async function openTrade(user, req, { botId = null, reason = 'Manual' } = {}) {
  const pv = await previewTrade(user, req);
  if (!pv.approved) throw Object.assign(bad(`Rejected by: ${pv.rejectedBy.join(', ')}`), { preview: pv });
  const mode = pv.mode;
  const legs = pv.analysis.legs;
  const tag = `nxo${Date.now().toString(36)}`;
  const fills = mode === 'paper' ? await fillPaper(user, legs, false) : await fillLive(user, legs, false, tag);
  const entryCash = fills.reduce((s, f) => s + (f.execSide === 'SELL' ? 1 : -1) * f.price * f.qty, 0) - fills.reduce((s, f) => s + f.fee, 0);
  if (mode === 'paper') {
    const w = await paperWallet(user._id);
    if (entryCash < 0 && -entryCash > (w.balances.INR || 0)) throw bad('Insufficient paper INR balance');
    await db.wallet.update(w._id, { balances: { ...w.balances, INR: (w.balances.INR || 0) + entryCash } });
  }
  const R = { ...OPTION_DEFAULTS, ...(req.risk || {}) };
  const pos = await db.optionPositions.insert({
    userId: user._id, mode, botId, status: 'open', underlying: pv.chain.underlying, expiry: pv.chain.expiry, expiryMs: pv.chain.expiryMs,
    template: pv.template, templateName: pv.templateName, lots: pv.lots, lotSize: pv.chain.lotSize,
    legs: fills.map((f) => ({ tradingsymbol: f.tradingsymbol, type: f.type, strike: f.strike, side: f.side, lots: f.lots, qty: f.qty, entryPrice: f.price, entryFee: f.fee, orderId: f.orderId || null })),
    entryCash: +entryCash.toFixed(2), netPremium: pv.analysis.netPremium, maxProfit: pv.analysis.maxProfit, maxLoss: pv.analysis.maxLoss, breakevens: pv.analysis.breakevens,
    pop: pv.analysis.pop, spotAtEntry: pv.chain.spot, ivAtEntry: pv.chain.atmIv, openedAt: Date.now(), reason,
    autoManage: req.autoManage !== false, tpPct: Number(req.tpPct ?? R.tpPct), slPct: Number(req.slPct ?? R.slPct),
  });
  await audit(user._id, 'options.open', { template: pos.templateName, underlying: pos.underlying, expiry: pos.expiry, lots: pos.lots, mode, maxLoss: pos.maxLoss });
  notify(user._id, { type: 'trade', title: `Options: opened ${pos.templateName} on ${pos.underlying}`, body: `${pos.lots} lot(s), ${pos.expiry}, max loss Rs ${pos.maxLoss} (${mode})`, important: mode === 'live' });
  optionEvents.emit('position', pos);
  return { position: pos, preview: pv };
}

export async function closeTrade(user, posId, reason = 'Manual close') {
  const pos = await db.optionPositions.findOne({ _id: posId });
  if (!pos || pos.userId !== user._id) throw bad('Position not found', 404);
  if (pos.status !== 'open') throw bad('Position is already closed');
  await db.optionPositions.update(pos._id, { status: 'closing' });
  try {
    const legs = pos.legs.map((l) => ({ ...l, price: l.entryPrice }));
    const fills = pos.mode === 'paper' ? await fillPaper(user, legs, true) : await fillLive(user, legs, true, `nxc${Date.now().toString(36)}`);
    const exitCash = fills.reduce((s, f) => s + (f.execSide === 'SELL' ? 1 : -1) * f.price * f.qty, 0) - fills.reduce((s, f) => s + f.fee, 0);
    if (pos.mode === 'paper') {
      const w = await paperWallet(user._id);
      await db.wallet.update(w._id, { balances: { ...w.balances, INR: (w.balances.INR || 0) + exitCash } });
    }
    const pnl = pos.entryCash + exitCash;
    const updated = await db.optionPositions.update(pos._id, {
      status: 'closed', closedAt: Date.now(), closeReason: reason, exitCash: +exitCash.toFixed(2), pnl: +pnl.toFixed(2),
      legs: pos.legs.map((l) => ({ ...l, exitPrice: fills.find((f) => f.tradingsymbol === l.tradingsymbol)?.price ?? null })),
    });
    if (pos.botId) {
      const bot = await db.optionBots.findOne({ _id: pos.botId });
      if (bot) {
        const st = bot.stats || { trades: 0, wins: 0, pnl: 0 };
        await db.optionBots.update(bot._id, { stats: { trades: st.trades + 1, wins: st.wins + (pnl > 0 ? 1 : 0), pnl: +(st.pnl + pnl).toFixed(2) } });
      }
    }
    await audit(user._id, 'options.close', { template: pos.templateName, pnl: +pnl.toFixed(2), reason, mode: pos.mode });
    notify(user._id, { type: pnl >= 0 ? 'profit' : 'loss', title: `Options: ${pos.templateName} closed ${pnl >= 0 ? '+' : ''}Rs ${pnl.toFixed(0)}`, body: `${reason} (${pos.mode})`, important: pos.mode === 'live' });
    optionEvents.emit('position', updated);
    return updated;
  } catch (err) {
    await db.optionPositions.update(pos._id, { status: 'open', lastError: err.message });
    throw err;
  }
}

// ---- Exit manager: take-profit, stop-loss and expiry exits for every auto-managed open position ----
const EXPIRY_EXIT_MS = 6 * 3600e3; // close on expiry day ~09:30 IST (expiry 15:30): no expiry-day gamma or settlement risk
export async function manageAll() {
  if (!nfo.marketOpen()) return;
  const open = await db.optionPositions.find({ status: 'open' });
  if (!open.length) return;
  const quotes = await marketCreds().then((c) => optionQuotes([...new Set(open.flatMap((p) => p.legs.map((l) => l.tradingsymbol)))], c)).catch(() => null);
  if (!quotes) return; // no Kite session: the 6 AM expiry alert from the bots covers it
  for (const pos of open) {
    if (pos.autoManage === false && Date.now() < pos.expiryMs - EXPIRY_EXIT_MS) continue;
    const m = await markPosition(pos, quotes);
    await db.optionPositions.update(pos._id, { lastPnl: m.pnl, lastMarkAt: Date.now() });
    let reason = null;
    if (Date.now() >= pos.expiryMs - EXPIRY_EXIT_MS) reason = 'Expiry-day exit';
    else if (pos.maxProfit && m.pnl >= pos.maxProfit * (pos.tpPct / 100)) reason = `Take-profit (${pos.tpPct}% of max profit)`;
    else if (!pos.maxProfit && pos.netPremium < 0 && m.pnl >= -pos.netPremium * (pos.tpPct / 100)) reason = `Take-profit (+${pos.tpPct}% on premium)`;
    else if (pos.maxLoss && m.pnl <= -pos.maxLoss * (pos.slPct / 100)) reason = `Stop-loss (${pos.slPct}% of max loss)`;
    if (!reason) continue;
    const user = await db.users.findOne({ _id: pos.userId });
    await closeTrade(user, pos._id, reason).catch((err) => notify(pos.userId, { type: 'warn', title: `Options exit failed: ${pos.templateName}`, body: `${reason}: ${err.message}`, important: true }));
  }
}

let managerTimer = null;
export function startOptionsManager() {
  if (managerTimer) return;
  managerTimer = setInterval(() => manageAll().catch((err) => console.error('[options] manager:', err.message)), 30000);
  managerTimer.unref?.();
}
