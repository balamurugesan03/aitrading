// Super Admin panel API (/api/superadmin/*): its own login, plans, subscriptions, users, payments.
// Mounted before the trading routers; trading sessions are rejected here and Super Admin sessions are rejected there.
import { Router } from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, signToken, verifyTotp, decrypt, MAX_PASSWORD } from '../auth/crypto.js';
import { requireSuperAdmin, publicUser, invalidateUser, SUPERADMIN_SCOPE } from '../auth/middleware.js';
import { stopBot } from '../bot/engine.js';
import { audit, notify } from '../notify.js';
import { FEATURES, INTERVAL_DAYS, cleanFeatures, planFor, grantSubscription, activeSubscription } from '../billing/plans.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const session = (u) => ({ token: signToken({ sub: u._id, v: u.tokenVersion || 0, scope: SUPERADMIN_SCOPE }, 12 * 3600), user: publicUser(u) });
const DAY = 86400e3;

// The Super Admin account comes from SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD, synced like the trading owner.
export async function ensureSuperAdminAccount() {
  const username = config.superAdminUsername;
  const password = config.superAdminPassword;
  const clash = await db.users.findOne({ email: username });
  if (clash && clash.role !== 'superadmin') {
    console.error(`[superadmin] username "${username}" is already a trading account - set a different SUPERADMIN_USERNAME`);
    return null;
  }
  const sa = clash || (await db.users.findOne({ role: 'superadmin' }));
  if (!sa) {
    const u = await db.users.insert({ email: username, name: 'Super Admin', displayName: 'Super Admin', passwordHash: hashPassword(password), envPasswordHash: hashPassword(password), role: 'superadmin', status: 'active', tokenVersion: 0 });
    console.log(`[superadmin] account "${username}" created from .env`);
    return u;
  }
  const patch = {};
  if (sa.email !== username) patch.email = username;
  if (!sa.envPasswordHash || !verifyPassword(password, sa.envPasswordHash)) {
    patch.passwordHash = hashPassword(password);
    patch.envPasswordHash = hashPassword(password);
  }
  if (sa.status !== 'active') patch.status = 'active';
  if (!Object.keys(patch).length) return sa;
  if (patch.email || patch.passwordHash) patch.tokenVersion = (sa.tokenVersion || 0) + 1;
  invalidateUser(sa._id);
  console.log(`[superadmin] login updated from .env (username "${username}"${patch.passwordHash ? ', password reset to SUPERADMIN_PASSWORD' : ''})`);
  return db.users.update(sa._id, patch);
}

// ---- Login (public) ----
const attempts = new Map();
const recent = (k) => (attempts.get(k) || []).filter((t) => Date.now() - t < 15 * 60e3);

r.post('/superadmin/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.username || '').trim().toLowerCase();
  const key = `${email}|${req.ip}`;
  if (recent(key).length >= 5) throw bad('Too many attempts - try again in 15 minutes', 429);
  const user = await db.users.findOne({ email });
  if (!user || user.role !== 'superadmin' || !verifyPassword(String(req.body?.password || ''), user.passwordHash)) {
    attempts.set(key, [...recent(key), Date.now()]);
    if (user?.role === 'superadmin') await audit(user._id, 'superadmin.login_failed', {}, req);
    throw bad('Wrong username or password', 401);
  }
  if (user.totpEnabled) {
    if (!req.body?.code) return res.json({ twoFactorRequired: true });
    if (!verifyTotp(decrypt(user.totpSecret), req.body.code)) throw bad('Invalid 2FA code', 401);
  }
  attempts.delete(key);
  const u = await db.users.update(user._id, { lastLoginAt: Date.now() });
  await audit(u._id, 'superadmin.login', {}, req);
  res.json(session(u));
}));

// Everything below needs a Super Admin session.
r.use('/superadmin', requireSuperAdmin);

r.get('/superadmin/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

r.post('/superadmin/auth/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.passwordHash)) throw bad('Current password is wrong');
  if (String(next || '').length < 12 || String(next).length > MAX_PASSWORD) throw bad('New password must be at least 12 characters');
  const u = await db.users.update(req.user._id, { passwordHash: hashPassword(String(next)), tokenVersion: (req.user.tokenVersion || 0) + 1 });
  invalidateUser(u._id);
  await audit(u._id, 'superadmin.password_change', {}, req);
  res.json(session(u));
}));

