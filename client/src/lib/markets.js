// Trading segments (spot, crypto futures, NSE futures, forex, stocks) and whether each one can trade live right now.
// Used by the Dashboard status panel, the sidebar and the P&L history page.

export const SEGMENTS = [
  { id: 'spot', market: 'crypto', label: 'Crypto Spot', short: 'Spot', tag: 'SPOT', currency: 'USDT' },
  { id: 'perps', market: 'perps', label: 'Crypto Futures', short: 'Crypto Fut.', tag: 'FUTURES', currency: 'USDT' },
  { id: 'futures', market: 'futures', label: 'NSE Futures', short: 'NSE Fut.', tag: 'NSE FUT', currency: 'INR' },
  { id: 'forex', market: 'forex', label: 'NSE Forex', short: 'Forex', tag: 'FOREX', currency: 'INR' },
  { id: 'stocks', market: 'stocks', label: 'NSE Stocks', short: 'Stocks', tag: 'STOCKS', currency: 'INR' },
];

const BY_MARKET = Object.fromEntries(SEGMENTS.map((s) => [s.market, s]));

export const exchangeInfo = (exchanges, id) => (exchanges || []).find((e) => e.id === (id || 'binance')) || null;

// Segment of an exchange id ('binance' -> spot, 'bperp' -> perps, 'nfut' -> futures ...). Old trades without an exchange are Binance spot.
export function segmentOf(exchanges, exchangeId) {
  const e = exchangeInfo(exchanges, exchangeId);
  return BY_MARKET[e?.market || 'crypto'] || null;
}

export const currencyOf = (exchanges, exchangeId) => exchangeInfo(exchanges, exchangeId)?.currency || 'USDT';

// Live-trading state of one segment.
//   state: 'live' (real money), 'testnet' (exchange test funds), 'paper' (live is off - reason says why), 'halted' (kill switch)
export function segmentStatus(seg, { status, access }) {
  const exchanges = (status?.exchanges || []).filter((e) => e.market === seg.market);
  const tradable = exchanges.filter((e) => e.trading);
  const names = exchanges.map((e) => e.name.replace(/ \(.*\)$/, ''));
  const base = { seg, exchanges: names };

  if (status && status.tradingEnabled === false) {
    return { ...base, state: 'halted', reason: status.platformHalt ? `Platform halt: ${status.platformHalt}` : 'Kill switch is on - no bot opens trades' };
  }
  if (!access) return { ...base, state: 'loading', reason: 'Checking…' };

  // Connected exchanges in this segment (Zerodha adapters share the one Kite connection).
  const conns = [];
  for (const e of tradable) {
    const id = e.connection || e.id;
    const c = access.connections.find((x) => x.exchange === id && x.active);
    if (c) conns.push({ name: e.name, testnet: c.testnet, ok: c.lastTestOk !== false, kite: id === 'zerodha' });
    else if (status?.envKeys?.[e.id]) conns.push({ name: e.name, testnet: status.envKeys[e.id].testnet, ok: true, env: true });
  }

  if (!conns.length) return { ...base, state: 'paper', reason: 'No API keys connected - paper trading only' };
  if (access.plan && access.plan.features?.liveTrading === false) return { ...base, state: 'paper', reason: `Your ${access.plan.name} plan has no live trading` };
  const working = conns.filter((c) => c.ok && (!c.kite || access.kiteLoggedIn));
  if (!working.length) {
    const kite = conns.some((c) => c.kite) && !access.kiteLoggedIn;
    return { ...base, state: 'paper', reason: kite ? 'Zerodha login expired - log in again under Account' : 'API key test failed - check Account → API connections', warn: true };
  }
  const real = working.filter((c) => !c.testnet);
  if (real.length) return { ...base, state: 'live', reason: `Real money · ${real.map((c) => c.name.replace(/ \(.*\)$/, '')).join(', ')}` };
  return { ...base, state: 'testnet', reason: `Testnet (fake funds) · ${working.map((c) => c.name.replace(/ \(.*\)$/, '')).join(', ')}` };
}

export const STATE_UI = {
  live: { label: 'LIVE ON', cls: 'live' },
  testnet: { label: 'TESTNET', cls: 'testnet' },
  paper: { label: 'PAPER ONLY', cls: 'paper' },
  halted: { label: 'STOPPED', cls: 'halted' },
  loading: { label: '…', cls: 'paper' },
};

// Local calendar day key (YYYY-MM-DD) for grouping trades by day.
export const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
