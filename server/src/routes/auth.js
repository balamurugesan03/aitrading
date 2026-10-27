// Single-owner account: login (+2FA), profile, exchange API connections, Telegram, API keys, notifications, audit log.
import { Router } from 'express';
import { db } from '../db/index.js';
import crypto from 'crypto';
import { hashPassword, verifyPassword, signToken, encrypt, decrypt, mask, randomBase32, verifyTotp, otpauthUrl, newApiKey, sha256, MAX_PASSWORD } from '../auth/crypto.js';
import { requireAuth, publicUser, invalidateUser } from '../auth/middleware.js';
import { audit, notify, testTelegram, sendTelegram } from '../notify.js';
import { EXCHANGES, listExchanges } from '../exchange/index.js';
import { config } from '../config.js';

const r = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Brute-force protection: 8 failed logins per 15 minutes per username+IP.
const attempts = new Map();
const tooMany = (key) => (attempts.get(key) || []).filter((t) => Date.now() - t < 15 * 60e3).length >= 8;
const fail = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
setInterval(() => {
  for (const [k, list] of attempts) if (!list.some((t) => Date.now() - t < 15 * 60e3)) attempts.delete(k);
}, 15 * 60e3).unref();

const session = (user) => ({ token: signToken({ sub: user._id, v: user.tokenVersion || 0 }), user: publicUser(user) });

// The owner account inherits all data created before accounts existed.
async function claimLegacyData(userId) {
  const cols = ['bots', 'trades', 'wallet', 'journal', 'signals', 'logs', 'equity', 'backtests'];
  for (const c of cols) {
    for (const doc of await db[c].find({})) if (!doc.userId) await db[c].update(doc._id, { userId });
  }
  const legacy = await db.settings.findOne({ kind: 'global' });
  if (legacy) {
    await db.settings.insert({ kind: 'user', userId, tradingEnabled: legacy.tradingEnabled ?? true, risk: legacy.risk, peakEquity: legacy.peakEquity || { paper: 0, live: 0 } });
    await db.settings.remove(legacy._id);
  }
}

// Personal install: there is no sign-up. The one owner account comes from ADMIN_USERNAME / ADMIN_PASSWORD in .env.
// The username always follows .env. ADMIN_PASSWORD is applied when the account is created and again whenever its
// value in .env changes (a scrypt hash of the last applied value is kept), so a password changed in the app survives
// restarts, and editing ADMIN_PASSWORD + restarting is the recovery path. Any change signs out existing sessions.
export async function ensureOwnerAccount() {
  const username = config.adminUsername;
  const password = config.adminPassword;
  const users = await db.users.find({}, { sort: { createdAt: 1 } });
  const owner = users.find((u) => u.role === 'admin') || users[0];
  if (!owner) {
    const user = await db.users.insert({ email: username, name: username, displayName: username, passwordHash: hashPassword(password), envPasswordHash: hashPassword(password), role: 'admin', status: 'active', tokenVersion: 0 });
    await claimLegacyData(user._id);
    await audit(user._id, 'account.created', { username });
    console.log(`[auth] owner account "${username}" created from .env`);
    return user;
  }
  const patch = {};
  if (owner.email !== username) patch.email = username;
  if (!owner.envPasswordHash || !verifyPassword(password, owner.envPasswordHash)) {
    patch.passwordHash = hashPassword(password);
    patch.envPasswordHash = hashPassword(password);
  }
  if (owner.role !== 'admin') patch.role = 'admin';
  if (owner.status !== 'active') patch.status = 'active';
  if (!Object.keys(patch).length) return owner;
  if (patch.email || patch.passwordHash) patch.tokenVersion = (owner.tokenVersion || 0) + 1;
  const updated = await db.users.update(owner._id, patch);
  invalidateUser(owner._id);
  await audit(owner._id, 'account.credentials_synced', { username: patch.email !== undefined, password: Boolean(patch.passwordHash) });
  console.log(`[auth] owner login updated from .env (username "${username}"${patch.passwordHash ? ', password reset to ADMIN_PASSWORD' : ''})`);
  return updated;
}

const checkNewPassword = (pw) => {
  if (pw.length < 8 || pw.length > MAX_PASSWORD) throw bad(`New password must be 8-${MAX_PASSWORD} characters`);
};