// ---- Overview ----
r.get('/superadmin/overview', wrap(async (_req, res) => {
  const [users, subs, payments, plans] = await Promise.all([db.users.find({}), db.subscriptions.find({}), db.payments.find({}), db.plans.find({})]);
  const traders = users.filter((u) => u.role !== 'superadmin');
  const now = Date.now();
  const live = subs.filter((s) => ['active', 'trial'].includes(s.status) && (!s.endAt || s.endAt > now));
  const planById = Object.fromEntries(plans.map((p) => [p._id, p]));
  const monthly = (p) => (!p || !p.price ? 0 : p.price * 30 / (INTERVAL_DAYS[p.interval] || 30));
  const sum = (rows) => Math.round(rows.reduce((s, p) => s + (p.amount || 0), 0));
  res.json({
    users: { total: traders.length, active: traders.filter((u) => u.status !== 'suspended').length, suspended: traders.filter((u) => u.status === 'suspended').length, newLast30d: traders.filter((u) => now - u.createdAt < 30 * DAY).length },
    subscriptions: { active: live.length, pending: subs.filter((s) => s.status === 'pending').length, expiringIn7d: live.filter((s) => s.endAt && s.endAt - now < 7 * DAY).length },
    revenue: { total: sum(payments), last30d: sum(payments.filter((p) => now - p.time < 30 * DAY)), mrr: Math.round(live.reduce((s, x) => s + monthly(planById[x.planId]), 0)) },
    byPlan: plans.map((p) => ({ _id: p._id, name: p.name, active: p.active, subscribers: live.filter((s) => s.planId === p._id).length })),
  });
}));

// ---- Plans ----
const planInput = (b, base = {}) => {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 40);
  if (b.code !== undefined) out.code = String(b.code).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  if (b.description !== undefined) out.description = String(b.description).slice(0, 200);
  if (b.price !== undefined) out.price = Math.max(0, Math.round(Number(b.price) * 100) / 100 || 0);
  if (b.currency !== undefined) out.currency = String(b.currency).toUpperCase().slice(0, 3) || 'INR';
  if (b.interval !== undefined) { if (!INTERVAL_DAYS[b.interval]) throw bad('Interval must be month, quarter, year or lifetime'); out.interval = b.interval; }
  if (b.trialDays !== undefined) out.trialDays = Math.max(0, Math.min(365, Math.round(Number(b.trialDays) || 0)));
  if (b.active !== undefined) out.active = Boolean(b.active);
  if (b.features !== undefined) out.features = cleanFeatures(b.features, base.features || {});
  return out;
};

r.get('/superadmin/plans', wrap(async (_req, res) => {
  const [plans, subs] = await Promise.all([db.plans.find({}, { sort: { price: 1 } }), db.subscriptions.find({})]);
  const now = Date.now();
  res.json({ features: FEATURES, intervals: Object.keys(INTERVAL_DAYS), plans: plans.map((p) => ({ ...p, subscribers: subs.filter((s) => s.planId === p._id && ['active', 'trial'].includes(s.status) && (!s.endAt || s.endAt > now)).length })) });
}));

r.post('/superadmin/plans', wrap(async (req, res) => {
  const p = planInput(req.body || {});
  if (!p.name) throw bad('Plan name is required');
  p.code ||= p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (await db.plans.findOne({ code: p.code })) throw bad('A plan with that code already exists', 409);
  const plan = await db.plans.insert({ price: 0, currency: 'INR', interval: 'month', trialDays: 0, active: true, isDefault: false, description: '', ...p, features: cleanFeatures(req.body?.features || {}, { maxBots: 1, liveTrading: false, aiAssistant: false, options: false, copyTrading: false }) });
  await audit(req.user._id, 'superadmin.plan_create', { name: plan.name }, req);
  res.json(plan);
}));

