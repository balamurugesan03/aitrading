// Core trading API. Every route is scoped to the signed-in user (req.user).
import { Router } from 'express';
import { db, dbKind } from '../db/index.js';
import { hasClaude, config } from '../config.js';
import { ex, fetchCandles, listExchanges, EXCHANGES, isFx, accountOf } from '../exchange/index.js';
import { walletFor } from '../bot/paperBroker.js';
import { computeAll } from '../ai/indicators.js';
import { analyze, STRATEGIES } from '../ai/analyzer.js';
import { regimeSeries } from '../ai/regime.js';
import { getFearGreed } from '../ai/sentiment.js';
import { streamAssistant } from '../ai/claude.js';
import { supportResistance } from '../ai/patterns.js';
import { analyzeOrderFlow } from '../ai/orderflow.js';
import { analyzeFutures } from '../ai/futures.js';
import { getNews, newsForAsset, getCalendar, macroEventRisk } from '../ai/news.js';
import { scanMarket } from '../ai/scanner.js';
import { listStrategies, getStrategy } from '../ai/strategies.js';
import { valuePortfolio, portfolioIntelligence } from '../ai/portfolio.js';
import { journalInsights } from '../ai/journal.js';
import { trainCandidate, evaluateModel, promoteModel, learningReport, evaluatePendingSignals } from '../ai/modelRegistry.js';
import { activeParams } from '../ai/mlModel.js';
import { baseAsset } from '../ai/util.js';
import { BOT_DEFAULTS, startBot, stopBot, closeBotPosition, executeOrder, killSwitch, resumeTrading } from '../bot/engine.js';
import { evaluateRisk, accountState } from '../bot/riskEngine.js';
import { getSettings, updateSettings, health } from '../bot/safety.js';
import { resetPaperWallet } from '../bot/paperBroker.js';
import { runBacktest, benchmarkStrategies } from '../backtest/backtester.js';
import { requireAdmin } from '../auth/middleware.js';
import { audit } from '../notify.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message, checks: err.checks, code: err.code }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
r.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' })));

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9&-]{0,19}$/; // crypto pairs, NSE forex pairs and NSE stocks (M&M, BAJAJ-AUTO)
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
const sym = (s) => {
  const v = String(s || 'BTCUSDT').toUpperCase();
  if (!SYMBOL_RE.test(v)) throw bad('Invalid symbol');
  return v;
};
const intv = (s) => (INTERVALS.includes(s) ? s : '1h');
const modeOf = (m) => (m === 'live' ? 'live' : 'paper');
const exOf = (e) => (EXCHANGES[e] ? e : 'binance');
const uid = (req) => req.user._id;


// ---------- System, settings, emergency ----------
r.get('/status', wrap(async (req, res) => {
  const s = await getSettings(uid(req));
  res.json({
    claude: hasClaude(), claudeModel: config.claudeModel, db: dbKind, exchanges: listExchanges(),
    strategies: Object.fromEntries(listStrategies(uid(req)).map((x) => [x.id, x.name])), intervals: INTERVALS,
    tradingEnabled: s.tradingEnabled, killSwitchAt: s.killSwitchAt, killSwitchReason: s.killSwitchReason, platformHalt: s.platformHalt,
    health, modelVersion: activeParams.version, binance: { keys: Boolean(config.binance.apiKey), testnet: config.binance.testnet },
  });
}));

r.get('/settings', wrap(async (req, res) => res.json(await getSettings(uid(req)))));
r.patch('/settings', wrap(async (req, res) => {
  const clean = {};
  for (const [k, v] of Object.entries(req.body?.risk || {})) {
    if (k === 'minQuality') { if (['A', 'B', 'C', 'D'].includes(v)) clean[k] = v; continue; }
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) clean[k] = n;
  }
  await audit(uid(req), 'risk.update', clean, req);
  res.json(await updateSettings(uid(req), { risk: clean }));
}));

