// Copy trading + strategy builder (custom strategies) + strategy marketplace.
import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { registerCustomStrategy, unregisterCustomStrategy, getStrategy } from '../ai/strategies.js';
import { MODEL_LABELS } from '../ai/models.js';
import { REGIMES } from '../ai/regime.js';
import { benchmarkStrategy } from '../backtest/backtester.js';
import { leaderboard, closeCopyPosition } from '../bot/copyEngine.js';
import { EXCHANGES } from '../exchange/index.js';
import { audit, notify } from '../notify.js';
import { requireFeature, assertFeature } from '../billing/plans.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
r.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' })));

const MODEL_KEYS = ['trend', 'momentum', 'meanReversion', 'volatility', 'regime', 'flow', 'pattern', 'ml', 'sentiment', 'htf'];

function cleanStrategy(b) {
  const weights = {};
  for (const k of MODEL_KEYS) {
    const v = Number(b.weights?.[k] || 0);
    if (v > 0) weights[k] = Math.min(1, v);
  }
  if (!Object.keys(weights).length) throw bad('Give at least one model a weight');
  const sl = Math.min(6, Math.max(0.5, Number(b.sl) || 2));
  const tp = Math.min(12, Math.max(0.5, Number(b.tp) || 3));
  return {
    name: String(b.name || 'My strategy').slice(0, 40), description: String(b.description || '').slice(0, 300), weights, sl, tp,
    regimes: (b.regimes || []).filter((x) => REGIMES[x]), blocked: (b.blocked?.length ? b.blocked : ['BEAR_TREND', 'BREAKDOWN', 'PANIC']).filter((x) => REGIMES[x]),
    timeframes: (b.timeframes || []).filter((x) => ['1m', '5m', '15m', '1h', '4h', '1d'].includes(x)),
  };
}

// ---------- Strategy builder ----------
r.get('/strategies/models', (_req, res) => res.json({ models: MODEL_KEYS.map((k) => ({ id: k, label: MODEL_LABELS[k] })), regimes: Object.entries(REGIMES).map(([id, v]) => ({ id, label: v.label })) }));
r.get('/strategies/custom', wrap(async (req, res) => res.json(await db.customStrategies.find({ userId: req.user._id }, { sort: { createdAt: -1 } }))));
r.post('/strategies/custom', wrap(async (req, res) => {
  const doc = await db.customStrategies.insert({ ...cleanStrategy(req.body || {}), id: `custom_${crypto.randomBytes(5).toString('hex')}`, userId: req.user._id });
  registerCustomStrategy(doc);
  await audit(req.user._id, 'strategy.create', { name: doc.name }, req);
  res.json(doc);
}));
r.put('/strategies/custom/:id', wrap(async (req, res) => {
  const doc = await db.customStrategies.findOne({ id: req.params.id });
  if (!doc || doc.userId !== req.user._id) throw bad('Not found', 404);
  const updated = await db.customStrategies.update(doc._id, cleanStrategy({ ...doc, ...req.body }));
  registerCustomStrategy(updated);
  res.json(updated);
}));
r.delete('/strategies/custom/:id', wrap(async (req, res) => {
  const doc = await db.customStrategies.findOne({ id: req.params.id });
  if (!doc || doc.userId !== req.user._id) throw bad('Not found', 404);
  if (await db.bots.findOne({ strategy: doc.id })) throw bad('A bot still uses this strategy');
  await db.customStrategies.remove(doc._id);
  unregisterCustomStrategy(doc.id);
  res.json({ ok: true });
}));

// ---------- Marketplace ----------
const listingView = (l, userId) => ({
  ...l, rating: l.ratings?.length ? +(l.ratings.reduce((s, x) => s + x.stars, 0) / l.ratings.length).toFixed(1) : null,
  ratingCount: l.ratings?.length || 0, myRating: l.ratings?.find((x) => x.userId === userId)?.stars || null, ratings: undefined, mine: l.authorId === userId,
});