// ---- Forgot password: a 6-digit code sent to the owner's Telegram, valid 10 minutes, 5 tries ----
// Kept in memory: a restart simply invalidates a pending code. With 2FA on, the reset also needs the authenticator code.
const RESET_TTL = 10 * 60e3;
let pendingReset = null; // { userId, codeHash, expires, tries }
const codeHash = (code) => crypto.createHmac('sha256', 'pw-reset').update(String(code)).digest();

r.post('/auth/forgot', wrap(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const user = username && (await db.users.findOne({ email: username }));
  const telegram = Boolean(user?.telegram?.enabled && user.telegram.token && user.telegram.chatId);
  if (telegram) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    pendingReset = { userId: user._id, codeHash: codeHash(code), expires: Date.now() + RESET_TTL, tries: 0 };
    await sendTelegram(user, `<b>VelocityX password reset</b>\nYour code: <code>${code}</code>\nValid for 10 minutes. If you did not ask for this, ignore it.`);
    await audit(user._id, 'auth.reset_requested', {}, req);
  }
  // Same answer either way, so the form does not reveal which usernames exist.
  res.json({ ok: true, needs2fa: Boolean(telegram && user.totpEnabled) });
}));

r.post('/auth/reset', wrap(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const next = String(req.body?.password || '');
  const p = pendingReset;
  const user = username && (await db.users.findOne({ email: username }));
  if (!p || !user || p.userId !== user._id || Date.now() > p.expires) throw bad('The reset code is invalid or has expired - request a new one');
  if (++p.tries > 5) { pendingReset = null; throw bad('Too many wrong codes - request a new one', 429); }
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(codeHash(code), p.codeHash)) throw bad('Wrong reset code');
  if (user.totpEnabled && !verifyTotp(decrypt(user.totpSecret), req.body?.totp)) throw bad('Enter the 6-digit code from your authenticator app');
  checkNewPassword(next);
  pendingReset = null;
  const updated = await db.users.update(user._id, { passwordHash: hashPassword(next), tokenVersion: (user.tokenVersion || 0) + 1 });
  invalidateUser(user._id);
  await audit(user._id, 'auth.password_reset', {}, req);
  notify(user._id, { type: 'warn', title: 'Password was reset', body: 'All other sessions were signed out.', important: true });
  res.json(session(updated));
}));

r.post('/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.username ?? req.body?.email ?? '').trim().toLowerCase();
  const key = `${email}|${req.ip}`;
  if (tooMany(key)) throw bad('Too many attempts - try again in 15 minutes', 429);
  const user = await db.users.findOne({ email });
  if (!user || !verifyPassword(String(req.body?.password || ''), user.passwordHash)) {
    fail(key);
    if (user) await audit(user._id, 'auth.login_failed', {}, req);
    throw bad('Wrong username or password', 401);
  }
  if (user.status === 'suspended') throw bad('Your account is suspended. Contact support.', 403);
  if (user.totpEnabled) {
    if (!req.body?.code) return res.json({ twoFactorRequired: true });
    if (!verifyTotp(decrypt(user.totpSecret), req.body.code)) {
      fail(key);
      await audit(user._id, 'auth.2fa_failed', {}, req);
      throw bad('Invalid 2FA code', 401);
    }
  }
  attempts.delete(key);
  const updated = await db.users.update(user._id, { lastLoginAt: Date.now() });
  await audit(user._id, 'auth.login', {}, req);
  res.json(session(updated));
}));

r.use(requireAuth);

r.get('/auth/me', wrap(async (req, res) => {
  res.json({ user: publicUser(req.user), unread: await db.notifications.count({ userId: req.user._id, read: false }) });
}));

r.post('/auth/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.passwordHash)) throw bad('Current password is wrong');
  checkNewPassword(String(next || ''));
  const u = await db.users.update(req.user._id, { passwordHash: hashPassword(String(next)), tokenVersion: (req.user.tokenVersion || 0) + 1 });
  invalidateUser(req.user._id);
  await audit(req.user._id, 'account.password_change', {}, req);
  res.json(session(u));
}));

