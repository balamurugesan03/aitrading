// Options API: chain, strategy preview, trading, positions, account and option bots (NSE index options via Zerodha).
import { Router } from 'express';
import { db } from '../db/index.js';
import { UNDERLYINGS, chain } from '../exchange/nfo.js';
import { TEMPLATES } from '../options/strategies.js';
import { previewTrade, openTrade, closeTrade, markPosition, optionsAccount, resetOptionsPaper, OPTION_DEFAULTS } from '../options/service.js';
import { OPTION_BOT_DEFAULTS, startOptionBot, stopOptionBot } from '../options/bot.js';
import { getSettings } from '../bot/safety.js';
import { audit } from '../notify.js';
import { requireFeature, assertBotSlot, assertFeature } from '../billing/plans.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status && err.status !== 401 ? err.status : 400).json({ error: err.message, code: err.code, preview: err.preview }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
r.use('/options', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' })));
const modeOf = (m) => (m === 'live' ? 'live' : 'paper');
const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));

r.get('/options/meta', (_req, res) => res.json({
  underlyings: Object.values(UNDERLYINGS).map((u) => ({ id: u.name, label: u.label })),
  templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, ...t })), defaults: OPTION_DEFAULTS, botDefaults: OPTION_BOT_DEFAULTS,
  note: 'Defined-risk strategies only: every sold option must be covered by a bought one. Options cannot be backtested here because Kite does not provide prices of expired contracts.',
}));

r.get('/options/chain', wrap(async (req, res) => {
  res.json(await chain(String(req.query.underlying || 'NIFTY').toUpperCase(), req.query.expiry ? String(req.query.expiry) : undefined, { strikes: num(req.query.strikes, 12, 4, 30) }));
}));

const tradeReq = (b) => ({
  mode: modeOf(b.mode), underlying: String(b.underlying || 'NIFTY').toUpperCase(), expiry: b.expiry ? String(b.expiry) : undefined,
  template: b.legs?.length ? undefined : String(b.template || 'bull_call_spread'), legs: b.legs, width: num(b.width, 2, 1, 10), distance: num(b.distance, 4, 1, 20),
  lots: b.lots === 'auto' || b.lots === undefined ? 'auto' : num(b.lots, 1, 1, 50),
  risk: { riskPct: num(b.riskPct, OPTION_DEFAULTS.riskPct, 0.1, 5) }, tpPct: num(b.tpPct, OPTION_DEFAULTS.tpPct, 5, 100), slPct: num(b.slPct, OPTION_DEFAULTS.slPct, 5, 100), autoManage: b.autoManage !== false,
});

r.post('/options/preview', wrap(async (req, res) => res.json(await previewTrade(req.user, tradeReq(req.body || {})))));
r.post('/options/trade', requireFeature('options'), wrap(async (req, res) => {
  if (req.body?.mode === 'live') await assertFeature(req.user, 'liveTrading');
  const out = await openTrade(req.user, tradeReq(req.body || {}), { reason: 'Manual' });
  res.json(out.position);
}));

r.get('/options/positions', wrap(async (req, res) => {
  const filter = { userId: req.user._id, mode: modeOf(req.query.mode) };
  const rows = (await db.optionPositions.find(filter, { sort: { openedAt: -1 }, limit: 200 }));
  const out = [];
  for (const p of rows) {
    if (p.status === 'open') out.push({ ...p, live: await markPosition(p).catch(() => null) });
    else out.push(p);
  }
  res.json(out);
}));
r.post('/options/positions/:id/close', wrap(async (req, res) => res.json(await closeTrade(req.user, req.params.id, 'Manual close'))));
r.patch('/options/positions/:id', wrap(async (req, res) => {
  const p = await db.optionPositions.findOne({ _id: req.params.id });
  if (!p || p.userId !== req.user._id) throw bad('Position not found', 404);
  const patch = {};
  if (req.body?.tpPct !== undefined) patch.tpPct = num(req.body.tpPct, p.tpPct, 5, 100);
  if (req.body?.slPct !== undefined) patch.slPct = num(req.body.slPct, p.slPct, 5, 100);
  if (req.body?.autoManage !== undefined) patch.autoManage = Boolean(req.body.autoManage);
  res.json(await db.optionPositions.update(p._id, patch));
}));