r.post('/killswitch', wrap(async (req, res) => {
  await audit(uid(req), 'safety.killswitch', {}, req);
  res.json(await killSwitch(uid(req), String(req.body?.reason || 'Manual kill switch').slice(0, 200)));
}));
r.post('/trading/resume', wrap(async (req, res) => {
  await resumeTrading(uid(req));
  await audit(uid(req), 'safety.resume', {}, req);
  res.json(await getSettings(uid(req)));
}));

// ---------- Market ----------
r.get('/market/exchanges', (_req, res) => res.json(listExchanges()));
r.get('/market/tickers', wrap(async (req, res) => {
  const symbols = req.query.symbols ? String(req.query.symbols).split(',').map(sym) : undefined;
  res.json(await ex(exOf(req.query.exchange)).getTickers(symbols));
}));

r.get('/market/top', wrap(async (req, res) => {
  const STABLE = /^(USDC|USD1|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|XUSD|RLUSD|USDE|PAXG)/;
  const e = exOf(req.query.exchange);
  const all = await ex(e).getTickers();
  if (isFx(e)) return res.json(all.sort((a, b) => b.volume - a.volume).slice(0, Number(req.query.limit || 50))); // NSE forex pairs / stock watch list
  res.json(all.filter((t) => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol) && !STABLE.test(t.symbol.slice(0, -4)) && t.volume > 0)
    .sort((a, b) => b.volume - a.volume).slice(0, Number(req.query.limit || 50)));
}));

r.get('/market/klines', wrap(async (req, res) => {
  const candles = await fetchCandles(exOf(req.query.exchange), sym(req.query.symbol), intv(req.query.interval), Math.min(1000, Number(req.query.limit || 500)));
  const ind = computeAll(candles);
  res.json({
    candles,
    overlays: { ema9: ind.ema9, ema21: ind.ema21, ema50: ind.ema50, ema200: ind.ema200, bbUpper: ind.bb.upper, bbLower: ind.bb.lower, bbMid: ind.bb.mid },
    oscillators: { rsi: ind.rsi, macd: ind.macd.line, macdSignal: ind.macd.signal, macdHist: ind.macd.hist },
    levels: supportResistance(candles),
    regimes: regimeSeries(candles, ind).map((x) => x?.regime || null),
  });
}));

r.get('/market/orderbook', wrap(async (req, res) => res.json(await ex(exOf(req.query.exchange)).getOrderBook(sym(req.query.symbol), 15))));
r.get('/market/orderflow', wrap(async (req, res) => res.json(await analyzeOrderFlow(sym(req.query.symbol), exOf(req.query.exchange)))));
r.get('/market/futures', wrap(async (req, res) => res.json(await analyzeFutures(sym(req.query.symbol)))));
r.get('/market/news', wrap(async (req, res) => {
  const items = await getNews({ force: req.query.refresh === '1' });
  const asset = req.query.asset ? String(req.query.asset).toUpperCase() : null;
  res.json({ items: asset ? items.filter((x) => x.assets.includes(asset)) : items, summary: await newsForAsset(asset || 'BTC') });
}));
r.get('/market/calendar', wrap(async (_req, res) => res.json({ events: await getCalendar(), risk: await macroEventRisk() })));
r.get('/market/symbols', wrap(async (req, res) => {
  const e = exOf(req.query.exchange);
  const quote = String(req.query.quote || ex(e).currency || 'USDT').toUpperCase();
  res.json((await ex(e).getSymbols()).filter((s) => s.quote === quote).map((s) => s.symbol));
}));
r.get('/market/sentiment', wrap(async (_req, res) => res.json(await getFearGreed())));

// ---------- AI ----------
r.post('/ai/analyze', wrap(async (req, res) => {
  const { symbol, interval, strategy = 'adaptive', useClaude = false, mode = 'paper', threshold = 30, exchange, allowShort = false } = req.body || {};
  const e = exOf(exchange);
  const signal = await analyze(sym(symbol), intv(interval), { strategy: getStrategy(strategy) ? strategy : 'adaptive', useClaude, forceClaude: useClaude, threshold: Number(threshold), exchange: e, allowShort: Boolean(allowShort) });
  signal.risk = await evaluateRisk(signal, { user: req.user, mode: modeOf(mode), exchange: e }).catch((err) => ({ decision: 'ERROR', error: err.message, steps: [], gates: [] }));
  res.json(signal);
}));