r.patch('/auth/profile', wrap(async (req, res) => {
  const patch = {};
  if (req.body?.name) patch.name = String(req.body.name).slice(0, 60);
  if (req.body?.displayName !== undefined) patch.displayName = String(req.body.displayName).slice(0, 40);
  if (req.body?.timezone) patch.timezone = String(req.body.timezone).slice(0, 60);
  const u = await db.users.update(req.user._id, patch);
  invalidateUser(req.user._id);
  await audit(req.user._id, 'account.profile_update', Object.keys(patch), req);
  res.json(publicUser(u));
}));

r.post('/auth/logout-all', wrap(async (req, res) => {
  const u = await db.users.update(req.user._id, { tokenVersion: (req.user.tokenVersion || 0) + 1 });
  invalidateUser(req.user._id);
  await audit(req.user._id, 'auth.logout_all', {}, req);
  res.json(session(u));
}));

// ---- 2FA (TOTP) ----
r.post('/auth/2fa/setup', wrap(async (req, res) => {
  const secret = randomBase32(32);
  await db.users.update(req.user._id, { totpPending: encrypt(secret) });
  invalidateUser(req.user._id);
  res.json({ secret, otpauth: otpauthUrl(secret, req.user.email) });
}));
r.post('/auth/2fa/enable', wrap(async (req, res) => {
  if (!req.user.totpPending) throw bad('Start 2FA setup first');
  const secret = decrypt(req.user.totpPending);
  if (!verifyTotp(secret, req.body?.code)) throw bad('Code did not match - check your authenticator app time');
  await db.users.update(req.user._id, { totpEnabled: true, totpSecret: req.user.totpPending, totpPending: null });
  invalidateUser(req.user._id);
  await audit(req.user._id, 'security.2fa_enabled', {}, req);
  notify(req.user._id, { type: 'info', title: 'Two-factor authentication enabled', important: true });
  res.json({ ok: true });
}));
r.post('/auth/2fa/disable', wrap(async (req, res) => {
  if (!req.user.totpEnabled) throw bad('2FA is not enabled');
  if (!verifyTotp(decrypt(req.user.totpSecret), req.body?.code)) throw bad('Invalid 2FA code');
  await db.users.update(req.user._id, { totpEnabled: false, totpSecret: null });
  invalidateUser(req.user._id);
  await audit(req.user._id, 'security.2fa_disabled', {}, req);
  notify(req.user._id, { type: 'warn', title: 'Two-factor authentication disabled', important: true });
  res.json({ ok: true });
}));

// ---- Exchange API connections (secrets encrypted at rest, never returned) ----
const connView = (c) => ({ _id: c._id, exchange: c.exchange, label: c.label, apiKey: mask(decrypt(c.apiKey)), testnet: c.testnet, active: c.active, createdAt: c.createdAt, lastTestAt: c.lastTestAt, lastTestOk: c.lastTestOk, lastTestMsg: c.lastTestMsg, sessionAt: c.sessionAt || null, kiteUserId: c.kiteUserId || null });

r.get('/account/exchanges', wrap(async (_req, res) => res.json(listExchanges())));
r.get('/account/connections', wrap(async (req, res) => res.json((await db.apiConnections.find({ userId: req.user._id })).map(connView))));
r.post('/account/connections', wrap(async (req, res) => {
  const { exchange, label, apiKey, apiSecret, passphrase } = req.body || {};
  const testnet = exchange === 'zerodha' ? false : req.body?.testnet ?? true; // Kite has no testnet: use paper mode to practise
  const e = EXCHANGES[exchange];
  if (!e) throw bad('Unknown exchange');
  if (!e.trading) throw bad(`${e.name} trading is not supported yet`);
  if (e.connection) throw bad(`${e.name} uses your ${EXCHANGES[e.connection].name} connection - add that one instead`);
  if (!apiKey || !apiSecret) throw bad('API key and secret are required');
  if (exchange === 'okx' && !passphrase) throw bad('OKX needs the API passphrase');
  for (const old of await db.apiConnections.find({ userId: req.user._id, exchange })) await db.apiConnections.update(old._id, { active: false });
  const c = await db.apiConnections.insert({
    userId: req.user._id, exchange, label: String(label || (exchange === 'zerodha' ? 'Zerodha Kite' : `${e.name} ${testnet ? 'testnet' : 'live'}`)).slice(0, 40),
    apiKey: encrypt(String(apiKey).trim()), apiSecret: encrypt(String(apiSecret).trim()), passphrase: passphrase ? encrypt(String(passphrase)) : null,
    testnet: Boolean(testnet), active: true,
  });
  await audit(req.user._id, 'connection.add', { exchange, testnet: Boolean(testnet) }, req);
  res.json(connView(c));
}));
r.post('/account/connections/:id/test', wrap(async (req, res) => {
  const c = await db.apiConnections.findOne({ _id: req.params.id });
  if (!c || c.userId !== req.user._id) throw bad('Not found', 404);
  const creds = { apiKey: decrypt(c.apiKey), apiSecret: decrypt(c.apiSecret), passphrase: c.passphrase ? decrypt(c.passphrase) : undefined, testnet: c.testnet };
  let ok = true;
  let msg;
  try {
    const bal = await EXCHANGES[c.exchange].tradingClient(creds).getAccount();
    msg = `Connected. ${bal.length} asset(s) with a balance.`;
  } catch (err) {
    ok = false;
    msg = err.message;
  }
  const u = await db.apiConnections.update(c._id, { lastTestAt: Date.now(), lastTestOk: ok, lastTestMsg: msg });
  res.json(connView(u));
}));
r.delete('/account/connections/:id', wrap(async (req, res) => {
  const c = await db.apiConnections.findOne({ _id: req.params.id });
  if (!c || c.userId !== req.user._id) throw bad('Not found', 404);
  await db.apiConnections.remove(c._id);
  await audit(req.user._id, 'connection.remove', { exchange: c.exchange }, req);
  res.json({ ok: true });
}));