r.patch('/superadmin/plans/:id', wrap(async (req, res) => {
  const plan = await db.plans.findOne({ _id: req.params.id });
  if (!plan) throw bad('Plan not found', 404);
  const patch = planInput(req.body || {}, plan);
  if (patch.code && patch.code !== plan.code && (await db.plans.findOne({ code: patch.code }))) throw bad('A plan with that code already exists', 409);
  if (req.body?.isDefault === true) {
    for (const p of await db.plans.find({ isDefault: true })) await db.plans.update(p._id, { isDefault: false });
    patch.isDefault = true;
    patch.active = true;
  }
  if (plan.isDefault && patch.active === false) throw bad('Make another plan the default before deactivating this one');
  const updated = await db.plans.update(plan._id, patch);
  await audit(req.user._id, 'superadmin.plan_update', { name: updated.name, ...patch }, req);
  res.json(updated);
}));

r.delete('/superadmin/plans/:id', wrap(async (req, res) => {
  const plan = await db.plans.findOne({ _id: req.params.id });
  if (!plan) throw bad('Plan not found', 404);
  if (plan.isDefault) throw bad('The default plan cannot be deleted');
  if (await db.subscriptions.count({ planId: plan._id })) {
    await db.plans.update(plan._id, { active: false }); // keep history intact
    await audit(req.user._id, 'superadmin.plan_deactivate', { name: plan.name }, req);
    return res.json({ ok: true, deactivated: true });
  }
  await db.plans.remove(plan._id);
  await audit(req.user._id, 'superadmin.plan_delete', { name: plan.name }, req);
  res.json({ ok: true });
}));

// ---- Users ----
r.get('/superadmin/users', wrap(async (_req, res) => {
  const [users, bots] = await Promise.all([db.users.find({}, { sort: { createdAt: -1 } }), db.bots.find({})]);
  const out = [];
  for (const u of users.filter((x) => x.role !== 'superadmin')) {
    const { plan, subscription } = await planFor(u);
    out.push({ ...publicUser(u), plan: { _id: plan._id, name: plan.name }, subscription, bots: bots.filter((b) => b.userId === u._id).length });
  }
  res.json(out);
}));

const traderOr404 = async (id) => {
  const u = await db.users.findOne({ _id: id });
  if (!u || u.role === 'superadmin') throw bad('User not found', 404);
  return u;
};

r.patch('/superadmin/users/:id', wrap(async (req, res) => {
  const u = await traderOr404(req.params.id);
  const patch = {};
  const { status, role } = req.body || {};
  if (['active', 'suspended'].includes(status)) {
    patch.status = status;
    if (status === 'suspended') {
      patch.tokenVersion = (u.tokenVersion || 0) + 1;
      for (const b of await db.bots.find({ userId: u._id, status: 'running' })) { stopBot(b._id); await db.bots.update(b._id, { status: 'stopped' }); }
    }
  }
  if (['user', 'admin'].includes(role)) patch.role = role;
  const updated = await db.users.update(u._id, patch);
  invalidateUser(u._id);
  await audit(req.user._id, 'superadmin.user_update', { target: u.email, ...patch }, req);
  res.json(publicUser(updated));
}));

r.get('/superadmin/users/:id/subscriptions', wrap(async (req, res) => {
  await traderOr404(req.params.id);
  res.json(await db.subscriptions.find({ userId: req.params.id }, { sort: { createdAt: -1 } }));
}));

// Assign or extend a plan. Body: { planId, days?, amount?, note?, method? }
r.post('/superadmin/users/:id/subscription', wrap(async (req, res) => {
  const u = await traderOr404(req.params.id);
  const plan = await db.plans.findOne({ _id: String(req.body?.planId || '') });
  if (!plan) throw bad('Plan not found', 404);
  const days = req.body?.days ? Math.max(1, Math.min(36500, Math.round(Number(req.body.days)))) : undefined;
  const amount = Math.max(0, Number(req.body?.amount ?? 0) || 0);
  const sub = await grantSubscription({ userId: u._id, plan, days, amount, note: String(req.body?.note || '').slice(0, 300), method: String(req.body?.method || 'manual').slice(0, 30), by: req.user._id });
  const pending = await db.subscriptions.findOne({ userId: u._id, status: 'pending' });
  if (pending) await db.subscriptions.update(pending._id, { status: 'approved', resolvedAt: Date.now() });
  await audit(req.user._id, 'superadmin.subscription_grant', { target: u.email, plan: plan.name, days, amount }, req);
  notify(u._id, { type: 'info', title: `Your plan is now ${plan.name}`, body: `Valid until ${new Date(sub.endAt).toDateString()}`, important: true });
  res.json(sub);
}));