r.get('/marketplace', wrap(async (req, res) => {
  const rows = await db.listings.find({}, { sort: { createdAt: -1 } });
  res.json(rows.map((l) => listingView(l, req.user._id)));
}));
r.post('/marketplace/publish', wrap(async (req, res) => {
  const doc = await db.customStrategies.findOne({ id: req.body?.strategyId });
  if (!doc || doc.userId !== req.user._id) throw bad('Pick one of your custom strategies');
  if (await db.listings.findOne({ strategyId: doc.id })) throw bad('Already published');
  const stats = await benchmarkStrategy(doc.id);
  const listing = await db.listings.insert({
    strategyId: doc.id, authorId: req.user._id, authorName: req.user.displayName || req.user.name, name: doc.name,
    description: String(req.body?.description || doc.description || '').slice(0, 500),
    config: { weights: doc.weights, sl: doc.sl, tp: doc.tp, regimes: doc.regimes, blocked: doc.blocked, timeframes: doc.timeframes },
    stats, installs: 0, ratings: [],
  });
  await audit(req.user._id, 'marketplace.publish', { name: doc.name }, req);
  res.json(listingView(listing, req.user._id));
}));
r.post('/marketplace/:id/install', wrap(async (req, res) => {
  const l = await db.listings.findOne({ _id: req.params.id });
  if (!l) throw bad('Listing not found', 404);
  const doc = await db.customStrategies.insert({ ...l.config, name: `${l.name} (by ${l.authorName})`, description: l.description, id: `custom_${crypto.randomBytes(5).toString('hex')}`, userId: req.user._id, installedFrom: l._id });
  registerCustomStrategy(doc);
  await db.listings.update(l._id, { installs: (l.installs || 0) + 1 });
  if (l.authorId !== req.user._id) notify(l.authorId, { type: 'info', title: `Someone installed "${l.name}"`, body: `${(l.installs || 0) + 1} installs so far` });
  res.json(doc);
}));
r.post('/marketplace/:id/rate', wrap(async (req, res) => {
  const l = await db.listings.findOne({ _id: req.params.id });
  if (!l) throw bad('Listing not found', 404);
  const stars = Math.min(5, Math.max(1, Math.round(Number(req.body?.stars) || 0)));
  const ratings = [...(l.ratings || []).filter((x) => x.userId !== req.user._id), { userId: req.user._id, stars }];
  res.json(listingView(await db.listings.update(l._id, { ratings }), req.user._id));
}));
r.delete('/marketplace/:id', wrap(async (req, res) => {
  const l = await db.listings.findOne({ _id: req.params.id });
  if (!l) throw bad('Listing not found', 404);
  if (l.authorId !== req.user._id && req.user.role !== 'admin') throw bad('Not your listing', 403);
  await db.listings.remove(l._id);
  res.json({ ok: true });
}));

// ---------- Copy trading ----------
r.get('/copy/leaderboard', wrap(async (req, res) => {
  const rows = await leaderboard();
  const mine = await db.copyLinks.find({ followerId: req.user._id });
  const myBots = new Set((await db.bots.find({ userId: req.user._id })).map((b) => b._id));
  res.json(rows.map((x) => ({ ...x, own: myBots.has(x.botId), following: mine.some((l) => l.leaderBotId === x.botId && l.active) })));
}));

r.patch('/copy/bots/:id', wrap(async (req, res) => {
  const bot = await db.bots.findOne({ _id: req.params.id });
  if (!bot || bot.userId !== req.user._id) throw bad('Bot not found', 404);
  const updated = await db.bots.update(bot._id, { copyable: Boolean(req.body?.copyable), copyDescription: String(req.body?.copyDescription || bot.copyDescription || '').slice(0, 300) });
  await audit(req.user._id, req.body?.copyable ? 'copy.leader_on' : 'copy.leader_off', { bot: bot.name }, req);
  res.json(updated);
}));

