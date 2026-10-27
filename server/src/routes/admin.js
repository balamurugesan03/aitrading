// Admin panel API.
import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAdmin, publicUser, invalidateUser } from '../auth/middleware.js';
import { getGlobal, updateGlobal, health, DEFAULT_BRANDING } from '../bot/safety.js';
import { killSwitch, stopBot } from '../bot/engine.js';
import { audit, notify } from '../notify.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
r.use('/admin', (req, res, next) => (req.user ? requireAdmin(req, res, next) : res.status(401).json({ error: 'Please sign in' })));

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

r.get('/admin/overview', wrap(async (_req, res) => {
  const [users, bots, trades, logs, models] = await Promise.all([
    db.users.find({}), db.bots.find({}), db.trades.find({}), db.logs.find({ level: 'error' }, { sort: { time: -1 }, limit: 500 }), db.models.find({}),
  ]);
  const today = dayKey(Date.now());
  const g = await getGlobal();
  res.json({
    users: { total: users.length, active: users.filter((u) => u.status !== 'suspended').length, suspended: users.filter((u) => u.status === 'suspended').length, newToday: users.filter((u) => dayKey(u.createdAt) === today).length, with2fa: users.filter((u) => u.totpEnabled).length },
    bots: { total: bots.length, running: bots.filter((b) => b.status === 'running').length, paused: bots.filter((b) => b.status === 'paused').length, live: bots.filter((b) => b.mode === 'live').length, openPositions: bots.filter((b) => b.position).length },
    trades: { total: trades.length, today: trades.filter((t) => dayKey(t.time) === today).length, live: trades.filter((t) => t.mode === 'live').length, volumeUsd: Math.round(trades.reduce((s, t) => s + (t.cost || 0), 0)) },
    errors24h: logs.filter((l) => Date.now() - l.time < 86400e3).length,
    health, platform: { haltAll: g.haltAll, haltReason: g.haltReason },
    models: models.map((m) => ({ _id: m._id, name: m.name, status: m.status, accuracy: m.metrics?.accuracy ?? null, oosReturnPct: m.metrics?.oosReturnPct ?? null })),
    process: { uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1e6), node: process.version },
  });
}));

r.get('/admin/users', wrap(async (_req, res) => {
  const [users, bots] = await Promise.all([db.users.find({}, { sort: { createdAt: -1 } }), db.bots.find({})]);
  res.json(users.map((u) => ({
    ...publicUser(u),
    bots: bots.filter((b) => b.userId === u._id).length, runningBots: bots.filter((b) => b.userId === u._id && b.status === 'running').length,
  })));
}));

r.patch('/admin/users/:id', wrap(async (req, res) => {
  const u = await db.users.findOne({ _id: req.params.id });
  if (!u) throw bad('User not found', 404);
  const patch = {};
  const { role, status } = req.body || {};
  if (role && ['user', 'admin'].includes(role)) {
    if (u._id === req.user._id && role !== 'admin') throw bad('You cannot remove your own admin role');
    patch.role = role;
  }
  if (status && ['active', 'suspended'].includes(status)) {
    if (u._id === req.user._id) throw bad('You cannot suspend yourself');
    patch.status = status;
    if (status === 'suspended') {
      patch.tokenVersion = (u.tokenVersion || 0) + 1; // sign them out everywhere
      for (const b of await db.bots.find({ userId: u._id, status: 'running' })) { stopBot(b._id); await db.bots.update(b._id, { status: 'stopped' }); }
    }
  }
  const updated = await db.users.update(u._id, patch);
  invalidateUser(u._id);
  await audit(req.user._id, 'admin.user_update', { target: u.email, ...req.body }, req);
  res.json(publicUser(updated));
}));

r.post('/admin/users/:id/killswitch', wrap(async (req, res) => {
  await audit(req.user._id, 'admin.user_killswitch', { target: req.params.id }, req);
  res.json(await killSwitch(req.params.id, `Admin emergency stop by ${req.user.email}`));
}));

r.get('/admin/bots', wrap(async (_req, res) => {
  const [bots, users] = await Promise.all([db.bots.find({}, { sort: { createdAt: -1 } }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  res.json(bots.map((b) => ({ _id: b._id, name: b.name, owner: email[b.userId], symbol: b.symbol, exchange: b.exchange || 'binance', strategy: b.strategy, mode: b.mode, status: b.status, pausedReason: b.pausedReason, position: Boolean(b.position), pnl: b.stats?.pnl || 0, trades: b.stats?.trades || 0, copyable: Boolean(b.copyable) })));
}));

r.get('/admin/trades', wrap(async (_req, res) => {
  const [trades, users] = await Promise.all([db.trades.find({}, { sort: { time: -1 }, limit: 300 }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  res.json(trades.map((t) => ({ ...t, owner: email[t.userId] })));
}));

r.get('/admin/errors', wrap(async (_req, res) => res.json(await db.logs.find({ level: 'error' }, { sort: { time: -1 }, limit: 200 }))));

r.get('/admin/audit', wrap(async (_req, res) => {
  const [rows, users] = await Promise.all([db.audit.find({}, { sort: { time: -1 }, limit: 500 }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  res.json(rows.map((a) => ({ ...a, email: email[a.userId] })));
}));

// Platform-wide halt: blocks new entries for every user (positions stay protected).
r.post('/admin/halt', wrap(async (req, res) => {
  const { haltAll, reason } = req.body || {};
  const g = await updateGlobal({ haltAll: Boolean(haltAll), haltReason: haltAll ? String(reason || 'Platform maintenance').slice(0, 200) : null });
  await audit(req.user._id, haltAll ? 'admin.platform_halt' : 'admin.platform_resume', { reason }, req);
  if (haltAll) for (const u of await db.users.find({})) notify(u._id, { type: 'warn', title: 'Trading paused by the platform', body: g.haltReason, important: true });
  res.json(g);
}));

// White-label branding.
r.put('/admin/branding', wrap(async (req, res) => {
  const b = req.body || {};
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
  const branding = {
    appName: String(b.appName || DEFAULT_BRANDING.appName).slice(0, 30), tagline: String(b.tagline ?? DEFAULT_BRANDING.tagline).slice(0, 40),
    logoText: String(b.logoText || DEFAULT_BRANDING.logoText).slice(0, 3), primary: hex(b.primary, DEFAULT_BRANDING.primary), accent: hex(b.accent, DEFAULT_BRANDING.accent),
    supportEmail: String(b.supportEmail || '').slice(0, 80), poweredBy: b.poweredBy !== false,
  };
  const g = await updateGlobal({ branding });
  await audit(req.user._id, 'admin.branding_update', branding, req);
  res.json(g.branding);
}));

export default r;