r.get('/options/account', wrap(async (req, res) => res.json(await optionsAccount(req.user, modeOf(req.query.mode)))));
r.post('/options/paper/reset', wrap(async (req, res) => {
  const w = await resetOptionsPaper(req.user._id, req.body?.amount ? num(req.body.amount, 500000, 10000, 1e9) : undefined);
  await audit(req.user._id, 'options.paper_reset', { amount: w.balances.INR }, req);
  res.json(w);
}));

// ---- Option bots ----
const BOT_FIELDS = Object.keys(OPTION_BOT_DEFAULTS).concat('name');
function pickBot(body) {
  const out = {};
  for (const k of BOT_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (out.underlying && !UNDERLYINGS[String(out.underlying).toUpperCase()]) throw bad('Underlying must be NIFTY or BANKNIFTY');
  if (out.underlying) out.underlying = String(out.underlying).toUpperCase();
  if (out.mode !== undefined) out.mode = modeOf(out.mode);
  if (out.template !== undefined && out.template !== 'auto' && !TEMPLATES[out.template]) throw bad('Unknown strategy');
  if (out.directional !== undefined && !['spread', 'single'].includes(out.directional)) throw bad('directional must be spread or single');
  if (out.interval !== undefined && !['5m', '15m', '30m', '1h'].includes(out.interval)) throw bad('Timeframe must be 5m, 15m, 30m or 1h');
  const nums = { threshold: [10, 80], width: [1, 10], distance: [1, 20], riskPct: [0.1, 5], tpPct: [5, 100], slPct: [5, 100], minDte: [0.5, 30], maxDte: [1, 60], minPop: [0, 0.95], condorMinIv: [0, 100] };
  for (const [k, [lo, hi]] of Object.entries(nums)) if (out[k] !== undefined) out[k] = num(out[k], OPTION_BOT_DEFAULTS[k], lo, hi);
  if (out.name !== undefined) out.name = String(out.name).slice(0, 40);
  if (out.requireEdge !== undefined) out.requireEdge = Boolean(out.requireEdge);
  return out;
}
async function ownBot(req) {
  const b = await db.optionBots.findOne({ _id: req.params.id });
  if (!b || b.userId !== req.user._id) throw bad('Bot not found', 404);
  return b;
}
r.get('/options/bots', wrap(async (req, res) => res.json(await db.optionBots.find({ userId: req.user._id }, { sort: { createdAt: -1 } }))));
r.post('/options/bots', requireFeature('options'), wrap(async (req, res) => {
  await assertBotSlot(req.user);
  const data = { ...OPTION_BOT_DEFAULTS, ...pickBot(req.body || {}) };
  if (!data.name) data.name = `${data.underlying} ${data.template === 'auto' ? 'AI Options' : TEMPLATES[data.template].name}`;
  const b = await db.optionBots.insert({ ...data, userId: req.user._id, status: 'stopped', stats: { trades: 0, wins: 0, pnl: 0 } });
  await audit(req.user._id, 'options.bot_create', { name: b.name, mode: b.mode }, req);
  res.json(b);
}));
r.patch('/options/bots/:id', wrap(async (req, res) => {
  const b = await ownBot(req);
  res.json(await db.optionBots.update(b._id, pickBot(req.body || {})));
}));
r.post('/options/bots/:id/start', requireFeature('options'), wrap(async (req, res) => {
  const b = await ownBot(req);
  if (b.mode === 'live') await assertFeature(req.user, 'liveTrading');
  if (!(await getSettings(req.user._id)).tradingEnabled) throw bad('Auto-trading is disabled by the kill switch');
  const u = await db.optionBots.update(b._id, { status: 'running', startedAt: Date.now() });
  startOptionBot(b._id);
  await audit(req.user._id, 'options.bot_start', { name: b.name, mode: b.mode }, req);
  res.json(u);
}));
r.post('/options/bots/:id/stop', wrap(async (req, res) => {
  const b = await ownBot(req);
  stopOptionBot(b._id);
  res.json(await db.optionBots.update(b._id, { status: 'stopped' }));
}));
r.delete('/options/bots/:id', wrap(async (req, res) => {
  const b = await ownBot(req);
  if ((await db.optionPositions.find({ botId: b._id })).some((p) => p.status === 'open')) throw bad('Close the bot\'s open position first');
  stopOptionBot(b._id);
  await db.optionBots.remove(b._id);
  res.json({ ok: true });
}));

export default r;