r.get('/copy/following', wrap(async (req, res) => {
  const links = await db.copyLinks.find({ followerId: req.user._id }, { sort: { createdAt: -1 } });
  const out = [];
  for (const l of links) {
    const bot = await db.bots.findOne({ _id: l.leaderBotId });
    out.push({ ...l, leader: bot ? { name: bot.name, symbol: bot.symbol, status: bot.status, strategy: bot.strategy } : null, positions: await db.copyPositions.find({ linkId: l._id }) });
  }
  res.json(out);
}));

r.post('/copy/follow', requireFeature('copyTrading'), wrap(async (req, res) => {
  const { leaderBotId, mode = 'paper', multiplier = 1, maxTradeUsd = 0, exchange } = req.body || {};
  if (mode === 'live') await assertFeature(req.user, 'liveTrading');
  const bot = await db.bots.findOne({ _id: leaderBotId });
  if (!bot || !bot.copyable) throw bad('This bot is not open for copying');
  if (bot.userId === req.user._id) throw bad('You cannot copy your own bot');
  const ex = exchange || bot.exchange || 'binance';
  if (!EXCHANGES[ex]) throw bad('Unknown exchange');
  if (await db.copyLinks.findOne({ followerId: req.user._id, leaderBotId, active: true })) throw bad('Already following this bot');
  const link = await db.copyLinks.insert({ followerId: req.user._id, leaderBotId, leaderUserId: bot.userId, mode: mode === 'live' ? 'live' : 'paper', exchange: ex, multiplier: Math.min(5, Math.max(0.1, Number(multiplier) || 1)), maxTradeUsd: Math.max(0, Number(maxTradeUsd) || 0), active: true, stats: { trades: 0, wins: 0, pnl: 0 } });
  await audit(req.user._id, 'copy.follow', { bot: bot.name, mode }, req);
  notify(bot.userId, { type: 'info', title: `New follower on ${bot.name}`, body: `Now ${await db.copyLinks.count({ leaderBotId, active: true })} active follower(s)` });
  res.json(link);
}));

r.patch('/copy/links/:id', wrap(async (req, res) => {
  const l = await db.copyLinks.findOne({ _id: req.params.id });
  if (!l || l.followerId !== req.user._id) throw bad('Not found', 404);
  const patch = {};
  if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body?.multiplier !== undefined) patch.multiplier = Math.min(5, Math.max(0.1, Number(req.body.multiplier) || 1));
  if (req.body?.maxTradeUsd !== undefined) patch.maxTradeUsd = Math.max(0, Number(req.body.maxTradeUsd) || 0);
  res.json(await db.copyLinks.update(l._id, patch));
}));

r.delete('/copy/links/:id', wrap(async (req, res) => {
  const l = await db.copyLinks.findOne({ _id: req.params.id });
  if (!l || l.followerId !== req.user._id) throw bad('Not found', 404);
  const open = await db.copyPositions.find({ linkId: l._id });
  if (open.length && !req.query.closePositions) throw bad(`You hold ${open.length} copied position(s) - close them first or unfollow with "close positions"`);
  for (const cp of open) await closeCopyPosition(cp, 'Unfollowed');
  await db.copyLinks.remove(l._id);
  await audit(req.user._id, 'copy.unfollow', { leaderBotId: l.leaderBotId }, req);
  res.json({ ok: true });
}));

r.post('/copy/positions/:id/close', wrap(async (req, res) => {
  const cp = await db.copyPositions.findOne({ _id: req.params.id });
  if (!cp || cp.followerId !== req.user._id) throw bad('Not found', 404);
  res.json({ pnl: await closeCopyPosition(cp, 'Closed manually') });
}));

export async function loadCustomStrategies() {
  const all = await db.customStrategies.find({});
  all.forEach(registerCustomStrategy);
  return all.length;
}

export { getStrategy };
export default r;