r.post('/ai/scan', wrap(async (req, res) => {
  const b = req.body || {};
  const cap = 150;
  res.json(await scanMarket({
    interval: intv(b.interval || '1h'), universe: Math.min(cap, Number(b.universe || 100)), exchange: exOf(b.exchange),
    minVolumeUsd: Number(b.minVolumeUsd || 5e6), symbols: (b.symbols || []).slice(0, cap).map(sym), strategy: getStrategy(b.strategy) ? b.strategy : 'adaptive',
  }));
}));

r.post('/ai/chat', async (req, res) => {
  const { history = [], message, symbol, interval, exchange } = req.body || {};
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    let marketContext = null;
    if (symbol) {
      try {
        const a = await analyze(sym(symbol), intv(interval), { exchange: exOf(exchange) });
        marketContext = {
          symbol: a.symbol, exchange: a.exchange, interval: a.interval, price: a.price, signal: a.signal, probability: a.probability,
          expectedReturnPct: a.expectedReturnPct, expectedRiskPct: a.expectedRiskPct, rr: a.rr, quality: a.quality,
          regime: a.regime && { label: a.regime.label, description: a.regime.description }, strategy: a.strategyName,
          models: a.components, indicators: a.indicators, levels: a.levels,
          orderFlow: a.orderFlow && { score: a.orderFlow.score, buyPressure: a.orderFlow.buyPressure, imbalance: a.orderFlow.imbalance },
          futures: a.futures?.available ? { funding: a.futures.fundingRatePct, oiChange: a.futures.oiChange24hPct, longShort: a.futures.longShortRatio, relationship: a.futures.relationship, risks: a.futures.risks } : null,
          news: a.news && { sentiment: a.news.sentiment, impact: a.news.impact, headlines: a.news.headlines.slice(0, 5).map((h) => h.title) },
          fearGreed: a.sentiment,
        };
      } catch { /* answer without context */ }
    }
    const cleanHistory = history.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content).slice(-20);
    await streamAssistant({ history: cleanHistory, userMessage: String(message || ''), marketContext, onText: (t) => send('text', t) });
    send('done', {});
  } catch (err) {
    send('error', { error: err.message });
  }
  res.end();
});

