// HTTP hardening: security headers, CORS policy, per-IP rate limits, request logging and the final error handler.
import { config } from './config.js';

// Google Fonts serves the UI fonts; everything else is same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss:",
  "frame-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (config.isProd) {
    res.set('Content-Security-Policy', CSP);
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// Same-origin requests need no CORS. In production only APP_URL and CORS_ORIGINS may call the API from a browser;
// API-key clients (servers, scripts) send no Origin header and are unaffected.
export const corsOptions = {
  origin(origin, cb) {
    if (!origin || !config.isProd) return cb(null, true);
    const allowed = [config.appUrl, ...config.corsOrigins].some((o) => o.replace(/\/+$/, '') === origin);
    cb(null, allowed);
  },
  maxAge: 600,
};

// Fixed-window limiter keyed by client IP (req.ip honours TRUST_PROXY). In memory: one process per deployment.
export function ipRateLimit({ windowMs, max, message = 'Too many requests - slow down and try again shortly' }) {
  const hits = new Map(); // ip -> { start, count }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (now - h.start >= windowMs) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || now - h.start >= windowMs) hits.set(req.ip, (h = { start: now, count: 0 }));
    if (++h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// One line per API request in production (method, path without query string, status, duration, ip).
export function requestLog(req, res, next) {
  if (!config.isProd || !req.path.startsWith('/api')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path, s: res.statusCode, ms: Math.round(ms), ip: req.ip, u: req.user?._id }));
  });
  next();
}

// Catches errors thrown outside the route wrappers (bad JSON bodies, oversized payloads, middleware bugs).
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.path}:`, err.stack || err);
  if (res.headersSent) return res.end();
  const expose = status < 500 || !config.isProd;
  res.status(status).json({ error: expose ? (err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message) : 'Internal server error' });
}
