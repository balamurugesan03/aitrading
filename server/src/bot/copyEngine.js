// Copy trading: followers mirror a leader bot's entries and exits, sized proportionally to their own
// equity. Every follower trade still passes the follower's own kill switch and exposure checks.
import { db } from '../db/index.js';
import { events, executeOrder, getUser } from './engine.js';
import { getSettings } from './safety.js';
import { valuePortfolio } from '../ai/portfolio.js';
import { notify } from '../notify.js';

async function followerOpen(link, bot, fraction) {
  const follower = await getUser(link.followerId);
  if (!follower || follower.status === 'suspended') return;
  const settings = await getSettings(follower._id);
  if (!settings.tradingEnabled) return;
  if (await db.copyPositions.findOne({ linkId: link._id })) return; // already holding this leader's position
  const pf = await valuePortfolio(follower, link.mode);
  const cash = pf.assets.filter((a) => a.stable).reduce((s, a) => s + a.value, 0);
  const exposureAfter = (100 - pf.stablePct) + (fraction * link.multiplier * 100);
  if (exposureAfter > settings.risk.maxExposurePct) {
    return notify(follower._id, { type: 'warn', title: `Copy of ${bot.name} skipped`, body: `Would exceed your max exposure (${settings.risk.maxExposurePct}%).` });
  }
  let amount = pf.total * fraction * link.multiplier;
  if (link.maxTradeUsd) amount = Math.min(amount, link.maxTradeUsd);
  amount = Math.min(amount, cash * 0.995);
  if (amount < 10) return notify(follower._id, { type: 'warn', title: `Copy of ${bot.name} skipped`, body: 'Trade size below 10 USDT.' });
  const { fill } = await executeOrder({
    user: follower, mode: link.mode, exchange: link.exchange || bot.exchange || 'binance', symbol: bot.symbol, side: 'BUY', quoteAmount: amount,
    reason: `Copy of ${bot.name}`, extra: { copyLinkId: link._id, botName: `Copy: ${bot.name}` },
  });
  await db.copyPositions.insert({ linkId: link._id, followerId: follower._id, leaderBotId: bot._id, leaderName: bot.name, symbol: bot.symbol, exchange: link.exchange || bot.exchange || 'binance', mode: link.mode, qty: fill.qty, cost: fill.cost, entry: fill.price, openedAt: Date.now() });
  notify(follower._id, { type: 'trade', title: `Copied ${bot.name}`, body: `Bought ${fill.qty.toFixed(6)} ${bot.symbol} @ ${fill.price.toFixed(4)} (${link.mode})`, important: link.mode === 'live' });
}

export async function closeCopyPosition(cp, reason) {
  const follower = await getUser(cp.followerId);
  const { fill, trade } = await executeOrder({
    user: follower, mode: cp.mode, exchange: cp.exchange, symbol: cp.symbol, side: 'SELL', quantity: cp.qty,
    reason, extra: { copyLinkId: cp.linkId, botName: `Copy: ${cp.leaderName}` },
  });
  const pnl = fill.cost - cp.cost;
  await db.trades.update(trade._id, { pnl, pnlPct: (pnl / cp.cost) * 100 });
  await db.copyPositions.remove(cp._id);
  const link = await db.copyLinks.findOne({ _id: cp.linkId });
  if (link) await db.copyLinks.update(link._id, { stats: { trades: (link.stats?.trades || 0) + 1, wins: (link.stats?.wins || 0) + (pnl > 0 ? 1 : 0), pnl: (link.stats?.pnl || 0) + pnl } });
  notify(follower._id, { type: pnl >= 0 ? 'profit' : 'loss', title: `Copy of ${cp.leaderName} closed`, body: `PnL ${pnl.toFixed(2)} USDT · ${reason}`, important: cp.mode === 'live' });
  return pnl;
}

export function startCopyEngine() {
  events.on('copy:open', async ({ bot, notional, equity }) => {
    const fraction = equity > 0 ? notional / equity : 0;
    if (!(fraction > 0)) return;
    const links = await db.copyLinks.find({ leaderBotId: bot._id, active: true });
    for (const link of links) await followerOpen(link, bot, fraction).catch((err) => notify(link.followerId, { type: 'warn', title: `Copy of ${bot.name} failed`, body: err.message }));
  });
  events.on('copy:close', async ({ bot, reason }) => {
    const positions = await db.copyPositions.find({ leaderBotId: bot._id });
    for (const cp of positions) await closeCopyPosition(cp, `Leader exit: ${reason}`).catch((err) => notify(cp.followerId, { type: 'warn', title: `Copy exit failed (${cp.symbol})`, body: `${err.message} - close it manually`, important: true }));
  });
  // A follower's kill switch also closes their copy positions.
  events.on('killswitch', async ({ userId }) => {
    for (const cp of await db.copyPositions.find({ followerId: userId })) await closeCopyPosition(cp, 'Kill switch').catch(() => {});
  });
}

export async function leaderboard() {
  const bots = await db.bots.find({ copyable: true });
  const rows = [];
  for (const b of bots) {
    const owner = await getUser(b.userId);
    const followers = await db.copyLinks.count({ leaderBotId: b._id, active: true });
    const closed = (await db.trades.find({ botId: b._id })).filter((t) => t.pnl !== undefined);
    const ret = closed.reduce((s, t) => s + t.pnlPct, 0);
    rows.push({
      botId: b._id, name: b.name, symbol: b.symbol, interval: b.interval, strategy: b.strategy, exchange: b.exchange || 'binance', mode: b.mode, status: b.status,
      leader: owner?.displayName || owner?.name || 'Trader', description: b.copyDescription || '',
      followers, trades: closed.length, winRate: closed.length ? +((closed.filter((t) => t.pnl > 0).length / closed.length) * 100).toFixed(1) : 0,
      totalReturnPct: +ret.toFixed(2), pnl: +(b.stats?.pnl || 0).toFixed(2), since: b.createdAt,
    });
  }
  return rows.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
}
