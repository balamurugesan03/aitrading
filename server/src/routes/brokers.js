// Broker logins that need a browser redirect. Zerodha Kite Connect: the owner opens the Kite login page, Kite
// redirects back to /api/brokers/zerodha/callback with a request_token, and the server swaps it (with the API
// secret) for the day's access token. Set the Kite app's redirect URL to <APP_URL>/api/brokers/zerodha/callback.
import crypto from 'crypto';
import { Router } from 'express';
import { db } from '../db/index.js';
import { encrypt, decrypt } from '../auth/crypto.js';
import { config } from '../config.js';
import { audit, notify } from '../notify.js';
import { loginUrl, createSession, sessionValid, resetSessionCache, marketOpen } from '../exchange/zerodha.js';

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status && err.status !== 401 ? err.status : 400).json({ error: err.message }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const callbackUrl = () => `${config.appUrl}/api/brokers/zerodha/callback`;

// One-time login states (10 minutes): ties the Kite redirect to a login the signed-in owner started.
const states = new Map();
const LOGIN_TTL = 10 * 60e3;

const activeConn = (userId) => db.apiConnections.findOne({ userId, exchange: 'zerodha', active: true });

// ---- Public: Kite redirects the browser here (no app session header on a redirect) ----
export const brokersPublic = Router();
brokersPublic.get('/brokers/zerodha/callback', async (req, res) => {
  const back = (q) => res.redirect(`${config.appUrl}/account?tab=connections&${new URLSearchParams(q)}`);
  try {
    const { request_token: requestToken, status, state } = req.query;
    const pending = state && states.get(String(state));
    if (!pending || Date.now() > pending.expires) return back({ zerodha: 'error', msg: 'Login link expired - start again from the app' });
    states.delete(String(state));
    if (status !== 'success' || !requestToken) return back({ zerodha: 'error', msg: 'Kite login was cancelled' });
    const conn = await db.apiConnections.findOne({ _id: pending.connectionId });
    if (!conn || !conn.active || conn.userId !== pending.userId) return back({ zerodha: 'error', msg: 'Zerodha connection not found' });
    const s = await createSession(decrypt(conn.apiKey), decrypt(conn.apiSecret), String(requestToken));
    // Only the Zerodha client that first logged in may refresh this connection.
    if (conn.kiteUserId && conn.kiteUserId !== s.kiteUserId) {
      await audit(pending.userId, 'zerodha.login_rejected', { expected: conn.kiteUserId, got: s.kiteUserId });
      return back({ zerodha: 'error', msg: `This connection belongs to Zerodha client ${conn.kiteUserId}` });
    }
    await db.apiConnections.update(conn._id, {
      accessToken: encrypt(s.accessToken), sessionAt: Date.now(), kiteUserId: s.kiteUserId, kiteUserName: s.userName,
      lastTestAt: Date.now(), lastTestOk: true, lastTestMsg: `Logged in as ${s.userName || s.kiteUserId}`,
    });
    resetSessionCache();
    await audit(pending.userId, 'zerodha.login', { kiteUserId: s.kiteUserId });
    notify(pending.userId, { type: 'info', title: 'Zerodha connected', body: `Kite session active until 6:00 AM IST tomorrow (${s.kiteUserId})` });
    return back({ zerodha: 'ok' });
  } catch (err) {
    return back({ zerodha: 'error', msg: err.message.slice(0, 200) });
  }
});

// ---- Authenticated ----
const r = Router();
r.use('/brokers', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' })));

r.get('/brokers/zerodha/status', wrap(async (req, res) => {
  const c = await activeConn(req.user._id);
  res.json({
    connected: Boolean(c), loggedIn: Boolean(c?.accessToken && sessionValid(c.sessionAt)), sessionAt: c?.sessionAt || null,
    kiteUserId: c?.kiteUserId || null, kiteUserName: c?.kiteUserName || null, redirectUrl: callbackUrl(), marketOpen: marketOpen(),
  });
}));

r.post('/brokers/zerodha/login', wrap(async (req, res) => {
  const c = await activeConn(req.user._id);
  if (!c) throw bad('Add your Kite Connect API key and secret first (exchange: Zerodha)');
  for (const [k, v] of states) if (Date.now() > v.expires) states.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, { userId: req.user._id, connectionId: c._id, expires: Date.now() + LOGIN_TTL });
  res.json({ url: loginUrl(decrypt(c.apiKey), state), redirectUrl: callbackUrl() });
}));

r.post('/brokers/zerodha/logout', wrap(async (req, res) => {
  const c = await activeConn(req.user._id);
  if (c) await db.apiConnections.update(c._id, { accessToken: null, sessionAt: null, lastTestMsg: 'Logged out' });
  resetSessionCache();
  await audit(req.user._id, 'zerodha.logout', {}, req);
  res.json({ ok: true });
}));

export default r;
