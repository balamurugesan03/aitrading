import { db } from '../db/index.js';
import { verifyToken, sha256 } from './crypto.js';

const userCache = new Map(); // id -> { at, user }
export const invalidateUser = (id) => userCache.delete(id);

async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 5000) return hit.user;
  const user = await db.users.findOne({ _id: id });
  userCache.set(id, { at: Date.now(), user });
  return user;
}

// Resolves the caller from a Bearer token or an X-API-Key header.
export async function authenticate(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const key = await db.apiKeys.findOne({ hash: sha256(String(apiKey)) });
    if (!key || key.revoked) throw Object.assign(new Error('Invalid API key'), { status: 401 });
    const user = await loadUser(key.userId);
    if (!user || user.status === 'suspended' || user.role === 'superadmin') throw Object.assign(new Error('Account disabled'), { status: 403 });
    db.apiKeys.update(key._id, { lastUsedAt: Date.now() });
    return { user, apiKey: key };
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query?.token;
  const payload = verifyToken(token);
  // Trading sessions and Super Admin sessions are separate: neither token works on the other side.
  if (!payload || payload.scope === SUPERADMIN_SCOPE) throw Object.assign(new Error('Please sign in'), { status: 401 });
  const user = await loadUser(payload.sub);
  if (!user || user.role === 'superadmin' || (user.tokenVersion || 0) !== (payload.v || 0)) throw Object.assign(new Error('Session expired - sign in again'), { status: 401 });
  if (user.status === 'suspended') throw Object.assign(new Error('Your account is suspended. Contact support.'), { status: 403 });
  return { user };
}

export const SUPERADMIN_SCOPE = 'superadmin';

// Super Admin panel: only a token issued by /superadmin/auth/login for a superadmin account.
export async function requireSuperAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
  const user = payload?.scope === SUPERADMIN_SCOPE && (await loadUser(payload.sub).catch(() => null));
  if (!user || user.role !== 'superadmin' || (user.tokenVersion || 0) !== (payload.v || 0)) return res.status(401).json({ error: 'Super Admin sign-in required' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account disabled' });
  req.user = user;
  next();
}

export const requireAuth = (req, res, next) =>
  authenticate(req)
    .then(({ user, apiKey }) => {
      req.user = user;
      req.apiKey = apiKey || null;
      // API keys are read-only unless they carry the "trade" scope.
      if (apiKey && req.method !== 'GET' && !apiKey.scopes?.includes('trade')) return res.status(403).json({ error: 'This API key is read-only (missing "trade" scope)' });
      next();
    })
    .catch((err) => res.status(err.status || 401).json({ error: err.message }));

export const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

export const publicUser = (u) => u && ({
  _id: u._id, email: u.email, name: u.name, role: u.role, status: u.status,
  twoFactor: Boolean(u.totpEnabled), telegram: u.telegram ? { enabled: u.telegram.enabled, chatId: u.telegram.chatId, hasToken: Boolean(u.telegram.token) } : null,
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, timezone: u.timezone || 'Asia/Kolkata', displayName: u.displayName || u.name,
});
