// Subscription plans: what each plan allows, which plan a user is on, and the checks trading routes call.
// Plans and subscriptions are managed from the Super Admin panel. A user without an active subscription is on the
// default plan. The trading owner (role "admin") is never limited.
import { db } from '../db/index.js';

export const FEATURES = {
  maxBots: { label: 'Max trading bots', type: 'number' },
  liveTrading: { label: 'Live (real money) trading', type: 'bool' },
  aiAssistant: { label: 'AI assistant chat', type: 'bool' },
  options: { label: 'NSE options trading', type: 'bool' },
  copyTrading: { label: 'Copy trading', type: 'bool' },
};

export const DEFAULT_PLANS = [
  { code: 'free', name: 'Free', price: 0, currency: 'INR', interval: 'month', isDefault: true, description: 'Paper trading to get started',
    features: { maxBots: 1, liveTrading: false, aiAssistant: false, options: false, copyTrading: false } },
  { code: 'pro', name: 'Pro', price: 999, currency: 'INR', interval: 'month', description: 'Live trading with AI',
    features: { maxBots: 10, liveTrading: true, aiAssistant: true, options: true, copyTrading: true } },
  { code: 'elite', name: 'Elite', price: 9999, currency: 'INR', interval: 'year', description: 'Everything, unlimited bots',
    features: { maxBots: 100, liveTrading: true, aiAssistant: true, options: true, copyTrading: true } },
];

export const INTERVAL_DAYS = { month: 30, quarter: 90, year: 365, lifetime: 36500 };
const DAY = 86400e3;

export function cleanFeatures(f = {}, base = {}) {
  const out = { ...base };
  for (const [k, def] of Object.entries(FEATURES)) {
    if (f[k] === undefined) continue;
    out[k] = def.type === 'number' ? Math.max(0, Math.min(1000, Math.round(Number(f[k]) || 0))) : Boolean(f[k]);
  }
  return out;
}

export async function seedPlans() {
  if (await db.plans.count({})) return;
  for (const p of DEFAULT_PLANS) await db.plans.insert({ ...p, active: true, trialDays: 0 });
  console.log(`[billing] created default plans: ${DEFAULT_PLANS.map((p) => p.name).join(', ')}`);
}

export async function defaultPlan() {
  return (await db.plans.findOne({ isDefault: true, active: true })) || (await db.plans.findOne({ code: 'free' })) || { _id: null, name: 'Free', code: 'free', price: 0, features: DEFAULT_PLANS[0].features };
}

// Marks subscriptions whose end date passed as expired (cheap: runs on read).
export async function activeSubscription(userId) {
  for (const s of await db.subscriptions.find({ userId }, { sort: { endAt: -1 } })) {
    if (!['active', 'trial'].includes(s.status)) continue;
    if (s.endAt && s.endAt < Date.now()) {
      await db.subscriptions.update(s._id, { status: 'expired' });
      continue;
    }
    return s;
  }
  return null;
}

export async function planFor(user) {
  const sub = await activeSubscription(user._id);
  const plan = (sub && (await db.plans.findOne({ _id: sub.planId }))) || (await defaultPlan());
  return { plan, subscription: sub };
}

const denied = (msg) => Object.assign(new Error(msg), { status: 402, code: 'PLAN_LIMIT' });

// Throws 402 unless the user's plan includes the feature. The trading owner is exempt.
export async function assertFeature(user, feature) {
  if (user.role === 'admin') return;
  const { plan } = await planFor(user);
  if (!plan.features?.[feature]) throw denied(`${FEATURES[feature].label} is not included in your ${plan.name} plan - upgrade under Account → Subscription`);
}

export async function assertBotSlot(user) {
  if (user.role === 'admin') return;
  const { plan } = await planFor(user);
  const max = plan.features?.maxBots ?? 0;
  const used = (await db.bots.count({ userId: user._id })) + (await db.optionBots.count({ userId: user._id }));
  if (used >= max) throw denied(`Your ${plan.name} plan allows ${max} bot${max === 1 ? '' : 's'} - delete one or upgrade under Account → Subscription`);
}

// Express middleware form.
export const requireFeature = (feature) => (req, res, next) =>
  assertFeature(req.user, feature).then(() => next()).catch((err) => res.status(err.status || 500).json({ error: err.message, code: err.code }));

// Starts (or extends) a subscription. Extending the same plan adds time after the current end date.
export async function grantSubscription({ userId, plan, days, amount = 0, note = '', by, status = 'active', method = 'manual' }) {
  const current = await activeSubscription(userId);
  let startAt = Date.now();
  if (current && current.planId === plan._id && current.endAt) startAt = Math.max(startAt, current.endAt);
  else if (current) await db.subscriptions.update(current._id, { status: 'cancelled', cancelledAt: Date.now(), note: `Replaced by ${plan.name}` });
  const endAt = startAt + (days || INTERVAL_DAYS[plan.interval] || 30) * DAY;
  let sub;
  if (current && current.planId === plan._id) sub = await db.subscriptions.update(current._id, { endAt, status, amount: (current.amount || 0) + amount });
  else sub = await db.subscriptions.insert({ userId, planId: plan._id, planName: plan.name, status, startAt, endAt, amount, currency: plan.currency, note, assignedBy: by });
  if (amount > 0) await db.payments.insert({ userId, subscriptionId: sub._id, planId: plan._id, planName: plan.name, amount, currency: plan.currency, method, note, time: Date.now(), by });
  return sub;
}