// ---- Telegram alerts ----
r.put('/account/telegram', wrap(async (req, res) => {
  const { token, chatId, enabled = true, allEvents = false } = req.body || {};
  const current = req.user.telegram || {};
  const telegram = { enabled: Boolean(enabled), chatId: String(chatId || current.chatId || '').slice(0, 40), allEvents: Boolean(allEvents), token: token ? encrypt(String(token)) : current.token };
  const u = await db.users.update(req.user._id, { telegram });
  invalidateUser(req.user._id);
  await audit(req.user._id, 'account.telegram_update', { enabled: telegram.enabled }, req);
  res.json(publicUser(u));
}));
r.post('/account/telegram/test', wrap(async (req, res) => {
  if (!req.user.telegram?.token) throw bad('Save a bot token and chat ID first');
  await testTelegram(req.user);
  res.json({ ok: true });
}));

// ---- Enterprise API keys ----
r.get('/account/apikeys', wrap(async (req, res) => {
  const keys = await db.apiKeys.find({ userId: req.user._id }, { sort: { createdAt: -1 } });
  res.json(keys.map((k) => ({ _id: k._id, name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: k.revoked })));
}));
r.post('/account/apikeys', wrap(async (req, res) => {
  const scopes = (req.body?.scopes || ['read']).filter((s) => ['read', 'trade'].includes(s));
  const key = newApiKey();
  const k = await db.apiKeys.insert({ userId: req.user._id, name: String(req.body?.name || 'API key').slice(0, 40), prefix: key.slice(0, 10), hash: sha256(key), scopes, revoked: false });
  await audit(req.user._id, 'apikey.create', { name: k.name, scopes }, req);
  res.json({ _id: k._id, name: k.name, prefix: k.prefix, scopes, key }); // the full key is shown once
}));
r.delete('/account/apikeys/:id', wrap(async (req, res) => {
  const k = await db.apiKeys.findOne({ _id: req.params.id });
  if (!k || k.userId !== req.user._id) throw bad('Not found', 404);
  await db.apiKeys.update(k._id, { revoked: true });
  await audit(req.user._id, 'apikey.revoke', { name: k.name }, req);
  res.json({ ok: true });
}));

// ---- Notifications & audit ----
r.get('/notifications', wrap(async (req, res) => res.json(await db.notifications.find({ userId: req.user._id }, { sort: { time: -1 }, limit: 100 }))));
r.post('/notifications/read-all', wrap(async (req, res) => {
  for (const n of await db.notifications.find({ userId: req.user._id, read: false })) await db.notifications.update(n._id, { read: true });
  res.json({ ok: true });
}));
r.get('/account/audit', wrap(async (req, res) => res.json(await db.audit.find({ userId: req.user._id }, { sort: { time: -1 }, limit: 200 }))));

export default r;