r.post('/superadmin/users/:id/subscription/cancel', wrap(async (req, res) => {
  const u = await traderOr404(req.params.id);
  const sub = await activeSubscription(u._id);
  if (!sub) throw bad('No active subscription');
  await db.subscriptions.update(sub._id, { status: 'cancelled', cancelledAt: Date.now() });
  await audit(req.user._id, 'superadmin.subscription_cancel', { target: u.email, plan: sub.planName }, req);
  notify(u._id, { type: 'warn', title: 'Your subscription was cancelled', body: 'You are back on the free plan.', important: true });
  res.json({ ok: true });
}));

// ---- Subscriptions & upgrade requests ----
r.get('/superadmin/subscriptions', wrap(async (req, res) => {
  const [subs, users] = await Promise.all([db.subscriptions.find(req.query.status ? { status: String(req.query.status) } : {}, { sort: { createdAt: -1 }, limit: 500 }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  const now = Date.now();
  res.json(subs.map((s) => ({ ...s, email: email[s.userId], status: ['active', 'trial'].includes(s.status) && s.endAt && s.endAt < now ? 'expired' : s.status })));
}));

r.post('/superadmin/subscriptions/:id/approve', wrap(async (req, res) => {
  const s = await db.subscriptions.findOne({ _id: req.params.id });
  if (!s || s.status !== 'pending') throw bad('Request not found', 404);
  const plan = await db.plans.findOne({ _id: s.planId });
  if (!plan) throw bad('That plan no longer exists');
  const amount = req.body?.amount !== undefined ? Math.max(0, Number(req.body.amount) || 0) : s.amount || 0;
  await db.subscriptions.update(s._id, { status: 'approved', resolvedAt: Date.now() });
  const sub = await grantSubscription({ userId: s.userId, plan, amount, note: String(req.body?.note || s.note || '').slice(0, 300), method: String(req.body?.method || 'manual'), by: req.user._id });
  await audit(req.user._id, 'superadmin.request_approve', { userId: s.userId, plan: plan.name, amount }, req);
  notify(s.userId, { type: 'info', title: `Upgrade approved: ${plan.name}`, body: `Valid until ${new Date(sub.endAt).toDateString()}`, important: true });
  res.json(sub);
}));

r.post('/superadmin/subscriptions/:id/reject', wrap(async (req, res) => {
  const s = await db.subscriptions.findOne({ _id: req.params.id });
  if (!s || s.status !== 'pending') throw bad('Request not found', 404);
  const reason = String(req.body?.reason || '').slice(0, 200);
  await db.subscriptions.update(s._id, { status: 'rejected', resolvedAt: Date.now(), rejectReason: reason });
  await audit(req.user._id, 'superadmin.request_reject', { userId: s.userId, plan: s.planName, reason }, req);
  notify(s.userId, { type: 'warn', title: `Upgrade request to ${s.planName} was declined`, body: reason || undefined, important: true });
  res.json({ ok: true });
}));

// ---- Payments & audit ----
r.get('/superadmin/payments', wrap(async (_req, res) => {
  const [rows, users] = await Promise.all([db.payments.find({}, { sort: { time: -1 }, limit: 500 }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  res.json(rows.map((p) => ({ ...p, email: email[p.userId] })));
}));

r.get('/superadmin/audit', wrap(async (_req, res) => {
  const [rows, users] = await Promise.all([db.audit.find({}, { sort: { time: -1 }, limit: 500 }), db.users.find({})]);
  const email = Object.fromEntries(users.map((u) => [u._id, u.email]));
  res.json(rows.map((a) => ({ ...a, email: email[a.userId] })));
}));

export default r;
