// Security primitives (Node crypto only): password hashing, signed tokens, encryption at rest, TOTP 2FA.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.resolve(process.env.DATA_DIR || path.resolve(here, '../../data'), 'master.key');

// Master key: MASTER_KEY env (64 hex chars) or a generated key persisted in server/data/master.key.
function loadMasterKey() {
  if (process.env.MASTER_KEY && /^[0-9a-f]{64}$/i.test(process.env.MASTER_KEY)) return Buffer.from(process.env.MASTER_KEY, 'hex');
  if (process.env.NODE_ENV === 'production') throw new Error('[security] MASTER_KEY (64 hex chars) is required in production - generate one with: openssl rand -hex 32');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  console.warn(`[security] generated a master key at ${KEY_FILE} - back it up, or set MASTER_KEY in .env. Losing it makes stored exchange keys unreadable.`);
  return key;
}
const MASTER = loadMasterKey();
const TOKEN_KEY = crypto.createHmac('sha256', MASTER).update('nexus-token-signing').digest();
const ENC_KEY = crypto.createHmac('sha256', MASTER).update('nexus-encryption').digest();

// ---- Passwords (scrypt) ----
export const MAX_PASSWORD = 256; // bounds the hashing cost of a single request
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex || String(password).length > MAX_PASSWORD) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---- Signed tokens (JWT-compatible HS256) ----
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function signToken(payload, ttlSec = 7 * 24 * 3600) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = b64u(crypto.createHmac('sha256', TOKEN_KEY).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}
export function verifyToken(token) {
  const [header, body, sig] = String(token || '').split('.');
  if (!header || !body || !sig) return null;
  const expected = b64u(crypto.createHmac('sha256', TOKEN_KEY).update(`${header}.${body}`).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ---- Encryption at rest (AES-256-GCM) for exchange API secrets ----
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
export function decrypt(blob) {
  const [v, ivHex, tagHex, dataHex] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
export const mask = (s) => (s ? `${String(s).slice(0, 4)}••••${String(s).slice(-4)}` : '');

// ---- API keys (stored as SHA-256 hashes) ----
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newApiKey = () => `nx_${crypto.randomBytes(24).toString('base64url')}`;

// ---- TOTP 2FA (RFC 6238, 30s, 6 digits, SHA-1 - compatible with Google Authenticator / Authy) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function randomBase32(len = 32) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => B32[b % 32]).join('');
}
function base32Decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret, code, window = 1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) if (totp(secret, Date.now() + w * 30000) === c) return true;
  return false;
}
export const otpauthUrl = (secret, account, issuer = 'VelocityX Crypto Trading') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
