// Options bots: the AI reads the index (NIFTY / BANKNIFTY) on the bot's timeframe and picks a defined-risk strategy:
//   bullish signal -> bull call spread (or long call), bearish -> bear put spread (or long put),
//   quiet range (sideways / low volatility, weak score) -> iron condor.
// Entries go through the same risk gates as manual trades; exits (take-profit, stop, expiry day) are handled by the
// options exit manager, plus an AI exit when the market turns against a directional position.
import { db } from '../db/index.js';
import { analyze } from '../ai/analyzer.js';
import { nfo, chain as loadChain, expiries } from '../exchange/nfo.js';
import { marketCreds } from '../exchange/zerodha.js';
import { events as engineEvents } from '../bot/engine.js';
import { openTrade, closeTrade, previewTrade } from './service.js';
import { notify } from '../notify.js';

export const OPTION_BOT_DEFAULTS = {
  underlying: 'NIFTY', interval: '15m', mode: 'paper', template: 'auto', directional: 'spread', threshold: 35,
  width: 2, distance: 4, riskPct: 2, tpPct: 50, slPct: 50, minDte: 2, maxDte: 10, minPop: 0.3, condorMinIv: 11,
  // true: trade a direction only when the AI's history-calibrated edge confirms it (LONG / SHORT signal).
  // false: any score past the threshold counts (more trades, no proven edge).
  requireEdge: true,
};
const TICK_MS = 60000;
const timers = new Map();
const busy = new Set();
const lastWarn = new Map();

async function log(bot, level, msg) {
  const row = await db.logs.insert({ userId: bot.userId, botId: bot._id, level, msg: `[options] ${msg}`, time: Date.now() });
  engineEvents.emit('log', row);
}
async function warnOnce(bot, key, msg) {
  const k = `${bot._id}:${key}`;
  if (Date.now() - (lastWarn.get(k) || 0) < 30 * 60e3) return;
  lastWarn.set(k, Date.now());
  await log(bot, 'warn', msg);
}

// Nearest expiry inside the bot's [minDte, maxDte] window (falls back to the nearest one past minDte).
async function pickExpiry(bot) {
  const list = await expiries(bot.underlying, await marketCreds());
  const dte = (d) => (Date.parse(`${d}T15:30:00+05:30`) - Date.now()) / 86400e3;
  return list.find((d) => dte(d) >= bot.minDte && dte(d) <= bot.maxDte) || list.find((d) => dte(d) >= bot.minDte) || null;
}

function chooseTemplate(bot, signal, chain) {
  const regime = signal.regime?.name;
  const fixed = bot.template !== 'auto' ? bot.template : null;
  const blockedUp = ['BEAR_TREND', 'BREAKDOWN', 'PANIC'].includes(regime);
  const blockedDown = ['BULL_TREND', 'BREAKOUT'].includes(regime);
  const bullish = bot.requireEdge ? signal.signal === 'LONG' : signal.score >= bot.threshold && !blockedUp;
  const bearish = bot.requireEdge ? signal.signal === 'SHORT' : signal.score <= -bot.threshold && !blockedDown;
  const quiet = Math.abs(signal.score) < bot.threshold / 2 && ['SIDEWAYS', 'LOW_VOLATILITY'].includes(regime) && (chain.atmIv || 0) >= bot.condorMinIv;
  const spread = bot.directional !== 'single';
  if (fixed) {
    if (['bull_call_spread', 'long_call'].includes(fixed)) return bullish ? fixed : null;
    if (['bear_put_spread', 'long_put'].includes(fixed)) return bearish ? fixed : null;
    if (fixed === 'iron_condor') return quiet ? fixed : null;
    return null;
  }
  if (bullish) return spread ? 'bull_call_spread' : 'long_call';
  if (bearish) return spread ? 'bear_put_spread' : 'long_put';
  if (quiet) return 'iron_condor';
  return null;
}