// ---------- Strategy library ----------
r.get('/strategies', wrap(async (req, res) => {
  const stats = (await db.strategyStats.find({}, { sort: { time: -1 }, limit: 1 }))[0] || null;
  res.json({ strategies: listStrategies(uid(req)), benchmark: stats });
}));
r.post('/strategies/benchmark', wrap(async (req, res) => {
  const b = req.body || {};
  const result = await benchmarkStrategies({
    symbols: (b.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']).map(sym), intervals: (b.intervals || ['15m', '1h', '4h']).map(intv), candles: Math.min(5000, Number(b.candles || 3000)),
  });
  res.json(await db.strategyStats.insert(result));
}));

// ---------- Bots ----------
const BOT_FIELDS = ['name', 'exchange', 'symbol', 'interval', 'strategy', 'mode', 'useClaude', 'allowShort', 'threshold', 'riskPct', 'maxPositionPct', 'trailingStop', 'trailAtr', 'dailyLossLimitPct', 'dcaEvery', 'dcaTranchePct', 'dcaMaxTranches', 'dcaTakeProfitPct'];
const pickBot = (body, user) => {
  const out = {};
  BOT_FIELDS.forEach((k) => body[k] !== undefined && (out[k] = body[k]));
  if (out.symbol) out.symbol = sym(out.symbol);
  if (out.interval) out.interval = intv(out.interval);
  if (out.exchange !== undefined) {
    if (!EXCHANGES[out.exchange]) throw bad('Unknown exchange');
    if (EXCHANGES[out.exchange].optionsOnly) throw bad('Use Options > Option bots for options');
  }
  if (out.strategy) {
    const st = getStrategy(out.strategy);
    if (!st) throw bad('Unknown strategy');
    if (st.custom && st.ownerId !== user._id) throw bad('That custom strategy belongs to someone else');
  }
  if (out.mode && !['paper', 'live'].includes(out.mode)) throw bad('mode must be paper or live');
  if (out.allowShort !== undefined) {
    out.allowShort = Boolean(out.allowShort);
    const exId = out.exchange || body.exchange || 'binance';
    if (out.allowShort && !EXCHANGES[exId]?.canShort) throw bad(`${EXCHANGES[exId]?.name || exId} cannot be sold short - shorts are available on NSE forex futures`);
  }
  ['threshold', 'riskPct', 'maxPositionPct', 'trailAtr', 'dailyLossLimitPct', 'dcaEvery', 'dcaTranchePct', 'dcaMaxTranches', 'dcaTakeProfitPct'].forEach((k) => out[k] !== undefined && (out[k] = Number(out[k])));
  return out;
};
async function ownBot(req) {
  const bot = await db.bots.findOne({ _id: req.params.id });
  if (!bot || bot.userId !== uid(req)) throw bad('Bot not found', 404);
  return bot;
}

r.get('/bots', wrap(async (req, res) => res.json(await db.bots.find({ userId: uid(req) }, { sort: { createdAt: -1 } }))));

r.post('/bots', wrap(async (req, res) => {
  const data = { ...BOT_DEFAULTS, ...pickBot(req.body || {}, req.user) };
  if (!data.symbol) data.symbol = 'BTCUSDT';
  if (!ex(data.exchange).intervals.includes(data.interval)) throw bad(`${ex(data.exchange).name} does not support ${data.interval}`);
  if (data.strategy === 'grid' && !['15m', '1h', '30m', '4h'].includes(data.interval)) data.interval = '1h';
  if (!data.name) data.name = `${baseAsset(data.symbol)} ${getStrategy(data.strategy).name}`;
  const bot = await db.bots.insert({ ...data, userId: uid(req), status: 'stopped', position: null, stats: { trades: 0, wins: 0, pnl: 0 } });
  await audit(uid(req), 'bot.create', { name: bot.name, mode: bot.mode, exchange: bot.exchange }, req);
  res.json(bot);
}));

r.patch('/bots/:id', wrap(async (req, res) => {
  const bot = await ownBot(req);
  const patch = pickBot(req.body || {}, req.user);
  if (bot.position && (patch.symbol || patch.mode || patch.exchange || patch.strategy)) throw bad('Close the open position before changing symbol, mode, exchange or strategy');
  res.json(await db.bots.update(bot._id, patch));
}));

r.delete('/bots/:id', wrap(async (req, res) => {
  const bot = await ownBot(req);
  if (bot.position) throw bad('Close the open position before deleting the bot');
  if (await db.copyLinks.count({ leaderBotId: bot._id, active: true })) throw bad('Followers are copying this bot - stop sharing it first');
  stopBot(bot._id);
  await audit(uid(req), 'bot.delete', { name: bot.name }, req);
  res.json({ ok: await db.bots.remove(bot._id) });
}));

r.post('/bots/:id/start', wrap(async (req, res) => {
  const bot = await ownBot(req);
  const s = await getSettings(uid(req));
  if (!s.tradingEnabled) throw bad(s.platformHalt ? `Trading is paused platform-wide: ${s.platformHalt}` : 'Auto-trading is disabled by your kill switch. Re-enable trading first.');
  const st = getStrategy(bot.strategy);
  if (st?.liveOnly && !hasClaude()) throw bad('This strategy needs ANTHROPIC_API_KEY on the server');
  const updated = await db.bots.update(bot._id, { status: 'running', lastCandleTime: null, pausedReason: null });
  startBot(bot._id);
  await audit(uid(req), 'bot.start', { name: bot.name, mode: bot.mode }, req);
  res.json(updated);
}));

r.post('/bots/:id/stop', wrap(async (req, res) => {
  const bot = await ownBot(req);
  stopBot(bot._id);
  await audit(uid(req), 'bot.stop', { name: bot.name }, req);
  res.json(await db.bots.update(bot._id, { status: 'stopped' }));
}));

r.post('/bots/:id/close', wrap(async (req, res) => {
  await closeBotPosition(req.params.id, uid(req));
  res.json(await db.bots.findOne({ _id: req.params.id }));
}));

r.get('/logs', wrap(async (req, res) => {
  const filter = { userId: uid(req) };
  if (req.query.botId) filter.botId = String(req.query.botId);
  res.json(await db.logs.find(filter, { sort: { time: -1 }, limit: Math.min(500, Number(req.query.limit || 100)) }));
}));

r.get('/signals', wrap(async (req, res) => {
  const filter = { userId: uid(req) };
  if (req.query.botId) filter.botId = String(req.query.botId);
  res.json(await db.signals.find(filter, { sort: { time: -1 }, limit: Math.min(200, Number(req.query.limit || 50)) }));
}));

// ---------- Risk manager ----------
r.get('/risk/overview', wrap(async (req, res) => {
  const mode = modeOf(req.query.mode);
  const e = exOf(req.query.exchange);
  const [settings, account, bots] = await Promise.all([getSettings(uid(req)), accountState(req.user, mode, e), db.bots.find({ userId: uid(req) })]);
  res.json({ mode, exchange: e, settings, account, health, bots: bots.map((b) => ({ _id: b._id, name: b.name, symbol: b.symbol, exchange: b.exchange, mode: b.mode, status: b.status, strategy: b.strategy, position: b.position, stats: b.stats, pausedReason: b.pausedReason, lastSignal: b.lastSignal })) });
}));

// ---------- Trading & portfolio ----------
r.get('/trades', wrap(async (req, res) => {
  const filter = { userId: uid(req) };
  if (req.query.mode) filter.mode = String(req.query.mode);
  if (req.query.botId) filter.botId = String(req.query.botId);
  res.json(await db.trades.find(filter, { sort: { time: -1 }, limit: Math.min(1000, Number(req.query.limit || 200)) }));
}));

r.post('/trade', wrap(async (req, res) => {
  const { symbol, side, mode = 'paper', quoteAmount, quantity, exchange, short = false } = req.body || {};
  if (!['BUY', 'SELL'].includes(side)) throw bad('side must be BUY or SELL');
  // short=true: SELL opens a short (quoteAmount), BUY covers it (quantity). Otherwise BUY opens a long, SELL closes it.
  const opening = short ? side === 'SELL' : side === 'BUY';
  if (short && !ex(exOf(exchange)).canShort) throw bad(`${ex(exOf(exchange)).name} cannot be sold short`);
  if (opening && !(quoteAmount > 0)) throw bad('quoteAmount required to open a position');
  if (!opening && !(quantity > 0)) throw bad('quantity required to close a position');
  const s = await getSettings(uid(req));
  if (!s.tradingEnabled && opening) throw bad('Trading is disabled by the kill switch');
  const e = exOf(exchange);
  if (ex(e).optionsOnly) throw bad('Options are traded from the Options page as defined-risk strategies');
  const { trade } = await executeOrder({ user: req.user, mode: modeOf(mode), exchange: e, symbol: sym(symbol), side, quoteAmount: Number(quoteAmount), quantity: Number(quantity), short: Boolean(short), reason: short ? (opening ? 'Manual short' : 'Manual cover') : 'Manual order' });
  await audit(uid(req), 'trade.manual', { symbol: trade.symbol, side, mode: trade.mode, exchange: e, value: trade.cost }, req);
  res.json(trade);
}));

r.get('/portfolio', wrap(async (req, res) => {
  const mode = modeOf(req.query.mode);
  const e = exOf(req.query.exchange);
  const account = accountOf(e);
  const pf = await valuePortfolio(req.user, mode, e);
  const closed = (await db.trades.find({ mode, userId: uid(req) })).filter((t) => t.pnl !== undefined && accountOf(t.exchange) === account);
  res.json({
    ...pf, account, startBalance: mode === 'paper' ? walletFor(e).start() : null,
    realizedPnl: closed.reduce((s, t) => s + t.pnl, 0),
    winRate: closed.length ? (closed.filter((t) => t.pnl > 0).length / closed.length) * 100 : 0,
    closedTrades: closed.length,
  });
}));

r.get('/portfolio/ai', wrap(async (req, res) => res.json(await portfolioIntelligence(req.user, modeOf(req.query.mode), exOf(req.query.exchange)))));

r.get('/equity', wrap(async (req, res) => {
  const account = accountOf(exOf(req.query.exchange));
  const rows = (await db.equity.find({ mode: modeOf(req.query.mode), userId: uid(req) }, { sort: { time: 1 } })).filter((e) => (e.account || 'crypto') === account);
  res.json(rows.slice(-2000).map((e) => ({ time: Math.floor(e.time / 1000), value: e.value })));
}));

r.post('/portfolio/reset', wrap(async (req, res) => {
  // Resets one paper account: crypto (USDT), NSE forex or NSE stocks (INR), chosen by `exchange`. The others are untouched.
  const userId = uid(req);
  const e = exOf(req.body?.exchange);
  const account = accountOf(e);
  const fx = account !== 'crypto';
  const same = (exchange) => accountOf(exchange) === account;
  const paperBots = (await db.bots.find({ userId, mode: 'paper' })).filter((b) => same(b.exchange));
  if (paperBots.some((b) => b.status === 'running')) throw bad('Stop the paper bots of this account before resetting');
  for (const b of paperBots) await db.bots.update(b._id, { position: null, grid: null, stats: { trades: 0, wins: 0, pnl: 0 } });
  if (!fx) for (const cp of await db.copyPositions.find({ followerId: userId, mode: 'paper' })) await db.copyPositions.remove(cp._id);
  const amount = Number(req.body?.amount) || walletFor(e).start();
  if (req.body?.clearHistory) {
    const paperBotIds = new Set(paperBots.map((b) => b._id));
    for (const t of await db.trades.find({ userId, mode: 'paper' })) if (same(t.exchange)) await db.trades.remove(t._id);
    for (const j of await db.journal.find({ userId, mode: 'paper' })) if (same(j.exchange)) await db.journal.remove(j._id);
    for (const q of await db.equity.find({ userId, mode: 'paper' })) if ((q.account || 'crypto') === account) await db.equity.remove(q._id);
    for (const sg of await db.signals.find({ userId })) if (!sg.botId || paperBotIds.has(sg.botId)) await db.signals.remove(sg._id);
    for (const l of await db.logs.find({ userId })) if (!l.botId || paperBotIds.has(l.botId)) await db.logs.remove(l._id);
  }
  const s = await getSettings(userId);
  await updateSettings(userId, { peakEquity: { ...s.peakEquity, [{ crypto: 'paper', fx: 'paperFx', stocks: 'paperStocks' }[account]]: amount } });
  await audit(userId, 'paper.reset', { amount, clearHistory: Boolean(req.body?.clearHistory) }, req);
  res.json(await resetPaperWallet(userId, amount, e));
}));

// ---------- Backtesting ----------
r.post('/backtest', wrap(async (req, res) => {
  const b = req.body || {};
  const strategy = getStrategy(b.strategy) ? b.strategy : 'adaptive';
  const st = getStrategy(strategy);
  if (st.custom && st.ownerId !== uid(req)) throw bad('That custom strategy belongs to someone else');
  const list = (v, d) => (Array.isArray(v) && v.length ? v : d);
  const result = await runBacktest({
    symbols: list(b.symbols, [b.symbol || 'BTCUSDT']).map(sym),
    intervals: list(b.intervals, [b.interval || '1h']).map(intv),
    candles: Math.min(20000, Math.max(800, Number(b.candles || 3000))),
    strategy, threshold: Number(b.threshold || 30),
    split: { train: Number(b.trainPct || 70), validation: Number(b.validationPct || 15), oos: 100 - Number(b.trainPct || 70) - Number(b.validationPct || 15) },
    optimize: Boolean(b.optimize), walkForwardFolds: Math.min(8, Number(b.walkForwardFolds ?? 4)), monteCarloRuns: Math.min(5000, Number(b.monteCarloRuns || 1000)),
    startBalance: Number(b.startBalance || (accountOf(exOf(b.exchange)) === 'crypto' ? 10000 : walletFor(exOf(b.exchange)).start())), riskPct: Number(b.riskPct || 1), maxPositionPct: Number(b.maxPositionPct || 25), trailingStop: b.trailingStop !== false,
    exchange: exOf(b.exchange),
    ...(b.feePct != null && { feeRate: Number(b.feePct) / 100 }), ...(b.slippageBps != null && { slippageBps: Number(b.slippageBps) }), ...(b.spreadBps != null && { spreadBps: Number(b.spreadBps) }),
    latencyBars: Number(b.latencyBars ?? 1), fundingRatePct8h: Number(b.fundingRatePct8h ?? 0), allowShort: Boolean(b.allowShort), // shorts only where the exchange can sell first
  });
  await db.backtests.insert({
    userId: uid(req),
    params: { symbols: result.params.symbols, intervals: result.params.intervals, strategy: result.params.strategy, optimize: result.params.optimize },
    summary: { ...result.summary, best: result.summary.best ? { symbol: result.summary.best.symbol, interval: result.summary.best.interval } : null },
    results: result.results.map((x) => ({ symbol: x.symbol, interval: x.interval, error: x.error, oos: x.segments?.outOfSample && { totalReturnPct: x.segments.outOfSample.totalReturnPct, buyHoldReturnPct: x.segments.outOfSample.buyHoldReturnPct, winRate: x.segments.outOfSample.winRate, trades: x.segments.outOfSample.trades, maxDrawdownPct: x.segments.outOfSample.maxDrawdownPct } })),
    time: Date.now(),
  });
  res.json(result);
}));

r.get('/backtests', wrap(async (req, res) => res.json(await db.backtests.find({ userId: uid(req) }, { sort: { time: -1 }, limit: 30 }))));

// ---------- Journal ----------
r.get('/journal', wrap(async (req, res) => res.json(await db.journal.find({ userId: uid(req) }, { sort: { time: -1 }, limit: Math.min(500, Number(req.query.limit || 100)) }))));
r.get('/journal/insights', wrap(async (req, res) => res.json(await journalInsights(uid(req)))));

// ---------- Learning loop / model registry (models are platform-wide, managed by admins) ----------
r.get('/learning', wrap(async (req, res) => res.json({ ...(await learningReport(uid(req))), canManageModels: req.user.role === 'admin' })));
r.post('/signals/evaluate', wrap(async (_req, res) => res.json({ resolved: await evaluatePendingSignals() })));
r.post('/models/train', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const m = await trainCandidate({
    symbols: (b.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']).slice(0, 5).map(sym), interval: intv(b.interval || '1h'),
    candles: Math.min(5000, Number(b.candles || 3000)), hidden: Math.min(64, Math.max(4, Number(b.hidden || 16))),
    epochs: Math.min(150, Math.max(10, Number(b.epochs || 60))), lr: Number(b.lr || 0.01), horizon: Math.min(24, Math.max(1, Number(b.horizon || 3))), name: b.name,
  });
  await audit(uid(req), 'model.train', { name: m.name }, req);
  res.json(m);
}));
r.post('/models/:id/evaluate', requireAdmin, wrap(async (req, res) => res.json(await evaluateModel(req.params.id))));
r.post('/models/:id/promote', requireAdmin, wrap(async (req, res) => {
  const { status, override = false, note = '' } = req.body || {};
  const m = await promoteModel(req.params.id, status, { approvedBy: req.user.email, override: Boolean(override), note: String(note).slice(0, 300) });
  await audit(uid(req), 'model.promote', { model: m.name, status, override: Boolean(override) }, req);
  res.json(m);
}));

export default r;
