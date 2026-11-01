import 'dotenv/config';

const bool = (v, d = false) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const isProd = process.env.NODE_ENV === 'production';
const DEFAULT_PASSWORD = 'admin123'; // local development only - production refuses to start with it
const DEFAULT_SUPERADMIN_PASSWORD = 'superadmin123'; // local development only

export const config = {
  port: Number(process.env.PORT || 5000),
  isProd,
  appUrl: (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  // Extra browser origins allowed to call the API (comma-separated). APP_URL is always allowed.
  corsOrigins: list(process.env.CORS_ORIGINS),
  // Number of reverse proxies in front of the app (nginx, Caddy, a load balancer). Needed for real client IPs.
  trustProxy: process.env.TRUST_PROXY === undefined || process.env.TRUST_PROXY === '' ? (isProd ? 1 : false) : Number(process.env.TRUST_PROXY) || bool(process.env.TRUST_PROXY),
  // Personal install: the single login. The password is applied on first start and whenever it changes here (see ensureOwnerAccount).
  adminUsername: String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD,
  // Super Admin: a separate login (/superadmin) for plans, subscriptions and users. It cannot sign in to the trading app,
  // and trading accounts cannot sign in to the Super Admin panel. Same .env sync/reset rules as ADMIN_PASSWORD.
  superAdminUsername: String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase(),
  superAdminPassword: process.env.SUPERADMIN_PASSWORD || DEFAULT_SUPERADMIN_PASSWORD,
  // Public sign-up: anyone can create a regular (non-admin) account. Set ALLOW_SIGNUP=false to keep it owner-only.
  allowSignup: bool(process.env.ALLOW_SIGNUP, true),
  mongoUri: process.env.MONGO_URI || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    testnet: bool(process.env.BINANCE_TESTNET, true),
    baseUrl: process.env.BINANCE_BASE_URL || '',
    dataUrl: process.env.BINANCE_DATA_URL || 'https://data-api.binance.vision',
  },
  paperStartBalance: Number(process.env.PAPER_START_BALANCE || 10000),
  paperFxStartBalance: Number(process.env.PAPER_FX_START_BALANCE || 1000000), // INR paper wallet for NSE forex
  paperStocksStartBalance: Number(process.env.PAPER_STOCKS_START_BALANCE || 1000000), // INR paper wallet for NSE stocks
  paperOptionsStartBalance: Number(process.env.PAPER_OPTIONS_START_BALANCE || 500000), // INR paper wallet for NSE options
};

export const hasClaude = () => Boolean(config.anthropicKey);
export const hasBinanceKeys = () => Boolean(config.binance.apiKey && config.binance.apiSecret);

// Refuses to start a production server with settings that would lose data or leak access.
export function validateConfig() {
  if (!isProd) {
    if (config.adminPassword === DEFAULT_PASSWORD) console.warn(`[config] WARNING: using the default login ${config.adminUsername} / ${DEFAULT_PASSWORD} - set ADMIN_PASSWORD in server/.env`);
    if (config.superAdminPassword === DEFAULT_SUPERADMIN_PASSWORD) console.warn(`[config] WARNING: using the default Super Admin login ${config.superAdminUsername} / ${DEFAULT_SUPERADMIN_PASSWORD} - set SUPERADMIN_PASSWORD in server/.env`);
    return;
  }
  const errors = [];
  const warnings = [];
  if (config.adminPassword === DEFAULT_PASSWORD || config.adminPassword.length < 12) errors.push('ADMIN_PASSWORD must be set to at least 12 characters (and not the development default).');
  if (config.superAdminPassword === DEFAULT_SUPERADMIN_PASSWORD || config.superAdminPassword.length < 12) errors.push('SUPERADMIN_PASSWORD must be set to at least 12 characters (and not the development default).');
  if (config.superAdminUsername === config.adminUsername) errors.push('SUPERADMIN_USERNAME must differ from ADMIN_USERNAME.');
  if (!/^[0-9a-f]{64}$/i.test(process.env.MASTER_KEY || '')) errors.push('MASTER_KEY must be set to 64 hex chars (openssl rand -hex 32). A generated key file is too easy to lose in production.');
  if (!config.mongoUri) errors.push('MONGO_URI is required in production (the JSON file store is for local use only).');
  if (!/^https:\/\//.test(config.appUrl)) errors.push('APP_URL must be the public https:// URL of the app.');
  if (hasBinanceKeys() && !config.binance.testnet) warnings.push('Owner Binance keys are LIVE (real money).');
  warnings.forEach((w) => console.warn(`[config] WARNING: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`[config] ERROR: ${e}`));
    throw new Error('Invalid production configuration - fix the errors above (see .env.example).');
  }
}

// Runs at import, before any module that reads secrets (crypto.js loads MASTER_KEY at import time).
validateConfig();