async function tick(botId) {
  if (busy.has(botId)) return;
  busy.add(botId);
  let bot;
  try {
    bot = await db.optionBots.findOne({ _id: botId });
    if (!bot || bot.status !== 'running') return stopOptionBot(botId);
    if (!nfo.marketOpen()) return;
    bot = { ...OPTION_BOT_DEFAULTS, ...bot };
    const user = await db.users.findOne({ _id: bot.userId });
    const open = (await db.optionPositions.find({ botId: bot._id })).find((p) => p.status === 'open');

    // Closed candles of the index drive the AI (one analysis per candle).
    const candles = await nfo.getKlinesDeep(bot.underlying, bot.interval, 500);
    const closed = candles.slice(0, -1);
    const last = closed.at(-1);
    if (!last || bot.lastCandleTime === last.time) return;
    const signal = await analyze(bot.underlying, bot.interval, { candles: closed, price: candles.at(-1).close, exchange: 'nfo', threshold: bot.threshold, allowShort: true });
    await db.optionBots.update(bot._id, { lastCandleTime: last.time, lastSignal: { signal: signal.signal, score: signal.score, regime: signal.regime?.label, quality: signal.quality, time: Date.now() } });

    if (open) {
      // AI exit for directional positions when the view flips.
      const view = ['bull_call_spread', 'long_call'].includes(open.template) ? 'bull' : ['bear_put_spread', 'long_put'].includes(open.template) ? 'bear' : 'neutral';
      const flip = (view === 'bull' && signal.score <= -bot.threshold) || (view === 'bear' && signal.score >= bot.threshold)
        || (view === 'neutral' && ['BREAKOUT', 'BREAKDOWN', 'PANIC'].includes(signal.regime?.name));
      if (flip) {
        await log(bot, 'info', `AI exit: ${signal.signal} score ${signal.score}, ${signal.regime?.label}`);
        await closeTrade(user, open._id, `AI exit (${signal.regime?.label}, score ${signal.score})`);
      }
      return;
    }

    const expiry = await pickExpiry(bot);
    if (!expiry) return warnOnce(bot, 'expiry', `No ${bot.underlying} expiry between ${bot.minDte} and ${bot.maxDte} days`);
    const chain = await loadChain(bot.underlying, expiry);
    const template = chooseTemplate(bot, signal, chain);
    if (!template) return log(bot, 'info', `${signal.signal} | ${signal.regime?.label} | score ${signal.score} | IV ${chain.atmIv}% - no trade`);
    const req = { mode: bot.mode, chain, underlying: bot.underlying, expiry, template, width: bot.width, distance: bot.distance, lots: 'auto', risk: { riskPct: bot.riskPct, minDte: bot.minDte }, tpPct: bot.tpPct, slPct: bot.slPct };
    const pv = await previewTrade(user, req);
    if (pv.approved && pv.analysis.pop < bot.minPop) {
      return log(bot, 'info', `${pv.templateName} skipped: probability of profit ${(pv.analysis.pop * 100).toFixed(0)}% < ${(bot.minPop * 100).toFixed(0)}%`);
    }
    if (!pv.approved) return log(bot, 'info', `${pv.templateName} rejected by ${pv.rejectedBy.join(', ')}`);
    const { position } = await openTrade(user, req, { botId: bot._id, reason: `${signal.signal} ${signal.regime?.label} score ${signal.score}` });
    await log(bot, 'trade', `Opened ${position.templateName} ${position.underlying} ${position.expiry} x${position.lots} | max loss Rs ${position.maxLoss} | max profit ${position.maxProfit ?? 'open'} | POP ${(position.pop * 100).toFixed(0)}%`);
  } catch (err) {
    if (bot) {
      if (err.code === 'KITE_LOGIN') await warnOnce(bot, 'kite', `${err.message} - waiting`);
      else await log(bot, 'error', err.message);
    }
  } finally {
    busy.delete(botId);
  }
}

export function startOptionBot(botId) {
  stopOptionBot(botId);
  timers.set(botId, setInterval(() => tick(botId), TICK_MS));
  tick(botId);
}
export function stopOptionBot(botId) {
  clearInterval(timers.get(botId));
  timers.delete(botId);
}
export async function resumeOptionBots() {
  for (const b of await db.optionBots.find({ status: 'running' })) startOptionBot(b._id);
}
export async function stopAllOptionBots(timeoutMs = 10000) {
  for (const id of [...timers.keys()]) stopOptionBot(id);
  const until = Date.now() + timeoutMs;
  while (busy.size && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

// Kill switch: stop the user's option bots and close their open option positions.
engineEvents.on('killswitch', async ({ userId }) => {
  for (const b of await db.optionBots.find({ userId })) {
    if (b.status === 'running') { stopOptionBot(b._id); await db.optionBots.update(b._id, { status: 'stopped' }); }
  }
  const user = await db.users.findOne({ _id: userId });
  for (const p of await db.optionPositions.find({ userId, status: 'open' })) {
    await closeTrade(user, p._id, 'Kill switch').catch((err) => notify(userId, { type: 'warn', title: 'Options: kill switch could not close a position', body: `${p.templateName}: ${err.message}`, important: true }));
  }
});
