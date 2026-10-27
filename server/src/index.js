import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { config, hasClaude, hasBinanceKeys } from './config.js';
import { initDb, closeDb, dbReady, dbKind } from './db/index.js';
import api from './routes/api.js';
import authRoutes, { ensureOwnerAccount } from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import socialRoutes, { loadCustomStrategies } from './routes/social.js';
import brokerRoutes, { brokersPublic } from './routes/brokers.js';
import optionRoutes from './routes/options.js';
import { startOptionsManager, optionEvents } from './options/service.js';
import { resumeOptionBots, stopAllOptionBots } from './options/bot.js';
import { events, resumeRunningBots, stopAllBots } from './bot/engine.js';
import { startCopyEngine } from './bot/copyEngine.js';
import { safetyEvents, startHealthMonitor, getGlobal } from './bot/safety.js';
import { startLiquidationStream } from './exchange/binanceFutures.js';
import { initModelRegistry, evaluatePendingSignals } from './ai/modelRegistry.js';
import { verifyToken } from './auth/crypto.js';
import { notifyEvents } from './notify.js';
import { db } from './db/index.js';
import { securityHeaders, corsOptions, ipRateLimit, requestLog, errorHandler } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();
let shuttingDown = false;

// Last line of defence for errors that escaped every try/catch, written to data/crash.log as well.
// A rejected promise is logged and the server keeps running. An uncaught exception leaves the process in an
// unknown state, so it exits and the supervisor (Docker / PM2 / start.bat) restarts it; live positions are
// re-checked against the exchange on the first tick, and their exchange-side stops keep protecting them meanwhile.
const crashLog = (kind, err) => {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`;
  console.error(line);
  try {
    fs.appendFileSync(path.resolve(process.env.DATA_DIR || path.resolve(here, '../data'), 'crash.log'), line);
  } catch {}
};
process.on('unhandledRejection', (err) => crashLog('unhandledRejection', err));
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException', err);
  process.exit(1);
});

await initDb();
await ensureOwnerAccount();
await getGlobal();
await initModelRegistry();
const customCount = await loadCustomStrategies();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(securityHeaders);
app.use(requestLog);
app.use('/api', cors(corsOptions));

// Liveness: the process answers. Readiness: the database is connected and the server is not shutting down.
app.get(['/healthz', '/api/health', '/api/v1/health'], (_req, res) => res.json({ ok: true, time: Date.now(), uptime: Math.round((Date.now() - startedAt) / 1000) }));
app.get('/readyz', (_req, res) => {
  const ready = !shuttingDown && dbReady();
  res.status(ready ? 200 : 503).json({ ready, db: dbKind, shuttingDown });
});

// Per-IP limits on top of the per-username one: slows password guessing and API floods.
const authLimiter = ipRateLimit({ windowMs: 15 * 60e3, max: 30, message: 'Too many sign-in attempts from this address - try again in 15 minutes' });
const apiLimiter = ipRateLimit({ windowMs: 60e3, max: Number(process.env.IP_RATE_LIMIT_PER_MIN || 600) });

function mountApi(prefix) {
  app.use(prefix, apiLimiter);
  app.use([`${prefix}/auth/login`, `${prefix}/auth/register`, `${prefix}/auth/forgot`, `${prefix}/auth/reset`], authLimiter);
  app.use(prefix, express.json({ limit: '1mb' }));
  app.get(`${prefix}/branding`, async (_req, res) => res.json((await getGlobal()).branding));
  app.use(prefix, brokersPublic); // Kite login redirect lands here without an app session
  app.use(prefix, authRoutes); // login is public; everything after this router is authenticated
  app.use(prefix, brokerRoutes);
  app.use(prefix, optionRoutes);
  app.use(prefix, adminRoutes);
  app.use(prefix, socialRoutes);
  app.use(prefix, api);
}
mountApi('/api/v1'); // stable Enterprise API path (X-API-Key)
mountApi('/api');
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app (client/dist). Vite fingerprints /assets/*, so those are cached for a year;
// index.html and the service worker must always be revalidated or users get stuck on an old build.
const dist = path.resolve(here, '../../client/dist');
if (fs.existsSync(dist)) {
  app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '365d', index: false }));
  app.use(express.static(dist, {
    index: false,
    maxAge: '1d',
    setHeaders: (res, file) => {
      if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api|ws|assets).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
} else if (config.isProd) {
  console.warn('[http] client/dist not found - run "npm run build" so the server can serve the web app');
}
app.use(errorHandler);

const server = http.createServer(app);
server.keepAliveTimeout = 65000; // longer than typical load-balancer idle timeouts (60s)
server.headersTimeout = 66000;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// Each socket authenticates with ?token= and only receives its own user's events.
wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  try {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const payload = verifyToken(token);
    const user = payload && (await db.users.findOne({ _id: payload.sub }));
    if (!user || (user.tokenVersion || 0) !== (payload.v || 0) || user.status === 'suspended') return ws.close(4401, 'unauthorized');
    ws.userId = user._id;
  } catch {
    ws.close(1011, 'server error');
  }
});

// Drops sockets that stopped answering pings (closed laptops, dead mobile connections) so they don't pile up.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
heartbeat.unref();

const send = (type, payload, userId) => {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((c) => c.readyState === 1 && c.userId && (!userId || c.userId === userId) && c.send(msg));
};
['log', 'trade', 'signal', 'position', 'journal', 'killswitch', 'bot'].forEach((t) => events.on(t, (p) => p?.userId && send(t, p, p.userId)));
notifyEvents.on('notification', (n) => send('notification', n, n.userId));
optionEvents.on('position', (p) => send('options', { _id: p._id, status: p.status }, p.userId));
safetyEvents.on('settings', (p) => send('settings', p.settings, p.userId));
safetyEvents.on('health', (p) => send('health', p));
safetyEvents.on('platform', (p) => send('platform', { haltAll: p.haltAll, haltReason: p.haltReason, branding: p.branding }));

server.listen(config.port, async () => {
  console.log(`\n  VelocityX Crypto Trading API  ->  http://localhost:${config.port}  (${config.isProd ? 'production' : 'development'})`);
  console.log(`  Database:  ${dbKind}`);
  console.log(`  Claude AI: ${hasClaude() ? `enabled (${config.claudeModel})` : 'disabled - set ANTHROPIC_API_KEY'}`);
  console.log(`  Binance:   ${hasBinanceKeys() ? (config.binance.testnet ? 'owner keys set (TESTNET)' : 'owner keys set (LIVE - real money!)') : 'no owner keys (users connect their own)'}`);
  console.log(`  Custom strategies loaded: ${customCount}\n`);
  startHealthMonitor();
  startLiquidationStream();
  startCopyEngine();
  await resumeRunningBots();
  startOptionsManager();
  await resumeOptionBots();
  setInterval(() => evaluatePendingSignals().catch(() => {}), 10 * 60 * 1000);
});

// Graceful shutdown (docker stop, PM2 reload, Ctrl+C): stop taking traffic, let bot ticks finish, flush the DB.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received - draining`);
  const force = setTimeout(() => {
    console.error('[shutdown] timed out - forcing exit');
    process.exit(1);
  }, 25000);
  force.unref();
  try {
    server.close();
    wss.clients.forEach((ws) => ws.close(1001, 'server restarting'));
    const clean = await stopAllBots(15000);
    await stopAllOptionBots(5000);
    if (!clean) console.warn('[shutdown] some bot ticks were still running');
    await closeDb();
    console.log('[shutdown] done');
    process.exit(0);
  } catch (err) {
    crashLog('shutdown', err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
