// Emergency protection: per-user settings & kill switch, global admin halt, exchange health,
// abnormal price, stale data and duplicate-order guards.
import { EventEmitter } from 'events';
import { db } from '../db/index.js';
import { ping } from '../exchange/binance.js';

export const safetyEvents = new EventEmitter();

export const DEFAULT_RISK = {
  baseRiskPct: 1,
  maxRiskPct: 2,
  maxOpenPositions: 5,
  maxExposurePct: 60,
  maxCorrelatedPositions: 2,
  correlationLimit: 0.8,
  maxDrawdownHaltPct: 20,
  dailyLossLimitPct: 5,
  minRR: 1.2,
  minQuality: 'C',
  abnormalMovePct: 8,
  maxConsecutiveErrors: 5,
  orderCooldownSec: 30,
};

export const DEFAULT_BRANDING = {
  appName: 'VelocityX', tagline: 'Crypto Trading', logoText: 'VX', primary: '#2f8cff', accent: '#ff9a3c',
  supportEmail: '', poweredBy: true,
};

// ---- Global (platform) settings: admin halt + white-label branding ----
let globalCache = null;
export async function getGlobal() {
  if (globalCache) return globalCache;
  let g = await db.settings.findOne({ kind: 'platform' });
  if (!g) g = await db.settings.insert({ kind: 'platform', haltAll: false, haltReason: null, branding: DEFAULT_BRANDING });
  g.branding = { ...DEFAULT_BRANDING, ...(g.branding || {}) };
  globalCache = g;
  return g;
}
export async function updateGlobal(patch) {
  const g = await getGlobal();
  const next = { ...patch };
  if (patch.branding) next.branding = { ...g.branding, ...patch.branding };
  globalCache = await db.settings.update(g._id, next);
  globalCache.branding = { ...DEFAULT_BRANDING, ...(globalCache.branding || {}) };
  safetyEvents.emit('platform', globalCache);
  return globalCache;
}

// ---- Per-user settings: kill switch, risk limits, peak equity ----
const cache = new Map();
export async function getSettings(userId) {
  if (!userId) throw new Error('getSettings needs a userId');
  let s = cache.get(userId);
  if (!s) {
    s = await db.settings.findOne({ kind: 'user', userId });
    if (!s) s = await db.settings.insert({ kind: 'user', userId, tradingEnabled: true, killSwitchAt: null, killSwitchReason: null, risk: DEFAULT_RISK, peakEquity: { paper: 0, live: 0 } });
    s.risk = { ...DEFAULT_RISK, ...(s.risk || {}) };
    s.peakEquity = { paper: 0, live: 0, ...(s.peakEquity || {}) };
    cache.set(userId, s);
  }
  const g = await getGlobal();
  return { ...s, userEnabled: s.tradingEnabled, tradingEnabled: s.tradingEnabled && !g.haltAll, platformHalt: g.haltAll ? g.haltReason || 'Platform maintenance' : null };
}

export async function updateSettings(userId, patch) {
  const s = await getSettings(userId);
  const next = { ...patch };
  if (patch.risk) next.risk = { ...s.risk, ...patch.risk };
  if (patch.peakEquity) next.peakEquity = { ...s.peakEquity, ...patch.peakEquity };
  const saved = await db.settings.update(s._id, next);
  saved.risk = { ...DEFAULT_RISK, ...(saved.risk || {}) };
  cache.set(userId, saved);
  safetyEvents.emit('settings', { userId, settings: saved });
  return getSettings(userId);
}

// ---- Exchange health monitor ----
export const health = { exchangeUp: true, latencyMs: null, lastCheck: null, failures: 0 };

export function startHealthMonitor() {
  const check = async () => {
    try {
      health.latencyMs = await ping();
      health.exchangeUp = true;
      health.failures = 0;
    } catch {
      health.failures++;
      if (health.failures >= 2) health.exchangeUp = false;
    }
    health.lastCheck = Date.now();
    safetyEvents.emit('health', health);
  };
  check();
  setInterval(check, 60000);
}

// Rejects a price that jumped implausibly far from the last closed candle (bad tick, flash crash, API glitch).
export function abnormalPrice(price, lastClose, atr, maxMovePct) {
  const movePct = (Math.abs(price - lastClose) / lastClose) * 100;
  const atrPct = (atr / lastClose) * 100;
  const limit = Math.max(maxMovePct, atrPct * 10);
  return movePct > limit ? `Price moved ${movePct.toFixed(2)}% from the last close (limit ${limit.toFixed(1)}%)` : null;
}

const INTERVAL_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400, '1w': 604800 };
export function staleData(lastCandleTime, interval) {
  const sec = INTERVAL_SEC[interval] || 3600;
  const age = Date.now() / 1000 - lastCandleTime;
  return age > sec * 3 ? `Market data is stale (${Math.round(age / 60)} min old)` : null;
}

// ---- Duplicate-order protection ----
const lastOrderAt = new Map();
export function orderCooldown(key, cooldownSec) {
  const prev = lastOrderAt.get(key) || 0;
  if (Date.now() - prev < cooldownSec * 1000) return `Duplicate-order protection: last order ${Math.round((Date.now() - prev) / 1000)}s ago`;
  return null;
}
export const markOrder = (key) => lastOrderAt.set(key, Date.now());
